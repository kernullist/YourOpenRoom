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
  resolveAoiHostBridgeKillSwitchPath,
  saveAoiHostBridgeKillSwitchState,
  setAoiHostBridgeCapability,
  engageAoiHostBridgePanic,
} from '../aoiHostBridgeKillSwitch';
import { resolveAoiHostStoreLockPath } from '../aoiHostStoreLock';
import { getDefaultAoiEnvironmentSourceRegistry } from '../aoiAutonomyPolicy';
import { saveAoiEnvironmentSourceRegistry, updateAoiEnvironmentSource } from '../aoiAutonomyStore';
import { addAoiHostReadRoot, saveAoiHostReadRoots } from '../aoiHostFileRead';
import { addAoiHostSpawnAllowlistEntry, saveAoiHostSpawnAllowlist } from '../aoiHostProcessSpawn';
import { addAoiHostWriteRoot, saveAoiHostWriteRoots } from '../aoiHostFileWrite';
import {
  addAoiBrowserDriveAllowlistEntry,
  resolveAoiBrowserDriveAllowlistPath,
  saveAoiBrowserDriveAllowlist,
} from '../aoiBrowserDriveAllowlist';
import { recordAoiBrowserDriveAuditEntry } from '../aoiBrowserDriveAuditStore';

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
    // Computer use ships ON, so a fresh machine reports it in force. An empty
    // list here would mean the settings UI showed the feature off while it was
    // working.
    expect(
      (status.payload as { killSwitch: { enabledCapabilities: string[] } }).killSwitch
        .enabledCapabilities,
    ).toEqual(['os_computer_use']);

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

  function blockEvil(home: string): void {
    saveAoiBrowserDriveAllowlist(
      home,
      addAoiBrowserDriveAllowlistEntry(null, { domain: 'evil.com' }, 1000).allowlist,
    );
  }

  it('blocks when capability/consent is off', async () => {
    const { home, sessionsDir, token } = makeDaemonHome();
    // Computer use is on by default now, so blocking is what happens when the
    // operator switches it OFF -- that is the guarantee worth pinning.
    saveAoiHostBridgeKillSwitchState(
      home,
      setAoiHostBridgeCapability(null, 'os_computer_use', false, 900),
    );
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

  it('blocks a denylisted URL before launching a browser', async () => {
    const { home, sessionsDir, token } = makeDaemonHome();
    enableDriveConsent(sessionsDir, home);
    blockEvil(home);
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
    expect((result.payload as { code: string }).code).toBe('url_denylisted');
    expect(launched).toBe(false);
  });

  it('returns an authenticated page extract when the host is not denylisted', async () => {
    const { home, sessionsDir, token } = makeDaemonHome();
    enableDriveConsent(sessionsDir, home);
    // Empty denylist = allow all hosts.
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

  it('reads through the configured profile, not an unconfigured browser', async () => {
    // Reading the operator's logged-in browser means reading THAT browser. This
    // path used to start a session with no profile at all, so it could only ever
    // have read a signed-out one -- and once the default fallback went away it
    // could not start a session at all. The home has to reach the impl for the
    // profile to be resolvable from it.
    const { home, sessionsDir, token } = makeDaemonHome();
    enableDriveConsent(sessionsDir, home);
    let seenHome: string | undefined;
    const result = await resolveAoiHostBridgeRoute({
      method: 'POST',
      route: '/browser-drive-read',
      body: { sessionPath: 'aoi/default', url: 'https://example.com/account' },
      token,
      openroomHome: home,
      sessionsDir,
      now: 2000,
      browserDriveReadImpl: async ({ url, openroomHome }) => {
        seenHome = openroomHome;
        return {
          ok: true,
          url,
          finalUrl: url,
          hostname: 'example.com',
          title: 'Inbox',
          excerpt: '',
          siteName: 'example.com',
          blocks: [],
          text: '',
          sampledAt: 2000,
        };
      },
    });
    expect(result.status).toBe(200);
    expect(seenHome).toBe(home);
  });

  it('maps a drive failure to 422', async () => {
    const { home, sessionsDir, token } = makeDaemonHome();
    enableDriveConsent(sessionsDir, home);
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
        reason: 'drift_to_denylist',
        hostname: 'tracker.evil.com',
      }),
    });
    expect(result.status).toBe(422);
    expect((result.payload as { code: string }).code).toBe('drift_to_denylist');
  });
});

