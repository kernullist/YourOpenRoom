import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  describeAppActionResultForModel,
  executeListApps,
  getAppControlInventory,
  getAppIdentityByReference,
  getAppIdentityById,
  getOsActionTargetApp,
  loadActionsFromMeta,
  resetActionsCache,
  resolveAppAction,
} from '../appRegistry';

afterEach(() => {
  resetActionsCache();
  vi.unstubAllGlobals();
});

describe('appRegistry app identity helpers', () => {
  it('lists newly added in-apps with app names and speaking guidance', () => {
    const result = executeListApps();

    expect(result).toContain('Use displayName or appName when speaking to the user');
    expect(result).toContain('Dewdrop Canvas (appName: dewdropcanvas, appId: 22');
    expect(result).toContain('Written By Me (appName: writtenbyme, appId: 23');
    expect(result).toContain('Aoi Research (appName: aoiresearch, appId: 24');
    expect(result).toContain('Aoi Memory (appName: aoimemory, appId: 25');
    expect(result).toContain('Capability inventory:');
    expect(result).toContain('Aoi Research controls:');
    expect(result).toContain('schemas=');
  });

  it('builds a capability inventory for every registered app', () => {
    const inventory = getAppControlInventory();
    const visibleInventory = inventory.filter((entry) => entry.app_name !== 'os');

    expect(visibleInventory.length).toBeGreaterThan(0);
    expect(visibleInventory.every((entry) => entry.windows.can_open)).toBe(true);
    expect(visibleInventory.every((entry) => entry.state.can_read_state_file)).toBe(true);
    expect(visibleInventory.every((entry) => entry.actions.names.includes('OPEN_APP_WINDOW'))).toBe(
      true,
    );
    expect(visibleInventory.every((entry) => entry.control_status === 'tool-backed')).toBe(true);
    expect(visibleInventory.map((entry) => entry.app_name)).toContain('kira');
    expect(visibleInventory.map((entry) => entry.app_name)).toContain('aoiresearch');
  });

  it('resolves OS app_id params back to the target app identity', () => {
    const target = getOsActionTargetApp('OPEN_APP', { app_id: '22' });

    expect(target?.displayName).toBe('Dewdrop Canvas');
    expect(target?.appName).toBe('dewdropcanvas');

    expect(getOsActionTargetApp('FOCUS_APP', { app_id: '25' })?.displayName).toBe('Aoi Memory');
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
    const app = getAppIdentityById(25);

    expect(app?.displayName).toBe('Aoi Memory');
    expect(app?.aliases).toContain('memory dashboard');
  });

  it('resolves app references by appName, displayName, alias, or appId', () => {
    expect(getAppIdentityByReference('Aoi Research')?.appName).toBe('aoiresearch');
    expect(getAppIdentityByReference('키라')?.appName).toBe('kira');
    expect(getAppIdentityByReference('22')?.appName).toBe('dewdropcanvas');
    expect(resolveAppAction('Aoi Research', 'REFRESH_AOI_RESEARCH_RUNS')).toEqual({
      appId: 24,
      actionType: 'REFRESH_AOI_RESEARCH_RUNS',
    });
    expect(resolveAppAction('Aoi Research', 'OPEN_APP_WINDOW')).toEqual({
      appId: 1,
      actionType: 'OPEN_APP',
      params: { app_id: '24' },
    });
  });

  it('rejects unsupported app actions after metadata has loaded', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
      })),
    );

    await loadActionsFromMeta();

    const unknown = resolveAppAction('Aoi Research', 'NOT_A_REAL_ACTION');
    expect(typeof unknown).toBe('string');

    const parsed = JSON.parse(unknown as string) as {
      ok: boolean;
      error: string;
      app: { app_name: string };
      requested_action: string;
      supported_actions: string[];
    };

    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe('unsupported_app_action');
    expect(parsed.app.app_name).toBe('aoiresearch');
    expect(parsed.requested_action).toBe('NOT_A_REAL_ACTION');
    expect(parsed.supported_actions).toContain('OPEN_APP_WINDOW');
  });
});
