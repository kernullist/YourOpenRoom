import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  FolderOpen,
  Grid3X3,
  HardDrive,
  Image as ImageIcon,
  RefreshCw,
  Save,
  Search,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import { initVibeApp, AppLifecycle } from '@gui/vibe-container';
import {
  useAgentActionListener,
  reportLifecycle,
  fetchVibeInfo,
  type CharacterAppAction,
} from '@/lib';
import { loadPersistedConfig, savePersistedConfig } from '@/lib/configPersistence';
import './i18n';
import styles from './index.module.scss';

const APP_ID = 8;
const IMAGE_ACCEPT = '.jpg,.jpeg,.png,.gif,.webp,.bmp,.avif';
const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif']);
const DEFAULT_WINDOW_STYLE = { width: 1080, height: 760 };

type AlbumSourceMode = 'configured' | 'picked';
type SortMode = 'newest' | 'oldest' | 'name' | 'folder';

interface ImageItem {
  id: string;
  name: string;
  src: string;
  createdAt: number;
  relativePath?: string;
  folder?: string;
  size?: number;
  source?: AlbumSourceMode;
}

interface AlbumFilesResponse {
  configured: boolean;
  exists?: boolean;
  photoDirectory?: string | null;
  files: ImageItem[];
}

interface BrowserFileHandle {
  kind: 'file';
  name: string;
  getFile: () => Promise<File>;
}

interface BrowserDirectoryHandle {
  kind: 'directory';
  name: string;
  values: () => AsyncIterable<BrowserFileHandle | BrowserDirectoryHandle>;
}

interface DirectoryPickerWindow extends Window {
  showDirectoryPicker?: () => Promise<BrowserDirectoryHandle>;
}

type FileWithRelativePath = File & { webkitRelativePath?: string };

function formatImageDate(createdAt: number, lang: string, compact = false): string {
  if (!createdAt || createdAt <= 0) return '';
  try {
    const date = new Date(createdAt);
    if (Number.isNaN(date.getTime())) return '';
    const locale = lang === 'zh' ? 'zh-CN' : lang === 'ko' ? 'ko-KR' : 'en-US';
    return new Intl.DateTimeFormat(locale, {
      year: 'numeric',
      month: compact ? 'short' : 'long',
      day: 'numeric',
      ...(compact ? {} : { hour: '2-digit', minute: '2-digit' }),
    }).format(date);
  } catch {
    return '';
  }
}

