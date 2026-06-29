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

describe('daemon session-data store', () => {
  it('serves session-data read/write/list and session-reset (durable memory endpoint)', async () => {
    const handle = await bootTestDaemon();
    const base = `http://127.0.0.1:${handle.port}`;
    const rel = 'aoi/memory-v2/memories/d1.json';
    const body = { id: 'd1', kind: 'fact' };

    const post = await fetch(`${base}/api/session-data?path=${encodeURIComponent(rel)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(post.status).toBe(200);

    const get = await fetch(`${base}/api/session-data?path=${encodeURIComponent(rel)}`);
    expect(get.status).toBe(200);
    expect(await get.json()).toEqual(body);

    const list = await fetch(
      `${base}/api/session-data?path=${encodeURIComponent('aoi/memory-v2/memories')}&action=list`,
    );
    const listData = (await list.json()) as { files: Array<{ path: string }> };
    expect(listData.files.some((f) => f.path.endsWith('d1.json'))).toBe(true);

    const reset = await fetch(`${base}/api/session-reset?path=${encodeURIComponent('aoi')}`, {
      method: 'DELETE',
    });
    expect(reset.status).toBe(200);
    const afterReset = await fetch(`${base}/api/session-data?path=${encodeURIComponent(rel)}`);
    expect(await afterReset.json()).toEqual({});
  });

  it('still 404s a path that neither autonomy nor session-data owns', async () => {
    const handle = await bootTestDaemon();
    // A session-data-prefixed typo proves exact-match routing, not prefix capture.
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/session-data-typo?path=x`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('route_not_found');
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
    // Real temp dir: the loop starter now touches the fs for the single-instance
    // lock, so it can no longer be exercised against a non-existent path.
    const sessionsDir = makeTempSessionsDir();
    const handle = startAoiAutonomyBackgroundFromEnv(
      { sessionsDir, configFile: join(sessionsDir, 'config.json') },
      {},
    );
    expect(handle).toBeNull();
    // OFF-by-default must not write the lock file.
    expect(fs.existsSync(join(sessionsDir, '.aoi-autonomy-loop.lock'))).toBe(false);
  });

  it('returns a stoppable handle when opted in via env', () => {
    const sessionsDir = makeTempSessionsDir();
    const handle = startAoiAutonomyBackgroundFromEnv(
      { sessionsDir, configFile: join(sessionsDir, 'config.json') },
      { AOI_AUTONOMY_BACKGROUND: '1' },
    );
    expect(handle).not.toBeNull();
    // The interval is unref'd and no cycle runs before stop(); release it now.
    handle?.stop();
  });
});

describe('autonomy loop single-instance lock', () => {
  it('refuses a second loop against the same session dir and frees it on stop', () => {
    const sessionsDir = makeTempSessionsDir();
    const options = { sessionsDir, configFile: join(sessionsDir, 'config.json') };
    const env = { AOI_AUTONOMY_BACKGROUND: '1' };

    const first = startAoiAutonomyBackgroundFromEnv(options, env);
    expect(first).not.toBeNull();

    // A second loop against the SAME dir is refused while the first is live --
    // this is the daemon-vs-daemon / daemon-vs-Vite double-tick guard.
    const second = startAoiAutonomyBackgroundFromEnv(options, env);
    expect(second).toBeNull();

    // After the first releases its lock on stop(), the dir can be locked again.
    first?.stop();
    const third = startAoiAutonomyBackgroundFromEnv(options, env);
    expect(third).not.toBeNull();
    third?.stop();
  });
});
