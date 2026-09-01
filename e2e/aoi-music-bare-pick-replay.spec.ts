import { test, expect, type Page } from '@playwright/test';

// E2E for the reported failure: Aoi kept playing the wrong song.
//
// Transcript from the report: Aoi's own ack said `"KISS N TELL" 유튜브에서
// 틀어볼게.`, so the only pick left on the table carried the TITLE and nothing
// else. 꿀보 then typed the artist in himself -- "에스파 KISS N TELL 틀어줘" --
// and got the same wrong video again, because:
//
//   1. with a pick on the table the turn was handed to the intent classifier,
//      whose play_candidate answer dispatches the CANDIDATE's query, so 에스파
//      never reached YouTube; and
//   2. searching the bare title, autoplay preferred a video whose title is
//      exactly "KISS N TELL" -- an unrelated Topic upload sitting below aespa's
//      MV -- over the top-ranked hit.
//
// Both halves are asserted here. The search backend is stubbed per query, and
// the same-title decoy is deliberately kept in the result set so a pass means
// the ranked video was chosen over it, not that the decoy was absent.

const YOUTUBE_APP_ID = 3;
const CONFIG_KEY = 'webuiapps-llm-config';

// Aoi's playback ack -- the whole point of the case is that this is ALL the
// transcript carries: a bare title, no artist, no channel.
const BARE_PICK_ACK = '"KISS N TELL" 유튜브에서 틀어볼게.';

const MV_TITLE = "aespa エスパ 'KISS N TELL' MV";
// Same title as the query, different song. This is what actually played.
const SAME_TITLE_DECOY = 'KISS N TELL';

function video(id: string, title: string, channel: string) {
  return {
    id,
    title,
    channel,
    duration: '3:10',
    views: '12,262,362 views',
    published: '1 month ago',
    thumbnail: '',
    url: `https://www.youtube.com/watch?v=${id}`,
  };
}

const MV = video('vid-mv', MV_TITLE, 'SMTOWN');
const DECOY = video('vid-topic', SAME_TITLE_DECOY, 'untiljapan - Topic');

function transcript(...assistantMessages: string[]) {
  return {
    version: 1,
    savedAt: 1,
    messages: assistantMessages.map((content, index) => ({
      id: `aoi-bare-pick-${index}`,
      role: 'assistant',
      content,
    })),
    chatHistory: assistantMessages.map((content) => ({ role: 'assistant', content })),
    suggestedReplies: [],
  };
}

async function stubTranscript(page: Page, ...assistantMessages: string[]): Promise<void> {
  await page.route('**/api/session-data**', async (route) => {
    const request = route.request();
    if (
      request.method() !== 'GET' ||
      !decodeURIComponent(request.url()).includes('chat/chat.json')
    ) {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(transcript(...assistantMessages)),
    });
  });
}

test.describe('replaying a pick Aoi recorded without the artist', () => {
  let llmCalls = 0;
  let searchQueries: string[] = [];

  test.beforeEach(async ({ page }) => {
    llmCalls = 0;
    searchQueries = [];
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
    // Both turns below must resolve in code. Any call here -- classifier or
    // conversation -- is counted and asserted zero.
    await page.route('**/api/llm-proxy', async (route) => {
      llmCalls += 1;
      await route.fulfill({ json: { choices: [{ message: { content: 'LLM PATH RAN' } }] } });
    });
    await page.route('**/api/youtube-search**', async (route) => {
      const query = new URL(route.request().url()).searchParams.get('query') ?? '';
      searchQueries.push(query);
      // Relevance order as YouTube really returned it: the MV on top, the
      // same-title upload further down.
      await route.fulfill({ json: { results: [MV, DECOY] } });
    });
    await page.route('https://www.youtube.com/**', (route) => route.abort());
    await page.route('https://i.ytimg.com/**', (route) => route.abort());
    await page.route('**/api/aoi-autonomy/**', (route) => route.abort());
    await page.route('**/api/kira-automation/**', (route) => route.abort());
  });

  async function send(page: Page, text: string): Promise<void> {
    const input = page.getByTestId('chat-input');
    await expect(input).toBeVisible({ timeout: 30_000 });
    await input.fill(text);
    await page.getByTestId('send-btn').click();
  }

  test('keeps the artist the user typed instead of replaying the bare pick', async ({ page }) => {
    await stubTranscript(page, BARE_PICK_ACK);
    await page.goto('/');
    await send(page, '에스파 KISS N TELL 틀어줘');

    await expect(page.getByTestId(`app-window-${YOUTUBE_APP_ID}`)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('yt-search-input')).toHaveValue('에스파 KISS N TELL', {
      timeout: 30_000,
    });
    await expect(page.getByTestId('yt-player-title')).toHaveText(MV_TITLE, { timeout: 30_000 });
    // The dropped artist is the defect: searching the bare title is what ranked
    // an unrelated song into reach in the first place.
    expect(searchQueries).toEqual(['에스파 KISS N TELL']);
    expect(llmCalls).toBe(0);
  });

  test('starts the ranked video, not a same-title upload further down', async ({ page }) => {
    // The chip resolves the bare pick verbatim, so this is the query the app
    // gets when nothing adds to it -- exactly the case autoplay got wrong.
    await stubTranscript(page, BARE_PICK_ACK);
    await page.goto('/');
    await send(page, '▶ 재생');

    await expect(page.getByTestId(`app-window-${YOUTUBE_APP_ID}`)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('yt-search-input')).toHaveValue('KISS N TELL', {
      timeout: 30_000,
    });
    await expect(page.getByTestId('yt-player-title')).toHaveText(MV_TITLE, { timeout: 30_000 });
    expect(searchQueries).toEqual(['KISS N TELL']);
    expect(llmCalls).toBe(0);
  });
});
