import { describe, expect, it } from 'vitest';
import {
  listAoiHostReadRootPresets,
  listAoiHostSpawnPresets,
  resolveAoiHostPresetPlatform,
} from '../aoiHostBridgePresets';

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

  it('includes common Windows spawn presets without reading bare process', () => {
    const presets = listAoiHostSpawnPresets({ USERPROFILE: 'C:\\Users\\tester' }, 'win32');
    expect(presets.some((item) => item.id === 'exe-notepad')).toBe(true);
    expect(presets.some((item) => item.kind === 'directory')).toBe(true);
    expect(presets.some((item) => item.id === 'dir-local-programs')).toBe(true);
  });

  it('returns posix spawn folders when platform is posix and HOME is set', () => {
    const presets = listAoiHostSpawnPresets({ HOME: '/home/tester' }, 'posix');
    expect(presets.map((item) => item.id)).toEqual(['dir-usr-bin', 'dir-usr-local-bin']);
  });

  it('is safe with empty env (browser has no USERPROFILE/HOME)', () => {
    expect(listAoiHostReadRootPresets({})).toEqual([]);
    // Windows static paths still appear even without home.
    const win = listAoiHostSpawnPresets({}, 'win32');
    expect(win.some((item) => item.id === 'exe-notepad')).toBe(true);
    expect(win.every((item) => item.id !== 'dir-local-programs')).toBe(true);
  });

  it('resolves explicit platform overrides', () => {
    expect(resolveAoiHostPresetPlatform('win32')).toBe('win32');
    expect(resolveAoiHostPresetPlatform('posix')).toBe('posix');
  });
});
