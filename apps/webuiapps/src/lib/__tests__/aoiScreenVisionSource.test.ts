// SV1.1 -- registration of the `screen_vision` environment source.
//
// Screen vision is a hybrid host-bridge source: it perceives the FOCUSED
// window's content via a vision model, but persists only a redacted, bounded,
// structured text summary (raw pixels are never stored). This slice registers
// the source end-to-end (kind union + kind list + catalog default + router
// source-id map + freshness window + honest data-scope/cannotKnow + salience
// half-life + blind-spot exclusion). No reader/route/UI consumes it yet, so the
// running system stays byte-identical until a later slice + operator consent.
import { describe, expect, it } from 'vitest';

import {
  AOI_ENVIRONMENT_SOURCE_KINDS,
  getDefaultAoiEnvironmentSourceRegistry,
} from '../aoiAutonomyPolicy';
import {
  buildAoiSourceFreshnessContracts,
  findAoiSourceFreshnessContract,
} from '../aoiSourceFreshnessContract';
import { AOI_SALIENCE_HALF_LIVES_MS } from '../aoiSalienceModel';

const NOW = 1_700_000_000_000;
const SCREEN_VISION_SOURCE_ID = 'screen-vision';

describe('SV1.1 screen_vision source registration', () => {
  it('is enumerated in the normalize kind list', () => {
    expect(AOI_ENVIRONMENT_SOURCE_KINDS).toContain('screen_vision');
  });

  it('has a default catalog entry with the strictest privacy posture (default OFF)', () => {
    const registry = getDefaultAoiEnvironmentSourceRegistry('aoi/default', NOW);
    const entry = registry.sources.find((source) => source.id === SCREEN_VISION_SOURCE_ID);
    expect(entry).toBeDefined();
    expect(entry?.kind).toBe('screen_vision');
    // Default OFF, private, explicit-target, high-risk, suppressed in quiet mode.
    expect(entry?.enabled).toBe(false);
    expect(entry?.privateByDefault).toBe(true);
    expect(entry?.scope).toBe('explicit_target');
    expect(entry?.risk).toBe('high');
    expect(entry?.quietModeBehavior).toBe('suppress');
    expect(entry?.allowedOperations).toEqual(['read_metadata', 'summarize_counts']);
  });

  it('decays on a minutes scale (faster than app activity) and is honest about pixels', () => {
    const registry = getDefaultAoiEnvironmentSourceRegistry('aoi/default', NOW);
    const contracts = buildAoiSourceFreshnessContracts({ sourceRegistry: registry, now: NOW });
    const contract = findAoiSourceFreshnessContract(contracts, SCREEN_VISION_SOURCE_ID);
    expect(contract).toBeDefined();
    // 5-minute freshness window -- a stale frame must never ground a live claim.
    expect(contract?.staleAfterMs).toBe(5 * 60 * 1000);
    // Data scope names the redacted-summary boundary, not raw content.
    expect(contract?.dataScope).toContain('redacted');
    expect(contract?.dataScope).toContain('focused window');
    // The pixels-not-persisted cannotKnow boundary is always present.
    const boundary = contract?.cannotKnow.find(
      (item) => item.code === 'screen_vision_pixels_not_persisted',
    );
    expect(boundary).toBeDefined();
    expect(boundary?.statement).toContain('raw screen pixels');
  });

  it('has a salience half-life shorter than app activity (most volatile NOW signal)', () => {
    expect(AOI_SALIENCE_HALF_LIVES_MS.screen_vision).toBe(15 * 60 * 1000);
    expect(AOI_SALIENCE_HALF_LIVES_MS.screen_vision).toBeLessThan(
      AOI_SALIENCE_HALF_LIVES_MS.app_activity,
    );
  });
});
