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
  type CharacterAppAction,
} from '@/lib';
import './i18n';
import {
  buildDirectResult,
  fetchYoutubeSearchResults,
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
  type Playlist,
  type PlaylistItem,
  type PlaylistPlayback,
  type PlaylistPlaybackMode,
} from './playlistUtils';
import styles from './index.module.scss';

const APP_ID = 3;
const APP_NAME = 'youtube';
const STATE_FILE = '/state.json';
const MAX_RECENT_SEARCHES = 12;
const MIN_PLAYER_ZOOM = 1;
const MAX_PLAYER_ZOOM = 2;
const PLAYER_ZOOM_STEP = 0.25;
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
};

function buildSearchUrl(query: string): string {
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
}

function buildHomeUrl(): string {
  return 'https://www.youtube.com/';
}

interface PlayerEmbedOptions {
  autoplay?: boolean;
  loopPlayback: boolean;
  queueVideoIds?: string[];
}

function buildEmbedUrl(videoId: string, options: PlayerEmbedOptions): string {
  const { autoplay = false, loopPlayback, queueVideoIds = [] } = options;
  const params = new URLSearchParams({
    rel: '0',
    modestbranding: '1',
    playsinline: '1',
    enablejsapi: '1',
    origin: window.location.origin,
  });
  const hasQueue = queueVideoIds.length > 1;
  if (autoplay) {
    params.set('autoplay', '1');
  }
  if (hasQueue) {
    params.set('playlist', queueVideoIds.slice(1).join(','));
    if (loopPlayback) {
      params.set('loop', '1');
    }
  } else if (loopPlayback) {
    params.set('loop', '1');
    params.set('playlist', videoId);
  }
  return `https://www.youtube.com/embed/${videoId}?${params.toString()}`;
}

