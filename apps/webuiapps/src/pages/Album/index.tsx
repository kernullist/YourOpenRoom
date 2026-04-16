import React, { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { initVibeApp, AppLifecycle } from '@gui/vibe-container';
import {
  useAgentActionListener,
  reportLifecycle,
  fetchVibeInfo,
  type CharacterAppAction,
} from '@/lib';
import './i18n';
import styles from './index.module.scss';

const APP_ID = 8;

interface ImageItem {
  id: string;
  name: string;
  src: string;
  createdAt: number;
}

interface AlbumFilesResponse {
  configured: boolean;
  exists?: boolean;
  files: ImageItem[];
}

const Icons = {
  back: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="15 18 9 12 15 6" />
    </svg>
  ),
  chevronLeft: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="15 18 9 12 15 6" />
    </svg>
  ),
  chevronRight: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="9 6 15 12 9 18" />
    </svg>
  ),
};

function formatImageDate(createdAt: number, lang: string): string {
  if (!createdAt || createdAt <= 0) return '';
  try {
    const date = new Date(createdAt);
    if (isNaN(date.getTime())) return '';
    const locale = lang === 'zh' ? 'zh-CN' : 'en-US';
    return new Intl.DateTimeFormat(locale, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
  } catch {
    return '';
  }
}

const Album: React.FC = () => {
  const { t, i18n } = useTranslation('album');
  const [items, setItems] = useState<ImageItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isConfigured, setIsConfigured] = useState(true);
  const [folderExists, setFolderExists] = useState(true);
  const [previewIndex, setPreviewIndex] = useState(-1);

  const loadAlbumFiles = useCallback(async () => {
    try {
      const res = await fetch('/api/album-files');
      if (!res.ok) throw new Error(`Album API error ${res.status}`);
      const data = (await res.json()) as AlbumFilesResponse;
      setIsConfigured(data.configured);
      setFolderExists(data.exists ?? true);
      setItems(data.files ?? []);
    } catch (error) {
      console.error('[Album] Failed to load album files:', error);
      setItems([]);
      setIsConfigured(false);
      setFolderExists(false);
    }
  }, []);

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
    const init = async () => {
      try {
        reportLifecycle(AppLifecycle.LOADING);

        const manager = await initVibeApp({
          id: APP_ID,
          url: window.location.href,
          type: 'page',
          name: 'Album',
          windowStyle: { width: 800, height: 600 },
        });

        manager.handshake({
          id: APP_ID,
          url: window.location.href,
          type: 'page',
          name: 'Album',
          windowStyle: { width: 800, height: 600 },
        });

        reportLifecycle(AppLifecycle.DOM_READY);

        try {
          await fetchVibeInfo();
        } catch (error) {
          console.warn('[Album] fetchVibeInfo failed:', error);
        }

        await loadAlbumFiles();
        setIsLoading(false);
        reportLifecycle(AppLifecycle.LOADED);
        manager.ready();
      } catch (error) {
        console.error('[Album] Init error:', error);
        setIsLoading(false);
        reportLifecycle(AppLifecycle.ERROR, String(error));
      }
    };

    void init();

    return () => {
      reportLifecycle(AppLifecycle.UNLOADING);
      reportLifecycle(AppLifecycle.DESTROYED);
    };
  }, [loadAlbumFiles]);

  const openPreview = useCallback((index: number) => setPreviewIndex(index), []);
  const closePreview = useCallback(() => setPreviewIndex(-1), []);
  const goPrev = useCallback(() => setPreviewIndex((prev) => (prev > 0 ? prev - 1 : prev)), []);
  const goNext = useCallback(
    () => setPreviewIndex((prev) => (prev < items.length - 1 ? prev + 1 : prev)),
    [items.length],
  );

  useEffect(() => {
    if (previewIndex < 0) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowLeft':
          e.preventDefault();
          goPrev();
          break;
        case 'ArrowRight':
          e.preventDefault();
          goNext();
          break;
        case 'Escape':
          e.preventDefault();
          closePreview();
          break;
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [previewIndex, goPrev, goNext, closePreview]);

  const previewItem = previewIndex >= 0 && previewIndex < items.length ? items[previewIndex] : null;

  if (isLoading) {
    return (
      <div className={styles.album}>
        <div className={styles.loadingState}>
          <div className={styles.spinner} />
        </div>
      </div>
    );
  }

  let emptyText = t('empty');
  if (!isConfigured) emptyText = t('notConfigured');
  else if (!folderExists) emptyText = t('folderMissing');

  return (
    <div className={styles.album}>
      <div className={styles.gridWrap}>
        {items.length === 0 ? (
          <div className={styles.emptyState}>
            <p>{emptyText}</p>
          </div>
        ) : (
          <ul className={styles.grid}>
            {items.map((item, index) => (
              <li key={item.id} className={styles.gridItem}>
                <button type="button" className={styles.thumbBtn} onClick={() => openPreview(index)}>
                  <img src={item.src} alt={item.name} className={styles.thumbImg} loading="lazy" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {previewItem && (
        <div className={styles.previewPage}>
          <div className={styles.previewToolbar}>
            <button type="button" className={styles.previewBackBtn} onClick={closePreview} title={t('back')}>
              {Icons.back}
            </button>
            {(() => {
              const dateStr = formatImageDate(previewItem.createdAt, i18n.language);
              return dateStr ? <span className={styles.previewTitle}>{dateStr}</span> : null;
            })()}
            <span className={styles.previewCounter}>
              {previewIndex + 1} / {items.length}
            </span>
          </div>

          <div className={styles.previewBody}>
            <button
              type="button"
              className={`${styles.navBtn} ${styles.navPrev}`}
              onClick={goPrev}
              disabled={previewIndex <= 0}
              title={t('prev')}
            >
              {Icons.chevronLeft}
            </button>

            <img src={previewItem.src} alt={previewItem.name} className={styles.previewImg} />

            <button
              type="button"
              className={`${styles.navBtn} ${styles.navNext}`}
              onClick={goNext}
              disabled={previewIndex >= items.length - 1}
              title={t('next')}
            >
              {Icons.chevronRight}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default Album;
