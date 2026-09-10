// Per-turn record of what actually happened, kept across turns.
//
// The persisted chat history stores only { role, content } for each turn, and
// condenseConversationHistory then drops every tool message before the model
// sees it. So on turn N+1 the model has no record of which tools ran on turn N,
// which files or apps they touched, or what Aoi offered -- "그거 다시 해줘" can
// only resolve against the prose Aoi happened to write. This module keeps a
// compact structured record per turn and renders the recent ones as a system
// block, so references like 그거 / 아까 / 다시 / "the same one" have something to
// point at.
//
// Everything here is derived from what the runtime did, never from what the
// model claimed: tool outcomes come from the real tool messages, entities from
// real tool arguments, and offers from the text Aoi actually sent.

import type { ChatMessage } from './llmClient';
import { classifyAoiToolResult } from './aoiToolResultOutcome';

export type AoiTurnKind =
  | 'question'
  | 'action_request'
  | 'confirmation'
  | 'rejection_or_correction'
  | 'chitchat'
  | 'meta'
  | 'unknown';

export const AOI_TURN_KINDS: readonly AoiTurnKind[] = [
  'question',
  'action_request',
  'confirmation',
  'rejection_or_correction',
  'chitchat',
  'meta',
  'unknown',
];

export type AoiCapabilityFamily =
  | 'app'
  | 'file'
  | 'command'
  | 'browser'
  | 'host'
  | 'ida'
  | 'ghidra'
  | 'research'
  | 'memory'
  | 'image'
  | 'none';

export const AOI_CAPABILITY_FAMILIES: readonly AoiCapabilityFamily[] = [
  'app',
  'file',
  'command',
  'browser',
  'host',
  'ida',
  'ghidra',
  'research',
  'memory',
  'image',
  'none',
];

// Families whose tools change something outside the conversation. A low-confidence
// request that lands here is worth one question; a read-only one is not.
export const AOI_SIDE_EFFECT_FAMILIES: ReadonlySet<AoiCapabilityFamily> = new Set([
  'app',
  'file',
  'command',
  'browser',
  'host',
  'ida',
  'ghidra',
]);

export type AoiTurnToolOutcome = 'ok' | 'error' | 'unknown';

export interface AoiTurnToolRecord {
  name: string;
  args: string;
  outcome: AoiTurnToolOutcome;
}

export type AoiTurnOutcome = 'delivered' | 'failed' | 'clarification_asked';

export interface AoiTurnRecord {
  version: 1;
  id: string;
  turnIndex: number;
  createdAt: number;
  userMessage: string;
  assistantMessage: string;
  route: 'dialog' | 'main';
  routeReason: string;
  kind: AoiTurnKind;
  families: AoiCapabilityFamily[];
  tools: AoiTurnToolRecord[];
  entities: string[];
  offers: string[];
  openQuestion: string | null;
  outcome: AoiTurnOutcome;
}

export interface AoiTurnRecordsData {
  version: 1;
  savedAt: number;
  turns: AoiTurnRecord[];
}

const API_PATH = '/api/session-data';
const RECORDS_DIR_NAME = 'aoi-turn-records';
const RECORDS_FILE_NAME = 'turns.json';

export const MAX_AOI_TURN_RECORDS = 40;
export const DEFAULT_RECENT_TURNS_IN_PROMPT = 6;
export const DEFAULT_RECENT_TURNS_PROMPT_CHARS = 2400;

const MAX_MESSAGE_CHARS = 240;
const MAX_TOOL_ARGS_CHARS = 80;
const MAX_TOOLS_PER_TURN = 12;
const MAX_ENTITIES_PER_TURN = 12;
const MAX_ENTITY_CHARS = 80;
const MAX_OFFERS_PER_TURN = 4;
const MAX_OFFER_CHARS = 100;
const MAX_OPEN_QUESTION_CHARS = 140;
const PROMPT_LINE_MESSAGE_CHARS = 100;
const PROMPT_LINE_MAX_TOOLS = 6;
// The extraction regexes are run on raw text; past this many characters nothing
// is a usable referent, and an unbounded single-line blob (a base64 image, a
// tool dump) made the path-shaped pattern quadratic on the UI thread.
const MAX_EXTRACTION_INPUT_CHARS = 4000;

