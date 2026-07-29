import { test, expect, type Page } from '@playwright/test';

// E2E for R2.2: an empty chat transcript is not automatically a first meeting.
//
// The authored first-meeting prologue is seeded whenever there is no persisted
// conversation -- a first-ever run, or a cleared history. Clearing a
// conversation does not clear the relationship record, so when one exists Aoi
// opens with a returning greeting instead. The greeting wording itself is
// covered by aoiCompanionVoice unit tests; this asserts the WIRING: what the
// relationship route reports decides which opener the user actually sees.
//
// Two things are stubbed. The relationship routes supply the record under test.
// The chat-history GET is forced empty so each case starts from a genuinely
// blank transcript -- the e2e home is reused across runs, so without this a
// previous run's saved opening line would decide the outcome. Every other fetch
// hits the real isolated server.
const FIRST_MEETING_MARKER = '후후';
const HOUR = 60 * 60 * 1000;

interface ThreadFixture {
  id: string;
  title: string;
  noticedAt: number;
  lastAskedAt?: number;
}

function relationshipFixture(
  sessionCount: number,
  lastSessionAt: number,
  openThreads: ThreadFixture[] = [],
) {
  return {
    version: 1,
    sessionPath: 'aoi/default',
    firstMetAt: lastSessionAt - 200 * HOUR,
    sessionCount,
    lastSessionAt,
    lastSessionSummary: 'E2E: the companion voice rollout',
    openThreads,
    milestones: [
      {
        id: 'first_met',
        kind: 'first_met',
        label: 'We started working together.',
        occurredAt: lastSessionAt - 200 * HOUR,
        evidenceRefs: [],
      },
    ],
    actionAuthority: 'display_only',
    mutationCount: 0,
    updatedAt: lastSessionAt,
  };
}

async function stubRelationship(page: Page, relationship: unknown): Promise<void> {
  await page.route('**/api/aoi-autonomy/relationship**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, sessionPath: 'aoi/default', relationship }),
    });
  });
}

// Force a blank transcript so the opener is decided by the relationship record
// alone. Only the chat.json read is intercepted; every other session-data
// request (including saves) passes through.
async function stubEmptyChatHistory(page: Page): Promise<void> {
  await page.route('**/api/session-data**', async (route) => {
    const url = route.request().url();
    const isChatRead =
      route.request().method() === 'GET' &&
      (url.includes('chat%2Fchat.json') || url.includes('chat/chat.json'));
    if (isChatRead) {
      await route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
      return;
    }
    await route.continue();
  });
}

test.describe('Chat – Aoi session greeting (R2.2)', () => {
  test('greets a returning user instead of replaying the first meeting', async ({ page }) => {
    await stubEmptyChatHistory(page);
    await stubRelationship(page, relationshipFixture(7, Date.now() - 80 * HOUR));

    await page.goto('/');

    const firstMessage = page.locator('[data-testid="chat-message"]').first();
    await expect(firstMessage).toBeVisible();
    // A long absence plus a stored summary: the long-gap opener, naming what the
    // previous session was about, and never the first-meeting line.
    await expect(firstMessage).toContainText('Been a while');
    await expect(firstMessage).toContainText('E2E: the companion voice rollout');
    await expect(firstMessage).not.toContainText(FIRST_MEETING_MARKER);
  });

  test('picks the same-day opener for a short gap', async ({ page }) => {
    await stubEmptyChatHistory(page);
    await stubRelationship(page, relationshipFixture(3, Date.now() - 2 * HOUR));

    await page.goto('/');

    const firstMessage = page.locator('[data-testid="chat-message"]').first();
    await expect(firstMessage).toContainText('Back again');
    await expect(firstMessage).not.toContainText('Been a while');
  });

  test('follows up on one unresolved thread and records the ask (R2.3)', async ({ page }) => {
    await stubEmptyChatHistory(page);
    const asked: string[] = [];
    // Capture the thread-asked write while still serving the record.
    await page.route('**/api/aoi-autonomy/relationship**', async (route) => {
      const request = route.request();
      if (request.url().includes('thread-asked')) {
        const body = JSON.parse(request.postData() ?? '{}') as { threadId?: string };
        asked.push(body.threadId ?? '');
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          sessionPath: 'aoi/default',
          relationship: relationshipFixture(4, Date.now() - 30 * HOUR, [
            // Oldest unasked wins; the already-asked one must not be raised again.
            {
              id: 'thread:already-asked',
              title: 'an old settled thing',
              noticedAt: 1,
              lastAskedAt: 2,
            },
            { id: 'thread:open-one', title: 'the daemon restart soak', noticedAt: 10 },
            { id: 'thread:open-two', title: 'a newer loose end', noticedAt: 20 },
          ]),
        }),
      });
    });

    await page.goto('/');

    const firstMessage = page.locator('[data-testid="chat-message"]').first();
    await expect(firstMessage).toContainText('First time since yesterday');
    await expect(firstMessage).toContainText('how did the daemon restart soak turn out?');
    // Exactly one thread is raised, and never one already asked about.
    await expect(firstMessage).not.toContainText('a newer loose end');
    await expect(firstMessage).not.toContainText('an old settled thing');
    await expect.poll(() => asked).toEqual(['thread:open-one']);
  });

  test('keeps the authored first-meeting prologue with no relationship on record', async ({
    page,
  }) => {
    await stubEmptyChatHistory(page);
    // A genuinely first-ever run: the route reports no record at all.
    await stubRelationship(page, null);

    await page.goto('/');

    const firstMessage = page.locator('[data-testid="chat-message"]').first();
    await expect(firstMessage).toContainText(FIRST_MEETING_MARKER);
    await expect(firstMessage).not.toContainText('Been a while');
    await expect(firstMessage).not.toContainText('Back again');
  });
});
