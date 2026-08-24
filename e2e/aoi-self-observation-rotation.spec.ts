import { test, expect, type Page } from '@playwright/test';

// The real default policy, so the stubbed status carries every nested field the
// panel dereferences (policy.proactiveBriefing among them) and this spec does not
// have to be hand-maintained as the policy shape grows.
import { DEFAULT_AOI_AUTONOMY_POLICY } from '../apps/webuiapps/src/lib/aoiAutonomyPolicy';

// E2E for the self-observation nudge rotation.
//
// The bug this covers: Aoi's "here is what I looked into myself" line remembered
// only the LAST topic it had voiced, so a pool of three research memories
// alternated between its two newest entries forever and the third was never
// spoken. To the user that reads as one canned sentence on repeat.
//
// Proving it needs a real browser because the rotation state lives in this
// browser's localStorage and the trigger is the idle news-nudge interval. Three
// gates stand between page load and a spoken observation:
//   1. autonomy policy enabled -> the wakeup response is stubbed with it on
//   2. 3 minutes of user idle -> Playwright's fake clock fast-forwards it
//   3. 4 hours of self-observation spacing -> the localStorage stamp is rewound
// Nothing about the copy or the selection is stubbed: the assertion is on the
// actual sentences rendered into the transcript.

const CONFIG_KEY = 'webuiapps-llm-config';
const SELF_OBSERVATION_KEY = 'aoi:selfObservationState:v1';
const NEWS_KEY = 'aoi:newsState:v1';
// Sibling idle nudges. Seeded as just-offered so their cooldowns hold them back
// and the self-observation is the only thing this window can produce.
const IDLE_MUSIC_KEY = 'aoi:idleMusicState:v1';
const TASTE_POLL_KEY = 'aoi-music-taste-v1';
const PREFERENCE_POLL_KEY = 'aoi-preference-poll-v1';
const CLOCK_ORIGIN = '2026-08-24T09:00:00Z';
// Set on the first load so later loads in the same test keep the rotation window
// instead of being cleared back to a fresh install.
const SEED_MARKER_KEY = 'e2e:selfobs-seeded';
const MEMORY_DIR = 'aoi/memory-v2/memories';
const ARTICLES_DIR = 'apps/cyberNews/data/articles';
const ARTICLE_ID = 'live-selfobs-e2e-1';
const HEADLINE = 'E2E SELF OBSERVATION HOST HEADLINE';

// Newest first. Distinct enough that a repeat is unmistakable in the assertion.
const RESEARCH_TOPICS = [
  { id: 'selfobs-mem-1', title: 'E2E 개인정보 메타데이터 수집 가이드라인', day: '2026-07-17' },
  { id: 'selfobs-mem-2', title: 'E2E Windows AI 에이전트 상황 인식 검증', day: '2026-07-16' },
  { id: 'selfobs-mem-3', title: 'E2E Kernel Anti-Tamper Driver Integrity', day: '2026-07-02' },
];

// Research-completion memories as aoiMemoryServerWriter stores them: audit prose
// in content, the human title in entities. The spoken line must carry the title,
// never the audit sentence.
function memoryFixture(index: number) {
  const topic = RESEARCH_TOPICS[index];
  return {
    version: 1,
    id: topic.id,
    scope: 'agent',
    status: 'active',
    kind: 'fact',
    content: `Aoi completed research "${topic.title}" on ${topic.day}. Findings: e2e fixture body.`,
    entities: [topic.title],
    tags: ['research'],
    confidence: 0.9,
    createdAt: Date.parse(`${topic.day}T00:00:00Z`),
    updatedAt: Date.parse(`${topic.day}T00:00:00Z`),
  };
}

function articleFixture(fetchedAt: string) {
  return {
    id: ARTICLE_ID,
    title: HEADLINE,
    category: 'tech',
    summary: 'An e2e host article the self-observation is allowed to ride on.',
    content: 'Full fixture body.',
    imageUrl: '',
    publishedAt: fetchedAt,
    isLive: true,
    fetchedAt,
  };
}

