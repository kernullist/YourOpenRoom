import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { initVibeApp, AppLifecycle } from '@gui/vibe-container';
import {
  CheckCircle2,
  Eye,
  Image as ImageIcon,
  Monitor,
  Palette,
  RotateCcw,
  ShoppingBag,
  Sparkles,
  Star,
} from 'lucide-react';
import {
  createAppFileApi,
  fetchVibeInfo,
  reportAction,
  reportLifecycle,
  useAgentActionListener,
  useFileSystem,
  type CharacterAppAction,
} from '@/lib';
import {
  ROOM_SHOP_ITEMS,
  buildRoomThemeSnapshot,
  createAppliedRoomThemeState,
  createPreviewRoomThemeState,
  createResetRoomThemeState,
  emitRoomThemeChanged,
  findRoomShopItem,
  getWallpaperBackgroundImage,
  isVideoWallpaper,
  loadRoomThemeState,
  normalizeRoomThemeState,
  parseRoomThemeState,
  persistRoomThemeState,
  type RoomShopCategory,
  type RoomShopItem,
  type RoomThemeState,
} from '@/lib/roomTheme';
import styles from './index.module.scss';

const APP_ID = 21;
const APP_NAME = 'roomshop';
const STATE_FILE = '/state.json';

const roomShopFileApi = createAppFileApi(APP_NAME);

interface CategoryDef {
  id: RoomShopCategory;
  label: string;
  description: string;
  Icon: typeof Sparkles;
}

const CATEGORIES: CategoryDef[] = [
  {
    id: 'featured',
    label: 'Featured',
    description: 'Bright picks for a fast room change',
    Icon: Sparkles,
  },
  {
    id: 'wallpapers',
    label: 'Wallpapers',
    description: 'Tint the Aoi room backdrop',
    Icon: ImageIcon,
  },
  {
    id: 'moods',
    label: 'Desk Mood',
    description: 'Shape the shell tone around Aoi',
    Icon: Palette,
  },
  {
    id: 'collection',
    label: 'My Collection',
    description: 'Your currently applied favorites',
    Icon: Star,
  },
];

function getItemsForCategory(category: RoomShopCategory, state: RoomThemeState): RoomShopItem[] {
  if (category === 'collection') {
    const uniqueItems = [state.activeMoodId, state.activeWallpaperId]
      .map((itemId) => findRoomShopItem(itemId))
      .filter((item): item is RoomShopItem => Boolean(item));
    return Array.from(new Map(uniqueItems.map((item) => [item.id, item])).values());
  }

  if (category === 'wallpapers') {
    return ROOM_SHOP_ITEMS.filter((item) => item.type === 'wallpaper');
  }

  if (category === 'moods') {
    return ROOM_SHOP_ITEMS.filter((item) => item.type === 'deskMood');
  }

  return ROOM_SHOP_ITEMS.filter((item) => item.category === 'featured');
}

function getAppliedLabel(item: RoomShopItem, state: RoomThemeState): string | null {
  if (item.type === 'deskMood' && state.activeMoodId === item.id) {
    return 'Mood active';
  }
  if (state.activeWallpaperId === item.id) {
    return 'Wallpaper active';
  }
  return null;
}

function formatUpdatedAt(updatedAt: number): string {
  if (!updatedAt) return 'Not saved yet';
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(updatedAt);
}

function getActionItemId(action: CharacterAppAction): string | null {
  const itemId = action.params?.itemId ?? action.params?.item_id ?? action.params?.id;
  if (typeof itemId !== 'string') return null;

  const trimmed = itemId.trim();
  return trimmed ? trimmed : null;
}

