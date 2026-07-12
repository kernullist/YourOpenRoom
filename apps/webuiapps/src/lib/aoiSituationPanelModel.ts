import type { AoiCurrentSituation } from './aoiCurrentSituationModel';

// SA4.4 (client): pure parse + view model for the GET /api/aoi-autonomy/situation
// response, kept out of the React component so the contract is unit-tested
// without a DOM or fetch (the aoiOperatorSnapshotPanelModel discipline). The
// situation type is imported TYPE-ONLY so this stays browser-bundle-safe (the
// server-only fs assembly lives in aoiCurrentSituationModel).

export const AOI_SITUATION_ROUTE_PREFIX = '/api/aoi-autonomy/situation';

export function buildAoiSituationRoute(sessionPath: string): string {
  return `${AOI_SITUATION_ROUTE_PREFIX}?sessionPath=${encodeURIComponent(sessionPath)}`;
}

export interface AoiSituationPanelResponse {
  ok?: boolean;
  situation?: AoiCurrentSituation | null;
  stale?: boolean | null;
}

export interface AoiSituationPanelParseResult {
  situation: AoiCurrentSituation | null;
  stale: boolean;
}

// Return {situation, stale}, or null when the payload is malformed / not ok.
// A missing situation is a VALID state (the tick has not fused one yet).
export function parseAoiSituationResponse(payload: unknown): AoiSituationPanelParseResult | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const body = payload as AoiSituationPanelResponse;
  if (body.ok !== true) {
    return null;
  }
  if (body.situation === null || body.situation === undefined) {
    return { situation: null, stale: false };
  }
  if (
    typeof body.situation !== 'object' ||
    body.situation.version !== 1 ||
    body.situation.actionAuthority !== 'display_only' ||
    !Array.isArray(body.situation.segments)
  ) {
    return null;
  }
  return { situation: body.situation, stale: body.stale === true };
}

export interface AoiSituationPanelFocusRow {
  title: string;
  salienceLabel: string;
  evidenceLabel: string;
}

export interface AoiSituationPanelViewModel {
  hasSituation: boolean;
  headline: string;
  stateLabel: string;
  confidenceLabel: string;
  intentLabel: string;
  focusRows: AoiSituationPanelFocusRow[];
  cannotKnow: string[];
  evidenceCount: number;
}

// A thin, display-ready projection so the panel component stays a renderer.
export function buildAoiSituationPanelViewModel(
  parsed: AoiSituationPanelParseResult,
): AoiSituationPanelViewModel {
  const situation = parsed.situation;
  if (!situation) {
    return {
      hasSituation: false,
      headline: 'No situation brief yet -- it is fused on the next autonomy wakeup.',
      stateLabel: 'none',
      confidenceLabel: '-',
      intentLabel: 'unknown',
      focusRows: [],
      cannotKnow: [],
      evidenceCount: 0,
    };
  }
  return {
    hasSituation: true,
    headline: situation.headline,
    stateLabel: parsed.stale ? 'stale' : 'current',
    confidenceLabel: situation.confidence.toFixed(2),
    intentLabel: situation.intent ? situation.intent.label : 'unknown',
    focusRows: situation.focusItems.map((item) => ({
      title: item.title,
      salienceLabel: item.salienceScore.toFixed(2),
      evidenceLabel: item.evidenceRefs.join(', '),
    })),
    cannotKnow: situation.cannotKnow.slice(0, 6),
    evidenceCount: situation.evidenceRefs.length,
  };
}
