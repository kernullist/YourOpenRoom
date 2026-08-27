// @vitest-environment node
//
// The only test here that touches a REAL idasql and a REAL IDA install.
//
// Everything else in this suite injects the process and the HTTP layer, which is
// what makes those tests fast and deterministic -- and also what let a whole
// class of bug through: the argument vector, the PATH handling, the auth scheme
// and the response envelope were all guesses until this ran. It exercises the
// production dependency wiring end to end: spawn -> readiness poll -> query ->
// shutdown.
//
// SELF-SKIPPING. It needs idasql and IDA configured in the shared config file
// (IDA Lab -> Setup writes it), so it is a no-op on a machine without them
// rather than a red suite.
import * as fs from 'fs';
import * as os from 'os';
import { join, resolve } from 'path';
import { afterAll, describe, expect, it } from 'vitest';

import { IdaSqlSessionManager, createIdaSqlNodeDeps } from '../idaSqlSession';
import { loadIdaSqlConfig } from '../idaSqlPlugin';
import { resolveIdaDirectory } from '../idaSqlConfig';
import type { IdaSqlConfigView } from '../idaSqlTypes';

const CONFIG_FILE = resolve(os.homedir(), '.openroom', 'config.json');
const READY_TIMEOUT_MS = 180_000;

function loadRealConfig(): IdaSqlConfigView | null {
  try {
    if (!fs.existsSync(CONFIG_FILE)) {
      return null;
    }
    const config = loadIdaSqlConfig(CONFIG_FILE);
    if (!config.idasqlExePath || !fs.existsSync(config.idasqlExePath)) {
      return null;
    }
    const idaDir = resolveIdaDirectory(config);
    if (!idaDir || !fs.existsSync(idaDir)) {
      return null;
    }
    return config;
  } catch {
    return null;
  }
}

/** A small PE inside one of the configured roots, or null. */
function findSample(config: IdaSqlConfigView): string | null {
  for (const root of config.binaryRoots) {
    const candidate = join(root.path, 'samples', 'where.exe');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

const config = loadRealConfig();
const sample = config ? findSample(config) : null;
const live = Boolean(config && sample);

const managers: IdaSqlSessionManager[] = [];

afterAll(async () => {
  for (const manager of managers) {
    for (const session of manager.list()) {
      await manager.stop(session.id).catch(() => undefined);
    }
  }
});

describe.skipIf(!live)('idasql, for real', () => {
  it(
    'starts, becomes ready, answers SQL, and shuts down',
    async () => {
      const manager = new IdaSqlSessionManager(createIdaSqlNodeDeps());
      managers.push(manager);

      const started = await manager.startHeadless({
        config: config as IdaSqlConfigView,
        binaryPath: sample as string,
        write: false,
      });
      expect(started.ok, started.reason).toBe(true);
      const sessionId = started.session?.id ?? '';

      const deadline = Date.now() + READY_TIMEOUT_MS;
      while (Date.now() < deadline && manager.get(sessionId)?.state === 'starting') {
        await new Promise((done) => setTimeout(done, 500));
      }
      const view = manager.get(sessionId);
      expect(view?.state, `${view?.failureReason} :: ${manager.outputTail(sessionId)}`).toBe(
        'ready',
      );

      // A real query against a real database.
      const funcs = await manager.query(sessionId, 'SELECT name, addr FROM funcs LIMIT 5');
      expect(funcs.ok, funcs.engineError || funcs.reason).toBe(true);
      expect(funcs.resultSets[0].columns).toEqual(['name', 'addr']);
      expect(funcs.resultSets[0].rows.length).toBeGreaterThan(0);

      // The bug this whole file exists for: a bad column must NOT read as an
      // empty success.
      const wrong = await manager.query(sessionId, 'SELECT start_ea FROM funcs LIMIT 1');
      expect(wrong.ok).toBe(false);
      expect(wrong.engineError).toContain('no such column');

      // The schema is discoverable the way the tool description tells the model.
      const tables = await manager.query(
        sessionId,
        "SELECT name FROM sqlite_master WHERE type IN ('table','view')",
      );
      expect(tables.ok).toBe(true);
      expect(tables.resultSets[0].rowCount).toBeGreaterThan(10);

      const stopped = await manager.stop(sessionId);
      expect(stopped.ok).toBe(true);
      expect(manager.get(sessionId)?.state).toBe('stopped');
    },
    READY_TIMEOUT_MS + 60_000,
  );

  it(
    'refuses a caller without the session token',
    async () => {
      // The server is on loopback, which is not a boundary: every local process
      // shares it. The token is what makes the port ours.
      const manager = new IdaSqlSessionManager(createIdaSqlNodeDeps());
      managers.push(manager);
      const started = await manager.startHeadless({
        config: config as IdaSqlConfigView,
        binaryPath: sample as string,
        write: false,
      });
      const sessionId = started.session?.id ?? '';
      const deadline = Date.now() + READY_TIMEOUT_MS;
      while (Date.now() < deadline && manager.get(sessionId)?.state === 'starting') {
        await new Promise((done) => setTimeout(done, 500));
      }
      expect(manager.get(sessionId)?.state).toBe('ready');

      const port = manager.get(sessionId)?.port ?? 0;
      const bare = await fetch(`http://127.0.0.1:${port}/status`);
      expect(bare.status).toBe(401);

      await manager.stop(sessionId);
    },
    READY_TIMEOUT_MS + 60_000,
  );
});

describe.skipIf(live)('idasql integration', () => {
  it('is skipped because idasql is not configured on this machine', () => {
    expect(live).toBe(false);
  });
});
