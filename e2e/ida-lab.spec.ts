import { test, expect, type Page, type Route } from '@playwright/test';

const IDA_LAB_APP_ID = 31;

// E2E for IDA Lab. The behaviors worth proving in a browser are the ones that
// keep a real process launch and a database write honest: Analyze must not start
// anything until the approval is clicked, a mutating statement must not reach
// idasql until it is approved, a host escape must be refused outright, and a
// capability that is off has to read as setup rather than as a failure.

interface LabFixture {
  /** Bodies the mock server answers with; tests mutate these. */
  health: Record<string, unknown>;
  sessions: Record<string, unknown>[];
  /** Every request the app made, so a test can assert nothing was started. */
  calls: { method: string; path: string; body: Record<string, unknown> }[];
  /**
   * Mode of the last preview, so approvals/run can answer the way the real route
   * does -- headless returns a session, GUI returns a pid and a command.
   *
   * Recorded rather than encoded in the fingerprint: the app PERSISTS its mode to
   * its own state file, and the e2e suite shares one OPENROOM_HOME, so a test
   * that switches to GUI leaves the next test starting there. Keying off what was
   * actually previewed makes the mock independent of test order.
   */
  lastPreviewMode: string;
  /** How many times the UI asked where the IDA window went. */
  guiWindowAsks: number;
  /** Make attach refuse an unidentified server until a human declares the port. */
  attachRefusesUntilDeclared: boolean;
}

const BIN_ROOT = 'F:\\games';
const BINARY = 'F:\\games\\client.exe';

function makeHealth(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    configured: true,
    config: {
      idaExePath: 'C:\\ida\\ida.exe',
      idasqlExePath: 'C:\\ida\\idasql.exe',
      defaultMode: 'headless',
      binaryRoots: [{ id: 'bins', path: BIN_ROOT, label: 'Games' }],
      httpPortStart: 8300,
      httpPortEnd: 8399,
      sessionIdleTimeoutMs: 1_800_000,
      writeEnabled: true,
    },
    idasqlPresent: true,
    idasqlVersion: 'idasql 1.2.0',
    idaSqlPluginPath:
      'C:\\Users\\me\\AppData\\Roaming\\Hex-Rays\\IDA Pro\\plugins\\idasql\\idasql.dll',
    idaExePresent: true,
    idalibPresent: true,
    analysisCapabilityEnabled: true,
    writeCapabilityEnabled: true,
    autoSessionCapabilityEnabled: false,
    globalPanic: false,
    problems: [],
    ...overrides,
  };
}

function makeSession(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ida-1',
    binaryPath: BINARY,
    binaryName: 'client.exe',
    mode: 'headless',
    write: false,
    state: 'ready',
    port: 8300,
    pid: 4242,
    startedAt: Date.now(),
    readyAt: Date.now(),
    lastUsedAt: Date.now(),
    queryCount: 0,
    failureReason: '',
    unreviewedFunctions: [],
    progress: null,
    ...overrides,
  };
}

/**
 * One handler for the whole surface: Playwright matches routes in reverse
 * registration order, and several of these paths are prefixes of each other, so
 * dispatching inside is the only way to keep it unambiguous.
 */
