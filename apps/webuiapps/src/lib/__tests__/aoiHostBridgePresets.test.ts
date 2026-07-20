import { describe, expect, it } from 'vitest';
import { listAoiHostReadRootPresets, listAoiHostSpawnPresets } from '../aoiHostBridgePresets';

describe('aoiHostBridgePresets', () => {
  it('builds user folder root presets from USERPROFILE', () => {
    const presets = listAoiHostReadRootPresets({ USERPROFILE: 'C:\\Users\\tester' });
    expect(presets.map((item) => item.id)).toEqual([
      'root-user-home',
      'root-documents',
      'root-desktop',
      'root-downloads',
    ]);
    expect(presets[1].path.replace(/\\/g, '/')).toContain('Documents');
  });

  it('includes common Windows spawn presets', () => {
    if (process.platform !== 'win32') {
      return;
    }
    const presets = listAoiHostSpawnPresets({ USERPROFILE: 'C:\\Users\\tester' });
    expect(presets.some((item) => item.id === 'exe-notepad')).toBe(true);
    expect(presets.some((item) => item.kind === 'directory')).toBe(true);
  });
});
