// Pure view model for the relationship-history panel (R4.2).
//
// Kept separate from the component (and from the fs-touching stores) so the
// parsing and formatting are unit-testable and the client never imports a
// node-only module. Mirrors aoiSituationPanelModel.
//
// Honesty rules: a malformed or non-display-only payload is rejected outright
// rather than partially rendered, and an absent retrospective produces an
// explicit empty state -- the panel must never imply a shared history that is
// not stored.

export interface AoiRelationshipHistoryRetrospective {
  id: string;
  periodStart: number;
  periodEnd: number;
  narrative: string;
  shipped: string[];
  stuck: string[];
  researched: string[];
  milestones: string[];
  openNext: string[];
  sessionCount: number;
  empty: boolean;
  evidenceRefs: string[];
  synthesizedBy: 'deterministic' | 'llm';
}

export interface AoiRelationshipHistoryMilestone {
  id: string;
  kind: string;
  label: string;
  occurredAt: number;
}

export interface AoiRelationshipHistoryPayload {
  sessionPath: string;
  retrospective: AoiRelationshipHistoryRetrospective | null;
  history: AoiRelationshipHistoryRetrospective[];
  milestones: AoiRelationshipHistoryMilestone[];
  firstMetAt: number | null;
  sessionCount: number | null;
}

export function buildAoiRelationshipHistoryRoute(sessionPath: string): string {
  return `/api/aoi-autonomy/relationship/retrospective?sessionPath=${encodeURIComponent(
    sessionPath,
  )}`;
}

function asStringArray(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .slice(0, maxItems);
}

function parseRetrospective(value: unknown): AoiRelationshipHistoryRetrospective | null {
  const raw = value as Record<string, unknown> | null;
  if (!raw || raw.version !== 1) {
    return null;
  }
  // Same fail-closed contract as the store: a record that claims any authority
  // beyond display is not rendered at all.
  if (raw.actionAuthority !== 'display_only' || raw.mutationCount !== 0) {
    return null;
  }
  if (
    typeof raw.id !== 'string' ||
    typeof raw.narrative !== 'string' ||
    typeof raw.periodStart !== 'number' ||
    typeof raw.periodEnd !== 'number'
  ) {
    return null;
  }
  return {
    id: raw.id,
    periodStart: raw.periodStart,
    periodEnd: raw.periodEnd,
    narrative: raw.narrative,
    shipped: asStringArray(raw.shipped, 5),
    stuck: asStringArray(raw.stuck, 5),
    researched: asStringArray(raw.researched, 5),
    milestones: asStringArray(raw.milestones, 5),
    openNext: asStringArray(raw.openNext, 5),
    sessionCount: typeof raw.sessionCount === 'number' ? raw.sessionCount : 0,
    empty: raw.empty === true,
    evidenceRefs: asStringArray(raw.evidenceRefs, 16),
    synthesizedBy: raw.synthesizedBy === 'llm' ? 'llm' : 'deterministic',
  };
}

function parseMilestone(value: unknown): AoiRelationshipHistoryMilestone | null {
  const raw = value as Record<string, unknown> | null;
  if (
    !raw ||
    typeof raw.id !== 'string' ||
    typeof raw.kind !== 'string' ||
    typeof raw.label !== 'string' ||
    typeof raw.occurredAt !== 'number'
  ) {
    return null;
  }
  return { id: raw.id, kind: raw.kind, label: raw.label, occurredAt: raw.occurredAt };
}

export function parseAoiRelationshipHistoryResponse(
  value: unknown,
): AoiRelationshipHistoryPayload | null {
  const raw = value as Record<string, unknown> | null;
  if (!raw || raw.ok !== true || typeof raw.sessionPath !== 'string') {
    return null;
  }
  return {
    sessionPath: raw.sessionPath,
    retrospective: parseRetrospective(raw.retrospective),
    history: Array.isArray(raw.history)
      ? raw.history
          .map(parseRetrospective)
          .filter((item): item is AoiRelationshipHistoryRetrospective => item !== null)
          .slice(0, 12)
      : [],
    milestones: Array.isArray(raw.milestones)
      ? raw.milestones
          .map(parseMilestone)
          .filter((item): item is AoiRelationshipHistoryMilestone => item !== null)
          .slice(0, 20)
      : [],
    firstMetAt: typeof raw.firstMetAt === 'number' ? raw.firstMetAt : null,
    sessionCount: typeof raw.sessionCount === 'number' ? raw.sessionCount : null,
  };
}

export interface AoiRelationshipHistoryRow {
  id: string;
  periodLabel: string;
  narrative: string;
  detailLabel: string;
}

export interface AoiRelationshipHistoryViewModel {
  hasHistory: boolean;
  summaryLabel: string;
  latest: AoiRelationshipHistoryRow | null;
  pastRows: AoiRelationshipHistoryRow[];
  milestoneRows: Array<{ id: string; label: string; dateLabel: string }>;
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function buildRow(record: AoiRelationshipHistoryRetrospective): AoiRelationshipHistoryRow {
  const detail = [
    `${record.shipped.length} landed`,
    `${record.stuck.length} stuck`,
    `${record.researched.length} researched`,
    `${record.openNext.length} still open`,
    `evidence ${record.evidenceRefs.length}`,
    record.synthesizedBy,
  ].join(' | ');
  return {
    id: record.id,
    periodLabel: `${formatDate(record.periodStart)} to ${formatDate(record.periodEnd)}`,
    narrative: record.narrative,
    detailLabel: detail,
  };
}

export function buildAoiRelationshipHistoryViewModel(
  payload: AoiRelationshipHistoryPayload,
): AoiRelationshipHistoryViewModel {
  const latest = payload.retrospective ? buildRow(payload.retrospective) : null;
  // The latest record is also the newest history entry; showing it twice would
  // read as two separate weeks.
  const pastRows = payload.history
    .filter((record) => record.id !== payload.retrospective?.id)
    .map(buildRow);
  const summaryParts: string[] = [];
  if (payload.sessionCount !== null) {
    summaryParts.push(`${payload.sessionCount} sessions together`);
  }
  if (payload.firstMetAt !== null) {
    summaryParts.push(`since ${formatDate(payload.firstMetAt)}`);
  }
  summaryParts.push(`${payload.milestones.length} milestones`);
  return {
    hasHistory: latest !== null || pastRows.length > 0 || payload.milestones.length > 0,
    summaryLabel: summaryParts.join(' | '),
    latest,
    pastRows,
    milestoneRows: [...payload.milestones]
      .sort((left, right) => right.occurredAt - left.occurredAt)
      .map((milestone) => ({
        id: milestone.id,
        label: milestone.label,
        dateLabel: formatDate(milestone.occurredAt),
      })),
  };
}
