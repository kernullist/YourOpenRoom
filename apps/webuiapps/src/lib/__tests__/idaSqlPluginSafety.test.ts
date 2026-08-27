// @vitest-environment node
//
// Adversarial regressions: each test here corresponds to a bug that shipped in
// the first draft of IDA Lab and that the original suite did not catch.
import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  loadIdaSqlConfig,
  resetIdaSqlVersionProbeCache,
  resolveIdaSqlRoute,
  saveIdaSqlConfig,
} from '../idaSqlPlugin';
import { ensureAoiHostBridgeToken } from '../aoiHostBridgeAuth';
import {
  saveAoiHostBridgeKillSwitchState,
  setAoiHostBridgeCapability,
} from '../aoiHostBridgeKillSwitch';
import {
  findAoiHostBridgeApproval,
  loadAoiHostBridgeApprovalStore,
  recordAoiHostBridgePendingApprovalAtomic,
} from '../aoiHostBridgeApprovalStore';
import {
  IdaSqlSessionManager,
  type IdaSqlChildHandle,
  type IdaSqlSessionDeps,
} from '../idaSqlSession';
import { normalizeIdaSqlConfig } from '../idaSqlConfig';
import {
  IDA_SQL_ANALYSIS_CAPABILITY,
  IDA_SQL_AUTO_SESSION_CAPABILITY,
  IDA_SQL_WRITE_CAPABILITY,
} from '../idaSqlTypes';
import { loadIdaSqlStandingGrantStore } from '../idaSqlStandingGrant';

const tempRoots: string[] = [];

interface Fixture {
  home: string;
  sessionsDir: string;
  configFile: string;
  binDir: string;
  binaryPath: string;
  secondBinary: string;
  token: string;
}

function makeFixture(capabilities: string[] = [IDA_SQL_ANALYSIS_CAPABILITY]): Fixture {
  const home = fs.mkdtempSync(join(os.tmpdir(), 'ida-lab-safety-'));
  tempRoots.push(home);
  const sessionsDir = join(home, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const binDir = join(home, 'binaries');
  fs.mkdirSync(binDir, { recursive: true });
  const binaryPath = join(binDir, 'client.exe');
  const secondBinary = join(binDir, 'server.exe');
  fs.writeFileSync(binaryPath, 'MZ');
  fs.writeFileSync(secondBinary, 'MZ');
  const idasqlPath = join(home, 'idasql.exe');
  fs.writeFileSync(idasqlPath, 'stub');
  const configFile = join(home, 'config.json');
  saveIdaSqlConfig(
    configFile,
    normalizeIdaSqlConfig({
      idasqlExePath: idasqlPath,
      binaryRoots: [{ id: 'bins', path: binDir, label: 'Binaries' }],
      writeEnabled: true,
    }),
  );
  const token = ensureAoiHostBridgeToken(home, { generateToken: () => 'd'.repeat(64) }).token;
  let state = { version: 1 as const, globalPanic: false, entries: {}, updatedAt: 0 };
  for (const key of capabilities) {
    state = setAoiHostBridgeCapability(state, key, true, 1000);
  }
  saveAoiHostBridgeKillSwitchState(home, state);
  return { home, sessionsDir, configFile, binDir, binaryPath, secondBinary, token };
}

function makeManager(): { manager: IdaSqlSessionManager; spawns: number } {
  const box = { spawns: 0 };
  const deps: IdaSqlSessionDeps = {
    spawnProcess(): IdaSqlChildHandle {
      box.spawns += 1;
      return { pid: 1000 + box.spawns, onExit() {}, onOutput() {}, kill() {} };
    },
    httpRequest: async (url) =>
      url.endsWith('/status')
        ? { status: 200, text: '{"idasql":"1.0"}' }
        : { status: 200, text: '{"results":[]}' },
    now: () => Date.now(),
    sleep: async () => {},
    isPortFree: async () => true,
  };
  return {
    manager: new IdaSqlSessionManager(deps),
    get spawns() {
      return box.spawns;
    },
  };
}

async function call(
  fixture: Fixture,
  manager: IdaSqlSessionManager,
  method: string,
  route: string,
  body: Record<string, unknown> = {},
  now = Date.now(),
): Promise<{ status: number; payload: Record<string, unknown> }> {
  const result = await resolveIdaSqlRoute({
    method,
    route,
    body,
    token: fixture.token,
    openroomHome: fixture.home,
    configFile: fixture.configFile,
    now,
    manager,
  });
  return { status: result.status, payload: result.payload as Record<string, unknown> };
}

async function waitReady(manager: IdaSqlSessionManager, sessionId: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (manager.get(sessionId)?.state === 'ready') {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('session never became ready');
}

afterAll(() => {
  for (const dir of tempRoots) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup.
    }
  }
});

