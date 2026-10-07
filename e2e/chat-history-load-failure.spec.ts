import { test, expect, type Page } from '@playwright/test';

// E2E for the chat-history overwrite fix.
//
// A saved conversation that cannot be read (a 500 from the session-data route,
// an EBUSY lock on Windows, a half-written file) used to look exactly like "no
// conversation": the panel seeded a fresh first-meeting prologue and the 500 ms
// autosave wrote it over the transcript on disk. Now the read is retried, the
// failure is shown, and nothing is written to chat.json for that session.
//
// Only chat.json traffic is intercepted; every other request hits the real
// isolated e2e server.

function isChatFile(url: string): boolean {
  return url.includes('chat%2Fchat.json') || url.includes('chat/chat.json');
}

async function stubChatFile(
  page: Page,
  readStatus: number,
): Promise<{ reads: () => number; writes: string[] }> {
  let reads = 0;
  const writes: string[] = [];
  await page.route('**/api/session-data**', async (route) => {
    const request = route.request();
    if (!isChatFile(request.url())) {
      await route.continue();
      return;
    }
    if (request.method() === 'GET') {
      reads += 1;
      await route.fulfill({
        status: readStatus,
        contentType: 'application/json',
        body: readStatus === 200 ? '{}' : '{"error":"EBUSY: resource busy or locked"}',
      });
      return;
    }
    if (request.method() === 'POST') {
      writes.push(request.postData() ?? '');
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
      return;
    }
    await route.continue();
  });
  return { reads: () => reads, writes };
}

test.describe('Chat – saved conversation that cannot be read', () => {
  test('says so, retries the read, and never saves over the transcript', async ({ page }) => {
    const chatFile = await stubChatFile(page, 500);

    await page.goto('/');

    const firstMessage = page.locator('[data-testid="chat-message"]').first();
    await expect(firstMessage).toContainText('could not be loaded');
    // Transient lock errors get two more tries before the panel gives up.
    expect(chatFile.reads()).toBeGreaterThanOrEqual(3);

    // The autosave is debounced at 500 ms. Waiting well past it is the only way
    // to observe that a write never happens.
    await page.waitForTimeout(2_000);
    expect(chatFile.writes).toEqual([]);
  });

  test('a missing transcript still starts a conversation and saves it', async ({ page }) => {
    // The contrast case: an empty file is a new conversation, so the opener is
    // seeded and autosave persists it as before.
    const chatFile = await stubChatFile(page, 200);

    await page.goto('/');

    const firstMessage = page.locator('[data-testid="chat-message"]').first();
    await expect(firstMessage).toBeVisible();
    await expect(firstMessage).not.toContainText('could not be loaded');
    await expect.poll(() => chatFile.writes.length, { timeout: 10_000 }).toBeGreaterThan(0);
  });
});
