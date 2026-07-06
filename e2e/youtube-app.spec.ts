import { test, expect, type Page } from '@playwright/test';

const YOUTUBE_APP_ID = 3;
// Unique per run: state is persisted server-side, so a crashed earlier run
// must never collide with the playlist this run creates and asserts on.
const TEST_PLAYLIST_NAME = `E2E Queue ${Date.now()}`;

const FIXTURE_RESULTS = [
  {
    id: 'vid-aaa',
    title: 'First Fixture Video',
    channel: 'OpenRoom',
    duration: '3:21',
    views: '1M views',
    published: 'today',
    thumbnail: '',
    url: 'https://www.youtube.com/watch?v=vid-aaa',
  },
  {
    id: 'vid-bbb',
    title: 'Second Fixture Video',
    channel: 'OpenRoom',
    duration: '4:04',
    views: '2M views',
    published: 'today',
    thumbnail: '',
    url: 'https://www.youtube.com/watch?v=vid-bbb',
  },
];

async function openYoutubeApp(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId(`app-icon-${YOUTUBE_APP_ID}`).dblclick();
  await expect(page.getByTestId(`app-window-${YOUTUBE_APP_ID}`)).toBeVisible();
  // Maximize so every in-app control is inside the viewport.
  await page.getByTestId(`window-maximize-${YOUTUBE_APP_ID}`).click();
  // The lazy app chunk can take a while on a cold dev-server transform.
  await expect(page.getByTestId('yt-search-input')).toBeVisible({ timeout: 30_000 });
}

async function searchFixtures(page: Page): Promise<void> {
  await page.getByTestId('yt-search-input').fill('lofi beats');
  await page.getByTestId('yt-search-submit').click();
  await expect(page.getByTestId('yt-results-popup')).toBeVisible();
  await expect(page.getByTestId('yt-result-card-vid-aaa')).toBeVisible();
  await expect(page.getByTestId('yt-result-card-vid-bbb')).toBeVisible();
}

// Saves the currently selected video. With more than one playlist the app
// opens a picker, so route the video into the dedicated test playlist.
async function addCurrentVideoToTestPlaylist(page: Page): Promise<void> {
  await page.getByTestId('yt-add-current').click();
  const picker = page.getByTestId('yt-playlist-picker');
  if (await picker.isVisible().catch(() => false)) {
    await picker.locator('button', { hasText: TEST_PLAYLIST_NAME }).last().click();
  }
  await expect(picker).toHaveCount(0);
}

test.describe('YouTube app – in-app viewer UX flows', () => {
  test.beforeEach(async ({ page }) => {
    // Hermetic setup: fixture search results, no real YouTube traffic.
    await page.route('**/api/youtube-search**', (route) =>
      route.fulfill({ json: { results: FIXTURE_RESULTS } }),
    );
    await page.route('https://www.youtube.com/**', (route) => route.abort());
    await page.route('https://i.ytimg.com/**', (route) => route.abort());
    // The chat panel's autonomy/automation pollers wait on a daemon that is
    // not running during e2e. Their hanging requests would otherwise pin all
    // six HTTP/1.1 dev-server connections and starve module loading.
    await page.route('**/api/aoi-autonomy/**', (route) => route.abort());
    await page.route('**/api/kira-automation/**', (route) => route.abort());
  });

  test('search shows results without hijacking the player, clicking a result starts it', async ({
    page,
  }) => {
    await openYoutubeApp(page);
    await searchFixtures(page);

    // A plain search only lists results; nothing is force-loaded into the player.
    await expect(page.getByTestId('yt-player-empty')).toBeVisible();

    // An explicit click loads that exact video with autoplay.
    await page.getByTestId('yt-result-card-vid-bbb').click();
    await expect(page.getByTestId('yt-player-title')).toHaveText('Second Fixture Video');
    const iframe = page.getByTestId('yt-player-iframe');
    await expect(iframe).toHaveAttribute('src', /\/embed\/vid-bbb\?/);
    await expect(iframe).toHaveAttribute('src', /autoplay=1/);
  });

  test('backdrop clicks no longer close the viewer during playback; Escape does', async ({
    page,
  }) => {
    await openYoutubeApp(page);
    await searchFixtures(page);
    await page.getByTestId('yt-result-card-vid-aaa').click();
    await expect(page.getByTestId('yt-player-title')).toHaveText('First Fixture Video');

    // Click the dark backdrop ring around the player card.
    await page.getByTestId('yt-results-popup').click({ position: { x: 4, y: 300 } });
    await expect(page.getByTestId('yt-results-popup')).toBeVisible();
    await expect(page.getByTestId('yt-player-title')).toHaveText('First Fixture Video');

    // Escape (or the close button) is the explicit way out.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('yt-results-popup')).toHaveCount(0);
  });

  test('toggling loop does not reload the player iframe', async ({ page }) => {
    await openYoutubeApp(page);
    await searchFixtures(page);
    await page.getByTestId('yt-result-card-vid-aaa').click();

    const iframe = page.getByTestId('yt-player-iframe');
    const srcBefore = await iframe.getAttribute('src');
    expect(srcBefore).toBeTruthy();

    await page.getByTestId('yt-loop-toggle').click();
    await expect(iframe).toHaveAttribute('src', srcBefore as string);
    expect(srcBefore).not.toContain('loop');

    await page.getByTestId('yt-loop-toggle').click();
    await expect(iframe).toHaveAttribute('src', srcBefore as string);
  });

  test('saved videos play as a queue and clicking a queue entry jumps to it', async ({ page }) => {
    await openYoutubeApp(page);

    // Work inside a dedicated playlist so persisted state from earlier runs
    // (or real user data) cannot affect the queue that is asserted below.
    await page.getByTestId('yt-new-playlist-input').fill(TEST_PLAYLIST_NAME);
    await page.getByTestId('yt-create-playlist').click();
    await expect(page.getByTestId('yt-playlist-summary')).toContainText('0');

    await searchFixtures(page);
    await page.getByTestId('yt-result-card-vid-aaa').click();
    await addCurrentVideoToTestPlaylist(page);
    await page.getByTestId('yt-result-card-vid-bbb').click();
    await addCurrentVideoToTestPlaylist(page);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('yt-playlist-summary')).toContainText('2');

    // Start sequential queue playback from the playlist panel.
    await page.getByTestId('yt-playlist-play-seq').click();
    await expect(page.getByTestId('yt-results-popup')).toBeVisible();
    await expect(page.getByTestId('yt-popup-title')).toHaveText(TEST_PLAYLIST_NAME);
    const iframe = page.getByTestId('yt-player-iframe');
    await expect(iframe).toHaveAttribute('src', /\/embed\/vid-aaa\?/);
    await expect(iframe).toHaveAttribute('src', /playlist=vid-bbb/);

    // Clicking another queue entry moves playback to that entry.
    await page.getByTestId('yt-result-card-vid-bbb').click();
    await expect(page.getByTestId('yt-player-title')).toHaveText('Second Fixture Video');

    // Clean up the dedicated playlist so reruns start from a known state.
    // Wait for the state save that follows the deletion to reach the server;
    // closing the page earlier would drop the write and leak the playlist.
    await page.keyboard.press('Escape');
    const stateSaved = page.waitForResponse(
      (response) =>
        response.url().includes('/api/session-data') && response.request().method() === 'POST',
    );
    await page.getByTestId('yt-playlist-delete').click();
    await expect(page.getByText(TEST_PLAYLIST_NAME)).toHaveCount(0);
    await stateSaved;
  });
});
