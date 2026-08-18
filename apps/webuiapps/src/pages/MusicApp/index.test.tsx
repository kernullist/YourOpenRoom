import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { YoutubeSearchResult } from './searchUtils';

// ---------------------------------------------------------------------------
// Mocks. @gui/vibe-container is already aliased to the in-repo mock by
// vitest.config, so only the @/lib data/reporting surface and the network
// search call need stubbing. The YouTube iframe API is never loaded in the test
// environment (no window.YT), which the component already treats as optional.
// ---------------------------------------------------------------------------

const reportActionMock = vi.fn();
// Captures every state.json write so tests can assert on the persisted
// nowPlaying snapshot.
const writeFileMock = vi.fn(async () => {});
let capturedAgentHandler: ((action: unknown) => Promise<string>) | null = null;
// Controls what the mocked NAS returns for /state.json. Empty => the app falls
// back to DEFAULT_STATE (one empty "My Playlist"); a test can set a JSON string
// to exercise the SYNC_STATE / init restore path.
let mockStateContent = '';

vi.mock('@/lib', () => ({
  createAppFileApi: () => ({
    readFile: vi.fn(async () => ({ content: mockStateContent })),
    writeFile: (...args: unknown[]) => writeFileMock(...(args as [])),
    listFiles: vi.fn(async () => []),
    deleteFile: vi.fn(async () => {}),
  }),
  reportAction: (...args: unknown[]) => reportActionMock(...args),
  reportLifecycle: vi.fn(),
  fetchVibeInfo: vi.fn(async () => ({})),
  useAgentActionListener: (_appId: number, handler: (action: unknown) => Promise<string>) => {
    capturedAgentHandler = handler;
  },
  ActionTriggerBy: { User: 'user', Agent: 'agent' },
}));

const fetchYoutubeSearchResultsMock = vi.fn<[string], Promise<YoutubeSearchResult[]>>();

vi.mock('./searchUtils', async () => {
  const actual = await vi.importActual<typeof import('./searchUtils')>('./searchUtils');
  return {
    ...actual,
    fetchYoutubeSearchResults: (query: string) => fetchYoutubeSearchResultsMock(query),
  };
});

import YouTubeApp from './index';

function makeResult(id: string, title: string): YoutubeSearchResult {
  return {
    id,
    title,
    channel: 'OpenRoom',
    duration: '3:20',
    views: '1M views',
    published: 'today',
    thumbnail: '',
    url: `https://www.youtube.com/watch?v=${id}`,
  };
}

const FIXTURES = [
  makeResult('vid-aaa', 'First Fixture Video'),
  makeResult('vid-bbb', 'Second Fixture Video'),
];

function playlistItem(id: string, title: string) {
  return { ...makeResult(id, title), addedAt: 1 };
}

// A persisted AppState JSON with a single active playlist, used to exercise the
// queue-playback / restore paths without building the playlist through the UI.
function stateWithPlaylist(
  playlist: { id: string; name: string; items: ReturnType<typeof playlistItem>[] },
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    searchQuery: '',
    recentSearches: [],
    favoriteTopics: [],
    playlists: [{ createdAt: 1, updatedAt: 1, ...playlist }],
    activePlaylistId: playlist.id,
    lastPlayedPlaylistId: null,
    lastPlayedPlaylistMode: null,
    sidebarOpen: false,
    resultsAutoHide: false,
    loopPlayback: false,
    playerZoom: 1,
    ...extra,
  });
}

const QUEUE_PLAYLIST = {
  id: 'pl-queue',
  name: 'Queue Mix',
  items: [
    playlistItem('vid-aaa', 'First Fixture Video'),
    playlistItem('vid-bbb', 'Second Fixture Video'),
  ],
};

// A stub of the YouTube IFrame API. Installing it makes loadYouTubeIframeApi
// resolve immediately (no external <script> fetch, so no network noise) and
// lets the player-setup effect run its onReady / setLoop / destroy paths.
const playerCtorSpy = vi.fn();
const setLoopSpy = vi.fn();
const playVideoAtSpy = vi.fn();

function installYouTubeApiStub() {
  class StubPlayer {
    constructor(_target: unknown, options?: { events?: Record<string, (e: unknown) => void> }) {
      playerCtorSpy();
      options?.events?.onReady?.({ target: this });
    }
    destroy() {}
    getVideoData() {
      return {};
    }
    playVideoAt(index: number) {
      playVideoAtSpy(index);
    }
    loadVideoById() {}
    playVideo() {}
    seekTo() {}
    setLoop(loopPlaylists: boolean) {
      setLoopSpy(loopPlaylists);
    }
  }
  (window as unknown as { YT: unknown }).YT = {
    Player: StubPlayer,
    PlayerState: { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 },
  };
}

