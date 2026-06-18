import { describe, expect, it } from 'vitest';

import { executeAppIntentTool } from '../appIntentTools';

describe('executeAppIntentTool()', () => {
  it('returns app intent contracts for a known app', async () => {
    const result = await executeAppIntentTool({ app_name: 'Notes' });
    const parsed = JSON.parse(result) as {
      app: { app_name: string };
      summary: { intent_count: number; schema_write_count: number };
      intents: Array<{ intent: string; execution: { kind: string; schema_id?: string } }>;
      control_surface_summary: { surface_count: number };
      control_surfaces: Array<{
        surface: string;
        coverage: string;
        backing_schema_ids: string[];
      }>;
    };

    expect(parsed.app.app_name).toBe('notes');
    expect(parsed.summary.schema_write_count).toBeGreaterThan(0);
    expect(parsed.control_surface_summary.surface_count).toBeGreaterThan(0);
    expect(
      parsed.control_surfaces.some(
        (surface) =>
          surface.surface === 'notes' && surface.backing_schema_ids.includes('notes-note'),
      ),
    ).toBe(true);
    expect(
      parsed.intents.some(
        (intent) =>
          intent.intent === 'create_note' &&
          intent.execution.kind === 'schema_file_write' &&
          intent.execution.schema_id === 'notes-note',
      ),
    ).toBe(true);
  });

  it('resolves a requested intent to one execution contract', async () => {
    const result = await executeAppIntentTool({
      app_name: 'notes',
      intent: 'create note',
    });
    const parsed = JSON.parse(result) as {
      ok: boolean;
      contract: { intent: string; execution: { kind: string } };
    };

    expect(parsed.ok).toBe(true);
    expect(parsed.contract.intent).toBe('create_note');
    expect(parsed.contract.execution.kind).toBe('schema_file_write');
  });

  it('returns a structured unsupported intent result', async () => {
    const result = await executeAppIntentTool({
      app_name: 'Aoi Memory',
      intent: 'teleport the dashboard',
    });
    const parsed = JSON.parse(result) as {
      ok: boolean;
      error: string;
      app: { app_name: string };
      available_intents: Array<{ intent: string }>;
      control_surface_summary: { surface_count: number };
      control_surfaces: Array<{ surface: string; gaps: string[] }>;
    };

    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe('unsupported_app_intent');
    expect(parsed.app.app_name).toBe('aoimemory');
    expect(parsed.available_intents.length).toBeGreaterThan(0);
    expect(parsed.control_surface_summary.surface_count).toBeGreaterThan(0);
    expect(parsed.control_surfaces.some((surface) => surface.surface === 'memory_records')).toBe(
      true,
    );
  });

  it('returns a compact all-app intent inventory when no app is provided', async () => {
    const result = await executeAppIntentTool({});
    const parsed = JSON.parse(result) as {
      summary: { app_count: number; intent_count: number };
      control_surface_summary: { surface_count: number };
      apps: Array<{ app_name: string; intent_count: number }>;
    };

    expect(parsed.summary.app_count).toBeGreaterThan(0);
    expect(parsed.summary.intent_count).toBeGreaterThan(0);
    expect(parsed.control_surface_summary.surface_count).toBeGreaterThan(0);
    expect(parsed.apps.some((app) => app.app_name === 'kira' && app.intent_count > 0)).toBe(true);
  });
});