// Empty transcript: the isolated e2e home is shared across runs, so a previous
// run's saved conversation must not decide what is on screen.
const EMPTY_TRANSCRIPT = {
  version: 1,
  savedAt: 1,
  messages: [],
  chatHistory: [],
  suggestedReplies: [],
};

async function stubSessionData(page: Page): Promise<void> {
  const fetchedAt = new Date().toISOString();
  await page.route('**/api/session-data**', async (route) => {
    const request = route.request();
    if (request.method() !== 'GET') {
      await route.continue();
      return;
    }
    const url = decodeURIComponent(request.url());
    if (url.includes('chat/chat.json')) {
      await route.fulfill({ json: EMPTY_TRANSCRIPT });
      return;
    }
    if (url.includes(MEMORY_DIR) && url.includes('action=list')) {
      await route.fulfill({
        json: {
          files: RESEARCH_TOPICS.map((topic) => ({
            path: `${MEMORY_DIR}/${topic.id}.json`,
            type: 0,
            size: 512,
          })),
          not_exists: false,
        },
      });
      return;
    }
    const memoryIndex = RESEARCH_TOPICS.findIndex((topic) =>
      url.includes(`${MEMORY_DIR}/${topic.id}.json`),
    );
    if (memoryIndex >= 0) {
      await route.fulfill({ json: memoryFixture(memoryIndex) });
      return;
    }
    if (url.includes(`${ARTICLES_DIR}/${ARTICLE_ID}.json`)) {
      await route.fulfill({ json: articleFixture(fetchedAt) });
      return;
    }
    if (url.includes(ARTICLES_DIR) && url.includes('action=list')) {
      await route.fulfill({
        json: {
          files: [{ path: `${ARTICLES_DIR}/${ARTICLE_ID}.json`, type: 0, size: 512 }],
          not_exists: false,
        },
      });
      return;
    }
    await route.continue();
  });
}

// The only thing this stub decides is that autonomy is ON with network off, so
// the nudge gate opens and the article is read from the local store.
async function stubAutonomy(page: Page): Promise<void> {
  await page.route('**/api/aoi-autonomy/wakeup', async (route) => {
    await route.fulfill({
      json: {
        ok: true,
        record: { id: 'selfobs-e2e-wakeup', completedAt: Date.now() },
        state: {},
        status: {
          version: 1,
          sessionPath: 'e2e/selfobs',
          // Autonomy on, network off: the gate opens and the article is read
          // from the local store rather than fetched.
          policy: { ...DEFAULT_AOI_AUTONOMY_POLICY, enabled: true, allowNetwork: false },
          activeProposalCount: 0,
          archivedProposalCount: 0,
          acceptedProposalCount: 0,
          snoozedProposalCount: 0,
          blockedProposalCount: 0,
          observationCount: 0,
          reflectionCount: 0,
          decisionCount: 0,
          activeTick: false,
          recentObservationCount: 0,
          proposalsCreatedInLastTick: 0,
          lastTickAt: Date.now(),
        },
      },
    });
  });
  // The dashboard refresh that follows the wakeup would overwrite the stubbed
  // status with the real (disabled) policy from the isolated home.
  await page.route('**/api/aoi-autonomy/dashboard**', (route) => route.abort());
}

// One visit: load the page, sit idle past the 3-minute threshold, and read back
// whatever self-observation was spoken.
//
// Each lap is its own page load rather than three fast-forwards in one session,
// for two reasons. The nudge reads its timing and rotation state from refs
// hydrated once at mount, so rewinding localStorage mid-session changes nothing;
// and a reload is what a returning user actually does, which makes this also a
// test that the rotation window survives the round trip through storage.
//
// The step is 4 minutes, not hours: the sibling nudges (idle music at 45m,
// taste/preference polls at 24h) are seeded as just-offered at the clock origin,
// and a multi-hour jump would bring them due. Whichever of those fires first
// parks a pending offer that suppresses this one.
async function visitAndWaitForObservation(page: Page): Promise<string> {
  await page.goto('/');
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 30_000 });
  await page.clock.fastForward('04:00');
  const spoken = page
    .getByTestId('chat-message')
    .filter({ hasText: /E2E (개인정보|Windows AI|Kernel Anti-Tamper)/ });
  await expect(spoken).toHaveCount(1, { timeout: 30_000 });
  return (await spoken.innerText()).trim();
}

