import type {
  AoiProactiveBriefFeedbackCategory,
  AoiProactiveTrendOpinionCard,
} from './aoiAutonomyTypes';

export interface AoiProactiveTrendFollowUpContext {
  version: 1;
  prompt: string;
  cardId: string;
  snapshotId: string;
  candidateId?: string;
  topicId: string;
  topicLabel: string;
  title: string;
  myTake: string;
  suggestedNextAction: string;
  sourceHosts: string[];
  evidenceRefs: string[];
  createdAt: number;
}

function sanitizeText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') {
    return '';
  }
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function sanitizeList(values: readonly string[], maxItems: number, maxLength: number): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const item = sanitizeText(value, maxLength);
    const key = item.toLowerCase();
    if (!item || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(item);
    if (result.length >= maxItems) {
      break;
    }
  }
  return result;
}

export function buildAoiProactiveTrendFollowUpContext(
  card: AoiProactiveTrendOpinionCard,
  prompt: string,
  now = Date.now(),
): AoiProactiveTrendFollowUpContext | null {
  const safePrompt = sanitizeText(prompt, 240);
  if (!safePrompt) {
    return null;
  }

  return {
    version: 1,
    prompt: safePrompt,
    cardId: sanitizeText(card.id, 120),
    snapshotId: sanitizeText(card.snapshotId, 120),
    ...(card.candidateId ? { candidateId: sanitizeText(card.candidateId, 120) } : {}),
    topicId: sanitizeText(card.topicId, 120),
    topicLabel: sanitizeText(card.topicLabel, 120) || 'Tracked interest',
    title: sanitizeText(card.title, 180) || 'Aoi proactive trend',
    myTake: sanitizeText(card.myTake, 360),
    suggestedNextAction: sanitizeText(card.suggestedNextAction, 240),
    sourceHosts: sanitizeList(card.sourceHosts, 6, 120),
    evidenceRefs: sanitizeList(card.evidenceRefs, 12, 180),
    createdAt: Number.isFinite(now) ? now : Date.now(),
  };
}

export function classifyAoiProactiveTrendFollowUpFeedback(
  prompt: string,
): AoiProactiveBriefFeedbackCategory {
  const normalized = sanitizeText(prompt, 240).toLowerCase();
  if (/(source|sources|evidence|url|link|open|host|출처|근거|링크|열어)/u.test(normalized)) {
    return 'open_sources';
  }
  return 'expand_summary';
}

export function buildAoiProactiveTrendFollowUpPromptBlock(
  context?: AoiProactiveTrendFollowUpContext | null,
): string {
  if (!context) {
    return '';
  }

  const sourceHosts = context.sourceHosts.join(', ') || 'No source host metadata saved.';
  const evidenceRefs = context.evidenceRefs.join(', ') || 'No evidence refs saved.';
  const candidate = context.candidateId ? `, candidate ${context.candidateId}` : '';

  return [
    'Aoi proactive trend follow-up context:',
    '- The latest user message was clicked from an Aoi proactive trend follow-up prompt.',
    `- Follow-up prompt: ${context.prompt}`,
    `- Trend: ${context.title}`,
    `- Topic: ${context.topicLabel} (${context.topicId})`,
    `- Snapshot: ${context.snapshotId}${candidate}`,
    `- Aoi take: ${context.myTake || 'No take saved.'}`,
    `- Suggested next action: ${context.suggestedNextAction || 'No next action saved.'}`,
    `- Source hosts: ${sourceHosts}`,
    `- Evidence refs: ${evidenceRefs}`,
    '- Use this trend as the primary subject unless the user clearly changes topics.',
    '- Do not claim that URLs or pages were opened unless a tool result in this turn confirms it.',
    '- If the user asks to open sources, use available URL/app tools or explain the saved source evidence.',
  ].join('\n');
}
