import type { CSSProperties } from 'react';

export type RoomItemType = 'wallpaper' | 'deskMood';
export type RoomShopCategory = 'featured' | 'wallpapers' | 'moods' | 'collection';

export interface RoomThemeTokens {
  accent: string;
  accentSoft: string;
  desktopOverlay: string;
  desktopLiveOverlay: string;
  liveFilter: string;
  iconBackground: string;
  iconBorder: string;
  iconColor?: string;
  bottomBarBackground: string;
  bottomBarBorder: string;
  windowBackground: string;
  windowTitleBackground: string;
  windowShadow: string;
  previewFloor: string;
}

export interface RoomShopItem {
  id: string;
  type: RoomItemType;
  name: string;
  description: string;
  category: Exclude<RoomShopCategory, 'collection'>;
  tags: string[];
  wallpaper: string;
  staticFallback?: string;
  liveWallpaper: boolean;
  swatch: string;
  tokens: RoomThemeTokens;
}

export interface RoomThemeState {
  activeWallpaperId: string;
  activeMoodId: string;
  previewItemId: string | null;
  liveWallpaper: boolean;
  updatedAt: number;
}

export interface RoomThemeSnapshot {
  state: RoomThemeState;
  wallpaperItem: RoomShopItem;
  moodItem: RoomShopItem;
  previewItem: RoomShopItem | null;
  wallpaper: string;
  staticFallback: string;
  liveWallpaper: boolean;
  tokens: RoomThemeTokens;
}

export const ROOM_THEME_STORAGE_KEY = 'openroom-room-theme-v1';
export const ROOM_THEME_EVENT = 'openroom-room-theme-changed';

export const DEFAULT_VIDEO_WALLPAPER =
  'https://cdn.openroom.ai/public-cdn-s3-us-west-2/talkie-op-img/1609284623_1772622757413_1.mp4';

export const DEFAULT_STATIC_WALLPAPER =
  'https://cdn.openroom.ai/public-cdn-s3-us-west-2/talkie-op-img/image/437110625_1772619481913_Aoi_default_Commander_Room.jpg';

export const DEFAULT_ROOM_ITEM_ID = 'aoi-commander-room';

const defaultTokens: RoomThemeTokens = {
  accent: '#faea5f',
  accentSoft: 'rgba(250, 234, 95, 0.28)',
  desktopOverlay:
    'linear-gradient(to right, rgba(0, 0, 0, 0.7) 0%, rgba(0, 0, 0, 0.3) 14%, rgba(0, 0, 0, 0.05) 35%, rgba(0, 0, 0, 0.05) 70%, rgba(0, 0, 0, 0.3) 90%, rgba(0, 0, 0, 0.65) 100%)',
  desktopLiveOverlay:
    'linear-gradient(to right, rgba(0, 0, 0, 0.42) 0%, rgba(0, 0, 0, 0.14) 16%, rgba(0, 0, 0, 0.04) 36%, rgba(0, 0, 0, 0.04) 70%, rgba(0, 0, 0, 0.16) 88%, rgba(0, 0, 0, 0.44) 100%)',
  liveFilter: 'saturate(1.08) contrast(1.04) brightness(0.82)',
  iconBackground: 'rgba(0, 0, 0, 0.45)',
  iconBorder: 'rgba(255, 255, 255, 0.16)',
  bottomBarBackground: 'rgba(0, 0, 0, 0.45)',
  bottomBarBorder: 'rgba(255, 255, 255, 0.1)',
  windowBackground: '#1c1d20',
  windowTitleBackground: '#282a2a',
  windowShadow: '0 8px 32px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.08)',
  previewFloor: 'linear-gradient(135deg, rgba(250, 234, 95, 0.22), rgba(0, 0, 0, 0.2))',
};

const cozyTokens: RoomThemeTokens = {
  accent: '#ffb86b',
  accentSoft: 'rgba(255, 184, 107, 0.26)',
  desktopOverlay:
    'linear-gradient(to right, rgba(25, 13, 8, 0.72), rgba(49, 26, 14, 0.24) 28%, rgba(32, 15, 10, 0.18) 70%, rgba(15, 8, 6, 0.68))',
  desktopLiveOverlay:
    'linear-gradient(to right, rgba(24, 13, 8, 0.56), rgba(68, 34, 14, 0.18) 34%, rgba(34, 16, 9, 0.18) 72%, rgba(15, 8, 6, 0.54))',
  liveFilter: 'saturate(1.12) contrast(1.02) brightness(0.86)',
  iconBackground: 'rgba(80, 39, 22, 0.48)',
  iconBorder: 'rgba(255, 184, 107, 0.36)',
  iconColor: '#ffd09a',
  bottomBarBackground: 'rgba(42, 22, 14, 0.62)',
  bottomBarBorder: 'rgba(255, 184, 107, 0.26)',
  windowBackground: '#241913',
  windowTitleBackground: '#352116',
  windowShadow: '0 14px 42px rgba(10, 5, 3, 0.56), 0 0 0 1px rgba(255, 184, 107, 0.14)',
  previewFloor: 'linear-gradient(135deg, rgba(255, 184, 107, 0.28), rgba(61, 30, 18, 0.46))',
};