async function renderApp() {
  const utils = render(<YouTubeApp />);
  // The app renders a "Loading" state until the async init effect resolves.
  await waitFor(() => expect(screen.getByTestId('yt-search-input')).toBeTruthy());
  return utils;
}

async function runSearch(query = 'lofi beats') {
  fireEvent.change(screen.getByTestId('yt-search-input'), { target: { value: query } });
  fireEvent.click(screen.getByTestId('yt-search-submit'));
  await waitFor(() => expect(screen.getByTestId('yt-results-popup')).toBeTruthy());
  await waitFor(() => expect(screen.getByTestId('yt-result-card-vid-aaa')).toBeTruthy());
}

function playerIframe(): HTMLIFrameElement | null {
  return document.querySelector('[data-testid="yt-player-iframe"]');
}

beforeEach(() => {
  reportActionMock.mockClear();
  writeFileMock.mockClear();
  playerCtorSpy.mockClear();
  setLoopSpy.mockClear();
  capturedAgentHandler = null;
  mockStateContent = '';
  playVideoAtSpy.mockClear();
  fetchYoutubeSearchResultsMock.mockReset();
  fetchYoutubeSearchResultsMock.mockResolvedValue(FIXTURES);
  installYouTubeApiStub();
  // openHome / external links call window.open; keep it a no-op spy.
  window.open = vi.fn() as unknown as typeof window.open;
});

afterEach(() => {
  cleanup();
});

