import type { AoiProactiveTrendAdvisorReadiness } from './aoiAutonomyTypes';

// P5.4 (client): pure model for the /operator/readiness-accrual response.
//
// Kept out of the React component so the parse + headline contracts are unit-tested
// without a DOM or fetch. The readiness type is imported TYPE-ONLY, so this stays
// client-build-safe (the import is erased; the server assembly lives in
// aoiProactiveTrendReadinessServer).

export const AOI_READINESS_ACCRUAL_ROUTE = '/api/aoi-autonomy/operator/readiness-accrual';

export interface AoiReadinessAccrualResponse {
  ok?: boolean;
  readiness?: AoiProactiveTrendAdvisorReadiness;
}

// Return the readiness, or null when the payload is missing / not ok / malformed.
export function parseAoiReadinessAccrualResponse(
  payload: unknown,
): AoiProactiveTrendAdvisorReadiness | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const body = payload as AoiReadinessAccrualResponse;
  if (body.ok !== true || !body.readiness || typeof body.readiness !== 'object') {
    return null;
  }
  return body.readiness;
}

// One-line headline for the trust on-ramp accrual meter.
export function summarizeAoiReadinessAccrual(readiness: AoiProactiveTrendAdvisorReadiness): string {
  const gate = readiness.directChatReady ? 'direct-chat READY' : 'accruing';
  return `${readiness.status} | ${readiness.sampleCount} field sample(s) | ${gate}`;
}
