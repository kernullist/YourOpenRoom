import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import StatePanel from '../components/StatePanel';
import type { PanelState } from '../types';

// Each kind must be visually and semantically distinct: the whole point of the
// panel is that a failure can never be mistaken for an empty result or for a
// feature that is simply not set up.

function renderState(state: PanelState<string>): void {
  render(
    <StatePanel title="패널" subtitle="부제" state={state}>
      {(data) => <p data-testid="panel-data">{data}</p>}
    </StatePanel>,
  );
}

afterEach(cleanup);

describe('StatePanel', () => {
  it('renders a loading note for idle and loading', () => {
    renderState({ kind: 'loading' });
    expect(screen.getByText('불러오는 중…')).toBeTruthy();
    expect(screen.queryByTestId('panel-data')).toBeNull();
  });

  it('renders empty with its stated reason', () => {
    renderState({ kind: 'empty', reason: '저장된 브리프가 없습니다.', fetchedAt: 1 });
    expect(screen.getByTestId('signal-desk-empty').textContent).toContain(
      '저장된 브리프가 없습니다.',
    );
  });

  it('renders unconfigured as setup, not failure', () => {
    renderState({ kind: 'unconfigured', fetchedAt: 1 });
    const note = screen.getByTestId('signal-desk-unconfigured');
    expect(note.textContent).toContain('고장이 아니라');
    expect(screen.queryByTestId('signal-desk-error')).toBeNull();
  });

  it('renders denied with the guard message', () => {
    renderState({ kind: 'denied', message: '이미 진행 중입니다.', fetchedAt: 1 });
    expect(screen.getByTestId('signal-desk-denied').textContent).toContain('이미 진행 중입니다.');
  });

  it('renders error with the failure message', () => {
    renderState({ kind: 'error', message: 'collector exploded', fetchedAt: 1 });
    expect(screen.getByTestId('signal-desk-error').textContent).toContain('collector exploded');
  });

  it('renders children only when ready', () => {
    renderState({ kind: 'ready', data: '내용', fetchedAt: 1 });
    expect(screen.getByTestId('panel-data').textContent).toBe('내용');
    expect(screen.queryByTestId('signal-desk-error')).toBeNull();
    expect(screen.queryByTestId('signal-desk-empty')).toBeNull();
  });

  it('renders an optional header icon without disturbing title or actions', () => {
    render(
      <StatePanel
        title="패널"
        icon={<svg data-testid="panel-icon" />}
        state={{ kind: 'ready', data: 'x', fetchedAt: 1 }}
        actions={<button type="button" data-testid="panel-action" />}
      >
        {(data) => <p data-testid="panel-data">{data}</p>}
      </StatePanel>,
    );
    expect(screen.getByTestId('panel-icon')).toBeTruthy();
    expect(screen.getByText('패널')).toBeTruthy();
    expect(screen.getByTestId('panel-action')).toBeTruthy();
  });
});
