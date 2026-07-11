// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import {
  resolveAoiDaemonOptionsFromEnv,
  startAoiDaemon,
  type AoiDaemonHandle,
} from '../aoiDaemonServer';
import { startAoiAutonomyBackgroundFromEnv } from '../aoiAutonomyPlugin';
import { saveAoiStrategicBrief } from '../aoiStrategicBrief';
import { loadServerAoiRunLedger } from '../aoiRunLedgerServer';
import { buildAoiAppOperationDispatch } from '../aoiAppOperationDispatch';
import {
  appendAoiAppOperationDispatch,
  loadAoiActiveProposals,
  saveAoiActiveProposals,
} from '../aoiAutonomyStore';
import { getAoiApprovedAppActionPolicyForProposal } from '../aoiAutonomyPolicy';
import type { AoiAppOperationDispatch, AoiProposal, AoiStrategicBrief } from '../aoiAutonomyTypes';

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
    // The daemon is a dedicated autonomy host: the runner starts by default (the
    // per-session policy.enabled, default false, is the actual on/off -- so nothing
    // autonomous runs until the operator enables it from the UI).
    expect(handle.backgroundRunning).toBe(true);

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

  it('runs the loop by default and hard-disables only on AOI_AUTONOMY_BACKGROUND=0', async () => {
    // Daemon default: the runner is RUNNING (per-session policy.enabled gates the
    // actual autonomy; default false -> a safe idle no-op).
    const def = await bootTestDaemon({});
    expect(def.backgroundRunning).toBe(true);

    // Explicit hard ceiling: no runner at all.
    const off = await bootTestDaemon({ AOI_AUTONOMY_BACKGROUND: '0' });
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

describe('daemon health endpoint (GET /healthz)', () => {
  it('serves a metadata-only readiness snapshot with the loop running by default', async () => {
    const handle = await bootTestDaemon();
    const res = await fetch(`http://127.0.0.1:${handle.port}/healthz`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as {
      status?: string;
      loopRunning?: boolean;
      cognitionActive?: boolean;
      cyclesCompleted?: number;
      lastCycle?: unknown;
      uptimeMs?: number;
      errorsTotal?: number;
    };
    expect(body.status).toBe('ok');
    expect(body.loopRunning).toBe(true);
    // No cycle fires within the test window (5-min interval, not run-immediately),
    // so cognition is not yet active and no cycle summary exists.
    expect(body.cognitionActive).toBe(false);
    expect(body.cyclesCompleted).toBe(0);
    expect(body.lastCycle).toBeNull();
    expect(typeof body.uptimeMs).toBe('number');
    expect(body.uptimeMs).toBeGreaterThanOrEqual(0);
    expect(body.errorsTotal).toBe(0);
  });

  it('reports loopRunning=false when the loop is hard-disabled', async () => {
    const handle = await bootTestDaemon({ AOI_AUTONOMY_BACKGROUND: '0' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/healthz?probe=1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { loopRunning?: boolean; cognitionActive?: boolean };
    expect(body.loopRunning).toBe(false);
    expect(body.cognitionActive).toBe(false);
  });

  it('does not treat a non-GET /healthz or a look-alike path as the probe', async () => {
    const handle = await bootTestDaemon();
    const base = `http://127.0.0.1:${handle.port}`;
    // POST /healthz is not the probe -> falls through to 404.
    const post = await fetch(`${base}/healthz`, { method: 'POST' });
    expect(post.status).toBe(404);
    // A prefix look-alike must not match (exact path / query-only).
    const lookAlike = await fetch(`${base}/healthz-not-real`);
    expect(lookAlike.status).toBe(404);
  });
});

describe('daemon graceful shutdown (POST /shutdown)', () => {
  it('acks then gracefully closes the server', async () => {
    const handle = await bootTestDaemon();
    const res = await fetch(`http://127.0.0.1:${handle.port}/shutdown`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok?: boolean; shuttingDown?: boolean };
    expect(body.ok).toBe(true);
    expect(body.shuttingDown).toBe(true);
    // The deferred close() stops the listening server (timing-robust: poll the
    // socket state rather than race a follow-up request).
    await vi.waitFor(() => expect(handle.server.listening).toBe(false), { timeout: 2000 });
  });

  it('does not treat GET /shutdown or a look-alike path as the trigger', async () => {
    const handle = await bootTestDaemon();
    const base = `http://127.0.0.1:${handle.port}`;
    const get = await fetch(`${base}/shutdown`);
    expect(get.status).toBe(404);
    const lookAlike = await fetch(`${base}/shutdown-not-real`, { method: 'POST' });
    expect(lookAlike.status).toBe(404);
  });
});

describe('daemon memory decay routes (P4.1)', () => {
  const MEM_PATH = 'aoi/memory-v2/memories/decay-cand-1.json';

  function oldCandidateMemory(): Record<string, unknown> {
    return {
      version: 2,
      id: 'decay-cand-1',
      scope: 'user',
      type: 'fact',
      status: 'active',
      content: 'An old, low-confidence, unused fact.',
      normalizedContent: 'an old, low-confidence, unused fact.',
      importance: 0.2,
      confidence: 0.3,
      hits: 1,
      createdAt: 1,
      updatedAt: Date.now() - 100 * 24 * 60 * 60 * 1000, // ~100d old -> past the 90d floor
      sourceEpisodeIds: ['ep-1'],
      tags: [],
      entities: [],
    };
  }

  async function seedMemory(base: string, body: Record<string, unknown>): Promise<void> {
    const res = await fetch(`${base}/api/session-data?path=${encodeURIComponent(MEM_PATH)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
  }

  it('previews -> archives an approved candidate -> restores it (soft-delete lifecycle)', async () => {
    const handle = await bootTestDaemon();
    const base = `http://127.0.0.1:${handle.port}`;
    const api = `${base}/api/aoi-autonomy`;
    await seedMemory(base, oldCandidateMemory());

    // Read-only preview: the old memory is a candidate; capture the approval fingerprint.
    const preview = await fetch(`${api}/memory/decay-preview`);
    expect(preview.status).toBe(200);
    const previewBody = (await preview.json()) as {
      ok: boolean;
      candidates: Array<{ id: string }>;
      fingerprint: string;
    };
    expect(previewBody.ok).toBe(true);
    expect(previewBody.candidates.map((candidate) => candidate.id)).toContain('decay-cand-1');

    // Apply with the reviewed fingerprint -> archived (soft-delete).
    const apply = await fetch(`${api}/memory/decay-apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ['decay-cand-1'], approvalFingerprint: previewBody.fingerprint }),
    });
    expect(apply.status).toBe(200);
    expect((await apply.json()) as { archivedCount?: number }).toMatchObject({ archivedCount: 1 });

    // The file is kept, flipped to status 'archived' (recoverable, not deleted).
    const archived = await fetch(`${base}/api/session-data?path=${encodeURIComponent(MEM_PATH)}`);
    expect(((await archived.json()) as { status?: string }).status).toBe('archived');

    // Restore -> active again (ungated recovery).
    const restore = await fetch(`${api}/memory/decay-restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ['decay-cand-1'] }),
    });
    expect(restore.status).toBe(200);
    expect((await restore.json()) as { unarchivedCount?: number }).toMatchObject({
      unarchivedCount: 1,
    });
    const restored = await fetch(`${base}/api/session-data?path=${encodeURIComponent(MEM_PATH)}`);
    expect(((await restored.json()) as { status?: string }).status).toBe('active');
  });

  it('rejects an apply whose fingerprint does not match the reviewed set (nothing archived)', async () => {
    const handle = await bootTestDaemon();
    const base = `http://127.0.0.1:${handle.port}`;
    await seedMemory(base, oldCandidateMemory());

    const res = await fetch(`${base}/api/aoi-autonomy/memory/decay-apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ['decay-cand-1'], approvalFingerprint: 'stale-or-tampered' }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code?: string }).code).toBe('decay_approval_mismatch');

    // Fail-closed: the memory is still active (never archived on a mismatch).
    const still = await fetch(`${base}/api/session-data?path=${encodeURIComponent(MEM_PATH)}`);
    expect(((await still.json()) as { status?: string }).status).toBe('active');
  });

  it('writes an audit-ledger entry on archive and on restore', async () => {
    const sessionsDir = makeTempSessionsDir();
    const handle = await startAoiDaemon({
      sessionsDir,
      configFile: join(sessionsDir, 'config.json'),
      workspaceRoot: sessionsDir,
      host: '127.0.0.1',
      port: 0,
      env: {},
    });
    liveDaemons.push(handle);
    const api = `http://127.0.0.1:${handle.port}/api/aoi-autonomy`;

    // Seed a decay candidate directly on disk (same store the daemon reads).
    const memDir = join(sessionsDir, 'aoi', 'memory-v2', 'memories');
    fs.mkdirSync(memDir, { recursive: true });
    fs.writeFileSync(join(memDir, 'decay-cand-1.json'), JSON.stringify(oldCandidateMemory()));

    const preview = (await (await fetch(`${api}/memory/decay-preview`)).json()) as {
      fingerprint: string;
    };
    await fetch(`${api}/memory/decay-apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ['decay-cand-1'], approvalFingerprint: preview.fingerprint }),
    });
    // The archive left an audit trail (soft-delete is destructive-adjacent).
    expect(JSON.stringify(loadServerAoiRunLedger(sessionsDir, 'aoi/default'))).toContain(
      'memory_archived',
    );

    await fetch(`${api}/memory/decay-restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ['decay-cand-1'] }),
    });
    expect(JSON.stringify(loadServerAoiRunLedger(sessionsDir, 'aoi/default'))).toContain(
      'memory_restored',
    );
  });
});

