// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import {
  resolveAoiDaemonOptionsFromEnv,
  startAoiDaemon,
  type AoiDaemonHandle,
} from '../aoiDaemonServer';
import { startAoiAutonomyBackgroundFromEnv } from '../aoiAutonomyPlugin';

const tempRoots: string[] = [];
const liveDaemons: AoiDaemonHandle[] = [];

function makeTempSessionsDir(): string {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'aoi-daemon-'));
  tempRoots.push(dir);
  return dir;
}

async function bootTestDaemon(
  env: Record<string, string | undefined> = {},
): Promise<AoiDaemonHandle> {
  const sessionsDir = makeTempSessionsDir();
  const handle = await startAoiDaemon({
    sessionsDir,
    configFile: join(sessionsDir, 'config.json'),
    workspaceRoot: sessionsDir,
    host: '127.0.0.1',
    port: 0,
    env,
  });
  liveDaemons.push(handle);
  return handle;
}

afterEach(async () => {
  while (liveDaemons.length > 0) {
    const handle = liveDaemons.pop();
    if (handle) {
      await handle.close();
    }
  }
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('startAoiDaemon', () => {
  it('binds an ephemeral port and routes into the shared autonomy handler', async () => {
    const handle = await bootTestDaemon();
    expect(handle.port).toBeGreaterThan(0);
    expect(handle.backgroundRunning).toBe(false);

    const base = `http://127.0.0.1:${handle.port}`;

    // Missing sessionPath is rejected by handleAoiAutonomyRequest -- proves the
    // daemon delegates to the same routing logic the Vite plugin uses.
    const missing = await fetch(`${base}/api/aoi-autonomy/status`);
    expect(missing.status).toBe(400);
    const missingBody = (await missing.json()) as { code?: string };
    expect(missingBody.code).toBe('invalid_session_path');

    // A valid sessionPath returns a default status for a brand-new session.
    const ok = await fetch(`${base}/api/aoi-autonomy/status?sessionPath=aoi/default`);
    expect(ok.status).toBe(200);
    const okBody = (await ok.json()) as { ok?: boolean };
    expect(okBody.ok).toBe(true);
  });

  it('returns 404 for paths the autonomy routes do not own', async () => {
    const handle = await bootTestDaemon();
    const res = await fetch(`http://127.0.0.1:${handle.port}/not-an-autonomy-route`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('route_not_found');
  });

  it('keeps the background loop OFF by default and ON only when opted in', async () => {
    const off = await bootTestDaemon({});
    expect(off.backgroundRunning).toBe(false);

    const on = await bootTestDaemon({ AOI_AUTONOMY_BACKGROUND: '1' });
    expect(on.backgroundRunning).toBe(true);
    // The loop's interval is stopped by close() in afterEach -- no leak.
  });

  it('has an idempotent close()', async () => {
    const handle = await bootTestDaemon();
    await handle.close();
    await expect(handle.close()).resolves.toBeUndefined();
  });
});

describe('resolveAoiDaemonOptionsFromEnv', () => {
  it('defaults to the shared ~/.openroom session store and loopback bind', () => {
    const options = resolveAoiDaemonOptionsFromEnv({});
    expect(options.sessionsDir.endsWith(join('.openroom', 'sessions'))).toBe(true);
    expect(options.configFile.endsWith(join('.openroom', 'config.json'))).toBe(true);
    expect(options.host).toBe('127.0.0.1');
    expect(options.port).toBe(7333);
  });

  it('honors AOI_DAEMON_* overrides', () => {
    const options = resolveAoiDaemonOptionsFromEnv({
      AOI_DAEMON_SESSIONS_DIR: '/custom/sessions',
      AOI_DAEMON_CONFIG_FILE: '/custom/config.json',
      AOI_DAEMON_HOST: '0.0.0.0',
      AOI_DAEMON_PORT: '9999',
    });
    expect(options.sessionsDir).toBe('/custom/sessions');
    expect(options.configFile).toBe('/custom/config.json');
    expect(options.host).toBe('0.0.0.0');
    expect(options.port).toBe(9999);
  });

  it('falls back to the default port for an out-of-range or invalid value', () => {
    expect(resolveAoiDaemonOptionsFromEnv({ AOI_DAEMON_PORT: '70000' }).port).toBe(7333);
    expect(resolveAoiDaemonOptionsFromEnv({ AOI_DAEMON_PORT: 'nope' }).port).toBe(7333);
    // 0 is a valid ephemeral-port request and must pass through.
    expect(resolveAoiDaemonOptionsFromEnv({ AOI_DAEMON_PORT: '0' }).port).toBe(0);
  });
});

describe('startAoiAutonomyBackgroundFromEnv', () => {
  it('returns null when the loop is not opted in', () => {
    const handle = startAoiAutonomyBackgroundFromEnv(
      { sessionsDir: '/sessions', configFile: '/config.json' },
      {},
    );
    expect(handle).toBeNull();
  });

  it('returns a stoppable handle when opted in via env', () => {
    const handle = startAoiAutonomyBackgroundFromEnv(
      { sessionsDir: '/sessions', configFile: '/config.json' },
      { AOI_AUTONOMY_BACKGROUND: '1' },
    );
    expect(handle).not.toBeNull();
    // The interval is unref'd and no cycle runs before stop(); release it now.
    handle?.stop();
  });
});
