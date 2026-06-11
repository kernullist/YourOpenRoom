import { describe, expect, it } from 'vitest';

import {
  describeAppActionResultForModel,
  executeListApps,
  getAppIdentityById,
  getOsActionTargetApp,
} from '../appRegistry';

describe('appRegistry app identity helpers', () => {
  it('lists newly added in-apps with app names and speaking guidance', () => {
    const result = executeListApps();

    expect(result).toContain('Use displayName or appName when speaking to the user');
    expect(result).toContain('Dewdrop Canvas (appName: dewdropcanvas, appId: 22');
    expect(result).toContain('Written By Me (appName: writtenbyme, appId: 23');
    expect(result).toContain('Aoi Research (appName: aoiresearch, appId: 24');
  });

  it('resolves OS app_id params back to the target app identity', () => {
    const target = getOsActionTargetApp('OPEN_APP', { app_id: '22' });

    expect(target?.displayName).toBe('Dewdrop Canvas');
    expect(target?.appName).toBe('dewdropcanvas');
  });

  it('describes app action results with a user-facing app name', () => {
    const result = describeAppActionResultForModel({
      sourceAppId: 1,
      actionType: 'OPEN_APP',
      params: { app_id: '23' },
      rawResult: 'success',
    });
    const parsed = JSON.parse(result) as {
      target_app: { display_name: string };
      user_facing_name: string;
    };

    expect(parsed.target_app.display_name).toBe('Written By Me');
    expect(parsed.user_facing_name).toBe('Written By Me');
  });

  it('keeps direct app identities available without loading meta.yaml', () => {
    const app = getAppIdentityById(20);

    expect(app?.displayName).toBe('PE Analyst');
    expect(app?.aliases).toContain('PE Analyzer');
  });
});