describe('daemon crash-restart (P0.5)', () => {
  it('reclaims a stale loop lock left by a crashed daemon and starts the loop', async () => {
    const sessionsDir = makeTempSessionsDir();
    const lockPath = join(sessionsDir, '.aoi-autonomy-loop.lock');
    // Simulate a crash: a loop lock owned by a dead pid on THIS host (a clean stop
    // would have released it; a crash leaves it behind). A very high pid is not a
    // live process, so the lock is stale and must be reclaimed on restart.
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        kind: 'aoi-autonomy-loop',
        pid: 2147483646,
        host: os.hostname(),
        startedAt: 1,
      }),
    );
    // Durable state that must survive the restart.
    saveAoiStrategicBrief(sessionsDir, 'aoi/default', {
      version: 1,
      sessionPath: 'aoi/default',
      generatedAt: 1_700_000_000_000,
      tickReason: 'periodic',
      focusSummary: 'Survive a daemon restart',
      openThreads: [],
      blockedThreads: [],
      recentOutcomes: [],
      observationHighlights: [],
      evidenceRefs: [],
      acceptedCount: 0,
      blockedCount: 0,
      observationCount: 0,
      synthesizedBy: 'deterministic',
    });

    const handle = await startAoiDaemon({
      sessionsDir,
      configFile: join(sessionsDir, 'config.json'),
      workspaceRoot: sessionsDir,
      host: '127.0.0.1',
      port: 0,
      env: {},
    });
    liveDaemons.push(handle);

    // The restart reclaimed the stale lock and started the loop from known-good state.
    expect(handle.backgroundRunning).toBe(true);
    const reclaimed = JSON.parse(fs.readFileSync(lockPath, 'utf-8')) as { pid?: number };
    expect(reclaimed.pid).toBe(process.pid);

    // State continuity: the pre-restart brief is still served.
    const res = await fetch(
      `http://127.0.0.1:${handle.port}/api/aoi-autonomy/strategic-brief?sessionPath=aoi/default`,
    );
    const body = (await res.json()) as { brief?: { focusSummary?: string } | null };
    expect(body.brief?.focusSummary).toBe('Survive a daemon restart');
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

  it('starts by default when defaultStart is set (the daemon host path)', () => {
    const sessionsDir = makeTempSessionsDir();
    const handle = startAoiAutonomyBackgroundFromEnv(
      { sessionsDir, configFile: join(sessionsDir, 'config.json') },
      {},
      { defaultStart: true },
    );
    expect(handle).not.toBeNull();
    handle?.stop();
  });

  it('defaultStart is overridden by an explicit AOI_AUTONOMY_BACKGROUND=0', () => {
    const sessionsDir = makeTempSessionsDir();
    const handle = startAoiAutonomyBackgroundFromEnv(
      { sessionsDir, configFile: join(sessionsDir, 'config.json') },
      { AOI_AUTONOMY_BACKGROUND: '0' },
      { defaultStart: true },
    );
    expect(handle).toBeNull();
    expect(fs.existsSync(join(sessionsDir, '.aoi-autonomy-loop.lock'))).toBe(false);
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

describe('daemon strategic-brief route', () => {
  const briefFixture: AoiStrategicBrief = {
    version: 1,
    sessionPath: 'aoi/default',
    generatedAt: 1_700_000_000_000,
    tickReason: 'periodic',
    focusSummary: 'Continue hardening the kernel telemetry path',
    openThreads: ['harden the kernel telemetry path'],
    blockedThreads: [],
    recentOutcomes: [],
    observationHighlights: [],
    evidenceRefs: ['proposal:p1'],
    acceptedCount: 1,
    blockedCount: 0,
    observationCount: 2,
    synthesizedBy: 'deterministic',
  };

  it('returns a null brief when none is persisted', async () => {
    const handle = await bootTestDaemon();
    const res = await fetch(
      `http://127.0.0.1:${handle.port}/api/aoi-autonomy/strategic-brief?sessionPath=aoi/default`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok?: boolean; brief?: unknown };
    expect(body.ok).toBe(true);
    expect(body.brief).toBeNull();
  });

  it('returns the persisted brief a tick saved (read-only, survives reload without a tick)', async () => {
    const sessionsDir = makeTempSessionsDir();
    saveAoiStrategicBrief(sessionsDir, 'aoi/default', briefFixture);
    const handle = await startAoiDaemon({
      sessionsDir,
      configFile: join(sessionsDir, 'config.json'),
      workspaceRoot: sessionsDir,
      host: '127.0.0.1',
      port: 0,
      env: {},
    });
    liveDaemons.push(handle);
    const res = await fetch(
      `http://127.0.0.1:${handle.port}/api/aoi-autonomy/strategic-brief?sessionPath=aoi/default`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { brief?: { focusSummary?: string } | null };
    expect(body.brief?.focusSummary).toContain('telemetry');
  });

  it('rejects a missing sessionPath', async () => {
    const handle = await bootTestDaemon();
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/aoi-autonomy/strategic-brief`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('invalid_session_path');
  });
});

describe('daemon app-operation-dispatch route (B3-1 client-mediated dispatch)', () => {
  function makeAppActionProposal(): AoiProposal {
    return {
      version: 1,
      id: 'prop-1',
      sessionPath: 'aoi/default',
      status: 'active',
      title: 'Play the queued track',
      body: 'x',
      reason: 'x',
      trigger: 'x',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      cooldownKey: 'k',
      confidence: 0.8,
      risk: 'low',
      requiredAutonomyLevel: 'L3',
      requiresUserApproval: false,
      suggestedTools: [],
      evidenceRefs: [],
      memoryIds: [],
      artifactRefs: [],
      riskSignals: [],
      acceptAction: {
        kind: 'app_action',
        params: { appName: 'musicApp', actionType: 'PLAY_TRACK', trackId: '123' },
      },
    };
  }

  function seedPendingDispatch(sessionsDir: string): AoiAppOperationDispatch {
    // The GET route now re-checks the approval fingerprint SERVER-SIDE, so the dispatch
    // must have a backing proposal whose recomputed fingerprint matches. Derive it from
    // the seeded proposal (the fingerprint is content-addressed + time-independent).
    saveAoiActiveProposals(sessionsDir, 'aoi/default', [makeAppActionProposal()]);
    // Derive the fingerprint from the LOADED proposal so it matches exactly what the
    // route recomputes (guards against any save/load normalization).
    const loaded = loadAoiActiveProposals(sessionsDir, 'aoi/default').find(
      (p) => p.id === 'prop-1',
    );
    const approvalFingerprint = getAoiApprovedAppActionPolicyForProposal(
      loaded as AoiProposal,
      1_700_000_000_000,
    ).approvalFingerprint;
    return appendAoiAppOperationDispatch(
      sessionsDir,
      'aoi/default',
      buildAoiAppOperationDispatch({
        sessionPath: 'aoi/default',
        appId: 7,
        appName: 'musicApp',
        actionType: 'PLAY_TRACK',
        params: { trackId: '123' },
        approvalFingerprint,
        proposalId: 'prop-1',
        decisionId: 'dec-1',
        evidenceRefs: ['proposal:prop-1'],
        now: 1_700_000_000_000,
      }),
    );
  }

  async function bootDaemonOn(sessionsDir: string): Promise<AoiDaemonHandle> {
    const handle = await startAoiDaemon({
      sessionsDir,
      configFile: join(sessionsDir, 'config.json'),
      workspaceRoot: sessionsDir,
      host: '127.0.0.1',
      port: 0,
      env: {},
    });
    liveDaemons.push(handle);
    return handle;
  }

  it('GET returns queued pending dispatches; POST report resolves them in place', async () => {
    const sessionsDir = makeTempSessionsDir();
    const seeded = seedPendingDispatch(sessionsDir);
    const handle = await bootDaemonOn(sessionsDir);
    const base = `http://127.0.0.1:${handle.port}/api/aoi-autonomy/app-operation-dispatch`;

    // The client bridge polls pending dispatches.
    const pendingRes = await fetch(`${base}?sessionPath=aoi/default`);
    expect(pendingRes.status).toBe(200);
    const pendingBody = (await pendingRes.json()) as {
      ok?: boolean;
      pending?: AoiAppOperationDispatch[];
    };
    expect(pendingBody.ok).toBe(true);
    expect(pendingBody.pending).toHaveLength(1);
    expect(pendingBody.pending?.[0].id).toBe(seeded.id);
    expect(pendingBody.pending?.[0].actionType).toBe('PLAY_TRACK');

    // The bridge reports the agent->app dispatch result.
    const reportRes = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionPath: 'aoi/default',
        id: seeded.id,
        status: 'dispatched',
        actionResult: 'success',
        now: 1_700_000_001_000,
      }),
    });
    expect(reportRes.status).toBe(200);
    const reportBody = (await reportRes.json()) as {
      dispatch?: AoiAppOperationDispatch;
      alreadyResolved?: boolean;
    };
    expect(reportBody.dispatch?.status).toBe('dispatched');
    expect(reportBody.dispatch?.actionResult).toBe('success');
    expect(reportBody.alreadyResolved).toBe(false);

    // After the report the record is terminal -> no longer pending.
    const afterRes = await fetch(`${base}?sessionPath=aoi/default`);
    const afterBody = (await afterRes.json()) as { pending?: AoiAppOperationDispatch[] };
    expect(afterBody.pending).toHaveLength(0);
  });

  it('GET drops a dispatch whose stored approval fingerprint no longer matches (P2.2 server re-check)', async () => {
    const sessionsDir = makeTempSessionsDir();
    // A backing proposal exists, but the dispatch carries a stale fingerprint that the
    // server-side recompute will not match.
    saveAoiActiveProposals(sessionsDir, 'aoi/default', [makeAppActionProposal()]);
    const seeded = appendAoiAppOperationDispatch(
      sessionsDir,
      'aoi/default',
      buildAoiAppOperationDispatch({
        sessionPath: 'aoi/default',
        appId: 7,
        appName: 'musicApp',
        actionType: 'PLAY_TRACK',
        params: { trackId: '123' },
        approvalFingerprint: 'fp-stale-does-not-match',
        proposalId: 'prop-1',
        decisionId: 'dec-1',
        evidenceRefs: ['proposal:prop-1'],
        now: 1_700_000_000_000,
      }),
    );
    const handle = await bootDaemonOn(sessionsDir);
    const res = await fetch(
      `http://127.0.0.1:${handle.port}/api/aoi-autonomy/app-operation-dispatch?sessionPath=aoi/default`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      pending?: AoiAppOperationDispatch[];
      rejected?: { id: string; reason: string }[];
    };
    // Never advertised to the client bridge...
    expect(body.pending).toHaveLength(0);
    // ...and surfaced as rejected for operator observability.
    expect(body.rejected).toEqual([{ id: seeded.id, reason: 'approval_fingerprint_mismatch' }]);
  });

  it('POST returns 404 for an unknown dispatch id', async () => {
    const handle = await bootTestDaemon();
    const res = await fetch(
      `http://127.0.0.1:${handle.port}/api/aoi-autonomy/app-operation-dispatch`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionPath: 'aoi/default', id: 'nope', status: 'dispatched' }),
      },
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('dispatch_not_found');
  });

  it('POST rejects a missing id, an invalid status, and a missing sessionPath', async () => {
    const handle = await bootTestDaemon();
    const base = `http://127.0.0.1:${handle.port}/api/aoi-autonomy/app-operation-dispatch`;

    const noId = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionPath: 'aoi/default', status: 'dispatched' }),
    });
    expect(noId.status).toBe(400);
    expect(((await noId.json()) as { code?: string }).code).toBe('invalid_dispatch_id');

    const badStatus = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionPath: 'aoi/default', id: 'x', status: 'pending' }),
    });
    expect(badStatus.status).toBe(400);
    expect(((await badStatus.json()) as { code?: string }).code).toBe('invalid_dispatch_status');

    const noSession = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'x', status: 'dispatched' }),
    });
    expect(noSession.status).toBe(400);
    expect(((await noSession.json()) as { code?: string }).code).toBe('invalid_session_path');
  });

  it('GET rejects a missing sessionPath', async () => {
    const handle = await bootTestDaemon();
    const res = await fetch(
      `http://127.0.0.1:${handle.port}/api/aoi-autonomy/app-operation-dispatch`,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code?: string }).code).toBe('invalid_session_path');
  });
});

