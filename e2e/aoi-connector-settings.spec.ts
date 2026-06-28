import { test, expect } from '@playwright/test';

// E2E for the Trusted MCP Connectors settings panel (the allow-list that authorizes
// a live connector RPC). There is no RTL in this repo, so this is the only coverage
// of the panel wired into the real chat-settings modal and of its inline SSRF
// host-status feedback rendering in a browser.
//
// Deliberately PERSIST-FREE: it only adds a draft connector row and types into the
// endpoint field (local component state). It never blurs, toggles, removes, or saves,
// so AoiMcpConnectorsSettings.onSave never fires and nothing is written to the real
// ~/.openroom config via /api/llm-config -- matching the existing e2e convention of
// not mutating server-side config. The draft is discarded when the modal closes. The
// draft->config persist round-trip is covered by the aoiMcpConnectorsSettingsModel
// unit tests. Unique hostnames keep assertions robust against any pre-existing
// connectors already in the dev config.
test.describe('Chat settings – Trusted MCP Connectors panel', () => {
  test('is wired into the Models tab and shows inline SSRF host validation', async ({ page }) => {
    await page.goto('/');

    await page.locator('[data-testid="settings-btn"]').click();
    const modal = page.locator('[data-testid="settings-modal"]');
    await expect(modal).toBeVisible();

    // The connector panel lives in the Models tab.
    await modal.getByRole('button', { name: 'Models', exact: true }).click();
    await expect(modal.getByText('Trusted MCP Connectors', { exact: true })).toBeVisible();

    // Add a draft connector row (local state only -> no config write).
    await modal.getByRole('button', { name: '+ Add connector' }).click();
    const endpoint = modal.getByLabel('Connector endpoint URL').last();
    await expect(endpoint).toBeVisible();

    // A public https endpoint resolves cleanly (unique host -> collision-free assert).
    await endpoint.fill('https://mcp-e2e-check.example.org/jira');
    await expect(modal.getByText(/Resolves to host: mcp-e2e-check\.example\.org/i)).toBeVisible();

    // A private / loopback endpoint is flagged inline by the SSRF host gate, and the
    // previous resolved-host line disappears.
    await endpoint.fill('http://10.10.10.10/mcp');
    await expect(modal.getByText(/Resolves to host: mcp-e2e-check/i)).toHaveCount(0);
    await expect(modal.getByText(/Private\/loopback host blocked/i).last()).toBeVisible();

    // Close without saving; the draft is discarded and the real config is untouched.
    await modal.locator('button', { hasText: 'Cancel' }).click();
    await expect(modal).not.toBeVisible();
  });
});