const rainTokens: RoomThemeTokens = {
  accent: '#7dd3fc',
  accentSoft: 'rgba(125, 211, 252, 0.24)',
  desktopOverlay:
    'linear-gradient(to right, rgba(5, 14, 22, 0.78), rgba(13, 35, 45, 0.22) 32%, rgba(9, 18, 28, 0.2) 72%, rgba(4, 10, 18, 0.72))',
  desktopLiveOverlay:
    'linear-gradient(to right, rgba(4, 11, 18, 0.62), rgba(10, 32, 42, 0.16) 34%, rgba(8, 18, 28, 0.18) 72%, rgba(4, 10, 18, 0.58))',
  liveFilter: 'saturate(1.04) contrast(1.05) brightness(0.8)',
  iconBackground: 'rgba(14, 37, 52, 0.5)',
  iconBorder: 'rgba(125, 211, 252, 0.36)',
  iconColor: '#bae6fd',
  bottomBarBackground: 'rgba(7, 24, 36, 0.62)',
  bottomBarBorder: 'rgba(125, 211, 252, 0.22)',
  windowBackground: '#111b24',
  windowTitleBackground: '#152635',
  windowShadow: '0 14px 44px rgba(1, 8, 15, 0.62), 0 0 0 1px rgba(125, 211, 252, 0.14)',
  previewFloor: 'linear-gradient(135deg, rgba(125, 211, 252, 0.24), rgba(14, 35, 47, 0.48))',
};

const arcadeTokens: RoomThemeTokens = {
  accent: '#fb4dff',
  accentSoft: 'rgba(251, 77, 255, 0.25)',
  desktopOverlay:
    'linear-gradient(to right, rgba(18, 5, 26, 0.78), rgba(38, 8, 55, 0.28) 28%, rgba(12, 10, 34, 0.18) 72%, rgba(10, 4, 22, 0.76))',
  desktopLiveOverlay:
    'linear-gradient(to right, rgba(18, 5, 26, 0.64), rgba(38, 8, 55, 0.18) 34%, rgba(12, 10, 34, 0.18) 72%, rgba(10, 4, 22, 0.6))',
  liveFilter: 'saturate(1.22) contrast(1.08) brightness(0.88)',
  iconBackground: 'rgba(45, 14, 67, 0.56)',
  iconBorder: 'rgba(251, 77, 255, 0.38)',
  iconColor: '#f0abfc',
  bottomBarBackground: 'rgba(28, 10, 48, 0.64)',
  bottomBarBorder: 'rgba(45, 212, 191, 0.28)',
  windowBackground: '#190f2a',
  windowTitleBackground: '#271443',
  windowShadow: '0 14px 44px rgba(7, 2, 18, 0.62), 0 0 0 1px rgba(251, 77, 255, 0.16)',
  previewFloor: 'linear-gradient(135deg, rgba(251, 77, 255, 0.24), rgba(45, 212, 191, 0.18))',
};

const pastelTokens: RoomThemeTokens = {
  accent: '#f9a8d4',
  accentSoft: 'rgba(249, 168, 212, 0.28)',
  desktopOverlay:
    'linear-gradient(to right, rgba(34, 20, 32, 0.5), rgba(255, 255, 255, 0.04) 34%, rgba(255, 255, 255, 0.03) 72%, rgba(29, 19, 34, 0.48))',
  desktopLiveOverlay:
    'linear-gradient(to right, rgba(34, 20, 32, 0.42), rgba(255, 255, 255, 0.04) 34%, rgba(255, 255, 255, 0.03) 72%, rgba(29, 19, 34, 0.4))',
  liveFilter: 'saturate(1.04) contrast(0.98) brightness(0.92)',
  iconBackground: 'rgba(255, 255, 255, 0.22)',
  iconBorder: 'rgba(255, 255, 255, 0.32)',
  iconColor: '#ffe4f2',
  bottomBarBackground: 'rgba(54, 36, 56, 0.54)',
  bottomBarBorder: 'rgba(255, 255, 255, 0.24)',
  windowBackground: '#252034',
  windowTitleBackground: '#362b48',
  windowShadow: '0 14px 42px rgba(15, 10, 25, 0.5), 0 0 0 1px rgba(249, 168, 212, 0.16)',
  previewFloor: 'linear-gradient(135deg, rgba(249, 168, 212, 0.28), rgba(196, 181, 253, 0.24))',
};

