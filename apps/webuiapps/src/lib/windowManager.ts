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
}

type Listener = () => void;
const listeners = new Set<Listener>();

let windows: WindowState[] = [];
let nextZ = 100;
let offsetCounter = 0;

const WINDOW_LAYOUT_KEY = 'openroom_window_layout_v1';
const BASE_X = 80;
const BASE_Y = 40;

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
  const layouts = loadWindowLayouts();
  layouts[win.appId] = {
    offsetX: win.x - BASE_X,
    offsetY: win.y - BASE_Y,
    width: win.width,
    height: win.height,
  };
  saveWindowLayouts(layouts);
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

export function moveWindow(appId: number, x: number, y: number): void {
  const win = windows.find((w) => w.appId === appId);
  if (win) {
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
    win.width = Math.max(300, width);
    win.height = Math.max(200, height);
    persistWindowLayout(win);
    windows = [...windows];
    notify();
  }
}
