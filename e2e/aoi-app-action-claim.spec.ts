import { test, expect, type Page } from '@playwright/test';

// E2E for the app-action claim postcondition.
//
// The deterministic intent parsers catch the common "play this" phrasings before
// the model runs. Whatever they miss reaches the LLM, which has repeatedly
// replied "지금 바로 틀어줄게" without calling app_action at all -- nothing opened,
// nothing played, and the user was told otherwise. Each individual miss was
// fixed by widening a parser; this asserts the structural backstop: a claim with
// no dispatch behind it is rejected before it can be shown, the model is told to
// either act or stop claiming, and only the corrected answer reaches the user.
//
// The model is scripted so the failure is deterministic: turn 1 hallucinates,
// turn 2 answers honestly.

const CONFIG_KEY = 'webuiapps-llm-config';
const YOUTUBE_APP_ID = 3;

const HALLUCINATED = '아, 그거! 지금 바로 틀어줄게. 늦은 밤에 은은하게 깔리기 딱 좋은 곡들이야.';
const HONEST =
  '미안, 뭘 틀지 못 찾았어. 아직 아무것도 재생하지 않았어. 제목을 알려주면 바로 찾아볼게.';

function respondToUser(content: string, performedActions: string[] = []) {
  return {
    choices: [
      {
        message: {
          content: '',
          tool_calls: [
            {
              id: `tc_${content.length}`,
              type: 'function',
              function: {
                name: 'respond_to_user',
                arguments: JSON.stringify({
                  character_expression: { content, emotion: 'neutral' },
                  recommended_replies: ['그래', '아니 됐어', '다른 거'],
                  performed_actions: performedActions,
                }),
              },
            },
          ],
        },
      },
    ],
  };
}

const EMPTY_TRANSCRIPT = {
  version: 1,
  savedAt: 1,
  messages: [],
  chatHistory: [],
  suggestedReplies: [],
};

// The e2e home is shared by every spec and reused across runs, and this spec
// sends its message the moment the page loads. Whatever conversation the home
// happens to hold is therefore what the direct-action parsers read: a music pick
// an earlier spec left there is a pick this spec never wrote, and it is exactly
// what these tests must not have -- the point is a claim with NOTHING behind it.
// The turns sent here land in the home the same way, for the next spec to
// inherit in turn.
//
// Reads of the conversation are answered empty and writes are swallowed. Every
// other read the conversation loop makes still goes to the real server, where it
// is read-only and cannot leak anything back out.
async function isolateFromSharedHome(page: Page): Promise<void> {
  await page.route('**/api/llm-config**', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({ json: {} })
      : route.fulfill({ json: { ok: true } }),
  );
  await page.route('**/api/session-data**', async (route) => {
    const request = route.request();
    if (request.method() !== 'GET') {
      await route.fulfill({ json: { ok: true } });
      return;
    }
    if (decodeURIComponent(request.url()).includes('chat/chat.json')) {
      await route.fulfill({ json: EMPTY_TRANSCRIPT });
      return;
    }
    await route.continue();
  });
}

test.describe('Aoi app-action claim postcondition', () => {
  test('rejects a playback claim with no dispatch and only shows the corrected answer', async ({
    page,
  }) => {
    const sentContents: string[] = [];
    let correctionSeen = false;

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
    await isolateFromSharedHome(page);
    await page.route('**/api/aoi-autonomy/**', (route) => route.abort());
    await page.route('**/api/kira-automation/**', (route) => route.abort());
    await page.route('**/api/youtube-search**', (route) =>
      route.fulfill({ json: { results: [] } }),
    );

    await page.route('**/api/llm-proxy', async (route) => {
      const body = route.request().postDataJSON() as {
        messages?: { role: string; content?: string }[];
      };
      // The correction is fed back as a tool result before the retry.
      if (
        (body.messages ?? []).some(
          (message) =>
            typeof message.content === 'string' &&
            message.content.includes('you reported an app action that did not happen'),
        )
      ) {
        correctionSeen = true;
        sentContents.push(HONEST);
        await route.fulfill({ json: respondToUser(HONEST) });
        return;
      }
      sentContents.push(HALLUCINATED);
      await route.fulfill({ json: respondToUser(HALLUCINATED) });
    });

    await page.goto('/');
    await page.getByTestId('chat-input').fill('아까 그거 다시 틀어달라니까');
    await page.getByTestId('send-btn').click();

    const messages = page.getByTestId('chat-messages');
    await expect(messages).toContainText('아직 아무것도 재생하지 않았어', { timeout: 30_000 });

    // The false claim must never reach the transcript, and nothing may open.
    await expect(messages).not.toContainText('지금 바로 틀어줄게');
    await expect(page.getByTestId(`app-window-${YOUTUBE_APP_ID}`)).toHaveCount(0);

    // And the model really was told why, rather than the reply being silently
    // swapped out from under it.
    expect(correctionSeen).toBe(true);
    expect(sentContents).toEqual([HALLUCINATED, HONEST]);
  });

  test('catches a declared action the prose detector would never have flagged', async ({
    page,
  }) => {
    // The reason the field exists. This reply asserts nothing a phrase pattern
    // could match -- it reads as an ordinary sentence -- but the model declared
    // it performed an action, and nothing was dispatched.
    const BLAND = '응, 다 됐어. 편하게 즐겨.';
    let correctionSeen = false;
    const shown: string[] = [];

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
    await isolateFromSharedHome(page);
    await page.route('**/api/aoi-autonomy/**', (route) => route.abort());
    await page.route('**/api/kira-automation/**', (route) => route.abort());
    await page.route('**/api/llm-proxy', async (route) => {
      const body = route.request().postDataJSON() as {
        messages?: { role: string; content?: string }[];
      };
      if (
        (body.messages ?? []).some(
          (message) =>
            typeof message.content === 'string' &&
            message.content.includes('performed_actions [youtube OPEN_SEARCH]'),
        )
      ) {
        correctionSeen = true;
        shown.push(HONEST);
        await route.fulfill({ json: respondToUser(HONEST) });
        return;
      }
      shown.push(BLAND);
      await route.fulfill({ json: respondToUser(BLAND, ['youtube OPEN_SEARCH']) });
    });

    await page.goto('/');
    // Must NOT end in a phrase the deterministic parser handles, or it never
    // reaches the model at all.
    await page.getByTestId('chat-input').fill('아무거나 하나 골라서 틀어달라니까');
    await page.getByTestId('send-btn').click();

    const messages = page.getByTestId('chat-messages');
    await expect(messages).toContainText('아직 아무것도 재생하지 않았어', { timeout: 30_000 });
    await expect(messages).not.toContainText(BLAND);
    expect(correctionSeen).toBe(true);
    expect(shown).toEqual([BLAND, HONEST]);
  });

  test('leaves an honest answer alone when nothing was claimed', async ({ page }) => {
    let llmCallCount = 0;
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
    await isolateFromSharedHome(page);
    await page.route('**/api/aoi-autonomy/**', (route) => route.abort());
    await page.route('**/api/kira-automation/**', (route) => route.abort());
    await page.route('**/api/llm-proxy', async (route) => {
      llmCallCount += 1;
      await route.fulfill({ json: respondToUser(HONEST) });
    });

    await page.goto('/');
    await page.getByTestId('chat-input').fill('아까 그거 다시 틀어달라니까');
    await page.getByTestId('send-btn').click();

    await expect(page.getByTestId('chat-messages')).toContainText('아직 아무것도 재생하지 않았어', {
      timeout: 30_000,
    });
    // One round trip: the contract polices false claims, not unfinished work.
    expect(llmCallCount).toBe(1);
  });
});
