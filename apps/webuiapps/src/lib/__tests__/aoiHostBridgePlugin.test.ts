import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterAll, describe, expect, it } from 'vitest';

import { getAoiHostBridgeRoute, resolveAoiHostBridgeRoute } from '../aoiHostBridgePlugin';
import { ensureAoiHostBridgeToken } from '../aoiHostBridgeAuth';
import {
  loadAoiHostBridgeKillSwitchState,
  saveAoiHostBridgeKillSwitchState,
  setAoiHostBridgeCapability,
} from '../aoiHostBridgeKillSwitch';
import { getDefaultAoiEnvironmentSourceRegistry } from '../aoiAutonomyPolicy';
import { saveAoiEnvironmentSourceRegistry, updateAoiEnvironmentSource } from '../aoiAutonomyStore';
import { addAoiHostReadRoot, saveAoiHostReadRoots } from '../aoiHostFileRead';
import { addAoiHostSpawnAllowlistEntry, saveAoiHostSpawnAllowlist } from '../aoiHostProcessSpawn';

function saveAoiHostSpawnAllowlistEntryHelper(home: string): void {
  saveAoiHostSpawnAllowlist(
    home,
    addAoiHostSpawnAllowlistEntry(
      null,
      { id: 'notepad', label: 'Notepad', path: 'C:\\Windows\\System32\\notepad.exe' },
      1000,
    ).allowlist,
  );
}

const tempRoots: string[] = [];

// A daemon home layout: <home>/sessions is the sessionsDir; host-bridge/ lives
// under <home>. Returns { home, sessionsDir, token }.
function makeDaemonHome(): { home: string; sessionsDir: string; token: string } {
  const home = fs.mkdtempSync(join(os.tmpdir(), 'aoi-hostbridge-'));
  tempRoots.push(home);
  const sessionsDir = join(home, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const token = ensureAoiHostBridgeToken(home, { generateToken: () => 'a'.repeat(64) }).token;
  return { home, sessionsDir, token };
}

const FAKE_LISTING = {
  version: 1 as const,
  sampledAt: 5000,
  records: [{ pid: 1234, imageName: 'chrome.exe' }],
  summary: {
    version: 1 as const,
    sampledAt: 5000,
    totalCount: 1,
    topImages: [{ imageName: 'chrome.exe', count: 1 }],
    distinctImageCount: 1,
  },
};

afterAll(() => {
  for (const dir of tempRoots) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup.
    }
  }
});

describe('getAoiHostBridgeRoute', () => {
  it('extracts the sub-route and ignores unrelated paths', () => {
    expect(getAoiHostBridgeRoute('/api/aoi-host/status')).toBe('/status');
    expect(getAoiHostBridgeRoute('/api/aoi-host')).toBe('/');
    expect(getAoiHostBridgeRoute('/api/aoi-autonomy/status')).toBeNull();
  });
});

describe('resolveAoiHostBridgeRoute auth', () => {
  it('rejects a missing or wrong token with 401 before touching state', async () => {
    const { home, sessionsDir } = makeDaemonHome();
    const missing = await resolveAoiHostBridgeRoute({
      method: 'GET',
      route: '/status',
      body: {},
      token: null,
      openroomHome: home,
      sessionsDir,
      now: 1000,
    });
    expect(missing.status).toBe(401);

    const wrong = await resolveAoiHostBridgeRoute({
      method: 'GET',
      route: '/status',
      body: {},
      token: 'b'.repeat(64),
      openroomHome: home,
      sessionsDir,
      now: 1000,
    });
    expect(wrong.status).toBe(401);
  });
});

describe('resolveAoiHostBridgeRoute /status + /killswitch', () => {
  it('reports kill-switch state and toggles a capability + panic', async () => {
    const { home, sessionsDir, token } = makeDaemonHome();

    const status = await resolveAoiHostBridgeRoute({
      method: 'GET',
      route: '/status',
      body: {},
      token,
      openroomHome: home,
      sessionsDir,
      now: 1000,
    });
    expect(status.status).toBe(200);
    expect(
      (status.payload as { killSwitch: { enabledCapabilities: string[] } }).killSwitch
        .enabledCapabilities,
    ).toEqual([]);

    // Enable a capability.
    const set = await resolveAoiHostBridgeRoute({
      method: 'POST',
      route: '/killswitch',
      body: { action: 'set', capability: 'process_activity', enabled: true },
      token,
      openroomHome: home,
      sessionsDir,
      now: 2000,
    });
    expect(set.status).toBe(200);
    expect(loadAoiHostBridgeKillSwitchState(home).entries.process_activity).toBe(true);

    // Panic engages.
    const panic = await resolveAoiHostBridgeRoute({
      method: 'POST',
      route: '/killswitch',
      body: { action: 'panic' },
      token,
      openroomHome: home,
      sessionsDir,
      now: 3000,
    });
    expect(panic.status).toBe(200);
    expect(loadAoiHostBridgeKillSwitchState(home).globalPanic).toBe(true);

    // Bad action -> 400.
    const bad = await resolveAoiHostBridgeRoute({
      method: 'POST',
      route: '/killswitch',
      body: { action: 'nope' },
      token,
      openroomHome: home,
      sessionsDir,
      now: 4000,
    });
    expect(bad.status).toBe(400);
  });
});

