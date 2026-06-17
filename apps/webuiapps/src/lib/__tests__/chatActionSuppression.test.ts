import { describe, expect, it } from 'vitest';

import { shouldSuppressUserActionConversation } from '../chatActionSuppression';

const osApp = {
  appId: 1,
  appName: 'os',
  displayName: 'OS',
};

const aoiMemoryApp = {
  appId: 25,
  appName: 'aoimemory',
  displayName: 'Aoi Memory',
};

const aoiResearchApp = {
  appId: 24,
  appName: 'aoiresearch',
  displayName: 'Aoi Research',
};

const kiraApp = {
  appId: 18,
  appName: 'kira',
  displayName: 'Kira',
};

describe('shouldSuppressUserActionConversation', () => {
  it('suppresses OS close events for any in-app window', () => {
    expect(
      shouldSuppressUserActionConversation(osApp, {
        action_type: 'CLOSE_APP',
        params: { app_id: '24' },
      }),
    ).toBe(true);
  });

  it('suppresses OS open events for any in-app window', () => {
    expect(
      shouldSuppressUserActionConversation(osApp, {
        action_type: 'OPEN_APP',
        params: { app_id: '24' },
      }),
    ).toBe(true);
  });

  it('keeps Aoi Memory refresh actions quiet', () => {
    expect(
      shouldSuppressUserActionConversation(aoiMemoryApp, {
        action_type: 'REFRESH_AOI_MEMORY_DASHBOARD',
      }),
    ).toBe(true);
  });

  it('suppresses automatic low-signal app refresh actions', () => {
    expect(
      shouldSuppressUserActionConversation(aoiResearchApp, {
        action_type: 'REFRESH_AOI_RESEARCH_RUNS',
      }),
    ).toBe(true);
  });

  it('keeps meaningful Kira refresh actions conversational', () => {
    expect(
      shouldSuppressUserActionConversation(kiraApp, {
        action_type: 'REFRESH_KIRA',
      }),
    ).toBe(false);
  });
});