describe('approvals/run cannot be used to approve another feature', () => {
  it('refuses a host-bridge spawn fingerprint and leaves it PENDING', async () => {
    const fixture = makeFixture();
    const { manager } = makeManager();

    // A pending host-bridge spawn approval, exactly as host_process_spawn_preview
    // would leave it: waiting for the operator to click ITS popup.
    const fingerprint = 'a'.repeat(64);
    recordAoiHostBridgePendingApprovalAtomic(fixture.home, {
      capability: 'os_process_spawn',
      approvalFingerprint: fingerprint,
      targetSummary: 'C:\\Windows\\System32\\cmd.exe',
      now: Date.now(),
      expiresAt: Date.now() + 300_000,
    });

    const ran = await call(fixture, manager, 'POST', '/approvals/run', {
      approvalFingerprint: fingerprint,
    });
    expect(ran.status).toBe(404);

    // The whole point: the foreign approval must still be waiting for a human.
    const entry = findAoiHostBridgeApproval(
      loadAoiHostBridgeApprovalStore(fixture.home),
      fingerprint,
      Date.now(),
    );
    expect(entry?.state).toBe('pending');
  });

  it('refuses when the stored entry is under a capability we did not preview', async () => {
    const fixture = makeFixture([IDA_SQL_ANALYSIS_CAPABILITY, IDA_SQL_WRITE_CAPABILITY]);
    const { manager } = makeManager();

    const previewed = await call(fixture, manager, 'POST', '/sessions/preview', {
      binaryPath: fixture.binaryPath,
    });
    const fingerprint = String(
      (previewed.payload.preview as Record<string, unknown>).approvalFingerprint,
    );
    // Something re-records the SAME fingerprint under a different capability.
    recordAoiHostBridgePendingApprovalAtomic(fixture.home, {
      capability: 'os_file_delete',
      approvalFingerprint: fingerprint,
      targetSummary: 'F:\\important.txt',
      now: Date.now(),
      expiresAt: Date.now() + 300_000,
    });

    const ran = await call(fixture, manager, 'POST', '/approvals/run', {
      approvalFingerprint: fingerprint,
    });
    expect(ran.status).toBe(403);
    expect(ran.payload.error).toBe('capability_mismatch');
    const entry = findAoiHostBridgeApproval(
      loadAoiHostBridgeApprovalStore(fixture.home),
      fingerprint,
      Date.now(),
    );
    expect(entry?.state).toBe('pending');
  });
});

describe('session-output is gated like every other read', () => {
  it('refuses while the analysis capability is off', async () => {
    const fixture = makeFixture([]);
    const { manager } = makeManager();
    const result = await call(fixture, manager, 'GET', '/session-output', { sessionId: 'x' });
    expect(result.status).toBe(403);
    expect(result.payload.denyReasons).toContain('capability_disabled');
  });
});

describe('a write fingerprint is exact', () => {
  it('gives two statements that differ only inside a literal different fingerprints', async () => {
    const fixture = makeFixture([IDA_SQL_ANALYSIS_CAPABILITY, IDA_SQL_WRITE_CAPABILITY]);
    const { manager } = makeManager();
    const attached = await call(fixture, manager, 'POST', '/sessions/attach', { port: 8100 });
    const sessionId = String((attached.payload.session as Record<string, unknown>).id);

    const first = await call(fixture, manager, 'POST', '/query', {
      sessionId,
      sql: "UPDATE funcs SET name = 'a  b' WHERE start_ea = 1",
    });
    const second = await call(fixture, manager, 'POST', '/query', {
      sessionId,
      sql: "UPDATE funcs SET name = 'a b' WHERE start_ea = 1",
    });
    const firstFingerprint = String(
      (first.payload.preview as Record<string, unknown>).approvalFingerprint,
    );
    const secondFingerprint = String(
      (second.payload.preview as Record<string, unknown>).approvalFingerprint,
    );
    // Collapsing whitespace made these the same approval, so approving the popup
    // for one would have run the other.
    expect(firstFingerprint).not.toBe(secondFingerprint);
  });
});

