// P2.1: server-side proactive delivery channel (push, not pull).
//
// A direct_chat-eligible proactive card dies on disk unless the ChatPanel happens to be
// mounted. This is the SAFE decision core of an out-of-panel channel: it decides which cards
// may be emitted (to an OS / webhook / service-worker notifier that consumes the queue),
// reusing the SAME preconditions as in-panel direct chat -- an explicit push opt-in, the card's
// own direct_chat allowance, a not-high-risk gate, and the direct-chat daily budget. Fail-closed:
// any failing gate short-circuits to no emit. The emitted record is DISPLAY-ONLY (a title + a
// deep link into the conversation) -- it never carries an executable action.
//
// Pure/deterministic (the caller owns persistence + the notifier transport), so the gating is
// exhaustively unit-testable; nothing is emitted until a notifier is wired and the operator
// opts in.
import type { AoiAutonomyRisk } from './aoiAutonomyTypes';
import { redactAoiSensitiveContent, stripAoiSourceInstructions } from './aoiMemoryShared';

export type AoiProactivePushBlockReason =
  | 'push_not_opted_in'
  | 'not_direct_chat'
  | 'direct_chat_not_allowed'
  | 'high_risk'
  | 'daily_budget_exhausted';

// The minimal view of a proactive card the push decision needs (a trend opinion card or a
// curiosity opportunity both project onto this).
export interface AoiProactivePushCandidate {
  id: string;
  sessionPath: string;
  title: string;
  // The card's already-decided delivery mode + direct-chat allowance (from the trend advisor /
  // opportunity governor) -- the push decision only gates, it never re-decides delivery.
  deliveryMode: string;
  directChatAllowed: boolean;
  risk: AoiAutonomyRisk;
  // Stable ref used to build the deep link back into the conversation.
  deepLinkRef: string;
}

export interface AoiProactivePushDeliveryRecord {
  version: 1;
  id: string;
  sessionPath: string;
  title: string;
  deepLink: string;
  createdAt: number;
  actionAuthority: 'display_only';
  mutationCount: 0;
  consumedAt?: number;
}

export interface AoiProactivePushDecision {
  eligible: boolean;
  blockReasons: AoiProactivePushBlockReason[];
  // A display-only record when eligible; null on every fail-closed path.
  record: AoiProactivePushDeliveryRecord | null;
}

const MAX_TITLE_CHARS = 160;

function sanitizeTitle(value: string): string {
  return stripAoiSourceInstructions(
    redactAoiSensitiveContent(typeof value === 'string' ? value : ''),
  )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TITLE_CHARS);
}

// Build the deep link into the conversation. Refs are slug-sanitized so a hostile ref cannot
// break out of the link.
export function buildAoiProactivePushDeepLink(sessionPath: string, ref: string): string {
  const safeSession = String(sessionPath).replace(/[^a-zA-Z0-9/_-]/g, '');
  const safeRef = String(ref).replace(/[^a-zA-Z0-9._:-]/g, '');
  return `openroom://aoi/${safeSession}?card=${safeRef}`;
}

// Decide whether a card may be emitted through the out-of-panel push channel. Fail-closed:
// every gate must pass; the first failures are collected for observability.
export function decideAoiProactivePushDelivery(params: {
  candidate: AoiProactivePushCandidate;
  // Explicit operator opt-in to out-of-panel push. Default off -> nothing is ever emitted.
  pushOptIn: boolean;
  // The direct-chat daily budget verdict (checkAoiDirectChatBudget(...).allowed).
  budgetAllowed: boolean;
  now: number;
}): AoiProactivePushDecision {
  const blockReasons: AoiProactivePushBlockReason[] = [];
  if (!params.pushOptIn) {
    blockReasons.push('push_not_opted_in');
  }
  if (params.candidate.deliveryMode !== 'direct_chat') {
    blockReasons.push('not_direct_chat');
  }
  if (!params.candidate.directChatAllowed) {
    blockReasons.push('direct_chat_not_allowed');
  }
  if (params.candidate.risk === 'high') {
    blockReasons.push('high_risk');
  }
  if (!params.budgetAllowed) {
    blockReasons.push('daily_budget_exhausted');
  }
  if (blockReasons.length > 0) {
    return { eligible: false, blockReasons, record: null };
  }
  return {
    eligible: true,
    blockReasons: [],
    record: {
      version: 1,
      id: params.candidate.id,
      sessionPath: params.candidate.sessionPath,
      title: sanitizeTitle(params.candidate.title),
      deepLink: buildAoiProactivePushDeepLink(
        params.candidate.sessionPath,
        params.candidate.deepLinkRef,
      ),
      createdAt: params.now,
      actionAuthority: 'display_only',
      mutationCount: 0,
    },
  };
}

const MAX_QUEUE_RECORDS = 50;

// Append an eligible record to the pending-push queue, de-duplicated by id (a re-decided card
// refreshes its record rather than piling up) and capped (newest kept). Pure -- the caller
// persists the returned queue.
export function appendAoiProactivePushRecord(
  queue: readonly AoiProactivePushDeliveryRecord[],
  record: AoiProactivePushDeliveryRecord,
): AoiProactivePushDeliveryRecord[] {
  const withoutDuplicate = queue.filter((item) => item.id !== record.id);
  return [...withoutDuplicate, record].slice(-MAX_QUEUE_RECORDS);
}

// The records a notifier still has to emit (not yet marked consumed).
export function selectPendingAoiProactivePushRecords(
  queue: readonly AoiProactivePushDeliveryRecord[],
): AoiProactivePushDeliveryRecord[] {
  return queue.filter((record) => typeof record.consumedAt !== 'number');
}

// Mark a record consumed (the notifier emitted it) so it is not re-emitted.
export function markAoiProactivePushRecordConsumed(
  queue: readonly AoiProactivePushDeliveryRecord[],
  id: string,
  now: number,
): AoiProactivePushDeliveryRecord[] {
  return queue.map((record) =>
    record.id === id && typeof record.consumedAt !== 'number'
      ? { ...record, consumedAt: now }
      : record,
  );
}
