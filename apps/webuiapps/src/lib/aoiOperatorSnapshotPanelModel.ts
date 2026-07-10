import type { AoiUnifiedOperatorSnapshotSummary } from './aoiUnifiedOperatorModel';

// P5.3 (client): pure parse for the /api/aoi-autonomy/operator/unified-snapshot response.
//
// Kept out of the React component so the (network-agnostic) parse contract is unit-tested
// without a DOM or fetch -- the same discipline as aoiReplayPromotionPanelModel. The
// summary type is imported TYPE-ONLY, so this stays in the browser bundle safely (the
// import is erased at build; the server-only assembly lives in aoiUnifiedOperatorModelServer).

export const AOI_OPERATOR_SNAPSHOT_ROUTE = '/api/aoi-autonomy/operator/unified-snapshot';

export interface AoiOperatorSnapshotResponse {
  ok?: boolean;
  summary?: AoiUnifiedOperatorSnapshotSummary;
}

// Return the display summary, or null when the payload is missing / not ok / malformed.
export function parseAoiOperatorSnapshotResponse(
  payload: unknown,
): AoiUnifiedOperatorSnapshotSummary | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const body = payload as AoiOperatorSnapshotResponse;
  if (body.ok !== true || !body.summary || typeof body.summary !== 'object') {
    return null;
  }
  return body.summary;
}

// A short, operator-facing one-liner for the snapshot's headline state. Pure so the panel
// stays a thin renderer.
export function summarizeAoiOperatorSnapshotHeadline(
  summary: AoiUnifiedOperatorSnapshotSummary,
): string {
  return `Readiness ${summary.readiness} | interruption ${summary.interruption} | ${summary.blindSpotCount} blind spot(s)`;
}
