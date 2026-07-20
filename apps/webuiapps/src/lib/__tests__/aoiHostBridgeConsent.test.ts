import { describe, expect, it } from 'vitest';
import {
  buildAoiHostBridgeLinkedSourcePatch,
  getAoiHostBridgeConsentLink,
} from '../aoiHostBridgeConsent';

describe('aoiHostBridgeConsent', () => {
  it('maps process_activity to process-activity source consent', () => {
    const link = getAoiHostBridgeConsentLink('process_activity');
    expect(link?.sourceId).toBe('process-activity');
    const patch = buildAoiHostBridgeLinkedSourcePatch(link!, true, 1000);
    expect(patch).toEqual({
      enabled: true,
      consentReason: link!.consentReason,
      lastReviewedAt: 1000,
    });
  });

  it('clears enable when turning the linked capability off', () => {
    const link = getAoiHostBridgeConsentLink('desktop_activity');
    expect(link?.sourceId).toBe('desktop-activity');
    expect(buildAoiHostBridgeLinkedSourcePatch(link!, false)).toEqual({ enabled: false });
  });
});
