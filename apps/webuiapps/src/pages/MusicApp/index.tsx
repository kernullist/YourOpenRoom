import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Search,
  ExternalLink,
  History,
  Star,
  Home,
  Trash2,
  Sparkles,
  X,
  PlayCircle,
  ArrowLeft,
  PanelLeft,
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
import styles from './index.module.scss';

const APP_ID = 3;
const APP_NAME = 'youtube';
const STATE_FILE = '/state.json';
const MAX_RECENT_SEARCHES = 12;

interface SearchEntry {
  id: string;
  query: string;
  createdAt: number;
}

interface AppState {
  searchQuery: string;
  recentSearches: SearchEntry[];
  favoriteTopics: string[];
  sidebarOpen: boolean;
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
  sidebarOpen: false,
};

function buildSearchUrl(query: string): string {
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
}

function buildHomeUrl(): string {
  return 'https://www.youtube.com/';
}

interface YoutubeSearchResult {
  id: string;
  title: string;
  channel: string;
  duration: string;
  views: string;
  published: string;
  thumbnail: string;
  url: string;
}

function extractYoutubeVideoId(url: string): string | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (host === 'youtu.be') {
      return parsed.pathname.replace(/^\/+/, '') || null;
    }
    if (host === 'www.youtube.com' || host === 'youtube.com' || host === 'm.youtube.com') {
      if (parsed.pathname === '/watch') {
        return parsed.searchParams.get('v');
      }
      if (parsed.pathname.startsWith('/shorts/')) {
        return parsed.pathname.split('/')[2] || null;
      }
      if (parsed.pathname.startsWith('/embed/')) {
        return parsed.pathname.split('/')[2] || null;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function buildDirectResult(url: string): YoutubeSearchResult | null {
  const videoId = extractYoutubeVideoId(url);
  if (!videoId) return null;
  return {
    id: videoId,
    title: 'YouTube Video',
    channel: '',
    duration: '',
    views: '',
    published: '',
    thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    url,
  };
}

async function fetchYoutubeSearchResults(query: string): Promise<YoutubeSearchResult[]> {
  const res = await fetch(`/api/youtube-search?query=${encodeURIComponent(query)}`);
  const data = (await res.json()) as { results?: YoutubeSearchResult[]; error?: string };
  if (!res.ok) {
    throw new Error(data.error || 'Failed to load YouTube results');
  }
  return data.results ?? [];
}

function normalizeState(raw: unknown): AppState {
  if (!raw || typeof raw !== 'object') return DEFAULT_STATE;
  const obj = raw as Partial<AppState>;
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
      Array.isArray(obj.favoriteTopics) && obj.favoriteTopics.every((topic) => typeof topic === 'string')
        ? obj.favoriteTopics
        : DEFAULT_TOPICS,
  };
}

const YouTubeApp: React.FC = () => {
  const { t } = useTranslation('musicApp');
  const [searchQuery, setSearchQuery] = useState('');
  const [recentSearches, setRecentSearches] = useState<SearchEntry[]>([]);
  const [favoriteTopics, setFavoriteTopics] = useState<string[]>(DEFAULT_TOPICS);
  const [isLoading, setIsLoading] = useState(true);
  const [resultsOpen, setResultsOpen] = useState(false);
  const [resultQuery, setResultQuery] = useState('');
  const [searchResults, setSearchResults] = useState<YoutubeSearchResult[]>([]);
  const [selectedResult, setSelectedResult] = useState<YoutubeSearchResult | null>(null);
  const [resultsLoading, setResultsLoading] = useState(false);
  const [resultsError, setResultsError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const saveState = useCallback(
    async (nextState: AppState) => {
      try {
        await youtubeFileApi.writeFile(STATE_FILE, nextState);
      } catch (error) {
        console.error('[YouTubeApp] Failed to save state:', error);
      }
    },
    [],
  );

  const persistState = useCallback(
    (updater: (prev: AppState) => AppState) => {
      const currentState: AppState = {
        searchQuery,
        recentSearches,
        favoriteTopics,
        sidebarOpen,
      };
      const nextState = updater(currentState);
      setSearchQuery(nextState.searchQuery);
      setRecentSearches(nextState.recentSearches);
      setFavoriteTopics(nextState.favoriteTopics);
      void saveState(nextState);
    },
    [favoriteTopics, recentSearches, saveState, searchQuery, sidebarOpen],
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
        recentSearches: [entry, ...prev.recentSearches.filter((item) => item.query !== query)].slice(
          0,
          MAX_RECENT_SEARCHES,
        ),
      }));

      reportAction(APP_ID, 'OPEN_SEARCH', { query });
      setResultsOpen(true);
      setResultQuery(query);
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

  const quickTopics = useMemo(
    () => favoriteTopics.slice(0, 6).concat(DEFAULT_TOPICS).filter((topic, index, arr) => arr.indexOf(topic) === index).slice(0, 8),
    [favoriteTopics],
  );

  useAgentActionListener(
    APP_ID,
    useCallback(async (action: CharacterAppAction): Promise<string> => {
      switch (action.action_type) {
        case 'OPEN_SEARCH': {
          const query = action.params?.query?.trim();
          if (!query) return 'error: missing query';
          await submitSearch(query);
          return 'success';
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
          setResultsOpen(true);
          setResultQuery(url);
          setSearchResults([direct]);
          setSelectedResult(direct);
          setResultsLoading(false);
          setResultsError(null);
          return 'success';
        }
        default:
          return `error: unknown action_type ${action.action_type}`;
      }
    }, [openHome, submitSearch]),
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
            setSidebarOpen(Boolean(normalized.sidebarOpen));
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
      sidebarOpen,
    });
  }, [favoriteTopics, isLoading, recentSearches, saveState, searchQuery, sidebarOpen]);

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
            <button key={topic} className={styles.topicChip} onClick={() => void submitSearch(topic)}>
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
                  <button key={entry.id} className={styles.recentItem} onClick={() => void submitSearch(entry.query)}>
                    <span className={styles.recentQuery}>{entry.query}</span>
                    <span className={styles.recentTime}>
                      {new Date(entry.createdAt).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </section>

          <section className={styles.panel}>
            <div className={styles.panelHeader}>
              <div className={styles.panelTitleWrap}>
                <Search size={18} />
                <h2 className={styles.panelTitle}>{t('tips.title')}</h2>
              </div>
            </div>
            <div className={styles.tipList}>
              <div className={styles.tipItem}>{t('tips.items.0')}</div>
              <div className={styles.tipItem}>{t('tips.items.1')}</div>
              <div className={styles.tipItem}>{t('tips.items.2')}</div>
            </div>
          </section>
        </section>
      </main>

      {resultsOpen && (
        <div className={styles.popupOverlay} onClick={() => setResultsOpen(false)}>
          <div className={styles.popupCard} onClick={(e) => e.stopPropagation()}>
            <div className={styles.popupHeader}>
              <div className={styles.popupTitleWrap}>
                <span className={styles.popupEyebrow}>{t('popup.label')}</span>
                <strong className={styles.popupTitle}>{resultQuery || t('popup.defaultTitle')}</strong>
              </div>
              <div className={styles.popupActions}>
                {selectedResult ? (
                  <button className={styles.popupAction} onClick={() => setSelectedResult(null)}>
                    <ArrowLeft size={16} />
                    <span>{t('popup.back')}</span>
                  </button>
                ) : null}
                <button
                  className={styles.popupAction}
                  onClick={() =>
                    window.open(buildSearchUrl(resultQuery), '_blank', 'noopener,noreferrer')
                  }
                >
                  <ExternalLink size={16} />
                  <span>{t('popup.openExternal')}</span>
                </button>
                <button className={styles.popupClose} onClick={() => setResultsOpen(false)}>
                  <X size={18} />
                </button>
              </div>
            </div>
            <div className={styles.popupHint}>{t('popup.hint')}</div>
            <div className={styles.resultLayout}>
              <div className={styles.resultList}>
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
                      onClick={() => setSelectedResult(result)}
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

              <div className={styles.playerPane}>
                {selectedResult ? (
                  <>
                    <div className={styles.playerHeader}>
                      <div>
                        <span className={styles.popupEyebrow}>{t('popup.nowPlaying')}</span>
                        <strong className={styles.playerTitle}>{selectedResult.title}</strong>
                      </div>
                      <button
                        className={styles.popupAction}
                        onClick={() =>
                          window.open(selectedResult.url, '_blank', 'noopener,noreferrer')
                        }
                      >
                        <ExternalLink size={16} />
                        <span>{t('popup.watchYoutube')}</span>
                      </button>
                    </div>
                    <iframe
                      key={selectedResult.id}
                      title={selectedResult.title}
                      src={`https://www.youtube.com/embed/${selectedResult.id}`}
                      className={styles.playerFrame}
                      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                      allowFullScreen
                    />
                  </>
                ) : (
                  <div className={styles.resultEmpty}>{t('popup.selectVideo')}</div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default YouTubeApp;
