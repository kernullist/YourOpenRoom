import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MISSION_CONTROL_STATE,
  isMissionControlViewId,
  mergeMissionControlState,
  MISSION_CONTROL_REFRESH_INTERVALS,
  STRIP_PANELS,
  VIEW_PANELS,
  type MissionControlState,
} from '../types';

// mergeMissionControlState backs SYNC_STATE, which applies a payload Aoi wrote.
// A partial or hostile write must not be able to silently reset the operator's
// session selection or view -- the defensive, field-by-field merge is the guard.

const CURRENT: MissionControlState = {
  version: 1,
  activeView: 'queue',
  sessionPath: 'aoi/space_adventure',
  autoRefresh: false,
  refreshIntervalMs: 30000,
  timelineKindFilter: 'proposal_failed',
  selectedProposalId: 'p-42',
};

describe('isMissionControlViewId', () => {
  it('accepts every known view', () => {
    for (const view of ['runtime', 'queue', 'timeline', 'flight', 'metrics']) {
      expect(isMissionControlViewId(view)).toBe(true);
    }
  });

  it('rejects anything else', () => {
    expect(isMissionControlViewId('settings')).toBe(false);
    expect(isMissionControlViewId(3)).toBe(false);
    expect(isMissionControlViewId(null)).toBe(false);
    expect(isMissionControlViewId(undefined)).toBe(false);
  });
});

describe('mergeMissionControlState', () => {
  it('leaves untouched fields alone when the payload is partial', () => {
    const next = mergeMissionControlState(CURRENT, { activeView: 'timeline' });

    expect(next.activeView).toBe('timeline');
    // Everything else must survive: a state.json that only carries the view has
    // not asked for the session selection to be reset.
    expect(next.sessionPath).toBe('aoi/space_adventure');
    expect(next.autoRefresh).toBe(false);
    expect(next.refreshIntervalMs).toBe(30000);
    expect(next.timelineKindFilter).toBe('proposal_failed');
    expect(next.selectedProposalId).toBe('p-42');
  });

  it('returns the current state unchanged for non-object payloads', () => {
    expect(mergeMissionControlState(CURRENT, null)).toEqual(CURRENT);
    expect(mergeMissionControlState(CURRENT, 'nope')).toEqual(CURRENT);
    expect(mergeMissionControlState(CURRENT, [1, 2, 3])).toEqual(CURRENT);
    expect(mergeMissionControlState(CURRENT, undefined)).toEqual(CURRENT);
  });

  it('ignores an unknown view instead of falling back to a default', () => {
    const next = mergeMissionControlState(CURRENT, { activeView: 'hacked' });

    expect(next.activeView).toBe('queue');
  });

  it('ignores a refresh interval outside the allowed set', () => {
    expect(mergeMissionControlState(CURRENT, { refreshIntervalMs: 1 }).refreshIntervalMs).toBe(
      30000,
    );
    expect(mergeMissionControlState(CURRENT, { refreshIntervalMs: 5000 }).refreshIntervalMs).toBe(
      5000,
    );
  });

  it('accepts an explicit null to clear nullable fields', () => {
    const next = mergeMissionControlState(CURRENT, {
      sessionPath: null,
      timelineKindFilter: null,
      selectedProposalId: null,
    });

    expect(next.sessionPath).toBeNull();
    expect(next.timelineKindFilter).toBeNull();
    expect(next.selectedProposalId).toBeNull();
  });

  it('treats a blank string as no instruction rather than as a clear', () => {
    const next = mergeMissionControlState(CURRENT, {
      sessionPath: '   ',
      selectedProposalId: '',
    });

    expect(next.sessionPath).toBe('aoi/space_adventure');
    expect(next.selectedProposalId).toBe('p-42');
  });

  it('trims surrounding whitespace on accepted strings', () => {
    const next = mergeMissionControlState(CURRENT, { sessionPath: '  aoi/other  ' });

    expect(next.sessionPath).toBe('aoi/other');
  });

  it('ignores wrongly typed values', () => {
    const next = mergeMissionControlState(CURRENT, {
      autoRefresh: 'yes',
      sessionPath: 42,
      refreshIntervalMs: '5000',
    });

    expect(next.autoRefresh).toBe(false);
    expect(next.sessionPath).toBe('aoi/space_adventure');
    expect(next.refreshIntervalMs).toBe(30000);
  });

  it('does not mutate the input state', () => {
    const snapshot = { ...CURRENT };

    mergeMissionControlState(CURRENT, { activeView: 'flight', autoRefresh: true });

    expect(CURRENT).toEqual(snapshot);
  });
});

describe('panel routing tables', () => {
  it('defines panels for every view', () => {
    for (const view of ['runtime', 'queue', 'timeline', 'flight', 'metrics'] as const) {
      expect(VIEW_PANELS[view].length).toBeGreaterThan(0);
    }
  });

  it('always refreshes the strip panels regardless of view', () => {
    // The strip is the one thing this app promises to keep honest at all times,
    // so it must never be reachable only through a specific view.
    expect(STRIP_PANELS).toContain('runtime');
    expect(STRIP_PANELS).toContain('status');
    for (const panels of Object.values(VIEW_PANELS)) {
      for (const strip of STRIP_PANELS) {
        expect(panels).not.toContain(strip);
      }
    }
  });
});

describe('defaults', () => {
  it('starts on the runtime view with no pinned session', () => {
    expect(DEFAULT_MISSION_CONTROL_STATE.activeView).toBe('runtime');
    // null means "follow the newest session", which is the only safe default on
    // a fresh install where no session path exists to pin.
    expect(DEFAULT_MISSION_CONTROL_STATE.sessionPath).toBeNull();
  });

  it('uses an allowed refresh interval', () => {
    expect(MISSION_CONTROL_REFRESH_INTERVALS).toContain(
      DEFAULT_MISSION_CONTROL_STATE.refreshIntervalMs,
    );
  });
});
