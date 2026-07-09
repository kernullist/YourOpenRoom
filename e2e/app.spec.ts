import { test, expect } from '@playwright/test';

test.describe('Shell – main UI', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('renders the shell with desktop app icons', async ({ page }) => {
    await expect(page).toHaveTitle('Your Room');
    const shell = page.locator('[data-testid="shell"]');
    await expect(shell).toBeVisible();

    const desktop = page.locator('[data-testid="desktop"]');
    await expect(desktop).toBeVisible();

    // Should have multiple app icons on the desktop
    const icons = page.locator('[data-testid^="app-icon-"]');
    await expect(icons).not.toHaveCount(0);
    const count = await icons.count();
    expect(count).toBeGreaterThanOrEqual(5);
  });

  test('displays control buttons (chat, wallpaper, report)', async ({ page }) => {
    await expect(page.locator('[data-testid="chat-toggle"]')).toBeVisible();
    await expect(page.locator('[data-testid="wallpaper-toggle"]')).toBeVisible();
    await expect(page.locator('[data-testid="report-toggle"]')).toBeVisible();
  });
});

test.describe('Chat panel – visibility toggle', () => {
  test('chat panel is visible by default and can be hidden and re-shown', async ({ page }) => {
    await page.goto('/');
    const panel = page.locator('[data-testid="chat-panel"]');
    const toggle = page.locator('[data-testid="chat-toggle"]');

    // Panel visible by default
    await expect(panel).toBeVisible();
    await expect(page.locator('[data-testid="chat-input"]')).toBeVisible();

    // Hide it
    await toggle.click();
    await expect(panel).not.toBeVisible();

    // Show it again
    await toggle.click();
    await expect(panel).toBeVisible();
  });

  test('chat panel shows either setup hint or chat messages', async ({ page }) => {
    await page.goto('/');
    const messages = page.locator('[data-testid="chat-messages"]');
    await expect(messages).toBeVisible();

    const emptyStateHint = messages.getByText(/configure your LLM API key|is ready to chat/i);
    const chatMessages = page.locator('[data-testid="chat-message"]');

    await expect
      .poll(async () => {
        return (await emptyStateHint.count()) + (await chatMessages.count());
      })
      .toBeGreaterThan(0);
  });
});

test.describe('Chat panel – settings modal', () => {
  test('opens and closes the settings modal', async ({ page }) => {
    await page.goto('/');
    const settingsBtn = page.locator('[data-testid="settings-btn"]');
    await expect(settingsBtn).toBeVisible();

    // Open settings
    await settingsBtn.click();
    const modal = page.locator('[data-testid="settings-modal"]');
    await expect(modal).toBeVisible();
    // The settings modal is grouped into tabs; the LLM configuration lives under
    // the "Models" tab. Assert that tab is present rather than the old flat
    // "LLM Settings" heading, which no longer exists.
    await expect(modal.getByRole('button', { name: 'Models', exact: true })).toBeVisible();

    // Close via Cancel button
    await modal.locator('button', { hasText: 'Cancel' }).click();
    await expect(modal).not.toBeVisible();
  });
});

test.describe('Chat panel – input interaction', () => {
  test('ctrl mouse wheel adjusts and persists chat font size', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => {
      window.localStorage.removeItem('openroom-chat-font-size');
    });
    await page.reload();

    const messages = page.locator('[data-testid="chat-messages"]');
    const input = page.locator('[data-testid="chat-input"]');
    await expect(messages).toBeVisible();
    await expect(input).toHaveCSS('font-size', '13px');

    await messages.evaluate((element) => {
      element.dispatchEvent(
        new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
          deltaY: -100,
        }),
      );
    });
    await expect(input).toHaveCSS('font-size', '14px');

    await page.reload();
    await expect(page.locator('[data-testid="chat-input"]')).toHaveCSS('font-size', '14px');
  });

  test('send button is disabled when input is empty and enabled when text is entered', async ({
    page,
  }) => {
    await page.goto('/');
    const input = page.locator('[data-testid="chat-input"]');
    const sendBtn = page.locator('[data-testid="send-btn"]');

    // Initially disabled
    await expect(sendBtn).toBeDisabled();

    // Type something
    await input.fill('Hello');
    await expect(sendBtn).toBeEnabled();

    // Clear it
    await input.fill('');
    await expect(sendBtn).toBeDisabled();
  });

  test('typing a message and clicking send adds it to the messages area', async ({ page }) => {
    // Sending is gated on a configured model, so provision a throwaway one in
    // localStorage rather than depending on the ambient dev config (the e2e home
    // is isolated and empty). The reply is mocked so the send completes cleanly;
    // this test only cares that the user message is appended and the input clears.
    await page.addInitScript(() => {
      localStorage.setItem(
        'webuiapps-llm-config',
        JSON.stringify({
          provider: 'openai',
          apiKey: 'sk-test',
          baseUrl: 'https://mock-llm.test/v1',
          model: 'gpt-4',
        }),
      );
    });
    await page.route('**/api/llm-proxy', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ choices: [{ message: { content: 'Ack from E2E mock.' } }] }),
      });
    });
    await page.goto('/');
    const input = page.locator('[data-testid="chat-input"]');
    const sendBtn = page.locator('[data-testid="send-btn"]');
    const messages = page.locator('[data-testid="chat-messages"]');

    await input.fill('Test message from E2E');
    await sendBtn.click();

    // The user message should appear in the messages area
    await expect(messages).toContainText('Test message from E2E');
    // Input should be cleared after sending
    await expect(input).toHaveValue('');
  });
});

test.describe('App window – open and close', () => {
  test('double-clicking an app icon opens a window, closing it removes the window', async ({
    page,
  }) => {
    await page.goto('/');

    // Double-click the Twitter icon (appId=2)
    const twitterIcon = page.locator('[data-testid="app-icon-2"]');
    await expect(twitterIcon).toBeVisible();
    await twitterIcon.dblclick();

    // An app window should appear
    const appWindow = page.locator('[data-testid="app-window-2"]');
    await expect(appWindow).toBeVisible({ timeout: 10000 });

    // Close it
    const closeBtn = page.locator('[data-testid="window-close-2"]');
    await closeBtn.click();
    await expect(appWindow).not.toBeVisible();
  });
});