describe('YouTubeApp – in-app viewer UX', () => {
  it('renders the search launcher after init', async () => {
    await renderApp();
    expect(screen.getByTestId('yt-search-submit')).toBeTruthy();
    // Default state seeds a single empty playlist.
    expect(screen.getByTestId('yt-playlist-summary').textContent).toContain('0');
  });

  it('a search lists results without auto-loading the player', async () => {
    await renderApp();
    await runSearch();

    // Two fixtures are listed.
    expect(screen.getByTestId('yt-result-card-vid-aaa')).toBeTruthy();
    expect(screen.getByTestId('yt-result-card-vid-bbb')).toBeTruthy();
    // Nothing is force-loaded: the player pane shows its empty prompt and there
    // is no iframe yet.
    expect(screen.getByTestId('yt-player-empty')).toBeTruthy();
    expect(playerIframe()).toBeNull();
    // The search was reported to the agent surface.
    expect(reportActionMock).toHaveBeenCalledWith(
      3,
      'OPEN_SEARCH',
      { query: 'lofi beats' },
      'user',
    );
  });

  it('clicking a result autoplays that exact video in the embedded player', async () => {
    await renderApp();
    await runSearch();

    fireEvent.click(screen.getByTestId('yt-result-card-vid-bbb'));

    await waitFor(() => expect(playerIframe()).not.toBeNull());
    expect(screen.getByTestId('yt-player-title').textContent).toBe('Second Fixture Video');
    const src = playerIframe()!.getAttribute('src') ?? '';
    expect(src).toContain('/embed/vid-bbb?');
    expect(src).toContain('autoplay=1');
    // The IFrame API player is wired up for the embedded video.
    await waitFor(() => expect(playerCtorSpy).toHaveBeenCalled());
  });

  it('closes the viewer on Escape but not on a backdrop click', async () => {
    await renderApp();
    await runSearch();
    fireEvent.click(screen.getByTestId('yt-result-card-vid-aaa'));
    await waitFor(() => expect(playerIframe()).not.toBeNull());

    // A click on the dark overlay must NOT close the viewer mid-playback.
    fireEvent.click(screen.getByTestId('yt-results-popup'));
    expect(screen.queryByTestId('yt-results-popup')).toBeTruthy();

    // Escape is the explicit close.
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('yt-results-popup')).toBeNull());
  });

  it('toggling loop does not reload (remount) the player iframe', async () => {
    await renderApp();
    await runSearch();
    fireEvent.click(screen.getByTestId('yt-result-card-vid-aaa'));
    await waitFor(() => expect(playerIframe()).not.toBeNull());

    const before = playerIframe()!;
    const srcBefore = before.getAttribute('src');
    expect(srcBefore).not.toContain('loop');

    fireEvent.click(screen.getByTestId('yt-loop-toggle'));

    const after = playerIframe()!;
    // Same element instance (React key unchanged) and identical src => no reload.
    expect(after).toBe(before);
    expect(after.getAttribute('src')).toBe(srcBefore);
  });

  it('saving the current video grows the active playlist', async () => {
    await renderApp();
    await runSearch();
    fireEvent.click(screen.getByTestId('yt-result-card-vid-aaa'));
    await waitFor(() => expect(playerIframe()).not.toBeNull());

    fireEvent.click(screen.getByTestId('yt-add-current'));

    // Only one playlist exists, so the video is added directly (no picker), and
    // the summary count reflects it.
    await waitFor(() =>
      expect(screen.getByTestId('yt-playlist-summary').textContent).toContain('1'),
    );
  });

  it('OPEN_VIDEO agent action autoplays a direct watch URL', async () => {
    await renderApp();
    expect(capturedAgentHandler).toBeTypeOf('function');

    let result: string | undefined;
    await act(async () => {
      result = await capturedAgentHandler!({
        action_type: 'OPEN_VIDEO',
        params: { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
      });
    });
    expect(result).toBe('success');

    await waitFor(() => expect(playerIframe()).not.toBeNull());
    const src = playerIframe()!.getAttribute('src') ?? '';
    expect(src).toContain('/embed/dQw4w9WgXcQ?');
    expect(src).toContain('autoplay=1');
  });

  it('plays a saved playlist as a queue and jumps within it without a reload', async () => {
    mockStateContent = stateWithPlaylist(QUEUE_PLAYLIST);
    await renderApp();
    await waitFor(() =>
      expect(screen.getByTestId('yt-playlist-summary').textContent).toContain('2'),
    );

    fireEvent.click(screen.getByTestId('yt-playlist-play-seq'));
    await waitFor(() => expect(screen.getByTestId('yt-results-popup')).toBeTruthy());
    expect(screen.getByTestId('yt-popup-title').textContent).toBe('Queue Mix');

    const queueFrame = playerIframe();
    expect(queueFrame).not.toBeNull();
    const queueSrc = queueFrame!.getAttribute('src') ?? '';
    // Queue starts at the first item and cues the rest via the playlist param.
    expect(queueSrc).toContain('/embed/vid-aaa?');
    expect(queueSrc).toContain('playlist=vid-bbb');

    // Clicking another queue entry jumps through the IFrame API (no remount).
    fireEvent.click(screen.getByTestId('yt-result-card-vid-bbb'));
    await waitFor(() =>
      expect(screen.getByTestId('yt-player-title').textContent).toBe('Second Fixture Video'),
    );
    expect(playVideoAtSpy).toHaveBeenCalled();
    expect(playerIframe()).toBe(queueFrame);
  });

  it('SYNC_STATE reloads persisted state from the cloud', async () => {
    await renderApp();
    // Baseline: default state has the empty "My Playlist".
    expect(screen.getByTestId('yt-playlist-summary').textContent).toContain('0');

    mockStateContent = stateWithPlaylist({
      id: 'pl-synced',
      name: 'Synced List',
      items: [playlistItem('vid-aaa', 'First Fixture Video')],
    });

    let result: string | undefined;
    await act(async () => {
      result = await capturedAgentHandler!({ action_type: 'SYNC_STATE', params: {} });
    });
    expect(result).toBe('success');

    // The playlist name renders in both the tab strip and the sidebar, so match
    // all occurrences rather than expecting a single node.
    await waitFor(() => expect(screen.getAllByText('Synced List').length).toBeGreaterThan(0));
    expect(screen.getByTestId('yt-playlist-summary').textContent).toContain('1');
  });

  it('PLAY_LAST_PLAYLIST resumes the most recently played playlist', async () => {
    mockStateContent = stateWithPlaylist(QUEUE_PLAYLIST, {
      lastPlayedPlaylistId: 'pl-queue',
      lastPlayedPlaylistMode: 'sequential',
    });
    await renderApp();

    let result: string | undefined;
    await act(async () => {
      result = await capturedAgentHandler!({ action_type: 'PLAY_LAST_PLAYLIST', params: {} });
    });
    expect(result).toBe('success');

    await waitFor(() => expect(screen.getByTestId('yt-results-popup')).toBeTruthy());
    expect(screen.getByTestId('yt-popup-title').textContent).toBe('Queue Mix');
  });

  it('PLAY_LAST_PLAYLIST rehydrates cloud state on cold open before reacting', async () => {
    // Mirrors dispatchAgentAction opening a closed YouTube window: the agent
    // fires PLAY_LAST_PLAYLIST as soon as the listener registers, often while
    // React still holds the empty DEFAULT_STATE. The handler must re-read
    // state.json instead of trusting the first render's empty playlists.
    mockStateContent = stateWithPlaylist(QUEUE_PLAYLIST, {
      lastPlayedPlaylistId: 'pl-queue',
      lastPlayedPlaylistMode: 'sequential',
    });
    render(<YouTubeApp />);
    await waitFor(() => expect(capturedAgentHandler).toBeTruthy());

    let result: string | undefined;
    await act(async () => {
      result = await capturedAgentHandler!({ action_type: 'PLAY_LAST_PLAYLIST', params: {} });
    });
    expect(result).toBe('success');

    await waitFor(() => expect(screen.getByTestId('yt-results-popup')).toBeTruthy());
    expect(screen.getByTestId('yt-popup-title').textContent).toBe('Queue Mix');
  });

  it('PLAY_LAST_PLAYLIST plays the active My Playlist when lastPlayed is unset', async () => {
    mockStateContent = stateWithPlaylist({
      id: 'playlist-default',
      name: 'My Playlist',
      items: [playlistItem('vid-aaa', 'First Fixture Video')],
    });
    await renderApp();

    let result: string | undefined;
    await act(async () => {
      result = await capturedAgentHandler!({ action_type: 'PLAY_LAST_PLAYLIST', params: {} });
    });
    expect(result).toBe('success');

    await waitFor(() => expect(screen.getByTestId('yt-results-popup')).toBeTruthy());
    expect(screen.getByTestId('yt-popup-title').textContent).toBe('My Playlist');
  });

  it('handles OPEN_HOME and OPEN_SEARCH agent actions', async () => {
    await renderApp();

    let homeResult: string | undefined;
    await act(async () => {
      homeResult = await capturedAgentHandler!({ action_type: 'OPEN_HOME', params: {} });
    });
    expect(homeResult).toBe('success');
    expect(window.open).toHaveBeenCalled();

    let searchResult: string | undefined;
    await act(async () => {
      searchResult = await capturedAgentHandler!({
        action_type: 'OPEN_SEARCH',
        params: { query: 'jazz cafe' },
      });
    });
    expect(searchResult).toBe('success');
    await waitFor(() => expect(screen.getByTestId('yt-results-popup')).toBeTruthy());
    expect(fetchYoutubeSearchResultsMock).toHaveBeenCalledWith('jazz cafe');
  });

  it('reports a failed search as an error instead of a successful open', async () => {
    await renderApp();
    fetchYoutubeSearchResultsMock.mockRejectedValueOnce(new Error('network down'));

    let searchResult: string | undefined;
    await act(async () => {
      searchResult = await capturedAgentHandler!({
        action_type: 'OPEN_SEARCH',
        params: { query: 'lofi', autoplay: '1' },
      });
    });
    // The window opened, but nothing is playing -- the caller must be able to
    // tell those apart, or it announces playback that never started.
    expect(searchResult).toContain('error');
    expect(searchResult).toContain('network down');
  });

  it('reports an empty result set as an error rather than success', async () => {
    await renderApp();
    fetchYoutubeSearchResultsMock.mockResolvedValueOnce([]);

    let searchResult: string | undefined;
    await act(async () => {
      searchResult = await capturedAgentHandler!({
        action_type: 'OPEN_SEARCH',
        params: { query: 'zzzz no such thing', autoplay: '1' },
      });
    });
    expect(searchResult).toContain('error');
    expect(searchResult).toContain('no results');
  });

  it('rejects an unknown agent action', async () => {
    await renderApp();
    let result: string | undefined;
    await act(async () => {
      result = await capturedAgentHandler!({ action_type: 'NOPE', params: {} });
    });
    expect(result).toContain('error');
  });
});