describe('resolveAoiHostBridgeRoute /browser-drive/preview + /execute (BD P2.3)', () => {
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
    // Empty denylist = all hosts allowed by default (example.com included).
    saveAoiBrowserDriveAllowlist(home, { version: 1, entries: [], updatedAt: 1500 });
  }

  const PLAN = {
    goal: 'refresh the dashboard',
    steps: [
      { description: 'open', action: { kind: 'navigate', url: 'https://example.com/account' } },
      { description: 'click refresh', action: { kind: 'click', selector: '#refresh' } },
    ],
  };

  it('preview blocks when capability/consent is off', async () => {
    const { home, sessionsDir, token } = makeDaemonHome();
    // Computer use is on by default now, so blocking is what happens when the
    // operator switches it OFF -- that is the guarantee worth pinning.
    saveAoiHostBridgeKillSwitchState(
      home,
      setAoiHostBridgeCapability(null, 'os_computer_use', false, 900),
    );
    const result = await resolveAoiHostBridgeRoute({
      method: 'POST',
      route: '/browser-drive/preview',
      body: { sessionPath: 'aoi/default', plan: PLAN, targetStepIndex: 1 },
      token,
      openroomHome: home,
      sessionsDir,
      now: 2000,
    });
    expect(result.status).toBe(403);
  });

  it('preview rejects a non-act target before opening a browser', async () => {
    const { home, sessionsDir, token } = makeDaemonHome();
    enableDriveConsent(sessionsDir, home);
    let launched = false;
    const result = await resolveAoiHostBridgeRoute({
      method: 'POST',
      route: '/browser-drive/preview',
      body: { sessionPath: 'aoi/default', plan: PLAN, targetStepIndex: 0 },
      token,
      openroomHome: home,
      sessionsDir,
      now: 2000,
      browserDrivePreviewImpl: async () => {
        launched = true;
        return { ok: false, reason: 'session_start_failed' };
      },
    });
    expect(result.status).toBe(422);
    expect((result.payload as { code: string }).code).toBe('not_an_act');
    expect(launched).toBe(false);
  });

  it('preview records a pending approval and returns the fingerprint + before-screenshot', async () => {
    const { home, sessionsDir, token } = makeDaemonHome();
    enableDriveConsent(sessionsDir, home);
    const result = await resolveAoiHostBridgeRoute({
      method: 'POST',
      route: '/browser-drive/preview',
      body: { sessionPath: 'aoi/default', plan: PLAN, targetStepIndex: 1 },
      token,
      openroomHome: home,
      sessionsDir,
      now: 2000,
      browserDrivePreviewImpl: async () => ({
        ok: true,
        stepIndex: 1,
        action: { kind: 'click', selector: '#refresh' },
        hostname: 'example.com',
        finalUrl: 'https://example.com/account',
        beforeScreenshotBase64: 'AAAA',
        prefix: [],
      }),
    });
    expect(result.status).toBe(200);
    const preview = (result.payload as { preview: Record<string, unknown> }).preview;
    expect(preview.capability).toBe('os_browser_drive');
    expect(preview.beforeScreenshotBase64).toBe('AAAA');
    const fingerprint = preview.approvalFingerprint as string;
    expect(fingerprint).toMatch(/^[a-f0-9]+$/i);

    // The pending approval is visible to the operator approve step.
    const approvals = await resolveAoiHostBridgeRoute({
      method: 'GET',
      route: '/approvals',
      body: {},
      token,
      openroomHome: home,
      sessionsDir,
      now: 2001,
    });
    const list = (
      approvals.payload as { approvals: Array<{ approvalFingerprint: string; capability: string }> }
    ).approvals;
    expect(
      list.some(
        (a) => a.approvalFingerprint === fingerprint && a.capability === 'os_browser_drive',
      ),
    ).toBe(true);
  });

  it('preview maps a runner failure to 422', async () => {
    const { home, sessionsDir, token } = makeDaemonHome();
    enableDriveConsent(sessionsDir, home);
    const result = await resolveAoiHostBridgeRoute({
      method: 'POST',
      route: '/browser-drive/preview',
      body: { sessionPath: 'aoi/default', plan: PLAN, targetStepIndex: 1 },
      token,
      openroomHome: home,
      sessionsDir,
      now: 2000,
      browserDrivePreviewImpl: async () => ({
        ok: false,
        reason: 'prefix_failed',
        detail: 'drift',
      }),
    });
    expect(result.status).toBe(422);
    expect((result.payload as { code: string }).code).toBe('prefix_failed');
  });

  it('execute blocks when capability/consent is off', async () => {
    const { home, sessionsDir, token } = makeDaemonHome();
    // Computer use is on by default now, so blocking is what happens when the
    // operator switches it OFF -- that is the guarantee worth pinning.
    saveAoiHostBridgeKillSwitchState(
      home,
      setAoiHostBridgeCapability(null, 'os_computer_use', false, 900),
    );
    const result = await resolveAoiHostBridgeRoute({
      method: 'POST',
      route: '/browser-drive/execute',
      body: { sessionPath: 'aoi/default', plan: PLAN, targetStepIndex: 1 },
      token,
      openroomHome: home,
      sessionsDir,
      now: 2000,
    });
    expect(result.status).toBe(403);
  });

  it('execute rejects a malformed body', async () => {
    const { home, sessionsDir, token } = makeDaemonHome();
    enableDriveConsent(sessionsDir, home);
    const result = await resolveAoiHostBridgeRoute({
      method: 'POST',
      route: '/browser-drive/execute',
      body: { sessionPath: 'aoi/default', plan: PLAN },
      token,
      openroomHome: home,
      sessionsDir,
      now: 2000,
    });
    expect(result.status).toBe(400);
  });

  it('execute returns 403 when the target act is not approved', async () => {
    const { home, sessionsDir, token } = makeDaemonHome();
    enableDriveConsent(sessionsDir, home);
    const result = await resolveAoiHostBridgeRoute({
      method: 'POST',
      route: '/browser-drive/execute',
      body: { sessionPath: 'aoi/default', plan: PLAN, targetStepIndex: 1 },
      token,
      openroomHome: home,
      sessionsDir,
      now: 2000,
      browserDriveExecuteImpl: async () => ({
        ok: false,
        stepIndex: 1,
        action: { kind: 'click', selector: '#refresh' },
        prefix: [],
        target: {
          index: 1,
          category: 'act',
          ok: false,
          stopReason: 'approval_denied',
          detail: 'not approved',
        },
      }),
    });
    expect(result.status).toBe(403);
    expect((result.payload as { code: string }).code).toBe('approval_denied');
  });

  it('execute maps a panic abort to 403', async () => {
    const { home, sessionsDir, token } = makeDaemonHome();
    enableDriveConsent(sessionsDir, home);
    const result = await resolveAoiHostBridgeRoute({
      method: 'POST',
      route: '/browser-drive/execute',
      body: { sessionPath: 'aoi/default', plan: PLAN, targetStepIndex: 1 },
      token,
      openroomHome: home,
      sessionsDir,
      now: 2000,
      browserDriveExecuteImpl: async () => ({ ok: false, reason: 'panicked' }),
    });
    expect(result.status).toBe(403);
    expect((result.payload as { code: string }).code).toBe('panicked');
  });

  it('execute maps a runner-level failure to 422', async () => {
    const { home, sessionsDir, token } = makeDaemonHome();
    enableDriveConsent(sessionsDir, home);
    const result = await resolveAoiHostBridgeRoute({
      method: 'POST',
      route: '/browser-drive/execute',
      body: { sessionPath: 'aoi/default', plan: PLAN, targetStepIndex: 1 },
      token,
      openroomHome: home,
      sessionsDir,
      now: 2000,
      browserDriveExecuteImpl: async () => ({ ok: false, reason: 'prefix_contains_act' }),
    });
    expect(result.status).toBe(422);
    expect((result.payload as { code: string }).code).toBe('prefix_contains_act');
  });

  it('execute returns 200 with the result when the approved act runs', async () => {
    const { home, sessionsDir, token } = makeDaemonHome();
    enableDriveConsent(sessionsDir, home);
    const result = await resolveAoiHostBridgeRoute({
      method: 'POST',
      route: '/browser-drive/execute',
      body: { sessionPath: 'aoi/default', plan: PLAN, targetStepIndex: 1 },
      token,
      openroomHome: home,
      sessionsDir,
      now: 2000,
      browserDriveExecuteImpl: async () => ({
        ok: true,
        stepIndex: 1,
        action: { kind: 'click', selector: '#refresh' },
        prefix: [],
        target: {
          index: 1,
          category: 'act',
          ok: true,
          finalUrl: 'https://example.com/account',
        },
      }),
    });
    expect(result.status).toBe(200);
    expect((result.payload as { ok: boolean }).ok).toBe(true);
  });
});

