import { describe, expect, it } from 'vitest';
import {
  buildAoiHostBridgeLinkedSourcePatch,
  getAoiHostBridgeConsentLink,
  needsAoiHostBridgeConsentRepair,
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

  it('maps os_browser_read and os_browser_drive to their source consent', () => {
    expect(getAoiHostBridgeConsentLink('os_browser_read')?.sourceId).toBe('host-browser-read');
    const drive = getAoiHostBridgeConsentLink('os_browser_drive');
    expect(drive?.sourceId).toBe('browser-drive');
    expect(buildAoiHostBridgeLinkedSourcePatch(drive!, true, 2000)).toEqual({
      enabled: true,
      consentReason: drive!.consentReason,
      lastReviewedAt: 2000,
    });
  });

  it('returns null for an unknown capability', () => {
    expect(getAoiHostBridgeConsentLink('nope')).toBeNull();
  });
});

describe('needsAoiHostBridgeConsentRepair', () => {
  it('repairs only a source nobody has decided on', () => {
    expect(needsAoiHostBridgeConsentRepair(undefined)).toBe(true);
    expect(needsAoiHostBridgeConsentRepair({ enabled: false })).toBe(true);
  });

  it('leaves an explicit decision alone, and does not rewrite an enabled one', () => {
    // An operator who disabled the session source must not be re-granted on the
    // next settings open.
    expect(
      needsAoiHostBridgeConsentRepair({ enabled: false, consentReason: 'Disabled by operator' }),
    ).toBe(false);
    expect(needsAoiHostBridgeConsentRepair({ enabled: false, lastReviewedAt: 1000 })).toBe(false);
    expect(needsAoiHostBridgeConsentRepair({ enabled: true })).toBe(false);
  });
});
