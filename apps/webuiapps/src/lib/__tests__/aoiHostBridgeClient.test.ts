import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  fetchAoiHostBridgeStatus,
  setAoiHostBridgeKillSwitch,
  fetchAoiHostSpawnAllowlist,
  fetchAoiHostSpawnPreview,
  removeAoiHostSpawnAllowlistEntry,
  runAoiHostSpawnExecute,
  fetchAoiHostRoots,
  fetchAoiHostProcesses,
  fetchAoiHostApprovals,
  approveAoiHostApproval,
  fetchAoiHostBrowserDriveActPreview,
  runAoiHostBrowserDriveActExecute,
  fetchAoiBrowserDriveStandingGrants,
  addAoiBrowserDriveStandingGrant,
  removeAoiBrowserDriveStandingGrant,
  runAoiHostBrowserDriveTask,
  fetchAoiBrowserDriveAudit,
} from '../aoiHostBridgeClient';

function mockFetch(payload: unknown, ok = true, status = 200): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => payload,
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('aoiHostBridgeClient', () => {
  it('parses the status envelope + kill switch', async () => {
    mockFetch({
      ok: true,
      tokenConfigured: true,
      killSwitch: { globalPanic: false, enabledCapabilities: ['os_file_read'], updatedAt: 5 },
    });
    const status = await fetchAoiHostBridgeStatus();
    expect(status.tokenConfigured).toBe(true);
    expect(status.killSwitch.enabledCapabilities).toEqual(['os_file_read']);
  });

  it('throws with denyReasons on a non-ok envelope', async () => {
    mockFetch({ ok: false, error: 'blocked', denyReasons: ['panic'] });
    await expect(fetchAoiHostBridgeStatus()).rejects.toThrow(/blocked \[panic\]/);
  });

  it('carries the detail, not just the code', async () => {
    // `error` is a CODE. Every explanation the routes write -- what is in the
    // way and what to do instead -- lives in `detail`, and dropping it here
    // meant a refusal reached the model as a bare slug and the helper install
    // instructions reached nobody at all.
    mockFetch({
      ok: false,
      error: 'helper_not_installed',
      code: 'helper_not_installed',
      detail: 'run tools/aoi-desktop-input/Install-AoiDesktopInput.ps1',
    });
    await expect(fetchAoiHostBridgeStatus()).rejects.toThrow(/Install-AoiDesktopInput/);
  });

  it('joins a detail that arrives as a list, alongside the deny reasons', async () => {
    mockFetch({
      ok: false,
      error: 'blocked',
      denyReasons: ['capability_disabled'],
      detail: ['capability_disabled:os_computer_use'],
    });
    await expect(fetchAoiHostBridgeStatus()).rejects.toThrow(
      /blocked \[capability_disabled\]: capability_disabled:os_computer_use/,
    );
  });

  it('posts a kill-switch set with the exact body', async () => {
    const fetchMock = mockFetch({
      ok: true,
      killSwitch: { globalPanic: false, enabledCapabilities: ['os_process_kill'], updatedAt: 9 },
    });
    const killSwitch = await setAoiHostBridgeKillSwitch('set', {
      capability: 'os_process_kill',
      enabled: true,
    });
    expect(killSwitch.enabledCapabilities).toEqual(['os_process_kill']);
    const init = fetchMock.mock.calls[0][1] as { method: string; body: string };
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      action: 'set',
      capability: 'os_process_kill',
      enabled: true,
    });
  });

  it('parses spawn allowlist entries including optional fields', async () => {
    mockFetch({
      ok: true,
      entries: [{ id: 'np', path: 'C:\\a.exe', label: 'NP', fixedArgs: ['--x'] }],
    });
    const entries = await fetchAoiHostSpawnAllowlist();
    expect(entries[0]).toEqual({ id: 'np', path: 'C:\\a.exe', label: 'NP', fixedArgs: ['--x'] });
  });

  it('posts spawn preview and execute bodies', async () => {
    const previewMock = mockFetch({
      ok: true,
      preview: {
        allowed: true,
        blockReasons: [],
        allowlistId: 'exe-notepad',
        label: 'Notepad',
        program: 'C:\\Windows\\System32\\notepad.exe',
        args: [],
        approvalFingerprint: 'fp',
        expiresAt: 1,
      },
    });
    const preview = await fetchAoiHostSpawnPreview({ allowlistId: 'exe-notepad' });
    expect(preview.allowed).toBe(true);
    expect(preview.approvalFingerprint).toBe('fp');
    expect(previewMock.mock.calls[0][0] as string).toContain('/spawn/preview');

    const runMock = mockFetch({
      ok: true,
      allowlistId: 'exe-notepad',
      program: 'C:\\Windows\\System32\\notepad.exe',
      spawnedPid: 99,
      blockReasons: [],
    });
    const executed = await runAoiHostSpawnExecute({ allowlistId: 'exe-notepad' });
    expect(executed).toEqual({
      ok: true,
      allowlistId: 'exe-notepad',
      program: 'C:\\Windows\\System32\\notepad.exe',
      spawnedPid: 99,
      blockReasons: [],
    });
    expect(runMock.mock.calls[0][0] as string).toContain('/spawn/execute');
  });

  it('removes a spawn entry via DELETE with an encoded id', async () => {
    const fetchMock = mockFetch({ ok: true, entries: [] });
    await removeAoiHostSpawnAllowlistEntry('a b');
    const url = fetchMock.mock.calls[0][0] as string;
    const init = fetchMock.mock.calls[0][1] as { method: string };
    expect(url).toContain('/spawn-allowlist?id=a%20b');
    expect(init.method).toBe('DELETE');
  });

  it('targets the right route for read vs write roots', async () => {
    const readMock = mockFetch({ ok: true, roots: [{ id: 'r', path: '/x' }] });
    expect(await fetchAoiHostRoots('read')).toEqual([{ id: 'r', path: '/x' }]);
    expect(readMock.mock.calls[0][0]).toContain('/read-roots');

    const writeMock = mockFetch({ ok: true, roots: [] });
    await fetchAoiHostRoots('write');
    expect(writeMock.mock.calls[0][0]).toContain('/write-roots');
  });

  it('fetches process listing with encoded sessionPath and drops bad rows', async () => {
    const fetchMock = mockFetch({
      ok: true,
      listing: {
        version: 1,
        sampledAt: 99,
        records: [
          { pid: 1, imageName: 'ok.exe', memKb: 10 },
          { pid: -1, imageName: 'bad' },
          { pid: 2 },
        ],
        summary: {
          version: 1,
          sampledAt: 99,
          totalCount: 1,
          distinctImageCount: 1,
          topImages: [{ imageName: 'ok.exe', count: 1 }],
        },
      },
    });
    const listing = await fetchAoiHostProcesses('aoi/my session');
    expect(listing.records).toEqual([{ pid: 1, imageName: 'ok.exe', memKb: 10 }]);
    expect(listing.summary.totalCount).toBe(1);
    expect(fetchMock.mock.calls[0][0]).toContain('/processes?sessionPath=aoi%2Fmy%20session');
  });

  it('parses approvals and approves via POST with the fingerprint', async () => {
    mockFetch({
      ok: true,
      approvals: [
        {
          id: 'i',
          capability: 'os_file_write',
          approvalFingerprint: 'fp',
          targetSummary: 'write x',
          state: 'pending',
          expiresAt: 10,
          canExecute: true,
        },
      ],
    });
    const approvals = await fetchAoiHostApprovals();
    expect(approvals[0].approvalFingerprint).toBe('fp');
    expect(approvals[0].canExecute).toBe(true);

    const fetchMock = mockFetch({
      ok: true,
      approved: true,
      alreadyApproved: false,
      canExecute: true,
      note: 'Approved.',
    });
    const approved = await approveAoiHostApproval('fp123');
    expect(approved).toEqual({
      alreadyApproved: false,
      canExecute: true,
      note: 'Approved.',
    });
    const url = fetchMock.mock.calls[0][0] as string;
    const init = fetchMock.mock.calls[0][1] as { body: string };
    expect(url).toContain('/approvals/approve');
    expect(JSON.parse(init.body)).toEqual({ approvalFingerprint: 'fp123' });
  });

  it('posts a browser-drive act preview and parses the approval preview', async () => {
    const fetchMock = mockFetch({
      ok: true,
      preview: {
        capability: 'os_browser_drive',
        approvalFingerprint: 'ff00aa',
        targetSummary: 'click #go on example.com',
        stepIndex: 1,
        hostname: 'example.com',
        finalUrl: 'https://example.com/a',
        expiresAt: 42,
        beforeScreenshotBase64: 'AAAA',
      },
    });
    const plan = { goal: 'g', steps: [{ action: { kind: 'click', selector: '#go' } }] };
    const preview = await fetchAoiHostBrowserDriveActPreview('aoi/default', plan, 1);
    expect(preview.approvalFingerprint).toBe('ff00aa');
    expect(preview.beforeScreenshotBase64).toBe('AAAA');
    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(url).toContain('/browser-drive/preview');
    expect(JSON.parse(init.body)).toEqual({ sessionPath: 'aoi/default', plan, targetStepIndex: 1 });
  });

  it('posts a browser-drive act execute and flattens the target result', async () => {
    mockFetch({
      ok: true,
      result: {
        ok: true,
        stepIndex: 1,
        target: { ok: true, finalUrl: 'https://example.com/done' },
      },
    });
    const view = await runAoiHostBrowserDriveActExecute('aoi/default', { goal: 'g', steps: [] }, 1);
    expect(view.ok).toBe(true);
    expect(view.finalUrl).toBe('https://example.com/done');
  });

  it('throws on an unapproved execute (403 envelope)', async () => {
    mockFetch({ ok: false, error: 'approval_denied' }, false, 403);
    await expect(
      runAoiHostBrowserDriveActExecute('aoi/default', { goal: 'g', steps: [] }, 1),
    ).rejects.toThrow(/approval_denied/);
  });

  it('fetches the audit ledger and flags standing + screenshot', async () => {
    mockFetch({
      ok: true,
      entries: [
        {
          id: 'a1',
          runId: 'run-1',
          stepIndex: 1,
          actionKind: 'click',
          actionSummary: 'click #go',
          category: 'act',
          ok: true,
          viaStanding: true,
          url: 'https://example.com/a',
          recordedAt: 5,
          beforeScreenshotRef: 'run-1/step-1-before.png',
        },
      ],
    });
    const entries = await fetchAoiBrowserDriveAudit();
    expect(entries[0].viaStanding).toBe(true);
    expect(entries[0].hasScreenshot).toBe(true);
    expect(entries[0].category).toBe('act');
  });

  it('runs a bounded task and flattens the result', async () => {
    const fetchMock = mockFetch({
      ok: true,
      result: {
        ok: true,
        goal: 'g',
        stopReason: 'completed',
        actsRun: 2,
        stepsRun: 4,
        results: [
          { index: 0, ok: true, finalUrl: 'https://example.com/1' },
          { index: 1, ok: true },
        ],
      },
    });
    const view = await runAoiHostBrowserDriveTask(
      'aoi/default',
      { owner: 'user', goal: 'g', steps: [] },
      {
        maxActs: 3,
      },
    );
    expect(view.ok).toBe(true);
    expect(view.actsRun).toBe(2);
    expect(view.steps).toHaveLength(2);
    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(url).toContain('/browser-drive/task');
    expect(JSON.parse(init.body)).toMatchObject({ sessionPath: 'aoi/default', maxActs: 3 });
  });

  it('lists, adds, and removes standing grants', async () => {
    mockFetch({
      ok: true,
      grants: [
        {
          id: 'g1',
          domain: 'example.com',
          label: 'Example',
          createdAt: 1,
          expiresAt: 2,
          maxActions: 5,
          usedActions: 1,
        },
      ],
    });
    const listed = await fetchAoiBrowserDriveStandingGrants();
    expect(listed[0].domain).toBe('example.com');
    expect(listed[0].usedActions).toBe(1);

    const addMock = mockFetch({ ok: true, grants: [] });
    await addAoiBrowserDriveStandingGrant({ domain: 'example.com', ttlMs: 60_000, maxActions: 10 });
    const [addUrl, addInit] = addMock.mock.calls[0] as [string, { body: string }];
    expect(addUrl).toContain('/browser-drive/standing-grants');
    expect(JSON.parse(addInit.body)).toEqual({
      domain: 'example.com',
      ttlMs: 60_000,
      maxActions: 10,
    });

    const delMock = mockFetch({ ok: true, grants: [] });
    await removeAoiBrowserDriveStandingGrant('g1');
    const [, delInit] = delMock.mock.calls[0] as [string, { method: string; body: string }];
    expect((delInit as { method: string }).method).toBe('DELETE');
    expect(JSON.parse(delInit.body)).toEqual({ id: 'g1' });
  });
});