describe('a second session on the same binary is refused', () => {
  it('blocks the preview and names the reason', async () => {
    const fixture = makeFixture();
    const { manager } = makeManager();
    const previewed = await call(fixture, manager, 'POST', '/sessions/preview', {
      binaryPath: fixture.binaryPath,
    });
    await call(fixture, manager, 'POST', '/approvals/run', {
      approvalFingerprint: String(
        (previewed.payload.preview as Record<string, unknown>).approvalFingerprint,
      ),
    });
    await waitReady(manager, manager.list()[0].id);

    const again = await call(fixture, manager, 'POST', '/sessions/preview', {
      binaryPath: fixture.binaryPath,
    });
    const preview = again.payload.preview as { allowed: boolean; blockReasons: string[] };
    expect(preview.allowed).toBe(false);
    expect(preview.blockReasons).toContain('session_already_open');

    // A different binary is still fine.
    const other = await call(fixture, manager, 'POST', '/sessions/preview', {
      binaryPath: fixture.secondBinary,
    });
    expect((other.payload.preview as { allowed: boolean }).allowed).toBe(true);
  });

  it('recognizes the same binary through a different letter case', async () => {
    // Windows realpath does NOT canonicalize case (verified: an all-caps path
    // comes back all-caps), so the duplicate guard has to fold case itself or
    // two idasql instances end up fighting over one .i64.
    const fixture = makeFixture();
    const { manager } = makeManager();
    const previewed = await call(fixture, manager, 'POST', '/sessions/preview', {
      binaryPath: fixture.binaryPath,
    });
    await call(fixture, manager, 'POST', '/approvals/run', {
      approvalFingerprint: String(
        (previewed.payload.preview as Record<string, unknown>).approvalFingerprint,
      ),
    });
    await waitReady(manager, manager.list()[0].id);

    const shouted = await call(fixture, manager, 'POST', '/sessions/preview', {
      binaryPath: fixture.binaryPath.toUpperCase(),
    });
    expect((shouted.payload.preview as { blockReasons: string[] }).blockReasons).toContain(
      'session_already_open',
    );
  });
});

describe('the gate is re-evaluated when the approval is run, not only at preview', () => {
  it('refuses a previewed session start once panic is engaged', async () => {
    const fixture = makeFixture();
    const { manager } = makeManager();
    const previewed = await call(fixture, manager, 'POST', '/sessions/preview', {
      binaryPath: fixture.binaryPath,
    });
    const fingerprint = String(
      (previewed.payload.preview as Record<string, unknown>).approvalFingerprint,
    );

    // The operator changes their mind between the popup and the click.
    saveAoiHostBridgeKillSwitchState(fixture.home, {
      version: 1,
      globalPanic: true,
      entries: { [IDA_SQL_ANALYSIS_CAPABILITY]: true },
      updatedAt: Date.now(),
    });

    const ran = await call(fixture, manager, 'POST', '/approvals/run', {
      approvalFingerprint: fingerprint,
    });
    expect(ran.status).toBe(403);
    expect(ran.payload.denyReasons).toContain('host_bridge_panic');
    expect(manager.list()).toHaveLength(0);
  });

  it('refuses a previewed write once the write capability is switched off', async () => {
    const fixture = makeFixture([IDA_SQL_ANALYSIS_CAPABILITY, IDA_SQL_WRITE_CAPABILITY]);
    const { manager } = makeManager();
    const attached = await call(fixture, manager, 'POST', '/sessions/attach', { port: 8100 });
    const sessionId = String((attached.payload.session as Record<string, unknown>).id);
    const proposed = await call(fixture, manager, 'POST', '/query', {
      sessionId,
      sql: "UPDATE funcs SET name = 'x' WHERE start_ea = 1",
    });
    const fingerprint = String(
      (proposed.payload.preview as Record<string, unknown>).approvalFingerprint,
    );

    saveAoiHostBridgeKillSwitchState(
      fixture.home,
      setAoiHostBridgeCapability(
        { version: 1, globalPanic: false, entries: {}, updatedAt: 0 },
        IDA_SQL_ANALYSIS_CAPABILITY,
        true,
        1000,
      ),
    );

    const ran = await call(fixture, manager, 'POST', '/approvals/run', {
      approvalFingerprint: fingerprint,
    });
    expect(ran.status).toBe(403);
    expect(ran.payload.denyReasons).toContain('capability_disabled');
  });

  it('refuses a previewed start whose root was removed in the meantime', async () => {
    const fixture = makeFixture();
    const { manager } = makeManager();
    const previewed = await call(fixture, manager, 'POST', '/sessions/preview', {
      binaryPath: fixture.binaryPath,
    });
    const fingerprint = String(
      (previewed.payload.preview as Record<string, unknown>).approvalFingerprint,
    );

    // Containment has to hold at execute time too: the binary is no longer in
    // any root the operator allows.
    const current = loadIdaSqlConfig(fixture.configFile);
    saveIdaSqlConfig(fixture.configFile, { ...current, binaryRoots: [] });

    const ran = await call(fixture, manager, 'POST', '/approvals/run', {
      approvalFingerprint: fingerprint,
    });
    expect(ran.status).toBe(403);
    expect(ran.payload.error).toBe('no_binary_roots');
    expect(manager.list()).toHaveLength(0);
  });

  it('refuses a previewed write session once the Setup toggle is turned off', async () => {
    const fixture = makeFixture([IDA_SQL_ANALYSIS_CAPABILITY, IDA_SQL_WRITE_CAPABILITY]);
    const { manager } = makeManager();
    const previewed = await call(fixture, manager, 'POST', '/sessions/preview', {
      binaryPath: fixture.binaryPath,
      write: true,
    });
    const preview = previewed.payload.preview as { allowed: boolean; approvalFingerprint: string };
    expect(preview.allowed).toBe(true);

    const current = loadIdaSqlConfig(fixture.configFile);
    saveIdaSqlConfig(fixture.configFile, { ...current, writeEnabled: false });

    const ran = await call(fixture, manager, 'POST', '/approvals/run', {
      approvalFingerprint: preview.approvalFingerprint,
    });
    expect(ran.status).toBe(403);
    expect(ran.payload.error).toBe('write_not_enabled_in_settings');
  });
});

