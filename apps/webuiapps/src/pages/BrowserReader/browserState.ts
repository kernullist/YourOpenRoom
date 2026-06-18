export type ViewMode = 'browse' | 'reader';

export interface BrowserState {
  currentUrl: string;
  inputUrl: string;
  viewMode: ViewMode;
  sidebarOpen: boolean;
}

export interface BrowserInitialNavigation {
  currentUrl: string;
  inputUrl: string;
}

export const DEFAULT_BROWSER_STATE: BrowserState = {
  currentUrl: 'https://www.notion.com/notes',
  inputUrl: 'https://www.notion.com/notes',
  viewMode: 'browse',
  sidebarOpen: false,
};

export function normalizeBrowserState(
  state: Partial<BrowserState> | null | undefined,
): BrowserState {
  const currentUrl =
    typeof state?.currentUrl === 'string' && state.currentUrl.trim()
      ? state.currentUrl
      : DEFAULT_BROWSER_STATE.currentUrl;
  const inputUrl =
    typeof state?.inputUrl === 'string' && state.inputUrl.trim()
      ? state.inputUrl
      : currentUrl || DEFAULT_BROWSER_STATE.inputUrl;

  return {
    currentUrl,
    inputUrl,
    viewMode: state?.viewMode === 'reader' ? 'reader' : DEFAULT_BROWSER_STATE.viewMode,
    sidebarOpen: Boolean(state?.sidebarOpen),
  };
}

export function resolveBrowserStateAfterCloudRefresh(params: {
  cloudState?: Partial<BrowserState> | null;
  pendingInitialNavigation?: BrowserInitialNavigation | null;
}): BrowserState {
  const cloudState = normalizeBrowserState(params.cloudState);
  const pending = params.pendingInitialNavigation;

  if (!pending) {
    return cloudState;
  }

  return {
    ...cloudState,
    currentUrl: pending.currentUrl || cloudState.currentUrl,
    inputUrl: pending.inputUrl || pending.currentUrl || cloudState.inputUrl,
  };
}
