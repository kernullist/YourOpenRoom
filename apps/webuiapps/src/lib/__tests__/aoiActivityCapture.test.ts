import { describe, expect, it } from 'vitest';
import {
  isAoiActivityCaptureConsented,
  mapAoiUserActionToActivityCapture,
} from '../aoiActivityCapture';

const resolveAppName = (appId: number): string | null => {
  if (appId === 3) {
    return 'youtube';
  }
  if (appId === 7) {
    return 'kira';
  }
  return null;
};

describe('isAoiActivityCaptureConsented', () => {
  it('reads missing registries and disabled sources as not consented', () => {
    expect(isAoiActivityCaptureConsented(null)).toBe(false);
    expect(isAoiActivityCaptureConsented(undefined)).toBe(false);
    expect(isAoiActivityCaptureConsented({ sources: [] })).toBe(false);
    expect(
      isAoiActivityCaptureConsented({ sources: [{ id: 'app-activity', enabled: false }] }),
    ).toBe(false);
    expect(isAoiActivityCaptureConsented({ sources: [{ id: 'app-state', enabled: true }] })).toBe(
      false,
    );
  });

  it('is true only for an explicitly enabled app-activity source', () => {
    expect(
      isAoiActivityCaptureConsented({ sources: [{ id: 'app-activity', enabled: true }] }),
    ).toBe(true);
  });
});

describe('mapAoiUserActionToActivityCapture', () => {
  it('maps OS OPEN_APP / CLOSE_APP to lifecycle events for the target app', () => {
    expect(
      mapAoiUserActionToActivityCapture(
        { app_id: 1, action_type: 'OPEN_APP', params: { app_id: '3' }, trigger_by: 1 },
        resolveAppName,
      ),
    ).toEqual({ kind: 'app_opened', appId: 'youtube' });
    expect(
      mapAoiUserActionToActivityCapture(
        { app_id: 1, action_type: 'CLOSE_APP', params: { app_id: '7' }, trigger_by: 1 },
        resolveAppName,
      ),
    ).toEqual({ kind: 'app_closed', appId: 'kira' });
  });

  it('maps app-reported actions to app_action with the action type only', () => {
    expect(
      mapAoiUserActionToActivityCapture(
        {
          app_id: 3,
          action_type: 'PLAY_TRACK',
          params: { trackId: 'secret-track-id', note: 'private note text' },
          trigger_by: 1,
        },
        resolveAppName,
      ),
    ).toEqual({ kind: 'app_action', appId: 'youtube', actionType: 'PLAY_TRACK' });
  });

  it('never captures agent-triggered actions (no self-observation)', () => {
    expect(
      mapAoiUserActionToActivityCapture(
        { app_id: 3, action_type: 'PLAY_TRACK', trigger_by: 2 },
        resolveAppName,
      ),
    ).toBeNull();
  });

  it('ignores unknown OS actions, unresolvable apps, and malformed events', () => {
    expect(
      mapAoiUserActionToActivityCapture(
        { app_id: 1, action_type: 'REBOOT', params: { app_id: '3' } },
        resolveAppName,
      ),
    ).toBeNull();
    expect(
      mapAoiUserActionToActivityCapture(
        { app_id: 1, action_type: 'OPEN_APP', params: { app_id: 'not-a-number' } },
        resolveAppName,
      ),
    ).toBeNull();
    expect(
      mapAoiUserActionToActivityCapture(
        { app_id: 1, action_type: 'OPEN_APP', params: { app_id: '1' } },
        resolveAppName,
      ),
    ).toBeNull();
    expect(
      mapAoiUserActionToActivityCapture(
        { app_id: 1, action_type: 'OPEN_APP', params: { app_id: '99' } },
        resolveAppName,
      ),
    ).toBeNull();
    expect(
      mapAoiUserActionToActivityCapture({ app_id: 99, action_type: 'ANY_ACTION' }, resolveAppName),
    ).toBeNull();
    expect(mapAoiUserActionToActivityCapture(null, resolveAppName)).toBeNull();
    expect(mapAoiUserActionToActivityCapture({ app_id: 3 }, resolveAppName)).toBeNull();
    expect(
      mapAoiUserActionToActivityCapture({ action_type: 'PLAY_TRACK' }, resolveAppName),
    ).toBeNull();
  });

  it('emits metadata only -- params never appear in the mapped event', () => {
    const mapped = mapAoiUserActionToActivityCapture(
      {
        app_id: 3,
        action_type: 'CREATE_NOTE',
        params: { body: 'extremely private diary content' },
      },
      resolveAppName,
    );
    expect(JSON.stringify(mapped)).not.toContain('private diary');
    expect(Object.keys(mapped ?? {})).toEqual(['kind', 'appId', 'actionType']);
  });
});
