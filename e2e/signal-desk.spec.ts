import { test, expect, type Page } from '@playwright/test';

const SIGNAL_DESK_APP_ID = 30;

// E2E for Signal Desk. The behaviors worth proving in a browser are the honest
// ones: a failed source that never renders as an empty feed, interest
// weighting that states why it did not apply, a missing collector that reads
// as setup rather than failure, and a research handoff that reports the
// guard's refusal distinctly from an error.
//
// state.json persists across the suite's shared isolated home, so every test
// sets its own view, filter, and session explicitly before asserting.

const NOW = Date.now();

const OK_SOURCES = [
  {
    sourceId: 'cisa-kev',
    name: 'CISA KEV',
    kind: 'kev-json',
    category: 'vuln',
    ok: true,
    itemCount: 1,
    ms: 120,
  },
  {
    sourceId: 'secret-club',
    name: 'secret club',
    kind: 'rss',
    category: 'research',
    ok: true,
    itemCount: 1,
    ms: 90,
  },
];

const ITEMS = [
  {
    id: 'sig-vuln',
    title: 'CVE-2026-1111: Windows Kernel Privilege Escalation',
    url: 'https://nvd.nist.gov/vuln/detail/CVE-2026-1111',
    summary: 'LPE in win32k, actively exploited.',
    sourceId: 'cisa-kev',
    sourceName: 'CISA KEV',
    category: 'vuln',
    publishedAt: new Date(NOW - 3_600_000).toISOString(),
    score: 73,
    scoreReasons: ['KEV 등재(실제 악용)', '1시간 내 신규'],
    cveIds: ['CVE-2026-1111'],
    kev: true,
    duplicateCount: 1,
    otherSources: ['MSRC Update Guide'],
  },
  {
    id: 'sig-blog',
    title: 'EPT hooking detection notes',
    url: 'https://secret.club/ept-hooks',
    summary: 'Hypervisor-based detection.',
    sourceId: 'secret-club',
    sourceName: 'secret club',
    category: 'research',
    publishedAt: new Date(NOW - 7_200_000).toISOString(),
    score: 41,
    scoreReasons: ['2시간 내 신규'],
    cveIds: [],
    kev: false,
    duplicateCount: 0,
    otherSources: [],
  },
];

function signalsPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    fetchedAt: NOW,
    cache: 'fresh',
    sources: OK_SOURCES,
    items: ITEMS,
    interest: { applied: false, keywordCount: 0, reason: 'no-profile' },
    ...overrides,
  };
}

const BRIEF_PAYLOAD = {
  ok: true,
  cache: 'fresh',
  brief: {
    version: 1,
    date: '2099-01-01',
    generatedAt: NOW,
    headline: '신호 2건 · KEV 1건 · 소스 2/2 정상',
    caveats: ['관심 가중치 미적용 — 기본 우선순위 · 관심 프로파일 없음'],
    sections: [
      {
        category: 'vuln',
        title: '취약점 / KEV',
        items: [ITEMS[0]],
      },
    ],
    interest: { applied: false, keywordCount: 0, reason: 'no-profile' },
  },
  sources: OK_SOURCES,
};

async function stubSignals(page: Page, payload: Record<string, unknown>): Promise<void> {
  await page.route('**/api/signal-desk/signals**', (route) => route.fulfill({ json: payload }));
}

async function stubBrief(page: Page): Promise<void> {
  await page.route('**/api/signal-desk/brief**', (route) => route.fulfill({ json: BRIEF_PAYLOAD }));
}

async function openSignalDesk(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId(`app-icon-${SIGNAL_DESK_APP_ID}`).dblclick();
  await expect(page.getByTestId(`app-window-${SIGNAL_DESK_APP_ID}`)).toBeVisible();
  await page.getByTestId(`window-maximize-${SIGNAL_DESK_APP_ID}`).click();
  await expect(page.getByTestId('signal-desk')).toBeVisible({ timeout: 30_000 });
}

/** Explicit baseline: inbox view, all category — never inherited state. */
async function resetToInbox(page: Page): Promise<void> {
  await page.getByTestId('signal-desk-rail-inbox').click();
  await page.getByTestId('signal-desk-chip-all').click();
}