function clampPlayerZoom(value: number): number {
  const normalized = Number.isFinite(value) ? value : 1;
  return Math.min(MAX_PLAYER_ZOOM, Math.max(MIN_PLAYER_ZOOM, normalized));
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
  const [resultsOpen, setResultsOpen] = useState(false);
  const [resultQuery, setResultQuery] = useState('');
  const [searchResults, setSearchResults] = useState<YoutubeSearchResult[]>([]);
  const [selectedResult, setSelectedResult] = useState<YoutubeSearchResult | null>(null);
  const [activePlayback, setActivePlayback] = useState<PlaylistPlayback | null>(null);
  const [currentPlayingVideoId, setCurrentPlayingVideoId] = useState<string | null>(null);
  const [resultsLoading, setResultsLoading] = useState(false);
  const [resultsError, setResultsError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [resultsAutoHide, setResultsAutoHide] = useState(false);
  const [loopPlayback, setLoopPlayback] = useState(false);
  const [playerZoom, setPlayerZoom] = useState(DEFAULT_STATE.playerZoom);
  const [resultListHidden, setResultListHidden] = useState(false);
  const resultListAutoHiddenRef = useRef(false);
  const previousSelectedResultIdRef = useRef<string | null>(null);
  const previousResultsAutoHideRef = useRef(false);
  const playerIframeRef = useRef<HTMLIFrameElement | null>(null);
  const youtubePlayerRef = useRef<YoutubeIframePlayer | null>(null);

  const saveState = useCallback(async (nextState: AppState) => {
    try {
      await youtubeFileApi.writeFile(STATE_FILE, nextState);
    } catch (error) {
      console.error('[YouTubeApp] Failed to save state:', error);
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
    }: {
      title: string;
      results: YoutubeSearchResult[];
      selected: YoutubeSearchResult | null;
      playback: PlaylistPlayback | null;
      hideResults?: boolean;
    }) => {
      setResultsOpen(true);
      setResultQuery(title);
      setSearchResults(results);
      setSelectedResult(selected);
      setActivePlayback(playback);
      setCurrentPlayingVideoId(selected?.id ?? null);
      setResultListHidden(hideResults);
      resultListAutoHiddenRef.current = hideResults;
      setResultsLoading(false);
      setResultsError(null);
    },
    [],
  );

  const submitSearch = useCallback(
    async (rawQuery?: string) => {
      const query = (rawQuery ?? searchQuery).trim();
      if (!query) return;

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

      reportAction(APP_ID, 'OPEN_SEARCH', { query });
      setResultsOpen(true);
      setActivePlayback(null);
      setCurrentPlayingVideoId(null);
      setResultQuery(query);
      setResultListHidden(false);
      resultListAutoHiddenRef.current = false;
      setResultsLoading(true);
      setResultsError(null);
      try {
        const results = await fetchYoutubeSearchResults(query);
        setSearchResults(results);
        setSelectedResult(results[0] ?? null);
      } catch (error) {
        setSearchResults([]);
        setSelectedResult(null);
        setResultsError(error instanceof Error ? error.message : String(error));
      } finally {
        setResultsLoading(false);
      }
    },
    [persistState, searchQuery],
  );

  const openHome = useCallback(() => {
    reportAction(APP_ID, 'OPEN_HOME', {});
    window.open(buildHomeUrl(), '_blank', 'noopener,noreferrer');
  }, []);

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
      openResultsViewer({
        title: targetPlaylist.name,
        results: playlistItemsToResults(targetPlaylist.items),
        selected: selectedItem,
        playback: null,
        hideResults: false,
      });
    },
    [openResultsViewer, playlists, selectPlaylist],
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
        hideResults: false,
      });
    },
    [openResultsViewer, persistState, playlists],
  );

  const playLastPlayedPlaylist = useCallback((): string => {
    const targetPlaylist =
      resolvePlaylist(playlists, lastPlayedPlaylistId) ||
      resolvePlaylist(playlists, activePlaylistId);

    if (!targetPlaylist || targetPlaylist.items.length === 0) {
      return 'error: no playlist available to play';
    }

    const mode = lastPlayedPlaylistMode ?? 'sequential';
    const playback = buildPlaylistPlayback(targetPlaylist.id, targetPlaylist.items, mode);
    if (!playback) {
      return 'error: no playlist available to play';
    }

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
      hideResults: false,
    });
    return 'success';
  }, [
    activePlaylistId,
    lastPlayedPlaylistId,
    lastPlayedPlaylistMode,
    openResultsViewer,
    persistState,
    playlists,
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
    closePlaylistPicker();
  }, [closePlaylistPicker]);

  const resetPlayerSelection = useCallback(() => {
    setSelectedResult(null);
    setActivePlayback(null);
    setCurrentPlayingVideoId(null);
    setResultListHidden(false);
    resultListAutoHiddenRef.current = false;
  }, []);

  const handleBackAction = useCallback(() => {
    if (resultListHidden) {
      resultListAutoHiddenRef.current = false;
      setResultListHidden(false);
      return;
    }
    resetPlayerSelection();
  }, [resetPlayerSelection, resultListHidden]);

  const toggleResultListVisibility = useCallback(() => {
    resultListAutoHiddenRef.current = false;
    setResultListHidden((prev) => !prev);
  }, []);

  const handleResultSelect = useCallback(
    (result: YoutubeSearchResult) => {
      if (activePlayback && playbackPlaylist?.items.some((item) => item.id === result.id)) {
        startPlaylistPlayback(activePlayback.playlistId, activePlayback.mode, result.id);
      } else {
        setActivePlayback(null);
        setCurrentPlayingVideoId(result.id);
        setSelectedResult(result);
        if (resultsAutoHide) {
          setResultListHidden(true);
          resultListAutoHiddenRef.current = true;
        }
      }
    },
    [activePlayback, playbackPlaylist, resultsAutoHide, startPlaylistPlayback],
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
            await submitSearch(query);
            return 'success';
          }
          case 'PLAY_LAST_PLAYLIST': {
            return playLastPlayedPlaylist();
          }
          case 'OPEN_HOME': {
            openHome();
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
            });
            return 'success';
          }
          default:
            return `error: unknown action_type ${action.action_type}`;
        }
      },
      [openHome, openResultsViewer, playLastPlayedPlaylist, resultsAutoHide, submitSearch],
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
          const stateResult = await youtubeFileApi.readFile(STATE_FILE);
          if (stateResult.content) {
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
            setSidebarOpen(Boolean(normalized.sidebarOpen));
            setResultsAutoHide(Boolean(normalized.resultsAutoHide));
            setLoopPlayback(Boolean(normalized.loopPlayback));
            setPlayerZoom(clampPlayerZoom(normalized.playerZoom));
          } else {
            await saveState(DEFAULT_STATE);
          }
        } catch {
          await saveState(DEFAULT_STATE);
        }

        setIsLoading(false);
        reportLifecycle(AppLifecycle.LOADED);
        manager.ready();
      } catch (error) {
        console.error('[YouTubeApp] Init error:', error);
        setIsLoading(false);
        reportLifecycle(AppLifecycle.ERROR, String(error));
      }
    };

    void init();

    return () => {
      reportLifecycle(AppLifecycle.UNLOADING);
      reportLifecycle(AppLifecycle.DESTROYED);
    };
  }, [saveState]);

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
    });
  }, [
    favoriteTopics,
    isLoading,
    loopPlayback,
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

  useEffect(() => {
    const previousSelectedResultId = previousSelectedResultIdRef.current;
    const previousResultsAutoHide = previousResultsAutoHideRef.current;
    const currentSelectedResultId = selectedResult?.id ?? null;
    const selectionChanged = currentSelectedResultId !== previousSelectedResultId;
    const autoHideEnabledNow = resultsAutoHide && !previousResultsAutoHide;
    const autoHideDisabledNow = !resultsAutoHide && previousResultsAutoHide;

    if (!resultsOpen || !currentSelectedResultId) {
      if (!currentSelectedResultId) {
        setResultListHidden(false);
        resultListAutoHiddenRef.current = false;
      }
    } else if (resultsAutoHide && (selectionChanged || autoHideEnabledNow)) {
      setResultListHidden(true);
      resultListAutoHiddenRef.current = true;
    } else if (autoHideDisabledNow && resultListAutoHiddenRef.current) {
      setResultListHidden(false);
      resultListAutoHiddenRef.current = false;
    }

    previousSelectedResultIdRef.current = currentSelectedResultId;
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
            onReady: syncCurrentVideoId,
            onStateChange: (event) => {
              if (!window.YT?.PlayerState) return;
              const trackedStates = [
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
  }, [resultsOpen, queueStartVideoId, currentQueueVideoIds.join(','), loopPlayback]);

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
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submitSearch();
                }}
                placeholder={t('search.placeholder')}
              />
              <button className={styles.searchButton} onClick={() => void submitSearch()}>
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
              <span className={styles.panelMeta}>
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
                value={newPlaylistDraft}
                onChange={(event) => setNewPlaylistDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    createPlaylistFromDraft(false);
                  }
                }}
                placeholder={t('playlist.newPlaylistPlaceholder')}
              />
              <button
                className={styles.secondaryButton}
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
                        if (event.key === 'Enter') {
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
        <div className={styles.popupOverlay} onClick={closeResultsViewer}>
          <div className={styles.popupCard} onClick={(e) => e.stopPropagation()}>
            <div className={styles.popupHeader}>
              <div className={styles.popupTitleWrap}>
                <span className={styles.popupEyebrow}>{t('popup.label')}</span>
                <strong className={styles.popupTitle}>
                  {activePlayback
                    ? playbackPlaylist?.name || DEFAULT_PLAYLIST_NAME
                    : resultQuery || t('popup.defaultTitle')}
                </strong>
              </div>
              <div className={styles.popupActions}>
                {selectedResult ? (
                  <button className={styles.popupAction} onClick={handleBackAction}>
                    <ArrowLeft size={16} />
                    <span>
                      {resultListHidden ? t('popup.backToResults') : t('popup.clearPlayer')}
                    </span>
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
                <button className={styles.popupClose} onClick={closeResultsViewer}>
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
                        <strong className={styles.playerTitle}>{currentPlaybackItem.title}</strong>
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
                        key={`${queueStartVideoId}-${currentQueueVideoIds.join(',')}-${loopPlayback ? 'loop' : 'single'}`}
                        ref={playerIframeRef}
                        title={currentPlaybackItem.title}
                        src={buildEmbedUrl(queueStartVideoId, {
                          autoplay: Boolean(activePlayback),
                          loopPlayback,
                          queueVideoIds: currentQueueVideoIds,
                        })}
                        className={styles.playerFrame}
                        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                        allowFullScreen
                      />
                    </div>
                  </>
                ) : (
                  <div className={styles.resultEmpty}>{t('popup.selectVideo')}</div>
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

            <div className={styles.playlistPickerList}>
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
                  if (event.key === 'Enter') {
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