function formatBytes(value: number | undefined): string {
  if (!value || value <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size >= 10 || unitIndex === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unitIndex]}`;
}

function getFolderFromPath(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const index = normalized.lastIndexOf('/');
  return index > 0 ? normalized.slice(0, index) : '';
}

function getRootFolderName(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized.split('/').filter(Boolean).pop() ?? normalized;
}

function isImageFile(file: File | { name: string; type?: string }): boolean {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  return IMAGE_EXTENSIONS.has(ext) || file.type?.startsWith('image/') === true;
}

function sortImages(items: ImageItem[], sortMode: SortMode): ImageItem[] {
  const next = [...items];
  next.sort((a, b) => {
    if (sortMode === 'oldest') return a.createdAt - b.createdAt;
    if (sortMode === 'name') return a.name.localeCompare(b.name);
    if (sortMode === 'folder') {
      const folderCompare = (a.folder ?? '').localeCompare(b.folder ?? '');
      return folderCompare || a.name.localeCompare(b.name);
    }
    return b.createdAt - a.createdAt;
  });
  return next;
}

async function collectDirectoryImages(
  directory: BrowserDirectoryHandle,
  prefix = '',
): Promise<Array<{ file: File; relativePath: string }>> {
  const collected: Array<{ file: File; relativePath: string }> = [];
  for await (const entry of directory.values()) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.kind === 'directory') {
      collected.push(...(await collectDirectoryImages(entry, relativePath)));
      continue;
    }
    const file = await entry.getFile();
    if (isImageFile(file)) collected.push({ file, relativePath });
  }
  return collected;
}

const Album: React.FC = () => {
  const { t, i18n } = useTranslation('album');
  const [items, setItems] = useState<ImageItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isSavingConfig, setIsSavingConfig] = useState(false);
  const [isConfigured, setIsConfigured] = useState(true);
  const [folderExists, setFolderExists] = useState(true);
  const [sourceMode, setSourceMode] = useState<AlbumSourceMode>('configured');
  const [folderLabel, setFolderLabel] = useState('');
  const [folderPath, setFolderPath] = useState('');
  const [pathDraft, setPathDraft] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [sortMode, setSortMode] = useState<SortMode>('newest');
  const [thumbSize, setThumbSize] = useState(156);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const objectUrlsRef = useRef<string[]>([]);

  const clearObjectUrls = useCallback(() => {
    for (const url of objectUrlsRef.current) {
      URL.revokeObjectURL(url);
    }
    objectUrlsRef.current = [];
  }, []);

  const loadAlbumFiles = useCallback(async () => {
    setIsRefreshing(true);
    setErrorText(null);
    try {
      const [res, persisted] = await Promise.all([
        fetch('/api/album-files'),
        loadPersistedConfig().catch(() => null),
      ]);
      if (!res.ok) throw new Error(`Album API error ${res.status}`);
      const data = (await res.json()) as AlbumFilesResponse;
      const configuredPath =
        data.photoDirectory?.trim() || persisted?.album?.photoDirectory?.trim() || '';

      clearObjectUrls();
      setSourceMode('configured');
      setIsConfigured(data.configured);
      setFolderExists(data.exists ?? true);
      setFolderPath(configuredPath);
      setPathDraft(configuredPath);
      setFolderLabel(configuredPath ? getRootFolderName(configuredPath) : '');
      setItems(
        (data.files ?? []).map((item) => {
          const relativePath = item.relativePath ?? item.id;
          return {
            ...item,
            relativePath,
            folder: item.folder ?? getFolderFromPath(relativePath),
            source: 'configured',
          };
        }),
      );
      setPreviewId(null);
    } catch (error) {
      console.error('[Album] Failed to load album files:', error);
      clearObjectUrls();
      setItems([]);
      setIsConfigured(false);
      setFolderExists(false);
      setErrorText(error instanceof Error ? error.message : String(error));
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, [clearObjectUrls]);

  const loadPickedFiles = useCallback(
    (files: Array<{ file: File; relativePath: string }>, nextFolderLabel: string) => {
      clearObjectUrls();
      const nextItems = files
        .map(({ file, relativePath }, index) => {
          const src = URL.createObjectURL(file);
          objectUrlsRef.current.push(src);
          return {
            id: `picked-${relativePath || file.name}-${index}`,
            name: file.name,
            src,
            createdAt: file.lastModified || Date.now(),
            relativePath,
            folder: getFolderFromPath(relativePath),
            size: file.size,
            source: 'picked' as const,
          };
        })
        .sort((a, b) => b.createdAt - a.createdAt);

      setItems(nextItems);
      setSourceMode('picked');
      setIsConfigured(true);
      setFolderExists(true);
      setFolderLabel(nextFolderLabel);
      setPreviewId(null);
      setSearchQuery('');
      setErrorText(null);
    },
    [clearObjectUrls],
  );

  const handlePickFolder = useCallback(async () => {
    setErrorText(null);
    const pickerWindow = window as DirectoryPickerWindow;
    if (!pickerWindow.showDirectoryPicker) {
      folderInputRef.current?.click();
      return;
    }

    try {
      const directory = await pickerWindow.showDirectoryPicker();
      const files = await collectDirectoryImages(directory);
      loadPickedFiles(files, directory.name);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setErrorText(error instanceof Error ? error.message : String(error));
    }
  }, [loadPickedFiles]);

  const handleFolderInputChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files ?? []) as FileWithRelativePath[];
      if (files.length === 0) return;
      const imageFiles = files.filter(isImageFile).map((file) => ({
        file,
        relativePath: file.webkitRelativePath || file.name,
      }));
      const rootName = files[0]?.webkitRelativePath?.split('/')[0] || t('source.pickedFolder');
      loadPickedFiles(imageFiles, rootName);
      event.target.value = '';
    },
    [loadPickedFiles, t],
  );

  const handleSavePath = useCallback(async () => {
    setIsSavingConfig(true);
    setErrorText(null);
    try {
      const nextPath = pathDraft.trim();
      const existing = await loadPersistedConfig();
      await savePersistedConfig({
        ...(existing ?? {}),
        album: {
          ...(existing?.album ?? {}),
          photoDirectory: nextPath || undefined,
        },
      });
      await loadAlbumFiles();
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSavingConfig(false);
    }
  }, [loadAlbumFiles, pathDraft]);

  const handleAgentAction = useCallback(
    async (action: CharacterAppAction): Promise<string> => {
      if (action.action_type === 'REFRESH') {
        await loadAlbumFiles();
        return 'success';
      }
      return `error: unknown action_type ${action.action_type}`;
    },
    [loadAlbumFiles],
  );

  useAgentActionListener(APP_ID, handleAgentAction);

  useEffect(() => {
    folderInputRef.current?.setAttribute('webkitdirectory', '');
    folderInputRef.current?.setAttribute('directory', '');
  }, []);

  useEffect(() => {
    const init = async () => {
      try {
        reportLifecycle(AppLifecycle.LOADING);

        const manager = await initVibeApp({
          id: APP_ID,
          url: window.location.href,
          type: 'page',
          name: 'Album',
          windowStyle: DEFAULT_WINDOW_STYLE,
        });

        manager.handshake({
          id: APP_ID,
          url: window.location.href,
          type: 'page',
          name: 'Album',
          windowStyle: DEFAULT_WINDOW_STYLE,
        });

        reportLifecycle(AppLifecycle.DOM_READY);
        await fetchVibeInfo().catch((error) =>
          console.warn('[Album] fetchVibeInfo failed:', error),
        );
        await loadAlbumFiles();
        reportLifecycle(AppLifecycle.LOADED);
        manager.ready();
      } catch (error) {
        console.error('[Album] Init error:', error);
        setIsLoading(false);
        setErrorText(error instanceof Error ? error.message : String(error));
        reportLifecycle(AppLifecycle.ERROR, String(error));
      }
    };

    void init();

    return () => {
      clearObjectUrls();
      reportLifecycle(AppLifecycle.UNLOADING);
      reportLifecycle(AppLifecycle.DESTROYED);
    };
  }, [clearObjectUrls, loadAlbumFiles]);

  const filteredItems = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const matches = query
      ? items.filter((item) => {
          const dateText = formatImageDate(item.createdAt, i18n.language, true);
          const haystack =
            `${item.name} ${item.relativePath ?? ''} ${item.folder ?? ''} ${dateText}`.toLowerCase();
          return haystack.includes(query);
        })
      : items;
    return sortImages(matches, sortMode);
  }, [i18n.language, items, searchQuery, sortMode]);

  const folderCount = useMemo(() => {
    const folders = new Set(items.map((item) => item.folder ?? '').filter(Boolean));
    return items.length > 0 ? Math.max(folders.size, 1) : 0;
  }, [items]);

  const latestDate = useMemo(() => {
    const latest = items.reduce((max, item) => Math.max(max, item.createdAt || 0), 0);
    return formatImageDate(latest, i18n.language, true);
  }, [i18n.language, items]);

  const totalSize = useMemo(() => items.reduce((sum, item) => sum + (item.size ?? 0), 0), [items]);
  const previewIndex = previewId ? filteredItems.findIndex((item) => item.id === previewId) : -1;
  const previewItem = previewIndex >= 0 ? filteredItems[previewIndex] : null;
  const isPickedSource = sourceMode === 'picked';
  const sourceLabel = isPickedSource
    ? t('source.sessionFolder')
    : folderPath
      ? t('source.configuredFolder')
      : t('source.noFolder');

  const openPreview = useCallback((id: string) => setPreviewId(id), []);
  const closePreview = useCallback(() => setPreviewId(null), []);
  const goPrev = useCallback(() => {
    setPreviewId((current) => {
      const index = current ? filteredItems.findIndex((item) => item.id === current) : -1;
      return index > 0 ? filteredItems[index - 1].id : current;
    });
  }, [filteredItems]);
  const goNext = useCallback(() => {
    setPreviewId((current) => {
      const index = current ? filteredItems.findIndex((item) => item.id === current) : -1;
      return index >= 0 && index < filteredItems.length - 1 ? filteredItems[index + 1].id : current;
    });
  }, [filteredItems]);

  useEffect(() => {
    if (previewId && !filteredItems.some((item) => item.id === previewId)) {
      setPreviewId(null);
    }
  }, [filteredItems, previewId]);

  useEffect(() => {
    if (!previewItem) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      switch (event.key) {
        case 'ArrowLeft':
          event.preventDefault();
          goPrev();
          break;
        case 'ArrowRight':
          event.preventDefault();
          goNext();
          break;
        case 'Escape':
          event.preventDefault();
          closePreview();
          break;
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [closePreview, goNext, goPrev, previewItem]);

  const emptyTitle = !isConfigured
    ? t('empty.notConfiguredTitle')
    : !folderExists
      ? t('empty.folderMissingTitle')
      : items.length > 0
        ? t('empty.noResultsTitle')
        : t('empty.noImagesTitle');
  const emptyCopy = !isConfigured
    ? t('empty.notConfiguredCopy')
    : !folderExists
      ? t('empty.folderMissingCopy')
      : items.length > 0
        ? t('empty.noResultsCopy')
        : t('empty.noImagesCopy');

  const albumStyle = { '--thumb-size': `${thumbSize}px` } as React.CSSProperties;

  return (
    <div className={styles.album} style={albumStyle}>
      <input
        ref={folderInputRef}
        className={styles.hiddenFileInput}
        type="file"
        accept={IMAGE_ACCEPT}
        multiple
        onChange={handleFolderInputChange}
      />

      <header className={styles.hero}>
        <div className={styles.heroMain}>
          <div className={styles.appMark}>
            <ImageIcon size={20} />
          </div>
          <div>
            <p className={styles.kicker}>{t('kicker')}</p>
            <h1>{t('title')}</h1>
            <p className={styles.subtitle}>{t('subtitle')}</p>
          </div>
        </div>
        <div className={styles.heroActions}>
          <button className={styles.iconButton} type="button" onClick={handlePickFolder}>
            <FolderOpen size={16} />
            <span>{t('actions.pickFolder')}</span>
          </button>
          <button
            className={styles.iconButton}
            type="button"
            onClick={() => void loadAlbumFiles()}
            disabled={isRefreshing}
          >
            <RefreshCw size={16} className={isRefreshing ? styles.spinningIcon : ''} />
            <span>{isRefreshing ? t('actions.refreshing') : t('actions.refresh')}</span>
          </button>
        </div>
      </header>

      <section className={styles.controlPanel}>
        <div className={styles.sourceCard}>
          <div className={styles.sourceHeader}>
            <span className={styles.sourceIcon}>
              <HardDrive size={16} />
            </span>
            <div>
              <strong>{folderLabel || t('source.folderLabelFallback')}</strong>
              <p>{sourceLabel}</p>
            </div>
          </div>
          <label className={styles.pathField}>
            <span>{t('fields.photoDirectory')}</span>
            <div className={styles.pathInputRow}>
              <input
                value={pathDraft}
                onChange={(event) => setPathDraft(event.target.value)}
                placeholder={t('fields.photoDirectoryPlaceholder')}
              />
              <button type="button" onClick={() => void handleSavePath()} disabled={isSavingConfig}>
                <Save size={15} />
                <span>{isSavingConfig ? t('actions.saving') : t('actions.savePath')}</span>
              </button>
            </div>
          </label>
        </div>

        <div className={styles.statsGrid}>
          <div className={styles.statItem}>
            <span>{t('stats.photos')}</span>
            <strong>{items.length}</strong>
          </div>
          <div className={styles.statItem}>
            <span>{t('stats.folders')}</span>
            <strong>{folderCount}</strong>
          </div>
          <div className={styles.statItem}>
            <span>{t('stats.latest')}</span>
            <strong>{latestDate || '-'}</strong>
          </div>
          <div className={styles.statItem}>
            <span>{t('stats.size')}</span>
            <strong>{formatBytes(totalSize) || '-'}</strong>
          </div>
        </div>
      </section>

      <section className={styles.toolbar}>
        <label className={styles.searchBox}>
          <Search size={16} />
          <input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder={t('fields.search')}
          />
          {searchQuery ? (
            <button type="button" onClick={() => setSearchQuery('')} title={t('actions.clear')}>
              <X size={14} />
            </button>
          ) : null}
        </label>
        <label className={styles.selectField}>
          <SlidersHorizontal size={16} />
          <select
            value={sortMode}
            onChange={(event) => setSortMode(event.target.value as SortMode)}
          >
            <option value="newest">{t('sort.newest')}</option>
            <option value="oldest">{t('sort.oldest')}</option>
            <option value="name">{t('sort.name')}</option>
            <option value="folder">{t('sort.folder')}</option>
          </select>
        </label>
        <label className={styles.sizeField}>
          <Grid3X3 size={16} />
          <input
            type="range"
            min={120}
            max={260}
            step={8}
            value={thumbSize}
            onChange={(event) => setThumbSize(Number(event.target.value))}
            aria-label={t('fields.thumbSize')}
          />
        </label>
      </section>

      {errorText ? <div className={styles.errorBar}>{errorText}</div> : null}

      <main className={styles.galleryShell}>
        {isLoading ? (
          <div className={styles.skeletonGrid}>
            {Array.from({ length: 18 }, (_, index) => (
              <div key={index} className={styles.skeletonItem} />
            ))}
          </div>
        ) : filteredItems.length === 0 ? (
          <div className={styles.emptyState}>
            <div className={styles.emptyIcon}>
              <ImageIcon size={28} />
            </div>
            <h2>{emptyTitle}</h2>
            <p>{emptyCopy}</p>
            <div className={styles.emptyActions}>
              <button className={styles.primaryButton} type="button" onClick={handlePickFolder}>
                <FolderOpen size={16} />
                <span>{t('actions.pickFolder')}</span>
              </button>
              <button
                className={styles.secondaryButton}
                type="button"
                onClick={() => void loadAlbumFiles()}
              >
                <RefreshCw size={16} />
                <span>{t('actions.refresh')}</span>
              </button>
            </div>
          </div>
        ) : (
          <ul className={styles.grid} aria-label={t('galleryLabel')}>
            {filteredItems.map((item) => {
              const dateStr = formatImageDate(item.createdAt, i18n.language, true);
              return (
                <li key={item.id} className={styles.gridItem}>
                  <button
                    type="button"
                    className={styles.thumbButton}
                    onClick={() => openPreview(item.id)}
                    title={item.relativePath ?? item.name}
                  >
                    <img src={item.src} alt={item.name} loading="lazy" decoding="async" />
                    <span className={styles.thumbShade} />
                    <span className={styles.thumbMeta}>
                      <strong>{item.name}</strong>
                      <small>{item.folder || dateStr || t('source.rootFolder')}</small>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </main>

      {previewItem ? (
        <div className={styles.previewPage}>
          <header className={styles.previewToolbar}>
            <button
              type="button"
              className={styles.roundButton}
              onClick={closePreview}
              title={t('back')}
            >
              <ArrowLeft size={18} />
            </button>
            <div className={styles.previewTitle}>
              <strong>{previewItem.name}</strong>
              <span>{previewItem.relativePath ?? previewItem.name}</span>
            </div>
            <div className={styles.previewCounter}>
              {previewIndex + 1} / {filteredItems.length}
            </div>
          </header>

          <div className={styles.previewBody}>
            <button
              type="button"
              className={`${styles.navButton} ${styles.navPrev}`}
              onClick={goPrev}
              disabled={previewIndex <= 0}
              title={t('prev')}
            >
              <ChevronLeft size={26} />
            </button>

            <div className={styles.previewImageFrame}>
              <img
                src={previewItem.src}
                alt={previewItem.name}
                className={styles.previewImage}
                decoding="async"
              />
            </div>

            <button
              type="button"
              className={`${styles.navButton} ${styles.navNext}`}
              onClick={goNext}
              disabled={previewIndex >= filteredItems.length - 1}
              title={t('next')}
            >
              <ChevronRight size={26} />
            </button>

            <aside className={styles.previewInfo}>
              <div>
                <span>{t('info.date')}</span>
                <strong>
                  <CalendarDays size={15} />
                  {formatImageDate(previewItem.createdAt, i18n.language) || '-'}
                </strong>
              </div>
              <div>
                <span>{t('info.folder')}</span>
                <strong>{previewItem.folder || t('source.rootFolder')}</strong>
              </div>
              <div>
                <span>{t('info.size')}</span>
                <strong>{formatBytes(previewItem.size) || '-'}</strong>
              </div>
            </aside>
          </div>

          <div className={styles.filmstrip}>
            {filteredItems.slice(Math.max(0, previewIndex - 8), previewIndex + 9).map((item) => (
              <button
                key={item.id}
                type="button"
                className={item.id === previewItem.id ? styles.filmstripActive : ''}
                onClick={() => openPreview(item.id)}
              >
                <img src={item.src} alt={item.name} loading="lazy" decoding="async" />
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
};

export default Album;
