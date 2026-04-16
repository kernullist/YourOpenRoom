import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PanelLeft } from 'lucide-react';
import { initVibeApp, AppLifecycle } from '@gui/vibe-container';
import {
  useFileSystem,
  useAgentActionListener,
  reportAction,
  reportLifecycle,
  createAppFileApi,
  fetchVibeInfo,
  generateId,
  type CharacterAppAction,
} from '@/lib';
import './i18n';
import styles from './index.module.scss';

const APP_ID = 17;
const APP_NAME = 'browser';
const BOOKMARKS_DIR = '/bookmarks';
const HISTORY_DIR = '/history';
const STATE_FILE = '/state.json';
const MAX_HISTORY_ITEMS = 40;
const READER_FETCH_TIMEOUT_MS = 10000;

const browserFileApi = createAppFileApi(APP_NAME);
const notesFileApi = createAppFileApi('notes');

type ViewMode = 'browse' | 'reader';

interface BookmarkItem {
  id: string;
  url: string;
  title: string;
  createdAt: number;
}

interface HistoryItem {
  id: string;
  url: string;
  title: string;
  visitedAt: number;
}

interface BrowserState {
  currentUrl: string;
  inputUrl: string;
  viewMode: ViewMode;
  sidebarOpen: boolean;
}

interface ReaderBlock {
  type: 'heading' | 'paragraph' | 'quote' | 'list';
  text: string;
}

interface PageSnapshot {
  finalUrl: string;
  title: string;
  excerpt: string;
  siteName: string;
  blocks: ReaderBlock[];
}

interface GoogleSearchResult {
  title: string;
  url: string;
  snippet: string;
  displayUrl: string;
}

type SearchResultSource = 'google' | 'fallback';

const DEFAULT_STATE: BrowserState = {
  currentUrl: 'https://www.notion.com/notes',
  inputUrl: 'https://www.notion.com/notes',
  viewMode: 'browse',
  sidebarOpen: false,
};

