import { describe, expect, it } from 'vitest';

import {
  AOI_DEFAULT_CAPABILITY_NAMES,
  buildAoiCapabilityPrompt,
  getAoiCapabilityRows,
  getUnknownAoiCapabilityNames,
  summarizeAoiCapabilityRegistry,
} from '../aoiCapabilityRegistry';

describe('aoiCapabilityRegistry', () => {
  it('registers every default Aoi chat capability', () => {
    const summary = summarizeAoiCapabilityRegistry(AOI_DEFAULT_CAPABILITY_NAMES);

    expect(summary.total).toBeGreaterThan(20);
    expect(summary.registered).toBe(summary.total);
    expect(summary.unknown).toBe(0);
    expect(summary.byRisk.high).toBeGreaterThan(0);
    expect(summary.writeOrExecute).toBeGreaterThan(0);
    expect(summary.bySurface.some((item) => item.surface === 'ide')).toBe(true);
  });

  it('marks mutation and command tools as high risk', () => {
    const rows = getAoiCapabilityRows(['file_write', 'run_command', 'file_read']);
    const byName = Object.fromEntries(rows.map((row) => [row.name, row]));

    expect(byName.file_write?.risk).toBe('high');
    expect(byName.file_write?.access).toContain('write');
    expect(byName.run_command?.risk).toBe('high');
    expect(byName.run_command?.access).toContain('execute');
    expect(byName.file_read?.risk).toBe('low');
    expect(byName.file_read?.parallelSafe).toBe(true);
    expect(byName.file_read?.cacheable).toBe(true);
  });

  it('surfaces unknown capabilities for review', () => {
    const unknown = getUnknownAoiCapabilityNames(['file_read', 'new_remote_tool']);
    const summary = summarizeAoiCapabilityRegistry(['file_read', 'new_remote_tool']);

    expect(unknown).toEqual(['new_remote_tool']);
    expect(summary.unknown).toBe(1);
    expect(summary.byRisk.unknown).toBe(1);
  });

  it('builds a compact prompt from the exposed tool set', () => {
    const prompt = buildAoiCapabilityPrompt(['respond_to_user', 'file_write', 'file_read']);

    expect(prompt).toContain('Aoi Capability Registry');
    expect(prompt).toContain('respond_to_user');
    expect(prompt).toContain('file_write');
    expect(prompt).toContain('High-risk tools');
    expect(prompt).not.toContain('search_web');
  });
});
