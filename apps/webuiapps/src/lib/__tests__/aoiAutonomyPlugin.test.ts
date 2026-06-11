import { describe, expect, it } from 'vitest';
import { getAoiAutonomyRoute } from '../aoiAutonomyPlugin';

describe('Aoi autonomy plugin routes', () => {
  it('matches only the Aoi autonomy API prefix', () => {
    expect(getAoiAutonomyRoute('/api/aoi-autonomy/status')).toBe('/status');
    expect(getAoiAutonomyRoute('/api/aoi-autonomy/tick')).toBe('/tick');
    expect(getAoiAutonomyRoute('/api/aoi-autonomy/goals')).toBe('/goals');
    expect(getAoiAutonomyRoute('/api/aoi-autonomy/evaluation')).toBe('/evaluation');
    expect(getAoiAutonomyRoute('/api/aoi-autonomy/goal/decision')).toBe('/goal/decision');
    expect(getAoiAutonomyRoute('/api/aoi-autonomy/goal/check')).toBe('/goal/check');
    expect(getAoiAutonomyRoute('/api/aoi-autonomy/proposal/feedback')).toBe('/proposal/feedback');
    expect(getAoiAutonomyRoute('/api/aoi-autonomy')).toBe('/');
    expect(getAoiAutonomyRoute('/api/aoi-autonomyx/status')).toBeNull();
    expect(getAoiAutonomyRoute('/api/aoi-research/status')).toBeNull();
  });
});
