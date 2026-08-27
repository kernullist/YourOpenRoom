import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  findIdaSqlPluginInstall,
  getIdaSqlRoute,
  listIdaSqlPluginSearchPaths,
  loadIdaSqlConfig,
  resolveIdaSqlRoute,
} from '../idaSqlPlugin';
import { describeIdaWindow, forgetIdaWindows } from '../idaSqlWindowHint';
import { ensureAoiHostBridgeToken } from '../aoiHostBridgeAuth';
import {
  engageAoiHostBridgePanic,
  saveAoiHostBridgeKillSwitchState,
  setAoiHostBridgeCapability,
} from '../aoiHostBridgeKillSwitch';
import {
  IdaSqlSessionManager,
  type IdaSqlChildHandle,
  type IdaSqlSessionDeps,
} from '../idaSqlSession';
import {
  IDA_SQL_ANALYSIS_CAPABILITY,
  IDA_SQL_AUTO_SESSION_CAPABILITY,
  IDA_SQL_WRITE_CAPABILITY,
} from '../idaSqlTypes';

const tempRoots: string[] = [];

interface Fixture {
  home: string;
  sessionsDir: string;
  configFile: string;
  binDir: string;
  binaryPath: string;
  outsideBinary: string;
  token: string;
}

function makeFixture(): Fixture {
  const home = fs.mkdtempSync(join(os.tmpdir(), 'ida-lab-'));
  tempRoots.push(home);
  const sessionsDir = join(home, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const binDir = join(home, 'binaries');
  fs.mkdirSync(join(binDir, 'nested'), { recursive: true });
  const binaryPath = join(binDir, 'client.exe');
  fs.writeFileSync(binaryPath, 'MZ');
  fs.writeFileSync(join(binDir, 'nested', 'worker.dll'), 'MZ');
  fs.writeFileSync(join(binDir, 'notes.txt'), 'not a binary');
  const outsideDir = join(home, 'outside');
  fs.mkdirSync(outsideDir, { recursive: true });
  const outsideBinary = join(outsideDir, 'secret.exe');
  fs.writeFileSync(outsideBinary, 'MZ');
  // A real file so the health probe finds it; it is never executed because the
  // session manager is injected.
  const idasqlPath = join(home, 'idasql.exe');
  fs.writeFileSync(idasqlPath, 'stub');
  const idaPath = join(home, 'ida.exe');
  fs.writeFileSync(idaPath, 'stub');

  const configFile = join(home, 'config.json');
  fs.writeFileSync(
    configFile,
    JSON.stringify({
      idaSql: {
        idasqlExePath: idasqlPath,
        idaExePath: idaPath,
        binaryRoots: [{ id: 'bins', path: binDir, label: 'Binaries' }],
        httpPortStart: 8300,
        httpPortEnd: 8302,
      },
    }),
  );

  const token = ensureAoiHostBridgeToken(home, { generateToken: () => 'b'.repeat(64) }).token;
  return { home, sessionsDir, configFile, binDir, binaryPath, outsideBinary, token };
}

function enableCapabilities(home: string, keys: string[]): void {
  let state = { version: 1 as const, globalPanic: false, entries: {}, updatedAt: 0 };
  for (const key of keys) {
    state = setAoiHostBridgeCapability(state, key, true, 1000);
  }
  saveAoiHostBridgeKillSwitchState(home, state);
}

interface ManagerHarness {
  manager: IdaSqlSessionManager;
  spawns: { program: string; args: string[] }[];
  queries: { url: string; body?: string }[];
  statusOk: boolean;
}

function makeManager(): ManagerHarness {
  const spawns: { program: string; args: string[] }[] = [];
  const queries: { url: string; body?: string }[] = [];
  const harness: ManagerHarness = {
    spawns,
    queries,
    statusOk: true,
    manager: null as unknown as IdaSqlSessionManager,
  };
  const deps: IdaSqlSessionDeps = {
    spawnProcess(program, args): IdaSqlChildHandle {
      spawns.push({ program, args });
      return {
        pid: 9001,
        onExit() {},
        onOutput() {},
        kill() {},
      };
    },
    async httpRequest(url, init) {
      if (url.endsWith('/query')) {
        const body = init.body ?? '';
        // A session runs ONE internal query when it becomes ready: it asks the
        // engine for its own function list so an unreviewed function can be
        // treated as a write. These assertions are about the operator's SQL
        // reaching the wire, so the probe is not counted.
        if (body.includes('pragma_function_list')) {
          return {
            status: 200,
            text: JSON.stringify({
              success: true,
              results: [{ columns: ['name'], rows: [['decompile'], ['make_code']], row_count: 2 }],
            }),
          };
        }
        queries.push({ url, ...(init.body === undefined ? {} : { body: init.body }) });
        return {
          status: 200,
          text: JSON.stringify({ results: [{ columns: ['n'], rows: [[1]] }] }),
        };
      }
      if (url.endsWith('/status')) {
        if (!harness.statusOk) {
          throw new Error('ECONNREFUSED');
        }
        return { status: 200, text: '{"idasql":"1.0"}' };
      }
      return { status: 200, text: '{}' };
    },
    now: () => Date.now(),
    sleep: async () => {},
    isPortFree: async () => true,
  };
  harness.manager = new IdaSqlSessionManager(deps);
  return harness;
}

async function call(
  fixture: Fixture,
  manager: IdaSqlSessionManager,
  method: string,
  route: string,
  body: Record<string, unknown> = {},
  token: string | null = fixture.token,
): Promise<{ status: number; payload: Record<string, unknown> }> {
  const result = await resolveIdaSqlRoute({
    method,
    route,
    body,
    token,
    openroomHome: fixture.home,
    configFile: fixture.configFile,
    now: Date.now(),
    manager,
  });
  return { status: result.status, payload: result.payload as Record<string, unknown> };
}

async function readySession(
  fixture: Fixture,
  harness: ManagerHarness,
  write: boolean,
): Promise<string> {
  const started = await harness.manager.startHeadless({
    config: loadIdaSqlConfig(fixture.configFile),
    binaryPath: fixture.binaryPath,
    write,
  });
  const sessionId = started.session?.id ?? '';
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (harness.manager.get(sessionId)?.state === 'ready') {
      return sessionId;
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

describe('getIdaSqlRoute', () => {
  it('extracts the sub-route and ignores unrelated paths', () => {
    expect(getIdaSqlRoute('/api/ida-sql/health')).toBe('/health');
    expect(getIdaSqlRoute('/api/ida-sql')).toBe('/');
    expect(getIdaSqlRoute('/api/ida-sql/sessions/')).toBe('/sessions');
    expect(getIdaSqlRoute('/api/aoi-host/status')).toBeNull();
  });
});

describe('ida-sql routes: authentication and the kill switch', () => {
  let fixture: Fixture;
  let harness: ManagerHarness;

  beforeEach(() => {
    fixture = makeFixture();
    harness = makeManager();
  });

  it('rejects an unauthenticated caller before anything else', async () => {
    enableCapabilities(fixture.home, [IDA_SQL_ANALYSIS_CAPABILITY]);
    const result = await call(fixture, harness.manager, 'GET', '/sessions', {}, 'wrong-token');
    expect(result.status).toBe(401);
    expect(result.payload.error).toBe('not_authenticated');
  });

  it('refuses browse while the analysis capability is off', async () => {
    const result = await call(fixture, harness.manager, 'GET', '/browse', {
      path: fixture.binDir,
    });
    expect(result.status).toBe(403);
    expect(result.payload.denyReasons).toContain('capability_disabled');
  });

  it('refuses everything under panic, even with the capability on', async () => {
    enableCapabilities(fixture.home, [IDA_SQL_ANALYSIS_CAPABILITY]);
    saveAoiHostBridgeKillSwitchState(
      fixture.home,
      engageAoiHostBridgePanic(
        setAoiHostBridgeCapability(
          { version: 1, globalPanic: false, entries: {}, updatedAt: 0 },
          IDA_SQL_ANALYSIS_CAPABILITY,
          true,
          1000,
        ),
        2000,
      ),
    );
    const result = await call(fixture, harness.manager, 'GET', '/sessions');
    expect(result.status).toBe(403);
    expect(result.payload.denyReasons).toContain('host_bridge_panic');
  });

  it('serves health without a capability, so the app can explain the refusal', async () => {
    const result = await call(fixture, harness.manager, 'GET', '/health');
    expect(result.status).toBe(200);
    const health = result.payload.health as Record<string, unknown>;
    expect(health.analysisCapabilityEnabled).toBe(false);
    expect(health.idasqlPresent).toBe(true);
  });
});

describe('ida-sql routes: browse containment', () => {
  let fixture: Fixture;
  let harness: ManagerHarness;

  beforeEach(() => {
    fixture = makeFixture();
    harness = makeManager();
    enableCapabilities(fixture.home, [IDA_SQL_ANALYSIS_CAPABILITY]);
  });

  it('lists the roots when no path is given', async () => {
    const result = await call(fixture, harness.manager, 'GET', '/browse');
    const browse = result.payload.browse as Record<string, unknown>;
    expect((browse.entries as unknown[]).length).toBe(1);
  });

  it('lists a folder inside a root and flags analyzable files', async () => {
    const result = await call(fixture, harness.manager, 'GET', '/browse', {
      path: fixture.binDir,
    });
    const browse = result.payload.browse as { entries: { name: string; analyzable: boolean }[] };
    const client = browse.entries.find((entry) => entry.name === 'client.exe');
    const notes = browse.entries.find((entry) => entry.name === 'notes.txt');
    expect(client?.analyzable).toBe(true);
    expect(notes?.analyzable).toBe(false);
  });

  it('refuses a path outside every root', async () => {
    const result = await call(fixture, harness.manager, 'GET', '/browse', {
      path: join(fixture.home, 'outside'),
    });
    expect(result.status).toBe(403);
    expect(result.payload.error).toBe('path_outside_roots');
  });

  it('finds a binary by name substring inside the roots', async () => {
    const result = await call(fixture, harness.manager, 'GET', '/browse', { find: 'worker' });
    const browse = result.payload.browse as { entries: { name: string }[] };
    expect(browse.entries.map((entry) => entry.name)).toEqual(['worker.dll']);
  });

  it('refuses a one-character find rather than walking every root', async () => {
    const result = await call(fixture, harness.manager, 'GET', '/browse', { find: 'a' });
    expect(result.status).toBe(400);
    expect(result.payload.error).toBe('find_too_short');
  });
});

describe('ida-sql routes: session start approval', () => {
  let fixture: Fixture;
  let harness: ManagerHarness;

  beforeEach(() => {
    fixture = makeFixture();
    harness = makeManager();
    enableCapabilities(fixture.home, [IDA_SQL_ANALYSIS_CAPABILITY]);
  });

  it('previews without starting anything', async () => {
    const result = await call(fixture, harness.manager, 'POST', '/sessions/preview', {
      binaryPath: fixture.binaryPath,
    });
    const preview = result.payload.preview as Record<string, unknown>;
    expect(preview.allowed).toBe(true);
    expect(String(preview.approvalFingerprint)).toMatch(/^[a-f0-9]{64}$/);
    expect(harness.spawns).toHaveLength(0);
    expect(harness.manager.list()).toHaveLength(0);
  });

  it('blocks a binary outside the roots', async () => {
    const result = await call(fixture, harness.manager, 'POST', '/sessions/preview', {
      binaryPath: fixture.outsideBinary,
    });
    const preview = result.payload.preview as { allowed: boolean; blockReasons: string[] };
    expect(preview.allowed).toBe(false);
    expect(preview.blockReasons).toContain('path_outside_roots');
  });

  it('blocks a write session while the settings toggle and capability are off', async () => {
    const result = await call(fixture, harness.manager, 'POST', '/sessions/preview', {
      binaryPath: fixture.binaryPath,
      write: true,
    });
    const preview = result.payload.preview as { blockReasons: string[] };
    expect(preview.blockReasons).toContain('write_not_enabled_in_settings');
    expect(preview.blockReasons).toContain('write_capability_disabled');
  });

  it('starts the session only after the approval is run, and the approval is single-use', async () => {
    const previewed = await call(fixture, harness.manager, 'POST', '/sessions/preview', {
      binaryPath: fixture.binaryPath,
    });
    const fingerprint = String(
      (previewed.payload.preview as Record<string, unknown>).approvalFingerprint,
    );

    const ran = await call(fixture, harness.manager, 'POST', '/approvals/run', {
      approvalFingerprint: fingerprint,
    });
    expect(ran.status).toBe(200);
    expect(harness.spawns).toHaveLength(1);
    expect(harness.spawns[0].args).toContain(fixture.binaryPath);

    // Replaying the same fingerprint must not start a second process.
    const replay = await call(fixture, harness.manager, 'POST', '/approvals/run', {
      approvalFingerprint: fingerprint,
    });
    expect(replay.status).toBe(404);
    expect(harness.spawns).toHaveLength(1);
  });

  it('refuses to run a fingerprint that was never previewed', async () => {
    const result = await call(fixture, harness.manager, 'POST', '/approvals/run', {
      approvalFingerprint: 'c'.repeat(64),
    });
    expect(result.status).toBe(404);
    expect(harness.spawns).toHaveLength(0);
  });

  it('does not auto-approve without the auto-session capability, even when asked', async () => {
    const result = await call(fixture, harness.manager, 'POST', '/sessions/preview', {
      binaryPath: fixture.binaryPath,
      auto: true,
    });
    const preview = result.payload.preview as Record<string, unknown>;
    expect(preview.autoApproved).toBe(false);
    expect(harness.spawns).toHaveLength(0);
  });

  it('auto-starts only with the capability AND a live standing grant, consuming its quota', async () => {
    enableCapabilities(fixture.home, [
      IDA_SQL_ANALYSIS_CAPABILITY,
      IDA_SQL_AUTO_SESSION_CAPABILITY,
    ]);
    // No grant yet: still just a preview.
    const withoutGrant = await call(fixture, harness.manager, 'POST', '/sessions/preview', {
      binaryPath: fixture.binaryPath,
      auto: true,
    });
    expect((withoutGrant.payload.preview as Record<string, unknown>).autoApproved).toBe(false);
    expect(harness.spawns).toHaveLength(0);

    const granted = await call(fixture, harness.manager, 'POST', '/grants', {
      rootId: 'bins',
      maxSessions: 1,
    });
    expect(granted.status).toBe(200);

    const auto = await call(fixture, harness.manager, 'POST', '/sessions/preview', {
      binaryPath: fixture.binaryPath,
      auto: true,
    });
    expect(auto.status).toBe(200);
    expect(auto.payload.session).toBeTruthy();
    expect(harness.spawns).toHaveLength(1);

    // Quota was 1: the next auto request falls back to needing a click.
    const exhausted = await call(fixture, harness.manager, 'POST', '/sessions/preview', {
      binaryPath: join(fixture.binDir, 'nested', 'worker.dll'),
      auto: true,
    });
    expect((exhausted.payload.preview as Record<string, unknown>).autoApproved).toBe(false);
    expect(harness.spawns).toHaveLength(1);
  });

  it('refuses a grant for a root that is not registered', async () => {
    const result = await call(fixture, harness.manager, 'POST', '/grants', { rootId: 'nope' });
    expect(result.status).toBe(400);
    expect(result.payload.error).toBe('unknown_root_id');
  });
});

describe('ida-sql routes: query classification', () => {
  let fixture: Fixture;
  let harness: ManagerHarness;

  beforeEach(() => {
    fixture = makeFixture();
    harness = makeManager();
    enableCapabilities(fixture.home, [IDA_SQL_ANALYSIS_CAPABILITY]);
  });

  it('forwards a read straight to the session', async () => {
    const sessionId = await readySession(fixture, harness, false);
    const result = await call(fixture, harness.manager, 'POST', '/query', {
      sessionId,
      sql: 'SELECT name FROM funcs LIMIT 1',
    });
    expect(result.status).toBe(200);
    expect(harness.queries).toHaveLength(1);
    const query = result.payload.query as Record<string, unknown>;
    expect(query.statementClass).toBe('read');
  });

  it('refuses a host escape outright and never puts it on the wire', async () => {
    const sessionId = await readySession(fixture, harness, false);
    const result = await call(fixture, harness.manager, 'POST', '/query', {
      sessionId,
      sql: "ATTACH DATABASE 'x.db' AS x",
    });
    expect(result.status).toBe(403);
    expect(result.payload.error).toBe('forbidden_statement');
    expect(harness.queries).toHaveLength(0);
  });

  it('refuses a write while the write capability is off', async () => {
    const sessionId = await readySession(fixture, harness, false);
    const result = await call(fixture, harness.manager, 'POST', '/query', {
      sessionId,
      sql: "UPDATE funcs SET name = 'x' WHERE start_ea = 1",
    });
    expect(result.status).toBe(403);
    expect(result.payload.error).toBe('write_capability_disabled');
    expect(harness.queries).toHaveLength(0);
  });

  it('refuses a write against a read-only session even with the capability on', async () => {
    enableCapabilities(fixture.home, [IDA_SQL_ANALYSIS_CAPABILITY, IDA_SQL_WRITE_CAPABILITY]);
    const sessionId = await readySession(fixture, harness, false);
    const result = await call(fixture, harness.manager, 'POST', '/query', {
      sessionId,
      sql: "UPDATE funcs SET name = 'x' WHERE start_ea = 1",
    });
    expect(result.status).toBe(409);
    expect(result.payload.error).toBe('session_is_read_only');
    expect(harness.queries).toHaveLength(0);
  });

  it('turns a write on a write session into an approval, then runs it once approved', async () => {
    enableCapabilities(fixture.home, [IDA_SQL_ANALYSIS_CAPABILITY, IDA_SQL_WRITE_CAPABILITY]);
    const sessionId = await readySession(fixture, harness, true);
    const proposed = await call(fixture, harness.manager, 'POST', '/query', {
      sessionId,
      sql: "UPDATE funcs SET name = 'decrypt_blob' WHERE start_ea = 4096",
    });
    expect(proposed.payload.needsApproval).toBe(true);
    expect(harness.queries).toHaveLength(0);
    const preview = proposed.payload.preview as Record<string, unknown>;
    expect(String(preview.targetSummary)).toContain('decrypt_blob');

    const ran = await call(fixture, harness.manager, 'POST', '/approvals/run', {
      approvalFingerprint: String(preview.approvalFingerprint),
    });
    expect(ran.status).toBe(200);
    expect(harness.queries).toHaveLength(1);
    expect(harness.queries[0].body).toContain('decrypt_blob');
  });

  it('rejects an unknown session', async () => {
    const result = await call(fixture, harness.manager, 'POST', '/query', {
      sessionId: 'nope',
      sql: 'SELECT 1',
    });
    expect(result.status).toBe(404);
    expect(result.payload.error).toBe('unknown_session');
  });
});

describe('ida-sql routes: config', () => {
  let fixture: Fixture;
  let harness: ManagerHarness;

  beforeEach(() => {
    fixture = makeFixture();
    harness = makeManager();
  });

  it('round-trips a config patch and keeps unrelated config keys', async () => {
    fs.writeFileSync(
      fixture.configFile,
      JSON.stringify({ idaSql: loadIdaSqlConfig(fixture.configFile), llm: { model: 'keep-me' } }),
    );
    const saved = await call(fixture, harness.manager, 'POST', '/config', { writeEnabled: true });
    expect((saved.payload.config as Record<string, unknown>).writeEnabled).toBe(true);
    const persisted = JSON.parse(fs.readFileSync(fixture.configFile, 'utf-8')) as Record<
      string,
      unknown
    >;
    expect((persisted.llm as Record<string, unknown>).model).toBe('keep-me');
    const reread = await call(fixture, harness.manager, 'GET', '/config');
    expect((reread.payload.config as Record<string, unknown>).writeEnabled).toBe(true);
  });

  it('drops an unknown key from a config patch', async () => {
    await call(fixture, harness.manager, 'POST', '/config', { smuggled: 'x' });
    const persisted = JSON.parse(fs.readFileSync(fixture.configFile, 'utf-8')) as Record<
      string,
      Record<string, unknown>
    >;
    expect(persisted.idaSql.smuggled).toBeUndefined();
  });
});

describe('the GUI window read route', () => {
  it('answers null until the launch measurement has settled', async () => {
    // The launch fires one measurement and does NOT await it: IDA takes ~3s to
    // draw a window, and holding the approval response for that would keep the
    // operator from the command they need. So this answers null first.
    const fixture = await makeFixture();
    const harness = makeManager();
    enableCapabilities(fixture.home, [IDA_SQL_ANALYSIS_CAPABILITY]);
    forgetIdaWindows();
    const answer = await call(fixture, harness.manager, 'GET', '/gui-window', { pid: '4242' });
    expect(answer.status).toBe(200);
    expect(answer.payload.window).toBeNull();
    expect(answer.payload.detail).toBe('');
  });

  it('serves the remembered measurement without taking another', async () => {
    const fixture = await makeFixture();
    const harness = makeManager();
    enableCapabilities(fixture.home, [IDA_SQL_ANALYSIS_CAPABILITY]);
    forgetIdaWindows();
    let spawned = 0;
    await describeIdaWindow(4242, () => {
      spawned += 1;
      return {
        onStdout(listener: (chunk: string) => void): void {
          setTimeout(
            () =>
              listener(
                '{"found":true,"flashed":true,"left":3645,"top":667,"offPrimaryMonitor":true}',
              ),
            0,
          );
        },
        onExit(listener: (code: number | null) => void): void {
          setTimeout(() => listener(0), 5);
        },
        kill(): void {},
      };
    });
    expect(spawned).toBe(1);

    // Polling this route has to cost nothing: no further measurement.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const answer = await call(fixture, harness.manager, 'GET', '/gui-window', { pid: '4242' });
      expect(answer.status).toBe(200);
      expect((answer.payload.window as { found: boolean }).found).toBe(true);
      expect(String(answer.payload.detail)).toContain('3645,667');
      expect(String(answer.payload.detail)).toContain('another monitor');
    }
    expect(spawned).toBe(1);
    forgetIdaWindows();
  });

  it('refuses a pid that is not one, without measuring', async () => {
    const fixture = await makeFixture();
    const harness = makeManager();
    enableCapabilities(fixture.home, [IDA_SQL_ANALYSIS_CAPABILITY]);
    for (const pid of ['0', '-1', 'abc', '']) {
      const answer = await call(fixture, harness.manager, 'GET', '/gui-window', { pid });
      expect(answer.status, pid).toBe(200);
      expect(answer.payload.window, pid).toBeNull();
    }
  });

  it('is gated: a window title carries the binary path', async () => {
    const fixture = await makeFixture();
    const harness = makeManager();
    const unauthenticated = await call(
      fixture,
      harness.manager,
      'GET',
      '/gui-window',
      { pid: '4242' },
      'wrong-token',
    );
    expect(unauthenticated.status).toBe(401);
  });
});

describe('finding the idasql IDA plugin', () => {
  const savedIdaUsr = process.env.IDAUSR;
  const savedAppData = process.env.APPDATA;

  afterEach(() => {
    if (savedIdaUsr === undefined) {
      delete process.env.IDAUSR;
    } else {
      process.env.IDAUSR = savedIdaUsr;
    }
    if (savedAppData === undefined) {
      delete process.env.APPDATA;
    } else {
      process.env.APPDATA = savedAppData;
    }
  });

  it('honors IDAUSR, which relocates the whole user directory', async () => {
    // A machine that sets IDAUSR does not use the default location at all, so
    // ignoring it reported a correctly installed plugin as missing -- and that
    // report HARD-BLOCKS GUI mode.
    const fixture = await makeFixture();
    const relocated = join(fixture.home, 'ida-user');
    fs.mkdirSync(join(relocated, 'plugins', 'idasql'), { recursive: true });
    fs.writeFileSync(join(relocated, 'plugins', 'idasql', 'idasql.dll'), 'MZ');
    process.env.IDAUSR = relocated;
    expect(findIdaSqlPluginInstall('')).toContain('idasql.dll');
    expect(listIdaSqlPluginSearchPaths('')).toContain(join(relocated, 'plugins'));
  });

  it('accepts both layouts IDA does: loose, or in its own folder', async () => {
    const fixture = await makeFixture();
    const loose = join(fixture.home, 'loose');
    fs.mkdirSync(join(loose, 'plugins'), { recursive: true });
    fs.writeFileSync(join(loose, 'plugins', 'idasql.dll'), 'MZ');
    process.env.IDAUSR = loose;
    expect(findIdaSqlPluginInstall('')).toBe(join(loose, 'plugins', 'idasql.dll'));
  });

  it('reports what it searched, so a wrong verdict is checkable', async () => {
    const fixture = await makeFixture();
    process.env.IDAUSR = '';
    const searched = listIdaSqlPluginSearchPaths(join(fixture.home, 'ida'));
    expect(searched.length).toBeGreaterThan(0);
    expect(searched[searched.length - 1]).toBe(join(fixture.home, 'ida', 'plugins'));
  });

  it('finds nothing when nothing is installed, rather than guessing', async () => {
    const fixture = await makeFixture();
    process.env.IDAUSR = join(fixture.home, 'nowhere');
    delete process.env.APPDATA;
    expect(findIdaSqlPluginInstall(join(fixture.home, 'also-nowhere'))).toBe('');
  });
});