export const ROOM_SHOP_ITEMS: RoomShopItem[] = [
  {
    id: DEFAULT_ROOM_ITEM_ID,
    type: 'deskMood',
    name: 'Aoi Commander Room',
    description: 'The familiar command room with live wallpaper glow.',
    category: 'featured',
    tags: ['default', 'live', 'aoi'],
    wallpaper: DEFAULT_VIDEO_WALLPAPER,
    staticFallback: DEFAULT_STATIC_WALLPAPER,
    liveWallpaper: true,
    swatch: 'linear-gradient(135deg, #25205f 0%, #6043b5 38%, #1ea7a8 72%, #191a24 100%)',
    tokens: defaultTokens,
  },
  {
    id: 'rainy-window-desk',
    type: 'deskMood',
    name: 'Rainy Window Desk',
    description: 'Cool rain, quiet desk light, and calm blue glass.',
    category: 'featured',
    tags: ['rain', 'focus', 'blue'],
    wallpaper:
      'radial-gradient(circle at 24% 22%, rgba(186, 230, 253, 0.4), transparent 22%), linear-gradient(135deg, #07111f 0%, #12344a 42%, #0c1725 100%)',
    liveWallpaper: false,
    swatch: 'linear-gradient(135deg, #08111f 0%, #0f3146 42%, #7dd3fc 62%, #15202f 100%)',
    tokens: rainTokens,
  },
  {
    id: 'lofi-cafe-night',
    type: 'deskMood',
    name: 'Lo-fi Cafe Night',
    description: 'Warm cafe counter, soft lamp haze, late playlist.',
    category: 'moods',
    tags: ['warm', 'music', 'coffee'],
    wallpaper:
      'radial-gradient(circle at 64% 24%, rgba(255, 184, 107, 0.42), transparent 24%), linear-gradient(135deg, #1b0f0a 0%, #4d2413 42%, #16100e 100%)',
    liveWallpaper: false,
    swatch: 'linear-gradient(135deg, #2b150d 0%, #c06c32 45%, #ffcf8a 62%, #1c1110 100%)',
    tokens: cozyTokens,
  },
  {
    id: 'pixel-arcade',
    type: 'deskMood',
    name: 'Pixel Arcade',
    description: 'Arcade carpet colors without turning the room noisy.',
    category: 'moods',
    tags: ['neon', 'game', 'retro'],
    wallpaper:
      'linear-gradient(135deg, rgba(251, 77, 255, 0.24), transparent 28%), radial-gradient(circle at 72% 30%, rgba(45, 212, 191, 0.34), transparent 24%), linear-gradient(135deg, #12051d 0%, #20114a 48%, #050816 100%)',
    liveWallpaper: false,
    swatch: 'linear-gradient(135deg, #16051f 0%, #fb4dff 38%, #2dd4bf 60%, #0b1026 100%)',
    tokens: arcadeTokens,
  },
  {
    id: 'soft-pastel-desk',
    type: 'wallpaper',
    name: 'Soft Pastel Desk',
    description: 'Candy-soft gradients for a gentle desktop reset.',
    category: 'wallpapers',
    tags: ['soft', 'pastel', 'bright'],
    wallpaper:
      'radial-gradient(circle at 30% 22%, rgba(249, 168, 212, 0.5), transparent 25%), radial-gradient(circle at 74% 30%, rgba(125, 211, 252, 0.38), transparent 22%), linear-gradient(135deg, #201b2e 0%, #3b3152 100%)',
    liveWallpaper: false,
    swatch: 'linear-gradient(135deg, #f9a8d4 0%, #bae6fd 45%, #c4b5fd 75%, #3b3152 100%)',
    tokens: pastelTokens,
  },
  {
    id: 'moonlit-library',
    type: 'wallpaper',
    name: 'Moonlit Library',
    description: 'Dusty shelves, moon glow, and a quiet reading mood.',
    category: 'wallpapers',
    tags: ['moon', 'book', 'quiet'],
    wallpaper:
      'radial-gradient(circle at 72% 16%, rgba(226, 232, 240, 0.42), transparent 18%), linear-gradient(135deg, #0f172a 0%, #27324a 42%, #15111f 100%)',
    liveWallpaper: false,
    swatch: 'linear-gradient(135deg, #0f172a 0%, #6b7280 42%, #e2e8f0 58%, #15111f 100%)',
    tokens: rainTokens,
  },
  {
    id: 'neon-pop-room',
    type: 'wallpaper',
    name: 'Neon Pop Room',
    description: 'A compact splash of pink, teal, and midnight.',
    category: 'featured',
    tags: ['neon', 'pop', 'color'],
    wallpaper:
      'radial-gradient(circle at 20% 30%, rgba(251, 113, 133, 0.4), transparent 22%), radial-gradient(circle at 78% 26%, rgba(45, 212, 191, 0.38), transparent 22%), linear-gradient(135deg, #080a1f 0%, #21103b 50%, #050816 100%)',
    liveWallpaper: false,
    swatch: 'linear-gradient(135deg, #fb7185 0%, #22d3ee 44%, #8b5cf6 72%, #050816 100%)',
    tokens: arcadeTokens,
  },
  {
    id: 'minimal-white-studio',
    type: 'wallpaper',
    name: 'Minimal White Studio',
    description: 'Clean studio light with a calmer shell frame.',
    category: 'wallpapers',
    tags: ['minimal', 'studio', 'clean'],
    wallpaper:
      'radial-gradient(circle at 68% 18%, rgba(250, 234, 95, 0.3), transparent 20%), linear-gradient(135deg, #eceff4 0%, #cbd5e1 42%, #64748b 100%)',
    liveWallpaper: false,
    swatch: 'linear-gradient(135deg, #f8fafc 0%, #e2e8f0 42%, #94a3b8 76%, #334155 100%)',
    tokens: {
      ...pastelTokens,
      accent: '#facc15',
      accentSoft: 'rgba(250, 204, 21, 0.24)',
      iconBackground: 'rgba(15, 23, 42, 0.28)',
      iconBorder: 'rgba(255, 255, 255, 0.42)',
      iconColor: '#f8fafc',
      bottomBarBackground: 'rgba(15, 23, 42, 0.52)',
      bottomBarBorder: 'rgba(255, 255, 255, 0.28)',
      windowBackground: '#1e293b',
      windowTitleBackground: '#273449',
    },
  },
];

