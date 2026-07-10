// P5-adjacent / P4.1 (client): pure model for the memory-decay operator panel.
//
// Kept free of any server-module import (local types mirror the decay route payloads) so
// the panel stays trivially client-build-safe, and the parse/body contracts are unit-tested
// without a DOM or fetch. The server routes (decay-preview / decay-apply / decay-restore)
// are the load-bearing safety: apply is gated by a content-addressed approval fingerprint,
// so a wrong id-set from the client can only 409 (reject) -- never archive the wrong set.

export const AOI_DECAY_PREVIEW_ROUTE = '/api/aoi-autonomy/memory/decay-preview';
export const AOI_DECAY_APPLY_ROUTE = '/api/aoi-autonomy/memory/decay-apply';
export const AOI_DECAY_RESTORE_ROUTE = '/api/aoi-autonomy/memory/decay-restore';

export interface AoiDecayCandidateView {
  id: string;
  contentPreview: string;
  confidence: number;
  hits: number;
  ageMs: number;
  reasons: string[];
}

export interface AoiDecayPreview {
  candidates: AoiDecayCandidateView[];
  fingerprint: string;
  totalActive: number;
}

export interface AoiDecayApplyResult {
  rejected: boolean;
  archivedCount: number;
  changedIds: string[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

// Parse the decay-preview response into a preview, or null when not ok / malformed.
export function parseAoiDecayPreviewResponse(payload: unknown): AoiDecayPreview | null {
  const body = asRecord(payload);
  if (!body || body.ok !== true || !Array.isArray(body.candidates)) {
    return null;
  }
  const candidates: AoiDecayCandidateView[] = body.candidates
    .map((raw) => asRecord(raw))
    .filter((raw): raw is Record<string, unknown> => raw !== null)
    .map((raw) => ({
      id: typeof raw.id === 'string' ? raw.id : '',
      contentPreview: typeof raw.contentPreview === 'string' ? raw.contentPreview : '',
      confidence: typeof raw.confidence === 'number' ? raw.confidence : 0,
      hits: typeof raw.hits === 'number' ? raw.hits : 0,
      ageMs: typeof raw.ageMs === 'number' ? raw.ageMs : 0,
      reasons: asStringArray(raw.reasons),
    }))
    .filter((candidate) => candidate.id.length > 0);
  return {
    candidates,
    fingerprint: typeof body.fingerprint === 'string' ? body.fingerprint : '',
    totalActive: typeof body.totalActive === 'number' ? body.totalActive : 0,
  };
}

// Build the decay-apply body: the EXACT reviewed id set + the content-addressed fingerprint
// the operator is approving. The server re-derives the fingerprint and rejects (409) on any
// drift, so this must send the fingerprint that pairs with these ids.
export function buildAoiDecayApplyBody(preview: AoiDecayPreview): {
  ids: string[];
  approvalFingerprint: string;
} {
  return {
    ids: preview.candidates.map((candidate) => candidate.id),
    approvalFingerprint: preview.fingerprint,
  };
}

// Parse the decay-apply response. A 409 drift comes back as { ok:false, rejected:true }.
export function parseAoiDecayApplyResponse(payload: unknown): AoiDecayApplyResult | null {
  const body = asRecord(payload);
  if (!body) {
    return null;
  }
  if (body.ok !== true) {
    return { rejected: body.rejected === true, archivedCount: 0, changedIds: [] };
  }
  return {
    rejected: false,
    archivedCount: typeof body.archivedCount === 'number' ? body.archivedCount : 0,
    changedIds: asStringArray(body.changedIds),
  };
}
