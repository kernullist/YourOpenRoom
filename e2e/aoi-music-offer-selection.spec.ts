import { test, expect, type Page } from '@playwright/test';

// E2E for answering a music recommendation Aoi made herself.
//
// Reported transcript: Aoi offered 에스파 "KISS N TELL" together with its exact
// YouTube query and asked "이거 틀어줄까?". Answering "에스파로 가자" searched the
// bare artist word instead of the offer, and YouTube's top hit for that word was
// an unrelated variety-show episode -- which is what actually played. Correcting
// her ("아니, 너가 추천한 에스파 노래 말야") and then confirming ("응 맞아")
// resolved to nothing at all, so those turns reached the LLM with no app tools,
// and it answered by promising playback "다음 턴에" -- on every turn after.
//
// The search backend is stubbed PER QUERY: only a query naming the offered song
// returns the MV, every other query returns the decoy alone. A passing test
// therefore proves the dispatched query was the offer's, not the typed fragment.
//
// The parser no longer resolves these itself. With a pick on the table, which pick
// the user means is a question about language, so the turn goes to the intent
// classifier -- which answers with a candidate id, and code dispatches its exact
// query. What is asserted is unchanged: the offered query runs, and no
// conversation turn is needed to make that happen.

const YOUTUBE_APP_ID = 3;
const CONFIG_KEY = 'webuiapps-llm-config';

// Quoted exactly as the recommendation card prints it, because the autoplay
// matcher looks for a result title spelled out inside the query.
const OFFER_QUERY = "aespa 에스파 'KISS N TELL' MV - SMTOWN and aespa";
const OFFER_TITLE = "aespa 에스파 'KISS N TELL' MV";
const DECOY_TITLE = '[EP.07] 아우디즈의 찾아서 투어 | 칼숙이와 애리를 찾아서 in 파인 다이닝';

const OFFER_CARD = [
  '좋아, 그럼 내가 네 취향에 딱 맞는 거 하나 집어줄게. 에스파 "KISS N TELL" 어때?',
  '',
  `YouTube 검색어: \`${OFFER_QUERY}\``,
  '',
  '이거 틀어줄까? 아니면 프로미스나인 쪽으로 갈까?',
].join('\n');

// The turn the reported loop died on: a confirm ask that names the pick only in
// backticks, and promises the action for a turn that never comes.
const CONFIRM_ASK =
  '아, 그거! "KISS N TELL" 맞지? 근데 지금 이 타이밍엔 재생 버튼이 내 손에 안 잡혀서 바로 못 틀었어. ' +
  `다음 턴에 YouTube 검색으로 \`${OFFER_QUERY}\` 바로 열어줄게. 그거 맞는 거지? 확인만 해줘.`;

function video(id: string, title: string) {
  return {
    id,
    title,
    channel: 'SMTOWN',
    duration: '3:12',
    views: '12,345,678 views',
    published: '2 weeks ago',
    thumbnail: '',
    url: `https://www.youtube.com/watch?v=${id}`,
  };
}

const MV = video('vid-mv', OFFER_TITLE);
const DECOY = video('vid-decoy', DECOY_TITLE);

// The transcript is served from a stub: the e2e home is reused across runs, so a
// previous run's saved conversation must not decide the outcome.
function transcript(...assistantMessages: string[]) {
  return {
    version: 1,
    savedAt: 1,
    messages: assistantMessages.map((content, index) => ({
      id: `aoi-music-offer-${index}`,
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

test.describe('answering Aoi’s own music recommendation', () => {
  let conversationCalls = 0;
  let classifierCalls = 0;
  // What the stubbed classifier answers. Set per test, because these turns differ
  // only in what the classifier concludes.
  let classifierAnswer: Record<string, unknown> = {
    action: 'play_candidate',
    candidate_id: 1,
    confidence: 'high',
  };
  let searchQueries: string[] = [];

  test.beforeEach(async ({ page }) => {
    conversationCalls = 0;
    classifierCalls = 0;
    classifierAnswer = { action: 'play_candidate', candidate_id: 1, confidence: 'high' };
    searchQueries = [];
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
      const body = route.request().postDataJSON() as {
        tools?: Array<{ function: { name: string } }>;
      };
      const toolNames = (body?.tools ?? []).map((tool) => tool.function.name);
      if (toolNames.includes('resolve_music_intent')) {
        classifierCalls += 1;
        await route.fulfill({
          json: {
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: 'call_intent',
                      type: 'function',
                      function: {
                        name: 'resolve_music_intent',
                        arguments: JSON.stringify(classifierAnswer),
                      },
                    },
                  ],
                },
              },
            ],
          },
        });
        return;
      }
      conversationCalls += 1;
      await route.fulfill({
        json: { choices: [{ message: { content: 'CONVERSATION PATH RAN' } }] },
      });
    });
    await page.route('**/api/youtube-search**', async (route) => {
      const query = new URL(route.request().url()).searchParams.get('query') ?? '';
      searchQueries.push(query);
      // Only a query that names the offered song can surface the MV. The decoy
      // stays first in both sets, the way relevance ranking put it in the real
      // case, so a matched query has to override the top hit to pass.
      const namesTheSong = /kiss\s*n\s*tell/i.test(query);
      await route.fulfill({ json: { results: namesTheSong ? [DECOY, MV] : [DECOY] } });
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

  async function expectOfferPlaying(page: Page): Promise<void> {
    await expect(page.getByTestId(`app-window-${YOUTUBE_APP_ID}`)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('yt-player-title')).toHaveText(OFFER_TITLE, { timeout: 30_000 });
    await expect(page.getByTestId('yt-search-input')).toHaveValue(OFFER_QUERY);
    // One classifier call resolved it, and the dispatch plus the ack came from
    // code. A conversation turn here is the "다음 턴에 틀어줄게" regression coming
    // back.
    expect(classifierCalls).toBe(1);
    expect(conversationCalls).toBe(0);
  }

  test('a named selection opens the offer, not the artist word', async ({ page }) => {
    await stubTranscript(page, OFFER_CARD);
    await page.goto('/');
    await send(page, '에스파로 가자');

    await expectOfferPlaying(page);
    // Searching the typed fragment alone is what played the variety show.
    expect(searchQueries).toContain(OFFER_QUERY);
    expect(searchQueries).not.toContain('에스파');
  });

  test('a correction naming her pick plays it instead of promising a later turn', async ({
    page,
  }) => {
    await stubTranscript(page, OFFER_CARD);
    await page.goto('/');
    await send(page, '아니, 너가 추천한 에스파 노래 말야');

    await expectOfferPlaying(page);
  });

  test('confirming her own confirm ask plays the pick on that turn', async ({ page }) => {
    await stubTranscript(page, OFFER_CARD, CONFIRM_ASK);
    await page.goto('/');
    await send(page, '응 맞아');

    await expectOfferPlaying(page);
  });

  test('asking for a different pick never replays the one being refused', async ({ page }) => {
    await stubTranscript(page, OFFER_CARD);
    // The classifier reads this as a refusal, which dispatches nothing.
    classifierAnswer = { action: 'reject_and_repick', confidence: 'high' };
    await page.goto('/');
    await send(page, '응 그런데 다른거로 해줘');

    // "다른거" names nothing to search, and recovering the offer would replay
    // exactly what was refused -- so nothing may be dispatched here. The turn
    // belongs to the conversation, which is the one path allowed to pick again.
    await expect(page.getByTestId(`app-window-${YOUTUBE_APP_ID}`)).toHaveCount(0);
    expect(searchQueries).toEqual([]);
  });
});
