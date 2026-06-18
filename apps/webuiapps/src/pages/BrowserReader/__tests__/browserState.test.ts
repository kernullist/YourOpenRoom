import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BROWSER_STATE,
  normalizeBrowserState,
  resolveBrowserStateAfterCloudRefresh,
} from '../browserState';

describe('Browser Reader state resolution', () => {
  it('keeps an agent-opened URL over the default startup page during initial refresh', () => {
    const state = resolveBrowserStateAfterCloudRefresh({
      cloudState: null,
      pendingInitialNavigation: {
        currentUrl: 'https://openrouter.ai/api/v1/models',
        inputUrl: 'https://openrouter.ai/api/v1/models',
      },
    });

    expect(state.currentUrl).toBe('https://openrouter.ai/api/v1/models');
    expect(state.inputUrl).toBe('https://openrouter.ai/api/v1/models');
    expect(state.currentUrl).not.toBe(DEFAULT_BROWSER_STATE.currentUrl);
  });

  it('keeps saved Browser state when no startup navigation is pending', () => {
    const state = resolveBrowserStateAfterCloudRefresh({
      cloudState: {
        currentUrl: 'https://example.com/article',
        inputUrl: 'https://example.com/article',
        viewMode: 'reader',
        sidebarOpen: true,
      },
      pendingInitialNavigation: null,
    });

    expect(state).toEqual({
      currentUrl: 'https://example.com/article',
      inputUrl: 'https://example.com/article',
      viewMode: 'reader',
      sidebarOpen: true,
    });
  });

  it('normalizes partial stored state without producing empty URLs', () => {
    const state = normalizeBrowserState({
      currentUrl: '',
      inputUrl: '',
      viewMode: 'browse',
    });

    expect(state.currentUrl).toBe(DEFAULT_BROWSER_STATE.currentUrl);
    expect(state.inputUrl).toBe(DEFAULT_BROWSER_STATE.currentUrl);
  });
});
