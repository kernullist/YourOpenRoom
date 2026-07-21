import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  createAoiHostBridgeMiddleware,
  getAoiHostBridgeRoute,
  resolveAoiHostBridgeRoute,
} from '../aoiHostBridgePlugin';
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
import { addAoiHostWriteRoot, saveAoiHostWriteRoots } from '../aoiHostFileWrite';
import {
  addAoiBrowserDriveAllowlistEntry,
  saveAoiBrowserDriveAllowlist,
} from '../aoiBrowserDriveAllowlist';

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

function saveAoiHostWriteRootsHelper(home: string, dir: string): void {
  saveAoiHostWriteRoots(home, addAoiHostWriteRoot(null, { id: 'work', path: dir }, 1000).config);
}

// A valid-shaped but non-existent exe: spawn passes the policy/approval gate but
// fails to launch (spawn_failed), so the execute flow is exercised WITHOUT
// launching a real GUI app during tests.
function saveAoiHostFakeSpawnEntry(home: string): void {
  saveAoiHostSpawnAllowlist(
    home,
    addAoiHostSpawnAllowlistEntry(
      null,
      { id: 'fake', label: 'Fake', path: 'C:\\aoi-test-nonexistent\\fake-app.exe' },
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

describe('resolveAoiHostBridgeRoute /browser-read (HP5 gate)', () => {
  function enableBrowserConsent(sessionsDir: string, home: string): void {
    const registry = getDefaultAoiEnvironmentSourceRegistry('aoi/default', 1000);
    saveAoiEnvironmentSourceRegistry(sessionsDir, 'aoi/default', registry);
    updateAoiEnvironmentSource(sessionsDir, 'aoi/default', {
      sourceId: 'host-browser-read',
      patch: {
        enabled: true,
        consentReason: 'User enabled host headless browser read for this test.',
      },
      now: 1500,
    });
    saveAoiHostBridgeKillSwitchState(
      home,
      setAoiHostBridgeCapability(null, 'os_browser_read', true, 1500),
    );
  }

  it('blocks browser-read when capability/consent is off', async () => {
    const { home, sessionsDir, token } = makeDaemonHome();
    const result = await resolveAoiHostBridgeRoute({
      method: 'POST',
      route: '/browser-read',
      body: { sessionPath: 'aoi/default', url: 'https://example.com' },
      token,
      openroomHome: home,
      sessionsDir,
      now: 2000,
      browserReadImpl: async () => ({
        ok: true,
        url: 'https://example.com',
        finalUrl: 'https://example.com',
        title: 'x',
        excerpt: 'x',
        siteName: 'example.com',
        blocks: [],
        text: 'x',
        browserPath: 'chrome',
        sampledAt: 1,
        durationMs: 1,
        engine: 'chrome-headless',
      }),
    });
    expect(result.status).toBe(403);
  });

  it('returns a page extract when gated and enabled', async () => {
    const { home, sessionsDir, token } = makeDaemonHome();
    enableBrowserConsent(sessionsDir, home);
    const result = await resolveAoiHostBridgeRoute({
      method: 'POST',
      route: '/browser-read',
      body: { sessionPath: 'aoi/default', url: 'https://example.com/a' },
      token,
      openroomHome: home,
      sessionsDir,
      now: 2000,
      browserReadImpl: async ({ url }) => ({
        ok: true,
        url,
        finalUrl: url,
        title: 'Example Article',
        excerpt: 'Hello',
        siteName: 'example.com',
        blocks: [{ type: 'paragraph', text: 'Hello world content for the page.' }],
        text: 'Hello world content for the page.',
        browserPath: 'C:\\chrome.exe',
        sampledAt: 2000,
        durationMs: 12,
        engine: 'chrome-headless',
      }),
    });
    expect(result.status).toBe(200);
    expect((result.payload as { page: { title: string } }).page.title).toBe('Example Article');
  });
});

describe('resolveAoiHostBridgeRoute /browser-drive-read (BD gate)', () => {
  function enableDriveConsent(sessionsDir: string, home: string): void {
    const registry = getDefaultAoiEnvironmentSourceRegistry('aoi/default', 1000);
    saveAoiEnvironmentSourceRegistry(sessionsDir, 'aoi/default', registry);
    updateAoiEnvironmentSource(sessionsDir, 'aoi/default', {
      sourceId: 'browser-drive',
      patch: { enabled: true, consentReason: 'User enabled browser drive for this test.' },
      now: 1500,
    });
    saveAoiHostBridgeKillSwitchState(
      home,
      setAoiHostBridgeCapability(null, 'os_browser_drive', true, 1500),
    );
  }

  function allowExample(home: string): void {
    saveAoiBrowserDriveAllowlist(
      home,
      addAoiBrowserDriveAllowlistEntry(null, { domain: 'example.com' }, 1000).allowlist,
    );
  }

  it('blocks when capability/consent is off', async () => {
    const { home, sessionsDir, token } = makeDaemonHome();
    allowExample(home);
    const result = await resolveAoiHostBridgeRoute({
      method: 'POST',
      route: '/browser-drive-read',
      body: { sessionPath: 'aoi/default', url: 'https://example.com/account' },
      token,
      openroomHome: home,
      sessionsDir,
      now: 2000,
      browserDriveReadImpl: async () => ({ ok: false, reason: 'navigation_failed' }),
    });
    expect(result.status).toBe(403);
  });

  it('blocks a non-allowlisted URL before launching a browser', async () => {
    const { home, sessionsDir, token } = makeDaemonHome();
    enableDriveConsent(sessionsDir, home);
    let launched = false;
    const result = await resolveAoiHostBridgeRoute({
      method: 'POST',
      route: '/browser-drive-read',
      body: { sessionPath: 'aoi/default', url: 'https://evil.com/x' },
      token,
      openroomHome: home,
      sessionsDir,
      now: 2000,
      browserDriveReadImpl: async () => {
        launched = true;
        return { ok: false, reason: 'navigation_failed' };
      },
    });
    expect(result.status).toBe(403);
    expect((result.payload as { code: string }).code).toBe('url_not_allowlisted');
    expect(launched).toBe(false);
  });

  it('returns an allowlisted authenticated page extract', async () => {
    const { home, sessionsDir, token } = makeDaemonHome();
    enableDriveConsent(sessionsDir, home);
    allowExample(home);
    const result = await resolveAoiHostBridgeRoute({
      method: 'POST',
      route: '/browser-drive-read',
      body: { sessionPath: 'aoi/default', url: 'https://example.com/account' },
      token,
      openroomHome: home,
      sessionsDir,
      now: 2000,
      browserDriveReadImpl: async ({ url }) => ({
        ok: true,
        url,
        finalUrl: url,
        hostname: 'example.com',
        title: 'My Dashboard',
        excerpt: 'Welcome back',
        siteName: 'example.com',
        blocks: [{ type: 'paragraph', text: 'Three new messages in the inbox today.' }],
        text: 'Three new messages in the inbox today.',
        sampledAt: 2000,
      }),
    });
    expect(result.status).toBe(200);
    expect((result.payload as { page: { title: string; hostname: string } }).page).toMatchObject({
      title: 'My Dashboard',
      hostname: 'example.com',
    });
  });

  it('maps a drive failure to 422', async () => {
    const { home, sessionsDir, token } = makeDaemonHome();
    enableDriveConsent(sessionsDir, home);
    allowExample(home);
    const result = await resolveAoiHostBridgeRoute({
      method: 'POST',
      route: '/browser-drive-read',
      body: { sessionPath: 'aoi/default', url: 'https://example.com/x' },
      token,
      openroomHome: home,
      sessionsDir,
      now: 2000,
      browserDriveReadImpl: async () => ({
        ok: false,
        reason: 'drift_off_allowlist',
        hostname: 'tracker.evil.com',
      }),
    });
    expect(result.status).toBe(422);
    expect((result.payload as { code: string }).code).toBe('drift_off_allowlist');
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

describe('spawn preview -> approve -> execute (server-side approval binding)', () => {
  async function call(
    home: string,
    sessionsDir: string,
    token: string,
    method: string,
    route: string,
    body: Record<string, unknown>,
    now: number,
  ) {
    return resolveAoiHostBridgeRoute({
      method,
      route,
      body,
      token,
      openroomHome: home,
      sessionsDir,
      now,
      // A fake spawn so the runner never launches a real process.
      listProcessesImpl: async () => FAKE_LISTING,
    });
  }

  it('execute is blocked until the operator approves, then runs once (single-use)', async () => {
    const { home, sessionsDir, token } = makeDaemonHome();
    // A non-existent exe so execute exercises the approval path without
    // launching a real GUI app (it fails at spawn, not at the gate).
    saveAoiHostFakeSpawnEntry(home);
    saveAoiHostBridgeKillSwitchState(
      home,
      setAoiHostBridgeCapability(null, 'os_process_spawn', true, 1500),
    );

    // 1. Preview records a pending approval.
    const preview = await call(
      home,
      sessionsDir,
      token,
      'POST',
      '/spawn/preview',
      {
        allowlistId: 'fake',
      },
      2000,
    );
    const fingerprint = (preview.payload as { preview: { approvalFingerprint: string } }).preview
      .approvalFingerprint;

    // 2. Execute BEFORE approve -> blocked (self-approve is impossible).
    const early = await call(
      home,
      sessionsDir,
      token,
      'POST',
      '/spawn/execute',
      {
        allowlistId: 'fake',
      },
      2100,
    );
    expect(early.status).toBe(403);
    expect((early.payload as { denyReasons: string[] }).denyReasons).toContain(
      'approval_not_granted',
    );

    // 3. Operator approves the fingerprint.
    const approve = await call(
      home,
      sessionsDir,
      token,
      'POST',
      '/approvals/approve',
      {
        approvalFingerprint: fingerprint,
      },
      2200,
    );
    expect(approve.status).toBe(200);

    // 4. Execute now passes the approval gate and reaches the runner (which
    // returns spawn_failed for the non-existent exe) -- NOT approval-blocked.
    const exec = await call(
      home,
      sessionsDir,
      token,
      'POST',
      '/spawn/execute',
      {
        allowlistId: 'fake',
      },
      2300,
    );
    const execReasons = (exec.payload as { blockReasons?: string[] }).blockReasons ?? [];
    expect(execReasons).not.toContain('approval_missing');
    expect(execReasons).not.toContain('approval_not_granted');
    expect(execReasons).toContain('spawn_failed');

    // 5. A SECOND execute is blocked -- the approval was single-use (consumed).
    const again = await call(
      home,
      sessionsDir,
      token,
      'POST',
      '/spawn/execute',
      {
        allowlistId: 'fake',
      },
      2400,
    );
    expect(again.status).toBe(403);
    expect((again.payload as { denyReasons: string[] }).denyReasons).toContain('approval_missing');
  });

  it('lists pending approvals for the operator UI', async () => {
    const { home, sessionsDir, token } = makeDaemonHome();
    saveAoiHostSpawnAllowlistEntryHelper(home);
    saveAoiHostBridgeKillSwitchState(
      home,
      setAoiHostBridgeCapability(null, 'os_process_spawn', true, 1500),
    );
    await call(
      home,
      sessionsDir,
      token,
      'POST',
      '/spawn/preview',
      { allowlistId: 'notepad' },
      2000,
    );
    const list = await call(home, sessionsDir, token, 'GET', '/approvals', {}, 2100);
    expect(list.status).toBe(200);
    const approvals = (list.payload as { approvals: Array<{ state: string; capability: string }> })
      .approvals;
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ state: 'pending', capability: 'os_process_spawn' });
  });
});

describe('filesystem write preview -> approve -> execute', () => {
  it('writes a file only after the operator approves the exact { path, content }', async () => {
    const { home, sessionsDir, token } = makeDaemonHome();
    const dir = fs.realpathSync.native(fs.mkdtempSync(join(os.tmpdir(), 'aoi-fswrite-')));
    tempRoots.push(dir);
    saveAoiHostWriteRootsHelper(home, dir);
    saveAoiHostBridgeKillSwitchState(
      home,
      setAoiHostBridgeCapability(null, 'os_file_write', true, 1500),
    );
    const target = join(dir, 'out.txt');

    // Preview records the approval for this exact content.
    const preview = await resolveAoiHostBridgeRoute({
      method: 'POST',
      route: '/fs/write/preview',
      body: { path: target, content: 'approved content' },
      token,
      openroomHome: home,
      sessionsDir,
      now: 2000,
    });
    const fingerprint = (preview.payload as { preview: { approvalFingerprint: string } }).preview
      .approvalFingerprint;

    // Execute with DIFFERENT content -> different fingerprint -> no approval.
    const swap = await resolveAoiHostBridgeRoute({
      method: 'POST',
      route: '/fs/write/execute',
      body: { path: target, content: 'DIFFERENT content' },
      token,
      openroomHome: home,
      sessionsDir,
      now: 2100,
    });
    expect(swap.status).toBe(403);
    expect(fs.existsSync(target)).toBe(false);

    // Approve, then execute with the SAME content -> writes.
    await resolveAoiHostBridgeRoute({
      method: 'POST',
      route: '/approvals/approve',
      body: { approvalFingerprint: fingerprint },
      token,
      openroomHome: home,
      sessionsDir,
      now: 2200,
    });
    const exec = await resolveAoiHostBridgeRoute({
      method: 'POST',
      route: '/fs/write/execute',
      body: { path: target, content: 'approved content' },
      token,
      openroomHome: home,
      sessionsDir,
      now: 2300,
    });
    expect(exec.status).toBe(200);
    expect(fs.readFileSync(target, 'utf-8')).toBe('approved content');
  });
});

describe('kill preview -> approve -> execute (injected impls)', () => {
  it('kills only after approval; protected images are refused; TOCTOU is enforced', async () => {
    const { home, sessionsDir, token } = makeDaemonHome();
    saveAoiHostBridgeKillSwitchState(
      home,
      setAoiHostBridgeCapability(null, 'os_process_kill', true, 1500),
    );
    const killBody = {
      pid: 4321,
      expectedImageName: 'notepad.exe',
      expectedStartTime: '2026-07-18T10:00:00',
      killAllowlistImages: ['notepad.exe'],
    };

    // A protected image is refused at preview (never even offered).
    const protectedPreview = await resolveAoiHostBridgeRoute({
      method: 'POST',
      route: '/kill/preview',
      body: { ...killBody, expectedImageName: 'lsass.exe', killAllowlistImages: ['lsass.exe'] },
      token,
      openroomHome: home,
      sessionsDir,
      now: 2000,
    });
    expect(
      (protectedPreview.payload as { preview: { blockReasons: string[] } }).preview.blockReasons,
    ).toContain('protected_process');

    // Normal target: preview records an approval.
    const preview = await resolveAoiHostBridgeRoute({
      method: 'POST',
      route: '/kill/preview',
      body: killBody,
      token,
      openroomHome: home,
      sessionsDir,
      now: 2000,
    });
    const fingerprint = (preview.payload as { preview: { approvalFingerprint: string } }).preview
      .approvalFingerprint;

    // Execute before approve -> blocked, kill never called.
    let killCalls = 0;
    const early = await resolveAoiHostBridgeRoute({
      method: 'POST',
      route: '/kill/execute',
      body: killBody,
      token,
      openroomHome: home,
      sessionsDir,
      now: 2100,
      readProcessImpl: () => ({ imageName: 'notepad.exe', startTime: '2026-07-18T10:00:00' }),
      killImpl: () => {
        killCalls += 1;
        return true;
      },
    });
    expect(early.status).toBe(403);
    expect(killCalls).toBe(0);

    // Approve.
    await resolveAoiHostBridgeRoute({
      method: 'POST',
      route: '/approvals/approve',
      body: { approvalFingerprint: fingerprint },
      token,
      openroomHome: home,
      sessionsDir,
      now: 2200,
    });

    // Execute with a TOCTOU MISMATCH (pid now hosts a different image) -> blocked.
    const toctou = await resolveAoiHostBridgeRoute({
      method: 'POST',
      route: '/kill/execute',
      body: killBody,
      token,
      openroomHome: home,
      sessionsDir,
      now: 2300,
      readProcessImpl: () => ({ imageName: 'chrome.exe' }),
      killImpl: () => {
        killCalls += 1;
        return true;
      },
    });
    expect((toctou.payload as { blockReasons?: string[] }).blockReasons).toContain(
      'toctou_mismatch',
    );
    expect(killCalls).toBe(0);
  });

  it('kills once when approved and the live process still matches', async () => {
    const { home, sessionsDir, token } = makeDaemonHome();
    saveAoiHostBridgeKillSwitchState(
      home,
      setAoiHostBridgeCapability(null, 'os_process_kill', true, 1500),
    );
    const killBody = {
      pid: 4321,
      expectedImageName: 'notepad.exe',
      killAllowlistImages: ['notepad.exe'],
    };
    const preview = await resolveAoiHostBridgeRoute({
      method: 'POST',
      route: '/kill/preview',
      body: killBody,
      token,
      openroomHome: home,
      sessionsDir,
      now: 2000,
    });
    const fingerprint = (preview.payload as { preview: { approvalFingerprint: string } }).preview
      .approvalFingerprint;
    await resolveAoiHostBridgeRoute({
      method: 'POST',
      route: '/approvals/approve',
      body: { approvalFingerprint: fingerprint },
      token,
      openroomHome: home,
      sessionsDir,
      now: 2100,
    });
    let killedPid: number | null = null;
    const exec = await resolveAoiHostBridgeRoute({
      method: 'POST',
      route: '/kill/execute',
      body: killBody,
      token,
      openroomHome: home,
      sessionsDir,
      now: 2200,
      readProcessImpl: () => ({ imageName: 'notepad.exe' }),
      killImpl: (pid) => {
        killedPid = pid;
        return true;
      },
    });
    expect(exec.status).toBe(200);
    expect(killedPid).toBe(4321);
  });
});

describe('delete preview -> approve -> execute (injected recycle)', () => {
  it('recycles a file only after approval; outside-root is refused', async () => {
    const { home, sessionsDir, token } = makeDaemonHome();
    const dir = fs.realpathSync.native(fs.mkdtempSync(join(os.tmpdir(), 'aoi-fsdel-')));
    tempRoots.push(dir);
    fs.writeFileSync(join(dir, 'trash.txt'), 'bye', 'utf-8');
    saveAoiHostWriteRootsHelper(home, dir);
    saveAoiHostBridgeKillSwitchState(
      home,
      setAoiHostBridgeCapability(null, 'os_file_delete', true, 1500),
    );
    const target = join(dir, 'trash.txt');

    const preview = await resolveAoiHostBridgeRoute({
      method: 'POST',
      route: '/fs/delete/preview',
      body: { path: target },
      token,
      openroomHome: home,
      sessionsDir,
      now: 2000,
    });
    const fingerprint = (preview.payload as { preview: { approvalFingerprint: string } }).preview
      .approvalFingerprint;

    // Execute before approve -> blocked, recycle not called.
    let recycled: string | null = null;
    const early = await resolveAoiHostBridgeRoute({
      method: 'POST',
      route: '/fs/delete/execute',
      body: { path: target },
      token,
      openroomHome: home,
      sessionsDir,
      now: 2100,
      recycleImpl: (p) => {
        recycled = p;
        return true;
      },
    });
    expect(early.status).toBe(403);
    expect(recycled).toBeNull();

    await resolveAoiHostBridgeRoute({
      method: 'POST',
      route: '/approvals/approve',
      body: { approvalFingerprint: fingerprint },
      token,
      openroomHome: home,
      sessionsDir,
      now: 2200,
    });
    const exec = await resolveAoiHostBridgeRoute({
      method: 'POST',
      route: '/fs/delete/execute',
      body: { path: target },
      token,
      openroomHome: home,
      sessionsDir,
      now: 2300,
      recycleImpl: (p) => {
        recycled = p;
        return true;
      },
    });
    expect(exec.status).toBe(200);
    expect(recycled).toBe(target);
  });
});

describe('desktop-activity ingest + summary', () => {
  function enableDesktopConsent(sessionsDir: string, home: string): void {
    const registry = getDefaultAoiEnvironmentSourceRegistry('aoi/default', 1000);
    saveAoiEnvironmentSourceRegistry(sessionsDir, 'aoi/default', registry);
    updateAoiEnvironmentSource(sessionsDir, 'aoi/default', {
      sourceId: 'desktop-activity',
      patch: { enabled: true, consentReason: 'User enabled desktop activity for this test.' },
      now: 1500,
    });
    saveAoiHostBridgeKillSwitchState(
      home,
      setAoiHostBridgeCapability(null, 'desktop_activity', true, 1500),
    );
  }

  it('is blocked without consent, then ingests samples and summarizes the taste signal', async () => {
    const { home, sessionsDir, token } = makeDaemonHome();
    const post = (appName: string, now: number) =>
      resolveAoiHostBridgeRoute({
        method: 'POST',
        route: '/desktop-activity',
        body: { sessionPath: 'aoi/default', sample: { appName, focused: true, observedAt: now } },
        token,
        openroomHome: home,
        sessionsDir,
        now,
      });

    const blocked = await post('ghidra.exe', 2000);
    expect(blocked.status).toBe(403);

    enableDesktopConsent(sessionsDir, home);
    expect((await post('ghidra.exe', 2100)).status).toBe(200);
    expect((await post('ghidra.exe', 2200)).status).toBe(200);
    expect((await post('chrome.exe', 2300)).status).toBe(200);

    const summary = await resolveAoiHostBridgeRoute({
      method: 'GET',
      route: '/desktop-activity/summary',
      body: { sessionPath: 'aoi/default' },
      token,
      openroomHome: home,
      sessionsDir,
      now: 2400,
    });
    expect(summary.status).toBe(200);
    const payload = summary.payload as {
      summary: { totalSamples: number; topApps: Array<{ appName: string; focusedCount: number }> };
    };
    expect(payload.summary.totalSamples).toBe(3);
    expect(payload.summary.topApps[0]).toMatchObject({ appName: 'ghidra.exe', focusedCount: 2 });
  });

  it('drops the window title unless the sub-toggle is set', async () => {
    const { home, sessionsDir, token } = makeDaemonHome();
    enableDesktopConsent(sessionsDir, home);
    const res = await resolveAoiHostBridgeRoute({
      method: 'POST',
      route: '/desktop-activity',
      body: {
        sessionPath: 'aoi/default',
        sample: { appName: 'code.exe', windowTitle: 'secret.md', focused: true, observedAt: 2100 },
        captureWindowTitles: false,
      },
      token,
      openroomHome: home,
      sessionsDir,
      now: 2100,
    });
    expect(res.status).toBe(200);
    // The persisted store must not contain the title.
    const stored = fs.readFileSync(join(home, 'host-bridge', 'desktop-activity.json'), 'utf-8');
    expect(stored).not.toContain('secret.md');
  });
});

describe('createAoiHostBridgeMiddleware loopback token trust', () => {
  interface MockRes {
    status: number;
    body: string;
  }

  function runMiddleware(
    middleware: ReturnType<typeof createAoiHostBridgeMiddleware>,
    req: {
      url?: string;
      method?: string;
      headers?: Record<string, string>;
      remoteAddress?: string;
    },
  ): Promise<MockRes> {
    const result: MockRes = { status: 0, body: '' };
    return new Promise((resolvePromise) => {
      const mockReq = {
        url: req.url ?? '/api/aoi-host/status',
        method: req.method ?? 'GET',
        headers: req.headers ?? {},
        socket: { remoteAddress: req.remoteAddress ?? '127.0.0.1' },
        on: () => undefined,
      } as unknown as Parameters<typeof middleware>[0];
      const mockRes = {
        writeHead(status: number) {
          result.status = status;
          return this;
        },
        end(body?: string) {
          result.body = body ?? '';
          resolvePromise(result);
        },
      } as unknown as Parameters<typeof middleware>[1];
      middleware(mockReq, mockRes, () => resolvePromise(result));
    });
  }

  it('authenticates a loopback GET with no token header when trust is on', async () => {
    const { sessionsDir } = makeDaemonHome();
    const middleware = createAoiHostBridgeMiddleware({ sessionsDir, trustLoopbackToken: true });
    const res = await runMiddleware(middleware, { remoteAddress: '127.0.0.1' });
    expect(res.status).toBe(200);
    expect(res.body).toContain('"ok":true');
  });

  it('rejects a non-loopback caller with no token even when trust is on', async () => {
    const { sessionsDir } = makeDaemonHome();
    const middleware = createAoiHostBridgeMiddleware({ sessionsDir, trustLoopbackToken: true });
    const res = await runMiddleware(middleware, { remoteAddress: '10.1.2.3' });
    expect(res.status).toBe(401);
  });

  it('rejects a loopback caller with no token when trust is off (daemon default)', async () => {
    const { sessionsDir } = makeDaemonHome();
    const middleware = createAoiHostBridgeMiddleware({ sessionsDir });
    const res = await runMiddleware(middleware, { remoteAddress: '127.0.0.1' });
    expect(res.status).toBe(401);
  });

  it('still accepts an explicit valid token header from any address', async () => {
    const { sessionsDir, token } = makeDaemonHome();
    const middleware = createAoiHostBridgeMiddleware({ sessionsDir });
    const res = await runMiddleware(middleware, {
      remoteAddress: '10.1.2.3',
      headers: { 'x-aoi-host-bridge-token': token },
    });
    expect(res.status).toBe(200);
  });
});
