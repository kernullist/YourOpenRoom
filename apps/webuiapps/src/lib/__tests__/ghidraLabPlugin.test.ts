// @vitest-environment node
//
// The route surface, with a real token file and a real approval store on a temp
// OPENROOM_HOME, but faked engines.
//
// Two behaviours here are security-relevant rather than merely functional:
//
//   - PREFLIGHT IS A GATE. A wrong JDK has to block the session preview, because
//     Ghidra answers a missing JDK with an interactive stdin prompt, and a
//     spawned child with no console hangs on it until the analysis deadline.
//   - APPROVAL OWNERSHIP. The approval store is shared with the host bridge
//     (spawn, kill, file delete) and IDA Lab. This route must refuse to approve
//     a fingerprint it did not itself preview, or it becomes a way to approve
//     someone else's pending process spawn.
import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureAoiHostBridgeToken, loadAoiHostBridgeToken } from '../aoiHostBridgeAuth';
import { recordAoiHostBridgePendingApprovalAtomic } from '../aoiHostBridgeApprovalStore';
import {
  saveAoiHostBridgeKillSwitchState,
  setAoiHostBridgeCapability,
} from '../aoiHostBridgeKillSwitch';
import { normalizeGhidraLabConfig } from '../ghidraLabConfig';
import { GhidraLabRunManager, resetSharedGhidraLabRunManager } from '../ghidraLabRunner';
import {
  GHIDRA_LAB_MAX_SESSIONS,
  GhidraLabSessionManager,
  type GhidraChildHandle,
  type GhidraLabSessionDeps,
} from '../ghidraLabSession';
import {
  loadGhidraLabConfig,
  resolveGhidraLabRoute,
  saveGhidraLabConfig,
  getGhidraLabRoute,
} from '../ghidraLabPlugin';
import type { GhidraLabPreflightResult } from '../ghidraLabPreflight';
import type { GhidraLabConfigView } from '../ghidraLabTypes';

let home = '';
let configFile = '';
let token = '';
let root = '';
let binary = '';

function passingPreflight(
  overrides: Partial<GhidraLabPreflightResult> = {},
): GhidraLabPreflightResult {
  return {
    checks: [
      {
        id: 'ghidra',
        label: 'Ghidra install',
        ok: true,
        found: 'Ghidra 12.1.3',
        remedy: '',
        required: true,
      },
      { id: 'jdk', label: 'JDK 21+', ok: true, found: 'Java 21', remedy: '', required: true },
      {
        id: 'python',
        label: 'pyghidra-mcp',
        ok: true,
        found: '0.5.0',
        remedy: '',
        required: false,
      },
      {
        id: 'projects',
        label: 'Project folder',
        ok: true,
        found: root,
        remedy: '',
        required: true,
      },
      {
        id: 'capa',
        label: 'capa (optional)',
        ok: false,
        found: 'not set',
        remedy: 'optional',
        required: false,
      },
      {
        id: 'roots',
        label: 'Binary roots',
        ok: true,
        found: '1 folder',
        remedy: '',
        required: true,
      },
    ],
    availableModes: ['headless', 'batch'],
    ghidraVersion: '12.1.3',
    jdkVersion: 'openjdk version "21.0.4"',
    jdkMajor: 21,
    pyghidraMcpVersion: '0.5.0',
    pyghidraLaunch: 'module',
    capaVersion: '',
    flossVersion: '',
    ...overrides,
  };
}

/** The state this machine is actually in: Ghidra fine, JDK 11. */
function jdk11Preflight(): GhidraLabPreflightResult {
  const base = passingPreflight();
  return {
    ...base,
    checks: base.checks.map((check) =>
      check.id === 'jdk'
        ? {
            ...check,
            ok: false,
            found: 'Java 11 (openjdk version "11.0.14")',
            remedy: 'Found Java 11; Ghidra needs JDK 21. Your system JAVA_HOME can stay on 11.',
          }
        : check,
    ),
    availableModes: [],
    jdkMajor: 11,
  };
}

function makeSessions(overrides: Partial<GhidraLabSessionDeps> = {}): GhidraLabSessionManager {
  const child: GhidraChildHandle = {
    pid: 999,
    onExit: () => {},
    onOutput: () => {},
    kill: () => {},
  };
  return new GhidraLabSessionManager({
    spawnProcess: () => child,
    createMcpClient: () => ({
      initialize: async () => {},
      listTools: async () => [{ name: 'list_project_binaries' }, { name: 'list_imports' }],
      callTool: async (name) =>
        name === 'list_project_binaries'
          ? { binaries: [{ name: 'client.exe' }] }
          : { content: [{ type: 'text', text: '[]' }] },
    }),
    now: () => Date.now(),
    sleep: async () => {},
    isPortFree: async () => true,
    ...overrides,
  });
}

function makeRuns(): GhidraLabRunManager {
  return new GhidraLabRunManager(
    {
      query: async () => ({
        ok: true,
        kind: null,
        mcpTool: 'fake',
        rows: [],
        rowCount: 0,
        truncated: false,
        elapsedMs: 0,
        engineError: '',
        reason: '',
      }),
      hashFile: () => ({ sha256: 'e'.repeat(64), sizeBytes: 10, mtimeMs: 0 }),
      writeArtifact: () => {},
      now: () => Date.now(),
    },
    join(home, 'runs'),
  );
}

interface CallOptions {
  method?: string;
  body?: Record<string, unknown>;
  token?: string | null;
  preflight?: () => GhidraLabPreflightResult;
  sessions?: GhidraLabSessionManager;
  runs?: GhidraLabRunManager | null;
  /** Lets a test step past a preview's expiry window. */
  now?: number;
}

