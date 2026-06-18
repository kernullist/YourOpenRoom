import { describe, expect, it } from 'vitest';

import {
  buildAppControlCapabilities,
  formatAppCapabilityLine,
  summarizeAppControlCapabilities,
} from '../appControlCapabilities';
import type { AppDef } from '../appRegistry';

describe('appControlCapabilities', () => {
  it('summarizes app state, schema, and action control surfaces', () => {
    const app: AppDef = {
      appId: 16,
      appName: 'notes',
      displayName: 'Notes',
      route: '/notes',
      actions: [
        { name: 'CREATE_NOTE', description: 'create', params: [] },
        { name: 'DELETE_NOTE', description: 'delete', params: [] },
        { name: 'REFRESH_NOTES', description: 'refresh', params: [] },
      ],
    };

    const capabilities = buildAppControlCapabilities(app);

    expect(capabilities.control_status).toBe('tool-backed');
    expect(capabilities.state).toMatchObject({
      can_read_state_file: true,
      state_file_path: 'apps/notes/data/state.json',
      has_bespoke_summary: true,
    });
    expect(capabilities.storage.schema_ids).toContain('notes-note');
    expect(capabilities.actions.names).toEqual(['CREATE_NOTE', 'DELETE_NOTE', 'REFRESH_NOTES']);
    expect(capabilities.actions.categories).toEqual(['create', 'delete', 'operation']);
    expect(capabilities.actions.mutating_names).toEqual(['CREATE_NOTE', 'DELETE_NOTE']);
    expect(capabilities.actions.destructive_names).toEqual(['DELETE_NOTE']);
    expect(capabilities.gaps).toEqual([]);
    expect(formatAppCapabilityLine(capabilities)).toContain('Notes controls:');
  });

  it('reports inventory gaps for apps without loaded meta actions or schemas', () => {
    const app: AppDef = {
      appId: 999,
      appName: 'unregisteredapp',
      displayName: 'Unregistered App',
      route: '/unregistered',
      actions: [],
    };

    const capabilities = buildAppControlCapabilities(app);
    const summary = summarizeAppControlCapabilities([capabilities]);

    expect(capabilities.control_status).toBe('inspectable');
    expect(capabilities.gaps).toContain('No declared app actions are loaded from meta.yaml yet.');
    expect(summary.gap_apps).toEqual([{ app_name: 'unregisteredapp', gaps: capabilities.gaps }]);
  });
});
