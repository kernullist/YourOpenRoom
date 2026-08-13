import { describe, expect, it } from 'vitest';
import {
  classifyBridgeError,
  DEFAULT_DRIVE_CONSOLE_STATE,
  isDriveConsoleViewId,
  mergeDriveConsoleState,
  type DriveConsoleState,
} from '../types';

// classifyBridgeError decides which of four very different messages the operator
// reads. Getting it wrong sends someone debugging a system that is merely
// switched off, or shrugging at a real failure.

const CURRENT: DriveConsoleState = {
  version: 1,
  activeView: 'run',
  sessionPath: 'aoi/space_adventure',
  targetUrl: 'https://example.com',
  draft: { goal: '기존 목표', steps: [] },
  selectedStepIndex: 2,
};

describe('isDriveConsoleViewId', () => {
  it('accepts the three real views and nothing else', () => {
    expect(isDriveConsoleViewId('plan')).toBe(true);
    expect(isDriveConsoleViewId('run')).toBe(true);
    expect(isDriveConsoleViewId('audit')).toBe(true);
    expect(isDriveConsoleViewId('settings')).toBe(false);
    expect(isDriveConsoleViewId(null)).toBe(false);
  });
});

describe('classifyBridgeError', () => {
  it('reads a 401 as not-configured rather than as a failure', () => {
    // The bridge token file simply has not been created. Calling that an error
    // sends the user debugging a non-problem.
    for (const message of ['unauthorized', 'invalid_token', 'HTTP 401']) {
      expect(classifyBridgeError(new Error(message), 1).kind).toBe('unconfigured');
    }
  });

  it('reads a 403 as a missing approval, which is the system working', () => {
    for (const message of ['HTTP 403', 'not_approved', 'approval required']) {
      expect(classifyBridgeError(new Error(message), 1).kind).toBe('denied');
    }
  });

  it('reports anything else as a real error', () => {
    const state = classifyBridgeError(new Error('ECONNRESET'), 1);

    expect(state.kind).toBe('error');
    if (state.kind === 'error') {
      expect(state.message).toContain('ECONNRESET');
    }
  });

  it('handles a non-Error throw', () => {
    expect(classifyBridgeError('boom', 1).kind).toBe('error');
  });

  it('keeps the timestamp it was given', () => {
    const state = classifyBridgeError(new Error('x'), 4242);

    expect(state.kind === 'error' && state.fetchedAt).toBe(4242);
  });
});

describe('mergeDriveConsoleState', () => {
  it('leaves untouched fields alone on a partial write', () => {
    const next = mergeDriveConsoleState(CURRENT, { activeView: 'plan' });

    expect(next.activeView).toBe('plan');
    // An in-progress plan must survive a partial state write.
    expect(next.draft.goal).toBe('기존 목표');
    expect(next.sessionPath).toBe('aoi/space_adventure');
    expect(next.selectedStepIndex).toBe(2);
  });

  it('returns the current state for non-object payloads', () => {
    expect(mergeDriveConsoleState(CURRENT, null)).toEqual(CURRENT);
    expect(mergeDriveConsoleState(CURRENT, [1])).toEqual(CURRENT);
    expect(mergeDriveConsoleState(CURRENT, 'nope')).toEqual(CURRENT);
  });

  it('ignores an unknown view', () => {
    expect(mergeDriveConsoleState(CURRENT, { activeView: 'hacked' }).activeView).toBe('run');
  });

  it('accepts a draft and keeps the previous half when one side is malformed', () => {
    const next = mergeDriveConsoleState(CURRENT, { draft: { goal: '새 목표' } });

    expect(next.draft.goal).toBe('새 목표');
    expect(next.draft.steps).toEqual(CURRENT.draft.steps);
  });

  it('clears the selected step on an explicit null', () => {
    expect(
      mergeDriveConsoleState(CURRENT, { selectedStepIndex: null }).selectedStepIndex,
    ).toBeNull();
  });

  it('ignores a non-numeric step index', () => {
    expect(mergeDriveConsoleState(CURRENT, { selectedStepIndex: 'first' }).selectedStepIndex).toBe(
      2,
    );
  });

  it('does not mutate the input', () => {
    const snapshot = JSON.parse(JSON.stringify(CURRENT));

    mergeDriveConsoleState(CURRENT, { activeView: 'audit', sessionPath: 'aoi/other' });

    expect(CURRENT).toEqual(snapshot);
  });

  it('starts on the plan view with nothing selected', () => {
    expect(DEFAULT_DRIVE_CONSOLE_STATE.activeView).toBe('plan');
    expect(DEFAULT_DRIVE_CONSOLE_STATE.selectedStepIndex).toBeNull();
  });
});
