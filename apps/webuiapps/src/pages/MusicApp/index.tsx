import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowDown,
  ArrowUp,
  Search,
  ExternalLink,
  History,
  ListPlus,
  Minus,
  Play,
  Plus,
  Shuffle,
  Star,
  Home,
  Trash2,
  Sparkles,
  X,
  PlayCircle,
  ArrowLeft,
  PanelLeft,
  Repeat,
} from 'lucide-react';
import { initVibeApp, AppLifecycle } from '@gui/vibe-container';
import {
  useAgentActionListener,
  reportAction,
  reportLifecycle,
  fetchVibeInfo,
  createAppFileApi,
  ActionTriggerBy,
  type CharacterAppAction,
} from '@/lib';
import './i18n';
import {
  buildDirectResult,
  fetchYoutubeSearchResults,
  pickAutoplayResult,
  type YoutubeSearchResult,
} from './searchUtils';
import {
  addResultToPlaylist,
  buildPlaylistPlayback,
  createDefaultPlaylist,
  createPlaylist,
  createPlaylistItem,
  DEFAULT_PLAYLIST_NAME,
  ensureActivePlaylistId,
  movePlaylistItem,
  normalizePlaylists,
  normalizePlaylistItems,
  playlistItemsToResults,
  removePlaylistItem,
  resolvePlaylist,
  resolvePlaybackItems,
  rotatePlaybackOrder,
  type Playlist,
  type PlaylistItem,
  type PlaylistPlayback,
  type PlaylistPlaybackMode,
} from './playlistUtils';
import {
  buildEmbedUrl,
  clampPlayerZoom,
  MAX_PLAYER_ZOOM,
  MIN_PLAYER_ZOOM,
  PLAYER_ZOOM_STEP,
} from './playerUtils';
import {
  buildNowPlaying,
  buildPlayVideoParams,
  normalizeNowPlaying,
  type NowPlayingState,
} from './nowPlayingUtils';
import { APP_ID, APP_NAME, ReportedEvents, STATE_FILE } from './actions/constants';
import styles from './index.module.scss';

const MAX_RECENT_SEARCHES = 12;
const YOUTUBE_IFRAME_API_URL = 'https://www.youtube.com/iframe_api';

let youtubeIframeApiPromise: Promise<void> | null = null;

function loadYouTubeIframeApi(): Promise<void> {
  if (typeof window === 'undefined' || window.YT?.Player) {
    return Promise.resolve();
  }

  if (youtubeIframeApiPromise) {
    return youtubeIframeApiPromise;
  }

  youtubeIframeApiPromise = new Promise((resolve, reject) => {
    const existingScript = document.querySelector<HTMLScriptElement>(
      `script[src="${YOUTUBE_IFRAME_API_URL}"]`,
    );

    if (!existingScript) {
      const script = document.createElement('script');
      script.src = YOUTUBE_IFRAME_API_URL;
      script.async = true;
      script.onerror = () => reject(new Error('Failed to load YouTube iframe API'));
      document.head.appendChild(script);
    }

    const previousReady = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previousReady?.();
      resolve();
    };
  });

  return youtubeIframeApiPromise;
}

interface SearchEntry {
  id: string;
  query: string;
  createdAt: number;
}

interface AppState {
  searchQuery: string;
  recentSearches: SearchEntry[];
  favoriteTopics: string[];
  playlists: Playlist[];
  activePlaylistId: string | null;
  lastPlayedPlaylistId: string | null;
  lastPlayedPlaylistMode: PlaylistPlaybackMode | null;
  sidebarOpen: boolean;
  resultsAutoHide: boolean;
  loopPlayback: boolean;
  playerZoom: number;
  nowPlaying: NowPlayingState | null;
}

const youtubeFileApi = createAppFileApi(APP_NAME);

const DEFAULT_TOPICS = [
  'lofi hip hop',
  'deep focus music',
  'coding soundtrack',
  'space documentary',
  'jazz cafe',
  'korean study vlog',
];

const DEFAULT_STATE: AppState = {
  searchQuery: '',
  recentSearches: [],
  favoriteTopics: DEFAULT_TOPICS,
  playlists: [createDefaultPlaylist()],
  activePlaylistId: createDefaultPlaylist().id,
  lastPlayedPlaylistId: null,
  lastPlayedPlaylistMode: null,
  sidebarOpen: false,
  resultsAutoHide: false,
  loopPlayback: false,
  playerZoom: 1,
  nowPlaying: null,
};

function buildSearchUrl(query: string): string {
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
}

function buildHomeUrl(): string {
  return 'https://www.youtube.com/';
}

function normalizeState(raw: unknown): AppState {
  if (!raw || typeof raw !== 'object') return DEFAULT_STATE;
  const obj = raw as Partial<AppState>;
  const normalizedPlaylists = normalizePlaylists(obj.playlists);
  const legacyPlaylistName =
    typeof (obj as { playlistName?: unknown }).playlistName === 'string' &&
    (obj as { playlistName?: string }).playlistName?.trim()
      ? (obj as { playlistName?: string }).playlistName?.trim() || DEFAULT_PLAYLIST_NAME
      : DEFAULT_PLAYLIST_NAME;
  const legacyPlaylistItems = normalizePlaylistItems(
    (obj as { playlistItems?: unknown }).playlistItems,
  );
  const playlists =
    normalizedPlaylists.length > 0
      ? normalizedPlaylists
      : legacyPlaylistItems.length > 0 ||
          typeof (obj as { playlistName?: unknown }).playlistName === 'string'
        ? [createPlaylist(legacyPlaylistName, legacyPlaylistItems)]
        : [createDefaultPlaylist()];

  return {
    searchQuery: typeof obj.searchQuery === 'string' ? obj.searchQuery : '',
    recentSearches: Array.isArray(obj.recentSearches)
      ? obj.recentSearches
          .filter(
            (entry): entry is SearchEntry =>
              !!entry &&
              typeof entry === 'object' &&
              typeof (entry as SearchEntry).id === 'string' &&
              typeof (entry as SearchEntry).query === 'string' &&
              typeof (entry as SearchEntry).createdAt === 'number',
          )
          .slice(0, MAX_RECENT_SEARCHES)
      : [],
    favoriteTopics:
      Array.isArray(obj.favoriteTopics) &&
      obj.favoriteTopics.every((topic) => typeof topic === 'string')
        ? obj.favoriteTopics
        : DEFAULT_TOPICS,
    playlists,
    activePlaylistId: ensureActivePlaylistId(
      playlists,
      typeof obj.activePlaylistId === 'string' ? obj.activePlaylistId : null,
    ),
    lastPlayedPlaylistId:
      typeof obj.lastPlayedPlaylistId === 'string' ? obj.lastPlayedPlaylistId : null,
    lastPlayedPlaylistMode:
      obj.lastPlayedPlaylistMode === 'sequential' || obj.lastPlayedPlaylistMode === 'shuffle'
        ? obj.lastPlayedPlaylistMode
        : null,
    sidebarOpen: Boolean(obj.sidebarOpen),
    resultsAutoHide: Boolean(obj.resultsAutoHide),
    loopPlayback: Boolean(obj.loopPlayback),
    playerZoom:
      typeof obj.playerZoom === 'number'
        ? clampPlayerZoom(obj.playerZoom)
        : DEFAULT_STATE.playerZoom,
    nowPlaying: normalizeNowPlaying(obj.nowPlaying),
  };
}

