import { test, expect, type Page } from '@playwright/test';

// E2E for restored nudge-card chips whose pending offer is gone.
//
// Aoi's nudge cards (idle music, cyber news, taste/preference polls) and their
// reply chips are restored from the server-persisted transcript, but the pending
// offer that gives each chip its meaning lives in this browser's localStorage.
// Tapping a chip from another browser profile, another dev-server origin, or
// after cleared storage used to arrive with no offer behind it: the chip missed
// its direct-action path, and the music one fell through to the LLM, which
// answered "I lined it up in YouTube" while nothing ever opened.
//
// Each test stubs the transcript (the e2e home is reused across runs, so a
// previous run's saved conversation must not decide the outcome) and clears
// localStorage to reproduce exactly that lost-offer state. The LLM proxy is
// stubbed to answer with a sentinel and every call is counted: these flows must
// be fully deterministic, so a single call is the regression coming back.

const YOUTUBE_APP_ID = 3;
const CYBERNEWS_APP_ID = 14;
const CONFIG_KEY = 'webuiapps-llm-config';

const PLAY_CHIP = '▶ 재생';
const MUSIC_DISMISS_CHIP = '다음에';
const RECOMMENDED_TITLE = 'E2E 8월 여름 노래모음 KPOP PLAYLIST';
// Taste-derived picks carry the channel too (aoiMusicTaste.recordYouTubePlay).
const RECOMMENDED_QUERY = `${RECOMMENDED_TITLE} - OpenRoom`;

const NEWS_CHIP = '📰 관심 있어';
const NEWS_ARTICLE_ID = 'live-e2e-chip-1';
const NEWS_HEADLINE = 'E2E SUPPLY CHAIN ATTACK POISONS BUILD PIPELINE';
const NEWS_ARTICLE_BODY = 'Full fixture body for the restored news chip test.';

// The first static preference question, mirrored here so the fixture card is
// the one the app will match against. Kept in sync by the unit tests, which
// build their fixtures from the bank itself.
const PREFERENCE_PROMPT = '요즘 가장 깊게 파고들고 싶은 기술 주제가 뭐야?';

// Deliberately ranked the way YouTube ranked the real case: the sibling upload
// first, the video Aoi actually named second. Autoplay must start the named one.
const FIXTURE_RESULTS = [
  {
    id: 'vid-wrong',
    title: 'E2E 7월 여름 노래모음 KPOP PLAYLIST',
    channel: 'OpenRoom',
    duration: '1:08:57',
    views: '245,323 views',
    published: '1 month ago',
    thumbnail: '',
    url: 'https://www.youtube.com/watch?v=vid-wrong',
  },
  {
    id: 'vid-chip',
    title: RECOMMENDED_TITLE,
    channel: 'OpenRoom',
    duration: '1:02:53',
    views: '112,033 views',
    published: '2 weeks ago',
    thumbnail: '',
    url: 'https://www.youtube.com/watch?v=vid-chip',
  },
];

// Live articles older than 30 minutes trigger CyberNews' live-feed refresh,
// which replaces the live set and DELETES the rotated-out files. Stamped fresh
// per run so the happy-path test is not racing that rotation; the rotation case
// gets its own test below.
function newsArticle(fetchedAt: string) {
  return {
    id: NEWS_ARTICLE_ID,
    title: NEWS_HEADLINE,
    category: 'breaking',
    summary: 'An E2E fixture article for the restored news chip.',
    content: NEWS_ARTICLE_BODY,
    imageUrl: '',
    publishedAt: fetchedAt,
    isLive: true,
    fetchedAt,
  };
}

interface CardFixture {
  id: string;
  content: string;
  suggestedReplies: string[];
}

const MUSIC_CARD: CardFixture = {
  id: 'aoi-idle-music-e2e',
  content: `늦은 시간이라 조용하네. 은은한 사운드 하나 깔아줄까?\n🎵 추천 (네 취향 반영): "${RECOMMENDED_QUERY}"`,
  suggestedReplies: [PLAY_CHIP, MUSIC_DISMISS_CHIP],
};

const NEWS_CARD: CardFixture = {
  id: 'aoi-news-e2e',
  content: `📰 새 사이버보안 뉴스가 눈에 띄네: "${NEWS_HEADLINE}". 자세히 볼래?`,
  suggestedReplies: [NEWS_CHIP, '지금은 됐어'],
};

