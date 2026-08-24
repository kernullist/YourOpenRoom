// Phase 1: the model reads the INTENT, code still owns the action.
//
// The regex tower in chatDirectActions covers the phrasings we thought of, and
// every phrasing it misses used to reach the LLM as prose -- which is how a
// confirmed playback request turned into "다음 턴에 틀어줄게". Korean has more
// ways to say "play that one" than a pattern list can hold, so understanding
// belongs to a model.
//
// What must NOT move to the model is the part that was actually lying: reporting
// what happened. So this classifier does one narrow job -- turn the user's words
// into a typed slot -- and never speaks to the user, never claims an action, and
// never invents a search string:
//
//   * It picks an id out of a list of picks CODE extracted from the transcript,
//     so a wrong answer is at worst the wrong pick from the conversation.
//   * A free-form query is accepted only when every word of it already appears
//     in the conversation or in the user's own message (isGroundedQuery), so an
//     invented title cannot reach YouTube.
//   * The caller dispatches, checks the dispatch result, and writes the ack.
//
// Design note: this is a separate, tiny request rather than a slot on the main
// turn, because the routing decision (which tools, which model) has to be made
// BEFORE the main call, and the whole point is to stop guessing that from
// keywords.

import type { ChatMessage, ToolDef } from './llmClient';
import type { LLMConfig } from './llmModels';
import { chat } from './llmClient';
import type { MusicPickCandidate } from './chatDirectActions';

export type MusicIntentAction = 'play_candidate' | 'search' | 'reject_and_repick' | 'none';

export interface MusicIntentClassification {
  action: MusicIntentAction;
  // Present for play_candidate (the chosen candidate's exact query) and for
  // search (a grounded query). Absent for reject_and_repick / none.
  query?: string;
  exclude?: string[];
  confidence: 'high' | 'low';
}

export const MUSIC_INTENT_TOOL_NAME = 'resolve_music_intent';

// Small on purpose: a bigger budget only buys the model room to explain itself,
// and its prose is never shown to anyone.
export const MUSIC_INTENT_CONTEXT_CHARS = 320;
const MAX_EXCLUDE_TERMS = 4;
const MAX_QUERY_CHARS = 120;
// Above this the message is saying more than "play this", and a one-slot answer
// would be a summary rather than a classification. Those turns belong to the
// normal conversation path.
const MAX_CLASSIFIABLE_CHARS = 80;

export function getMusicIntentToolDefinition(): ToolDef {
  return {
    type: 'function',
    function: {
      name: MUSIC_INTENT_TOOL_NAME,
      description:
        'Report what the user wants done about music. Choose a candidate id when they mean a pick that was already offered.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['play_candidate', 'search', 'reject_and_repick', 'none'],
            description:
              'play_candidate: they mean one of the numbered candidates. search: they named something else to play. reject_and_repick: they refused the candidates and want a different pick. none: this message is not a request to play music.',
          },
          candidate_id: {
            type: 'integer',
            description: 'Required for play_candidate. Must be one of the listed ids.',
          },
          query: {
            type: 'string',
            description:
              'Required for search. Copy the words from the conversation or the user message; never invent a title.',
          },
          exclude: {
            type: 'array',
            items: { type: 'string' },
            description: 'Picks the user explicitly refused, if any.',
          },
          confidence: {
            type: 'string',
            enum: ['high', 'low'],
            description: 'low when the message is ambiguous about what to play.',
          },
        },
        required: ['action', 'confidence'],
      },
    },
  };
}

/**
 * Whether this turn is worth one classifier call.
 *
 * Deliberately NOT keyword-based -- keyword gating is the thing that failed. The
 * gate is structural: Aoi has a pick on the table, and the reply is short enough
 * to be an answer about it rather than a new topic. A message that is neither
 * still reaches the normal path with app_action attached.
 */
export function shouldClassifyMusicIntent(
  text: string,
  candidates: readonly MusicPickCandidate[],
): boolean {
  const trimmed = text.trim();
  if (!trimmed || candidates.length === 0) {
    return false;
  }
  return trimmed.length <= MAX_CLASSIFIABLE_CHARS;
}