function boundForExtraction(value: string): string {
  return value.length > MAX_EXTRACTION_INPUT_CHARS
    ? value.slice(0, MAX_EXTRACTION_INPUT_CHARS)
    : value;
}
const PROMPT_LINE_ARGS_CHARS = 60;

// Tools that are the turn's plumbing rather than something the user asked for.
// Recording them would tell the next turn nothing it can act on.
const NON_ACTION_TOOL_NAMES = new Set([
  'respond_to_user',
  'finish_target',
  'understand_turn',
  'request_capabilities',
  'resolve_music_intent',
]);

// Argument keys whose values name the thing the tool acted on. Listed in the
// order they should appear when several are present.
const SALIENT_ARG_KEYS = [
  'path',
  'file_path',
  'directory',
  'app_name',
  'app_id',
  'action_type',
  'intent',
  'query',
  'url',
  'command',
  'symbol',
  'name',
  'process_name',
  'pid',
  'title',
  'binary',
  'function',
  'address',
  'artifact',
  'run_id',
  'content',
];

function truncateSingleLine(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function apiUrl(sessionPath: string, file: string): string {
  return `${API_PATH}?path=${encodeURIComponent(`${sessionPath}/${RECORDS_DIR_NAME}/${file}`)}`;
}

function dedupeStrings(values: string[], maxItems: number, maxChars: number): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of values) {
    const value = truncateSingleLine(raw, maxChars);
    if (!value) {
      continue;
    }
    const key = value.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(value);
    if (result.length >= maxItems) {
      break;
    }
  }
  return result;
}

/**
 * Compress a tool's JSON arguments into the values that name its target.
 *
 * `{"path":"src/a.ts","content":"..."}` becomes `path=src/a.ts`; content-like
 * values are cut hard because they are payload, not identity. Unparseable or
 * empty arguments fall back to a trimmed slice of the raw string.
 */
export function summarizeAoiToolArgs(rawArgs: string | undefined): string {
  const raw = (rawArgs ?? '').trim();
  if (!raw || raw === '{}') {
    return '';
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return truncateSingleLine(raw, MAX_TOOL_ARGS_CHARS);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return truncateSingleLine(raw, MAX_TOOL_ARGS_CHARS);
  }
  const record = parsed as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of SALIENT_ARG_KEYS) {
    const value = record[key];
    if (value === undefined || value === null || value === '') {
      continue;
    }
    const text = typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
    if (!text) {
      continue;
    }
    const limit = key === 'content' ? 24 : 48;
    parts.push(`${key}=${truncateSingleLine(text, limit)}`);
    if (parts.length >= 3) {
      break;
    }
  }
  if (parts.length === 0) {
    return truncateSingleLine(raw, MAX_TOOL_ARGS_CHARS);
  }
  return truncateSingleLine(parts.join(', '), MAX_TOOL_ARGS_CHARS);
}

/**
 * Read the tool calls a turn actually made, with their real outcomes, out of the
 * final message array.
 *
 * Each assistant `tool_calls` entry is paired with the `tool` message carrying
 * the same id, and the outcome is classified from that message's content. A
 * call with no result message is `unknown` -- the loop was interrupted before it
 * ran -- and is kept, because "was attempted" is still information.
 */
export function deriveAoiTurnToolRecords(messages: ChatMessage[]): AoiTurnToolRecord[] {
  const resultsById = new Map<string, string>();
  for (const message of messages) {
    if (message.role === 'tool' && message.tool_call_id) {
      resultsById.set(message.tool_call_id, message.content);
    }
  }
  const records: AoiTurnToolRecord[] = [];
  for (const message of messages) {
    if (message.role !== 'assistant' || !message.tool_calls?.length) {
      continue;
    }
    for (const call of message.tool_calls) {
      const name = call.function?.name?.trim();
      if (!name || NON_ACTION_TOOL_NAMES.has(name)) {
        continue;
      }
      const result = resultsById.get(call.id);
      let outcome: AoiTurnToolOutcome = 'unknown';
      if (result !== undefined) {
        outcome = classifyAoiToolResult(result).failed ? 'error' : 'ok';
      }
      records.push({ name, args: summarizeAoiToolArgs(call.function.arguments), outcome });
      if (records.length >= MAX_TOOLS_PER_TURN) {
        return records;
      }
    }
  }
  return records;
}

