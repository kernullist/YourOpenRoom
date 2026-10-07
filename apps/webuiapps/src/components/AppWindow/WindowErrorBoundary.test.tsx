import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WindowErrorBoundary } from './index';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

let shouldThrow = true;
function Flaky(): React.ReactElement {
  if (shouldThrow) {
    throw new Error('unknown category "financial"');
  }
  return <p>recovered</p>;
}

describe('WindowErrorBoundary', () => {
  it('keeps one app crash inside its window', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    shouldThrow = true;
    render(
      <div>
        <p>shell still here</p>
        <WindowErrorBoundary>
          <Flaky />
        </WindowErrorBoundary>
      </div>,
    );
    expect(screen.getByText('shell still here')).toBeTruthy();
    expect(screen.getByTestId('app-window-error').textContent).toContain('unknown category');

    shouldThrow = false;
    fireEvent.click(screen.getByText('Reload app'));
    expect(screen.getByText('recovered')).toBeTruthy();
  });
});
