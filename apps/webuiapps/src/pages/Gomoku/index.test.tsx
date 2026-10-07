import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const writeFileMock = vi.fn(async () => {});
let agentHandler: ((action: unknown) => Promise<string>) | null = null;

vi.mock('@/lib', () => ({
  useAgentActionListener: (_appId: number, handler: (action: unknown) => Promise<string>) => {
    agentHandler = handler;
  },
  reportAction: vi.fn(),
  reportLifecycle: vi.fn(),
  fetchVibeInfo: vi.fn(async () => ({})),
  useVibeInfo: () => ({ characterInfo: { name: 'Aoi' } }),
  createAppFileApi: () => ({
    listFiles: vi.fn(async () => []),
    readFile: vi.fn(async () => ({ content: '' })),
    writeFile: (...args: unknown[]) => writeFileMock(...(args as [])),
    deleteFile: vi.fn(async () => {}),
  }),
  generateId: () => 'game-1',
  batchConcurrent: vi.fn(async () => []),
}));

import Gomoku from './index';

afterEach(() => {
  cleanup();
  writeFileMock.mockClear();
  agentHandler = null;
});

async function dispatch(params: Record<string, string>): Promise<string> {
  let result = '';
  await act(async () => {
    result = await agentHandler!({ action_type: 'SURRENDER', params });
  });
  return result;
}

function savedRecord(): { result: { winner: string; reason: string } } | undefined {
  const call = writeFileMock.mock.calls.find((args) =>
    String((args as unknown[])[0]).startsWith('/history/'),
  ) as unknown[] | undefined;
  return call?.[1] as { result: { winner: string; reason: string } } | undefined;
}

describe('Gomoku surrender', () => {
  it("records the agent's own resignation as the human's win", async () => {
    render(<Gomoku />);
    // The human takes white, so the agent plays black.
    fireEvent.click(await screen.findByText('White'));
    await screen.findByText('Surrender');

    expect(await dispatch({ color: 'black' })).toBe('success');

    // Taking agentColor as the winner recorded this as a black win.
    expect(savedRecord()?.result).toEqual(
      expect.objectContaining({ winner: 'white', reason: 'surrender' }),
    );
    expect(await screen.findByText('White wins')).toBeTruthy();
    // The game is over; a second resignation has nothing to end.
    expect(await dispatch({ color: 'black' })).toBe('error: no game in progress');
  });

  it('refuses a SURRENDER that does not name a side', async () => {
    render(<Gomoku />);
    fireEvent.click(await screen.findByText('Black'));
    await screen.findByText('Surrender');

    expect(await dispatch({})).toBe('error: color must be "black" or "white"');
    expect(await dispatch({ color: 'red' })).toBe('error: color must be "black" or "white"');
    expect(savedRecord()).toBeUndefined();
  });
});