async function mockLab(page: Page, fixture: LabFixture): Promise<void> {
  await page.route('**/api/ida-sql/**', async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace('/api/ida-sql', '');
    const method = request.method();
    let body: Record<string, unknown> = {};
    if (method === 'POST') {
      try {
        body = (request.postDataJSON() ?? {}) as Record<string, unknown>;
      } catch {
        body = {};
      }
    } else {
      body = Object.fromEntries(url.searchParams.entries());
    }
    fixture.calls.push({ method, path, body });

    if (path === '/health') {
      await route.fulfill({ json: { ok: true, health: fixture.health } });
      return;
    }
    if (path === '/config' && method === 'GET') {
      await route.fulfill({ json: { ok: true, config: fixture.health.config } });
      return;
    }
    if (path === '/grants') {
      await route.fulfill({ json: { ok: true, grants: [] } });
      return;
    }
    if (path === '/sessions' && method === 'GET') {
      // Stamp the progress reading at request time, the way the real server
      // does: it samples on its readiness poll, so what the page receives is
      // always a fresh measurement. A fixture with a frozen sampledAt goes stale
      // during page load and the panel correctly refuses to call it growth --
      // which would make this a test of the staleness path, not the live one.
      await route.fulfill({
        json: {
          ok: true,
          sessions: fixture.sessions.map((session) =>
            session.progress
              ? {
                  ...session,
                  progress: { ...(session.progress as object), sampledAt: Date.now() },
                }
              : session,
          ),
        },
      });
      return;
    }
    if (path === '/browse') {
      const requested = String(body.path ?? '');
      if (!requested) {
        await route.fulfill({
          json: {
            ok: true,
            browse: {
              path: '',
              rootId: '',
              parentPath: '',
              truncated: false,
              entries: [
                {
                  name: 'Games',
                  path: BIN_ROOT,
                  kind: 'directory',
                  sizeBytes: 0,
                  analyzable: false,
                },
              ],
            },
          },
        });
        return;
      }
      await route.fulfill({
        json: {
          ok: true,
          browse: {
            path: BIN_ROOT,
            rootId: 'bins',
            parentPath: '',
            truncated: false,
            entries: [
              { name: 'client.exe', path: BINARY, kind: 'file', sizeBytes: 2048, analyzable: true },
              {
                name: 'readme.txt',
                path: 'F:\\games\\readme.txt',
                kind: 'file',
                sizeBytes: 12,
                analyzable: false,
              },
            ],
          },
        },
      });
      return;
    }
    if (path === '/sessions/preview') {
      fixture.lastPreviewMode = String(body.mode ?? 'headless');
      await route.fulfill({
        json: {
          ok: true,
          preview: {
            allowed: true,
            blockReasons: [],
            // A distinct fingerprint per mode, so the approvals/run mock can
            // answer the way the real route does: a headless run returns a
            // session, a GUI run returns a pid and a command to type.
            approvalFingerprint:
              String(body.mode ?? 'headless') === 'gui' ? `g${'0'.repeat(63)}` : 'f'.repeat(64),
            capability: 'os_ida_analysis',
            targetSummary:
              String(body.mode ?? 'headless') === 'gui'
                ? `IDA GUI: ${BINARY}`
                : `idasql headless: ${BINARY}`,
            expiresAt: Date.now() + 300_000,
            autoApproved: false,
            binaryPath: BINARY,
            mode: String(body.mode ?? 'headless'),
            write: false,
            program:
              String(body.mode ?? 'headless') === 'gui'
                ? 'C:\\ida\\ida.exe'
                : 'C:\\ida\\idasql.exe',
            args: [],
          },
        },
      });
      return;
    }
    if (path === '/approvals/run') {
      const fingerprint = String(body.approvalFingerprint ?? '');
      if (fingerprint.startsWith('w')) {
        await route.fulfill({
          json: {
            ok: true,
            query: {
              sessionId: 'ida-1',
              statementClass: 'write',
              statements: [],
              resultSets: [],
              elapsedMs: 12,
              engineError: '',
            },
          },
        });
        return;
      }
      if (fixture.lastPreviewMode === 'gui') {
        // GUI mode: no session yet, a launched pid and the line to type.
        await route.fulfill({
          json: {
            ok: true,
            launchedPid: 4242,
            session: null,
            guiStartCommand: '.http start 127.0.0.1 8100 --token abc123def456',
            guiSuggestedPort: 8100,
            guiSuggestedToken: 'abc123def456',
            // Matches the real route: at reply time IDA has not drawn a window
            // yet, so there are no coordinates here. They arrive from
            // /gui-window once the launch's own measurement settles.
            detail:
              'IDA is opening as PID 4242. Its window opens BEHIND this one -- Windows does not let a background launcher take the foreground -- and it may land on another monitor, so watch for its taskbar button flashing in a few seconds.',
          },
        });
        return;
      }
      fixture.sessions = [makeSession()];
      await route.fulfill({ json: { ok: true, session: fixture.sessions[0] } });
      return;
    }
    if (path === '/sessions/attach') {
      // Mirrors the real refusal: something answered on the port but did not
      // identify itself as idasql, so NO SQL was sent to it. Only an explicit
      // human declaration gets past that.
      if (fixture.attachRefusesUntilDeclared && body.portDeclared !== true) {
        await route.fulfill({ status: 409, json: { ok: false, error: 'gui_server_unrecognized' } });
        return;
      }
      fixture.sessions = [makeSession({ id: 'ida-gui', mode: 'gui', port: 8100 })];
      await route.fulfill({ json: { ok: true, session: fixture.sessions[0] } });
      return;
    }
    if (path === '/gui-window') {
      // Null on the first ask and a location afterwards: the server fires one
      // measurement that waits ~3s for IDA to draw, so the UI polls.
      fixture.guiWindowAsks += 1;
      if (fixture.guiWindowAsks < 2) {
        await route.fulfill({ json: { ok: true, window: null, detail: '' } });
        return;
      }
      await route.fulfill({
        json: {
          ok: true,
          window: { found: true, flashed: true, left: 3645, top: 667, offPrimaryMonitor: true },
          detail:
            'Its taskbar button is flashing and it opened on another monitor at 3645,667. Windows does not let a background launcher take the foreground, so it will not come to the front on its own -- click the taskbar button or Alt+Tab to it.',
        },
      });
      return;
    }
    if (path === '/session-output') {
      await route.fulfill({
        json: { ok: true, output: 'usage: idasql [options]\nunrecognized option --http' },
      });
      return;
    }
    if (path === '/query') {
      const sql = String(body.sql ?? '');
      if (/attach/i.test(sql)) {
        await route.fulfill({
          status: 403,
          json: {
            ok: false,
            error: 'forbidden_statement',
            detail: 'refused: attach_database',
          },
        });
        return;
      }
      if (/^\s*update/i.test(sql)) {
        await route.fulfill({
          json: {
            ok: true,
            needsApproval: true,
            preview: {
              allowed: true,
              blockReasons: [],
              approvalFingerprint: `w${'0'.repeat(63)}`,
              capability: 'os_ida_write',
              targetSummary: 'IDASQL write on client.exe',
              expiresAt: Date.now() + 300_000,
              autoApproved: false,
              sessionId: 'ida-1',
              sql,
              statements: [],
            },
          },
        });
        return;
      }
      await route.fulfill({
        json: {
          ok: true,
          query: {
            sessionId: 'ida-1',
            statementClass: 'read',
            statements: [],
            resultSets: [
              {
                columns: ['name', 'start_ea'],
                rows: [
                  ['sub_401000', '4198400'],
                  ['decrypt_blob', '4198656'],
                ],
                rowCount: 2,
                truncated: false,
              },
            ],
            elapsedMs: 7,
            engineError: '',
          },
        },
      });
      return;
    }
    await route.fulfill({ json: { ok: true } });
  });
}