describe('resolveAoiHostBridgeRoute /processes (HP1 gate)', () => {
  function enableProcessConsent(sessionsDir: string, home: string): void {
    // Consent: enable the process-activity environment source for the session.
    const registry = getDefaultAoiEnvironmentSourceRegistry('aoi/default', 1000);
    saveAoiEnvironmentSourceRegistry(sessionsDir, 'aoi/default', registry);
    updateAoiEnvironmentSource(sessionsDir, 'aoi/default', {
      sourceId: 'process-activity',
      patch: { enabled: true, consentReason: 'User enabled process metadata for this test.' },
      now: 1500,
    });
    // Kill-switch capability.
    saveAoiHostBridgeKillSwitchState(
      home,
      setAoiHostBridgeCapability(null, 'process_activity', true, 1500),
    );
  }

  it('blocks with 403 when consent or the kill-switch capability is off', async () => {
    const { home, sessionsDir, token } = makeDaemonHome();
    const result = await resolveAoiHostBridgeRoute({
      method: 'GET',
      route: '/processes',
      body: { sessionPath: 'aoi/default' },
      token,
      openroomHome: home,
      sessionsDir,
      now: 2000,
      listProcessesImpl: async () => FAKE_LISTING,
    });
    expect(result.status).toBe(403);
    expect((result.payload as { denyReasons: string[] }).denyReasons.length).toBeGreaterThan(0);
  });

  it('returns the listing when authenticated, consented, and enabled', async () => {
    const { home, sessionsDir, token } = makeDaemonHome();
    enableProcessConsent(sessionsDir, home);
    let listed = false;
    const result = await resolveAoiHostBridgeRoute({
      method: 'GET',
      route: '/processes',
      body: { sessionPath: 'aoi/default' },
      token,
      openroomHome: home,
      sessionsDir,
      now: 2000,
      listProcessesImpl: async () => {
        listed = true;
        return FAKE_LISTING;
      },
    });
    expect(result.status).toBe(200);
    expect(listed).toBe(true);
    expect(
      (result.payload as { listing: { summary: { totalCount: number } } }).listing.summary
        .totalCount,
    ).toBe(1);
  });

  it('panic blocks the process listing even when consented + enabled', async () => {
    const { home, sessionsDir, token } = makeDaemonHome();
    enableProcessConsent(sessionsDir, home);
    saveAoiHostBridgeKillSwitchState(home, {
      version: 1,
      globalPanic: true,
      entries: { process_activity: true },
      updatedAt: 1600,
    });
    const result = await resolveAoiHostBridgeRoute({
      method: 'GET',
      route: '/processes',
      body: { sessionPath: 'aoi/default' },
      token,
      openroomHome: home,
      sessionsDir,
      now: 2000,
      listProcessesImpl: async () => FAKE_LISTING,
    });
    expect(result.status).toBe(403);
    expect((result.payload as { denyReasons: string[] }).denyReasons).toContain(
      'host_bridge_panic',
    );
  });

  it('requires a sessionPath', async () => {
    const { home, sessionsDir, token } = makeDaemonHome();
    const result = await resolveAoiHostBridgeRoute({
      method: 'GET',
      route: '/processes',
      body: {},
      token,
      openroomHome: home,
      sessionsDir,
      now: 2000,
      listProcessesImpl: async () => FAKE_LISTING,
    });
    expect(result.status).toBe(400);
  });
});

describe('registration CRUD (auth-only)', () => {
  it('adds, lists, and removes a spawn-allowlist entry; rejects a relative path', async () => {
    const { home, sessionsDir, token } = makeDaemonHome();
    const exe = 'C:\\Windows\\System32\\notepad.exe';
    const add = await resolveAoiHostBridgeRoute({
      method: 'POST',
      route: '/spawn-allowlist',
      body: { id: 'notepad', label: 'Notepad', path: exe },
      token,
      openroomHome: home,
      sessionsDir,
      now: 1000,
    });
    expect(add.status).toBe(200);
    expect((add.payload as { entries: Array<{ id: string }> }).entries.map((e) => e.id)).toEqual([
      'notepad',
    ]);

    const bad = await resolveAoiHostBridgeRoute({
      method: 'POST',
      route: '/spawn-allowlist',
      body: { id: 'rel', path: 'notepad.exe' },
      token,
      openroomHome: home,
      sessionsDir,
      now: 1000,
    });
    expect(bad.status).toBe(400);

    const del = await resolveAoiHostBridgeRoute({
      method: 'DELETE',
      route: '/spawn-allowlist',
      body: { id: 'notepad' },
      token,
      openroomHome: home,
      sessionsDir,
      now: 2000,
    });
    expect((del.payload as { entries: unknown[] }).entries).toEqual([]);
  });

  it('manages read-roots and write-roots', async () => {
    const { home, sessionsDir, token } = makeDaemonHome();
    const dir = fs.realpathSync.native(fs.mkdtempSync(join(os.tmpdir(), 'aoi-root-')));
    tempRoots.push(dir);
    for (const route of ['/read-roots', '/write-roots'] as const) {
      const add = await resolveAoiHostBridgeRoute({
        method: 'POST',
        route,
        body: { id: 'work', path: dir },
        token,
        openroomHome: home,
        sessionsDir,
        now: 1000,
      });
      expect(add.status).toBe(200);
      expect((add.payload as { roots: Array<{ id: string }> }).roots.map((r) => r.id)).toEqual([
        'work',
      ]);
    }
  });
});

