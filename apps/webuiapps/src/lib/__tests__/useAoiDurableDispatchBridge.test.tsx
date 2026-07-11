// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

import { useAoiDurableDispatchBridge } from '../useAoiDurableDispatchBridge';

describe('useAoiDurableDispatchBridge (P2.2 durable client bridge)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('drains repeatedly on the interval (durable), with no immediate call', () => {
    vi.useFakeTimers();
    const drain = vi.fn();
    renderHook(() => useAoiDurableDispatchBridge({ drain, intervalMs: 1000 }));
    expect(drain).not.toHaveBeenCalled();
    vi.advanceTimersByTime(3000);
    expect(drain).toHaveBeenCalledTimes(3);
  });

  it('clears the interval on unmount (no leak)', () => {
    vi.useFakeTimers();
    const drain = vi.fn();
    const { unmount } = renderHook(() => useAoiDurableDispatchBridge({ drain, intervalMs: 1000 }));
    vi.advanceTimersByTime(1000);
    expect(drain).toHaveBeenCalledTimes(1);
    unmount();
    vi.advanceTimersByTime(5000);
    expect(drain).toHaveBeenCalledTimes(1);
  });

  it('does not poll when disabled', () => {
    vi.useFakeTimers();
    const drain = vi.fn();
    renderHook(() => useAoiDurableDispatchBridge({ drain, intervalMs: 1000, enabled: false }));
    vi.advanceTimersByTime(5000);
    expect(drain).not.toHaveBeenCalled();
  });

  it('does not poll with a non-positive interval', () => {
    vi.useFakeTimers();
    const drain = vi.fn();
    renderHook(() => useAoiDurableDispatchBridge({ drain, intervalMs: 0 }));
    vi.advanceTimersByTime(5000);
    expect(drain).not.toHaveBeenCalled();
  });
});
