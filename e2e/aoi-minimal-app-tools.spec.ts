import { test, expect, type Page } from '@playwright/test';

// E2E for the minimal app toolset (list_apps + app_action) riding every
// tool-capable turn.
//
// Measured before this change: 11 of 12 real chat turns in the run ledger shipped
// with 2 tools and no way to act, so a playback request phrased in any way the
// direct parser did not recognize could only be answered with a promise for a
// later turn -- which the next turn, gated the same way, could not keep either.
//
// The full app toolset would have fixed that at ~16k extra input tokens per turn
// (30 schemas + a 15k-char policy block). list_apps + app_action cost ~285 tokens
// of schema, so they are no longer gated. This test proves the reach: a phrasing
// the direct parser deliberately does NOT claim still reaches the YouTube app.

const YOUTUBE_APP_ID = 3;
const CONFIG_KEY = 'webuiapps-llm-config';

const OFFER_QUERY = "aespa 에스파 'KISS N TELL' MV";
const OFFER_TITLE = "aespa 에스파 'KISS N TELL' MV";

const OFFER_CARD = [
  '에스파 "KISS N TELL" 어때?',
  `YouTube 검색어: \`${OFFER_QUERY}\``,
  '이거 틀어줄까?',
].join('\n');

// A phrasing with no direct-action path of its own, so the turn has to reach the
// model -- which is exactly the case that used to be unserviceable.
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

test.describe('minimal app tools on every turn', () => {
  let toolNamesPerCall: string[][] = [];
  let dispatchedAppAction = false;

  async function setup(page: Page): Promise<void> {
    toolNamesPerCall = [];
    dispatchedAppAction = false;
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
    // The model is stubbed, but the TOOLS it is offered are the real ones: the
    // first call answers with app_action, the second wraps up. A turn that ships
    // without app_action cannot produce this sequence at all.
    await page.route('**/api/llm-proxy', async (route) => {
      const body = route.request().postDataJSON() as {
        tools?: Array<{ function: { name: string } }>;
      };
      const names = (body?.tools ?? []).map((tool) => tool.function.name);
      toolNamesPerCall.push(names);
      // The intent classifier runs first on this phrasing and is offered only its
      // own tool, so the branch has to key off what is actually available and
      // whether an action already went out -- never off the call index.
      if (names.includes('resolve_music_intent')) {
        await route.fulfill({
          json: { choices: [{ message: { content: null, tool_calls: [] } }] },
        });
        return;
      }
      if (!dispatchedAppAction && names.includes('app_action')) {
        dispatchedAppAction = true;
        await route.fulfill({
          json: {
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: 'call_action',
                      type: 'function',
                      function: {
                        name: 'app_action',
                        arguments: JSON.stringify({
                          app_name: 'youtube',
                          action_type: 'OPEN_SEARCH',
                          params: JSON.stringify({ query: OFFER_QUERY, autoplay: '1' }),
                        }),
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
                        message: `"${OFFER_QUERY}" 틀었어.`,
                        emotion: 'happy',
                        performed_actions: ['youtube OPEN_SEARCH'],
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

  test('an unparsed playback phrasing still reaches the YouTube app', async ({ page }) => {
    await setup(page);
    await page.goto('/');

    const input = page.getByTestId('chat-input');
    await expect(input).toBeVisible({ timeout: 30_000 });
    await input.fill(UNPARSED_REQUEST);
    await page.getByTestId('send-btn').click();

    await expect(page.getByTestId(`app-window-${YOUTUBE_APP_ID}`)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('yt-player-title')).toHaveText(OFFER_TITLE, { timeout: 30_000 });

    // Every CONVERSATION call this turn had to be offered app_action, on whichever
    // route the router picked -- that is the property the gate used to break. The
    // classifier call is excluded: it is deliberately given one tool and nothing
    // else.
    const conversationCalls = toolNamesPerCall.filter(
      (names) => !names.includes('resolve_music_intent'),
    );
    expect(conversationCalls.length).toBeGreaterThan(0);
    for (const names of conversationCalls) {
      expect(names).toContain('app_action');
      expect(names).toContain('list_apps');
    }
  });
});