test.describe('Signal Desk', () => {
  test('shows prioritized signals with reasons, badges, and honest ranking meta', async ({
    page,
  }) => {
    await stubSignals(page, signalsPayload());
    await openSignalDesk(page);
    await resetToInbox(page);

    const row = page.getByTestId('signal-desk-row-sig-vuln');
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row).toContainText('CVE-2026-1111');
    await expect(row).toContainText('KEV');

    // Interest honesty: not applied is stated with its reason, in the header.
    await expect(page.getByTestId('signal-desk-meta')).toContainText('관심 프로파일 없음');

    // The stat band reflects the snapshot: 2 signals, 2/2 sources ok.
    await expect(page.getByTestId('signal-desk-stats')).toContainText('2/2');

    await row.locator('button').first().click();
    const expand = page.getByTestId('signal-desk-expand-sig-vuln');
    await expect(expand).toBeVisible();
    await expect(expand).toContainText('KEV 등재(실제 악용)');
    await expect(expand).toContainText('중복 출처: MSRC Update Guide');
  });

  test('filters by category chips', async ({ page }) => {
    await stubSignals(page, signalsPayload());
    await openSignalDesk(page);
    await resetToInbox(page);
    await expect(page.getByTestId('signal-desk-row-sig-vuln')).toBeVisible({ timeout: 15_000 });

    await page.getByTestId('signal-desk-chip-research').click();
    await expect(page.getByTestId('signal-desk-row-sig-blog')).toBeVisible();
    await expect(page.getByTestId('signal-desk-row-sig-vuln')).toHaveCount(0);

    await page.getByTestId('signal-desk-chip-all').click();
    await expect(page.getByTestId('signal-desk-row-sig-vuln')).toBeVisible();
  });

  test('a failed source is a named failure in inbox and sources, never an empty feed', async ({
    page,
  }) => {
    await stubSignals(
      page,
      signalsPayload({
        sources: [
          OK_SOURCES[0],
          {
            sourceId: 'msrc',
            name: 'MSRC Update Guide',
            kind: 'rss',
            category: 'msrc',
            ok: false,
            itemCount: 0,
            error: 'HTTP 503',
            ms: 12_000,
          },
        ],
      }),
    );
    await openSignalDesk(page);
    await resetToInbox(page);

    const banner = page.getByTestId('signal-desk-partial');
    await expect(banner).toBeVisible({ timeout: 15_000 });
    await expect(banner).toContainText('MSRC Update Guide');

    // The stat band mirrors the degradation rather than claiming full health.
    await expect(page.getByTestId('signal-desk-stats')).toContainText('1/2');

    await page.getByTestId('signal-desk-rail-sources').click();
    const failedRow = page.getByTestId('signal-desk-source-msrc');
    await expect(failedRow).toBeVisible();
    await expect(failedRow).toContainText('실패 · HTTP 503');
    await expect(page.getByTestId('signal-desk-source-cisa-kev')).toContainText('정상 · 1건');
  });

  test('all sources failed reads as a read failure, not as an empty inbox', async ({ page }) => {
    await stubSignals(
      page,
      signalsPayload({
        items: [],
        sources: [
          {
            sourceId: 'cisa-kev',
            name: 'CISA KEV',
            kind: 'kev-json',
            category: 'vuln',
            ok: false,
            itemCount: 0,
            error: 'timeout',
            ms: 12_000,
          },
        ],
      }),
    );
    await openSignalDesk(page);
    await resetToInbox(page);

    const block = page.getByTestId('signal-desk-all-failed');
    await expect(block).toBeVisible({ timeout: 15_000 });
    await expect(block).toContainText('읽지 못한 것');
    await expect(page.getByTestId('signal-desk-inbox-empty')).toHaveCount(0);
  });

  test('a missing collector route reads as setup, not as a failure', async ({ page }) => {
    await page.route('**/api/signal-desk/signals**', (route) =>
      route.fulfill({ status: 404, json: { ok: false, error: 'not found' } }),
    );
    await openSignalDesk(page);
    await resetToInbox(page);

    const notice = page.getByTestId('signal-desk-unconfigured');
    await expect(notice).toBeVisible({ timeout: 15_000 });
    await expect(notice).toContainText('고장이 아니라');
    await expect(page.getByTestId('signal-desk-error')).toHaveCount(0);
  });

  test('hands a signal off to research with the composed request', async ({ page }) => {
    await stubSignals(page, signalsPayload());
    let capturedRequest: Record<string, unknown> | null = null;
    await page.route('**/api/aoi-research/start', async (route) => {
      capturedRequest = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({ json: { ok: true, run: { id: 'run-1' }, background: true } });
    });

    await openSignalDesk(page);
    await resetToInbox(page);
    // Rows visible == loadSignals resolved == state.json hydration finished.
    // Filling the session before that lets the late hydration overwrite it.
    const row = page.getByTestId('signal-desk-row-sig-vuln');
    await expect(row).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('signal-desk-session').fill('aoi/space_adventure');
    await row.locator('button').first().click();

    const handoff = page.getByTestId('signal-desk-handoff');
    await expect(handoff).toBeEnabled();
    await handoff.click();

    const state = page.getByTestId('signal-desk-research-state');
    await expect(state).toContainText('리서치가 백그라운드에서 시작', { timeout: 15_000 });
    expect(capturedRequest).not.toBeNull();
    expect(String(capturedRequest?.request)).toContain('Deep dive: CVE-2026-1111');
    expect(capturedRequest?.sessionPath).toBe('aoi/space_adventure');
  });

  test('handoff without a session is disabled and says why', async ({ page }) => {
    await stubSignals(page, signalsPayload());
    await openSignalDesk(page);
    await resetToInbox(page);
    // Same hydration ordering as above: clear the session only after the
    // persisted state has finished loading, or it reappears underneath us.
    const row = page.getByTestId('signal-desk-row-sig-vuln');
    await expect(row).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('signal-desk-session').fill('');
    await row.locator('button').first().click();

    await expect(page.getByTestId('signal-desk-handoff')).toBeDisabled();
    await expect(page.getByTestId('signal-desk-need-session')).toBeVisible();
  });

  test('brief renders with caveats and saves a snapshot', async ({ page }) => {
    await stubSignals(page, signalsPayload());
    await stubBrief(page);
    await openSignalDesk(page);

    await page.getByTestId('signal-desk-rail-brief').click();
    const doc = page.getByTestId('signal-desk-brief-doc');
    await expect(doc).toBeVisible({ timeout: 15_000 });
    await expect(doc).toContainText('신호 2건 · KEV 1건');
    await expect(page.getByTestId('signal-desk-brief-caveats')).toContainText('관심 가중치 미적용');

    await page.getByTestId('signal-desk-brief-save').click();
    await expect(page.getByTestId('signal-desk-brief-saved-note')).toContainText('저장됨', {
      timeout: 15_000,
    });
  });
});