describe('daemon memory embedding-status route (P4.4)', () => {
  function memoryFileBody(id: string, embedding?: number[]): Record<string, unknown> {
    return {
      version: 2,
      id,
      scope: 'user',
      type: 'fact',
      status: 'active',
      content: `A fact ${id}.`,
      normalizedContent: `a fact ${id}.`,
      importance: 0.5,
      confidence: 0.8,
      hits: 1,
      createdAt: 1,
      updatedAt: 1,
      sourceEpisodeIds: ['ep-1'],
      tags: [],
      entities: [],
      ...(embedding ? { embedding, embeddingModel: 'test-model' } : {}),
    };
  }

  async function seed(base: string, id: string, embedding?: number[]): Promise<void> {
    const path = `aoi/memory-v2/memories/${id}.json`;
    const res = await fetch(`${base}/api/session-data?path=${encodeURIComponent(path)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(memoryFileBody(id, embedding)),
    });
    expect(res.status).toBe(200);
  }

  it('reports active/embedded/pending counts and a keyless (no-provider) default', async () => {
    const handle = await bootTestDaemon();
    const base = `http://127.0.0.1:${handle.port}`;
    await seed(base, 'embed-1', [0.1, 0.2]);
    await seed(base, 'embed-2');

    const res = await fetch(`${base}/api/aoi-autonomy/memory/embedding-status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      providerConfigured: boolean;
      providerModel: string | null;
      activeCount: number;
      embeddedCount: number;
      pendingCount: number;
    };
    expect(body.ok).toBe(true);
    // No embedding key in the test config -> keyless, so recall is lexical-only.
    expect(body.providerConfigured).toBe(false);
    expect(body.providerModel).toBeNull();
    expect(body.activeCount).toBe(2);
    expect(body.embeddedCount).toBe(1);
    expect(body.pendingCount).toBe(1);
  });
});

describe('daemon unified operator snapshot route (P5.3)', () => {
  it('serves the display_only unified operator summary built from real stores', async () => {
    const handle = await bootTestDaemon();
    const res = await fetch(
      `http://127.0.0.1:${handle.port}/api/aoi-autonomy/operator/unified-snapshot`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      summary: { actionAuthority: string; sessionPath: string };
    };
    expect(body.ok).toBe(true);
    // The previously-dark model is now surfaced -- display_only by construction.
    expect(body.summary.actionAuthority).toBe('display_only');
    expect(body.summary.sessionPath).toBe('aoi/default');
  });
});

describe('daemon readiness-accrual route (P5.4)', () => {
  it('serves the trust on-ramp readiness accrual (sample count -> directChatReady)', async () => {
    const handle = await bootTestDaemon();
    const res = await fetch(
      `http://127.0.0.1:${handle.port}/api/aoi-autonomy/operator/readiness-accrual`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      readiness: { status: string; sampleCount: number; directChatReady: boolean };
    };
    expect(body.ok).toBe(true);
    // A fresh session is measuring / not ready, with a numeric sample count and a boolean gate.
    expect(typeof body.readiness.sampleCount).toBe('number');
    expect(typeof body.readiness.directChatReady).toBe('boolean');
    expect(body.readiness.directChatReady).toBe(false);
  });
});
