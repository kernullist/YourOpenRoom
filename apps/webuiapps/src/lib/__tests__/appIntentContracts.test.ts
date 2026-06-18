import { describe, expect, it } from 'vitest';

import {
  buildAppIntentContracts,
  findAppIntentContract,
  summarizeAppIntentContracts,
} from '../appIntentContracts';
import type { AppDef } from '../appRegistry';

describe('appIntentContracts', () => {
  it('builds schema-first data mutation contracts for app storage entities', () => {
    const app: AppDef = {
      appId: 16,
      appName: 'notes',
      displayName: 'Notes',
      route: '/notes',
      actions: [
        { name: 'OPEN_APP_WINDOW', description: 'open', params: [] },
        { name: 'CREATE_NOTE', description: 'refresh after note creation', params: [] },
        { name: 'REFRESH_NOTES', description: 'refresh notes', params: [] },
      ],
    };

    const contracts = buildAppIntentContracts(app);
    const createNote = contracts.find((contract) => contract.intent === 'create_note');

    expect(createNote?.execution.kind).toBe('schema_file_write');
    expect(createNote?.id).toBe('notes:schema:create_note');
    expect(createNote?.execution.schema_id).toBe('notes-note');
    expect(createNote?.execution.refresh_action_type).toBe('CREATE_NOTE');
    expect(createNote?.required_tools).toContain('file_write');
    expect(createNote?.required_tools).toContain('app_action');
  });

  it('keeps window control and app-owned settings actions as app actions', () => {
    const app: AppDef = {
      appId: 18,
      appName: 'kira',
      displayName: 'Kira',
      route: '/kira',
      actions: [
        { name: 'OPEN_APP_WINDOW', description: 'open', params: [] },
        {
          name: 'APPLY_MODEL_SETTINGS',
          description: 'Persist Kira model settings',
          params: [{ name: 'model', type: 'string', description: 'model', required: false }],
        },
      ],
    };

    const contracts = buildAppIntentContracts(app);
    const openWindow = contracts.find((contract) => contract.intent === 'open_app_window');
    const applySettings = contracts.find(
      (contract) => contract.execution.action_type === 'APPLY_MODEL_SETTINGS',
    );

    expect(openWindow?.execution.kind).toBe('window_action');
    expect(openWindow?.id).toBe('kira:open_app_window');
    expect(applySettings?.execution.kind).toBe('app_action');
    expect(applySettings?.id).toBe('kira:apply_model_settings');
    expect(applySettings?.execution.tool_name).toBe('app_action');
    expect(applySettings?.execution.requires_preview).toBe(true);
  });

  it('resolves natural intent references to the schema-backed contract before refresh actions', () => {
    const match = findAppIntentContract('notes', 'create note');

    expect(match?.intent).toBe('create_note');
    expect(match?.execution.kind).toBe('schema_file_write');
  });

  it('recognizes generic REFRESH actions as schema refresh hooks', () => {
    const contracts = buildAppIntentContracts({
      appId: 8,
      appName: 'album',
      displayName: 'Album',
      route: '/album',
      actions: [
        { name: 'OPEN_APP_WINDOW', description: 'open', params: [] },
        { name: 'REFRESH', description: 'refresh images', params: [] },
      ],
    });
    const createImage = contracts.find((contract) => contract.intent === 'create_image');

    expect(createImage?.execution.schema_id).toBe('album-image');
    expect(createImage?.execution.refresh_action_type).toBe('REFRESH');
    expect(createImage?.gaps).toEqual([]);
  });

  it('summarizes intent contract coverage', () => {
    const contracts = buildAppIntentContracts({
      appId: 16,
      appName: 'notes',
      displayName: 'Notes',
      route: '/notes',
      actions: [{ name: 'OPEN_APP_WINDOW', description: 'open', params: [] }],
    });
    const summary = summarizeAppIntentContracts(contracts);

    expect(summary.app_count).toBe(1);
    expect(summary.intent_count).toBeGreaterThan(0);
    expect(summary.schema_write_count).toBeGreaterThan(0);
    expect(summary.window_action_count).toBe(1);
  });
});