export const DEFAULT_ROOM_THEME_STATE: RoomThemeState = {
  activeWallpaperId: DEFAULT_ROOM_ITEM_ID,
  activeMoodId: DEFAULT_ROOM_ITEM_ID,
  previewItemId: null,
  liveWallpaper: true,
  updatedAt: 0,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function findRoomShopItem(itemId: string | null | undefined): RoomShopItem | null {
  if (!itemId) return null;
  return ROOM_SHOP_ITEMS.find((item) => item.id === itemId) ?? null;
}

export function normalizeRoomThemeState(value: unknown): RoomThemeState {
  const record = isRecord(value) ? value : {};
  const activeWallpaper = findRoomShopItem(String(record.activeWallpaperId ?? ''));
  const activeMood = findRoomShopItem(String(record.activeMoodId ?? ''));
  const previewItem = findRoomShopItem(
    typeof record.previewItemId === 'string' ? record.previewItemId : null,
  );

  return {
    activeWallpaperId: activeWallpaper?.id ?? DEFAULT_ROOM_THEME_STATE.activeWallpaperId,
    activeMoodId:
      activeMood?.type === 'deskMood' ? activeMood.id : DEFAULT_ROOM_THEME_STATE.activeMoodId,
    previewItemId: previewItem?.id ?? null,
    liveWallpaper:
      typeof record.liveWallpaper === 'boolean'
        ? record.liveWallpaper
        : DEFAULT_ROOM_THEME_STATE.liveWallpaper,
    updatedAt:
      typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt)
        ? record.updatedAt
        : DEFAULT_ROOM_THEME_STATE.updatedAt,
  };
}

export function parseRoomThemeState(raw: unknown): RoomThemeState {
  if (typeof raw === 'string') {
    try {
      return normalizeRoomThemeState(JSON.parse(raw));
    } catch {
      return normalizeRoomThemeState(null);
    }
  }
  return normalizeRoomThemeState(raw);
}

export function loadRoomThemeState(): RoomThemeState {
  if (typeof window === 'undefined') return DEFAULT_ROOM_THEME_STATE;

  try {
    return normalizeRoomThemeState(
      JSON.parse(localStorage.getItem(ROOM_THEME_STORAGE_KEY) ?? '{}'),
    );
  } catch {
    return DEFAULT_ROOM_THEME_STATE;
  }
}