const URL_PATTERN = /https?:\/\/[^\s"'<>)\]]+/g;
// A path needs a separator or a file extension to count; a bare word with a dot
// ("e.g.") does not. Windows drive paths are included.
const PATH_PATTERN =
  /(?:[A-Za-z]:\\|\.{1,2}[\\/]|~[\\/]|[\\/])?[\w.-]+(?:[\\/][\w.-]+)+(?:\.[A-Za-z0-9]{1,6})?|\b[\w-]+\.(?:tsx?|jsx?|mjs|cjs|json|ya?ml|md|txt|css|scss|html?|cpp|cc|hpp|h|c|py|rs|go|java|kt|cs|sys|dll|exe|bin|pdb|idb|i64|gpr|toml|ini|log|sql|sh|ps1|bat)\b/g;
const BACKTICK_PATTERN = /`([^`\n]{2,80})`/g;
const QUOTED_PATTERN = /["“「『]([^"”」』\n]{2,80})["”」』]/g;

function collectMatches(pattern: RegExp, text: string, group = 0): string[] {
  const found: string[] = [];
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null = pattern.exec(text);
  while (match) {
    const value = match[group];
    if (value) {
      found.push(value);
    }
    match = pattern.exec(text);
  }
  return found;
}

function entitiesFromToolArgs(tools: AoiTurnToolRecord[]): string[] {
  const values: string[] = [];
  for (const tool of tools) {
    if (!tool.args) {
      continue;
    }
    for (const part of tool.args.split(', ')) {
      const eq = part.indexOf('=');
      if (eq <= 0) {
        continue;
      }
      const key = part.slice(0, eq);
      const value = part.slice(eq + 1).trim();
      if (key === 'content' || !value || value.endsWith('...')) {
        continue;
      }
      values.push(value);
    }
  }
  return values;
}

/**
 * The things this turn was about: paths, URLs, quoted or backticked names, and
 * whatever the tools were pointed at. Deterministic extraction only -- an entity
 * has to appear verbatim in the turn to be listed.
 */
export function extractAoiTurnEntities(input: {
  userMessage: string;
  assistantMessage: string;
  tools: AoiTurnToolRecord[];
}): string[] {
  const text = `${boundForExtraction(input.userMessage)}\n${boundForExtraction(input.assistantMessage)}`;
  const candidates = [
    ...entitiesFromToolArgs(input.tools),
    ...collectMatches(URL_PATTERN, text),
    ...collectMatches(BACKTICK_PATTERN, text, 1),
    ...collectMatches(QUOTED_PATTERN, text, 1),
    ...collectMatches(PATH_PATTERN, text),
  ].filter((value) => {
    const trimmed = value.trim();
    // Reject pure numbers and single characters; they are not references.
    return trimmed.length >= 2 && !/^\d+(?:\.\d+)?$/.test(trimmed);
  });
  return dedupeStrings(candidates, MAX_ENTITIES_PER_TURN, MAX_ENTITY_CHARS);
}

const KO_OFFER_SENTENCE_PATTERN =
  // Volitional 래 endings only (들을래, 볼래, 갈래): a bare "[가-힣]+래" also caught
  // 노래 and 그래, which then displaced real offers from the capped list.
  /[^.!?\n]*(?:줄까|할까|볼까|드릴까|어때|[가-힣]*[을볼할갈줄]래|괜찮을까|해도 될까|원해|필요해)\??/g;
const EN_OFFER_SENTENCE_PATTERN =
  /[^.!?\n]*\b(?:shall i|should i|want me to|do you want|would you like|can i)\b[^.!?\n]*\?/gi;

/**
 * What Aoi put on the table this turn: the reply chips, plus any sentence in the
 * message that is an offer or a question the user can say yes to.
 */
export function extractAoiAssistantOffers(
  assistantMessage: string,
  suggestedReplies: readonly string[] = [],
): string[] {
  const bounded = boundForExtraction(assistantMessage);
  const sentences = [
    ...collectMatches(KO_OFFER_SENTENCE_PATTERN, bounded),
    ...collectMatches(EN_OFFER_SENTENCE_PATTERN, bounded),
  ].filter((sentence) => sentence.trim().length >= 4);
  return dedupeStrings([...suggestedReplies, ...sentences], MAX_OFFERS_PER_TURN, MAX_OFFER_CHARS);
}

/**
 * The question the turn left open, if it ended on one. A reply that ends with a
 * question is what a bare "응" on the next turn is answering.
 */
export function extractAoiOpenQuestion(assistantMessage: string): string | null {
  const normalized = boundForExtraction(assistantMessage).replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return null;
  }
  const sentences = normalized.split(/(?<=[.!?])\s+/u).filter(Boolean);
  const last = sentences[sentences.length - 1] ?? '';
  if (!/\?\s*$/.test(last)) {
    return null;
  }
  return truncateSingleLine(last, MAX_OPEN_QUESTION_CHARS);
}

export function nextAoiTurnIndex(records: readonly AoiTurnRecord[]): number {
  let max = 0;
  for (const record of records) {
    if (record.turnIndex > max) {
      max = record.turnIndex;
    }
  }
  return max + 1;
}

export function createAoiTurnRecord(params: {
  id: string;
  turnIndex: number;
  userMessage: string;
  assistantMessage: string;
  route: 'dialog' | 'main';
  routeReason: string;
  kind: AoiTurnKind;
  families: readonly AoiCapabilityFamily[];
  messages: ChatMessage[];
  suggestedReplies?: readonly string[];
  outcome: AoiTurnOutcome;
  openQuestion?: string | null;
  createdAt?: number;
}): AoiTurnRecord {
  const tools = deriveAoiTurnToolRecords(params.messages);
  const userMessage = truncateSingleLine(params.userMessage, MAX_MESSAGE_CHARS);
  const assistantMessage = truncateSingleLine(params.assistantMessage, MAX_MESSAGE_CHARS);
  const explicitQuestion =
    typeof params.openQuestion === 'string' && params.openQuestion.trim()
      ? truncateSingleLine(params.openQuestion, MAX_OPEN_QUESTION_CHARS)
      : null;
  return {
    version: 1,
    id: params.id,
    turnIndex: params.turnIndex,
    createdAt: params.createdAt ?? Date.now(),
    userMessage,
    assistantMessage,
    route: params.route,
    routeReason: truncateSingleLine(params.routeReason, 120),
    kind: params.kind,
    families: [...new Set(params.families)],
    tools,
    entities: extractAoiTurnEntities({
      userMessage: params.userMessage,
      assistantMessage: params.assistantMessage,
      tools,
    }),
    offers: extractAoiAssistantOffers(params.assistantMessage, params.suggestedReplies ?? []),
    openQuestion: explicitQuestion ?? extractAoiOpenQuestion(params.assistantMessage),
    outcome: params.outcome,
  };
}

/**
 * Reconcile the persisted list with records appended before the load resolved.
 * The loaded records keep their indices; the in-memory ones are rebased after
 * them in their original order, so nothing that already happened this session
 * is lost and nothing persisted is overwritten by a shorter list.
 */
export function mergeAoiTurnRecords(
  loaded: readonly AoiTurnRecord[],
  inMemory: readonly AoiTurnRecord[],
): AoiTurnRecord[] {
  if (inMemory.length === 0) {
    return [...loaded]
      .sort((left, right) => left.turnIndex - right.turnIndex)
      .slice(-MAX_AOI_TURN_RECORDS);
  }
  let merged = [...loaded].sort((left, right) => left.turnIndex - right.turnIndex);
  const loadedIds = new Set(loaded.map((record) => record.id));
  for (const record of [...inMemory].sort((left, right) => left.turnIndex - right.turnIndex)) {
    if (loadedIds.has(record.id)) {
      continue;
    }
    merged = appendAoiTurnRecord(merged, { ...record, turnIndex: nextAoiTurnIndex(merged) });
  }
  return merged;
}

export function appendAoiTurnRecord(
  records: readonly AoiTurnRecord[],
  record: AoiTurnRecord,
): AoiTurnRecord[] {
  const withoutSame = records.filter((entry) => entry.id !== record.id);
  return [...withoutSame, record]
    .sort((left, right) => left.turnIndex - right.turnIndex)
    .slice(-MAX_AOI_TURN_RECORDS);
}

function formatRelativeAge(createdAt: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - createdAt) / 1000));
  if (seconds < 60) {
    return 'just now';
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return `${hours}h ago`;
  }
  return `${Math.round(hours / 24)}d ago`;
}

function formatTurnLine(record: AoiTurnRecord, position: number, now: number): string {
  const parts: string[] = [];
  parts.push(
    `- T-${position} (${formatRelativeAge(record.createdAt, now)}) [${record.route}] user: ${JSON.stringify(
      truncateSingleLine(record.userMessage, PROMPT_LINE_MESSAGE_CHARS),
    )}`,
  );
  if (record.tools.length > 0) {
    const shown = record.tools.slice(0, PROMPT_LINE_MAX_TOOLS);
    const tools = shown
      .map((tool) => {
        const args = tool.args ? `(${truncateSingleLine(tool.args, PROMPT_LINE_ARGS_CHARS)})` : '';
        return `${tool.name}${args} ${tool.outcome}`;
      })
      .join('; ');
    const more = record.tools.length - shown.length;
    parts.push(`tools: ${tools}${more > 0 ? `; +${more} more` : ''}`);
  } else {
    parts.push('no tools');
  }
  if (record.outcome === 'clarification_asked') {
    parts.push(`Aoi asked: ${JSON.stringify(record.openQuestion ?? record.assistantMessage)}`);
  } else if (record.outcome === 'failed') {
    parts.push(`turn failed: ${JSON.stringify(truncateSingleLine(record.assistantMessage, 80))}`);
  } else if (record.assistantMessage) {
    parts.push(
      `reply: ${JSON.stringify(truncateSingleLine(record.assistantMessage, PROMPT_LINE_MESSAGE_CHARS))}`,
    );
  }
  if (record.entities.length > 0) {
    parts.push(`refs: ${record.entities.slice(0, 6).join(', ')}`);
  }
  if (record.offers.length > 0) {
    parts.push(
      `offered: ${record.offers
        .slice(0, 3)
        .map((offer) => JSON.stringify(offer))
        .join(', ')}`,
    );
  }
  if (record.outcome !== 'clarification_asked' && record.openQuestion) {
    parts.push(`open question: ${JSON.stringify(record.openQuestion)}`);
  }
  return parts.join(' | ');
}

/**
 * The recent turns as a system block. Oldest first so the newest reads last;
 * T-1 is always the previous turn. Older lines are dropped first when the block
 * would exceed the character budget.
 */
export function buildAoiRecentTurnsPromptBlock(
  records: readonly AoiTurnRecord[],
  options: { maxTurns?: number; maxChars?: number; now?: number } = {},
): string {
  const maxTurns = options.maxTurns ?? DEFAULT_RECENT_TURNS_IN_PROMPT;
  const maxChars = options.maxChars ?? DEFAULT_RECENT_TURNS_PROMPT_CHARS;
  const now = options.now ?? Date.now();
  const recent = [...records]
    .sort((left, right) => left.turnIndex - right.turnIndex)
    .slice(-maxTurns);
  if (recent.length === 0) {
    return '';
  }
  const header = [
    '',
    '',
    'Recent turns (what actually happened; T-1 is the previous turn, oldest first).',
    'Resolve references such as 그거 / 아까 / 다시 / 그 파일 / "it" / "the same one" against these before answering. A tool listed here ran for real; a reply quoted here is what the user saw.',
  ].join('\n');
  let lines = recent.map((record, index) => formatTurnLine(record, recent.length - index, now));
  let body = lines.join('\n');
  while (lines.length > 1 && header.length + 1 + body.length > maxChars) {
    lines = lines.slice(1);
    body = lines.join('\n');
  }
  if (header.length + 1 + body.length > maxChars) {
    body = truncateSingleLine(body, Math.max(80, maxChars - header.length - 1));
  }
  return `${header}\n${body}`;
}

export function isAoiTurnRecord(value: unknown): value is AoiTurnRecord {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Partial<AoiTurnRecord>;
  return (
    record.version === 1 &&
    typeof record.id === 'string' &&
    typeof record.turnIndex === 'number' &&
    typeof record.createdAt === 'number' &&
    typeof record.userMessage === 'string' &&
    typeof record.assistantMessage === 'string' &&
    (record.route === 'dialog' || record.route === 'main') &&
    typeof record.routeReason === 'string' &&
    AOI_TURN_KINDS.includes(record.kind as AoiTurnKind) &&
    Array.isArray(record.families) &&
    Array.isArray(record.tools) &&
    Array.isArray(record.entities) &&
    Array.isArray(record.offers) &&
    (record.outcome === 'delivered' ||
      record.outcome === 'failed' ||
      record.outcome === 'clarification_asked')
  );
}

export async function loadAoiTurnRecords(sessionPath: string): Promise<AoiTurnRecord[]> {
  try {
    const res = await fetch(apiUrl(sessionPath, RECORDS_FILE_NAME));
    if (!res.ok) {
      return [];
    }
    const data = (await res.json()) as Partial<AoiTurnRecordsData>;
    if (data.version !== 1 || !Array.isArray(data.turns)) {
      return [];
    }
    return data.turns
      .filter(isAoiTurnRecord)
      .sort((left, right) => left.turnIndex - right.turnIndex)
      .slice(-MAX_AOI_TURN_RECORDS);
  } catch {
    return [];
  }
}

export async function saveAoiTurnRecords(
  sessionPath: string,
  records: readonly AoiTurnRecord[],
): Promise<void> {
  const data: AoiTurnRecordsData = {
    version: 1,
    savedAt: Date.now(),
    turns: records.slice(-MAX_AOI_TURN_RECORDS),
  };
  const res = await fetch(apiUrl(sessionPath, RECORDS_FILE_NAME), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    throw new Error(`Aoi turn records save failed with ${res.status}`);
  }
}

// ---------------------------------------------------------------------------
// Direct actions: turns the runtime handled without a model call
// ---------------------------------------------------------------------------

// Labels look like "direct:play_music" or "classified:play_music:search": a
// source tag, the action, then any detail. The tag is bookkeeping for the
// memory episode; the record keeps the action and the detail.
export function parseAoiDirectToolCallLabel(label: string): AoiTurnToolRecord {
  const segments = label
    .split(':')
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.length === 0) {
    return { name: 'direct_action', args: '', outcome: 'ok' };
  }
  if (segments.length === 1) {
    return { name: segments[0], args: '', outcome: 'ok' };
  }
  return {
    name: segments[1],
    args: truncateSingleLine(segments.slice(2).join(':'), MAX_TOOL_ARGS_CHARS),
    outcome: 'ok',
  };
}

const DIRECT_APP_ACTION_PATTERN = /(music|play|youtube|app|open|search)/i;

/**
 * The record for a turn that a direct-action path (chip, music parser, music
 * classifier) answered in code. These turns never reach runConversation, so
 * without this the next turn would see a gap where the song was played.
 */
export function createAoiDirectActionTurnRecord(params: {
  id: string;
  turnIndex: number;
  userMessage: string;
  assistantMessage: string;
  toolCallLabels: readonly string[];
  createdAt?: number;
}): AoiTurnRecord {
  const tools = params.toolCallLabels
    .filter((label) => label.trim().length > 0)
    .slice(0, MAX_TOOLS_PER_TURN)
    .map(parseAoiDirectToolCallLabel);
  const isAppAction = tools.some((tool) => DIRECT_APP_ACTION_PATTERN.test(tool.name));
  const userMessage = truncateSingleLine(params.userMessage, MAX_MESSAGE_CHARS);
  const assistantMessage = truncateSingleLine(params.assistantMessage, MAX_MESSAGE_CHARS);
  return {
    version: 1,
    id: params.id,
    turnIndex: params.turnIndex,
    createdAt: params.createdAt ?? Date.now(),
    userMessage,
    assistantMessage,
    route: 'main',
    routeReason: `direct action: ${tools.map((tool) => tool.name).join(',') || 'none'}`,
    kind: isAppAction ? 'action_request' : 'chitchat',
    families: isAppAction ? ['app'] : ['none'],
    tools,
    entities: extractAoiTurnEntities({
      userMessage: params.userMessage,
      assistantMessage: params.assistantMessage,
      tools,
    }),
    offers: extractAoiAssistantOffers(params.assistantMessage, []),
    openQuestion: extractAoiOpenQuestion(params.assistantMessage),
    outcome: 'delivered',
  };
}