// The route is lazily imported, so the FIRST mount in a run also pays for Vite
// transforming this app's module graph. Under the full suite (many workers
// hitting a cold dev server) that first mount measured past 30s, which is a
// compile wait, not app behavior -- hence the longer ceiling here than the
// 30s other app specs use.
const MOUNT_TIMEOUT_MS = 90_000;

async function openIdaLab(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId(`app-icon-${IDA_LAB_APP_ID}`).dblclick();
  await expect(page.getByTestId(`app-window-${IDA_LAB_APP_ID}`)).toBeVisible();
  await page.getByTestId(`window-maximize-${IDA_LAB_APP_ID}`).click();
  const app = page.getByTestId('ida-lab');
  await expect(app).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
  // The SQL draft and the last binary come from state.json; typing before that
  // write lands is the classic flake in this suite.
  await expect(app).toHaveAttribute('data-hydrated', 'true', { timeout: MOUNT_TIMEOUT_MS });
}

function newFixture(overrides: Record<string, unknown> = {}): LabFixture {
  return {
    health: makeHealth(overrides),
    sessions: [],
    calls: [],
    lastPreviewMode: 'headless',
    guiWindowAsks: 0,
    attachRefusesUntilDeclared: false,
  };
}

test.describe('IDA Lab', () => {
  // The default 60s per-test budget cannot cover a 90s cold mount, so the mount
  // ceiling above would be unreachable without this.
  test.describe.configure({ timeout: 150_000 });

  test('reports readiness with the probed idasql version', async ({ page }) => {
    const fixture = newFixture();
    await mockLab(page, fixture);
    await openIdaLab(page);

    await expect(page.getByTestId('ida-lab-status')).toContainText('idasql 1.2.0', {
      timeout: 15_000,
    });
  });

  test('reads a disabled capability as setup, naming where to enable it', async ({ page }) => {
    const fixture = newFixture({ analysisCapabilityEnabled: false });
    await mockLab(page, fixture);
    await openIdaLab(page);

    const status = page.getByTestId('ida-lab-status');
    await expect(status).toContainText('capability is off', { timeout: 15_000 });
    await expect(page.getByTestId('ida-lab')).toContainText('Settings > Advanced > Host PC');
  });

  test('browses from the roots into a folder and selects a binary', async ({ page }) => {
    const fixture = newFixture();
    await mockLab(page, fixture);
    await openIdaLab(page);

    const entries = page.getByTestId('ida-lab-entries');
    await expect(entries).toContainText('Games', { timeout: 15_000 });
    await entries.getByRole('button', { name: /Games/ }).click();
    await expect(entries).toContainText('client.exe');
    await entries.getByRole('button', { name: /client\.exe/ }).click();
    await expect(page.getByTestId('ida-lab-selected')).toContainText('client.exe');
  });

  test('Analyze proposes and starts nothing until the approval is clicked', async ({ page }) => {
    const fixture = newFixture();
    await mockLab(page, fixture);
    await openIdaLab(page);

    // Named explicitly: the app persists its mode and the suite shares one home,
    // so inheriting whatever the previous test left is not isolation.
    await page.getByTestId('ida-lab-mode').selectOption('headless');
    const entries = page.getByTestId('ida-lab-entries');
    await expect(entries).toContainText('Games', { timeout: 15_000 });
    await entries.getByRole('button', { name: /Games/ }).click();
    await entries.getByRole('button', { name: /client\.exe/ }).click();
    await page.getByTestId('ida-lab-analyze').click();

    const confirm = page.getByTestId('ida-lab-session-confirm');
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText('client.exe');
    // Proposing must not have run anything.
    expect(fixture.calls.filter((call) => call.path === '/approvals/run')).toHaveLength(0);
    await expect(page.getByTestId('ida-lab-sessions')).toContainText('No sessions.');

    await page.getByTestId('ida-lab-session-approve').click();
    await expect(page.getByTestId('ida-lab-sessions')).toContainText('client.exe', {
      timeout: 15_000,
    });
    expect(fixture.calls.filter((call) => call.path === '/approvals/run')).toHaveLength(1);
  });

  test('runs a read query and shows the rows', async ({ page }) => {
    const fixture = newFixture();
    fixture.sessions = [makeSession()];
    await mockLab(page, fixture);
    await openIdaLab(page);

    await expect(page.getByTestId('ida-lab-sessions')).toContainText('client.exe', {
      timeout: 15_000,
    });
    await page.getByTestId('ida-lab-sql').fill('SELECT name, start_ea FROM funcs LIMIT 2');
    await expect(page.getByTestId('ida-lab-sql-class')).toHaveText('read');
    await page.getByTestId('ida-lab-run-sql').click();

    const results = page.getByTestId('ida-lab-results');
    await expect(results).toBeVisible({ timeout: 15_000 });
    await expect(results).toContainText('decrypt_blob');
  });

  test('a write query is held for approval and only then reaches the engine', async ({ page }) => {
    const fixture = newFixture();
    fixture.sessions = [makeSession({ write: true })];
    await mockLab(page, fixture);
    await openIdaLab(page);

    await expect(page.getByTestId('ida-lab-sessions')).toContainText('client.exe', {
      timeout: 15_000,
    });
    await page
      .getByTestId('ida-lab-sql')
      .fill("UPDATE funcs SET name = 'decrypt_blob' WHERE start_ea = 4198656");
    await expect(page.getByTestId('ida-lab-sql-class')).toHaveText('write');
    await page.getByTestId('ida-lab-run-sql').click();

    const confirm = page.getByTestId('ida-lab-write-confirm');
    await expect(confirm).toBeVisible({ timeout: 15_000 });
    // The operator sees the exact SQL before deciding.
    await expect(confirm).toContainText('decrypt_blob');
    expect(fixture.calls.filter((call) => call.path === '/approvals/run')).toHaveLength(0);

    await page.getByTestId('ida-lab-write-approve').click();
    await expect(page.getByTestId('ida-lab-note')).toContainText('Write applied', {
      timeout: 15_000,
    });
    expect(fixture.calls.filter((call) => call.path === '/approvals/run')).toHaveLength(1);
  });

  test('an empty answer does not look like a broken one', async ({ page }) => {
    const fixture = newFixture();
    fixture.sessions = [makeSession()];
    await mockLab(page, fixture);
    // A query that matched nothing, and then one that returned no result set at
    // all -- the shape a write answers with.
    await page.route('**/api/ida-sql/query**', async (route: Route) => {
      const sql = String((route.request().postDataJSON() as { sql?: string })?.sql ?? '');
      await route.fulfill({
        json: {
          ok: true,
          query: {
            sessionId: 'ida-1',
            statementClass: 'read',
            statements: [],
            resultSets: /nomatch/.test(sql)
              ? [{ columns: ['name'], rows: [], rowCount: 0, truncated: false }]
              : [],
            elapsedMs: 3,
            engineError: '',
          },
        },
      });
    });
    await openIdaLab(page);
    await expect(page.getByTestId('ida-lab-sessions')).toContainText('client.exe', {
      timeout: 15_000,
    });

    await page.getByTestId('ida-lab-sql').fill("SELECT name FROM funcs WHERE name = 'nomatch'");
    await page.getByTestId('ida-lab-run-sql').click();
    await expect(page.getByTestId('ida-lab-zero-rows')).toContainText('0 rows', {
      timeout: 15_000,
    });

    await page.getByTestId('ida-lab-sql').fill('SELECT 1');
    await page.getByTestId('ida-lab-run-sql').click();
    await expect(page.getByTestId('ida-lab-no-result-set')).toContainText('no result set', {
      timeout: 15_000,
    });
  });

  test('a host escape is refused and reported, not silently dropped', async ({ page }) => {
    const fixture = newFixture();
    fixture.sessions = [makeSession()];
    await mockLab(page, fixture);
    await openIdaLab(page);

    await expect(page.getByTestId('ida-lab-sessions')).toContainText('client.exe', {
      timeout: 15_000,
    });
    await page.getByTestId('ida-lab-sql').fill("ATTACH DATABASE 'x.db' AS x");
    await expect(page.getByTestId('ida-lab-sql-class')).toHaveText('forbidden');
    await page.getByTestId('ida-lab-run-sql').click();

    await expect(page.getByTestId('ida-lab-note')).toContainText('forbidden_statement', {
      timeout: 15_000,
    });
    await expect(page.getByTestId('ida-lab-results')).toHaveCount(0);
  });

  test('says so when the installed idasql exposes unreviewed functions', async ({ page }) => {
    // Non-empty means the classification was written against an older build.
    // Nothing is unguarded (those statements become writes), but a stale review
    // is exactly the kind of thing that should not be silent.
    const fixture = newFixture();
    fixture.sessions = [makeSession({ unreviewedFunctions: ['wipe_database', 'exec_thing'] })];
    await mockLab(page, fixture);
    await openIdaLab(page);

    const warning = page.getByTestId('ida-lab-unreviewed');
    await expect(warning).toBeVisible({ timeout: 15_000 });
    await expect(warning).toContainText('has not reviewed');
    await expect(warning).toContainText('wipe_database');
    // And it does not pretend the session is broken.
    await expect(page.getByTestId('ida-lab-run-sql')).toBeEnabled();
  });

  test('a failed session offers idasql own output as the diagnostic', async ({ page }) => {
    // The most likely first-run failure is a CLI-flag or licence problem, and
    // idasql's stdout is the only thing that says which. It has to be reachable
    // from the window, not just from the API.
    const fixture = newFixture();
    fixture.sessions = [
      makeSession({ state: 'failed', failureReason: 'exited (code=1, signal=null)' }),
    ];
    await mockLab(page, fixture);
    await openIdaLab(page);

    await expect(page.getByTestId('ida-lab-sessions')).toContainText('failed', {
      timeout: 15_000,
    });
    const failure = page.getByTestId('ida-lab-failure');
    await expect(failure).toBeVisible();
    await expect(failure).toContainText('exited (code=1');
    // Running SQL against it is not offered.
    await expect(page.getByTestId('ida-lab-run-sql')).toBeDisabled();

    await page.getByTestId('ida-lab-show-output').click();
    await expect(page.getByTestId('ida-lab-output')).toContainText('unrecognized option --http', {
      timeout: 15_000,
    });
  });

  test('a running analysis reports what can be observed, and no percentage', async ({ page }) => {
    // idasql emits nothing while it works and exposes no verbosity flag
    // (measured against a real install), so time and the database growing on
    // disk are the only evidence there is. The operator was previously left
    // staring at the word "analyzing" for twenty minutes with no way to tell a
    // working session from a wedged one.
    const fixture = newFixture();
    fixture.sessions = [
      makeSession({
        state: 'starting',
        readyAt: null,
        startedAt: Date.now() - 185_000,
        progress: {
          databaseBytes: 125_000_000,
          deltaBytes: 4_400_000,
          sampledAt: Date.now(),
          sampleCount: 6,
        },
      }),
    ];
    await mockLab(page, fixture);
    await openIdaLab(page);

    const progress = page.getByTestId('ida-lab-progress');
    await expect(progress).toBeVisible({ timeout: 15_000 });
    await expect(progress).toContainText('Analyzing');
    // Elapsed is wall-clock from a fixture built before the page loaded, so
    // assert its SHAPE, not a value that drifts with how long the mount took.
    await expect(progress).toContainText(/\dm \d\ds/);
    await expect(progress).toContainText('119 MB');
    await expect(progress).toContainText('+4.2 MB');
    await expect(page.getByTestId('ida-lab-progress-detail')).toContainText('no percentage');
    // The guarantee, asserted rather than assumed: nothing here claims a share
    // of a total that IDA never reports.
    await expect(progress).not.toContainText('%');
  });

  test('a stalled analysis says so instead of repeating the last number', async ({ page }) => {
    const fixture = newFixture();
    fixture.sessions = [
      makeSession({
        state: 'starting',
        readyAt: null,
        startedAt: Date.now() - 60_000,
        progress: {
          databaseBytes: 125_000_000,
          deltaBytes: 0,
          sampledAt: Date.now(),
          sampleCount: 9,
        },
      }),
    ];
    await mockLab(page, fixture);
    await openIdaLab(page);

    await expect(page.getByTestId('ida-lab-progress-detail')).toContainText('has not grown', {
      timeout: 15_000,
    });
  });

  test('GUI mode hands over the exact command, because a bare .http start cannot work', async ({
    page,
  }) => {
    // Measured against the real plugin: `.http start` with no arguments binds
    // "127.0.0.1, random port, no auth". So the old advice produced a server on
    // a port the 8100-8199 probe could not find, with nothing protecting it.
    const fixture = newFixture();
    await mockLab(page, fixture);
    await openIdaLab(page);

    await page.getByTestId('ida-lab-mode').selectOption('gui');
    const entries = page.getByTestId('ida-lab-entries');
    await expect(entries).toContainText('Games', { timeout: 15_000 });
    await entries.getByRole('button', { name: /Games/ }).click();
    await entries.getByRole('button', { name: /client\.exe/ }).click();
    await page.getByTestId('ida-lab-analyze').click();
    await page.getByTestId('ida-lab-session-approve').click();

    const handoff = page.getByTestId('ida-lab-gui-handoff');
    await expect(handoff).toBeVisible({ timeout: 15_000 });
    // The line has a port AND a token on it, both named.
    const command = page.getByTestId('ida-lab-gui-command');
    await expect(command).toContainText('.http start 127.0.0.1 8100');
    await expect(command).toContainText('--token');
    // The immediate reply explains why the window is not in front, without
    // inventing a position -- IDA has not drawn one yet at that point.
    const immediate = page.getByTestId('ida-lab-gui-handoff-detail');
    await expect(immediate).toContainText('opens BEHIND');
    await expect(immediate).not.toContainText(',667');
    await expect(handoff).toContainText('random port');

    // The position arrives from /gui-window, which answers null until the
    // server-side measurement has waited out IDA's ~3s to draw a window.
    await expect(page.getByTestId('ida-lab-gui-window-where')).toContainText('3645,667', {
      timeout: 20_000,
    });
    await expect(page.getByTestId('ida-lab-gui-window-where')).toContainText('another monitor');
    // Asked more than once, because the first answer was empty.
    expect(fixture.guiWindowAsks).toBeGreaterThan(1);
    // ...and never claims it raised the window, because it cannot.
    await expect(page.getByTestId('ida-lab-gui-window-where')).toContainText(
      'does not let a background launcher take the foreground',
    );

    // It persists rather than vanishing like a toast -- the operator has to
    // retype it into another program.
    await expect(handoff).toBeVisible();

    await page.getByTestId('ida-lab-dismiss-handoff').click();
    await expect(handoff).toHaveCount(0);
  });

  test('attaching after the handoff uses the port and token that were handed out', async ({
    page,
  }) => {
    const fixture = newFixture();
    await mockLab(page, fixture);
    await openIdaLab(page);

    await page.getByTestId('ida-lab-mode').selectOption('gui');
    const entries = page.getByTestId('ida-lab-entries');
    await expect(entries).toContainText('Games', { timeout: 15_000 });
    await entries.getByRole('button', { name: /Games/ }).click();
    await entries.getByRole('button', { name: /client\.exe/ }).click();
    await page.getByTestId('ida-lab-analyze').click();
    await page.getByTestId('ida-lab-session-approve').click();
    await expect(page.getByTestId('ida-lab-gui-handoff')).toBeVisible({ timeout: 15_000 });

    await page.getByTestId('ida-lab-attach-after-handoff').click();
    await expect
      .poll(() => fixture.calls.filter((call) => call.path === '/sessions/attach').length, {
        timeout: 15_000,
      })
      .toBeGreaterThan(0);
    const attach = fixture.calls.find((call) => call.path === '/sessions/attach');
    // Blind probing was never going to find a random port. These have to travel.
    expect(attach?.body?.port).toBe(8100);
    expect(attach?.body?.token).toBe('abc123def456');
  });

  test('an unidentified server on the port is refused, and only a human can wave it through', async ({
    page,
  }) => {
    // The identity check exists because attaching to the wrong local service
    // means posting SQL to it. It used to be skipped for any port passed as a
    // hint -- which became every port once the app started SUGGESTING one. The
    // override is a person saying they can see it is their IDA.
    const fixture = newFixture();
    fixture.attachRefusesUntilDeclared = true;
    await mockLab(page, fixture);
    await openIdaLab(page);

    await page.getByTestId('ida-lab-mode').selectOption('gui');
    const entries = page.getByTestId('ida-lab-entries');
    await expect(entries).toContainText('Games', { timeout: 15_000 });
    await entries.getByRole('button', { name: /Games/ }).click();
    await entries.getByRole('button', { name: /client\.exe/ }).click();
    await page.getByTestId('ida-lab-analyze').click();
    await page.getByTestId('ida-lab-session-approve').click();
    await expect(page.getByTestId('ida-lab-gui-handoff')).toBeVisible({ timeout: 15_000 });

    // The override is NOT offered before the refusal has happened.
    await expect(page.getByTestId('ida-lab-declare-port')).toHaveCount(0);

    await page.getByTestId('ida-lab-attach-after-handoff').click();
    await expect(page.getByTestId('ida-lab-note')).toContainText('did not identify itself', {
      timeout: 15_000,
    });
    // No session was created from the unidentified server.
    await expect(page.getByTestId('ida-lab-sessions')).toContainText('No sessions.');

    // Now it is offered, and it carries the declaration.
    const declare = page.getByTestId('ida-lab-declare-port');
    await expect(declare).toBeVisible();
    await declare.click();
    await expect(page.getByTestId('ida-lab-sessions')).toContainText('client.exe', {
      timeout: 15_000,
    });
    const declaredCall = fixture.calls.filter((call) => call.path === '/sessions/attach').at(-1);
    expect(declaredCall?.body?.portDeclared).toBe(true);
  });

  test('the setup view shows the paths and the diagnostics', async ({ page }) => {
    const fixture = newFixture();
    await mockLab(page, fixture);
    await openIdaLab(page);

    await page.getByTestId('ida-lab-setup-toggle').click();
    const setup = page.getByTestId('ida-lab-setup');
    await expect(setup).toBeVisible();
    await expect(setup.getByTestId('ida-lab-idasql-path')).toHaveValue('C:\\ida\\idasql.exe');
    await expect(setup).toContainText('Binary roots');
    await expect(setup).toContainText('Games');
    await expect(setup).toContainText('idalib');
  });
});