const YouTubeApp: React.FC = () => {
  const { t } = useTranslation('musicApp');
  const [searchQuery, setSearchQuery] = useState('');
  const [recentSearches, setRecentSearches] = useState<SearchEntry[]>([]);
  const [favoriteTopics, setFavoriteTopics] = useState<string[]>(DEFAULT_TOPICS);
  const [playlists, setPlaylists] = useState<Playlist[]>(DEFAULT_STATE.playlists);
  const [activePlaylistId, setActivePlaylistId] = useState<string | null>(
    DEFAULT_STATE.activePlaylistId,
  );
  const [lastPlayedPlaylistId, setLastPlayedPlaylistId] = useState<string | null>(null);
  const [lastPlayedPlaylistMode, setLastPlayedPlaylistMode] = useState<PlaylistPlaybackMode | null>(
    null,
  );
  const [playlistNameDraft, setPlaylistNameDraft] = useState(DEFAULT_PLAYLIST_NAME);
  const [playlistPickerOpen, setPlaylistPickerOpen] = useState(false);
  const [newPlaylistDraft, setNewPlaylistDraft] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  // Mirror for agent handlers that may fire while the init effect is still
  // awaiting cloud state (cold open via dispatchAgentAction).
  const isLoadingRef = useRef(true);
  const [resultsOpen, setResultsOpen] = useState(false);
  const [resultQuery, setResultQuery] = useState('');
  const [searchResults, setSearchResults] = useState<YoutubeSearchResult[]>([]);
  const [selectedResult, setSelectedResult] = useState<YoutubeSearchResult | null>(null);
  const [activePlayback, setActivePlayback] = useState<PlaylistPlayback | null>(null);
  const [currentPlayingVideoId, setCurrentPlayingVideoId] = useState<string | null>(null);
  // One-shot autoplay target: the video id of a search hit that should auto-start
  // (set by an OPEN_SEARCH with autoplay). Matched by id so only that exact hit
  // autoplays; manual selection of any other result does not.
  const [autoplayVideoId, setAutoplayVideoId] = useState<string | null>(null);
  const [resultsLoading, setResultsLoading] = useState(false);
  const [resultsError, setResultsError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [resultsAutoHide, setResultsAutoHide] = useState(false);
  const [loopPlayback, setLoopPlayback] = useState(false);
  const [playerZoom, setPlayerZoom] = useState(DEFAULT_STATE.playerZoom);
  // Live-derived from the player state (see the sync effect below); persisted
  // so the agent surface can read the current video title from state.json.
  const [nowPlaying, setNowPlaying] = useState<NowPlayingState | null>(null);
  const [resultListHidden, setResultListHidden] = useState(false);
  const resultListAutoHiddenRef = useRef(false);
  const previousResultsAutoHideRef = useRef(false);
  const playerIframeRef = useRef<HTMLIFrameElement | null>(null);
  const youtubePlayerRef = useRef<YoutubeIframePlayer | null>(null);
  // Live mirrors for callbacks attached once per player instance.
  const loopPlaybackRef = useRef(false);
  const queueActiveRef = useRef(false);
  // Monotonic token so a stale (slow) search response cannot clobber a view
  // that was opened after the search started.
  const searchRequestSeqRef = useRef(0);

  const saveState = useCallback(async (nextState: AppState) => {
    try {
      await youtubeFileApi.writeFile(STATE_FILE, nextState);
    } catch (error) {
      console.error('[YouTubeApp] Failed to save state:', error);
    }
  }, []);

  // Reads state.json from the cloud and applies every field. Used both at
  // init and for the SYNC_STATE / PLAY_LAST_PLAYLIST agent actions. Returns
  // the normalized snapshot, or null when the state file has no content yet.
  const applyCloudState = useCallback(async (): Promise<AppState | null> => {
    const stateResult = await youtubeFileApi.readFile(STATE_FILE);
    if (!stateResult.content) return null;
    const parsed =
      typeof stateResult.content === 'string'
        ? JSON.parse(stateResult.content)
        : stateResult.content;
    const normalized = normalizeState(parsed);
    setSearchQuery(normalized.searchQuery);
    setRecentSearches(normalized.recentSearches);
    setFavoriteTopics(normalized.favoriteTopics);
    setPlaylists(normalized.playlists);
    setActivePlaylistId(normalized.activePlaylistId);
    setLastPlayedPlaylistId(normalized.lastPlayedPlaylistId);
    setLastPlayedPlaylistMode(normalized.lastPlayedPlaylistMode);
    setPlaylistNameDraft(
      resolvePlaylist(normalized.playlists, normalized.activePlaylistId)?.name ||
        DEFAULT_PLAYLIST_NAME,
    );
    setSidebarOpen(normalized.sidebarOpen);
    setResultsAutoHide(normalized.resultsAutoHide);
    setLoopPlayback(normalized.loopPlayback);
    setPlayerZoom(clampPlayerZoom(normalized.playerZoom));
    // nowPlaying is intentionally NOT restored: the live player is its only
    // source of truth. The sync effect below rewrites it right away, so a
    // stale persisted claim (app closed mid-playback) self-heals on reload
    // and an agent-written value can never fake an active playback.
    return normalized;
  }, []);

  const waitForInit = useCallback(async () => {
    if (!isLoadingRef.current) {
      return;
    }
    const deadline = Date.now() + 15_000;
    while (isLoadingRef.current && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }, []);

  const persistState = useCallback(
    (updater: (prev: AppState) => AppState) => {
      const currentState: AppState = {
        searchQuery,
        recentSearches,
        favoriteTopics,
        playlists,
        activePlaylistId,
        lastPlayedPlaylistId,
        lastPlayedPlaylistMode,
        sidebarOpen,
        resultsAutoHide,
        loopPlayback,
        playerZoom,
        nowPlaying,
      };
      const nextState = updater(currentState);
      setSearchQuery(nextState.searchQuery);
      setRecentSearches(nextState.recentSearches);
      setFavoriteTopics(nextState.favoriteTopics);
      setPlaylists(nextState.playlists);
      setActivePlaylistId(nextState.activePlaylistId);
      setLastPlayedPlaylistId(nextState.lastPlayedPlaylistId);
      setLastPlayedPlaylistMode(nextState.lastPlayedPlaylistMode);
      setSidebarOpen(nextState.sidebarOpen);
      setResultsAutoHide(nextState.resultsAutoHide);
      setLoopPlayback(nextState.loopPlayback);
      setPlayerZoom(clampPlayerZoom(nextState.playerZoom));
      void saveState(nextState);
    },
    [
      activePlaylistId,
      favoriteTopics,
      lastPlayedPlaylistId,
      lastPlayedPlaylistMode,
      loopPlayback,
      nowPlaying,
      playlists,
      playerZoom,
      recentSearches,
      resultsAutoHide,
      saveState,
      searchQuery,
      sidebarOpen,
    ],
  );

  const activePlaylist = useMemo(
    () => resolvePlaylist(playlists, activePlaylistId),
    [activePlaylistId, playlists],
  );

  const activePlaylistItems = activePlaylist?.items ?? [];
  const activePlaylistName = activePlaylist?.name || DEFAULT_PLAYLIST_NAME;

  const playbackPlaylist = useMemo(
    () =>
      activePlayback
        ? (playlists.find((playlist) => playlist.id === activePlayback.playlistId) ?? null)
        : null,
    [activePlayback, playlists],
  );

  const orderedPlaybackItems = useMemo(
    () => resolvePlaybackItems(playbackPlaylist?.items ?? [], activePlayback),
    [activePlayback, playbackPlaylist],
  );

  const currentPlaybackItem = useMemo(() => {
    if (!activePlayback) return selectedResult;
    return (
      orderedPlaybackItems.find((item) => item.id === currentPlayingVideoId) ||
      orderedPlaybackItems[0] ||
      selectedResult
    );
  }, [activePlayback, currentPlayingVideoId, orderedPlaybackItems, selectedResult]);

  const currentQueueVideoIds = activePlayback
    ? orderedPlaybackItems.map((item) => item.id)
    : currentPlaybackItem
      ? [currentPlaybackItem.id]
      : [];
  const queueStartVideoId = currentQueueVideoIds[0] || currentPlaybackItem?.id || '';
  const currentQueueKey = currentQueueVideoIds.join(',');
  const queueActive = currentQueueVideoIds.length > 1;

  const currentResultSavedInActivePlaylist = Boolean(
    selectedResult && activePlaylistItems.some((item) => item.id === selectedResult.id),
  );

  const playlistSummary = useMemo(
    () => t('playlist.count', { count: activePlaylistItems.length }),
    [activePlaylistItems.length, t],
  );

  const openResultsViewer = useCallback(
    ({
      title,
      results,
      selected,
      playback,
      hideResults = false,
      autoplay = false,
    }: {
      title: string;
      results: YoutubeSearchResult[];
      selected: YoutubeSearchResult | null;
      playback: PlaylistPlayback | null;
      hideResults?: boolean;
      autoplay?: boolean;
    }) => {
      searchRequestSeqRef.current += 1;
      setResultsOpen(true);
      setResultQuery(title);
      setSearchResults(results);
      setSelectedResult(selected);
      setActivePlayback(playback);
      setCurrentPlayingVideoId(selected?.id ?? null);
      setAutoplayVideoId(autoplay && selected ? selected.id : null);
      setResultListHidden(hideResults);
      resultListAutoHiddenRef.current = hideResults;
      setResultsLoading(false);
      setResultsError(null);
    },
    [],
  );

  // Reports what actually happened so an agent caller can be honest about it:
  // a failed fetch or an empty result set means nothing is playing, however
  // successfully the window opened.
  const submitSearch = useCallback(
    async (
      rawQuery?: string,
      triggerBy: ActionTriggerBy = ActionTriggerBy.User,
      options?: { autoplay?: boolean },
    ): Promise<{ ok: boolean; error?: string }> => {
      const query = (rawQuery ?? searchQuery).trim();
      if (!query) return { ok: false, error: 'missing query' };

      const createdAt = Date.now();
      const entry: SearchEntry = {
        id: `search_${createdAt}`,
        query,
        createdAt,
      };

      persistState((prev) => ({
        ...prev,
        searchQuery: query,
        recentSearches: [
          entry,
          ...prev.recentSearches.filter((item) => item.query !== query),
        ].slice(0, MAX_RECENT_SEARCHES),
      }));

      reportAction(APP_ID, 'OPEN_SEARCH', { query }, triggerBy);
      const requestSeq = searchRequestSeqRef.current + 1;
      searchRequestSeqRef.current = requestSeq;
      setResultsOpen(true);
      setAutoplayVideoId(null);
      // A queue is stopped because its item list is about to be replaced, but
      // a single playing video keeps running until the user picks a new one.
      if (activePlayback) {
        setActivePlayback(null);
        setCurrentPlayingVideoId(null);
        setSelectedResult(null);
      }
      setResultQuery(query);
      setResultListHidden(false);
      resultListAutoHiddenRef.current = false;
      setResultsLoading(true);
      setResultsError(null);
      try {
        const results = await fetchYoutubeSearchResults(query);
        // A newer search replaced this one, so what is on screen is not what
        // this call asked for.
        if (searchRequestSeqRef.current !== requestSeq) {
          return { ok: false, error: 'search superseded by a newer one' };
        }
        setSearchResults(results);
        if (options?.autoplay) {
          // Start the video the query actually names, not whatever YouTube
          // ranked first -- relevance order regularly puts a sibling upload on
          // top of the exact one that was asked for.
          const autoplayTarget = pickAutoplayResult(results, query);
          if (autoplayTarget) {
            setSelectedResult(autoplayTarget);
            setCurrentPlayingVideoId(autoplayTarget.id);
            setAutoplayVideoId(autoplayTarget.id);
          }
        }
        if (results.length === 0) {
          return { ok: false, error: `no results for "${query}"` };
        }
        return { ok: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (searchRequestSeqRef.current !== requestSeq) {
          return { ok: false, error: message };
        }
        setSearchResults([]);
        setResultsError(message);
        return { ok: false, error: message };
      } finally {
        if (searchRequestSeqRef.current === requestSeq) {
          setResultsLoading(false);
        }
      }
    },
    [activePlayback, persistState, searchQuery],
  );

  // Effect-only home open (no reportAction). The Agent handler reuses this so it
  // does NOT double-report: useAgentActionListener's sendResult already reports
  // the action back to the Agent. The user-facing openHome wraps this + reports.
  const doOpenHome = useCallback(() => {
    window.open(buildHomeUrl(), '_blank', 'noopener,noreferrer');
  }, []);

  const openHome = useCallback(() => {
    reportAction(APP_ID, 'OPEN_HOME', {});
    doOpenHome();
  }, [doOpenHome]);

  const addFavoriteTopic = useCallback(() => {
    const topic = searchQuery.trim();
    if (!topic) return;
    persistState((prev) => ({
      ...prev,
      favoriteTopics: prev.favoriteTopics.includes(topic)
        ? prev.favoriteTopics
        : [topic, ...prev.favoriteTopics].slice(0, 18),
    }));
  }, [persistState, searchQuery]);

  const removeFavoriteTopic = useCallback(
    (topic: string) => {
      persistState((prev) => ({
        ...prev,
        favoriteTopics: prev.favoriteTopics.filter((item) => item !== topic),
      }));
    },
    [persistState],
  );

  const clearRecentSearches = useCallback(() => {
    persistState((prev) => ({
      ...prev,
      recentSearches: [],
    }));
  }, [persistState]);

  const removeRecentSearch = useCallback(
    (entryId: string) => {
      persistState((prev) => ({
        ...prev,
        recentSearches: prev.recentSearches.filter((entry) => entry.id !== entryId),
      }));
    },
    [persistState],
  );

  const selectPlaylist = useCallback(
    (playlistId: string) => {
      persistState((prev) => ({
        ...prev,
        activePlaylistId: ensureActivePlaylistId(prev.playlists, playlistId),
      }));
    },
    [persistState],
  );

  const savePlaylistName = useCallback(() => {
    if (!activePlaylist) return;
    const nextName = playlistNameDraft.trim() || DEFAULT_PLAYLIST_NAME;
    setPlaylistNameDraft(nextName);
    persistState((prev) => ({
      ...prev,
      playlists: prev.playlists.map((playlist) =>
        playlist.id === activePlaylist.id
          ? {
              ...playlist,
              name: nextName,
              updatedAt: Date.now(),
            }
          : playlist,
      ),
    }));
  }, [activePlaylist, persistState, playlistNameDraft]);

  const createPlaylistByName = useCallback(
    (name?: string, initialItems: PlaylistItem[] = []) => {
      const trimmedName = (name || '').trim();
      const now = Date.now();
      const fallbackName = `${t('playlist.newPlaylistDefault')} ${playlists.length + 1}`;
      const nextPlaylist = createPlaylist(trimmedName || fallbackName, initialItems, now);

      persistState((prev) => ({
        ...prev,
        playlists: [...prev.playlists, nextPlaylist],
        activePlaylistId: nextPlaylist.id,
      }));
      setPlaylistNameDraft(nextPlaylist.name);
      setNewPlaylistDraft('');
      return nextPlaylist;
    },
    [persistState, playlists.length, t],
  );

  const closePlaylistPicker = useCallback(() => {
    setPlaylistPickerOpen(false);
    setNewPlaylistDraft('');
  }, []);

  const addSelectedResultToPlaylist = useCallback(
    (playlistId: string) => {
      if (!selectedResult) return;
      persistState((prev) => ({
        ...prev,
        playlists: prev.playlists.map((playlist) =>
          playlist.id === playlistId
            ? {
                ...playlist,
                items: addResultToPlaylist(playlist.items, selectedResult),
                updatedAt: Date.now(),
              }
            : playlist,
        ),
        activePlaylistId: playlistId,
      }));
      closePlaylistPicker();
    },
    [closePlaylistPicker, persistState, selectedResult],
  );

  const handleAddToPlaylistClick = useCallback(() => {
    if (!selectedResult || !activePlaylist) return;
    if (playlists.length <= 1) {
      addSelectedResultToPlaylist(activePlaylist.id);
      return;
    }
    setPlaylistPickerOpen(true);
  }, [activePlaylist, addSelectedResultToPlaylist, playlists.length, selectedResult]);

  const createPlaylistFromDraft = useCallback(
    (addCurrentVideo = false) => {
      const initialItems =
        addCurrentVideo && selectedResult ? [createPlaylistItem(selectedResult)] : [];
      const nextPlaylist = createPlaylistByName(newPlaylistDraft, initialItems);
      if (addCurrentVideo) {
        closePlaylistPicker();
      }
      return nextPlaylist;
    },
    [closePlaylistPicker, createPlaylistByName, newPlaylistDraft, selectedResult],
  );

  const previewPlaylistItem = useCallback(
    (playlistId: string, itemId: string) => {
      const targetPlaylist = resolvePlaylist(playlists, playlistId);
      const selectedItem = targetPlaylist?.items.find((item) => item.id === itemId) || null;
      if (!targetPlaylist || !selectedItem) return;
      selectPlaylist(targetPlaylist.id);
      // A playlist-item preview is a user click that starts that exact video.
      reportAction(APP_ID, ReportedEvents.PLAY_VIDEO, buildPlayVideoParams(selectedItem, null));
      openResultsViewer({
        title: targetPlaylist.name,
        results: playlistItemsToResults(targetPlaylist.items),
        selected: selectedItem,
        playback: null,
        hideResults: resultsAutoHide,
        autoplay: true,
      });
    },
    [openResultsViewer, playlists, resultsAutoHide, selectPlaylist],
  );

  const startPlaylistPlayback = useCallback(
    (playlistId: string, mode: PlaylistPlaybackMode, startItemId?: string) => {
      const targetPlaylist = resolvePlaylist(playlists, playlistId);
      if (!targetPlaylist) return;
      const playback = buildPlaylistPlayback(
        targetPlaylist.id,
        targetPlaylist.items,
        mode,
        startItemId,
      );
      if (!playback) return;
      const orderedItems = resolvePlaybackItems(targetPlaylist.items, playback);
      const orderedResults = playlistItemsToResults(orderedItems);
      persistState((prev) => ({
        ...prev,
        activePlaylistId: targetPlaylist.id,
        lastPlayedPlaylistId: targetPlaylist.id,
        lastPlayedPlaylistMode: mode,
      }));
      openResultsViewer({
        title: targetPlaylist.name,
        results: orderedResults,
        selected: orderedResults[0] ?? null,
        playback,
        hideResults: resultsAutoHide,
      });
      // Queue playback starts on a user click (this function has no agent
      // caller); report the first video with its title and queue name.
      if (orderedResults[0]) {
        reportAction(
          APP_ID,
          ReportedEvents.PLAY_VIDEO,
          buildPlayVideoParams(orderedResults[0], targetPlaylist.name),
        );
      }
    },
    [openResultsViewer, persistState, playlists, resultsAutoHide],
  );

  const playLastPlayedPlaylist = useCallback(async (): Promise<string> => {
    // Cold-open race: dispatchAgentAction opens YouTube and fires
    // PLAY_LAST_PLAYLIST as soon as the listener registers, often before the
    // init effect has applied state.json. Waiting + rehydrating avoids playing
    // from the empty DEFAULT_STATE and never wiping cloud playlists via a
    // stale persistState closure.
    await waitForInit();

    let snapshot: AppState | null = null;
    try {
      snapshot = await applyCloudState();
    } catch (error) {
      console.error('[YouTubeApp] Failed to rehydrate before playlist play:', error);
    }

    if (!snapshot) {
      snapshot = {
        searchQuery,
        recentSearches,
        favoriteTopics,
        playlists,
        activePlaylistId,
        lastPlayedPlaylistId,
        lastPlayedPlaylistMode,
        sidebarOpen,
        resultsAutoHide,
        loopPlayback,
        playerZoom,
        nowPlaying,
      };
    }

    const targetPlaylist =
      resolvePlaylist(snapshot.playlists, snapshot.lastPlayedPlaylistId) ||
      resolvePlaylist(snapshot.playlists, snapshot.activePlaylistId);

    if (!targetPlaylist || targetPlaylist.items.length === 0) {
      return 'error: no playlist available to play';
    }

    const mode = snapshot.lastPlayedPlaylistMode ?? 'sequential';
    const playback = buildPlaylistPlayback(targetPlaylist.id, targetPlaylist.items, mode);
    if (!playback) {
      return 'error: no playlist available to play';
    }

    const orderedItems = resolvePlaybackItems(targetPlaylist.items, playback);
    const orderedResults = playlistItemsToResults(orderedItems);
    const nextState: AppState = {
      ...snapshot,
      activePlaylistId: targetPlaylist.id,
      lastPlayedPlaylistId: targetPlaylist.id,
      lastPlayedPlaylistMode: mode,
    };
    setActivePlaylistId(nextState.activePlaylistId);
    setLastPlayedPlaylistId(nextState.lastPlayedPlaylistId);
    setLastPlayedPlaylistMode(nextState.lastPlayedPlaylistMode);
    setPlaylists(nextState.playlists);
    void saveState(nextState);
    openResultsViewer({
      title: targetPlaylist.name,
      results: orderedResults,
      selected: orderedResults[0] ?? null,
      playback,
      hideResults: snapshot.resultsAutoHide,
    });
    return 'success';
  }, [
    activePlaylistId,
    applyCloudState,
    favoriteTopics,
    lastPlayedPlaylistId,
    lastPlayedPlaylistMode,
    loopPlayback,
    nowPlaying,
    openResultsViewer,
    playlists,
    playerZoom,
    recentSearches,
    resultsAutoHide,
    saveState,
    searchQuery,
    sidebarOpen,
    waitForInit,
  ]);

  const removeItemFromPlaylist = useCallback(
    (playlistId: string, itemId: string) => {
      persistState((prev) => ({
        ...prev,
        playlists: prev.playlists.map((playlist) =>
          playlist.id === playlistId
            ? {
                ...playlist,
                items: removePlaylistItem(playlist.items, itemId),
                updatedAt: Date.now(),
              }
            : playlist,
        ),
      }));
    },
    [persistState],
  );

  const moveItemWithinPlaylist = useCallback(
    (playlistId: string, itemId: string, direction: 'up' | 'down') => {
      persistState((prev) => ({
        ...prev,
        playlists: prev.playlists.map((playlist) =>
          playlist.id === playlistId
            ? {
                ...playlist,
                items: movePlaylistItem(playlist.items, itemId, direction),
                updatedAt: Date.now(),
              }
            : playlist,
        ),
      }));
    },
    [persistState],
  );

  const clearPlaylist = useCallback(
    (playlistId: string) => {
      if (activePlayback?.playlistId === playlistId) {
        setActivePlayback(null);
      }
      persistState((prev) => ({
        ...prev,
        playlists: prev.playlists.map((playlist) =>
          playlist.id === playlistId
            ? {
                ...playlist,
                items: [],
                updatedAt: Date.now(),
              }
            : playlist,
        ),
      }));
    },
    [activePlayback?.playlistId, persistState],
  );

  const deletePlaylist = useCallback(
    (playlistId: string) => {
      if (playlists.length <= 1) return;

      const remainingPlaylists = playlists.filter((playlist) => playlist.id !== playlistId);
      const nextActivePlaylistId = ensureActivePlaylistId(
        remainingPlaylists,
        playlistId === activePlaylistId ? (remainingPlaylists[0]?.id ?? null) : activePlaylistId,
      );

      if (activePlayback?.playlistId === playlistId) {
        setActivePlayback(null);
      }

      persistState((prev) => ({
        ...prev,
        playlists: prev.playlists.filter((playlist) => playlist.id !== playlistId),
        activePlaylistId: nextActivePlaylistId,
      }));
    },
    [activePlayback?.playlistId, activePlaylistId, persistState, playlists],
  );

  const closeResultsViewer = useCallback(() => {
    setResultsOpen(false);
    setActivePlayback(null);
    setCurrentPlayingVideoId(null);
    setAutoplayVideoId(null);
    closePlaylistPicker();
  }, [closePlaylistPicker]);

  const toggleResultListVisibility = useCallback(() => {
    resultListAutoHiddenRef.current = false;
    setResultListHidden((prev) => !prev);
  }, []);

  const hideListAfterExplicitSelect = useCallback(() => {
    if (!resultsAutoHide) return;
    setResultListHidden(true);
    resultListAutoHiddenRef.current = true;
  }, [resultsAutoHide]);

  const handleResultSelect = useCallback(
    (result: YoutubeSearchResult) => {
      const player = youtubePlayerRef.current;

      // An explicit user pick is the playback signal the agent cares about:
      // report it with the video title so the agent knows what is playing.
      // Agent-triggered playback paths never call this handler, so the
      // sendResult/reportAction duplicate rule is not violated.
      const inQueue = Boolean(activePlayback && activePlayback.order.includes(result.id));
      reportAction(
        APP_ID,
        ReportedEvents.PLAY_VIDEO,
        buildPlayVideoParams(
          result,
          inQueue ? playbackPlaylist?.name || DEFAULT_PLAYLIST_NAME : null,
        ),
      );

      if (activePlayback && activePlayback.order.includes(result.id)) {
        // Jump inside the running queue without rebuilding it, so the visible
        // order stays stable and the player iframe is not remounted.
        if (player?.playVideoAt) {
          player.playVideoAt(activePlayback.order.indexOf(result.id));
        } else {
          setActivePlayback({
            ...activePlayback,
            order: rotatePlaybackOrder(activePlayback.order, result.id),
          });
        }
        setCurrentPlayingVideoId(result.id);
        setSelectedResult(result);
        hideListAfterExplicitSelect();
        return;
      }

      setActivePlayback(null);
      if (selectedResult?.id === result.id && player) {
        // Same card re-clicked: start/resume it, or pull the embed back if it
        // navigated to a related video inside the iframe.
        if (currentPlayingVideoId !== result.id && player.loadVideoById) {
          player.loadVideoById(result.id);
        } else {
          player.playVideo?.();
        }
      } else {
        setAutoplayVideoId(result.id);
        setSelectedResult(result);
      }
      setCurrentPlayingVideoId(result.id);
      hideListAfterExplicitSelect();
    },
    [
      activePlayback,
      currentPlayingVideoId,
      hideListAfterExplicitSelect,
      playbackPlaylist,
      selectedResult,
    ],
  );

  const quickTopics = useMemo(
    () =>
      favoriteTopics
        .slice(0, 6)
        .concat(DEFAULT_TOPICS)
        .filter((topic, index, arr) => arr.indexOf(topic) === index)
        .slice(0, 8),
    [favoriteTopics],
  );

  useAgentActionListener(
    APP_ID,
    useCallback(
      async (action: CharacterAppAction): Promise<string> => {
        switch (action.action_type) {
          case 'OPEN_SEARCH': {
            const query = action.params?.query?.trim();
            if (!query) return 'error: missing query';
            // Same cold-open race as PLAY_LAST_PLAYLIST: dispatchAgentAction
            // opens YouTube and fires OPEN_SEARCH as soon as the listener
            // registers, which can beat the init effect's applyCloudState.
            // Without the wait, submitSearch persists over DEFAULT_STATE and
            // the arriving state.json then restores the PREVIOUS query into
            // the search box while Aoi's pick is what actually plays.
            await waitForInit();
            const outcome = await submitSearch(query, ActionTriggerBy.Agent, {
              autoplay: action.params?.autoplay === '1',
            });
            // The window opening is not the same as the search working. Report
            // a failed fetch or an empty result set so the caller does not
            // announce playback that never started.
            if (!outcome.ok) {
              return `error: ${outcome.error ?? 'search failed'}`;
            }
            return 'success';
          }
          case 'PLAY_LAST_PLAYLIST': {
            return await playLastPlayedPlaylist();
          }
          case 'OPEN_HOME': {
            doOpenHome();
            return 'success';
          }
          case 'OPEN_VIDEO': {
            const url = action.params?.url?.trim();
            if (!url) return 'error: missing url';
            const direct = buildDirectResult(url);
            if (!direct) return 'error: invalid youtube url';
            openResultsViewer({
              title: url,
              results: [direct],
              selected: direct,
              playback: null,
              hideResults: resultsAutoHide,
              autoplay: action.params?.autoplay !== '0',
            });
            return 'success';
          }
          case 'SYNC_STATE': {
            try {
              const restored = await applyCloudState();
              return restored ? 'success' : 'error: state.json not found';
            } catch (error) {
              return `error: ${error instanceof Error ? error.message : String(error)}`;
            }
          }
          default:
            return `error: unknown action_type ${action.action_type}`;
        }
      },
      [
        applyCloudState,
        doOpenHome,
        openResultsViewer,
        playLastPlayedPlaylist,
        resultsAutoHide,
        submitSearch,
        waitForInit,
      ],
    ),
  );

  useEffect(() => {
    const init = async () => {
      try {
        reportLifecycle(AppLifecycle.LOADING);

        const manager = await initVibeApp({
          id: APP_ID,
          url: window.location.href,
          type: 'page',
          name: 'YouTube',
          windowStyle: { width: 1100, height: 760 },
        });

        manager.handshake({
          id: APP_ID,
          url: window.location.href,
          type: 'page',
          name: 'YouTube',
          windowStyle: { width: 1100, height: 760 },
        });

        reportLifecycle(AppLifecycle.DOM_READY);
        await fetchVibeInfo();

        try {
          const restored = await applyCloudState();
          if (!restored) {
            await saveState(DEFAULT_STATE);
          }
        } catch {
          await saveState(DEFAULT_STATE);
        }

        isLoadingRef.current = false;
        setIsLoading(false);
        reportLifecycle(AppLifecycle.LOADED);
        manager.ready();
      } catch (error) {
        console.error('[YouTubeApp] Init error:', error);
        isLoadingRef.current = false;
        setIsLoading(false);
        reportLifecycle(AppLifecycle.ERROR, String(error));
      }
    };

    void init();

    return () => {
      reportLifecycle(AppLifecycle.UNLOADING);
      reportLifecycle(AppLifecycle.DESTROYED);
    };
  }, [applyCloudState, saveState]);

  useEffect(() => {
    if (isLoading) return;
    void saveState({
      searchQuery,
      recentSearches,
      favoriteTopics,
      playlists,
      activePlaylistId,
      lastPlayedPlaylistId,
      lastPlayedPlaylistMode,
      sidebarOpen,
      resultsAutoHide,
      loopPlayback,
      playerZoom,
      nowPlaying,
    });
  }, [
    favoriteTopics,
    isLoading,
    loopPlayback,
    nowPlaying,
    playlists,
    activePlaylistId,
    recentSearches,
    resultsAutoHide,
    saveState,
    searchQuery,
    sidebarOpen,
    playerZoom,
    lastPlayedPlaylistId,
    lastPlayedPlaylistMode,
  ]);

  // Auto-hide reacts only to the toggle itself and to the selection being
  // cleared. Hiding on selection changes is handled by explicit user picks
  // (handleResultSelect / openResultsViewer); doing it here as well used to
  // slam the list shut on programmatic changes such as queue auto-advance or
  // search results arriving.
  useEffect(() => {
    const previousResultsAutoHide = previousResultsAutoHideRef.current;
    const autoHideEnabledNow = resultsAutoHide && !previousResultsAutoHide;
    const autoHideDisabledNow = !resultsAutoHide && previousResultsAutoHide;

    if (!selectedResult) {
      setResultListHidden(false);
      resultListAutoHiddenRef.current = false;
    } else if (resultsOpen && autoHideEnabledNow) {
      setResultListHidden(true);
      resultListAutoHiddenRef.current = true;
    } else if (autoHideDisabledNow && resultListAutoHiddenRef.current) {
      setResultListHidden(false);
      resultListAutoHiddenRef.current = false;
    }

    previousResultsAutoHideRef.current = resultsAutoHide;
  }, [resultsAutoHide, resultsOpen, selectedResult]);

  useEffect(() => {
    setPlaylistNameDraft(activePlaylistName);
  }, [activePlaylistName]);

  useEffect(() => {
    if (!activePlayback) return;

    const nextItems = resolvePlaybackItems(playbackPlaylist?.items ?? [], activePlayback);
    if (nextItems.length === 0) {
      setActivePlayback(null);
      setCurrentPlayingVideoId(null);
      setSelectedResult(null);
      setSearchResults([]);
      return;
    }

    const nextOrder = nextItems.map((item) => item.id);
    if (nextOrder.join('|') !== activePlayback.order.join('|')) {
      setActivePlayback((prev) =>
        prev
          ? {
              ...prev,
              order: nextOrder,
            }
          : prev,
      );
    }

    setSearchResults(playlistItemsToResults(nextItems));
    const nextCurrentVideoId =
      currentPlayingVideoId && nextOrder.includes(currentPlayingVideoId)
        ? currentPlayingVideoId
        : nextItems[0]?.id || null;
    setCurrentPlayingVideoId(nextCurrentVideoId);
    if (nextCurrentVideoId) {
      const matchingItem =
        nextItems.find((item) => item.id === nextCurrentVideoId) || nextItems[0] || null;
      setSelectedResult(matchingItem);
    }
  }, [activePlayback, currentPlayingVideoId, playbackPlaylist]);

  useEffect(() => {
    if (!activePlayback) return;
    setResultQuery(playbackPlaylist?.name || DEFAULT_PLAYLIST_NAME);
  }, [activePlayback, playbackPlaylist]);

  // Mirror the video currently loaded in the viewer into the persisted
  // now-playing snapshot. This also tracks queue auto-advance (which is not a
  // user action and therefore never reported), so state.json always answers
  // "which video is on screen right now" for the agent surface.
  useEffect(() => {
    if (isLoading) return;
    const playingItem = resultsOpen ? currentPlaybackItem : null;
    setNowPlaying((prev) => {
      if (!playingItem) {
        return prev === null ? prev : null;
      }
      const queueName = activePlayback ? playbackPlaylist?.name || DEFAULT_PLAYLIST_NAME : null;
      if (prev && prev.videoId === playingItem.id && prev.queueName === queueName) {
        return prev;
      }
      return buildNowPlaying(playingItem, queueName, Date.now(), prev);
    });
  }, [activePlayback, currentPlaybackItem, isLoading, playbackPlaylist, resultsOpen]);

  useEffect(() => {
    loopPlaybackRef.current = loopPlayback;
  }, [loopPlayback]);

  useEffect(() => {
    queueActiveRef.current = queueActive;
  }, [queueActive]);

  // Apply loop changes live through the iframe API so toggling loop never
  // reloads the iframe (which used to restart the video from the beginning).
  useEffect(() => {
    youtubePlayerRef.current?.setLoop?.(queueActive && loopPlayback);
  }, [loopPlayback, queueActive]);

  useEffect(() => {
    if (!resultsOpen || !queueStartVideoId || !playerIframeRef.current) return;

    let cancelled = false;
    let syncTimer: number | null = null;

    const syncCurrentVideoId = () => {
      const nextVideoId = youtubePlayerRef.current?.getVideoData()?.video_id || null;
      if (!cancelled && nextVideoId) {
        setCurrentPlayingVideoId(nextVideoId);
      }
    };

    void loadYouTubeIframeApi()
      .then(() => {
        if (cancelled || !playerIframeRef.current || !window.YT?.Player) return;

        youtubePlayerRef.current?.destroy();
        youtubePlayerRef.current = new window.YT.Player(playerIframeRef.current, {
          events: {
            onReady: () => {
              youtubePlayerRef.current?.setLoop?.(
                queueActiveRef.current && loopPlaybackRef.current,
              );
              syncCurrentVideoId();
            },
            onStateChange: (event) => {
              if (!window.YT?.PlayerState) return;
              if (event.data === window.YT.PlayerState.ENDED) {
                // Native loop only exists for queue embeds; a single video is
                // looped manually so the iframe never has to reload.
                if (!queueActiveRef.current && loopPlaybackRef.current) {
                  youtubePlayerRef.current?.seekTo?.(0, true);
                  youtubePlayerRef.current?.playVideo?.();
                }
                return;
              }
              const trackedStates: number[] = [
                window.YT.PlayerState.PLAYING,
                window.YT.PlayerState.BUFFERING,
                window.YT.PlayerState.PAUSED,
                window.YT.PlayerState.CUED,
              ];
              if (trackedStates.includes(event.data)) {
                syncCurrentVideoId();
              }
            },
          },
        });

        syncTimer = window.setInterval(syncCurrentVideoId, 1000);
      })
      .catch((error) => {
        console.error('[YouTubeApp] Failed to initialize iframe API:', error);
      });

    return () => {
      cancelled = true;
      if (syncTimer !== null) {
        window.clearInterval(syncTimer);
      }
      youtubePlayerRef.current?.destroy();
      youtubePlayerRef.current = null;
    };
  }, [resultsOpen, queueStartVideoId, currentQueueKey]);

  // The viewer is closed with the explicit close button or Escape. Clicking
  // the dark backdrop no longer closes it: a stray click while a video plays
  // used to silently kill playback and drop the user back to the main screen.
  useEffect(() => {
    if (!resultsOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing) return;
      if (playlistPickerOpen) {
        closePlaylistPicker();
        return;
      }
      closeResultsViewer();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [closePlaylistPicker, closeResultsViewer, playlistPickerOpen, resultsOpen]);

  if (isLoading) {
    return (
      <div className={styles.youtubeApp}>
        <div className={styles.loading}>Loading YouTube...</div>
      </div>
    );
  }

  return (
    <div className={`${styles.youtubeApp} ${!sidebarOpen ? styles.sidebarClosed : ''}`}>
      <aside className={`${styles.sidebar} ${!sidebarOpen ? styles.sidebarHidden : ''}`}>
        <div className={styles.sidebarTitle}>{t('sidebar.library')}</div>
        <button className={styles.homeButton} onClick={openHome}>
          <Home size={18} />
          <span>{t('home.openYoutube')}</span>
        </button>

        <div className={styles.sidebarSection}>
          <div className={styles.sectionTitle}>{t('sidebar.playlists')}</div>
          <div className={styles.favoriteList}>
            {favoriteTopics.map((topic) => (
              <div key={topic} className={styles.favoriteItem}>
                <button className={styles.favoriteTopic} onClick={() => void submitSearch(topic)}>
                  {topic}
                </button>
                <button className={styles.removeTopic} onClick={() => removeFavoriteTopic(topic)}>
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        </div>

        <div className={styles.sidebarSection}>
          <div className={styles.sectionTitle}>{t('playlist.collectionTitle')}</div>
          <div className={styles.sidebarPlaylistList}>
            {playlists.map((playlist) => (
              <div
                key={playlist.id}
                className={`${styles.sidebarPlaylistCard} ${
                  activePlaylistId === playlist.id ? styles.sidebarPlaylistCardActive : ''
                }`}
              >
                <button
                  className={styles.sidebarPlaylistMeta}
                  onClick={() => selectPlaylist(playlist.id)}
                >
                  <strong className={styles.sidebarPlaylistName}>{playlist.name}</strong>
                  <span className={styles.sidebarPlaylistCount}>
                    {t('playlist.count', { count: playlist.items.length })}
                  </span>
                </button>
                <div className={styles.sidebarPlaylistActions}>
                  <button
                    className={styles.iconButton}
                    onClick={() => startPlaylistPlayback(playlist.id, 'sequential')}
                    disabled={playlist.items.length === 0}
                    title={t('playlist.playSequential')}
                  >
                    <Play size={15} />
                  </button>
                  <button
                    className={styles.iconButton}
                    onClick={() => startPlaylistPlayback(playlist.id, 'shuffle')}
                    disabled={playlist.items.length === 0}
                    title={t('playlist.playShuffle')}
                  >
                    <Shuffle size={15} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </aside>

      <main className={styles.main}>
        <div className={styles.topBar}>
          <button className={styles.sidebarToggle} onClick={() => setSidebarOpen((prev) => !prev)}>
            <PanelLeft size={16} />
            <span>{sidebarOpen ? t('sidebar.hide') : t('sidebar.show')}</span>
          </button>
        </div>
        <div className={styles.hero}>
          <div className={styles.heroCopy}>
            <div className={styles.badge}>
              <Sparkles size={14} />
              <span>{t('hero.badge')}</span>
            </div>
            <h1 className={styles.heroTitle}>{t('hero.title')}</h1>
            <p className={styles.heroDescription}>{t('hero.description')}</p>
          </div>

          <div className={styles.searchCard}>
            <div className={styles.searchRow}>
              <Search size={18} className={styles.searchIcon} />
              <input
                className={styles.searchInput}
                data-testid="yt-search-input"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) void submitSearch();
                }}
                placeholder={t('search.placeholder')}
              />
              <button
                className={styles.searchButton}
                data-testid="yt-search-submit"
                onClick={() => void submitSearch()}
              >
                {t('search.action')}
              </button>
            </div>

            <div className={styles.searchActions}>
              <button className={styles.secondaryButton} onClick={addFavoriteTopic}>
                <Star size={16} />
                <span>{t('search.saveTopic')}</span>
              </button>
              <button className={styles.secondaryButton} onClick={openHome}>
                <ExternalLink size={16} />
                <span>{t('search.openHome')}</span>
              </button>
            </div>
          </div>
        </div>

        <section className={styles.quickTopics}>
          {quickTopics.map((topic) => (
            <button
              key={topic}
              className={styles.topicChip}
              onClick={() => void submitSearch(topic)}
            >
              {topic}
            </button>
          ))}
        </section>

        <section className={styles.panelGrid}>
          <section className={styles.panel}>
            <div className={styles.panelHeader}>
              <div className={styles.panelTitleWrap}>
                <History size={18} />
                <h2 className={styles.panelTitle}>{t('recent.title')}</h2>
              </div>
              {recentSearches.length > 0 && (
                <button className={styles.textButton} onClick={clearRecentSearches}>
                  {t('recent.clear')}
                </button>
              )}
            </div>

            {recentSearches.length === 0 ? (
              <div className={styles.emptyState}>{t('recent.empty')}</div>
            ) : (
              <div className={styles.recentList}>
                {recentSearches.map((entry) => (
                  <div key={entry.id} className={styles.recentItem}>
                    <button
                      className={styles.recentItemButton}
                      onClick={() => void submitSearch(entry.query)}
                    >
                      <span className={styles.recentQuery}>{entry.query}</span>
                      <span className={styles.recentTime}>
                        {new Date(entry.createdAt).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                    </button>
                    <button
                      className={styles.recentRemoveButton}
                      onClick={() => removeRecentSearch(entry.id)}
                      title={t('recent.removeItem')}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className={styles.panel}>
            <div className={styles.panelHeader}>
              <div className={styles.panelTitleWrap}>
                <ListPlus size={18} />
                <h2 className={styles.panelTitle}>{t('playlist.title')}</h2>
              </div>
              <span className={styles.panelMeta} data-testid="yt-playlist-summary">
                {activePlaylist ? playlistSummary : t('playlist.noPlaylistSelected')}
              </span>
            </div>

            <div className={styles.playlistTabs}>
              {playlists.map((playlist) => (
                <button
                  key={playlist.id}
                  className={`${styles.playlistTab} ${
                    activePlaylistId === playlist.id ? styles.playlistTabActive : ''
                  }`}
                  onClick={() => selectPlaylist(playlist.id)}
                >
                  <span className={styles.playlistTabName}>{playlist.name}</span>
                  <span className={styles.playlistTabMeta}>
                    {t('playlist.count', { count: playlist.items.length })}
                  </span>
                </button>
              ))}
            </div>

            <div className={styles.playlistCreateRow}>
              <input
                className={styles.playlistNameInput}
                data-testid="yt-new-playlist-input"
                value={newPlaylistDraft}
                onChange={(event) => setNewPlaylistDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    createPlaylistFromDraft(false);
                  }
                }}
                placeholder={t('playlist.newPlaylistPlaceholder')}
              />
              <button
                className={styles.secondaryButton}
                data-testid="yt-create-playlist"
                onClick={() => createPlaylistFromDraft(false)}
              >
                <Plus size={16} />
                <span>{t('playlist.create')}</span>
              </button>
            </div>

            {activePlaylist ? (
              <>
                <div className={styles.playlistEditor}>
                  <label className={styles.playlistLabel} htmlFor="playlist-name">
                    {t('playlist.nameLabel')}
                  </label>
                  <div className={styles.playlistNameRow}>
                    <input
                      id="playlist-name"
                      className={styles.playlistNameInput}
                      value={playlistNameDraft}
                      onChange={(event) => setPlaylistNameDraft(event.target.value)}
                      onBlur={savePlaylistName}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                          event.preventDefault();
                          savePlaylistName();
                        }
                      }}
                      placeholder={t('playlist.namePlaceholder')}
                    />
                    <button className={styles.secondaryButton} onClick={savePlaylistName}>
                      {t('playlist.saveName')}
                    </button>
                  </div>
                </div>

                <div className={styles.playlistToolbar}>
                  <button
                    className={styles.secondaryButton}
                    onClick={handleAddToPlaylistClick}
                    disabled={
                      !selectedResult ||
                      (playlists.length === 1 && currentResultSavedInActivePlaylist)
                    }
                  >
                    <ListPlus size={16} />
                    <span>{t('playlist.addCurrent')}</span>
                  </button>
                  <button
                    className={styles.secondaryButton}
                    data-testid="yt-playlist-play-seq"
                    onClick={() => startPlaylistPlayback(activePlaylist.id, 'sequential')}
                    disabled={activePlaylistItems.length === 0}
                  >
                    <Play size={16} />
                    <span>{t('playlist.playSequential')}</span>
                  </button>
                  <button
                    className={styles.secondaryButton}
                    onClick={() => startPlaylistPlayback(activePlaylist.id, 'shuffle')}
                    disabled={activePlaylistItems.length === 0}
                  >
                    <Shuffle size={16} />
                    <span>{t('playlist.playShuffle')}</span>
                  </button>
                  <button
                    className={styles.textButton}
                    onClick={() => clearPlaylist(activePlaylist.id)}
                    disabled={activePlaylistItems.length === 0}
                  >
                    {t('playlist.clear')}
                  </button>
                  <button
                    className={styles.textButton}
                    data-testid="yt-playlist-delete"
                    onClick={() => deletePlaylist(activePlaylist.id)}
                    disabled={playlists.length <= 1}
                  >
                    {t('playlist.delete')}
                  </button>
                </div>

                {activePlaylistItems.length === 0 ? (
                  <div className={styles.playlistEmpty}>
                    <strong>{t('playlist.empty')}</strong>
                    <span>{t('playlist.emptyHint')}</span>
                  </div>
                ) : (
                  <div className={styles.playlistList}>
                    {activePlaylistItems.map((item, index) => (
                      <div
                        key={item.id}
                        className={`${styles.playlistItem} ${
                          currentPlaybackItem?.id === item.id ? styles.playlistItemActive : ''
                        }`}
                      >
                        <button
                          className={styles.playlistItemMain}
                          data-testid={`yt-playlist-item-${item.id}`}
                          onClick={() => previewPlaylistItem(activePlaylist.id, item.id)}
                        >
                          <div className={styles.playlistThumbWrap}>
                            {item.thumbnail ? (
                              <img
                                src={item.thumbnail}
                                alt={item.title}
                                className={styles.playlistThumb}
                              />
                            ) : (
                              <div className={styles.playlistThumbFallback}>
                                <PlayCircle size={20} />
                              </div>
                            )}
                          </div>
                          <div className={styles.playlistItemInfo}>
                            <strong className={styles.playlistItemTitle}>
                              {index + 1}. {item.title}
                            </strong>
                            <span className={styles.playlistItemMeta}>
                              {[item.channel, item.duration].filter(Boolean).join(' • ')}
                            </span>
                          </div>
                        </button>
                        <div className={styles.playlistItemActions}>
                          <button
                            className={styles.iconButton}
                            onClick={() =>
                              startPlaylistPlayback(activePlaylist.id, 'sequential', item.id)
                            }
                            title={t('playlist.playFromHere')}
                          >
                            <Play size={15} />
                          </button>
                          <button
                            className={styles.iconButton}
                            onClick={() => moveItemWithinPlaylist(activePlaylist.id, item.id, 'up')}
                            disabled={index === 0}
                            title={t('playlist.moveUp')}
                          >
                            <ArrowUp size={15} />
                          </button>
                          <button
                            className={styles.iconButton}
                            onClick={() =>
                              moveItemWithinPlaylist(activePlaylist.id, item.id, 'down')
                            }
                            disabled={index === activePlaylistItems.length - 1}
                            title={t('playlist.moveDown')}
                          >
                            <ArrowDown size={15} />
                          </button>
                          <button
                            className={styles.iconButton}
                            onClick={() => removeItemFromPlaylist(activePlaylist.id, item.id)}
                            title={t('playlist.removeItem')}
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <div className={styles.playlistEmpty}>
                <strong>{t('playlist.noPlaylistSelected')}</strong>
                <span>{t('playlist.createFirstHint')}</span>
              </div>
            )}
          </section>
        </section>
      </main>

      {resultsOpen && (
        <div className={styles.popupOverlay} data-testid="yt-results-popup">
          <div className={styles.popupCard}>
            <div className={styles.popupHeader}>
              <div className={styles.popupTitleWrap}>
                <span className={styles.popupEyebrow}>{t('popup.label')}</span>
                <strong className={styles.popupTitle} data-testid="yt-popup-title">
                  {activePlayback
                    ? playbackPlaylist?.name || DEFAULT_PLAYLIST_NAME
                    : resultQuery || t('popup.defaultTitle')}
                </strong>
              </div>
              <div className={styles.popupActions}>
                {selectedResult && resultListHidden ? (
                  <button
                    className={styles.popupAction}
                    data-testid="yt-back-to-results"
                    onClick={toggleResultListVisibility}
                  >
                    <ArrowLeft size={16} />
                    <span>{t('popup.backToResults')}</span>
                  </button>
                ) : null}
                <button
                  className={`${styles.popupAction} ${resultsAutoHide ? styles.popupActionActive : ''}`}
                  onClick={() => setResultsAutoHide((prev) => !prev)}
                >
                  <PanelLeft size={16} />
                  <span>
                    {t('popup.autoHide')}:{' '}
                    {resultsAutoHide ? t('popup.autoHideOn') : t('popup.autoHideOff')}
                  </span>
                </button>
                <button
                  className={styles.popupAction}
                  onClick={() =>
                    window.open(
                      selectedResult?.url || buildSearchUrl(resultQuery),
                      '_blank',
                      'noopener,noreferrer',
                    )
                  }
                >
                  <ExternalLink size={16} />
                  <span>{t('popup.openExternal')}</span>
                </button>
                <button
                  className={styles.popupClose}
                  data-testid="yt-popup-close"
                  onClick={closeResultsViewer}
                >
                  <X size={18} />
                </button>
              </div>
            </div>
            <div className={styles.popupHint}>
              {activePlayback ? t('playlist.queueHint') : t('popup.hint')}
            </div>
            <div
              className={`${styles.resultLayout} ${
                resultListHidden ? styles.resultLayoutCollapsed : ''
              }`}
            >
              <div
                className={`${styles.resultList} ${
                  resultListHidden ? styles.resultListHidden : ''
                }`}
              >
                {resultsLoading ? (
                  <div className={styles.resultEmpty}>{t('popup.loading')}</div>
                ) : resultsError ? (
                  <div className={styles.resultEmpty}>{resultsError}</div>
                ) : searchResults.length === 0 ? (
                  <div className={styles.resultEmpty}>{t('popup.empty')}</div>
                ) : (
                  searchResults.map((result) => (
                    <button
                      key={result.id}
                      className={`${styles.resultCard} ${selectedResult?.id === result.id ? styles.resultCardActive : ''}`}
                      data-testid={`yt-result-card-${result.id}`}
                      onClick={() => handleResultSelect(result)}
                    >
                      <div className={styles.resultThumbWrap}>
                        {result.thumbnail ? (
                          <img
                            src={result.thumbnail}
                            alt={result.title}
                            className={styles.resultThumb}
                          />
                        ) : (
                          <div className={styles.resultThumbFallback}>
                            <PlayCircle size={28} />
                          </div>
                        )}
                        {result.duration ? (
                          <span className={styles.resultDuration}>{result.duration}</span>
                        ) : null}
                      </div>
                      <div className={styles.resultInfo}>
                        <strong className={styles.resultTitle}>{result.title}</strong>
                        <span className={styles.resultMeta}>{result.channel}</span>
                        <span className={styles.resultMeta}>
                          {[result.views, result.published].filter(Boolean).join(' • ')}
                        </span>
                      </div>
                    </button>
                  ))
                )}
              </div>

              <div
                className={`${styles.playerPane} ${resultListHidden ? styles.playerPaneExpanded : ''}`}
              >
                {currentPlaybackItem ? (
                  <>
                    <div className={styles.playerHeader}>
                      <div className={styles.playerTitleBlock}>
                        <span className={styles.popupEyebrow}>{t('popup.nowPlaying')}</span>
                        <strong className={styles.playerTitle} data-testid="yt-player-title">
                          {currentPlaybackItem.title}
                        </strong>
                        {activePlayback ? (
                          <span className={styles.playerQueueBadge}>
                            {activePlayback.mode === 'shuffle'
                              ? t('playlist.queueShuffle')
                              : t('playlist.queueSequential')}
                          </span>
                        ) : null}
                      </div>
                      {searchResults.length > 0 && (
                        <button className={styles.popupAction} onClick={toggleResultListVisibility}>
                          <PanelLeft size={16} />
                          <span>
                            {resultListHidden ? t('popup.showResults') : t('popup.hideResults')}
                          </span>
                        </button>
                      )}
                      <div className={styles.playerControls}>
                        <button
                          className={`${styles.popupAction} ${loopPlayback ? styles.popupActionActive : ''}`}
                          data-testid="yt-loop-toggle"
                          onClick={() => setLoopPlayback((prev) => !prev)}
                        >
                          <Repeat size={16} />
                          <span>
                            {t('popup.loopPlayback')}:{' '}
                            {loopPlayback ? t('popup.loopOn') : t('popup.loopOff')}
                          </span>
                        </button>
                        <button
                          className={`${styles.popupAction} ${
                            currentResultSavedInActivePlaylist ? styles.popupActionActive : ''
                          }`}
                          data-testid="yt-add-current"
                          onClick={handleAddToPlaylistClick}
                          disabled={
                            !selectedResult ||
                            (playlists.length === 1 && currentResultSavedInActivePlaylist)
                          }
                        >
                          <ListPlus size={16} />
                          <span>{t('playlist.addCurrent')}</span>
                        </button>
                        <div className={styles.playerZoomControls}>
                          <span className={styles.playerZoomValue}>
                            {t('popup.zoomLabel')} {Math.round(playerZoom * 100)}%
                          </span>
                          <button
                            className={styles.popupAction}
                            onClick={() =>
                              setPlayerZoom((prev) => clampPlayerZoom(prev - PLAYER_ZOOM_STEP))
                            }
                            disabled={playerZoom <= MIN_PLAYER_ZOOM}
                          >
                            <Minus size={16} />
                            <span>{t('popup.zoomOut')}</span>
                          </button>
                          <button
                            className={styles.popupAction}
                            onClick={() => setPlayerZoom(1)}
                            disabled={playerZoom === 1}
                          >
                            <span>{t('popup.zoomReset')}</span>
                          </button>
                          <button
                            className={styles.popupAction}
                            onClick={() =>
                              setPlayerZoom((prev) => clampPlayerZoom(prev + PLAYER_ZOOM_STEP))
                            }
                            disabled={playerZoom >= MAX_PLAYER_ZOOM}
                          >
                            <Plus size={16} />
                            <span>{t('popup.zoomIn')}</span>
                          </button>
                        </div>
                        <button
                          className={styles.popupAction}
                          onClick={() =>
                            window.open(currentPlaybackItem.url, '_blank', 'noopener,noreferrer')
                          }
                        >
                          <ExternalLink size={16} />
                          <span>{t('popup.watchYoutube')}</span>
                        </button>
                      </div>
                    </div>
                    <div
                      className={styles.playerViewport}
                      style={
                        {
                          '--player-zoom': String(playerZoom),
                        } as React.CSSProperties
                      }
                    >
                      <iframe
                        key={`${queueStartVideoId}-${currentQueueKey}`}
                        ref={playerIframeRef}
                        data-testid="yt-player-iframe"
                        title={currentPlaybackItem.title}
                        src={buildEmbedUrl(queueStartVideoId, {
                          autoplay:
                            Boolean(activePlayback) ||
                            (autoplayVideoId !== null && queueStartVideoId === autoplayVideoId),
                          queueVideoIds: currentQueueVideoIds,
                        })}
                        className={styles.playerFrame}
                        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                        allowFullScreen
                      />
                    </div>
                  </>
                ) : (
                  <div className={styles.resultEmpty} data-testid="yt-player-empty">
                    {t('popup.selectVideo')}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {playlistPickerOpen && selectedResult && (
        <div className={styles.playlistPickerOverlay} onClick={closePlaylistPicker}>
          <div className={styles.playlistPickerCard} onClick={(event) => event.stopPropagation()}>
            <div className={styles.playlistPickerHeader}>
              <div>
                <span className={styles.popupEyebrow}>{t('playlist.pickerLabel')}</span>
                <strong className={styles.playlistPickerTitle}>{t('playlist.pickerTitle')}</strong>
              </div>
              <button className={styles.popupClose} onClick={closePlaylistPicker}>
                <X size={18} />
              </button>
            </div>

            <div className={styles.playlistPickerList} data-testid="yt-playlist-picker">
              {playlists.map((playlist) => {
                const alreadyAdded = playlist.items.some((item) => item.id === selectedResult.id);
                return (
                  <button
                    key={playlist.id}
                    className={`${styles.playlistPickerItem} ${
                      activePlaylistId === playlist.id ? styles.playlistPickerItemActive : ''
                    }`}
                    onClick={() => addSelectedResultToPlaylist(playlist.id)}
                    disabled={alreadyAdded}
                  >
                    <div className={styles.playlistPickerMeta}>
                      <strong>{playlist.name}</strong>
                      <span>{t('playlist.count', { count: playlist.items.length })}</span>
                    </div>
                    <span className={styles.playlistPickerStatus}>
                      {alreadyAdded ? t('playlist.savedState') : t('playlist.selectTarget')}
                    </span>
                  </button>
                );
              })}
            </div>

            <div className={styles.playlistPickerCreate}>
              <input
                className={styles.playlistNameInput}
                value={newPlaylistDraft}
                onChange={(event) => setNewPlaylistDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    createPlaylistFromDraft(true);
                  }
                }}
                placeholder={t('playlist.newPlaylistPlaceholder')}
              />
              <button
                className={styles.secondaryButton}
                onClick={() => createPlaylistFromDraft(true)}
              >
                <Plus size={16} />
                <span>{t('playlist.createAndAdd')}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default YouTubeApp;
