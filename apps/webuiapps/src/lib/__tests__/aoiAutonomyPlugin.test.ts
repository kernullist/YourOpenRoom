import { describe, expect, it } from 'vitest';
import { getAoiAutonomyRoute } from '../aoiAutonomyPlugin';

describe('Aoi autonomy plugin routes', () => {
  it('matches only the Aoi autonomy API prefix', () => {
    expect(getAoiAutonomyRoute('/api/aoi-autonomy/status')).toBe('/status');
    expect(getAoiAutonomyRoute('/api/aoi-autonomy')).toBe('/');
    expect(getAoiAutonomyRoute('/api/aoi-autonomyx/status')).toBeNull();
    expect(getAoiAutonomyRoute('/api/aoi-research/status')).toBeNull();
  });
});