export function buildRoomThemeSnapshot(state: RoomThemeState): RoomThemeSnapshot {
  const normalized = normalizeRoomThemeState(state);
  const previewItem = findRoomShopItem(normalized.previewItemId);
  const defaultItem = findRoomShopItem(DEFAULT_ROOM_ITEM_ID) ?? ROOM_SHOP_ITEMS[0];
  const activeWallpaper = findRoomShopItem(normalized.activeWallpaperId) ?? defaultItem;
  const activeMood = findRoomShopItem(normalized.activeMoodId) ?? defaultItem;
  const wallpaperItem = previewItem ?? activeWallpaper;
  const moodItem = previewItem?.type === 'deskMood' ? previewItem : activeMood;
  const tokenItem = previewItem ?? (wallpaperItem.type === 'wallpaper' ? wallpaperItem : moodItem);
  const keepsAoiRoomBase = wallpaperItem.id !== DEFAULT_ROOM_ITEM_ID;
  const wallpaper = keepsAoiRoomBase ? DEFAULT_VIDEO_WALLPAPER : wallpaperItem.wallpaper;
  const staticFallback = keepsAoiRoomBase
    ? DEFAULT_STATIC_WALLPAPER
    : (wallpaperItem.staticFallback ?? DEFAULT_STATIC_WALLPAPER);
  const liveWallpaper = keepsAoiRoomBase ? true : normalized.liveWallpaper;

  return {
    state: normalized,
    wallpaperItem,
    moodItem,
    previewItem,
    wallpaper,
    staticFallback,
    liveWallpaper,
    tokens: tokenItem.tokens,
  };
}

export function createPreviewRoomThemeState(itemId: string, state: RoomThemeState): RoomThemeState {
  const item = findRoomShopItem(itemId);
  if (!item) return normalizeRoomThemeState(state);

  return normalizeRoomThemeState({
    ...state,
    previewItemId: item.id,
  });
}

export function createAppliedRoomThemeState(itemId: string, state: RoomThemeState): RoomThemeState {
  const item = findRoomShopItem(itemId);
  if (!item) return normalizeRoomThemeState(state);

  const nextState: RoomThemeState = {
    ...normalizeRoomThemeState(state),
    activeWallpaperId: item.id,
    activeMoodId: item.type === 'deskMood' ? item.id : state.activeMoodId,
    previewItemId: null,
    liveWallpaper: true,
    updatedAt: Date.now(),
  };

  return normalizeRoomThemeState(nextState);
}

export function createResetRoomThemeState(): RoomThemeState {
  return {
    ...DEFAULT_ROOM_THEME_STATE,
    updatedAt: Date.now(),
  };
}

export function persistRoomThemeState(state: RoomThemeState): RoomThemeState {
  const normalized = normalizeRoomThemeState({
    ...state,
    previewItemId: null,
  });

  if (typeof window !== 'undefined') {
    localStorage.setItem(ROOM_THEME_STORAGE_KEY, JSON.stringify(normalized));
  }

  return normalized;
}

export function emitRoomThemeChanged(state: RoomThemeState, reason: string): void {
  if (typeof window === 'undefined') return;

  const normalized = normalizeRoomThemeState(state);
  window.dispatchEvent(
    new CustomEvent(ROOM_THEME_EVENT, {
      detail: {
        reason,
        state: normalized,
        snapshot: buildRoomThemeSnapshot(normalized),
      },
    }),
  );
}

export function getRoomThemeCssVars(snapshot: RoomThemeSnapshot): CSSProperties {
  const { tokens } = snapshot;
  const vars = {
    '--room-accent': tokens.accent,
    '--room-accent-soft': tokens.accentSoft,
    '--room-desktop-overlay': tokens.desktopOverlay,
    '--room-desktop-live-overlay': tokens.desktopLiveOverlay,
    '--room-live-filter': tokens.liveFilter,
    '--room-bottom-bar-background': tokens.bottomBarBackground,
    '--room-bottom-bar-border': tokens.bottomBarBorder,
  } as CSSProperties;

  return vars;
}

export function getWallpaperBackgroundImage(wallpaper: string): string {
  const trimmed = wallpaper.trim();
  if (
    trimmed.startsWith('linear-gradient(') ||
    trimmed.startsWith('radial-gradient(') ||
    trimmed.startsWith('conic-gradient(')
  ) {
    return trimmed;
  }

  return `url("${trimmed.replace(/"/g, '\\"')}")`;
}

export function isVideoWallpaper(wallpaper: string): boolean {
  try {
    const pathname = new URL(wallpaper).pathname.toLowerCase();
    return /\.(mp4|webm|mov|ogg)$/.test(pathname);
  } catch {
    return false;
  }
}