test.describe('Aoi self-observation rotation', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.install({ time: new Date(CLOCK_ORIGIN) });
    await page.addInitScript(
      (seed) => {
        // First load seeds; later loads must keep the rotation window this spec
        // is measuring, so only the timing stamps are reopened.
        if (!localStorage.getItem(seed.markerKey)) {
          localStorage.clear();
          localStorage.setItem(seed.markerKey, '1');
          localStorage.setItem(
            seed.configKey,
            JSON.stringify({
              provider: 'openai',
              apiKey: 'sk-test',
              baseUrl: 'https://mock-llm.test/v1',
              model: 'gpt-4',
            }),
          );
          // Sibling nudges: just offered, so their cooldowns keep them quiet.
          localStorage.setItem(
            seed.idleMusicKey,
            JSON.stringify({
              version: 1,
              moodFeedback: {},
              recentQueries: [],
              lastOfferedAt: seed.origin,
            }),
          );
          localStorage.setItem(
            seed.tastePollKey,
            JSON.stringify({
              version: 1,
              answers: {},
              recentSearches: [],
              recentPlays: [],
              lastAskedAt: seed.origin,
            }),
          );
          localStorage.setItem(
            seed.preferencePollKey,
            JSON.stringify({ version: 1, answers: {}, lastAskedAt: seed.origin }),
          );
        }
        // Reopen the two gates that would otherwise hold this visit's offer: the
        // self-observation spacing (0 = never voiced) and the news cooldown.
        const rawSelfObs = localStorage.getItem(seed.selfObsKey);
        const selfObs = rawSelfObs ? JSON.parse(rawSelfObs) : { version: 1 };
        selfObs.version = 1;
        selfObs.lastSelfObservationAt = 0;
        localStorage.setItem(seed.selfObsKey, JSON.stringify(selfObs));
        const rawNews = localStorage.getItem(seed.newsKey);
        if (rawNews) {
          const news = JSON.parse(rawNews);
          news.lastOfferedAt = 0;
          localStorage.setItem(seed.newsKey, JSON.stringify(news));
        }
      },
      {
        configKey: CONFIG_KEY,
        selfObsKey: SELF_OBSERVATION_KEY,
        newsKey: NEWS_KEY,
        idleMusicKey: IDLE_MUSIC_KEY,
        tastePollKey: TASTE_POLL_KEY,
        preferencePollKey: PREFERENCE_POLL_KEY,
        markerKey: SEED_MARKER_KEY,
        origin: Date.parse(CLOCK_ORIGIN),
      },
    );
    await page.route('**/api/llm-proxy', (route) =>
      route.fulfill({ json: { choices: [{ message: { content: 'LLM MUST NOT BE CALLED' } }] } }),
    );
    await page.route('**/api/cybernews/live**', (route) =>
      route.fulfill({ json: { provider: 'e2e', fetchedAt: new Date().toISOString(), items: [] } }),
    );
    await stubSessionData(page);
    await stubAutonomy(page);
  });

  test('cycles every researched topic instead of repeating the newest', async ({ page }) => {
    const spoken: string[] = [];
    for (let visit = 0; visit < RESEARCH_TOPICS.length; visit += 1) {
      spoken.push(await visitAndWaitForObservation(page));
    }

    // Every researched topic gets voiced once -- the regression spoke only two.
    for (const topic of RESEARCH_TOPICS) {
      expect(spoken.filter((line) => line.includes(topic.title))).toHaveLength(1);
    }
    // Audit prose never reaches the transcript.
    expect(spoken.some((line) => line.includes('Aoi completed research'))).toBe(false);
    expect(spoken.some((line) => line.includes('Findings:'))).toBe(false);
    // Research from five weeks ago is not claimed as something happening now.
    expect(spoken.some((line) => line.includes('요즘'))).toBe(false);

    // The rotation window is persisted, not just held in memory.
    const state = await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key) ?? 'null'),
      SELF_OBSERVATION_KEY,
    );
    expect(state.recentTopicKeys).toHaveLength(3);
    expect(state.offeredCount).toBe(3);
  });
});