function normalizeUrlInput(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function buildProxyUrl(url: string): string {
  return `/api/browser-reader?url=${encodeURIComponent(url)}`;
}

function isLikelyInteractiveHomePage(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    const search = parsed.search.trim();
    if (/(\.|^)google\./.test(host) && pathname === '/' && !search) return true;
    if ((host === 'www.youtube.com' || host === 'youtube.com') && pathname === '/' && !search) return true;
    if ((host === 'x.com' || host === 'www.x.com' || host === 'twitter.com' || host === 'www.twitter.com') && pathname === '/' && !search) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function isGoogleUrl(url: string): boolean {
  try {
    return /(\.|^)google\./.test(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function extractGoogleSearchQuery(url: string): string {
  try {
    const parsed = new URL(url);
    if (!/(\.|^)google\./.test(parsed.hostname.toLowerCase())) return '';
    return parsed.searchParams.get('q')?.trim() || '';
  } catch {
    return '';
  }
}

function isKnownFrameBlockedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return (
      /(\.|^)google\./.test(host) ||
      host === 'youtube.com' ||
      host === 'www.youtube.com' ||
      host === 'x.com' ||
      host === 'www.x.com' ||
      host === 'twitter.com' ||
      host === 'www.twitter.com'
    );
  } catch {
    return false;
  }
}

function stripText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function parseGoogleSearchResults(html: string): GoogleSearchResult[] {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const anchors = Array.from(doc.querySelectorAll('a[href]'));
  const results: GoogleSearchResult[] = [];
  const seen = new Set<string>();

  for (const anchor of anchors) {
    const rawHref = anchor.getAttribute('href') || '';
    let targetUrl = '';

    if (rawHref.startsWith('/url?')) {
      try {
        const parsed = new URL(rawHref, 'https://www.google.com');
        targetUrl =
          parsed.searchParams.get('q') ||
          parsed.searchParams.get('url') ||
          parsed.searchParams.get('adurl') ||
          '';
      } catch {
        targetUrl = '';
      }
    } else if (/^https?:\/\//i.test(rawHref)) {
      targetUrl = rawHref;
    }

    if (!targetUrl) continue;
    if (isGoogleUrl(targetUrl)) continue;
    if (seen.has(targetUrl)) continue;

    const title = stripText(
      anchor.querySelector('h3')?.textContent ||
        anchor.querySelector('span')?.textContent ||
        anchor.textContent ||
        '',
    );
    if (!title || title.length < 3) continue;

    const container = anchor.closest('div');
    const surroundingText = stripText(container?.parentElement?.textContent || container?.textContent || '');
    const snippetCandidate = surroundingText.replace(title, '').replace(targetUrl, '').trim();

    let displayUrl = '';
    try {
      displayUrl = new URL(targetUrl).hostname.replace(/^www\./, '');
    } catch {
      displayUrl = targetUrl;
    }

    results.push({
      title,
      url: targetUrl,
      snippet: snippetCandidate.length > 260 ? `${snippetCandidate.slice(0, 260)}...` : snippetCandidate,
      displayUrl,
    });
    seen.add(targetUrl);
    if (results.length >= 12) break;
  }

  return results;
}

function parseDuckDuckGoResults(html: string): GoogleSearchResult[] {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const anchors = Array.from(doc.querySelectorAll('a.result__a, a[data-testid="result-title-a"]'));
  const results: GoogleSearchResult[] = [];
  const seen = new Set<string>();

  for (const anchor of anchors) {
    const url = anchor.getAttribute('href') || '';
    if (!/^https?:\/\//i.test(url)) continue;
    if (seen.has(url)) continue;

    const container =
      anchor.closest('.result') ||
      anchor.closest('[data-testid="result"]') ||
      anchor.parentElement;

    const title = stripText(anchor.textContent || '');
    if (!title) continue;

    const snippet = stripText(
      container?.querySelector('.result__snippet')?.textContent ||
        container?.querySelector('[data-result="snippet"]')?.textContent ||
        container?.textContent ||
        '',
    ).replace(title, '');

    let displayUrl = url;
    try {
      displayUrl = new URL(url).hostname.replace(/^www\./, '');
    } catch {
      // keep raw URL
    }

    results.push({
      title,
      url,
      snippet: snippet.length > 260 ? `${snippet.slice(0, 260)}...` : snippet,
      displayUrl,
    });
    seen.add(url);
    if (results.length >= 12) break;
  }

  return results;
}

function parsePageSnapshot(html: string, sourceUrl: string): PageSnapshot {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script, style, noscript, iframe, svg, canvas').forEach((node) => node.remove());

  const title =
    doc.querySelector('meta[property="og:title"]')?.getAttribute('content')?.trim() ||
    doc.title?.trim() ||
    sourceUrl;

  const siteName =
    doc.querySelector('meta[property="og:site_name"]')?.getAttribute('content')?.trim() ||
    new URL(sourceUrl).hostname.replace(/^www\./, '');

  const excerpt =
    doc.querySelector('meta[name="description"]')?.getAttribute('content')?.trim() ||
    doc.querySelector('meta[property="og:description"]')?.getAttribute('content')?.trim() ||
    '';

  const root =
    doc.querySelector('article') ||
    doc.querySelector('main') ||
    doc.querySelector('[role="main"]') ||
    doc.querySelector('.article') ||
    doc.querySelector('.post') ||
    doc.querySelector('.entry-content') ||
    doc.querySelector('.content') ||
    doc.body;

  const nodes = Array.from(root.querySelectorAll('h1, h2, h3, p, li, blockquote'));
  const blocks: ReaderBlock[] = [];
  for (const node of nodes) {
    const text = node.textContent?.replace(/\s+/g, ' ').trim() || '';
    if (text.length < 30) continue;
    const type =
      node.tagName === 'BLOCKQUOTE'
        ? 'quote'
        : node.tagName === 'LI'
          ? 'list'
          : /^H[1-3]$/.test(node.tagName)
            ? 'heading'
            : 'paragraph';
    blocks.push({ type, text });
    if (blocks.length >= 30) break;
  }

  const fallbackExcerpt = excerpt || blocks.find((block) => block.type === 'paragraph')?.text || title;
  return {
    finalUrl: sourceUrl,
    title,
    excerpt: fallbackExcerpt.length > 220 ? `${fallbackExcerpt.slice(0, 220)}...` : fallbackExcerpt,
    siteName,
    blocks,
  };
}

async function fetchPageSnapshot(url: string): Promise<PageSnapshot> {
  if (isLikelyInteractiveHomePage(url)) {
    const parsed = new URL(url);
    return {
      finalUrl: url,
      title: parsed.hostname.replace(/^www\./, ''),
      excerpt:
        'This page is primarily an interactive homepage, so reader mode may not be able to extract a meaningful article view.',
      siteName: parsed.hostname.replace(/^www\./, ''),
      blocks: [
        {
          type: 'paragraph',
          text: 'This page is primarily an interactive homepage, so reader mode may not be able to extract a meaningful article view. Try opening a specific article or search result instead.',
        },
      ],
    };
  }

  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), READER_FETCH_TIMEOUT_MS);
  const res = await fetch(buildProxyUrl(url), { signal: controller.signal }).finally(() => {
    window.clearTimeout(timer);
  });
  const contentType = res.headers.get('content-type') || '';
  const finalUrl = res.headers.get('x-final-url') || url;
  if (!res.ok) {
    if (contentType.includes('application/json')) {
      const data = (await res.json()) as { error?: string };
      throw new Error(data.error || 'Failed to load page');
    }
    throw new Error(await res.text());
  }
  const html = await res.text();
  return parsePageSnapshot(html, finalUrl);
}

async function fetchGoogleSearchResults(
  query: string,
): Promise<{ results: GoogleSearchResult[]; source: SearchResultSource }> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), READER_FETCH_TIMEOUT_MS);
  const searchUrl = `https://www.google.com/search?hl=en&gbv=1&num=10&q=${encodeURIComponent(query)}`;

  try {
    const res = await fetch(buildProxyUrl(searchUrl), { signal: controller.signal });
    if (!res.ok) {
      throw new Error('Google search request failed');
    }
    const html = await res.text();
    const results = parseGoogleSearchResults(html);
    if (results.length > 0) {
      return { results, source: 'google' };
    }
    throw new Error('No Google results parsed');
  } finally {
    window.clearTimeout(timer);
  }
}

