// Links host-bridge kill-switch capabilities to the session environment-source
// consent they also require. Process list is a common footgun: the Advanced
// panel enables process_activity, but GET /processes still needs
// process-activity consent + consentReason.

export interface AoiHostBridgeConsentLink {
  capabilityKey: string;
  sourceId: string;
  label: string;
  consentReason: string;
}

export const AOI_HOST_BRIDGE_CONSENT_LINKS: readonly AoiHostBridgeConsentLink[] = [
  {
    capabilityKey: 'process_activity',
    sourceId: 'process-activity',
    label: 'Running process list',
    consentReason: 'Enabled from Host Bridge settings (process list).',
  },
  {
    capabilityKey: 'desktop_activity',
    sourceId: 'desktop-activity',
    label: 'Desktop activity',
    consentReason: 'Enabled from Host Bridge settings (desktop activity).',
  },
];

export function getAoiHostBridgeConsentLink(
  capabilityKey: string,
): AoiHostBridgeConsentLink | null {
  return AOI_HOST_BRIDGE_CONSENT_LINKS.find((link) => link.capabilityKey === capabilityKey) ?? null;
}

/** Patch for updateAoiEnvironmentSource when linking kill-switch enable/disable. */
export function buildAoiHostBridgeLinkedSourcePatch(
  link: AoiHostBridgeConsentLink,
  enabled: boolean,
  now = Date.now(),
): {
  enabled: boolean;
  consentReason?: string;
  lastReviewedAt?: number;
} {
  if (enabled) {
    return {
      enabled: true,
      consentReason: link.consentReason,
      lastReviewedAt: now,
    };
  }
  return { enabled: false };
}
