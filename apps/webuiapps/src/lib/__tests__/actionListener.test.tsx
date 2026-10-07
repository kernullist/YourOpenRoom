import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../diskStorage', () => ({
  listFiles: vi.fn(async () => []),
  getFile: vi.fn(async () => null),
  putTextFilesByJSON: vi.fn(async () => undefined),
  deleteFilesByPaths: vi.fn(async () => undefined),
  searchFiles: vi.fn(async () => []),
}));

import { useAgentActionListener } from '../action';
import { dispatchAgentAction } from '../vibeContainerMock';
import { closeWindow, getWindows } from '../windowManager';

const DIARY_APP_ID = 4;

afterEach(() => {
  cleanup();
  for (const win of getWindows()) closeWindow(win.appId);
  vi.restoreAllMocks();
});

describe('useAgentActionListener', () => {
  it('answers a synchronously throwing handler with error:, not a timeout', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    renderHook(() =>
      useAgentActionListener(DIARY_APP_ID, () => {
        throw new Error('bad param');
      }),
    );
    await dispatchAgentAction({
      app_id: 1,
      action_type: 'OPEN_APP',
      params: { app_id: String(DIARY_APP_ID) },
    });

    const started = Date.now();
    const result = await dispatchAgentAction({
      app_id: DIARY_APP_ID,
      action_type: 'SELECT_DATE',
      params: {},
    });
    expect(result).toBe('error: bad param');
    // Answered right away rather than after the 10-20 s dispatch timeout.
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('still answers a synchronous result', async () => {
    renderHook(() => useAgentActionListener(DIARY_APP_ID, () => 'success'));
    await dispatchAgentAction({
      app_id: 1,
      action_type: 'OPEN_APP',
      params: { app_id: String(DIARY_APP_ID) },
    });
    expect(
      await dispatchAgentAction({ app_id: DIARY_APP_ID, action_type: 'SELECT_DATE', params: {} }),
    ).toBe('success');
  });
});
