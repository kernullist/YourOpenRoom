import { describe, expect, it } from 'vitest';

import {
  buildAppControlSurfaceContracts,
  findAppControlSurfaceContract,
  formatAppControlSurfaceLine,
  listAppControlSurfaceContracts,
  summarizeAppControlSurfaceContracts,
} from '../appControlSurfaceContracts';
import { APP_REGISTRY, type AppDef } from '../appRegistry';

function commonActions() {
  return [
    { name: 'OPEN_APP_WINDOW', description: 'open', params: [] },
    { name: 'FOCUS_APP_WINDOW', description: 'focus', params: [] },
    { name: 'CLOSE_APP_WINDOW', description: 'close', params: [] },
  ];
}

describe('appControlSurfaceContracts', () => {
  it('creates at least one control surface for every registered non-OS app', () => {
    const apps = APP_REGISTRY.filter((app) => app.appName !== 'os');

    for (const app of apps) {
      const surfaces = buildAppControlSurfaceContracts(app);

      expect(surfaces.length, app.appName).toBeGreaterThan(0);
      expect(
        surfaces.some((surface) => surface.surface === 'state_snapshot'),
        app.appName,
      ).toBe(true);
    }
  });

  it('marks common window and state surfaces as covered for default registered apps', () => {
    const apps = APP_REGISTRY.filter((app) => app.appName !== 'os');

    for (const app of apps) {
      const surfaces = buildAppControlSurfaceContracts(app);
      const windowSurface = surfaces.find((surface) => surface.surface === 'window_controls');
      const stateSurface = surfaces.find((surface) => surface.surface === 'state_snapshot');

      expect(windowSurface?.coverage, app.appName).toBe('covered');
      expect(stateSurface?.coverage, app.appName).toBe('covered');
    }
  });

  it('covers Kira model settings when the app exposes settings actions', () => {
    const app: AppDef = {
      appId: 18,
      appName: 'kira',
      displayName: 'Kira',
      route: '/kira',
      actions: [
        ...commonActions(),
        { name: 'OPEN_MODEL_SETTINGS', description: 'open settings', params: [] },
        { name: 'APPLY_MODEL_SETTINGS', description: 'apply model settings', params: [] },
        { name: 'APPLY_PROJECT_SETTINGS', description: 'apply project settings', params: [] },
      ],
    };

    const surfaces = buildAppControlSurfaceContracts(app);
    const settingsSurface = surfaces.find((surface) => surface.surface === 'model_settings');

    expect(settingsSurface?.coverage).toBe('covered');
    expect(settingsSurface?.backing_action_types).toEqual([
      'OPEN_MODEL_SETTINGS',
      'APPLY_MODEL_SETTINGS',
      'APPLY_PROJECT_SETTINGS',
    ]);
    expect(settingsSurface?.backing_intent_ids).toContain('kira:inspect_state');
    expect(formatAppControlSurfaceLine(settingsSurface!)).toContain('coverage=covered');
  });

  it('uses schema-backed contracts to cover Notes data surfaces', () => {
    const app: AppDef = {
      appId: 16,
      appName: 'notes',
      displayName: 'Notes',
      route: '/notes',
      actions: [
        ...commonActions(),
        { name: 'CREATE_NOTE', description: 'create', params: [] },
        { name: 'UPDATE_NOTE', description: 'update', params: [] },
        { name: 'DELETE_NOTE', description: 'delete', params: [] },
        { name: 'REFRESH_NOTES', description: 'refresh', params: [] },
      ],
    };

    const notesSurface = buildAppControlSurfaceContracts(app).find(
      (surface) => surface.surface === 'notes',
    );

    expect(notesSurface?.coverage).toBe('covered');
    expect(notesSurface?.backing_schema_ids).toEqual(['notes-note', 'notes-state']);
    expect(notesSurface?.backing_action_types).toEqual([
      'CREATE_NOTE',
      'UPDATE_NOTE',
      'DELETE_NOTE',
      'REFRESH_NOTES',
    ]);
  });

  it('covers Album image surfaces with a generic REFRESH action', () => {
    const app: AppDef = {
      appId: 8,
      appName: 'album',
      displayName: 'Album',
      route: '/album',
      actions: [...commonActions(), { name: 'REFRESH', description: 'refresh images', params: [] }],
    };

    const imageSurface = buildAppControlSurfaceContracts(app).find(
      (surface) => surface.surface === 'images',
    );

    expect(imageSurface?.coverage).toBe('covered');
    expect(imageSurface?.backing_action_types).toContain('REFRESH');
    expect(imageSurface?.backing_schema_ids).toContain('album-image');
  });

  it('reports concrete gaps for partially exposed app surfaces', () => {
    const app: AppDef = {
      appId: 25,
      appName: 'aoimemory',
      displayName: 'Aoi Memory',
      route: '/aoi-memory',
      actions: [
        ...commonActions(),
        { name: 'REFRESH_AOI_MEMORY_DASHBOARD', description: 'refresh', params: [] },
        { name: 'FILTER_AOI_MEMORY', description: 'filter', params: [] },
        { name: 'ARCHIVE_AOI_MEMORY', description: 'archive', params: [] },
      ],
    };

    const memoryRecords = buildAppControlSurfaceContracts(app).find(
      (surface) => surface.surface === 'memory_records',
    );

    expect(memoryRecords?.coverage).toBe('partial');
    expect(memoryRecords?.gaps).toContain('Missing action: PROMOTE_AOI_MEMORY');
    expect(memoryRecords?.gaps).toContain('Missing action: DEMOTE_AOI_MEMORY');
    expect(memoryRecords?.gaps).toContain('Missing action: DELETE_AOI_MEMORY');
    expect(memoryRecords?.gaps).toContain('Missing schema: aoimemory-memory');
  });

  it('summarizes and resolves control surface contracts', () => {
    const contracts = listAppControlSurfaceContracts('notes');
    const summary = summarizeAppControlSurfaceContracts(contracts);
    const surface = findAppControlSurfaceContract('notes', 'notes-note');

    expect(summary.app_count).toBe(1);
    expect(summary.surface_count).toBeGreaterThan(0);
    expect(summary.covered_count).toBeGreaterThan(0);
    expect(surface?.surface).toBe('notes');
  });
});