describe('the version probe does not respawn idasql on every health poll', () => {
  it('answers repeated polls without re-running the binary', async () => {
    const fixture = makeFixture();
    const { manager } = makeManager();
    resetIdaSqlVersionProbeCache();
    // The stub "idasql" is not executable, so spawnSync fails and the version is
    // empty either way; what matters is that the result is memoized by the
    // binary's identity rather than probed per request. Health is polled every
    // 2.5s while a session analyzes, and this probe is synchronous.
    const first = await call(fixture, manager, 'GET', '/health');
    const second = await call(fixture, manager, 'GET', '/health');
    expect((first.payload.health as { idasqlVersion: string }).idasqlVersion).toBe(
      (second.payload.health as { idasqlVersion: string }).idasqlVersion,
    );
    // Replacing the binary invalidates the memo.
    const config = loadIdaSqlConfig(fixture.configFile);
    fs.writeFileSync(config.idasqlExePath, 'stub-v2-different-size');
    const third = await call(fixture, manager, 'GET', '/health');
    expect((third.payload.health as { idasqlPresent: boolean }).idasqlPresent).toBe(true);
  });
});

describe('an engine rejection is a delivered answer, a transport failure is not', () => {
  function managerWith(httpRequest: IdaSqlSessionDeps['httpRequest']): IdaSqlSessionManager {
    return new IdaSqlSessionManager({
      spawnProcess: () => ({ pid: 1, onExit() {}, onOutput() {}, kill() {} }),
      httpRequest,
      now: () => Date.now(),
      sleep: async () => {},
      isPortFree: async () => true,
    });
  }

  it('delivers the engine message instead of raising a bare code', async () => {
    const fixture = makeFixture();
    // The real envelope: HTTP 200, top-level success false, message inside the
    // statement entry. Returning ok:false here threw the message away -- the
    // client raises the top-level code and drops the body, so the operator saw
    // "engine_error" and the UI kept the previous query's table.
    const manager = managerWith(async (url) =>
      url.endsWith('/status')
        ? { status: 200, text: '{"tool":"idasql"}' }
        : {
            status: 200,
            text: '{"success":false,"statement_count":1,"results":[{"statement_index":0,"success":false,"columns":[],"rows":[],"row_count":0,"error":"no such column: start_ea"}]}',
          },
    );
    const attached = await call(fixture, manager, 'POST', '/sessions/attach', { port: 8100 });
    const sessionId = String((attached.payload.session as Record<string, unknown>).id);
    const result = await call(fixture, manager, 'POST', '/query', {
      sessionId,
      sql: 'SELECT start_ea FROM funcs',
    });
    expect(result.status).toBe(200);
    expect(result.payload.ok).toBe(true);
    const query = result.payload.query as { engineError: string; resultSets: unknown[] };
    expect(query.engineError).toBe('no such column: start_ea');
    // Delivered as ok:true means the client returns it, so the UI can replace
    // the table rather than keeping a stale one.
    expect(query.resultSets).toHaveLength(1);
  });

  it('still refuses a transport failure, carrying the reason', async () => {
    const fixture = makeFixture();
    const manager = managerWith(async (url) => {
      if (url.endsWith('/status')) {
        return { status: 200, text: '{"tool":"idasql"}' };
      }
      throw new Error('socket hang up');
    });
    const attached = await call(fixture, manager, 'POST', '/sessions/attach', { port: 8100 });
    const sessionId = String((attached.payload.session as Record<string, unknown>).id);
    const result = await call(fixture, manager, 'POST', '/query', {
      sessionId,
      sql: 'SELECT 1',
    });
    expect(result.status).toBe(409);
    expect(result.payload.ok).toBe(false);
    expect(result.payload.error).toBe('query_transport_failed');
    expect(String(result.payload.detail)).toContain('socket hang up');
  });

  it('refuses a 401 from the session as a transport problem, not an empty answer', async () => {
    const fixture = makeFixture();
    // If the token ever stops matching, this must not look like "no rows".
    const manager = managerWith(async (url) =>
      url.endsWith('/status')
        ? { status: 200, text: '{"tool":"idasql"}' }
        : { status: 401, text: 'Unauthorized' },
    );
    const attached = await call(fixture, manager, 'POST', '/sessions/attach', { port: 8100 });
    const sessionId = String((attached.payload.session as Record<string, unknown>).id);
    const result = await call(fixture, manager, 'POST', '/query', { sessionId, sql: 'SELECT 1' });
    expect(result.payload.ok).toBe(false);
    expect(result.payload.error).toBe('query_rejected');
    expect(String(result.payload.detail)).toContain('401');
  });
});

