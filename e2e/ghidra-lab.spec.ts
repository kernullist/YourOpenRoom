import { test, expect, type Page, type Route } from '@playwright/test';

const GHIDRA_LAB_APP_ID = 32;
const MOUNT_TIMEOUT_MS = 90_000;

// E2E for Ghidra Lab. The behaviours worth proving in a real browser are the ones
// that keep a real process launch honest:
//
//   - A wrong JDK has to read as a specific, actionable failure. Ghidra answers a
//     missing JDK by prompting on stdin, so a spawned child hangs; the preflight
//     row is the only place the operator finds that out before waiting.
//   - Analyze must not start anything until the approval is clicked.
//   - An approval Aoi recorded from chat has to become clickable here, because
//     that is the only surface where it can be approved.

const BIN_ROOT = 'F:\\games';
const BINARY = 'F:\\games\\client.exe';

interface LabFixture {
  health: Record<string, unknown>;
  sessions: Record<string, unknown>[];
  runs: Record<string, unknown>[];
  approvals: Record<string, unknown>[];
  previewAllowed: boolean;
  previewBlockReasons: string[];
  calls: { method: string; path: string; body: Record<string, unknown> }[];
}

function makeCheck(
  id: string,
  label: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return { id, label, ok: true, found: 'ok', remedy: '', required: true, ...overrides };
}

function makeHealth(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    configured: true,
    config: {
      ghidraInstallDir: 'C:\\ghidra',
      jdkHome: 'C:\\jdk21',
      pythonExePath: 'C:\\venv\\python.exe',
      projectRoot: 'C:\\projects',
      maxMemMb: 4096,
      binaryRoots: [{ id: 'bins', path: BIN_ROOT, label: 'Games' }],
      httpPortStart: 8500,
      httpPortEnd: 8599,
      sessionIdleTimeoutMs: 1_800_000,
      analysisTimeoutMs: 2_700_000,
      capaExePath: '',
      writeEnabled: false,
    },
    checks: [
      makeCheck('ghidra', 'Ghidra install', { found: 'Ghidra 12.1.3' }),
      makeCheck('jdk', 'JDK 21+', { found: 'Java 21' }),
      makeCheck('python', 'pyghidra-mcp', { found: '0.5.0', required: false }),
      makeCheck('projects', 'Project folder', { found: 'C:\\projects' }),
      makeCheck('capa', 'capa (optional)', {
        ok: false,
        found: 'not set',
        remedy: 'Optional.',
        required: false,
      }),
      makeCheck('roots', 'Binary roots', { found: '1 folder' }),
    ],
    availableModes: ['headless', 'batch'],
    ghidraVersion: '12.1.3',
    jdkVersion: 'openjdk version "21.0.4"',
    jdkMajor: 21,
    pyghidraMcpVersion: '0.5.0',
    capaVersion: '',
    analysisCapabilityEnabled: true,
    writeCapabilityEnabled: false,
    autoSessionCapabilityEnabled: false,
    globalPanic: false,
    problems: [],
    ...overrides,
  };
}

function newFixture(healthOverrides: Record<string, unknown> = {}): LabFixture {
  return {
    health: makeHealth(healthOverrides),
    sessions: [],
    runs: [],
    approvals: [],
    previewAllowed: true,
    previewBlockReasons: [],
    calls: [],
  };
}

/**
 * One handler for the whole surface: Playwright matches routes in reverse
 * registration order and several of these paths are prefixes of each other, so
 * dispatching inside is the only way to keep it unambiguous.
 */
