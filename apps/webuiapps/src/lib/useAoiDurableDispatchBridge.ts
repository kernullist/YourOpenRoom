import { useEffect } from 'react';

// P2.2: a durable, reconnecting client dispatch bridge (the roadmap's accepted alternative to a
// headless worker -- an iframe app cannot receive a dispatch while its client is closed, so the
// truly-headless path is structurally impossible; a durable client bridge is what is achievable).
//
// While the panel is mounted, this drains any pending app-operation dispatches the daemon queued
// on a fixed interval, so a dispatch does not wait for a manual refresh. Each tick is best-effort
// (the injected drain swallows its own failures), so a transient error simply retries on the next
// tick -- that is the "reconnecting" property. OFF-by-default upstream: the autonomy loop queues
// nothing unless live dispatch is enabled, so an idle tick is a cheap empty poll.
//
// Extracted as a tiny hook so the durability (fires repeatedly) and cleanup (no leak on unmount)
// are unit-testable with fake timers, without mounting the 11k-line ChatPanel.
export function useAoiDurableDispatchBridge(params: {
  // Drain the pending dispatches now. MUST be stable (wrap in useCallback) or memoized upstream,
  // otherwise the interval resets every render.
  drain: () => void;
  intervalMs: number;
  // Default true; pass false to disable the poll entirely (e.g. no session yet).
  enabled?: boolean;
}): void {
  const { drain, intervalMs, enabled = true } = params;
  useEffect(() => {
    if (!enabled || !(intervalMs > 0)) {
      return undefined;
    }
    const intervalId = setInterval(() => {
      drain();
    }, intervalMs);
    return () => {
      clearInterval(intervalId);
    };
  }, [drain, intervalMs, enabled]);
}

// Default cadence: prompt enough that a queued dispatch drains within a reasonable window, but not
// so chatty that an idle panel spams the pending-dispatch route.
export const AOI_DURABLE_DISPATCH_BRIDGE_INTERVAL_MS = 30_000;