async function fetchFallbackSearchResults(
  query: string,
): Promise<{ results: GoogleSearchResult[]; source: SearchResultSource }> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), READER_FETCH_TIMEOUT_MS);
  const fallbackUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

  try {
    const res = await fetch(buildProxyUrl(fallbackUrl), { signal: controller.signal });
    if (!res.ok) {
      throw new Error('Fallback search request failed');
    }
    const html = await res.text();
    const results = parseDuckDuckGoResults(html);
    if (results.length === 0) {
      throw new Error('No fallback results parsed');
    }
    return { results, source: 'fallback' };
  } finally {
    window.clearTimeout(timer);
  }
}

const BrowserReaderPage: React.FC = () => {
  const { t, i18n } = useTranslation('browserReader');
  const [bookmarks, setBookmarks] = useState<BookmarkItem[]>([]);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [currentUrl, setCurrentUrl] = useState(DEFAULT_STATE.currentUrl);
  const [inputUrl, setInputUrl] = useState(DEFAULT_STATE.inputUrl);
  const [viewMode, setViewMode] = useState<ViewMode>(DEFAULT_STATE.viewMode);
  const [pageSnapshot, setPageSnapshot] = useState<PageSnapshot | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [readerLoading, setReaderLoading] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [flashText, setFlashText] = useState<string | null>(null);
  const [isInitialized, setIsInitialized] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [googleQuery, setGoogleQuery] = useState('');
  const [googleResults, setGoogleResults] = useState<GoogleSearchResult[]>([]);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [googleError, setGoogleError] = useState<string | null>(null);
  const [googleResultSource, setGoogleResultSource] = useState<SearchResultSource | null>(null);

  const { saveFile, syncToCloud, deleteFromCloud, initFromCloud, getChildrenByPath, getByPath } =
    useFileSystem({ fileApi: browserFileApi });

  const loadItems = useCallback(<T,>(dirPath: string): T[] => {
    return getChildrenByPath(dirPath)
      .filter((node) => node.type === 'file')
      .map((node) => {
        try {
          return (typeof node.content === 'string' ? JSON.parse(node.content) : node.content) as T;
        } catch {
          return null;
        }
      })
      .filter((item): item is T => item !== null);
  }, [getChildrenByPath]);

  const saveState = useCallback(
    async (state: BrowserState) => {
      saveFile(STATE_FILE, state);
      await syncToCloud(STATE_FILE, state);
    },
    [saveFile, syncToCloud],
  );

  const refreshFromCloud = useCallback(async () => {
    await initFromCloud();
    const nextBookmarks = loadItems<BookmarkItem>(BOOKMARKS_DIR).sort((a, b) => b.createdAt - a.createdAt);
    const nextHistory = loadItems<HistoryItem>(HISTORY_DIR).sort((a, b) => b.visitedAt - a.visitedAt);
    const state = (getByPath(STATE_FILE)?.content as BrowserState | undefined) ?? DEFAULT_STATE;

    setBookmarks(nextBookmarks);
    setHistory(nextHistory);
    setCurrentUrl(state.currentUrl || DEFAULT_STATE.currentUrl);
    setInputUrl(state.inputUrl || state.currentUrl || DEFAULT_STATE.inputUrl);
    setViewMode(state.viewMode || 'browse');
    setSidebarOpen(Boolean(state.sidebarOpen));
  }, [getByPath, initFromCloud, loadItems]);

  const persistHistoryEntry = useCallback(
    async (url: string, title: string) => {
      const existing = history.find((item) => item.url === url);
      const entry: HistoryItem = {
        id: existing?.id ?? generateId(),
        url,
        title: title || url,
        visitedAt: Date.now(),
      };

      saveFile(`${HISTORY_DIR}/${entry.id}.json`, entry);
      await syncToCloud(`${HISTORY_DIR}/${entry.id}.json`, entry);

      const orderedHistory = [entry, ...history.filter((item) => item.id !== entry.id)].sort(
        (a, b) => b.visitedAt - a.visitedAt,
      );
      const nextHistory = orderedHistory.slice(0, MAX_HISTORY_ITEMS);
      const overflow = orderedHistory.slice(MAX_HISTORY_ITEMS);

      for (const item of overflow) {
        await deleteFromCloud(`${HISTORY_DIR}/${item.id}.json`);
      }

      setHistory(nextHistory);
    },
    [deleteFromCloud, history, saveFile, syncToCloud],
  );

  const navigateTo = useCallback(
    async (rawUrl: string, reason: 'manual' | 'bookmark' | 'agent' | 'history' = 'manual') => {
      const normalized = normalizeUrlInput(rawUrl);
      if (!normalized) return;

      setErrorText(null);
      setInputUrl(normalized);
      setCurrentUrl(normalized);
      if (reason !== 'agent') {
        reportAction(APP_ID, 'OPEN_URL', { url: normalized, source: reason });
      }
    },
    [],
  );

  const handleAgentAction = useCallback(
    async (action: CharacterAppAction): Promise<string> => {
      switch (action.action_type) {
        case 'OPEN_URL': {
          const url = action.params?.url;
          if (!url) return 'error: missing url';
          await navigateTo(url, 'agent');
          return 'success';
        }
        case 'SET_VIEW_MODE': {
          const mode = action.params?.mode === 'reader' ? 'reader' : 'browse';
          setViewMode(mode);
          return 'success';
        }
        case 'REFRESH_DATA': {
          await refreshFromCloud();
          return 'success';
        }
        case 'CREATE_BOOKMARK':
        case 'DELETE_BOOKMARK': {
          await refreshFromCloud();
          return 'success';
        }
        default:
          return `error: unknown action_type ${action.action_type}`;
      }
    },
    [navigateTo, refreshFromCloud],
  );

  useAgentActionListener(APP_ID, handleAgentAction);

  useEffect(() => {
    const init = async () => {
      try {
        reportLifecycle(AppLifecycle.LOADING);
        const manager = await initVibeApp({
          id: APP_ID,
          url: window.location.href,
          type: 'page',
          name: 'Browser',
          windowStyle: { width: 1180, height: 760 },
        });

        manager.handshake({
          id: APP_ID,
          url: window.location.href,
          type: 'page',
          name: 'Browser',
          windowStyle: { width: 1180, height: 760 },
        });

        reportLifecycle(AppLifecycle.DOM_READY);
        await fetchVibeInfo().catch(() => undefined);
        await refreshFromCloud();
        setIsInitialized(true);
        setIsLoading(false);
        reportLifecycle(AppLifecycle.LOADED);
        manager.ready();
      } catch (error) {
        setIsLoading(false);
        setErrorText(error instanceof Error ? error.message : String(error));
        reportLifecycle(AppLifecycle.ERROR, String(error));
      }
    };

    void init();

    return () => {
      reportLifecycle(AppLifecycle.UNLOADING);
      reportLifecycle(AppLifecycle.DESTROYED);
    };
  }, [refreshFromCloud]);

  useEffect(() => {
    if (!isInitialized) return;
    void saveState({ currentUrl, inputUrl, viewMode, sidebarOpen });
  }, [currentUrl, inputUrl, isInitialized, saveState, sidebarOpen, viewMode]);

  useEffect(() => {
    if (!currentUrl) return;
    let cancelled = false;
    setReaderLoading(true);
    void fetchPageSnapshot(currentUrl)
      .then(async (snapshot) => {
        if (cancelled) return;
        setErrorText(null);
        setPageSnapshot(snapshot);
        await persistHistoryEntry(snapshot.finalUrl, snapshot.title);
      })
      .catch((error) => {
        if (cancelled) return;
        setPageSnapshot(null);
        setErrorText(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) setReaderLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [currentUrl, persistHistoryEntry]);

  useEffect(() => {
    if (!flashText) return;
    const timer = window.setTimeout(() => setFlashText(null), 2500);
    return () => window.clearTimeout(timer);
  }, [flashText]);

  useEffect(() => {
    if (!isGoogleUrl(currentUrl)) {
      setGoogleResults([]);
      setGoogleError(null);
      setGoogleLoading(false);
      setGoogleQuery('');
      setGoogleResultSource(null);
      return;
    }

    const query = extractGoogleSearchQuery(currentUrl);
    setGoogleQuery(query);
    if (!query) {
      setGoogleResults([]);
      setGoogleError(null);
      setGoogleLoading(false);
      setGoogleResultSource(null);
      return;
    }

    let cancelled = false;
    setGoogleLoading(true);
    setGoogleError(null);
    void fetchGoogleSearchResults(query)
      .then(({ results, source }) => {
        if (cancelled) return;
        setGoogleResults(results);
        setGoogleResultSource(source);
      })
      .catch(async () => {
        if (cancelled) return;
        try {
          const fallback = await fetchFallbackSearchResults(query);
          if (cancelled) return;
          setGoogleResults(fallback.results);
          setGoogleResultSource(fallback.source);
          setGoogleError(null);
        } catch (fallbackError) {
          if (cancelled) return;
          setGoogleResults([]);
          setGoogleResultSource(null);
          setGoogleError(
            fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
          );
        }
      })
      .finally(() => {
        if (!cancelled) setGoogleLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [currentUrl]);

  const isBookmarked = useMemo(
    () => bookmarks.some((bookmark) => bookmark.url === (pageSnapshot?.finalUrl || currentUrl)),
    [bookmarks, currentUrl, pageSnapshot?.finalUrl],
  );
  const isFrameBlocked = useMemo(() => isKnownFrameBlockedUrl(currentUrl), [currentUrl]);

  const saveBookmark = useCallback(async () => {
    const targetUrl = pageSnapshot?.finalUrl || currentUrl;
    if (!targetUrl) return;

    const existing = bookmarks.find((bookmark) => bookmark.url === targetUrl);
    if (existing) {
      await deleteFromCloud(`${BOOKMARKS_DIR}/${existing.id}.json`);
      setBookmarks((prev) => prev.filter((item) => item.id !== existing.id));
      setFlashText(t('bookmarkRemoved'));
      reportAction(APP_ID, 'DELETE_BOOKMARK', { bookmarkId: existing.id });
      return;
    }

    const bookmark: BookmarkItem = {
      id: generateId(),
      url: targetUrl,
      title: pageSnapshot?.title || targetUrl,
      createdAt: Date.now(),
    };
    saveFile(`${BOOKMARKS_DIR}/${bookmark.id}.json`, bookmark);
    await syncToCloud(`${BOOKMARKS_DIR}/${bookmark.id}.json`, bookmark);
    setBookmarks((prev) => [bookmark, ...prev].sort((a, b) => b.createdAt - a.createdAt));
    setFlashText(t('bookmarkSaved'));
    reportAction(APP_ID, 'SAVE_BOOKMARK', { bookmarkId: bookmark.id, url: bookmark.url });
  }, [bookmarks, currentUrl, deleteFromCloud, pageSnapshot, saveFile, syncToCloud, t]);

  const saveToNotes = useCallback(async () => {
    if (!pageSnapshot) return;
    const noteId = generateId();
    const note = {
      id: noteId,
      title: pageSnapshot.title,
      content: [
        `# ${pageSnapshot.title}`,
        '',
        `Source: ${pageSnapshot.finalUrl}`,
        '',
        pageSnapshot.excerpt,
        '',
        ...pageSnapshot.blocks.slice(0, 12).map((block) =>
          block.type === 'heading' ? `## ${block.text}` : block.type === 'list' ? `- ${block.text}` : block.text,
        ),
      ].join('\n'),
      tags: ['web', 'reader'],
      pinned: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await notesFileApi.writeFile(`/notes/${noteId}.json`, note);
    setFlashText(t('savedToNotes'));
    reportAction(APP_ID, 'SAVE_TO_NOTES', { noteId, url: pageSnapshot.finalUrl });
  }, [pageSnapshot, t]);

  const submitGoogleSearch = useCallback(() => {
    const query = googleQuery.trim();
    if (!query) return;
    void navigateTo(`https://www.google.com/search?q=${encodeURIComponent(query)}`, 'manual');
  }, [googleQuery, navigateTo]);

  if (isLoading) {
    return (
      <div className={styles.browserReader}>
        <div className={styles.loadingState}>{t('loading')}</div>
      </div>
    );
  }

  return (
    <div className={`${styles.browserReader} ${!sidebarOpen ? styles.sidebarClosed : ''}`}>
      <aside className={`${styles.sidebar} ${!sidebarOpen ? styles.sidebarHidden : ''}`}>
        <div className={styles.sidebarIntro}>
          <p className={styles.kicker}>{t('kicker')}</p>
          <h1>{t('title')}</h1>
          <p>{t('subtitle')}</p>
        </div>

        <section className={styles.sidebarSection}>
          <div className={styles.sidebarHeader}>
            <h2>{t('bookmarks')}</h2>
            <button onClick={() => void saveBookmark()}>{isBookmarked ? t('remove') : t('save')}</button>
          </div>
          <div className={styles.sidebarList}>
            {bookmarks.length > 0 ? (
              bookmarks.map((bookmark) => (
                <button
                  key={bookmark.id}
                  className={styles.linkCard}
                  onClick={() => void navigateTo(bookmark.url, 'bookmark')}
                >
                  <strong>{bookmark.title}</strong>
                  <span>{bookmark.url}</span>
                </button>
              ))
            ) : (
              <div className={styles.emptyBlock}>{t('noBookmarks')}</div>
            )}
          </div>
        </section>

        <section className={styles.sidebarSection}>
          <div className={styles.sidebarHeader}>
            <h2>{t('history')}</h2>
          </div>
          <div className={styles.sidebarList}>
            {history.length > 0 ? (
              history.slice(0, 10).map((item) => (
                <button
                  key={item.id}
                  className={styles.linkCardMuted}
                  onClick={() => void navigateTo(item.url, 'history')}
                >
                  <strong>{item.title}</strong>
                  <span>{item.url}</span>
                </button>
              ))
            ) : (
              <div className={styles.emptyBlock}>{t('noHistory')}</div>
            )}
          </div>
        </section>
      </aside>

      <main className={styles.workspace}>
        <div className={styles.toolbar}>
          <button className={styles.sidebarToggle} onClick={() => setSidebarOpen((prev) => !prev)}>
            <PanelLeft size={16} />
            <span>{sidebarOpen ? t('hideSidebar') : t('showSidebar')}</span>
          </button>
          <form
            className={styles.addressForm}
            onSubmit={(e) => {
              e.preventDefault();
              void navigateTo(inputUrl, 'manual');
            }}
          >
            <input value={inputUrl} onChange={(e) => setInputUrl(e.target.value)} placeholder={t('placeholder')} />
            <button type="submit">{t('go')}</button>
          </form>

          <div className={styles.toolbarActions}>
            <button
              className={viewMode === 'browse' ? styles.toolbarActive : ''}
              onClick={() => {
                setViewMode('browse');
                reportAction(APP_ID, 'SET_VIEW_MODE', { mode: 'browse' });
              }}
            >
              {t('browse')}
            </button>
            <button
              className={viewMode === 'reader' ? styles.toolbarActive : ''}
              onClick={() => {
                setViewMode('reader');
                reportAction(APP_ID, 'SET_VIEW_MODE', { mode: 'reader' });
              }}
            >
              {t('reader')}
            </button>
            <button onClick={() => void saveBookmark()}>{isBookmarked ? t('unsave') : t('bookmark')}</button>
            <button onClick={() => void saveToNotes()} disabled={!pageSnapshot}>
              {t('saveToNotes')}
            </button>
          </div>
        </div>

        <div className={styles.stage}>
          {viewMode === 'browse' ? (
            <div className={styles.browserPane}>
              {isGoogleUrl(currentUrl) ? (
                <div className={styles.googlePane}>
                  <div className={styles.googleCard}>
                    <p className={styles.kicker}>{t('google.kicker')}</p>
                    <h2>{t('google.title')}</h2>
                    <p>{t('google.description')}</p>

                    <div className={styles.googleSearchRow}>
                      <input
                        value={googleQuery}
                        onChange={(e) => setGoogleQuery(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') submitGoogleSearch();
                        }}
                        placeholder={t('google.placeholder')}
                      />
                      <button className={styles.primaryAction} onClick={submitGoogleSearch}>
                        {t('google.search')}
                      </button>
                    </div>

                    {googleLoading ? (
                      <div className={styles.googleEmpty}>{t('google.loading')}</div>
                    ) : googleError ? (
                      <div className={styles.errorBox}>{googleError}</div>
                    ) : googleResults.length > 0 ? (
                      <>
                        {googleResultSource === 'fallback' ? (
                          <div className={styles.googleFallbackNote}>{t('google.fallback')}</div>
                        ) : null}
                        <div className={styles.googleResults}>
                          {googleResults.map((result) => (
                            <button
                              key={result.url}
                              className={styles.googleResultCard}
                              onClick={() => void navigateTo(result.url, 'manual')}
                            >
                              <span className={styles.googleResultHost}>{result.displayUrl}</span>
                              <strong className={styles.googleResultTitle}>{result.title}</strong>
                              {result.snippet ? (
                                <p className={styles.googleResultSnippet}>{result.snippet}</p>
                              ) : null}
                            </button>
                          ))}
                        </div>
                      </>
                    ) : (
                      <div className={styles.googleEmpty}>
                        {googleQuery ? t('google.noResults') : t('google.empty')}
                      </div>
                    )}
                  </div>
                </div>
              ) : isFrameBlocked ? (
                <div className={styles.blockedPane}>
                  <div className={styles.blockedCard}>
                    <p className={styles.kicker}>{t('blocked.kicker')}</p>
                    <h2>{t('blocked.title')}</h2>
                    <p>{t('blocked.description')}</p>
                    <div className={styles.blockedUrl}>{currentUrl}</div>
                    <div className={styles.blockedActions}>
                      <button
                        className={styles.primaryAction}
                        onClick={() => window.open(currentUrl, '_blank', 'noopener,noreferrer')}
                      >
                        {t('blocked.openExternal')}
                      </button>
                      <button
                        className={styles.secondaryAction}
                        onClick={() => {
                          setViewMode('reader');
                          reportAction(APP_ID, 'SET_VIEW_MODE', { mode: 'reader' });
                        }}
                      >
                        {t('blocked.tryReader')}
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <>
                  <div className={styles.browserNotice}>{t('browseNotice')}</div>
                  <iframe
                    key={currentUrl}
                    title={pageSnapshot?.title || currentUrl}
                    src={buildProxyUrl(currentUrl)}
                    className={styles.browserFrame}
                    sandbox="allow-forms allow-popups allow-scripts"
                  />
                </>
              )}
            </div>
          ) : (
            <div className={styles.readerPane}>
              {readerLoading ? (
                <div className={styles.loadingState}>{t('readerLoading')}</div>
              ) : pageSnapshot ? (
                <>
                  <div className={styles.readerHero}>
                    <p className={styles.kicker}>{pageSnapshot.siteName}</p>
                    <h2>{pageSnapshot.title}</h2>
                    <p>{pageSnapshot.excerpt}</p>
                    <a href={pageSnapshot.finalUrl} target="_blank" rel="noreferrer">
                      {pageSnapshot.finalUrl}
                    </a>
                  </div>
                  <div className={styles.readerBody}>
                    {pageSnapshot.blocks.length > 0 ? (
                      pageSnapshot.blocks.map((block, index) => (
                        <div key={`${block.type}-${index}`} className={styles[`block${block.type}`]}>
                          {block.type === 'heading' ? <h3>{block.text}</h3> : <p>{block.text}</p>}
                        </div>
                      ))
                    ) : (
                      <div className={styles.emptyBlock}>{t('noReaderContent')}</div>
                    )}
                  </div>
                </>
              ) : (
                <div className={styles.emptyBlock}>{t('readerFallback')}</div>
              )}
            </div>
          )}
        </div>
      </main>

      <section className={styles.inspector}>
        <div className={styles.inspectorCard}>
          <p className={styles.kicker}>{t('inspector')}</p>
          <h2>{pageSnapshot?.title || t('awaitingPage')}</h2>
          <div className={styles.metaGrid}>
            <div>
              <span>{t('mode')}</span>
              <strong>{viewMode === 'browse' ? t('browse') : t('reader')}</strong>
            </div>
            <div>
              <span>{t('language')}</span>
              <strong>{i18n.language}</strong>
            </div>
          </div>

          <div className={styles.summaryCard}>
            <span>{t('summary')}</span>
            <p>{pageSnapshot?.excerpt || t('summaryEmpty')}</p>
          </div>

          {errorText ? <div className={styles.errorBox}>{errorText}</div> : null}
          {flashText ? <div className={styles.flashBox}>{flashText}</div> : null}
        </div>
      </section>
    </div>
  );
};

export default BrowserReaderPage;