async function mockLab(page: Page, fixture: LabFixture): Promise<void> {
  await page.route('**/api/ghidra-lab/**', async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace('/api/ghidra-lab', '');
    const method = request.method();
    let body: Record<string, unknown> = {};
    if (method === 'POST') {
      try {
        body = (request.postDataJSON() ?? {}) as Record<string, unknown>;
      } catch {
        body = {};
      }
    }
    fixture.calls.push({ method, path, body });

    const json = (payload: unknown): Promise<void> =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(payload),
      });

    if (path === '/health' || path === '/') {
      return json({ ok: true, health: fixture.health });
    }
    if (path === '/config') {
      return json({ ok: true, config: (fixture.health as { config: unknown }).config });
    }
    if (path === '/sessions' && method === 'GET') {
      return json({ ok: true, sessions: fixture.sessions });
    }
    if (path === '/sessions' && method === 'DELETE') {
      fixture.sessions = [];
      return json({ ok: true });
    }
    if (path === '/reports' && method === 'GET') {
      return json({ ok: true, runs: fixture.runs });
    }
    if (path === '/reports/artifact') {
      return json({
        ok: true,
        report: '# client.exe -- Binary Analysis Report\n\nEvidence check: 3 cited.',
      });
    }
    if (path === '/approvals') {
      return json({ ok: true, approvals: fixture.approvals });
    }
    if (path === '/browse') {
      const requested = url.searchParams.get('path');
      if (!requested) {
        return json({
          ok: true,
          browse: {
            path: '',
            rootId: '',
            parentPath: '',
            entries: [
              { name: 'Games', path: BIN_ROOT, kind: 'directory', sizeBytes: 0, analyzable: false },
            ],
            truncated: false,
          },
        });
      }
      return json({
        ok: true,
        browse: {
          path: BIN_ROOT,
          rootId: 'bins',
          parentPath: '',
          entries: [
            { name: 'client.exe', path: BINARY, kind: 'file', sizeBytes: 4096, analyzable: true },
            {
              name: 'readme.txt',
              path: `${BIN_ROOT}\\readme.txt`,
              kind: 'file',
              sizeBytes: 12,
              analyzable: false,
            },
          ],
          truncated: false,
        },
      });
    }
    if (path === '/sessions/preview') {
      return json({
        ok: true,
        preview: {
          allowed: fixture.previewAllowed,
          blockReasons: fixture.previewBlockReasons,
          approvalFingerprint: fixture.previewAllowed ? 'f'.repeat(64) : '',
          capability: 'os_ghidra_analysis',
          targetSummary: `Ghidra headless (pyghidra-mcp): ${BINARY}`,
          expiresAt: Date.now() + 300_000,
          autoApproved: false,
          binaryPath: BINARY,
          mode: 'headless',
          write: false,
          program: 'C:\\venv\\python.exe',
          args: [],
        },
      });
    }
    if (path === '/reports/preview') {
      return json({
        ok: true,
        preview: {
          allowed: true,
          blockReasons: [],
          approvalFingerprint: 'e'.repeat(64),
          capability: 'os_ghidra_analysis',
          targetSummary: 'Full sweep + report: client.exe',
          expiresAt: Date.now() + 300_000,
          autoApproved: false,
        },
      });
    }
    if (path === '/approvals/run') {
      const fingerprint = String(body.approvalFingerprint ?? '');
      if (fingerprint.startsWith('e')) {
        fixture.runs = [
          {
            runId: 'grun-1',
            sessionId: 's1',
            binaryPath: BINARY,
            binaryName: 'client.exe',
            state: 'running',
            stages: [
              {
                stage: 'identity',
                state: 'done',
                startedAt: 1,
                finishedAt: 2,
                summary: '',
                detail: '',
              },
              {
                stage: 'imports',
                state: 'running',
                startedAt: 2,
                finishedAt: null,
                summary: '',
                detail: '',
              },
            ],
            startedAt: Date.now(),
            finishedAt: null,
            anchorCount: 5,
            droppedClaims: 0,
            reportPath: '',
            ledgerPath: '',
            failureReason: '',
          },
        ];
        fixture.approvals = [];
        return json({ ok: true, runId: 'grun-1' });
      }
      fixture.sessions = [
        {
          id: 's1',
          binaryPath: BINARY,
          binaryName: 'client.exe',
          projectName: 'client',
          mode: 'headless',
          write: false,
          state: 'ready',
          port: 8500,
          pid: 4242,
          startedAt: Date.now(),
          readyAt: Date.now(),
          lastUsedAt: Date.now(),
          queryCount: 0,
          failureReason: '',
          progress: null,
        },
      ];
      fixture.approvals = [];
      return json({ ok: true, session: fixture.sessions[0] });
    }
    return json({ ok: true });
  });
}

/**
 * Open the app and land on a known tab.
 *
 * The tab is passed explicitly rather than assumed: the app PERSISTS the
 * selected tab to its own state file, and the e2e suite shares one
 * OPENROOM_HOME, so a test that ends on Sessions leaves the next one starting
 * there. Clicking the tab makes each test independent of the order it runs in.
 */
