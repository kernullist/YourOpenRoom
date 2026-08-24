import { test, expect, type Page } from '@playwright/test';

// E2E for the plain-text fallback: the turn where the model answers in prose
// instead of calling respond_to_user.
//
// Measured on the configured model (deepseek-v4-flash), this is the common path:
// 9 of 10 real chat turns in the run ledger recorded plain_text_fallback. It
// cannot be forced away -- tool_choice:'required' is rejected in thinking mode,
// and with thinking off the model still answers conversational turns in prose.
// So the path has to behave correctly rather than be treated as impossible, and
// nothing covered it. This pins what it does today: the prose is delivered as the
// assistant message, and no chips are left over from the previous turn.
//
// What it CANNOT deliver, by construction: the reply chips and the expression for
// this turn, both of which ride on respond_to_user's arguments. On this model that
// is most turns.

const CONFIG_KEY = 'webuiapps-llm-config';

const STALE_CHIP = '스테일 칩 답변';
const PROSE_REPLY = '(턱을 괴고) 그냥 평문으로 답할게. 오늘은 좀 쉬어.';

function transcript() {
  return {
    version: 1,
    savedAt: 1,
    messages: [
      {
        id: 'aoi-prior',
        role: 'assistant',
        content: '아까 물어본 거 답이야. 더 볼래?',
        suggestedReplies: [STALE_CHIP, '아니 괜찮아'],
      },
    ],
    chatHistory: [{ role: 'assistant', content: '아까 물어본 거 답이야. 더 볼래?' }],
    suggestedReplies: [STALE_CHIP, '아니 괜찮아'],
  };
}

async function setup(page: Page): Promise<void> {
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
  // Prose, no tool calls -- exactly what the real provider returns on these turns.
  await page.route('**/api/llm-proxy', (route) =>
    route.fulfill({ json: { choices: [{ message: { content: PROSE_REPLY } }] } }),
  );
  await page.route('**/api/youtube-search**', (route) => route.fulfill({ json: { results: [] } }));
  await page.route('https://www.youtube.com/**', (route) => route.abort());
  await page.route('**/api/aoi-autonomy/**', (route) => route.abort());
  await page.route('**/api/kira-automation/**', (route) => route.abort());
}

test.describe('plain-text fallback turn', () => {
  test('delivers the prose and drops the previous turn’s chips', async ({ page }) => {
    await setup(page);
    await page.goto('/');

    // The restored transcript puts the earlier turn's chips on screen.
    await expect(page.getByTestId('suggested-reply').filter({ hasText: STALE_CHIP })).toBeVisible({
      timeout: 30_000,
    });

    const input = page.getByTestId('chat-input');
    await input.fill('오늘 좀 피곤하다');
    await page.getByTestId('send-btn').click();

    // The reply still arrives -- the fallback is a delivery path, not an error.
    await expect(page.getByTestId('chat-messages')).toContainText('그냥 평문으로 답할게', {
      timeout: 30_000,
    });
    // And no chip is left over from the previous turn sitting under a reply it does
    // not answer. handleSend clears them per send, which this pins.
    await expect(page.getByTestId('suggested-reply').filter({ hasText: STALE_CHIP })).toHaveCount(
      0,
    );
  });
});