function truncate(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit)}...`;
}

export function buildMusicIntentMessages(
  text: string,
  candidates: readonly MusicPickCandidate[],
): ChatMessage[] {
  const candidateLines = candidates
    .map((candidate) => `${candidate.id}. ${candidate.query}`)
    .join('\n');
  // One context excerpt per distinct source message, so the model can see the
  // pick named in the script the user is reading -- the card says 에스파 while the
  // query can say エスパ.
  const contexts = [...new Set(candidates.map((candidate) => candidate.context))]
    .map((context) => `- ${truncate(context, MUSIC_INTENT_CONTEXT_CHARS)}`)
    .join('\n');

  return [
    {
      role: 'system',
      content: [
        'You classify one user message about music playback. You are not talking to the user.',
        `Answer only by calling ${MUSIC_INTENT_TOOL_NAME}. Never write prose.`,
        'Prefer play_candidate with a candidate_id whenever the user means a pick that was already offered, including when they name only the artist, only the title, or just agree ("응", "맞아", "그거").',
        'Use search only when they named something that is NOT in the candidate list, and copy their words verbatim.',
        'Use reject_and_repick when they refused the candidates and want something else instead.',
        'Use none when the message is not about playing music at all.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        'Candidates Aoi already offered:',
        candidateLines,
        '',
        'What Aoi said (excerpt):',
        contexts,
        '',
        `User message: ${truncate(text, MAX_QUERY_CHARS)}`,
      ].join('\n'),
    },
  ];
}

function normalizeForGrounding(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ');
}

/**
 * True when every word of a free-form query already appears in the conversation
 * or the user's own message.
 *
 * This is the guard that keeps "the model understands the request" from becoming
 * "the model writes the search string". An invented title fails it and the turn
 * falls through to the normal path instead of searching a hallucination.
 */
export function isGroundedQuery(
  query: string,
  text: string,
  candidates: readonly MusicPickCandidate[],
): boolean {
  const words = normalizeForGrounding(query).split(/\s+/u).filter(Boolean);
  if (words.length === 0) {
    return false;
  }
  const haystack = normalizeForGrounding(
    [text, ...candidates.map((candidate) => `${candidate.query} ${candidate.context}`)].join(' '),
  );
  return words.every((word) => haystack.includes(word));
}

interface RawMusicIntent {
  action?: unknown;
  candidate_id?: unknown;
  query?: unknown;
  exclude?: unknown;
  confidence?: unknown;
}

function cleanExclude(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const terms: string[] = [];
  for (const item of raw) {
    const term = typeof item === 'string' ? item.trim() : '';
    if (term.length >= 2 && !terms.includes(term)) {
      terms.push(term);
    }
    if (terms.length >= MAX_EXCLUDE_TERMS) {
      break;
    }
  }
  return terms;
}

/**
 * Validate a classifier answer into something safe to dispatch, or null.
 *
 * Null is always an acceptable outcome: the caller then behaves exactly as it did
 * before the classifier existed. Every rejection here is a case where acting
 * would mean trusting a value the model was not entitled to produce.
 */
export function parseMusicIntentToolCall(
  raw: unknown,
  text: string,
  candidates: readonly MusicPickCandidate[],
): MusicIntentClassification | null {
  const parsed = (raw ?? {}) as RawMusicIntent;
  const action = parsed.action;
  const confidence = parsed.confidence === 'low' ? 'low' : 'high';
  const exclude = cleanExclude(parsed.exclude);

  if (action === 'none') {
    return { action: 'none', confidence };
  }
  if (action === 'reject_and_repick') {
    return { action: 'reject_and_repick', confidence, ...(exclude.length ? { exclude } : {}) };
  }
  if (action === 'play_candidate') {
    // The id has to name a candidate WE extracted. Anything else -- an index the
    // model counted wrong, an id it invented -- is not a pick from this
    // conversation and must not be played.
    const id = typeof parsed.candidate_id === 'number' ? parsed.candidate_id : Number.NaN;
    const candidate = candidates.find((entry) => entry.id === id);
    if (!candidate) {
      return null;
    }
    return {
      action: 'play_candidate',
      query: candidate.query,
      confidence,
      ...(exclude.length ? { exclude } : {}),
    };
  }
  if (action === 'search') {
    const query = typeof parsed.query === 'string' ? parsed.query.trim() : '';
    if (!query || query.length > MAX_QUERY_CHARS || !isGroundedQuery(query, text, candidates)) {
      return null;
    }
    return { action: 'search', query, confidence, ...(exclude.length ? { exclude } : {}) };
  }
  return null;
}

/**
 * Run the classifier for one turn. Returns null on anything unusual -- no
 * candidates, a provider error, a refused tool call, a value that failed
 * validation -- so the caller's existing behaviour is always the fallback.
 */
export async function classifyMusicIntent(
  text: string,
  candidates: readonly MusicPickCandidate[],
  config: LLMConfig,
  options: { signal?: AbortSignal } = {},
): Promise<MusicIntentClassification | null> {
  if (!shouldClassifyMusicIntent(text, candidates)) {
    return null;
  }
  try {
    const response = await chat(
      buildMusicIntentMessages(text, candidates),
      [getMusicIntentToolDefinition()],
      config,
      { signal: options.signal },
    );
    const call = response.toolCalls.find((entry) => entry.function.name === MUSIC_INTENT_TOOL_NAME);
    if (!call) {
      return null;
    }
    let args: unknown = {};
    try {
      args = JSON.parse(call.function.arguments) as unknown;
    } catch {
      return null;
    }
    return parseMusicIntentToolCall(args, text, candidates);
  } catch {
    // A classifier outage must never break the turn.
    return null;
  }
}