const PREFERENCE_CARD: CardFixture = {
  id: 'aoi-preference-poll-e2e',
  content: PREFERENCE_PROMPT,
  suggestedReplies: [
    'Windows 커널·드라이버 내부',
    '안티치트·게임 보안',
    '리버스 엔지니어링',
    'TPM·하드웨어 기반 검증',
  ],
};

function transcriptWith(card: CardFixture) {
  const message = { ...card, role: 'assistant' };
  return {
    version: 1,
    savedAt: 1,
    messages: [message],
    chatHistory: [{ role: 'assistant', content: card.content }],
    suggestedReplies: card.suggestedReplies,
  };
}

// Serve the fixture transcript for the chat read, and the fixture article for
// the CyberNews store. Every other session-data request (including saves)
// passes through to the real isolated server.
async function stubSessionData(
  page: Page,
  card: CardFixture,
  articleFetchedAt: string = new Date().toISOString(),
): Promise<void> {
  await page.route('**/api/session-data**', async (route) => {
    const request = route.request();
    const url = decodeURIComponent(request.url());
    if (request.method() !== 'GET') {
      await route.continue();
      return;
    }
    if (url.includes('chat/chat.json')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(transcriptWith(card)),
      });
      return;
    }
    const articlesDir = 'apps/cyberNews/data/articles';
    if (url.includes(`${articlesDir}/${NEWS_ARTICLE_ID}.json`)) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(newsArticle(articleFetchedAt)),
      });
      return;
    }
    if (url.includes(articlesDir) && url.includes('action=list')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          files: [{ path: `${articlesDir}/${NEWS_ARTICLE_ID}.json`, type: 0, size: 512 }],
          not_exists: false,
        }),
      });
      return;
    }
    await route.continue();
  });
}

