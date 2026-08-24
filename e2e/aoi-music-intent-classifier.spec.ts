import { test, expect, type Page } from '@playwright/test';

// E2E for Phase 1: the model reads the intent, code still owns the action.
//
// The pattern list in chatDirectActions covers the phrasings we thought of.
// Everything else used to arrive at the LLM as prose, which is how a confirmed
// playback request became "다음 턴에 틀어줄게". Now an unrecognized phrasing goes
// to a tiny classifier that can only pick from candidates this code extracted,
// and the dispatch + ack stay in code.
//
// The classifier request is identified by the tool it is offered
// (resolve_music_intent); everything else is a normal conversation turn, counted
// separately so each test can assert which path actually ran.

const YOUTUBE_APP_ID = 3;
const CONFIG_KEY = 'webuiapps-llm-config';

// Katakana on purpose: the exact query is the real upload title, while the card
// speaks Korean. The classifier is handed both.
const OFFER_QUERY = "aespa エスパ 'KISS N TELL' MV";
const OFFER_TITLE = "aespa エスパ 'KISS N TELL' MV";
const OFFER_CARD = [
  '에스파 "KISS N TELL" 어때?',
  `YouTube 검색어: \`${OFFER_QUERY}\``,
  '이거 틀어줄까?',
].join('\n');

// No direct-action path claims this, so the turn has to be resolved by intent.
const UNPARSED_REQUEST = '그 노래 좀 부탁할게';

const RESULTS = [
  {
    id: 'vid-mv',
    title: OFFER_TITLE,
    channel: 'SMTOWN',
    duration: '3:12',
    views: '12,345,678 views',
    published: '2 weeks ago',
    thumbnail: '',
    url: 'https://www.youtube.com/watch?v=vid-mv',
  },
];

function transcript() {
  return {
    version: 1,
    savedAt: 1,
    messages: [{ id: 'aoi-offer', role: 'assistant', content: OFFER_CARD }],
    chatHistory: [{ role: 'assistant', content: OFFER_CARD }],
    suggestedReplies: [],
  };
}

interface Counters {
  classifierCalls: number;
  conversationCalls: number;
  classifierPrompts: string[];
}

async function setup(
  page: Page,
  counters: Counters,
  classifierAnswer: Record<string, unknown>,
): Promise<void> {
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
      body: JSON.stringify(transcript()),
    });
  });
  await page.route('**/api/llm-proxy', async (route) => {
    const body = route.request().postDataJSON() as {
      messages?: Array<{ role: string; content: string }>;
      tools?: Array<{ function: { name: string } }>;
    };
    const toolNames = (body?.tools ?? []).map((tool) => tool.function.name);
    if (toolNames.includes('resolve_music_intent')) {
      counters.classifierCalls += 1;
      counters.classifierPrompts.push(
        (body.messages ?? []).map((message) => message.content).join('\n'),
      );
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
    counters.conversationCalls += 1;
    await route.fulfill({
      json: {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: 'call_respond',
                  type: 'function',
                  function: {
                    name: 'respond_to_user',
                    arguments: JSON.stringify({
                      character_expression: {
                        content: 'CONVERSATION PATH RAN',
                        emotion: 'peaceful',
                      },
                      user_interaction: { suggested_replies: ['응', '아니', '그래'] },
                      performed_actions: [],
                    }),
                  },
                },
              ],
            },
          },
        ],
      },
    });
  });
  await page.route('**/api/youtube-search**', (route) =>
    route.fulfill({ json: { results: RESULTS } }),
  );
  await page.route('https://www.youtube.com/**', (route) => route.abort());
  await page.route('https://i.ytimg.com/**', (route) => route.abort());
  await page.route('**/api/aoi-autonomy/**', (route) => route.abort());
  await page.route('**/api/kira-automation/**', (route) => route.abort());
}

async function send(page: Page, text: string): Promise<void> {
  const input = page.getByTestId('chat-input');
  await expect(input).toBeVisible({ timeout: 30_000 });
  await input.fill(text);
  await page.getByTestId('send-btn').click();
}

test.describe('music intent classifier', () => {
  test('an unrecognized phrasing is played from the candidate the classifier picked', async ({
    page,
  }) => {
    const counters: Counters = { classifierCalls: 0, conversationCalls: 0, classifierPrompts: [] };
    await setup(page, counters, { action: 'play_candidate', candidate_id: 1, confidence: 'high' });
    await page.goto('/');
    await send(page, UNPARSED_REQUEST);

    await expect(page.getByTestId(`app-window-${YOUTUBE_APP_ID}`)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('yt-player-title')).toHaveText(OFFER_TITLE, { timeout: 30_000 });
    // The exact offered query ran, not a fragment of what the user typed.
    await expect(page.getByTestId('yt-search-input')).toHaveValue(OFFER_QUERY);

    expect(counters.classifierCalls).toBe(1);
    // The action and the ack came from code, so no conversation turn was needed.
    expect(counters.conversationCalls).toBe(0);
    await expect(page.getByTestId('chat-messages')).not.toContainText('CONVERSATION PATH RAN');
    // The classifier was handed the numbered candidate AND the card excerpt, which
    // is what makes a cross-script pick resolvable.
    expect(counters.classifierPrompts[0]).toContain(`1. ${OFFER_QUERY}`);
    expect(counters.classifierPrompts[0]).toContain('에스파');
  });

  test('an invented query is refused and the turn falls through', async ({ page }) => {
    const counters: Counters = { classifierCalls: 0, conversationCalls: 0, classifierPrompts: [] };
    // Nothing in the conversation says this, so the grounding guard must reject it
    // rather than let a hallucinated title reach YouTube.
    await setup(page, counters, {
      action: 'search',
      query: 'BLACKPINK Jump MV Official',
      confidence: 'high',
    });
    await page.goto('/');
    await send(page, UNPARSED_REQUEST);

    await expect(page.getByTestId('chat-messages')).toContainText('CONVERSATION PATH RAN', {
      timeout: 30_000,
    });
    expect(counters.classifierCalls).toBe(1);
    expect(counters.conversationCalls).toBeGreaterThan(0);
    // Nothing was dispatched off the refused query.
    await expect(page.getByTestId(`app-window-${YOUTUBE_APP_ID}`)).toHaveCount(0);
  });

  test('a non-music message is left to the conversation', async ({ page }) => {
    const counters: Counters = { classifierCalls: 0, conversationCalls: 0, classifierPrompts: [] };
    await setup(page, counters, { action: 'none', confidence: 'high' });
    await page.goto('/');
    await send(page, '오늘 좀 피곤하다');

    await expect(page.getByTestId('chat-messages')).toContainText('CONVERSATION PATH RAN', {
      timeout: 30_000,
    });
    await expect(page.getByTestId(`app-window-${YOUTUBE_APP_ID}`)).toHaveCount(0);
    expect(counters.conversationCalls).toBeGreaterThan(0);
  });
});