describe('resolveAoiHostBridgeRoute /browser-drive/task (BD P3.2)', () => {
  function enableDriveConsent(sessionsDir: string, home: string): void {
    const registry = getDefaultAoiEnvironmentSourceRegistry('aoi/default', 1000);
    saveAoiEnvironmentSourceRegistry(sessionsDir, 'aoi/default', registry);
    updateAoiEnvironmentSource(sessionsDir, 'aoi/default', {
      sourceId: 'browser-drive',
      patch: { enabled: true, consentReason: 'test' },
      now: 1500,
    });
    saveAoiHostBridgeKillSwitchState(
      home,
      setAoiHostBridgeCapability(null, 'os_browser_drive', true, 1500),
    );
  }
  function enableTaskToggle(home: string): void {
    const current = loadAoiHostBridgeKillSwitchState(home);
    saveAoiHostBridgeKillSwitchState(
      home,
      setAoiHostBridgeCapability(current, 'os_browser_drive_task', true, 1600),
    );
  }

  const TASK = {
    owner: 'user',
    goal: 'refresh twice',
    steps: [
      {
        plan: {
          goal: 'refresh twice',
          steps: [
            { description: 'open', action: { kind: 'navigate', url: 'https://example.com/a' } },
            { description: 'click', action: { kind: 'click', selector: '#refresh' } },
          ],
        },
        targetStepIndex: 1,
      },
    ],
  };

  it('blocks when the os_browser_drive_task toggle is off (even with base consent)', async () => {
    const { home, sessionsDir, token } = makeDaemonHome();
    enableDriveConsent(sessionsDir, home);
    const result = await resolveAoiHostBridgeRoute({
      method: 'POST',
      route: '/browser-drive/task',
      body: { sessionPath: 'aoi/default', task: TASK },
      token,
      openroomHome: home,
      sessionsDir,
      now: 2000,
    });
    expect(result.status).toBe(403);
    expect((result.payload as { code: string }).code).toBe('task_capability_disabled');
  });

  it('runs the bounded task when the toggle is on', async () => {
    const { home, sessionsDir, token } = makeDaemonHome();
    enableDriveConsent(sessionsDir, home);
    enableTaskToggle(home);
    const result = await resolveAoiHostBridgeRoute({
      method: 'POST',
      route: '/browser-drive/task',
      body: { sessionPath: 'aoi/default', task: TASK },
      token,
      openroomHome: home,
      sessionsDir,
      now: 2000,
      browserDriveTaskImpl: async (opts) => ({
        ok: true,
        goal: opts.task.goal,
        stopReason: 'completed',
        actsRun: 1,
        stepsRun: 2,
        results: [{ index: 0, ok: true, finalUrl: 'https://example.com/done' }],
      }),
    });
    expect(result.status).toBe(200);
    expect((result.payload as { result: { actsRun: number } }).result.actsRun).toBe(1);
  });

  it('maps a not_operator_authored refusal to 403', async () => {
    const { home, sessionsDir, token } = makeDaemonHome();
    enableDriveConsent(sessionsDir, home);
    enableTaskToggle(home);
    const result = await resolveAoiHostBridgeRoute({
      method: 'POST',
      route: '/browser-drive/task',
      body: { sessionPath: 'aoi/default', task: { ...TASK, owner: 'aoi' } },
      token,
      openroomHome: home,
      sessionsDir,
      now: 2000,
      browserDriveTaskImpl: async () => ({
        ok: false,
        goal: 'x',
        stopReason: 'not_operator_authored',
        actsRun: 0,
        stepsRun: 0,
        results: [],
      }),
    });
    expect(result.status).toBe(403);
    expect((result.payload as { code: string }).code).toBe('not_operator_authored');
  });

  it('rejects a malformed task body', async () => {
    const { home, sessionsDir, token } = makeDaemonHome();
    enableDriveConsent(sessionsDir, home);
    enableTaskToggle(home);
    const result = await resolveAoiHostBridgeRoute({
      method: 'POST',
      route: '/browser-drive/task',
      body: { sessionPath: 'aoi/default', task: { owner: 'user', steps: [] } },
      token,
      openroomHome: home,
      sessionsDir,
      now: 2000,
    });
    expect(result.status).toBe(400);
  });
});

describe('/browser-drive/audit (BD P3.3, auth-only read)', () => {
  it('returns the recorded step-audit ledger newest-first', async () => {
    const { home, sessionsDir, token } = makeDaemonHome();
    // Seed two audit entries directly via the store.
    recordAoiBrowserDriveAuditEntry(
      home,
      {
        runId: 'run-1',
        stepIndex: 0,
        actionKind: 'navigate',
        actionSummary: 'navigate example.com',
        category: 'read',
        ok: true,
        url: 'https://example.com/a',
      },
      1000,
    );
    recordAoiBrowserDriveAuditEntry(
      home,
      {
        runId: 'run-1',
        stepIndex: 1,
        actionKind: 'click',
        actionSummary: 'click #go on example.com',
        category: 'act',
        ok: true,
        viaStanding: true,
        url: 'https://example.com/a',
      },
      1100,
    );
    const result = await resolveAoiHostBridgeRoute({
      method: 'GET',
      route: '/browser-drive/audit',
      body: {},
      token,
      openroomHome: home,
      sessionsDir,
      now: 2000,
    });
    expect(result.status).toBe(200);
    const entries = (result.payload as { entries: Array<Record<string, unknown>> }).entries;
    expect(entries).toHaveLength(2);
    // newest-first
    expect(entries[0].stepIndex).toBe(1);
    expect(entries[0].viaStanding).toBe(true);
    expect(entries[0].category).toBe('act');
  });

  it('requires a valid token', async () => {
    const { home, sessionsDir } = makeDaemonHome();
    const res = await resolveAoiHostBridgeRoute({
      method: 'GET',
      route: '/browser-drive/audit',
      body: {},
      token: 'b'.repeat(64),
      openroomHome: home,
      sessionsDir,
      now: 1,
    });
    expect(res.status).toBe(401);
  });
});