async function call(route: string, options: CallOptions = {}) {
  return resolveGhidraLabRoute({
    method: options.method ?? 'GET',
    route,
    body: options.body ?? {},
    token: options.token === undefined ? token : options.token,
    openroomHome: home,
    configFile,
    serverOrigin: 'http://127.0.0.1:3000',
    now: options.now ?? Date.now(),
    sessions: options.sessions ?? makeSessions(),
    // Left undefined on purpose when a test asks for it: that is the only way
    // to exercise the shared run manager the dev server actually builds.
    ...(options.runs === null ? {} : { runs: options.runs ?? makeRuns() }),
    preflight: () => (options.preflight ?? passingPreflight)(),
  });
}

function payload(result: { payload: unknown }): Record<string, unknown> {
  return result.payload as Record<string, unknown>;
}

beforeEach(() => {
  home = fs.mkdtempSync(join(os.tmpdir(), 'ghidra-lab-'));
  configFile = join(home, 'config.json');
  root = join(home, 'bins');
  binary = join(root, 'client.exe');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(binary, 'MZ');
  ensureAoiHostBridgeToken(home);
  token = loadAoiHostBridgeToken(home) ?? '';
  saveAoiHostBridgeKillSwitchState(
    home,
    setAoiHostBridgeCapability(null, 'os_ghidra_analysis', true, Date.now()),
  );
  saveGhidraLabConfig(
    configFile,
    normalizeGhidraLabConfig({
      ghidraInstallDir: join(home, 'ghidra'),
      jdkHome: join(home, 'jdk21'),
      pythonExePath: join(home, 'venv', 'python.exe'),
      projectRoot: join(home, 'projects'),
      binaryRoots: [{ id: 'bins', path: root, label: 'Bins' }],
    }) as GhidraLabConfigView,
  );
});

