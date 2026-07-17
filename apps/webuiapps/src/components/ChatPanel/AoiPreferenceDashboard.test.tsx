import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

// Mock the memory-manager IO surface so set/clear never touch storage; the
// component's own poll-state persistence (localStorage) runs for real in jsdom.
const syncMock = vi.fn<unknown[], Promise<unknown[]>>(async () => []);
const forgetMock = vi.fn<unknown[], Promise<unknown[]>>(async () => []);
vi.mock('@/lib/aoiMemoryManager', () => ({
  syncAoiMemoryFromPreferencePoll: (...args: unknown[]) => syncMock(...args),
  forgetAoiPreferencePollMemory: (...args: unknown[]) => forgetMock(...args),
}));

import { AoiPreferenceDashboard } from './AoiPreferenceDashboard';

const SESSION = 'aoi/default';

function renderDashboard(onMemoriesChanged = vi.fn()) {
  return render(
    <AoiPreferenceDashboard
      sessionPath={SESSION}
      lang="en"
      onMemoriesChanged={onMemoriesChanged}
    />,
  );
}

describe('AoiPreferenceDashboard', () => {
  beforeEach(() => {
    localStorage.clear();
    syncMock.mockClear();
    forgetMock.mockClear();
  });
  afterEach(() => {
    cleanup();
  });

  it('renders the grouped bank with a zero summary and no selection', () => {
    renderDashboard();
    expect(screen.getByTestId('aoi-preference-summary').textContent).toContain('0 of');
    const focus = screen.getByTestId('aoi-preference-q-focus_area');
    expect(within(focus).getByText('Anti-cheat / game security')).toBeTruthy();
    // A category header from the personal group is present too.
    expect(screen.getByTestId('aoi-preference-q-game_taste')).toBeTruthy();
  });

  it('sets an answer: marks it, shows the learned statement, and persists a memory', async () => {
    const onMemoriesChanged = vi.fn();
    renderDashboard(onMemoriesChanged);
    const focus = screen.getByTestId('aoi-preference-q-focus_area');
    fireEvent.click(within(focus).getByText('Anti-cheat / game security'));

    await waitFor(() => expect(syncMock).toHaveBeenCalledTimes(1));
    expect(syncMock).toHaveBeenCalledWith(
      SESSION,
      expect.objectContaining({
        questionId: 'focus_area',
        prefKey: 'focus-area',
        optionLabel: 'Anti-cheat / game security',
        candidate: expect.objectContaining({ type: 'preference' }),
      }),
    );
    await waitFor(() => expect(onMemoriesChanged).toHaveBeenCalled());

    // Selection + learned statement reflected in the UI and summary.
    expect(within(focus).getByText('Anti-cheat / game security').getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(within(focus).getByText(/Remembers:/)).toBeTruthy();
    expect(screen.getByTestId('aoi-preference-summary').textContent).toContain('1 of');
    // Poll state persisted to the shared localStorage store.
    expect(localStorage.getItem('aoi-preference-poll-v1')).toContain('anti_cheat');
  });

  it('does not rewrite memory when the already-selected option is clicked again', async () => {
    renderDashboard();
    const focus = screen.getByTestId('aoi-preference-q-focus_area');
    fireEvent.click(within(focus).getByText('Reverse engineering'));
    await waitFor(() => expect(syncMock).toHaveBeenCalledTimes(1));
    fireEvent.click(within(focus).getByText('Reverse engineering'));
    // Idempotent re-click: no second write.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(syncMock).toHaveBeenCalledTimes(1);
  });

  it('clears an answer: drops the selection and forgets the memory', async () => {
    renderDashboard();
    const focus = screen.getByTestId('aoi-preference-q-focus_area');
    fireEvent.click(within(focus).getByText('TPM / hardware verification'));
    await waitFor(() => expect(syncMock).toHaveBeenCalledTimes(1));

    fireEvent.click(within(focus).getByText('Clear'));
    await waitFor(() => expect(forgetMock).toHaveBeenCalledWith(SESSION, 'focus-area'));

    expect(
      within(focus).getByText('TPM / hardware verification').getAttribute('aria-pressed'),
    ).toBe('false');
    expect(screen.getByTestId('aoi-preference-summary').textContent).toContain('0 of');
  });

  it('runs a generate round and re-enables the control when Generate is clicked', async () => {
    const onGenerate = vi.fn(async () => {});
    render(<AoiPreferenceDashboard sessionPath={SESSION} lang="en" onGenerate={onGenerate} />);

    fireEvent.click(screen.getByTestId('aoi-preference-generate'));

    await waitFor(() => expect(onGenerate).toHaveBeenCalledTimes(1));
    // The control re-enables after the round resolves (generating flag reset).
    await waitFor(() =>
      expect((screen.getByTestId('aoi-preference-generate') as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
  });

  it('recovers and re-enables Generate when a generate round throws', async () => {
    const onGenerate = vi.fn(async () => {
      throw new Error('bank expansion failed');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<AoiPreferenceDashboard sessionPath={SESSION} lang="en" onGenerate={onGenerate} />);

    fireEvent.click(screen.getByTestId('aoi-preference-generate'));

    await waitFor(() => expect(onGenerate).toHaveBeenCalled());
    await waitFor(() =>
      expect((screen.getByTestId('aoi-preference-generate') as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    warn.mockRestore();
  });

  it('reloads the shared stores from Refresh without losing the current selection', async () => {
    renderDashboard();
    const focus = screen.getByTestId('aoi-preference-q-focus_area');
    fireEvent.click(within(focus).getByText('Anti-cheat / game security'));
    await waitFor(() => expect(syncMock).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));

    // Reload re-reads localStorage, so the persisted pick stays selected.
    expect(within(focus).getByText('Anti-cheat / game security').getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('keeps the local selection when persisting the set fails', async () => {
    syncMock.mockRejectedValueOnce(new Error('io down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    renderDashboard();
    const focus = screen.getByTestId('aoi-preference-q-focus_area');

    fireEvent.click(within(focus).getByText('Anti-cheat / game security'));

    await waitFor(() => expect(syncMock).toHaveBeenCalled());
    // The pick still applies in the UI despite the write failure.
    expect(within(focus).getByText('Anti-cheat / game security').getAttribute('aria-pressed')).toBe(
      'true',
    );
    warn.mockRestore();
  });

  it('still clears the selection locally when forgetting the memory fails', async () => {
    renderDashboard();
    const focus = screen.getByTestId('aoi-preference-q-focus_area');
    fireEvent.click(within(focus).getByText('TPM / hardware verification'));
    await waitFor(() => expect(syncMock).toHaveBeenCalled());

    forgetMock.mockRejectedValueOnce(new Error('io down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fireEvent.click(within(focus).getByText('Clear'));

    await waitFor(() => expect(forgetMock).toHaveBeenCalled());
    expect(
      within(focus).getByText('TPM / hardware verification').getAttribute('aria-pressed'),
    ).toBe('false');
    warn.mockRestore();
  });

  it('does not clobber answers and the ask cooldown written by the chat loop after mount', async () => {
    renderDashboard();

    // Simulate the chat loop writing to the shared store while the panel is
    // open: an answered chat poll plus a fresh ask-cooldown stamp. The panel's
    // render state still holds the empty snapshot from mount.
    localStorage.setItem(
      'aoi-preference-poll-v1',
      JSON.stringify({ version: 1, answers: { downtime: 'gaming' }, lastAskedAt: 777 }),
    );

    const focus = screen.getByTestId('aoi-preference-q-focus_area');
    fireEvent.click(within(focus).getByText('Anti-cheat / game security'));
    await waitFor(() => expect(syncMock).toHaveBeenCalledTimes(1));

    // The saved state keeps the chat-recorded answer and cooldown stamp.
    const saved = JSON.parse(localStorage.getItem('aoi-preference-poll-v1') ?? '{}') as {
      answers: Record<string, string>;
      lastAskedAt: number;
    };
    expect(saved.answers).toEqual({ downtime: 'gaming', focus_area: 'anti_cheat' });
    expect(saved.lastAskedAt).toBe(777);
  });

  it('clearing one answer preserves concurrent chat-loop writes to other questions', async () => {
    renderDashboard();
    const focus = screen.getByTestId('aoi-preference-q-focus_area');
    fireEvent.click(within(focus).getByText('TPM / hardware verification'));
    await waitFor(() => expect(syncMock).toHaveBeenCalledTimes(1));

    // Chat loop answers another question and stamps the cooldown afterwards.
    const stored = JSON.parse(localStorage.getItem('aoi-preference-poll-v1') ?? '{}') as {
      answers: Record<string, string>;
    };
    localStorage.setItem(
      'aoi-preference-poll-v1',
      JSON.stringify({
        version: 1,
        answers: { ...stored.answers, downtime: 'reading' },
        lastAskedAt: 888,
      }),
    );

    fireEvent.click(within(focus).getByText('Clear'));
    await waitFor(() => expect(forgetMock).toHaveBeenCalled());

    const saved = JSON.parse(localStorage.getItem('aoi-preference-poll-v1') ?? '{}') as {
      answers: Record<string, string>;
      lastAskedAt: number;
    };
    expect(saved.answers).toEqual({ downtime: 'reading' });
    expect(saved.lastAskedAt).toBe(888);
  });
});