describe('standing-grant CRUD (BD P3.1c, auth-only)', () => {
  it('adds, lists (live only), and removes a standing grant; rejects a bad domain', async () => {
    const { home, sessionsDir, token } = makeDaemonHome();
    const add = await resolveAoiHostBridgeRoute({
      method: 'POST',
      route: '/browser-drive/standing-grants',
      body: { domain: 'example.com', maxActions: 5, ttlMs: 60_000 },
      token,
      openroomHome: home,
      sessionsDir,
      now: 1000,
    });
    expect(add.status).toBe(200);
    const grants = (add.payload as { grants: Array<{ id: string; domain: string }> }).grants;
    expect(grants).toHaveLength(1);
    expect(grants[0].domain).toBe('example.com');

    const list = await resolveAoiHostBridgeRoute({
      method: 'GET',
      route: '/browser-drive/standing-grants',
      body: {},
      token,
      openroomHome: home,
      sessionsDir,
      now: 2000,
    });
    expect((list.payload as { grants: unknown[] }).grants).toHaveLength(1);

    // Past the TTL the list prunes it out.
    const listLater = await resolveAoiHostBridgeRoute({
      method: 'GET',
      route: '/browser-drive/standing-grants',
      body: {},
      token,
      openroomHome: home,
      sessionsDir,
      now: 1000 + 60_001,
    });
    expect((listLater.payload as { grants: unknown[] }).grants).toHaveLength(0);

    const del = await resolveAoiHostBridgeRoute({
      method: 'DELETE',
      route: '/browser-drive/standing-grants',
      body: { id: grants[0].id },
      token,
      openroomHome: home,
      sessionsDir,
      now: 3000,
    });
    expect((del.payload as { grants: unknown[] }).grants).toHaveLength(0);

    const bad = await resolveAoiHostBridgeRoute({
      method: 'POST',
      route: '/browser-drive/standing-grants',
      body: { domain: 'not a domain' },
      token,
      openroomHome: home,
      sessionsDir,
      now: 4000,
    });
    expect(bad.status).toBe(400);
  });

  it('requires a valid token', async () => {
    const { home, sessionsDir } = makeDaemonHome();
    const res = await resolveAoiHostBridgeRoute({
      method: 'GET',
      route: '/browser-drive/standing-grants',
      body: {},
      token: 'b'.repeat(64),
      openroomHome: home,
      sessionsDir,
      now: 1000,
    });
    expect(res.status).toBe(401);
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

  it('adds, lists, and removes a browser-drive denylist domain; rejects junk', async () => {
    const { home, sessionsDir, token } = makeDaemonHome();
    const add = await resolveAoiHostBridgeRoute({
      method: 'POST',
      route: '/browser-drive-allowlist',
      body: { domain: 'GitHub.com', label: 'GitHub' },
      token,
      openroomHome: home,
      sessionsDir,
      now: 1000,
    });
    expect(add.status).toBe(200);
    const addPayload = add.payload as {
      entries: Array<{ id: string; domain: string }>;
      mode?: string;
    };
    expect(addPayload.mode).toBe('denylist');
    expect(addPayload.entries).toEqual([
      { id: 'github-com', domain: 'github.com', label: 'GitHub', addedAt: 1000 },
    ]);

    const bad = await resolveAoiHostBridgeRoute({
      method: 'POST',
      route: '/browser-drive-denylist',
      body: { domain: 'not a domain' },
      token,
      openroomHome: home,
      sessionsDir,
      now: 1000,
    });
    expect(bad.status).toBe(400);

    const list = await resolveAoiHostBridgeRoute({
      method: 'GET',
      route: '/browser-drive-denylist',
      body: {},
      token,
      openroomHome: home,
      sessionsDir,
      now: 1500,
    });
    expect((list.payload as { entries: unknown[]; mode: string }).entries).toHaveLength(1);
    expect((list.payload as { mode: string }).mode).toBe('denylist');

    const del = await resolveAoiHostBridgeRoute({
      method: 'DELETE',
      route: '/browser-drive-allowlist',
      body: { id: 'github-com' },
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
    const approvals = (
      list.payload as {
        approvals: Array<{ state: string; capability: string; canExecute?: boolean }>;
      }
    ).approvals;
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({
      state: 'pending',
      capability: 'os_process_spawn',
      canExecute: true,
    });
  });

  it('approve is idempotent and approve-and-execute runs from stored payload', async () => {
    const { home, sessionsDir, token } = makeDaemonHome();
    saveAoiHostFakeSpawnEntry(home);
    saveAoiHostBridgeKillSwitchState(
      home,
      setAoiHostBridgeCapability(null, 'os_process_spawn', true, 1500),
    );

    const preview = await call(
      home,
      sessionsDir,
      token,
      'POST',
      '/spawn/preview',
      { allowlistId: 'fake' },
      2000,
    );
    const fingerprint = (preview.payload as { preview: { approvalFingerprint: string } }).preview
      .approvalFingerprint;

    const first = await call(
      home,
      sessionsDir,
      token,
      'POST',
      '/approvals/approve',
      { approvalFingerprint: fingerprint },
      2100,
    );
    expect(first.status).toBe(200);
    expect((first.payload as { alreadyApproved?: boolean }).alreadyApproved).toBe(false);

    // Re-click Approve must not 404 with "no pending approval".
    const second = await call(
      home,
      sessionsDir,
      token,
      'POST',
      '/approvals/approve',
      { approvalFingerprint: fingerprint },
      2200,
    );
    expect(second.status).toBe(200);
    expect((second.payload as { alreadyApproved?: boolean }).alreadyApproved).toBe(true);

    // Operator Approve & Run path executes from the stored payload.
    const run = await call(
      home,
      sessionsDir,
      token,
      'POST',
      '/approvals/approve-and-execute',
      { approvalFingerprint: fingerprint },
      2300,
    );
    // Fake exe fails at spawn_failed, but must NOT fail approval_missing.
    const reasons = (run.payload as { blockReasons?: string[] }).blockReasons ?? [];
    expect(reasons).not.toContain('approval_missing');
    expect(reasons).toContain('spawn_failed');
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

describe('an unreadable kill-switch file', () => {
  function corruptKillSwitch(home: string): string {
    const filePath = resolveAoiHostBridgeKillSwitchPath(home);
    fs.mkdirSync(join(filePath, '..'), { recursive: true });
    fs.writeFileSync(filePath, '{"version":1,"globalPan', 'utf-8');
    return filePath;
  }

  it('reports the machine as stopped, and says the file is why', async () => {
    // Stopped either way, but "the operator pressed panic" and "the safety file
    // cannot be read" call for different actions from them.
    const { home, sessionsDir, token } = makeDaemonHome();
    corruptKillSwitch(home);
    const result = await resolveAoiHostBridgeRoute({
      method: 'GET',
      route: '/status',
      body: {},
      token,
      openroomHome: home,
      sessionsDir,
      now: 1000,
    });
    const killSwitch = (
      result.payload as { killSwitch: { globalPanic: boolean; unreadable?: boolean } }
    ).killSwitch;
    expect(killSwitch.globalPanic).toBe(true);
    expect(killSwitch.unreadable).toBe(true);
  });

  it('refuses to edit it, because saving would overwrite the real settings', async () => {
    const { home, sessionsDir, token } = makeDaemonHome();
    const filePath = corruptKillSwitch(home);
    const before = fs.readFileSync(filePath, 'utf-8');
    const result = await resolveAoiHostBridgeRoute({
      method: 'POST',
      route: '/killswitch',
      body: { action: 'clear_panic' },
      token,
      openroomHome: home,
      sessionsDir,
      now: 1000,
    });
    expect(result.status).toBe(409);
    expect((result.payload as { code: string }).code).toBe('killswitch_unreadable');
    expect(fs.readFileSync(filePath, 'utf-8')).toBe(before);
  });

  it('blocks a capability route while the file is unreadable', async () => {
    // The point of the stop: nothing acts on the machine until the operator's
    // safety configuration can be read again.
    const { home, sessionsDir, token } = makeDaemonHome();
    corruptKillSwitch(home);
    const result = await resolveAoiHostBridgeRoute({
      method: 'POST',
      route: '/desktop-input',
      body: { op: 'list_windows' },
      token,
      openroomHome: home,
      sessionsDir,
      now: 1000,
    });
    expect(result.status).toBe(403);
  });
});

describe('a refusal that asks the operator to repair a file', () => {
  // "Repair or delete the file first" named the file in a `path` field, and the
  // client builds its error from `error` + `denyReasons` + `detail` only. So the
  // instruction arrived without the one piece of information it needed.
  it('names the denylist file in a field the client carries', async () => {
    const { home, sessionsDir, token } = makeDaemonHome();
    const filePath = resolveAoiBrowserDriveAllowlistPath(home);
    fs.mkdirSync(join(filePath, '..'), { recursive: true });
    fs.writeFileSync(filePath, '{"version":1,"entr', 'utf-8');
    const result = await resolveAoiHostBridgeRoute({
      method: 'POST',
      route: '/browser-drive-denylist',
      body: { domain: 'evil.com' },
      token,
      openroomHome: home,
      sessionsDir,
      now: 1000,
    });
    expect(result.status).toBe(409);
    expect((result.payload as { detail?: string }).detail).toContain('denylist');
  });

  it('names the kill-switch file too', async () => {
    const { home, sessionsDir, token } = makeDaemonHome();
    const filePath = resolveAoiHostBridgeKillSwitchPath(home);
    fs.mkdirSync(join(filePath, '..'), { recursive: true });
    fs.writeFileSync(filePath, 'not json', 'utf-8');
    const result = await resolveAoiHostBridgeRoute({
      method: 'POST',
      route: '/killswitch',
      body: { action: 'clear_panic' },
      token,
      openroomHome: home,
      sessionsDir,
      now: 1000,
    });
    expect(result.status).toBe(409);
    expect((result.payload as { detail?: string }).detail).toContain('killswitch');
  });

  it('does not call an unreadable denylist a denylisted URL', async () => {
    // Nothing is wrong with the URL. Saying "url_denylisted" sends the operator
    // looking for an entry that does not exist.
    const { home, sessionsDir, token } = makeDaemonHome();
    const registry = getDefaultAoiEnvironmentSourceRegistry('aoi/default', 1000);
    saveAoiEnvironmentSourceRegistry(sessionsDir, 'aoi/default', registry);
    updateAoiEnvironmentSource(sessionsDir, 'aoi/default', {
      sourceId: 'browser-drive',
      patch: { enabled: true, consentReason: 'test' },
      now: 1500,
    });
    const filePath = resolveAoiBrowserDriveAllowlistPath(home);
    fs.mkdirSync(join(filePath, '..'), { recursive: true });
    fs.writeFileSync(filePath, '{"version":1,"entr', 'utf-8');

    const result = await resolveAoiHostBridgeRoute({
      method: 'POST',
      route: '/browser-drive-read',
      body: { sessionPath: 'aoi/default', url: 'https://example.com/x' },
      token,
      openroomHome: home,
      sessionsDir,
      now: 2000,
    });
    expect(result.status).toBe(403);
    expect((result.payload as { code: string }).code).toBe('denylist_unreadable');
    expect((result.payload as { detail?: string }).detail).toContain('denylist');
  });
});

describe('a busy store', () => {
  // The lock throws when it cannot be taken. Uncaught, that is a 500 with a raw
  // message and no code -- a transient, retryable condition reported as a crash,
  // and answered differently on every route.
  function holdLock(home: string, name: string): void {
    const lockPath = resolveAoiHostStoreLockPath(home, name);
    fs.mkdirSync(join(lockPath, '..'), { recursive: true });
    fs.writeFileSync(lockPath, 'held-by-another-process');
  }

  it('answers 409 store_busy on a config route, not 500', async () => {
    const { home, sessionsDir, token } = makeDaemonHome();
    holdLock(home, 'read-roots');
    const result = await resolveAoiHostBridgeRoute({
      method: 'POST',
      route: '/read-roots',
      body: { path: join(home, 'docs') },
      token,
      openroomHome: home,
      sessionsDir,
      now: 1000,
    });
    expect(result.status).toBe(409);
    expect((result.payload as { code: string }).code).toBe('store_busy');
  });

  it('answers the same way on the kill switch', async () => {
    // Same condition, same answer. It used to be a bespoke code here and a bare
    // 500 elsewhere.
    const { home, sessionsDir, token } = makeDaemonHome();
    holdLock(home, 'killswitch');
    const result = await resolveAoiHostBridgeRoute({
      method: 'POST',
      route: '/killswitch',
      body: { action: 'panic' },
      token,
      openroomHome: home,
      sessionsDir,
      now: 1000,
    });
    expect(result.status).toBe(409);
    expect((result.payload as { code: string }).code).toBe('store_busy');
  });

  it('rejects a bad request without waiting on the lock', async () => {
    // Validation happens before the lock is taken, so a malformed request is
    // not made to queue behind another process.
    const { home, sessionsDir, token } = makeDaemonHome();
    holdLock(home, 'killswitch');
    const result = await resolveAoiHostBridgeRoute({
      method: 'POST',
      route: '/killswitch',
      body: { action: 'nonsense' },
      token,
      openroomHome: home,
      sessionsDir,
      now: 1000,
    });
    expect(result.status).toBe(400);
  });
});

describe('browser-drive denylist when the stored file is unreadable', () => {
  function corrupt(home: string): void {
    const filePath = resolveAoiBrowserDriveAllowlistPath(home);
    fs.mkdirSync(join(filePath, '..'), { recursive: true });
    fs.writeFileSync(filePath, '{"version":1,"entr', 'utf-8');
  }

  it('says so instead of reporting an empty list', async () => {
    const { home, sessionsDir, token } = makeDaemonHome();
    corrupt(home);
    const result = await resolveAoiHostBridgeRoute({
      method: 'GET',
      route: '/browser-drive-denylist',
      body: {},
      token,
      openroomHome: home,
      sessionsDir,
      now: 1000,
    });
    expect(result.status).toBe(200);
    expect((result.payload as { unreadable?: boolean }).unreadable).toBe(true);
  });

  it('refuses to edit it, because saving would overwrite the real entries', async () => {
    // add/remove build the saved value from the loaded one, and the loaded one
    // is an empty stand-in here -- so one edit would discard whatever is still
    // on disk.
    const { home, sessionsDir, token } = makeDaemonHome();
    corrupt(home);
    const before = fs.readFileSync(resolveAoiBrowserDriveAllowlistPath(home), 'utf-8');
    const result = await resolveAoiHostBridgeRoute({
      method: 'POST',
      route: '/browser-drive-denylist',
      body: { domain: 'evil.com' },
      token,
      openroomHome: home,
      sessionsDir,
      now: 1000,
    });
    expect(result.status).toBe(409);
    expect((result.payload as { code: string }).code).toBe('denylist_unreadable');
    expect(fs.readFileSync(resolveAoiBrowserDriveAllowlistPath(home), 'utf-8')).toBe(before);
  });

  it('still edits a readable list normally', async () => {
    const { home, sessionsDir, token } = makeDaemonHome();
    const result = await resolveAoiHostBridgeRoute({
      method: 'POST',
      route: '/browser-drive-denylist',
      body: { domain: 'evil.com' },
      token,
      openroomHome: home,
      sessionsDir,
      now: 1000,
    });
    expect(result.status).toBe(200);
    expect((result.payload as { entries: unknown[] }).entries).toHaveLength(1);
  });
});

describe('browser-drive profile', () => {
  // Chrome refuses remote debugging on its own default profile, so the profile
  // is a required setup step rather than a preference -- and a setting that
  // stores something unusable looks applied and fails much later.
  it('stores an absolute directory and reports it back', async () => {
    const { home, sessionsDir, token } = makeDaemonHome();
    const saved = await resolveAoiHostBridgeRoute({
      method: 'POST',
      route: '/browser-drive/profile',
      body: { userDataDir: join(home, 'drive-profile') },
      token,
      openroomHome: home,
      sessionsDir,
      now: 1000,
    });
    expect(saved.status).toBe(200);
    expect((saved.payload as { configured: boolean }).configured).toBe(true);

    const read = await resolveAoiHostBridgeRoute({
      method: 'GET',
      route: '/browser-drive/profile',
      body: {},
      token,
      openroomHome: home,
      sessionsDir,
      now: 1100,
    });
    expect((read.payload as { userDataDir: string }).userDataDir).toContain('drive-profile');
  });

  it('refuses a relative path', async () => {
    const { home, sessionsDir, token } = makeDaemonHome();
    const result = await resolveAoiHostBridgeRoute({
      method: 'POST',
      route: '/browser-drive/profile',
      body: { userDataDir: 'drive-profile' },
      token,
      openroomHome: home,
      sessionsDir,
      now: 1000,
    });
    expect(result.status).toBe(400);
    expect((result.payload as { code: string }).code).toBe('invalid_profile_dir');
  });

  it('clears the setting when given an empty value', async () => {
    const { home, sessionsDir, token } = makeDaemonHome();
    await resolveAoiHostBridgeRoute({
      method: 'POST',
      route: '/browser-drive/profile',
      body: { userDataDir: join(home, 'drive-profile') },
      token,
      openroomHome: home,
      sessionsDir,
      now: 1000,
    });
    const cleared = await resolveAoiHostBridgeRoute({
      method: 'POST',
      route: '/browser-drive/profile',
      body: { userDataDir: '' },
      token,
      openroomHome: home,
      sessionsDir,
      now: 1100,
    });
    expect((cleared.payload as { configured: boolean }).configured).toBe(false);
  });

  it('opens the configured profile for signing in', async () => {
    const { home, sessionsDir, token } = makeDaemonHome();
    const dir = join(home, 'drive-profile');
    await resolveAoiHostBridgeRoute({
      method: 'POST',
      route: '/browser-drive/profile',
      body: { userDataDir: dir },
      token,
      openroomHome: home,
      sessionsDir,
      now: 1000,
    });

    const opened: { exe: string; dir: string }[] = [];
    const result = await resolveAoiHostBridgeRoute({
      method: 'POST',
      route: '/browser-drive/profile/open',
      body: {},
      token,
      openroomHome: home,
      sessionsDir,
      now: 1200,
      browserProfileOpenImpl: (exe: string, userDataDir: string) => {
        opened.push({ exe, dir: userDataDir });
      },
    });
    // A machine with no Chrome installed answers 501 rather than pretending.
    if (result.status === 501) {
      expect(opened).toHaveLength(0);
      return;
    }
    expect(result.status).toBe(200);
    expect(opened).toHaveLength(1);
    expect(opened[0].dir).toBe(dir);
  });

  it('refuses to spawn a browser while the bridge is panicked', async () => {
    // Panic is the emergency stop for everything host-side. This route launches
    // a real process on the desktop and used to consult nothing at all, so a
    // panicked bridge still opened windows.
    const { home, sessionsDir, token } = makeDaemonHome();
    const dir = join(home, 'drive-profile');
    await resolveAoiHostBridgeRoute({
      method: 'POST',
      route: '/browser-drive/profile',
      body: { userDataDir: dir },
      token,
      openroomHome: home,
      sessionsDir,
      now: 1000,
    });
    saveAoiHostBridgeKillSwitchState(home, engageAoiHostBridgePanic(null, 1100));

    const opened: string[] = [];
    const result = await resolveAoiHostBridgeRoute({
      method: 'POST',
      route: '/browser-drive/profile/open',
      body: {},
      token,
      openroomHome: home,
      sessionsDir,
      now: 1200,
      browserProfileOpenImpl: (_exe: string, userDataDir: string) => {
        opened.push(userDataDir);
      },
    });
    expect(result.status).toBe(403);
    expect((result.payload as { code: string }).code).toBe('panic');
    expect(opened).toHaveLength(0);
  });

  it('refuses to open anything when no profile is set', async () => {
    const { home, sessionsDir, token } = makeDaemonHome();
    const opened: string[] = [];
    const result = await resolveAoiHostBridgeRoute({
      method: 'POST',
      route: '/browser-drive/profile/open',
      body: {},
      token,
      openroomHome: home,
      sessionsDir,
      now: 1200,
      browserProfileOpenImpl: (_exe: string, dir: string) => {
        opened.push(dir);
      },
    });
    expect(result.status).toBe(400);
    expect((result.payload as { code: string }).code).toBe('profile_not_configured');
    expect(opened).toHaveLength(0);
  });
});

describe('desktop-input', () => {
  // A stand-in for the native helper. It records what it was asked and answers
  // with whatever verdict the test wants, so the ROUTE's decisions are under
  // test rather than UI Automation's.
  function fakeHelper(reply: Record<string, unknown>) {
    const seen: { args: string[]; command: Record<string, unknown> }[] = [];
    const spawn = (_helper: string, args: string[], stdin: string) => {
      seen.push({ args, command: JSON.parse(stdin) as Record<string, unknown> });
      return { status: 0, stdout: JSON.stringify(reply), stderr: '' };
    };
    return { spawn, seen };
  }

  function callDesktopInput(
    home: string,
    sessionsDir: string,
    token: string,
    body: Record<string, unknown>,
    spawnImpl: ReturnType<typeof fakeHelper>['spawn'],
  ) {
    return resolveAoiHostBridgeRoute({
      method: 'POST',
      route: '/desktop-input',
      body,
      token,
      openroomHome: home,
      sessionsDir,
      now: 5000,
      desktopInputSpawnImpl: spawnImpl,
    });
  }

  // The helper path is resolved by stat, so point the daemon at a file that
  // really exists; the fake spawn means it is never executed.
  const helperEnvKey = 'AOI_DESKTOP_INPUT_HELPER';

  function withHelperPath(path: string, run: () => Promise<void>): Promise<void> {
    const previous = process.env[helperEnvKey];
    process.env[helperEnvKey] = path;
    return run().finally(() => {
      if (previous === undefined) {
        delete process.env[helperEnvKey];
      } else {
        process.env[helperEnvKey] = previous;
      }
    });
  }

  it('works by default and stops the moment the switch is turned off', async () => {
    // Computer use ships ON: the point of a single default-on switch is that the
    // feature works without being discovered first. What still has to hold is
    // that switching it off stops everything, before the helper is reached.
    const { home, sessionsDir, token } = makeDaemonHome();
    await withHelperPath(__filename, async () => {
      const on = fakeHelper({ ok: true, windows: [] });
      const allowed = await callDesktopInput(
        home,
        sessionsDir,
        token,
        { op: 'list_windows' },
        on.spawn,
      );
      expect(allowed.status).toBe(200);

      saveAoiHostBridgeKillSwitchState(
        home,
        setAoiHostBridgeCapability(null, 'os_computer_use', false, 4000),
      );
      const off = fakeHelper({ ok: true, windows: [] });
      const blocked = await callDesktopInput(
        home,
        sessionsDir,
        token,
        { op: 'list_windows' },
        off.spawn,
      );
      expect(blocked.status).toBe(403);
      // Nothing was spawned: the gate runs before the helper is ever reached.
      expect(off.seen).toHaveLength(0);
    });
  });

  it('remembers being switched off instead of drifting back on', async () => {
    // A default-on capability that forgets an OFF decision is worse than one
    // that defaults off: the operator turns it off, and it comes back.
    const { home, sessionsDir, token } = makeDaemonHome();
    await withHelperPath(__filename, async () => {
      saveAoiHostBridgeKillSwitchState(
        home,
        setAoiHostBridgeCapability(null, 'os_computer_use', false, 4000),
      );
      const status = await resolveAoiHostBridgeRoute({
        method: 'GET',
        route: '/status',
        body: {},
        token,
        openroomHome: home,
        sessionsDir,
        now: 4100,
      });
      const reported = (status.payload as { killSwitch: { enabledCapabilities: string[] } })
        .killSwitch.enabledCapabilities;
      // The settings UI reads this list; it has to say OFF too.
      expect(reported).not.toContain('os_computer_use');

      const { spawn } = fakeHelper({ ok: true, windows: [] });
      const blocked = await callDesktopInput(
        home,
        sessionsDir,
        token,
        { op: 'list_windows' },
        spawn,
      );
      expect(blocked.status).toBe(403);
    });
  });

  it('withholds the SendInput rung until its own capability is on', async () => {
    // The main toggle is the standing approval for acting. It must NOT quietly
    // include the rung that takes over the operator's real mouse.
    const { home, sessionsDir, token } = makeDaemonHome();
    await withHelperPath(__filename, async () => {
      saveAoiHostBridgeKillSwitchState(
        home,
        setAoiHostBridgeCapability(null, 'os_computer_use', true, 4000),
      );
      const act = {
        op: 'invoke',
        hwnd: '0x1a2b',
        ref: 2,
        snapshotId: 'dis-0a1b2c3d',
        allowForeground: true,
      };

      const first = fakeHelper({
        ok: true,
        effect: 'confirmed',
        verified: false,
        path: 'uia_invoke',
      });
      const withheld = await callDesktopInput(home, sessionsDir, token, act, first.spawn);
      expect(withheld.status).toBe(200);
      expect(first.seen[0].args).not.toContain('--allow-foreground');
      expect((withheld.payload as { foregroundAllowed: boolean }).foregroundAllowed).toBe(false);

      const state = loadAoiHostBridgeKillSwitchState(home);
      saveAoiHostBridgeKillSwitchState(
        home,
        setAoiHostBridgeCapability(state, 'os_desktop_input_foreground', true, 4100),
      );
      const second = fakeHelper({
        ok: true,
        effect: 'unverifiable',
        verified: false,
        path: 'sendinput',
      });
      const granted = await callDesktopInput(home, sessionsDir, token, act, second.spawn);
      expect(granted.status).toBe(200);
      expect(second.seen[0].args).toContain('--allow-foreground');
    });
  });

  it('answers a refusal with its verdict, not an HTTP error', async () => {
    // The verdict is the answer. Collapsing a refusal into a 4xx would throw
    // away the one field that says whether anything happened -- and "the call
    // failed" reads very differently from "nothing was clicked".
    const { home, sessionsDir, token } = makeDaemonHome();
    await withHelperPath(__filename, async () => {
      saveAoiHostBridgeKillSwitchState(
        home,
        setAoiHostBridgeCapability(null, 'os_computer_use', true, 4000),
      );
      const { spawn } = fakeHelper({
        ok: false,
        effect: 'suspected_noop',
        verified: false,
        code: 'element_forbidden',
        detail: 'credential fields are never driven by Aoi',
      });
      const result = await callDesktopInput(
        home,
        sessionsDir,
        token,
        { op: 'set_value', hwnd: '0x1a2b', ref: 2, snapshotId: 'dis-0a1b2c3d', value: 'x' },
        spawn,
      );
      expect(result.status).toBe(200);
      const act = (
        result.payload as { act: { ok: boolean; verdict: { effect: string; code?: string } } }
      ).act;
      expect(act.ok).toBe(false);
      expect(act.verdict.effect).toBe('suspected_noop');
      expect(act.verdict.code).toBe('element_forbidden');
    });
  });

  it('covers seeing a window with the same switch that covers driving it', async () => {
    // Capture used to have its own toggle. It is part of Computer-Use, so the
    // single switch governs it -- and switching that off has to stop the
    // screenshots too, not just the clicks.
    const { home, sessionsDir, token } = makeDaemonHome();
    await withHelperPath(__filename, async () => {
      const reply = {
        ok: true,
        snapshotId: 'dis-0a1b2c3d',
        mode: 'som',
        width: 800,
        height: 600,
        scale: 1,
        totalElements: 0,
        elements: [],
        pngBase64: 'AAAA',
      };

      const on = fakeHelper(reply);
      const allowed = await callDesktopInput(
        home,
        sessionsDir,
        token,
        { op: 'capture', hwnd: '0x1a2b' },
        on.spawn,
      );
      expect(allowed.status).toBe(200);
      expect((allowed.payload as { capture: { pngBase64: string } }).capture.pngBase64).toBe(
        'AAAA',
      );

      saveAoiHostBridgeKillSwitchState(
        home,
        setAoiHostBridgeCapability(null, 'os_computer_use', false, 4100),
      );
      const off = fakeHelper(reply);
      const blocked = await callDesktopInput(
        home,
        sessionsDir,
        token,
        { op: 'capture', hwnd: '0x1a2b' },
        off.spawn,
      );
      expect(blocked.status).toBe(403);
      // And no picture was taken on the way to being refused.
      expect(off.seen).toHaveLength(0);
    });
  });

  it('says the helper is not installed rather than pretending it acted', async () => {
    const { home, sessionsDir, token } = makeDaemonHome();
    await withHelperPath(join(home, 'no-such-helper.exe'), async () => {
      saveAoiHostBridgeKillSwitchState(
        home,
        setAoiHostBridgeCapability(null, 'os_computer_use', true, 4000),
      );
      const { spawn } = fakeHelper({ ok: true, windows: [] });
      const result = await callDesktopInput(
        home,
        sessionsDir,
        token,
        { op: 'list_windows' },
        spawn,
      );
      expect(result.status).toBe(501);
      expect((result.payload as { code: string }).code).toBe('helper_not_installed');
    });
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

describe('screen-vision ingest + summary (SV3.2)', () => {
  function enableScreenVision(sessionsDir: string, home: string, capability = true): void {
    const registry = getDefaultAoiEnvironmentSourceRegistry('aoi/default', 1000);
    saveAoiEnvironmentSourceRegistry(sessionsDir, 'aoi/default', registry);
    updateAoiEnvironmentSource(sessionsDir, 'aoi/default', {
      sourceId: 'screen-vision',
      patch: { enabled: true, consentReason: 'User enabled screen vision for this test.' },
      now: 1500,
    });
    if (capability) {
      saveAoiHostBridgeKillSwitchState(
        home,
        setAoiHostBridgeCapability(null, 'screen_vision', true, 1500),
      );
    }
  }

  it('blocks without consent, then records a redacted summary and summarizes it', async () => {
    const { home, sessionsDir, token } = makeDaemonHome();
    const post = (summaryText: string, now: number, appId = 'code') =>
      resolveAoiHostBridgeRoute({
        method: 'POST',
        route: '/screen-vision',
        body: {
          sessionPath: 'aoi/default',
          sample: {
            summaryText,
            appId,
            channel: 'local',
            modelId: 'local-vlm',
            confidence: 0.9,
            observedAt: now,
          },
        },
        token,
        openroomHome: home,
        sessionsDir,
        now,
      });

    expect((await post('editing code', 2000)).status).toBe(403);

    enableScreenVision(sessionsDir, home);
    expect(
      (await post('reading gloryo@naver.com at https://mail.example.com', 2100, 'mail')).status,
    ).toBe(200);

    const summary = await resolveAoiHostBridgeRoute({
      method: 'GET',
      route: '/screen-vision/summary',
      body: { sessionPath: 'aoi/default' },
      token,
      openroomHome: home,
      sessionsDir,
      now: 2200,
    });
    expect(summary.status).toBe(200);
    const payload = summary.payload as {
      summary: {
        latestSummaryText: string | null;
        activeEventCount: number;
        activeAppId: string | null;
      };
    };
    expect(payload.summary.activeEventCount).toBe(1);
    expect(payload.summary.activeAppId).toBe('mail');
    expect(payload.summary.latestSummaryText).toContain('[email]');
    expect(payload.summary.latestSummaryText).toContain('[url]');
    expect(payload.summary.latestSummaryText).not.toContain('gloryo@naver.com');
  });

  it('enforces the host-bridge kill switch at the route even when the source is consented', async () => {
    const { home, sessionsDir, token } = makeDaemonHome();
    // Consent the env source but leave the screen_vision kill-switch capability OFF.
    enableScreenVision(sessionsDir, home, false);
    const res = await resolveAoiHostBridgeRoute({
      method: 'POST',
      route: '/screen-vision',
      body: {
        sessionPath: 'aoi/default',
        sample: { summaryText: 'editing code', observedAt: 2100 },
      },
      token,
      openroomHome: home,
      sessionsDir,
      now: 2100,
    });
    expect(res.status).toBe(403);
  });

  it('rejects a sample whose summary is empty after redaction', async () => {
    const { home, sessionsDir, token } = makeDaemonHome();
    enableScreenVision(sessionsDir, home);
    const res = await resolveAoiHostBridgeRoute({
      method: 'POST',
      route: '/screen-vision',
      body: { sessionPath: 'aoi/default', sample: { summaryText: '   ', observedAt: 2100 } },
      token,
      openroomHome: home,
      sessionsDir,
      now: 2100,
    });
    expect(res.status).toBe(400);
    expect((res.payload as { code: string }).code).toBe('empty_summary');
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