describe('filesystem read routes (gate os_file_read)', () => {
  function seedReadableFile(home: string): { dir: string } {
    const dir = fs.realpathSync.native(fs.mkdtempSync(join(os.tmpdir(), 'aoi-fsread-')));
    tempRoots.push(dir);
    fs.writeFileSync(join(dir, 'note.txt'), 'hello fs', 'utf-8');
    saveAoiHostReadRoots(home, addAoiHostReadRoot(null, { id: 'r', path: dir }, 1).config);
    return { dir };
  }

  it('blocks with 403 until the os_file_read capability is enabled', async () => {
    const { home, sessionsDir, token } = makeDaemonHome();
    const { dir } = seedReadableFile(home);
    const blocked = await resolveAoiHostBridgeRoute({
      method: 'GET',
      route: '/fs/read',
      body: { path: join(dir, 'note.txt') },
      token,
      openroomHome: home,
      sessionsDir,
      now: 2000,
    });
    expect(blocked.status).toBe(403);
    expect((blocked.payload as { denyReasons: string[] }).denyReasons).toContain(
      'capability_disabled',
    );
  });

  it('lists, stats, and reads a file inside a read root once enabled', async () => {
    const { home, sessionsDir, token } = makeDaemonHome();
    const { dir } = seedReadableFile(home);
    saveAoiHostBridgeKillSwitchState(
      home,
      setAoiHostBridgeCapability(null, 'os_file_read', true, 1500),
    );

    const listing = await resolveAoiHostBridgeRoute({
      method: 'GET',
      route: '/fs/list',
      body: { path: dir },
      token,
      openroomHome: home,
      sessionsDir,
      now: 2000,
    });
    expect(listing.status).toBe(200);
    expect(
      (listing.payload as { entries: Array<{ name: string }> }).entries.some(
        (e) => e.name === 'note.txt',
      ),
    ).toBe(true);

    const read = await resolveAoiHostBridgeRoute({
      method: 'GET',
      route: '/fs/read',
      body: { path: join(dir, 'note.txt') },
      token,
      openroomHome: home,
      sessionsDir,
      now: 2000,
    });
    expect(read.status).toBe(200);
    expect((read.payload as { content: { content: string } }).content.content).toBe('hello fs');
  });

  it('refuses a path outside the read roots with a 400 body', async () => {
    const { home, sessionsDir, token } = makeDaemonHome();
    seedReadableFile(home);
    saveAoiHostBridgeKillSwitchState(
      home,
      setAoiHostBridgeCapability(null, 'os_file_read', true, 1500),
    );
    const outside = await resolveAoiHostBridgeRoute({
      method: 'GET',
      route: '/fs/read',
      body: { path: 'C:\\Windows\\System32\\drivers\\etc\\hosts' },
      token,
      openroomHome: home,
      sessionsDir,
      now: 2000,
    });
    expect(outside.status).toBe(400);
    expect((outside.payload as { reason?: string }).reason).toBe('outside_consent_roots');
  });
});

describe('spawn preview route', () => {
  it('is blocked until os_process_spawn is enabled, then returns an approval preview', async () => {
    const { home, sessionsDir, token } = makeDaemonHome();
    saveAoiHostSpawnAllowlistEntryHelper(home);

    const blocked = await resolveAoiHostBridgeRoute({
      method: 'POST',
      route: '/spawn/preview',
      body: { allowlistId: 'notepad' },
      token,
      openroomHome: home,
      sessionsDir,
      now: 1000,
    });
    expect(blocked.status).toBe(403);

    saveAoiHostBridgeKillSwitchState(
      home,
      setAoiHostBridgeCapability(null, 'os_process_spawn', true, 1500),
    );
    const preview = await resolveAoiHostBridgeRoute({
      method: 'POST',
      route: '/spawn/preview',
      body: { allowlistId: 'notepad' },
      token,
      openroomHome: home,
      sessionsDir,
      now: 2000,
    });
    expect(preview.status).toBe(200);
    const payload = preview.payload as {
      preview: { allowed: boolean; approvalFingerprint: string; program: string };
    };
    expect(payload.preview.allowed).toBe(true);
    expect(payload.preview.approvalFingerprint).toBeTruthy();
    expect(payload.preview.program).toContain('notepad.exe');
  });
});