const RoomShop: React.FC = () => {
  const { initFromCloud, getByPath, saveFile, syncToCloud } = useFileSystem({
    fileApi: roomShopFileApi,
  });
  const previewActiveRef = useRef(false);
  const [category, setCategory] = useState<RoomShopCategory>('featured');
  const [themeState, setThemeState] = useState<RoomThemeState>(() => loadRoomThemeState());
  const [selectedItemId, setSelectedItemId] = useState<string>(() => {
    const snapshot = buildRoomThemeSnapshot(loadRoomThemeState());
    return snapshot.previewItem?.id ?? snapshot.wallpaperItem.id;
  });
  const [loading, setLoading] = useState(true);
  const [statusText, setStatusText] = useState('Loading room shelf...');
  const [errorText, setErrorText] = useState<string | null>(null);

  const snapshot = useMemo(() => buildRoomThemeSnapshot(themeState), [themeState]);
  const selectedItem =
    findRoomShopItem(selectedItemId) ?? snapshot.previewItem ?? snapshot.wallpaperItem;
  const selectedPreviewSnapshot = useMemo(
    () => buildRoomThemeSnapshot(createPreviewRoomThemeState(selectedItem.id, themeState)),
    [selectedItem.id, themeState],
  );
  const selectedPreviewWallpaper = useMemo(() => {
    if (isVideoWallpaper(selectedItem.wallpaper)) {
      return selectedItem.staticFallback ?? selectedPreviewSnapshot.staticFallback;
    }

    return selectedItem.wallpaper;
  }, [selectedItem, selectedPreviewSnapshot.staticFallback]);
  const visibleItems = useMemo(
    () => getItemsForCategory(category, themeState),
    [category, themeState],
  );

  const persistState = useCallback(
    async (nextState: RoomThemeState): Promise<RoomThemeState> => {
      const persisted = normalizeRoomThemeState({
        ...nextState,
        previewItemId: null,
      });
      await syncToCloud(STATE_FILE, persisted);
      saveFile(STATE_FILE, persisted);
      persistRoomThemeState(persisted);
      return persisted;
    },
    [saveFile, syncToCloud],
  );

  const refreshFromCloud = useCallback(async () => {
    await initFromCloud();
    const persistedNode = getByPath(STATE_FILE);
    const nextState = persistedNode?.content
      ? parseRoomThemeState(persistedNode.content)
      : loadRoomThemeState();
    const normalized = persistRoomThemeState(nextState);
    previewActiveRef.current = false;
    setThemeState(normalized);
    setSelectedItemId(normalized.activeWallpaperId);
    emitRoomThemeChanged(normalized, 'refresh');
    return normalized;
  }, [getByPath, initFromCloud]);

  const previewItem = useCallback(
    (itemId: string) => {
      const item = findRoomShopItem(itemId);
      if (!item) {
        setErrorText('That room item is no longer on the shelf.');
        return;
      }

      const nextState = createPreviewRoomThemeState(item.id, themeState);
      setThemeState(nextState);
      setSelectedItemId(item.id);
      setStatusText(`Previewing ${item.name}`);
      setErrorText(null);
      previewActiveRef.current = true;
      emitRoomThemeChanged(nextState, 'preview');
      reportAction(APP_ID, 'PREVIEW_ROOM_ITEM', { itemId: item.id });
    },
    [themeState],
  );

  const applyItem = useCallback(
    async (itemId: string) => {
      const item = findRoomShopItem(itemId);
      if (!item) {
        setErrorText('That room item is no longer on the shelf.');
        return;
      }

      try {
        const nextState = createAppliedRoomThemeState(item.id, themeState);
        const persisted = await persistState(nextState);
        setThemeState(persisted);
        setSelectedItemId(item.id);
        setStatusText(`${item.name} applied`);
        setErrorText(null);
        previewActiveRef.current = false;
        emitRoomThemeChanged(persisted, 'apply');
        reportAction(APP_ID, 'APPLY_ROOM_ITEM', { itemId: item.id });
      } catch (error) {
        setErrorText(error instanceof Error ? error.message : String(error));
      }
    },
    [persistState, themeState],
  );

  const resetTheme = useCallback(async () => {
    try {
      const nextState = createResetRoomThemeState();
      const persisted = await persistState(nextState);
      setThemeState(persisted);
      setSelectedItemId(persisted.activeWallpaperId);
      setStatusText('Default room restored');
      setErrorText(null);
      previewActiveRef.current = false;
      emitRoomThemeChanged(persisted, 'reset');
      reportAction(APP_ID, 'RESET_ROOM_THEME', {});
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : String(error));
    }
  }, [persistState]);

  const handleAgentAction = useCallback(
    async (action: CharacterAppAction): Promise<string> => {
      switch (action.action_type) {
        case 'REFRESH_ROOM_SHOP': {
          await refreshFromCloud();
          return 'success';
        }
        case 'PREVIEW_ROOM_ITEM': {
          const itemId = getActionItemId(action);
          if (!itemId) return 'error: missing itemId';
          previewItem(itemId);
          return 'success';
        }
        case 'APPLY_ROOM_ITEM': {
          const itemId = getActionItemId(action);
          if (!itemId) return 'error: missing itemId';
          await applyItem(itemId);
          return 'success';
        }
        case 'RESET_ROOM_THEME': {
          await resetTheme();
          return 'success';
        }
        default:
          return `error: unknown action_type ${action.action_type}`;
      }
    },
    [applyItem, previewItem, refreshFromCloud, resetTheme],
  );

  useAgentActionListener(APP_ID, handleAgentAction);

  useEffect(() => {
    return () => {
      if (!previewActiveRef.current) return;
      emitRoomThemeChanged(loadRoomThemeState(), 'preview-dismiss');
    };
  }, []);

  useEffect(() => {
    const init = async () => {
      try {
        reportLifecycle(AppLifecycle.LOADING);
        const manager = await initVibeApp({
          id: APP_ID,
          url: window.location.href,
          type: 'page',
          name: 'Room Shop',
          windowStyle: { width: 960, height: 640 },
        });
        reportLifecycle(AppLifecycle.DOM_READY);
        await fetchVibeInfo().catch((error) =>
          console.warn('[RoomShop] fetchVibeInfo failed', error),
        );
        await refreshFromCloud();
        setLoading(false);
        setStatusText('Pick a room mood');
        reportLifecycle(AppLifecycle.LOADED);
        manager.ready();
      } catch (error) {
        console.error('[RoomShop] Init error:', error);
        setLoading(false);
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

  return (
    <main className={styles.roomShop} data-testid="room-shop">
      <aside className={styles.sidebar}>
        <div className={styles.brand}>
          <div className={styles.brandMark}>
            <ShoppingBag size={22} />
          </div>
          <div>
            <h1>Room Shop</h1>
            <p>Decorate the desktop</p>
          </div>
        </div>

        <nav className={styles.categoryList} aria-label="Room Shop categories">
          {CATEGORIES.map((entry) => {
            const count = getItemsForCategory(entry.id, themeState).length;
            const active = category === entry.id;
            return (
              <button
                key={entry.id}
                className={`${styles.categoryButton} ${active ? styles.categoryActive : ''}`}
                onClick={() => setCategory(entry.id)}
              >
                <entry.Icon size={18} />
                <span>
                  <strong>{entry.label}</strong>
                  <small>{count} items</small>
                </span>
              </button>
            );
          })}
        </nav>

        <div className={styles.shelfNote}>
          <Sparkles size={16} />
          <p>{statusText}</p>
        </div>
      </aside>

      <section className={styles.shopPane}>
        <header className={styles.shopHeader}>
          <div>
            <p>{CATEGORIES.find((entry) => entry.id === category)?.description}</p>
            <h2>{CATEGORIES.find((entry) => entry.id === category)?.label}</h2>
          </div>
          <button className={styles.resetButton} onClick={() => void resetTheme()}>
            <RotateCcw size={16} />
            Reset
          </button>
        </header>

        {loading ? (
          <div className={styles.emptyState}>Arranging the shelf...</div>
        ) : (
          <div className={styles.itemGrid}>
            {visibleItems.map((item) => {
              const appliedLabel = getAppliedLabel(item, themeState);
              const previewing = themeState.previewItemId === item.id;
              const selected = selectedItem.id === item.id;

              return (
                <article
                  key={item.id}
                  className={`${styles.itemCard} ${selected ? styles.itemSelected : ''}`}
                  onClick={() => setSelectedItemId(item.id)}
                >
                  <div className={styles.itemSwatch} style={{ background: item.swatch }}>
                    <div className={styles.swatchWindow} />
                    <div className={styles.swatchIcon} />
                    {appliedLabel && (
                      <span className={styles.itemState}>
                        <CheckCircle2 size={13} />
                        {appliedLabel}
                      </span>
                    )}
                    {previewing && (
                      <span className={styles.previewState}>
                        <Eye size={13} />
                        Preview
                      </span>
                    )}
                  </div>
                  <div className={styles.itemBody}>
                    <div className={styles.itemTitleRow}>
                      <h3>{item.name}</h3>
                      <span>{item.type === 'deskMood' ? 'Mood' : 'Wallpaper'}</span>
                    </div>
                    <p>{item.description}</p>
                    <div className={styles.tags}>
                      {item.tags.map((tag) => (
                        <span key={tag}>{tag}</span>
                      ))}
                    </div>
                    <div className={styles.cardActions}>
                      <button
                        className={styles.previewButton}
                        onClick={(event) => {
                          event.stopPropagation();
                          previewItem(item.id);
                        }}
                      >
                        <Eye size={15} />
                        Preview
                      </button>
                      <button
                        className={styles.applyButton}
                        onClick={(event) => {
                          event.stopPropagation();
                          void applyItem(item.id);
                        }}
                      >
                        <CheckCircle2 size={15} />
                        Apply
                      </button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      <aside className={styles.previewPane}>
        <div className={styles.previewHeader}>
          <div>
            <p>Live Preview</p>
            <h2>{selectedItem.name}</h2>
          </div>
          <Monitor size={19} />
        </div>

        <div
          className={styles.desktopPreview}
          style={{
            backgroundImage: getWallpaperBackgroundImage(selectedPreviewWallpaper),
          }}
        >
          <div className={styles.previewOverlay} />
          <div className={styles.previewIcons}>
            <span />
            <span />
            <span />
          </div>
          <div className={styles.previewWindow}>
            <div style={{ background: selectedPreviewSnapshot.tokens.windowTitleBackground }} />
            <section style={{ background: selectedPreviewSnapshot.tokens.windowBackground }}>
              <strong />
              <span />
              <span />
            </section>
          </div>
          <div
            className={styles.previewDock}
            style={{
              background: selectedPreviewSnapshot.tokens.bottomBarBackground,
              borderColor: selectedPreviewSnapshot.tokens.bottomBarBorder,
            }}
          >
            <span />
            <span />
            <span />
          </div>
        </div>

        <div className={styles.summary}>
          <div>
            <span>Wallpaper</span>
            <strong>{selectedPreviewSnapshot.wallpaperItem.name}</strong>
          </div>
          <div>
            <span>Mood</span>
            <strong>{selectedPreviewSnapshot.moodItem.name}</strong>
          </div>
          <div>
            <span>Live wallpaper</span>
            <strong>{selectedPreviewSnapshot.liveWallpaper ? 'On' : 'Off'}</strong>
          </div>
          <div>
            <span>Saved</span>
            <strong>{formatUpdatedAt(themeState.updatedAt)}</strong>
          </div>
        </div>

        {errorText && <div className={styles.errorBox}>{errorText}</div>}

        <div className={styles.previewActions}>
          <button onClick={() => previewItem(selectedItem.id)}>
            <Eye size={16} />
            Preview
          </button>
          <button onClick={() => void applyItem(selectedItem.id)}>
            <CheckCircle2 size={16} />
            Apply
          </button>
        </div>
      </aside>
    </main>
  );
};

export default RoomShop;
