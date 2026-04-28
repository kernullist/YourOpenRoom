/**
 * Simple window manager
 * Manages App window states on the desktop
 */

import { getAppDisplayName, getAppDefaultSize } from './appRegistry';

export interface WindowState {
  appId: number;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
  minimized: boolean;
  maximized?: boolean;
  restoreBounds?: WindowBounds;
}

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

type Listener = () => void;
const listeners = new Set<Listener>();

let windows: WindowState[] = [];
let nextZ = 100;
let offsetCounter = 0;

const WINDOW_LAYOUT_KEY = 'openroom_window_layout_v1';
const BASE_X = 80;
const BASE_Y = 40;
const MIN_WINDOW_WIDTH = 300;
const MIN_WINDOW_HEIGHT = 200;

interface SavedWindowLayout {
  offsetX: number;
  offsetY: number;
  width?: number;
  height?: number;
}

function loadWindowLayouts(): Record<number, SavedWindowLayout> {
  try {
    const raw = localStorage.getItem(WINDOW_LAYOUT_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, SavedWindowLayout>;
    return Object.fromEntries(
      Object.entries(parsed).filter(([, value]) => value && typeof value === 'object'),
    ) as Record<number, SavedWindowLayout>;
  } catch {
    return {};
  }
}

function saveWindowLayouts(layouts: Record<number, SavedWindowLayout>): void {
  try {
    localStorage.setItem(WINDOW_LAYOUT_KEY, JSON.stringify(layouts));
  } catch {
    // ignore persistence failures
  }
}

function persistWindowLayout(win: WindowState): void {
  if (win.maximized) return;

  const layouts = loadWindowLayouts();
  layouts[win.appId] = {
    offsetX: win.x - BASE_X,
    offsetY: win.y - BASE_Y,
    width: win.width,
    height: win.height,
  };
  saveWindowLayouts(layouts);
}

function normalizeBounds(bounds: WindowBounds): WindowBounds {
  return {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.max(MIN_WINDOW_WIDTH, Math.round(bounds.width)),
    height: Math.max(MIN_WINDOW_HEIGHT, Math.round(bounds.height)),
  };
}

function applyBounds(win: WindowState, bounds: WindowBounds): void {
  const normalized = normalizeBounds(bounds);
  win.x = normalized.x;
  win.y = normalized.y;
  win.width = normalized.width;
  win.height = normalized.height;
}

export function getMaximizedWindowBounds(): WindowBounds {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return { x: 0, y: 0, width: 1024, height: 768 };
  }

  const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
  let left = 0;
  let right = viewportWidth;

  const chatPanel = document.querySelector('[data-testid="chat-panel"]') as HTMLElement | null;
  if (chatPanel) {
    const rect = chatPanel.getBoundingClientRect();
    const isVisible =
      rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.left < viewportWidth;
    const hasRoomBesideChat = viewportWidth - rect.width >= MIN_WINDOW_WIDTH;

    if (isVisible && hasRoomBesideChat) {
      if (rect.left <= 1) {
        left = Math.min(viewportWidth, Math.max(0, rect.right));
      } else if (rect.right >= viewportWidth - 1) {
        right = Math.max(0, Math.min(viewportWidth, rect.left));
      }
    }
  }

  return normalizeBounds({
    x: left,
    y: 0,
    width: right - left,
    height: viewportHeight,
  });
}

/**
 * Claim the next z-index value from the shared counter.
 * Used by both AppWindow (via focusWindow) and ChatPanel to participate
 * in the same stacking order — click either to bring it to front.
 */
export function claimZIndex(): number {
  return ++nextZ;
}

function notify() {
  listeners.forEach((fn) => fn());
}

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getWindows(): WindowState[] {
  return windows;
}

export function openWindow(appId: number): void {
  const existing = windows.find((w) => w.appId === appId);
  if (existing) {
    // Focus existing window
    existing.zIndex = ++nextZ;
    existing.minimized = false;
    windows = [...windows];
    notify();
    return;
  }

  const size = getAppDefaultSize(appId);
  const saved = loadWindowLayouts()[appId];
  const offset = (offsetCounter++ % 5) * 30;

  const win: WindowState = {
    appId,
    title: getAppDisplayName(appId),
    x: saved ? BASE_X + saved.offsetX : BASE_X + offset,
    y: saved ? BASE_Y + saved.offsetY : BASE_Y + offset,
    width: saved?.width ?? size.width,
    height: saved?.height ?? size.height,
    zIndex: ++nextZ,
    minimized: false,
    maximized: false,
  };

  windows = [...windows, win];
  notify();
}

export function closeWindow(appId: number): void {
  windows = windows.filter((w) => w.appId !== appId);
  notify();
}

export function closeAllWindows(): void {
  windows = [];
  notify();
}

export function focusWindow(appId: number): void {
  const win = windows.find((w) => w.appId === appId);
  if (win) {
    win.zIndex = ++nextZ;
    win.minimized = false;
    windows = [...windows];
    notify();
  }
}

export function minimizeWindow(appId: number): void {
  const win = windows.find((w) => w.appId === appId);
  if (win) {
    win.minimized = true;
    windows = [...windows];
    notify();
  }
}

export function toggleMaximizeWindow(appId: number, bounds: WindowBounds): void {
  const win = windows.find((w) => w.appId === appId);
  if (!win) return;

  win.zIndex = ++nextZ;
  win.minimized = false;

  if (win.maximized) {
    if (win.restoreBounds) {
      applyBounds(win, win.restoreBounds);
    }
    win.maximized = false;
    persistWindowLayout(win);
    win.restoreBounds = undefined;
  } else {
    win.restoreBounds = {
      x: win.x,
      y: win.y,
      width: win.width,
      height: win.height,
    };
    applyBounds(win, bounds);
    win.maximized = true;
  }

  windows = [...windows];
  notify();
}

export function updateMaximizedWindows(bounds: WindowBounds = getMaximizedWindowBounds()): void {
  let changed = false;

  for (const win of windows) {
    if (!win.maximized) continue;
    applyBounds(win, bounds);
    changed = true;
  }

  if (changed) {
    windows = [...windows];
    notify();
  }
}

export function moveWindow(appId: number, x: number, y: number): void {
  const win = windows.find((w) => w.appId === appId);
  if (win) {
    if (win.maximized) return;
    win.x = x;
    win.y = y;
    persistWindowLayout(win);
    windows = [...windows];
    notify();
  }
}

export function resizeWindow(appId: number, width: number, height: number): void {
  const win = windows.find((w) => w.appId === appId);
  if (win) {
    if (win.maximized) return;
    win.width = Math.max(MIN_WINDOW_WIDTH, width);
    win.height = Math.max(MIN_WINDOW_HEIGHT, height);
    persistWindowLayout(win);
    windows = [...windows];
    notify();
  }
}