describe('a request naming a session counts as activity on it', () => {
  it('does not reap the session the query is for', async () => {
    const fixture = makeFixture();
    const current = loadIdaSqlConfig(fixture.configFile);
    saveIdaSqlConfig(fixture.configFile, { ...current, sessionIdleTimeoutMs: 60_000 });
    let clock = 4_000_000;
    const manager = new IdaSqlSessionManager({
      spawnProcess: () => ({ pid: 3131, onExit() {}, onOutput() {}, kill() {} }),
      httpRequest: async (url) =>
        url.endsWith('/status')
          ? { status: 200, text: '{"idasql":"1.0"}' }
          : { status: 200, text: '{"results":[{"columns":["n"],"rows":[[1]]}]}' },
      now: () => clock,
      sleep: async () => {},
      isPortFree: async () => true,
    });
    const attached = await call(
      fixture,
      manager,
      'POST',
      '/sessions/attach',
      { port: 8100 },
      clock,
    );
    const sessionId = String((attached.payload.session as Record<string, unknown>).id);

    // Come back after the idle window and run a query. The reaper runs first, so
    // without the touch this request killed its own session.
    clock += 10 * 60 * 1000;
    const queried = await call(
      fixture,
      manager,
      'POST',
      '/query',
      { sessionId, sql: 'SELECT 1' },
      clock,
    );
    expect(queried.status).toBe(200);
    expect(manager.get(sessionId)?.state).toBe('ready');

    // A session nobody named is still reaped.
    const other = await call(fixture, manager, 'POST', '/sessions/attach', { port: 8101 }, clock);
    const otherId = String((other.payload.session as Record<string, unknown>).id);
    clock += 10 * 60 * 1000;
    await call(fixture, manager, 'POST', '/query', { sessionId, sql: 'SELECT 1' }, clock);
    expect(manager.get(sessionId)?.state).toBe('ready');
    expect(manager.get(otherId)?.state).toBe('stopped');
  });
});

describe('the session cap is refused at preview time', () => {
  it('does not spend a standing grant on a start that cannot happen', async () => {
    const fixture = makeFixture([IDA_SQL_ANALYSIS_CAPABILITY, IDA_SQL_AUTO_SESSION_CAPABILITY]);
    const { manager } = makeManager();
    const wideConfig = { ...loadIdaSqlConfig(fixture.configFile), httpPortEnd: 8400 };
    saveIdaSqlConfig(fixture.configFile, wideConfig);

    // Fill the cap with GUI attachments (cheap, no spawn needed).
    for (let index = 0; index < 8; index += 1) {
      const attached = await call(fixture, manager, 'POST', '/sessions/attach', {
        port: 8100 + index,
      });
      expect(attached.status, `attach ${index}`).toBe(200);
    }

    const granted = await call(fixture, manager, 'POST', '/grants', {
      rootId: 'bins',
      maxSessions: 3,
    });
    expect(granted.status).toBe(200);

    const blocked = await call(fixture, manager, 'POST', '/sessions/preview', {
      binaryPath: fixture.binaryPath,
      auto: true,
    });
    const preview = blocked.payload.preview as { allowed: boolean; blockReasons: string[] };
    expect(preview.allowed).toBe(false);
    expect(preview.blockReasons).toContain('too_many_sessions');

    // The grant still has its full budget.
    const store = loadIdaSqlStandingGrantStore(fixture.home);
    expect(store.grants[0].usedSessions).toBe(0);
  });
});