async function openGhidraLab(
  page: Page,
  tab: 'setup' | 'binaries' | 'sessions' | 'reports' = 'setup',
): Promise<void> {
  await page.goto('/');
  await page.getByTestId(`app-icon-${GHIDRA_LAB_APP_ID}`).dblclick();
  await expect(page.getByTestId(`app-window-${GHIDRA_LAB_APP_ID}`)).toBeVisible();
  await page.getByTestId(`window-maximize-${GHIDRA_LAB_APP_ID}`).click();
  const app = page.getByTestId('ghidra-lab');
  await expect(app).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
  // The selected tab and last binary come from state.json; interacting before
  // that read lands is the classic flake in this kind of suite.
  await expect(app).toHaveAttribute('data-hydrated', 'true', { timeout: MOUNT_TIMEOUT_MS });
  await page.getByTestId(`ghidra-lab-tab-${tab}`).click();
}

test.describe('Ghidra Lab', () => {
  // The default 60s per-test budget cannot cover a cold mount.
  //
  // Serial because the whole e2e suite shares one OPENROOM_HOME and this app
  // persists its selected tab, last binary and last run there. Run in parallel,
  // two of these tests write that file at once and one of them ends up looking
  // at a window that re-rendered underneath it.
  test.describe.configure({ timeout: 150_000, mode: 'serial' });

  test('shows every preflight row and reports a ready lab', async ({ page }) => {
    const fixture = newFixture();
    await mockLab(page, fixture);
    await openGhidraLab(page);

    await expect(page.getByTestId('ghidra-lab-status')).toContainText('12.1.3');
    for (const id of ['ghidra', 'jdk', 'python', 'projects', 'capa', 'roots']) {
      await expect(page.getByTestId(`ghidra-check-${id}`)).toBeVisible();
    }
    await expect(page.getByTestId('ghidra-check-jdk')).toContainText('Java 21');
  });

  test('names a wrong JDK instead of calling the lab unconfigured', async ({ page }) => {
    // The real failure mode on a machine with a system JDK 11: everything else is
    // set up, and without this row the operator would wait out an analysis
    // timeout to learn what a preflight knew immediately.
    const fixture = newFixture({
      checks: [
        makeCheck('ghidra', 'Ghidra install', { found: 'Ghidra 12.1.3' }),
        makeCheck('jdk', 'JDK 21+', {
          ok: false,
          found: 'Java 11 (openjdk version "11.0.14")',
          remedy: 'Found Java 11; Ghidra needs JDK 21. Your system JAVA_HOME can stay on 11.',
        }),
        makeCheck('python', 'pyghidra-mcp', { found: '0.5.0', required: false }),
        makeCheck('projects', 'Project folder', { found: 'C:\\projects' }),
        makeCheck('capa', 'capa (optional)', { ok: false, found: 'not set', required: false }),
        makeCheck('roots', 'Binary roots', { found: '1 folder' }),
      ],
      availableModes: [],
      jdkMajor: 11,
      configured: false,
    });
    await mockLab(page, fixture);
    await openGhidraLab(page);

    const jdkRow = page.getByTestId('ghidra-check-jdk');
    await expect(jdkRow).toContainText('Java 11');
    await expect(jdkRow).toContainText('JDK 21');
    await expect(jdkRow).toContainText('JAVA_HOME');
    await expect(page.getByTestId('ghidra-lab-status')).toContainText('Java 11');
  });

  test('analyzing asks for approval and starts nothing on its own', async ({ page }) => {
    const fixture = newFixture();
    await mockLab(page, fixture);
    await openGhidraLab(page, 'binaries');

    // Test ids, not name regexes: /client\.exe/ also matches the
    // "Analyze client.exe" button, which exists as soon as a previous run left a
    // selected binary in state.json -- two matches, and the click lands wherever
    // strict mode does not stop it first.
    await page.getByTestId('ghidra-entry-Games').click();
    await page.getByTestId('ghidra-entry-client.exe').click();
    await page.getByTestId('ghidra-lab-start').click();

    await expect(page.getByTestId('ghidra-lab-approval')).toBeVisible();
    await expect(page.getByTestId('ghidra-lab-approval')).toContainText('client.exe');
    // The preview was recorded; nothing was executed.
    expect(fixture.calls.some((call) => call.path === '/sessions/preview')).toBe(true);
    expect(fixture.calls.some((call) => call.path === '/approvals/run')).toBe(false);
    expect(fixture.sessions).toHaveLength(0);

    await page.getByTestId('ghidra-lab-approve').click();
    await expect(page.getByTestId('ghidra-lab-approval')).toBeHidden();
    expect(fixture.calls.some((call) => call.path === '/approvals/run')).toBe(true);
    await expect(page.getByTestId('ghidra-session-s1')).toBeVisible();
  });

  test('explains a blocked analysis rather than silently doing nothing', async ({ page }) => {
    const fixture = newFixture();
    fixture.previewAllowed = false;
    fixture.previewBlockReasons = ['preflight_jdk'];
    await mockLab(page, fixture);
    await openGhidraLab(page, 'binaries');

    // Test ids, not name regexes: /client\.exe/ also matches the
    // "Analyze client.exe" button, which exists as soon as a previous run left a
    // selected binary in state.json -- two matches, and the click lands wherever
    // strict mode does not stop it first.
    await page.getByTestId('ghidra-entry-Games').click();
    await page.getByTestId('ghidra-entry-client.exe').click();
    await page.getByTestId('ghidra-lab-start').click();

    await expect(page.getByTestId('ghidra-lab-note')).toContainText('JDK');
    await expect(page.getByTestId('ghidra-lab-approval')).toBeHidden();
  });

  test('surfaces an approval Aoi recorded from chat', async ({ page }) => {
    // Aoi's tools record a pending approval server-side. This window is the only
    // place it can be clicked, so it has to find one it did not itself request.
    const fixture = newFixture();
    fixture.approvals = [
      {
        approvalFingerprint: 'f'.repeat(64),
        capability: 'os_ghidra_analysis',
        targetSummary: `Ghidra headless (pyghidra-mcp): ${BINARY}`,
        state: 'pending',
        expiresAt: Date.now() + 300_000,
      },
    ];
    await mockLab(page, fixture);
    await openGhidraLab(page);

    const approval = page.getByTestId('ghidra-lab-approval');
    await expect(approval).toBeVisible();
    await expect(approval).toContainText('client.exe');
    // Still nothing started.
    expect(fixture.calls.some((call) => call.path === '/approvals/run')).toBe(false);

    await page.getByTestId('ghidra-lab-dismiss').click();
    await expect(approval).toBeHidden();
  });

  test('runs a sweep from a ready session and shows its stages', async ({ page }) => {
    const fixture = newFixture();
    fixture.sessions = [
      {
        id: 's1',
        binaryPath: BINARY,
        binaryName: 'client.exe',
        projectName: 'client',
        mode: 'headless',
        write: false,
        state: 'ready',
        port: 8500,
        pid: 4242,
        startedAt: Date.now(),
        readyAt: Date.now(),
        lastUsedAt: Date.now(),
        queryCount: 0,
        failureReason: '',
        progress: null,
      },
    ];
    await mockLab(page, fixture);
    await openGhidraLab(page, 'sessions');

    await page.getByTestId('ghidra-session-s1').click();
    await page.getByTestId('ghidra-lab-sweep').click();

    await expect(page.getByTestId('ghidra-lab-approval')).toContainText('Full sweep');
    await expect(page.getByTestId('ghidra-lab-approval')).toContainText('many minutes');
    await page.getByTestId('ghidra-lab-approve').click();

    // Starting a sweep lands on the run, but a run that just started has no
    // report yet -- the report is fetched when the operator opens the run.
    const run = page.getByTestId('ghidra-run-grun-1');
    await expect(run).toBeVisible();
    await expect(run).toContainText('Sweeping');
    await expect(page.getByTestId('ghidra-lab-report')).toBeHidden();

    await run.click();
    await expect(page.getByTestId('ghidra-lab-report')).toContainText('Binary Analysis Report');
  });

  test('says what a starting session is waiting on', async ({ page }) => {
    const fixture = newFixture();
    fixture.sessions = [
      {
        id: 's1',
        binaryPath: BINARY,
        binaryName: 'client.exe',
        projectName: 'client',
        mode: 'headless',
        write: false,
        state: 'starting',
        port: 8500,
        pid: 4242,
        startedAt: Date.now() - 60_000,
        readyAt: null,
        lastUsedAt: Date.now(),
        queryCount: 0,
        failureReason: '',
        progress: {
          phase: 'jvm',
          projectBytes: 0,
          deltaBytes: 0,
          sampledAt: Date.now(),
          sampleCount: 2,
        },
      },
    ];
    await mockLab(page, fixture);
    await openGhidraLab(page, 'sessions');

    await expect(page.getByTestId('ghidra-session-s1')).toContainText('Booting the JVM');
    await page.getByTestId('ghidra-session-s1').click();
    // The sweep button must stay unavailable until the session is ready.
    await expect(page.getByTestId('ghidra-lab-sweep')).toBeDisabled();
  });
});