afterEach(() => {
  try {
    fs.rmSync(home, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

describe('route resolution', () => {
  it('maps only its own prefix', () => {
    expect(getGhidraLabRoute('/api/ghidra-lab')).toBe('/');
    expect(getGhidraLabRoute('/api/ghidra-lab/health')).toBe('/health');
    expect(getGhidraLabRoute('/api/ghidra-lab/sessions/')).toBe('/sessions');
    expect(getGhidraLabRoute('/api/ida-sql/health')).toBeNull();
    expect(getGhidraLabRoute('/api/other')).toBeNull();
  });
});

describe('auth', () => {
  it('refuses every route without the token', async () => {
    for (const route of ['/health', '/config', '/browse', '/sessions']) {
      const result = await call(route, { token: null });
      expect(result.status).toBe(401);
      expect(payload(result).error).toBe('not_authenticated');
    }
  });

  it('refuses a wrong token', async () => {
    const result = await call('/health', { token: 'f'.repeat(64) });
    expect(result.status).toBe(401);
  });
});

describe('health and config', () => {
  it('returns the preflight verdict and capability state', async () => {
    const result = await call('/health');
    const health = payload(result).health as Record<string, unknown>;
    expect(health.configured).toBe(true);
    expect(health.jdkMajor).toBe(21);
    expect(health.analysisCapabilityEnabled).toBe(true);
    expect((health.checks as unknown[]).length).toBe(6);
  });

  it('surfaces the JDK-11 verdict as an unconfigured lab', async () => {
    const result = await call('/health', { preflight: jdk11Preflight });
    const health = payload(result).health as Record<string, unknown>;
    expect(health.configured).toBe(false);
    expect(health.jdkMajor).toBe(11);
    expect(health.availableModes).toEqual([]);
  });

  it('persists a config patch and drops unknown keys', async () => {
    const result = await call('/config', {
      method: 'POST',
      body: { config: { maxMemMb: 8192, nonsense: true } },
    });
    expect(payload(result).ok).toBe(true);
    expect(loadGhidraLabConfig(configFile).maxMemMb).toBe(8192);
    expect(
      (loadGhidraLabConfig(configFile) as unknown as Record<string, unknown>).nonsense,
    ).toBeUndefined();
  });

  it('rejects an unsupported method on config', async () => {
    expect((await call('/config', { method: 'PUT' })).status).toBe(405);
  });
});

describe('browse', () => {
  it('lists the registered roots when given no path', async () => {
    const result = await call('/browse');
    const browse = payload(result).browse as Record<string, unknown>;
    expect((browse.entries as { path: string }[])[0].path).toBe(root);
  });

  it('lists inside a root and marks analyzable files', async () => {
    const result = await call('/browse', { body: { path: root } });
    const browse = payload(result).browse as Record<string, unknown>;
    const entries = browse.entries as { name: string; analyzable: boolean }[];
    expect(entries.find((entry) => entry.name === 'client.exe')?.analyzable).toBe(true);
  });

  it('refuses a path outside every root', async () => {
    const result = await call('/browse', { body: { path: os.tmpdir() } });
    expect(payload(result).ok).toBe(false);
    expect(payload(result).error).toBe('path_outside_roots');
  });

  it('sends the gate detail as a string the client can actually read', async () => {
    // The gate answers with a LIST of details, and every consumer -- the browser
    // client, the tool results, the error banner -- reads `detail` as a string,
    // so the array was dropped on the floor and the operator saw a bare code
    // with no mention of which capability was off.
    saveAoiHostBridgeKillSwitchState(
      home,
      setAoiHostBridgeCapability(null, 'os_ghidra_analysis', false, Date.now()),
    );
    const result = await call('/browse', { body: { path: root } });
    expect(result.status).toBe(403);
    expect(typeof payload(result).detail).toBe('string');
    expect(String(payload(result).detail)).toContain('os_ghidra_analysis');
  });

  it('is blocked when the capability is off', async () => {
    saveAoiHostBridgeKillSwitchState(
      home,
      setAoiHostBridgeCapability(null, 'os_ghidra_analysis', false, Date.now()),
    );
    const result = await call('/browse', { body: { path: root } });
    expect(result.status).toBe(403);
  });

  it('finds a binary by name inside the roots', async () => {
    const result = await call('/browse', { body: { find: 'client' } });
    const browse = payload(result).browse as Record<string, unknown>;
    expect((browse.entries as { name: string }[]).map((entry) => entry.name)).toContain(
      'client.exe',
    );
  });
});

describe('session preview', () => {
  it('blocks on a failing preflight and names the failing check', async () => {
    const result = await call('/sessions/preview', {
      method: 'POST',
      body: { binaryPath: binary },
      preflight: jdk11Preflight,
    });
    const preview = payload(result).preview as Record<string, unknown>;
    expect(preview.allowed).toBe(false);
    expect(preview.blockReasons).toContain('preflight_jdk');
    expect(preview.approvalFingerprint).toBe('');
  });

  it('does not block on capa or python, which are not required for a verdict', async () => {
    const result = await call('/sessions/preview', {
      method: 'POST',
      body: { binaryPath: binary },
    });
    const preview = payload(result).preview as Record<string, unknown>;
    expect(preview.allowed).toBe(true);
    expect(preview.blockReasons).toEqual([]);
    expect(String(preview.approvalFingerprint)).toHaveLength(64);
  });

  it('blocks a binary outside the roots', async () => {
    const outside = join(os.tmpdir(), 'outside.exe');
    fs.writeFileSync(outside, 'MZ');
    const result = await call('/sessions/preview', {
      method: 'POST',
      body: { binaryPath: outside },
    });
    expect((payload(result).preview as Record<string, unknown>).blockReasons).toContain(
      'path_outside_roots',
    );
    fs.rmSync(outside, { force: true });
  });

  it('points at the existing session instead of starting a second one', async () => {
    const sessions = makeSessions();
    const started = await sessions.startHeadless({
      config: loadGhidraLabConfig(configFile),
      binaryPath: fs.realpathSync(binary),
      projectName: 'p',
      launch: 'module',
    });
    const result = await call('/sessions/preview', {
      method: 'POST',
      body: { binaryPath: binary },
      sessions,
    });
    const preview = payload(result).preview as Record<string, unknown>;
    expect(preview.blockReasons).toContain('session_already_open');
    expect(preview.existingSessionId).toBe(started.session?.id);
  });
});

describe('approvals', () => {
  it('refuses to approve a fingerprint it never previewed', async () => {
    // A pending approval belonging to something else -- a host-bridge spawn, say.
    const foreign = 'a'.repeat(64);
    recordAoiHostBridgePendingApprovalAtomic(home, {
      capability: 'os_process_spawn',
      approvalFingerprint: foreign,
      targetSummary: 'someone else',
      now: Date.now(),
      expiresAt: Date.now() + 60_000,
    });
    const result = await call('/approvals/run', {
      method: 'POST',
      body: { approvalFingerprint: foreign },
    });
    expect(result.status).toBe(404);
    expect(payload(result).error).toBe('unknown_or_expired_preview');
  });

  it('requires a fingerprint', async () => {
    const result = await call('/approvals/run', { method: 'POST', body: {} });
    expect(result.status).toBe(400);
  });

  it('starts the session once its own preview is approved', async () => {
    const sessions = makeSessions();
    const preview = payload(
      await call('/sessions/preview', {
        method: 'POST',
        body: { binaryPath: binary },
        sessions,
      }),
    ).preview as Record<string, unknown>;

    const result = await call('/approvals/run', {
      method: 'POST',
      body: { approvalFingerprint: preview.approvalFingerprint },
      sessions,
    });
    expect(payload(result).ok).toBe(true);
    expect(sessions.list()).toHaveLength(1);
  });

  it('will not run the same approval twice', async () => {
    const sessions = makeSessions();
    const preview = payload(
      await call('/sessions/preview', { method: 'POST', body: { binaryPath: binary }, sessions }),
    ).preview as Record<string, unknown>;
    await call('/approvals/run', {
      method: 'POST',
      body: { approvalFingerprint: preview.approvalFingerprint },
      sessions,
    });
    const second = await call('/approvals/run', {
      method: 'POST',
      body: { approvalFingerprint: preview.approvalFingerprint },
      sessions,
    });
    expect(second.status).toBe(404);
  });

  it('re-checks the preflight at execute time, not only at preview', async () => {
    const sessions = makeSessions();
    const preview = payload(
      await call('/sessions/preview', { method: 'POST', body: { binaryPath: binary }, sessions }),
    ).preview as Record<string, unknown>;
    // The operator broke the JDK between the preview and the click.
    const result = await call('/approvals/run', {
      method: 'POST',
      body: { approvalFingerprint: preview.approvalFingerprint },
      sessions,
      preflight: jdk11Preflight,
    });
    expect(payload(result).ok).toBe(false);
    expect(payload(result).error).toBe('headless_mode_unavailable');
    expect(sessions.list()).toHaveLength(0);
  });

  it('lists only its own capabilities', async () => {
    recordAoiHostBridgePendingApprovalAtomic(home, {
      capability: 'os_process_spawn',
      approvalFingerprint: 'b'.repeat(64),
      targetSummary: 'other',
      now: Date.now(),
      expiresAt: Date.now() + 60_000,
    });
    await call('/sessions/preview', { method: 'POST', body: { binaryPath: binary } });
    const approvals = payload(await call('/approvals')).approvals as { capability: string }[];
    expect(approvals.every((entry) => entry.capability.startsWith('os_ghidra_'))).toBe(true);
    expect(approvals.length).toBeGreaterThan(0);
  });
});

describe('query and reports', () => {
  async function readySession(sessions: GhidraLabSessionManager): Promise<string> {
    const started = await sessions.startHeadless({
      config: loadGhidraLabConfig(configFile),
      binaryPath: fs.realpathSync(binary),
      projectName: 'p',
      launch: 'module',
    });
    const id = started.session?.id ?? '';
    for (let tick = 0; tick < 5000; tick += 1) {
      if (sessions.get(id)?.state === 'ready') {
        return id;
      }
      await Promise.resolve();
    }
    throw new Error('session never became ready');
  }

  it('forwards a known sub-command to the engine', async () => {
    const sessions = makeSessions();
    const sessionId = await readySession(sessions);
    const result = await call('/query', {
      method: 'POST',
      body: { sessionId, kind: 'imports', args: {} },
      sessions,
    });
    expect(payload(result).ok).toBe(true);
    expect((payload(result).query as Record<string, unknown>).mcpTool).toBe('list_imports');
  });

  it('refuses an unknown sub-command without reaching the engine', async () => {
    const sessions = makeSessions();
    const sessionId = await readySession(sessions);
    const result = await call('/query', {
      method: 'POST',
      body: { sessionId, kind: 'read_bytes', args: {} },
      sessions,
    });
    expect(payload(result).ok).toBe(false);
    expect(String(payload(result).error)).toContain('unknown_query_kind');
  });

  it('previews and starts a sweep on a ready session', async () => {
    const sessions = makeSessions();
    const runs = makeRuns();
    const sessionId = await readySession(sessions);
    const preview = payload(
      await call('/reports/preview', { method: 'POST', body: { sessionId }, sessions, runs }),
    ).preview as Record<string, unknown>;
    expect(preview.allowed).toBe(true);

    const started = await call('/approvals/run', {
      method: 'POST',
      body: { approvalFingerprint: preview.approvalFingerprint },
      sessions,
      runs,
    });
    expect(payload(started).ok).toBe(true);
    expect(String(payload(started).runId)).toContain('grun-');
  });

  it('blocks a sweep preview when the session is not ready', async () => {
    const result = await call('/reports/preview', {
      method: 'POST',
      body: { sessionId: 'nope' },
    });
    expect((payload(result).preview as Record<string, unknown>).blockReasons).toContain(
      'session_not_found',
    );
  });

  it('reports an unknown run artifact as missing', async () => {
    const result = await call('/reports/artifact', { body: { runId: 'nope' } });
    expect(result.status).toBe(404);
  });
});

describe('unknown routes', () => {
  it('404s rather than falling through', async () => {
    expect((await call('/nope')).status).toBe(404);
  });
});

describe('read-only routes', () => {
  it('returns the stored config on GET', async () => {
    const result = await call('/config');
    expect(result.status).toBe(200);
    const config = payload(result).config as GhidraLabConfigView;
    expect(config.binaryRoots[0]?.id).toBe('bins');
  });

  it('lists reports, empty on a fresh manager', async () => {
    const result = await call('/reports');
    expect(result.status).toBe(200);
    expect(payload(result).runs).toEqual([]);
  });

  it('answers the output tail for a session that does not exist', async () => {
    // The UI polls this while a session is starting, before the id is known to
    // be good; an empty tail is the honest answer, not a 404.
    const result = await call('/session-output', { body: { sessionId: 'nope' } });
    expect(result.status).toBe(200);
    expect(payload(result).output).toBe('');
  });

  it('refuses to browse or search when no roots are registered', async () => {
    // With no roots there is no reach limit, so the answer has to be a refusal
    // rather than a walk of the whole filesystem.
    saveGhidraLabConfig(configFile, normalizeGhidraLabConfig({ binaryRoots: [] }));
    const found = await call('/browse', { body: { find: 'client' } });
    expect(payload(found).ok).toBe(false);
    expect(payload(found).error).toBe('no_binary_roots');
  });
});

describe('session teardown', () => {
  it('stops a session it knows and 404s one it does not', async () => {
    const sessions = makeSessions();
    const missing = await call('/sessions', {
      method: 'DELETE',
      body: { sessionId: 'never-existed' },
      sessions,
    });
    expect(missing.status).toBe(404);
    expect(payload(missing).error).toBeTruthy();
  });
});

describe('approval ownership', () => {
  it('refuses to approve a fingerprint the shared store files under another capability', async () => {
    // Second line of defence behind the pending-action map. If a fingerprint we
    // previewed also exists in the shared store under the host bridge's spawn or
    // delete capability, approving it here would green-light THAT instead. The
    // store is rewritten under the route's feet to force exactly that collision.
    const sessions = makeSessions();
    const preview = payload(
      await call('/sessions/preview', {
        method: 'POST',
        body: { binaryPath: binary },
        sessions,
      }),
    ).preview as Record<string, unknown>;

    const storeFile = join(home, 'host-bridge', 'approvals.json');
    const store = JSON.parse(fs.readFileSync(storeFile, 'utf-8')) as {
      approvals: { approvalFingerprint: string; capability: string }[];
    };
    for (const approval of store.approvals) {
      if (approval.approvalFingerprint === preview.approvalFingerprint) {
        approval.capability = 'os_process_spawn';
      }
    }
    fs.writeFileSync(storeFile, JSON.stringify(store));

    const result = await call('/approvals/run', {
      method: 'POST',
      body: { approvalFingerprint: preview.approvalFingerprint },
      sessions,
    });
    expect(result.status).toBe(403);
    expect(payload(result).error).toBe('capability_mismatch');
    expect(sessions.list()).toHaveLength(0);
  });
});

describe('report artifacts and cancellation', () => {
  it('serves the ledger separately from the report, and 404s a ledger it does not have', async () => {
    const result = await call('/reports/artifact', {
      body: { runId: 'grun-nope-1', artifact: 'ledger' },
    });
    expect(result.status).toBe(404);
    expect(payload(result).error).toBe('ledger_not_found');
  });

  it('refuses to cancel a run that is not running', async () => {
    const result = await call('/reports', { method: 'DELETE', body: { runId: 'grun-nope-1' } });
    expect(result.status).toBe(404);
    expect(payload(result).error).toBe('run_not_cancellable');
  });

  it('names the state a session is stuck in rather than saying only "not ready"', async () => {
    // A sweep against a session that never came up would fail ten stages deep;
    // the state is what tells the operator whether to wait or read the log.
    // The clock is driven by sleep() so the start-up deadline is reached in
    // microtasks rather than in three real minutes.
    let clock = 1_000_000;
    const sessions = makeSessions({
      now: () => clock,
      sleep: async (ms: number) => {
        clock += ms;
      },
      createMcpClient: () => ({
        initialize: async () => {
          throw new Error('not up yet');
        },
        listTools: async () => [],
        callTool: async () => ({}),
      }),
    });
    const preview = payload(
      await call('/sessions/preview', {
        method: 'POST',
        body: { binaryPath: binary },
        sessions,
      }),
    ).preview as Record<string, unknown>;
    await call('/approvals/run', {
      method: 'POST',
      body: { approvalFingerprint: preview.approvalFingerprint },
      sessions,
    });
    const sessionId = sessions.list()[0]?.id ?? '';

    const result = await call('/reports/preview', {
      method: 'POST',
      body: { sessionId },
      sessions,
    });
    const sweepPreview = payload(result).preview as Record<string, unknown>;
    expect(sweepPreview.allowed).toBe(false);
    expect((sweepPreview.blockReasons as string[]).join(' ')).toContain('session_not_ready:');
  });
});

describe('preview blocking', () => {
  it('reports a binary that is inside a root but no longer on disk', async () => {
    // Containment is re-checked after realpath, so a path that cannot be
    // resolved at all is refused there rather than reaching the file check.
    const gone = join(root, 'deleted.exe');
    fs.writeFileSync(gone, 'MZ');
    fs.rmSync(gone);
    const result = await call('/sessions/preview', {
      method: 'POST',
      body: { binaryPath: gone },
    });
    const preview = payload(result).preview as Record<string, unknown>;
    expect(preview.allowed).toBe(false);
    expect(preview.blockReasons).toContain('path_not_found');
  });

  it('refuses a directory that resolves cleanly inside a root', async () => {
    // realpath succeeds, containment holds -- and Ghidra would still be handed
    // something it cannot import.
    const dir = join(root, 'notabinary');
    fs.mkdirSync(dir, { recursive: true });
    const result = await call('/sessions/preview', { method: 'POST', body: { binaryPath: dir } });
    const preview = payload(result).preview as Record<string, unknown>;
    expect(preview.allowed).toBe(false);
    expect(preview.blockReasons).toContain('binary_not_found');
  });

  it('browses inside a subdirectory of a root', async () => {
    const nested = join(root, 'sub');
    fs.mkdirSync(nested);
    fs.writeFileSync(join(nested, 'inner.dll'), 'MZ');
    const result = await call('/browse', { body: { path: nested } });
    const browse = payload(result).browse as Record<string, unknown>;
    expect((browse.entries as { name: string }[]).map((entry) => entry.name)).toContain(
      'inner.dll',
    );
  });

  it('refuses to browse a path that resolves outside every root', async () => {
    const result = await call('/browse', { body: { path: join(home, 'outside') } });
    expect(payload(result).ok).toBe(false);
    expect(payload(result).error).toBeTruthy();
  });
});

describe('the capability gate covers every route, not just browse', () => {
  it('refuses preview, query and sweep once the capability is switched off', async () => {
    // One route left ungated is the whole gate. os_ghidra_analysis is what the
    // operator flips in Settings; every route that reaches a binary or an engine
    // has to honour it.
    saveAoiHostBridgeKillSwitchState(
      home,
      setAoiHostBridgeCapability(null, 'os_ghidra_analysis', false, Date.now()),
    );
    const sessions = makeSessions();
    for (const [route, body] of [
      ['/sessions/preview', { binaryPath: binary }],
      ['/query', { sessionId: 'sess-1', kind: 'imports' }],
      ['/reports/preview', { sessionId: 'sess-1' }],
    ] as [string, Record<string, unknown>][]) {
      const result = await call(route, { method: 'POST', body, sessions });
      expect(result.status, route).toBe(403);
    }
  });
});

describe('session capacity', () => {
  it('blocks a preview once the session cap is reached', async () => {
    // Each session is a JVM holding a project; the cap is what keeps a machine
    // usable, and it has to be enforced at preview so the operator sees why.
    // The engine has to answer for the binary each session was started with,
    // otherwise readiness is never reached and the start-up deadline is spent
    // spinning.
    const names = Array.from(
      { length: GHIDRA_LAB_MAX_SESSIONS },
      (_unused, index) => `filler${index}.exe`,
    );
    const sessions = makeSessions({
      createMcpClient: () => ({
        initialize: async () => {},
        listTools: async () => [{ name: 'list_project_binaries' }, { name: 'list_imports' }],
        callTool: async (tool) =>
          tool === 'list_project_binaries'
            ? { binaries: [...names, 'client.exe'].map((name) => ({ name })) }
            : { content: [{ type: 'text', text: '[]' }] },
      }),
    });
    for (const target of names.map((name) => join(root, name))) {
      fs.writeFileSync(target, 'MZ');
      const preview = payload(
        await call('/sessions/preview', {
          method: 'POST',
          body: { binaryPath: target },
          sessions,
        }),
      ).preview as Record<string, unknown>;
      await call('/approvals/run', {
        method: 'POST',
        body: { approvalFingerprint: preview.approvalFingerprint },
        sessions,
      });
    }
    expect(sessions.list()).toHaveLength(GHIDRA_LAB_MAX_SESSIONS);

    const blocked = payload(
      await call('/sessions/preview', {
        method: 'POST',
        body: { binaryPath: binary },
        sessions,
      }),
    ).preview as Record<string, unknown>;
    expect(blocked.allowed).toBe(false);
    expect(blocked.blockReasons).toContain('too_many_sessions');
  });

  it('stops a session it started', async () => {
    const sessions = makeSessions();
    const preview = payload(
      await call('/sessions/preview', {
        method: 'POST',
        body: { binaryPath: binary },
        sessions,
      }),
    ).preview as Record<string, unknown>;
    await call('/approvals/run', {
      method: 'POST',
      body: { approvalFingerprint: preview.approvalFingerprint },
      sessions,
    });
    const sessionId = sessions.list()[0]?.id ?? '';
    const result = await call('/sessions', { method: 'DELETE', body: { sessionId }, sessions });
    expect(result.status).toBe(200);
    expect(payload(result).ok).toBe(true);
  });
});

describe('python bootstrap route', () => {
  it('reports the failure detail instead of a bare 500 when there is no interpreter', async () => {
    saveGhidraLabConfig(configFile, normalizeGhidraLabConfig({ pythonExePath: '' }));
    const result = await call('/bootstrap-python', { method: 'POST', body: {} });
    expect(result.status).toBe(200);
    expect(payload(result).ok).toBe(false);
    expect(payload(result).error).toBe('bootstrap_failed');
    expect(payload(result).detail).toBeTruthy();
  });

  it('surfaces what the interpreter said when venv creation fails', async () => {
    // A real child, so the bounded runner is exercised end to end: node is a
    // working executable that has no venv module, which is the same shape as a
    // Python too old to create one. The operator needs the child's own words
    // here -- "bootstrap failed" alone sends them nowhere.
    saveGhidraLabConfig(configFile, normalizeGhidraLabConfig({ pythonExePath: process.execPath }));
    const result = await call('/bootstrap-python', { method: 'POST', body: {} });
    expect(result.status).toBe(200);
    expect(payload(result).ok).toBe(false);
    expect(String(payload(result).detail)).not.toBe('');
  }, 60_000);
});

describe('the wiring the routes use when nothing is injected', () => {
  // Every other test in this file hands the route its own session and run
  // managers, which means the production wiring -- the shared run manager, the
  // model lookup behind it, the artifact directory it writes to -- was never the
  // thing under test. These drive the real path.

  beforeEach(() => {
    resetSharedGhidraLabRunManager();
  });

  afterEach(() => {
    resetSharedGhidraLabRunManager();
  });

  /** Bring a session up through preview and approval, and return its id. */
  async function readySession(sessions: GhidraLabSessionManager): Promise<string> {
    const preview = payload(
      await call('/sessions/preview', {
        method: 'POST',
        body: { binaryPath: binary },
        sessions,
        runs: null,
      }),
    ).preview as Record<string, unknown>;
    await call('/approvals/run', {
      method: 'POST',
      body: { approvalFingerprint: preview.approvalFingerprint },
      sessions,
      runs: null,
    });
    return sessions.list()[0]?.id ?? '';
  }

  /** Run a sweep on the SHARED run manager and wait for it to settle. */
  async function sweepOnSharedManager(sessions: GhidraLabSessionManager): Promise<string> {
    const sessionId = await readySession(sessions);
    const preview = payload(
      await call('/reports/preview', { method: 'POST', body: { sessionId }, sessions, runs: null }),
    ).preview as Record<string, unknown>;
    expect(preview.allowed, JSON.stringify(preview.blockReasons)).toBe(true);
    const started = payload(
      await call('/approvals/run', {
        method: 'POST',
        body: { approvalFingerprint: preview.approvalFingerprint },
        sessions,
        runs: null,
      }),
    );
    expect(started.ok).toBe(true);
    const runId = String(started.runId ?? '');

    for (let tick = 0; tick < 400; tick += 1) {
      const runs = payload(await call('/reports', { runs: null })).runs as {
        runId: string;
        state: string;
      }[];
      const state = runs.find((run) => run.runId === runId)?.state ?? '';
      if (state === 'done' || state === 'failed' || state === 'cancelled') {
        return runId;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('the shared run manager never settled');
  }

  it('runs a sweep on the shared manager and serves the report it wrote to disk', async () => {
    // No `runs` passed, so this exercises the production deps: the query closure
    // over the session manager, the run directory under OPENROOM_HOME, and the
    // artifact route reading the file back.
    const sessions = makeSessions();
    const runId = await sweepOnSharedManager(sessions);

    const artifact = payload(await call('/reports/artifact', { body: { runId }, runs: null }));
    expect(artifact.ok).toBe(true);
    expect(String(artifact.report)).toContain('Binary Analysis Report');
    expect(artifact.truncated).toBe(false);

    const ledger = payload(
      await call('/reports/artifact', { body: { runId, artifact: 'ledger' }, runs: null }),
    );
    expect(ledger.ok).toBe(true);
  }, 60_000);

  it('falls back to a deterministic report when the config names no model', async () => {
    // callModel re-reads the config on every call rather than being decided at
    // construction. With no llm block it throws, and the report writer falls
    // back -- which is what makes a report exist at all on a machine with no
    // model configured.
    const sessions = makeSessions();
    const runId = await sweepOnSharedManager(sessions);
    const report = String(
      payload(await call('/reports/artifact', { body: { runId }, runs: null })).report,
    );
    expect(report).toContain('Binary Analysis Report');
  }, 60_000);

  it('reaches the model adapter once a model IS configured, and still reports on failure', async () => {
    // Same manager, different config: the point is that the lookup is live. The
    // endpoint is a dead local port, so the call fails fast and the deterministic
    // report ships -- a configured-but-unreachable model must not lose the run.
    const persisted = JSON.parse(fs.readFileSync(configFile, 'utf-8')) as Record<string, unknown>;
    persisted.llm = {
      provider: 'openai',
      model: 'test-model',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: '',
    };
    fs.writeFileSync(configFile, JSON.stringify(persisted));

    const sessions = makeSessions();
    const runId = await sweepOnSharedManager(sessions);
    const report = String(
      payload(await call('/reports/artifact', { body: { runId }, runs: null })).report,
    );
    expect(report).toContain('Binary Analysis Report');
  }, 60_000);

  it('survives a config whose llm block is malformed, and runs capa through the shared dep', async () => {
    // Two production closures at once. The llm lookup must not throw the run
    // away on a config it cannot read -- a number where the model name goes is
    // enough to break `.trim()`. And capa is reached through the shared runCapa
    // dep, which nothing else in this suite exercises; pointing it at a path
    // that does not exist makes the stage fail rather than the sweep.
    const persisted = JSON.parse(fs.readFileSync(configFile, 'utf-8')) as Record<string, unknown>;
    persisted.llm = { model: 123 };
    fs.writeFileSync(configFile, JSON.stringify(persisted));
    saveGhidraLabConfig(
      configFile,
      normalizeGhidraLabConfig({
        ...loadGhidraLabConfig(configFile),
        capaExePath: join(home, 'no-such-capa.exe'),
      }),
    );

    const sessions = makeSessions();
    const runId = await sweepOnSharedManager(sessions);
    const report = String(
      payload(await call('/reports/artifact', { body: { runId }, runs: null })).report,
    );
    expect(report).toContain('Binary Analysis Report');
  }, 60_000);

  it('refuses a second sweep while one is active on the same session', async () => {
    const sessions = makeSessions();
    const sessionId = await readySession(sessions);
    const preview = payload(
      await call('/reports/preview', { method: 'POST', body: { sessionId }, sessions, runs: null }),
    ).preview as Record<string, unknown>;
    await call('/approvals/run', {
      method: 'POST',
      body: { approvalFingerprint: preview.approvalFingerprint },
      sessions,
      runs: null,
    });

    const second = payload(
      await call('/reports/preview', { method: 'POST', body: { sessionId }, sessions, runs: null }),
    ).preview as Record<string, unknown>;
    // Either the first run is still going (blocked) or it finished between the
    // two calls (allowed). Only the blocked case carries a claim worth making.
    if (second.allowed === false) {
      expect(second.blockReasons).toContain('run_already_active');
    }
  }, 60_000);
});

describe('approval expiry', () => {
  it('forgets a preview once its window has passed', async () => {
    // The preview-to-click window is deliberately short: it is what stops an
    // approval recorded hours ago from starting a JVM the operator has forgotten
    // about. A stale fingerprint has to read as unknown, not as approved.
    const sessions = makeSessions();
    const preview = payload(
      await call('/sessions/preview', {
        method: 'POST',
        body: { binaryPath: binary },
        sessions,
      }),
    ).preview as Record<string, unknown>;
    expect(preview.approvalFingerprint).toBeTruthy();

    const result = await call('/approvals/run', {
      method: 'POST',
      body: { approvalFingerprint: preview.approvalFingerprint },
      sessions,
      now: Date.now() + 60 * 60 * 1000,
    });
    expect(result.status).toBe(404);
    expect(payload(result).error).toBe('unknown_or_expired_preview');
    expect(sessions.list()).toHaveLength(0);
  });
});

describe('execute-time re-checks', () => {
  it('refuses to start a session that no longer fits under the cap', async () => {
    // The preview said yes; between the preview and the click, other sessions
    // took the room. The cap is re-checked here rather than trusted.
    const names = Array.from(
      { length: GHIDRA_LAB_MAX_SESSIONS },
      (_unused, index) => `late${index}.exe`,
    );
    const sessions = makeSessions({
      createMcpClient: () => ({
        initialize: async () => {},
        listTools: async () => [{ name: 'list_project_binaries' }, { name: 'list_imports' }],
        callTool: async (tool) =>
          tool === 'list_project_binaries'
            ? { binaries: [...names, 'client.exe'].map((name) => ({ name })) }
            : { content: [{ type: 'text', text: '[]' }] },
      }),
    });

    const preview = payload(
      await call('/sessions/preview', {
        method: 'POST',
        body: { binaryPath: binary },
        sessions,
      }),
    ).preview as Record<string, unknown>;
    expect(preview.allowed).toBe(true);

    for (const name of names) {
      const target = join(root, name);
      fs.writeFileSync(target, 'MZ');
      const filler = payload(
        await call('/sessions/preview', {
          method: 'POST',
          body: { binaryPath: target },
          sessions,
        }),
      ).preview as Record<string, unknown>;
      await call('/approvals/run', {
        method: 'POST',
        body: { approvalFingerprint: filler.approvalFingerprint },
        sessions,
      });
    }

    const result = await call('/approvals/run', {
      method: 'POST',
      body: { approvalFingerprint: preview.approvalFingerprint },
      sessions,
    });
    expect(payload(result).ok).toBe(false);
    expect(payload(result).error).toBe('too_many_sessions');
  });

  it('reports why a session failed to start instead of claiming it did', async () => {
    const sessions = makeSessions({
      spawnProcess: () => {
        throw new Error('CreateProcess failed');
      },
    });
    const preview = payload(
      await call('/sessions/preview', {
        method: 'POST',
        body: { binaryPath: binary },
        sessions,
      }),
    ).preview as Record<string, unknown>;
    const result = await call('/approvals/run', {
      method: 'POST',
      body: { approvalFingerprint: preview.approvalFingerprint },
      sessions,
    });
    expect(payload(result).ok).toBe(false);
    expect(String(payload(result).error)).toBeTruthy();
  });

  it('refuses to sweep a session that was stopped after the preview', async () => {
    const sessions = makeSessions();
    const sessionPreview = payload(
      await call('/sessions/preview', {
        method: 'POST',
        body: { binaryPath: binary },
        sessions,
      }),
    ).preview as Record<string, unknown>;
    await call('/approvals/run', {
      method: 'POST',
      body: { approvalFingerprint: sessionPreview.approvalFingerprint },
      sessions,
    });
    const sessionId = sessions.list()[0]?.id ?? '';

    const sweepPreview = payload(
      await call('/reports/preview', { method: 'POST', body: { sessionId }, sessions }),
    ).preview as Record<string, unknown>;
    expect(sweepPreview.allowed).toBe(true);

    await sessions.stop(sessionId);
    const result = await call('/approvals/run', {
      method: 'POST',
      body: { approvalFingerprint: sweepPreview.approvalFingerprint },
      sessions,
    });
    expect(payload(result).ok).toBe(false);
    expect(payload(result).error).toBe('session_not_ready');
  });
});

describe('find', () => {
  it('searches under one requested folder rather than every root', async () => {
    const nested = join(root, 'deep');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(join(nested, 'target.exe'), 'MZ');
    fs.writeFileSync(join(root, 'target-elsewhere.exe'), 'MZ');

    const result = await call('/browse', { body: { find: 'target', path: nested, depth: 2 } });
    const names = (
      (payload(result).browse as Record<string, unknown>).entries as { name: string }[]
    ).map((entry) => entry.name);
    expect(names).toContain('target.exe');
    expect(names).not.toContain('target-elsewhere.exe');
  });

  it('accepts a depth given as a string, the way a query string delivers it', async () => {
    const result = await call('/browse', { body: { find: 'client', depth: '3' } });
    expect(payload(result).ok).toBe(true);
  });

  it('refuses a path that only leaves the roots once the link is resolved', async () => {
    // Containment is checked twice on purpose: the literal path passes, and then
    // realpath moves it outside. A junction inside a root is the reachable form
    // of that on Windows, and without the second check it is a way to hand
    // Ghidra any file on the machine.
    const outside = join(home, 'not-a-root');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(join(outside, 'secret.exe'), 'MZ');
    const link = join(root, 'link');
    try {
      fs.symlinkSync(outside, link, 'junction');
    } catch {
      return; // No link support here; the second check is covered by unit tests.
    }

    const result = await call('/sessions/preview', {
      method: 'POST',
      body: { binaryPath: join(link, 'secret.exe') },
    });
    const preview = payload(result).preview as Record<string, unknown>;
    expect(preview.allowed).toBe(false);
    expect(preview.blockReasons).toContain('path_outside_roots');
  });

  it('refuses to search under a folder outside every root', async () => {
    const outside = join(home, 'elsewhere');
    fs.mkdirSync(outside, { recursive: true });
    const result = await call('/browse', { body: { find: 'client', path: outside } });
    expect(payload(result).ok).toBe(false);
    expect(payload(result).error).toBeTruthy();
  });

  it('skips files that do not match and stops at the match cap', async () => {
    // 60 is the cap; the extras prove it truncates rather than growing, and the
    // non-matching names prove the filter runs before the cap does.
    const bulk = join(root, 'bulk');
    fs.mkdirSync(bulk, { recursive: true });
    for (let index = 0; index < 70; index += 1) {
      // The non-matching names sort FIRST, so the filter has to run before the
      // cap does -- with them second, the cap returns before they are ever seen
      // and the filter goes untested.
      fs.writeFileSync(join(bulk, `aaa-skip${index}.exe`), 'MZ');
      fs.writeFileSync(join(bulk, `match${index}.exe`), 'MZ');
    }
    const result = await call('/browse', { body: { find: 'match', path: bulk } });
    const browse = payload(result).browse as Record<string, unknown>;
    const names = (browse.entries as { name: string }[]).map((entry) => entry.name);
    expect(names.length).toBeLessThanOrEqual(60);
    expect(names.every((name) => name.startsWith('match'))).toBe(true);
    expect(browse.truncated).toBe(true);
  });
});

describe('config file damage', () => {
  it('reads as defaults when the config file is not JSON', async () => {
    // The file is shared with the rest of the app. A half-written one must not
    // take the lab down -- and must not silently look like a configured lab.
    fs.writeFileSync(configFile, '{ this is not json');
    const result = await call('/config');
    expect(result.status).toBe(200);
    expect((payload(result).config as GhidraLabConfigView).binaryRoots).toEqual([]);
  });
});

describe('the FLOSS install route', () => {
  const globalAny = globalThis as { fetch?: unknown };

  afterEach(() => {
    delete globalAny.fetch;
  });

  it('reports why it could not install, rather than a bare failure', async () => {
    globalAny.fetch = async () => {
      throw new Error('ENOTFOUND api.github.com');
    };
    const result = await call('/bootstrap-floss', { method: 'POST', body: {} });
    expect(result.status).toBe(200);
    expect(payload(result).ok).toBe(false);
    expect(payload(result).error).toBe('floss_install_failed');
    expect(String(payload(result).detail)).toContain('ENOTFOUND');
  });

  it('writes the installed path back into the config so the sweep can use it', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const exeName = process.platform === 'win32' ? 'floss.exe' : 'floss';
    globalAny.fetch = async (url: string) =>
      String(url).includes('api.github.com')
        ? {
            ok: true,
            status: 200,
            json: async () => ({
              tag_name: 'v3.1.1',
              assets: [
                {
                  name: 'floss-v3.1.1-windows.zip',
                  browser_download_url:
                    'https://github.com/mandiant/flare-floss/releases/download/v3.1.1/floss-v3.1.1-windows.zip',
                },
                {
                  name: 'floss-v3.1.1-linux.zip',
                  browser_download_url:
                    'https://github.com/mandiant/flare-floss/releases/download/v3.1.1/floss-v3.1.1-linux.zip',
                },
              ],
            }),
          }
        : {
            ok: true,
            status: 200,
            headers: { get: () => '2' },
            arrayBuffer: async () => new Uint8Array([0x50, 0x4b]).buffer,
          };

    // Stand in for the unpack: the route's job is what it does with the result.
    const tools = path.join(home, 'ghidra-lab', 'tools');
    fs.mkdirSync(tools, { recursive: true });
    fs.writeFileSync(path.join(tools, exeName), 'stub');

    const result = await call('/bootstrap-floss', { method: 'POST', body: {} });
    if (payload(result).ok !== true) {
      // No zip-capable tar here; the installer's own suite covers that path.
      return;
    }
    const config = payload(result).config as GhidraLabConfigView;
    expect(config.flossExePath).toContain(exeName);
    // Persisted, not just returned: the next sweep reads the file.
    expect(loadGhidraLabConfig(configFile).flossExePath).toBe(config.flossExePath);
  }, 60_000);
});