// ---------------------------------------------------------------------------
// Now-playing visibility for the agent: user playback is reported with the
// video title (PLAY_VIDEO), and state.json mirrors the current video so the
// agent surface can read it back on demand.
// ---------------------------------------------------------------------------

function lastPersistedState(): Record<string, unknown> | null {
  const lastCall = writeFileMock.mock.calls.at(-1) as unknown[] | undefined;
  return lastCall && lastCall.length > 1 ? (lastCall[1] as Record<string, unknown>) : null;
}

describe('YouTubeApp – now-playing agent visibility', () => {
  it('clicking a search result reports PLAY_VIDEO with the video title', async () => {
    await renderApp();
    await runSearch();

    fireEvent.click(screen.getByTestId('yt-result-card-vid-bbb'));

    await waitFor(() =>
      expect(reportActionMock).toHaveBeenCalledWith(3, 'PLAY_VIDEO', {
        video_id: 'vid-bbb',
        title: 'Second Fixture Video',
        channel: 'OpenRoom',
        queue: '',
      }),
    );
  });

  it('starting queue playback reports PLAY_VIDEO with the queue name', async () => {
    mockStateContent = stateWithPlaylist(QUEUE_PLAYLIST);
    await renderApp();
    await waitFor(() =>
      expect(screen.getByTestId('yt-playlist-summary').textContent).toContain('2'),
    );

    fireEvent.click(screen.getByTestId('yt-playlist-play-seq'));

    await waitFor(() =>
      expect(reportActionMock).toHaveBeenCalledWith(3, 'PLAY_VIDEO', {
        video_id: 'vid-aaa',
        title: 'First Fixture Video',
        channel: 'OpenRoom',
        queue: 'Queue Mix',
      }),
    );
  });

  it('jumping to another queue entry reports PLAY_VIDEO with the queue name', async () => {
    mockStateContent = stateWithPlaylist(QUEUE_PLAYLIST);
    await renderApp();
    await waitFor(() =>
      expect(screen.getByTestId('yt-playlist-summary').textContent).toContain('2'),
    );
    fireEvent.click(screen.getByTestId('yt-playlist-play-seq'));
    await waitFor(() => expect(screen.getByTestId('yt-results-popup')).toBeTruthy());

    fireEvent.click(screen.getByTestId('yt-result-card-vid-bbb'));

    await waitFor(() =>
      expect(reportActionMock).toHaveBeenCalledWith(3, 'PLAY_VIDEO', {
        video_id: 'vid-bbb',
        title: 'Second Fixture Video',
        channel: 'OpenRoom',
        queue: 'Queue Mix',
      }),
    );
  });

  it('previewing a playlist item reports PLAY_VIDEO without a queue name', async () => {
    mockStateContent = stateWithPlaylist(QUEUE_PLAYLIST);
    await renderApp();
    await waitFor(() =>
      expect(screen.getByTestId('yt-playlist-summary').textContent).toContain('2'),
    );

    fireEvent.click(screen.getByTestId('yt-playlist-item-vid-bbb'));

    await waitFor(() =>
      expect(reportActionMock).toHaveBeenCalledWith(3, 'PLAY_VIDEO', {
        video_id: 'vid-bbb',
        title: 'Second Fixture Video',
        channel: 'OpenRoom',
        queue: '',
      }),
    );
  });

  it('agent-triggered OPEN_VIDEO does not emit a duplicate PLAY_VIDEO report', async () => {
    await renderApp();

    await act(async () => {
      await capturedAgentHandler!({
        action_type: 'OPEN_VIDEO',
        params: { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
      });
    });
    await waitFor(() => expect(playerIframe()).not.toBeNull());

    expect(reportActionMock).not.toHaveBeenCalledWith(3, 'PLAY_VIDEO', expect.anything());
  });

  it('persists nowPlaying in state.json while playing and clears it on close', async () => {
    await renderApp();
    await runSearch();

    fireEvent.click(screen.getByTestId('yt-result-card-vid-aaa'));
    await waitFor(() => expect(playerIframe()).not.toBeNull());

    await waitFor(() => {
      const persisted = lastPersistedState();
      expect(persisted).not.toBeNull();
      expect(persisted!.nowPlaying).toMatchObject({
        videoId: 'vid-aaa',
        title: 'First Fixture Video',
        channel: 'OpenRoom',
        queueName: null,
      });
    });

    fireEvent.keyDown(document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('yt-results-popup')).toBeNull());

    await waitFor(() => {
      const persisted = lastPersistedState();
      expect(persisted).not.toBeNull();
      expect(persisted!.nowPlaying).toBeNull();
    });
  });

  it('a persisted nowPlaying claim self-heals to null after reload', async () => {
    mockStateContent = stateWithPlaylist(QUEUE_PLAYLIST, {
      nowPlaying: {
        videoId: 'vid-aaa',
        title: 'First Fixture Video',
        channel: 'OpenRoom',
        queueName: null,
        startedAt: 1,
        updatedAt: 1,
      },
    });
    await renderApp();

    // Nothing is playing after a fresh load, so the stale persisted claim is
    // rewritten to null by the live-derive effect.
    await waitFor(() => {
      const persisted = lastPersistedState();
      expect(persisted).not.toBeNull();
      expect(persisted!.nowPlaying).toBeNull();
    });
    expect(screen.queryByTestId('yt-results-popup')).toBeNull();
  });
});