test.describe('Aoi nudge chips after the pending offer is lost', () => {
  let llmCallCount = 0;

  test.beforeEach(async ({ page }) => {
    llmCallCount = 0;
    // A usable model config is required to reach the direct-action paths, but no
    // request may actually be made -- every call is counted and asserted zero.
    await page.addInitScript((configKey) => {
      localStorage.clear();
      localStorage.setItem(
        configKey,
        JSON.stringify({
          provider: 'openai',
          apiKey: 'sk-test',
          baseUrl: 'https://mock-llm.test/v1',
          model: 'gpt-4',
        }),
      );
    }, CONFIG_KEY);
    await page.route('**/api/llm-proxy', async (route) => {
      llmCallCount += 1;
      await route.fulfill({
        json: { choices: [{ message: { content: 'LLM MUST NOT BE CALLED' } }] },
      });
    });
    await page.route('**/api/youtube-search**', (route) =>
      route.fulfill({ json: { results: FIXTURE_RESULTS } }),
    );
    await page.route('https://www.youtube.com/**', (route) => route.abort());
    await page.route('https://i.ytimg.com/**', (route) => route.abort());
    // Empty live feed by default: syncLiveArticles bails on an empty response
    // and keeps what is on disk, so the fixture article survives. The rotation
    // test overrides this with a real item.
    await page.route('**/api/cybernews/live**', (route) =>
      route.fulfill({ json: { provider: 'e2e', fetchedAt: new Date().toISOString(), items: [] } }),
    );
    await page.route('**/api/aoi-autonomy/**', (route) => route.abort());
    await page.route('**/api/kira-automation/**', (route) => route.abort());
  });

  async function tapChip(page: Page, hasText: string): Promise<void> {
    const chip = page.getByTestId('suggested-reply').filter({ hasText });
    await expect(chip).toBeVisible({ timeout: 30_000 });
    await chip.click();
  }

  test('the music play chip recovers its pick and opens it in the YouTube app', async ({
    page,
  }) => {
    await stubSessionData(page, MUSIC_CARD);
    await page.goto('/');
    await tapChip(page, '재생');

    // The chip must open the in-app YouTube window and run the recommended
    // query -- this is the whole point of the fix.
    await expect(page.getByTestId(`app-window-${YOUTUBE_APP_ID}`)).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByTestId('yt-result-card-vid-chip')).toBeVisible({ timeout: 30_000 });
    // autoplay: '1' loads a video into the player -- and it must be the one the
    // card named, not the higher-ranked sibling sitting above it in the list.
    await expect(page.getByTestId('yt-player-title')).toHaveText(RECOMMENDED_TITLE);
    // The search box must show what is actually playing. A cold open applies
    // state.json after the agent action lands, so this catches the stale query
    // being restored over the one Aoi just ran.
    await expect(page.getByTestId('yt-search-input')).toHaveValue(RECOMMENDED_QUERY);

    // And the ack must come from the deterministic path, not a model turn.
    await expect(page.getByTestId('chat-messages')).toContainText(RECOMMENDED_QUERY);
    expect(llmCallCount).toBe(0);
  });

  test('the music dismiss chip answers as a dismissal instead of reaching the model', async ({
    page,
  }) => {
    await stubSessionData(page, MUSIC_CARD);
    await page.goto('/');
    await tapChip(page, MUSIC_DISMISS_CHIP);

    await expect(page.getByTestId('chat-messages')).toContainText('알겠어. 필요하면 말해줘.');
    // A dismissal opens nothing.
    await expect(page.getByTestId(`app-window-${YOUTUBE_APP_ID}`)).toHaveCount(0);
    expect(llmCallCount).toBe(0);
  });

  test('the news chip recovers its article and opens it in CyberNews', async ({ page }) => {
    await stubSessionData(page, NEWS_CARD);
    await page.goto('/');
    await tapChip(page, '관심 있어');

    await expect(page.getByTestId(`app-window-${CYBERNEWS_APP_ID}`)).toBeVisible({
      timeout: 30_000,
    });
    // The article BODY only renders in the detail view, so this distinguishes
    // "VIEW_ARTICLE actually opened it" from "the feed list happens to show
    // that headline".
    await expect(page.getByTestId(`app-window-${CYBERNEWS_APP_ID}`)).toContainText(
      NEWS_ARTICLE_BODY,
      { timeout: 30_000 },
    );
    await expect(page.getByTestId('chat-messages')).toContainText('CyberNews에서');
    expect(llmCallCount).toBe(0);
  });

  test('says so honestly when the offered article is gone instead of claiming an open', async ({
    page,
  }) => {
    // A stale live article is rotated out (and its file deleted) by CyberNews'
    // own refresh, so VIEW_ARTICLE genuinely cannot find it. dispatchAgentAction
    // reports that by RESOLVING with "error: ...", never by throwing -- an ack
    // gated only on exceptions would announce an article that never opened.
    // A live feed that does not contain the offered article: CyberNews replaces
    // its live set with this one and deletes the rotated-out file.
    await page.route('**/api/cybernews/live**', (route) =>
      route.fulfill({
        json: {
          provider: 'e2e',
          fetchedAt: new Date().toISOString(),
          items: [
            {
              title: 'A COMPLETELY DIFFERENT HEADLINE',
              url: 'https://example.test/other',
              summary: 'Replaces the offered article.',
              imageUrl: '',
              sourceName: 'E2E',
              publishedAt: new Date().toISOString(),
              category: 'breaking',
            },
          ],
        },
      }),
    );
    await stubSessionData(page, NEWS_CARD, '2020-01-01T00:00:00.000Z');
    await page.goto('/');
    await tapChip(page, '관심 있어');

    await expect(page.getByTestId('chat-messages')).toContainText('문제가 있었어', {
      timeout: 30_000,
    });
    await expect(page.getByTestId('chat-messages')).not.toContainText('CyberNews에서 "');
    expect(llmCallCount).toBe(0);
  });

  test('a preference poll chip is recorded as an answer instead of reaching the model', async ({
    page,
  }) => {
    await stubSessionData(page, PREFERENCE_CARD);
    await page.goto('/');
    await tapChip(page, 'Windows 커널·드라이버 내부');

    // The deterministic ack confirms the exact choice back and says it is kept.
    await expect(page.getByTestId('chat-messages')).toContainText('Windows 커널·드라이버 내부');
    await expect(page.getByTestId('chat-messages')).toContainText('기억해둘게');
    expect(llmCallCount).toBe(0);
  });
});
