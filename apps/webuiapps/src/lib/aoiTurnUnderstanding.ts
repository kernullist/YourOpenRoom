// One small model call that reads the latest user message in the light of the
// recent turns: is it a request, a question, a yes, a no, or just talk; which
// capability families it needs; and what earlier thing it points at.
//
// This generalizes aoiMusicIntentClassifier, whose shape was measured to work:
// a structural gate rather than keywords, an answer that can only name things
// the runtime already has (turn numbers, strings that appear in the record),
// an explicit confidence, and null on anything unusual so the caller's
// pre-existing behaviour is always the fallback. Here the fallback is the regex
// router in chatTokenControl, which stays in place as layer 0; this call can pull
// a turn onto the main route and add tool families, never push one down.
//
// The classifier never talks to the user and never acts. What it returns is a
// typed reading of the message; the route, the tools, and any clarification
// question are decided by aoiTurnContext from that reading.

import type { ChatMessage, ToolDef } from './llmClient';
import type { LLMConfig } from './llmModels';
import { chat, shouldUseOpenAIResponses } from './llmClient';
import { getSupportedReasoningEfforts } from './llmModels';
import {
  resolveAoiActionConfirmationRequest,
  shouldEnableAppTools,
  shouldUseAoiResearchRun,
  shouldUseDialogModel,
  shouldUseWebSearch,
} from './chatTokenControl';
import { shouldEnableIdaSqlTools } from './aoiIdaSqlTools';
import { shouldEnableGhidraTools } from './aoiGhidraTools';
import {
  AOI_CAPABILITY_FAMILIES,
  AOI_TURN_KINDS,
  DEFAULT_RECENT_TURNS_IN_PROMPT,
  type AoiCapabilityFamily,
  type AoiTurnKind,
  type AoiTurnRecord,
} from './aoiTurnRecord';

export type AoiTurnConfidence = 'high' | 'medium' | 'low';

export type AoiTurnUnderstandingSource = 'classifier' | 'regex';

// How a playback request points at its song: by naming it (none), by the
// user's taste ("내가 좋아하는", "my favorite" -- taste), or by a pick Aoi already
// offered (offered_pick). Read by the classifier; acted on by aoiMusicPreference.
export type AoiMusicReference = 'none' | 'taste' | 'offered_pick';
export const AOI_MUSIC_REFERENCES: readonly AoiMusicReference[] = ['none', 'taste', 'offered_pick'];

export interface AoiTurnUnderstanding {
  kind: AoiTurnKind;
  families: AoiCapabilityFamily[];
  refersToTurn: number | null;
  referent: string | null;
  confidence: AoiTurnConfidence;
  needsClarification: string | null;
  clarificationOptions: string[];
  source: AoiTurnUnderstandingSource;
  // Playback requests only: the exact words the user used for a title or
  // artist (grounded in their message), and what the request points at.
  musicTarget: string | null;
  musicReference: AoiMusicReference | null;
  latencyMs?: number;
}

export const AOI_TURN_UNDERSTANDING_TOOL_NAME = 'understand_turn';

// Above this the message explains itself and the regex router already sends it
// to the main route; a one-slot reading would be a summary, not a classification.
export const MAX_AOI_TURN_CLASSIFIABLE_CHARS = 400;
// Same reasoning as the music classifier: reasoning tokens count against the
// cap, and at a small cap the call was cut off before the tool call every time.
const MAX_CLASSIFIER_OUTPUT_TOKENS = 2048;
// The turn does not wait forever on the classifier: past this the regex reading
// is used. Long enough for a reasoning model on a slow provider, short enough
// that a hung request does not read as a frozen app.
export const DEFAULT_AOI_TURN_CLASSIFIER_TIMEOUT_MS = 8000;
const MAX_CLARIFICATION_CHARS = 200;
const MAX_CLARIFICATION_OPTIONS = 3;
const MAX_CLARIFICATION_OPTION_CHARS = 40;
const MAX_REFERENT_CHARS = 120;
const MAX_MUSIC_TARGET_CHARS = 120;

const MAX_USER_MESSAGE_IN_PROMPT_CHARS = 400;
// Thinking is OFF for this call. Measured on qwen3.7-flash over the 164-case
// corpus (docs/aoi-turn-understanding-design.md 2.1): with the provider default
// (thinking on) p90 latency was 13.2 s and 36 of 157 readings exceeded the 8 s
// budget below, so about a quarter of turns silently fell back to the regex
// reading; with thinking off p90 was 1.4 s, nothing fell back, and routing
// accuracy was unchanged (92.7% -> 93.3%). The one measured loss is
// refers_to_turn on bare confirmations ("응", "그래"), which the runtime already
// covers by injecting the previous offer. 'low' was no middle ground (p90 15.4 s).
// This is the opposite of the music classifier's finding, and it was measured
// for this prompt, not carried over.
const CLASSIFIER_REASONING_EFFORT = 'none';

export function getAoiTurnUnderstandingToolDefinition(): ToolDef {
  return {
    type: 'function',
    function: {
      name: AOI_TURN_UNDERSTANDING_TOOL_NAME,
      description:
        'Report how to read the latest user message: what kind of turn it is, which capability families it needs, and what earlier turn it refers to.',
      parameters: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: AOI_TURN_KINDS.filter((kind) => kind !== 'unknown'),
            description:
              'action_request: the user wants something done. question: they want information or an explanation. confirmation: they accept an offer or answer yes to Aoi. rejection_or_correction: they refuse, or correct what Aoi did or understood. chitchat: social talk with nothing to do or answer. meta: about Aoi herself, her settings, or this conversation.',
          },
          families: {
            type: 'array',
            items: { type: 'string', enum: [...AOI_CAPABILITY_FAMILIES] },
            description:
              'Capability families the turn needs. app: in-room apps such as YouTube or notes. file: files and folders in the session or IDE workspace. command: build, test, commit, shell. browser: the real Chrome/Edge or a URL to open or read. host: programs and processes on the PC. ida / ghidra: binary analysis labs. research: web search or a cited report. memory: remember or forget. image: generate a picture. Use ["none"] when no tool is needed.',
          },
          refers_to_turn: {
            type: 'integer',
            description:
              'When the message points at something from the recent turns (그거, 아까, 다시, that one, the same file), the position of that turn as listed: 1 = T-1, the previous turn; 2 = T-2, the one before it. Omit otherwise.',
          },
          referent: {
            type: 'string',
            description:
              'The exact string from that turn the message refers to (a path, a title, a query, an app name). Copy it verbatim from the recent turns; never invent one.',
          },
          confidence: {
            type: 'string',
            enum: ['high', 'medium', 'low'],
            description:
              'high: kind and families are clear. medium: kind is clear but the target is not. low: you cannot tell what they want done.',
          },
          needs_clarification: {
            type: 'string',
            description:
              'Only when confidence is low AND the request would change something (file, app, command, browser, host, binary): one short question in the language of the user message. Omit otherwise.',
          },
          music_target: {
            type: 'string',
            description:
              'Playback requests only: the artist and/or title the user named, copied verbatim from the message and including the artist when they named one ("에스파 KISS N TELL"). Never the words that describe their taste (내가 좋아하는 노래, 자주 듣는, my favorite, the one I always play). Omit when they named neither an artist nor a title, or when the message is not about playing music.',
          },
          music_reference: {
            type: 'string',
            enum: [...AOI_MUSIC_REFERENCES],
            description:
              'Playback requests only. taste: they refer to what they like or usually listen to instead of naming a song (내가 좋아하는, 자주 듣는, my favorite, the one I always play), possibly with an artist in music_target. offered_pick: they mean a pick Aoi already offered. none: they named the song or artist themselves.',
          },
          clarification_options: {
            type: 'array',
            items: { type: 'string' },
            description:
              'With needs_clarification: two or three short answers the user could tap, under 40 characters each, in the same language.',
          },
        },
        required: ['kind', 'families', 'confidence'],
      },
    },
  };
}

/**
 * Whether this turn is worth one classifier call. Structural, not keyword-based:
 * the switch is on, there is text, it is short enough to be about one thing, and
 * there is no image (image turns are routed to the main model regardless).
 */
export function shouldClassifyAoiTurn(params: {
  text: string;
  hasAttachments: boolean;
  enabled: boolean;
}): boolean {
  if (!params.enabled || params.hasAttachments) {
    return false;
  }
  const trimmed = params.text.trim();
  if (!trimmed) {
    return false;
  }
  return trimmed.length <= MAX_AOI_TURN_CLASSIFIABLE_CHARS;
}

function truncate(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit)}...`;
}

export function countAoiTurnLines(recentTurnsBlock: string): number {
  return recentTurnsBlock.split('\n').filter((line) => line.startsWith('- T-')).length;
}

export function buildAoiTurnUnderstandingMessages(params: {
  text: string;
  recentTurnsBlock: string;
  records: readonly AoiTurnRecord[];
}): ChatMessage[] {
  const previous = params.records[params.records.length - 1] ?? null;
  const openQuestion = previous?.openQuestion ?? null;
  const offers = previous?.offers ?? [];
  // Count what the block actually shows: the budget can drop the oldest lines,
  // and the label must not name a T-n the model was never given.
  const shownTurns = countAoiTurnLines(params.recentTurnsBlock);
  return [
    {
      role: 'system',
      content: [
        "You classify ONE user chat message for Aoi's runtime. You are not talking to the user.",
        `Answer only by calling ${AOI_TURN_UNDERSTANDING_TOOL_NAME}. Never write prose.`,
        'Read the message together with the recent turns: a short reply like "응", "그거", "다시", "아니 그거 말고", "yes", "that one" is answered by what Aoi last asked or offered.',
        'Bare agreement right after Aoi offered or asked something is confirmation, not chitchat. A refusal or "not that, the other one" is rejection_or_correction.',
        'A request to do something again, or to do it to the thing from an earlier turn, is action_request with the same families as that earlier turn.',
        'For refers_to_turn use the T-number of the turn as listed (T-1 is the previous turn). For referent copy an exact string that appears in that turn; if nothing exact applies, omit referent.',
        'Ask for clarification only when the request would change something and you genuinely cannot tell what. Never ask about chitchat or a question.',
        'For a request to play music: music_target is the artist and/or title exactly as written, including the artist when named ("에스파 KISS N TELL 틀어줘" -> "에스파 KISS N TELL"; "에스파 내가 좋아하는 노래 틀어줘" -> "에스파"), and is omitted when neither an artist nor a title is named ("내가 자주 듣는 노래 틀어줘" -> no music_target). music_reference is taste when they point at what they like or usually listen to instead of naming a song, offered_pick when they mean something Aoi offered, none when they named the song.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        params.recentTurnsBlock.trim()
          ? params.recentTurnsBlock.trim()
          : 'Recent turns: (none, this is the first turn)',
        shownTurns > 0 ? `Turns listed: T-1 (previous) through T-${shownTurns}` : '',
        `Open question from Aoi: ${openQuestion ? JSON.stringify(openQuestion) : '(none)'}`,
        `Offers on the table: ${offers.length > 0 ? offers.map((offer) => JSON.stringify(offer)).join(', ') : '(none)'}`,
        '',
        `User message: ${JSON.stringify(truncate(params.text, MAX_USER_MESSAGE_IN_PROMPT_CHARS))}`,
      ]
        .filter((line) => line !== '')
        .join('\n'),
    },
  ];
}

function normalizeForGrounding(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * True when the referent appears, as a whole, somewhere the runtime has on
 * record: the user's own message or the recent turns. This is the guard that
 * keeps "the model understood the reference" from becoming "the model wrote the
 * reference".
 */
export function isGroundedAoiReferent(
  referent: string,
  text: string,
  records: readonly AoiTurnRecord[],
): boolean {
  const needle = normalizeForGrounding(referent);
  if (needle.length < 2) {
    return false;
  }
  const haystack = normalizeForGrounding(
    [
      text,
      ...records.flatMap((record) => [
        record.userMessage,
        record.assistantMessage,
        ...record.entities,
        ...record.offers,
        ...record.tools.map((tool) => `${tool.name} ${tool.args}`),
      ]),
    ].join(' '),
  );
  return haystack.includes(needle);
}

interface RawTurnUnderstanding {
  kind?: unknown;
  families?: unknown;
  refers_to_turn?: unknown;
  referent?: unknown;
  confidence?: unknown;
  needs_clarification?: unknown;
  clarification_options?: unknown;
  music_target?: unknown;
  music_reference?: unknown;
}

function cleanFamilies(raw: unknown): AoiCapabilityFamily[] | null {
  if (!Array.isArray(raw)) {
    return null;
  }
  const families: AoiCapabilityFamily[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') {
      continue;
    }
    const value = item.trim().toLowerCase() as AoiCapabilityFamily;
    if (AOI_CAPABILITY_FAMILIES.includes(value) && !families.includes(value)) {
      families.push(value);
    }
  }
  if (families.length === 0) {
    return null;
  }
  // "none" beside a real family is a contradiction; the real family wins.
  const real = families.filter((family) => family !== 'none');
  return real.length > 0 ? real : ['none'];
}

function cleanOptions(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const options: string[] = [];
  for (const item of raw) {
    const value = typeof item === 'string' ? item.replace(/\s+/g, ' ').trim() : '';
    if (
      value.length >= 1 &&
      value.length <= MAX_CLARIFICATION_OPTION_CHARS &&
      !options.some((existing) => existing.toLowerCase() === value.toLowerCase())
    ) {
      options.push(value);
    }
    if (options.length >= MAX_CLARIFICATION_OPTIONS) {
      break;
    }
  }
  return options;
}

/**
 * Validate a classifier answer into something the runtime may act on, or null.
 *
 * Every rejection is a value the model was not entitled to produce: a kind or
 * family outside the enum, a turn number that is not on record, a referent that
 * appears nowhere. A referent failing grounding is dropped rather than failing
 * the whole reading, because the kind and families are still usable without it.
 */
export function parseAoiTurnUnderstandingToolCall(
  raw: unknown,
  context: { text: string; records: readonly AoiTurnRecord[] },
): AoiTurnUnderstanding | null {
  const parsed = (raw ?? {}) as RawTurnUnderstanding;
  const kind =
    typeof parsed.kind === 'string' ? (parsed.kind.trim().toLowerCase() as AoiTurnKind) : null;
  if (!kind || kind === 'unknown' || !AOI_TURN_KINDS.includes(kind)) {
    return null;
  }
  const families = cleanFamilies(parsed.families);
  if (!families) {
    return null;
  }
  const confidence: AoiTurnConfidence =
    // Anything but the three named values reads as medium: shown to the model as
    // context, never allowed to move a tool. Defaulting to high let an omitted
    // field act on the routing.
    parsed.confidence === 'low' ? 'low' : parsed.confidence === 'high' ? 'high' : 'medium';

  let refersToTurn: number | null = null;
  if (typeof parsed.refers_to_turn === 'number' && Number.isInteger(parsed.refers_to_turn)) {
    // The prompt names turns only by T-n position (1 = the previous turn), so the
    // answer is read the same way and converted to the record's turn index here.
    // Accepting the absolute index as well was ambiguous: in a fresh session the
    // oldest record is turn 1 and the previous turn is T-1.
    const position = parsed.refers_to_turn;
    const shown = Math.min(context.records.length, DEFAULT_RECENT_TURNS_IN_PROMPT);
    if (position >= 1 && position <= shown) {
      refersToTurn = context.records[context.records.length - position].turnIndex;
    }
  }

  let referent: string | null = null;
  if (typeof parsed.referent === 'string') {
    const value = parsed.referent.replace(/\s+/g, ' ').trim();
    if (
      value.length >= 2 &&
      value.length <= MAX_REFERENT_CHARS &&
      isGroundedAoiReferent(value, context.text, context.records)
    ) {
      referent = value;
    }
  }

  let needsClarification: string | null = null;
  // Only a low reading can ask (decideAoiClarification); a question kept at
  // medium would be dead data that reads as if it might be used.
  if (confidence === 'low' && typeof parsed.needs_clarification === 'string') {
    const value = parsed.needs_clarification.replace(/\s+/g, ' ').trim();
    if (value.length >= 2) {
      needsClarification =
        value.length <= MAX_CLARIFICATION_CHARS
          ? value
          : `${value.slice(0, MAX_CLARIFICATION_CHARS)}`;
    }
  }
  const clarificationOptions = needsClarification ? cleanOptions(parsed.clarification_options) : [];

  const musicReferenceRaw =
    typeof parsed.music_reference === 'string' ? parsed.music_reference.trim().toLowerCase() : '';
  const musicReference: AoiMusicReference | null = AOI_MUSIC_REFERENCES.includes(
    musicReferenceRaw as AoiMusicReference,
  )
    ? (musicReferenceRaw as AoiMusicReference)
    : null;
  let musicTarget: string | null = null;
  if (typeof parsed.music_target === 'string') {
    const value = parsed.music_target.replace(/\s+/g, ' ').trim();
    // Verbatim means verbatim: a target that does not appear in the user's own
    // words is the model composing a title, which is the one thing this slot
    // must never do.
    if (
      value.length >= 2 &&
      value.length <= MAX_MUSIC_TARGET_CHARS &&
      isGroundedAoiReferent(value, context.text, [])
    ) {
      musicTarget = value;
    }
  }

  return {
    kind,
    families,
    refersToTurn,
    referent,
    confidence,
    needsClarification,
    clarificationOptions,
    source: 'classifier',
    musicTarget,
    musicReference,
  };
}

const AFFIRMATIVE_PATTERN =
  /^(?:응|어|엉|웅|네|넵|예|ㅇㅇ|ㅇㅋ|오케이|오키|그래|좋아|좋음|맞아|맞아요|맞지|맞음|콜|가자|해줘|해|진행해|진행해줘|시작해|시작하자|그렇게 해줘|그대로 해줘|그걸로 해줘|그걸로|이걸로|yes|yep|yeah|yup|sure|ok|okay|go ahead|do it|please do|sounds good|correct|exactly|that'?s right|that'?s it)[.!?~\s]*$/iu;
// JS \b is ASCII-only: after a Hangul syllable it needs an ASCII word character
// next, so a bare "아니" never matched. Korean alternatives end on an explicit
// boundary lookahead; the ASCII ones keep \b.
const KO_WORD_END = '(?=\\s|$|[.!?~,])';
const REJECTION_PATTERN = new RegExp(
  `^(?:아니|아냐|아니야|아니요|아뇨|아니아니|노|됐어|그만|그거 말고|그게 아니라|그게 아냐|틀렸어|잘못|다른 거|다른거)${KO_WORD_END}|^(?:no|nope|nah|not that|wrong|stop|never mind|cancel)\\b|(?:말고|아니라|틀렸|잘못했|not that one|the other one|instead)`,
  'iu',
);
const QUESTION_PATTERN =
  /\?\s*$|(?:^|\s)(?:뭐|뭐야|뭔데|무엇|왜|어떻게|어떤|언제|어디|누가|누구|몇|얼마|어때|어땠어|맞아\?|인가|일까|할까)(?:\s|$|[?.!])|\b(?:what|why|how|when|where|who|which|is it|are there|does it|do you|can you tell)\b/iu;
const META_PATTERN =
  /(?:너\s*(?:는|가)?\s*(?:누구|뭐|어떤)|네\s*설정|너의\s*설정|아오이\s*(?:설정|모델|메모리)|어떤\s*모델|무슨\s*모델|모델\s*(?:뭐|무엇)|기억\s*(?:하고 있|나)|what model|who are you|your settings|how do you work|are you an ai)/iu;
const IMPERATIVE_ENDING_PATTERN =
  /(?:해줘|해봐|해라|해요|하자|해줄래|해주세요|줘|봐|와줘|열어|틀어|켜|꺼|보여|알려|찍어|만들|바꿔|고쳐|지워|삭제|저장|실행|열어봐|읽어|써|추가|정리)\s*[.!~]*\s*$|^(?:please\s+)?(?:open|play|run|show|read|write|save|delete|remove|create|make|find|search|check|fix|change|set|start|stop|close|list|summarize|analyze|build|test|commit|push|install|remember|forget|generate|draw|launch|kill|restart)\b/iu;

const FAMILY_HINTS: Array<{ family: AoiCapabilityFamily; pattern: RegExp }> = [
  {
    family: 'browser',
    pattern:
      /(크롬|브라우저|엣지|사이트|웹페이지|탭|url|링크|chrome|edge|browser|website|web ?page|tab\b|https?:\/\/)/iu,
  },
  {
    family: 'host',
    pattern:
      /(프로세스|메모장|계산기|작업\s*관리자|실행\s*중인|프로그램\s*(?:켜|실행|종료|꺼)|바탕화면|창\s*(?:목록|띄|닫)|활성\s*창|어떤\s*창|현재\s*창|process|notepad|calc(?:ulator)?|task ?manager|running programs?|desktop|window list|foreground window|active window|which window|dev server running)/iu,
  },
  {
    family: 'file',
    // 디컴파일 contains 파일; the lookbehind keeps decompilation out of "file".
    pattern:
      /((?<!컴)파일|폴더|디렉토리|디렉터리|경로|소스\s*코드|현재\s*열린|편집기|컴포넌트\s*(?:어디|찾)|\.(?:tsx?|jsx?|json|md|cpp|h|py|rs|go|cs|yaml|yml|scss|css)\b|\bfile\b|folder|director(?:y|ies)|workspace|editor|read the source|codebase)/iu,
  },
  {
    family: 'command',
    pattern:
      /(빌드|테스트\s*(?:돌려|실행|해)|린트|타입\s*체크|커밋|푸시|머지|리베이스|배포|설치해|명령어?\s*(?:실행|돌려)|터미널|셸|쉘|\b(?:build|test|lint|typecheck|commit|push|merge|rebase|deploy|install|terminal|shell|npm|pnpm|git)\b)/iu,
  },
  {
    family: 'ida',
    pattern: /(\bida\b|idasql|헥스레이|hex-?rays|\.i64\b|\.idb\b)/iu,
  },
  {
    family: 'ghidra',
    pattern: /(ghidra|기드라|\.gpr\b|pyghidra)/iu,
  },
  {
    family: 'memory',
    pattern:
      /(기억해|기억해줘|기억\s*해\s*둬|잊어|잊지\s*마|메모리에|저장해\s*둬|\bremember\b|\bforget\b|note that|keep in mind)/iu,
  },
  {
    family: 'image',
    pattern:
      /(그림\s*(?:그려|만들|생성)|이미지\s*(?:만들|생성|그려)|일러스트|draw|generate an? (?:image|picture)|illustration|make an? (?:image|picture))/iu,
  },
  {
    family: 'app',
    // Generic imperatives (열어줘, 켜줘) are deliberately absent: they belong to
    // whatever family the object names, and the umbrella gate below covers the
    // case where nothing more specific fired.
    pattern:
      /(유튜브|youtube|노래|음악|곡(?=\s|$|[을를이가은는도의.!?,])|재생|틀어|플레이리스트|앱(?=\s|$|[을를이가은는도의.!?,])|노트|메모\s*앱|캘린더|일정|타이머|위젯|\bplay\b|\bsong\b|\bmusic\b|\bapp\b|\bnotes?\b|calendar|timer|widget|lo-?fi)/iu,
  },
];

/**
 * The regex reading of a turn, in the same shape as the classifier's. Used as
 * the offline baseline in the evaluation corpus and as the fallback whenever the
 * classifier is off, times out, or answers with something that fails validation.
 * It cannot resolve references and never asks for clarification.
 */
export function inferAoiTurnUnderstandingFromRegex(
  text: string,
  history: readonly ChatMessage[] = [],
): AoiTurnUnderstanding {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  const mutableHistory = [...history];
  const families = new Set<AoiCapabilityFamily>();

  for (const hint of FAMILY_HINTS) {
    if (hint.pattern.test(trimmed)) {
      families.add(hint.family);
    }
  }
  if (shouldEnableIdaSqlTools(trimmed, mutableHistory)) {
    families.add('ida');
  }
  if (shouldEnableGhidraTools(trimmed, mutableHistory)) {
    families.add('ghidra');
  }
  if (shouldUseAoiResearchRun(trimmed, mutableHistory) || shouldUseWebSearch(trimmed)) {
    families.add('research');
  }
  // shouldEnableAppTools is the umbrella gate for the whole app/file/workspace
  // tool block, so it fires for file and command work too. It names "app" only
  // when nothing more specific already did.
  if (
    shouldEnableAppTools(trimmed, mutableHistory) &&
    !['file', 'command', 'browser', 'host', 'ida', 'ghidra'].some((family) =>
      families.has(family as AoiCapabilityFamily),
    )
  ) {
    families.add('app');
  }

  const confirmed = resolveAoiActionConfirmationRequest(trimmed, mutableHistory) !== null;
  const affirmative = AFFIRMATIVE_PATTERN.test(trimmed);
  const rejection = REJECTION_PATTERN.test(trimmed);
  const dialog = shouldUseDialogModel(trimmed, mutableHistory);

  let kind: AoiTurnKind;
  if (rejection && trimmed.length <= 60) {
    kind = 'rejection_or_correction';
  } else if (confirmed || (affirmative && trimmed.length <= 24)) {
    kind = 'confirmation';
  } else if (META_PATTERN.test(trimmed)) {
    kind = 'meta';
  } else if (!dialog && (families.size > 0 || IMPERATIVE_ENDING_PATTERN.test(trimmed))) {
    kind = 'action_request';
  } else if (QUESTION_PATTERN.test(trimmed)) {
    kind = 'question';
  } else if (dialog) {
    kind = 'chitchat';
  } else {
    kind = 'action_request';
  }

  // A question that does not need any tool is conversational; a chat that names
  // a tool family is a request the ending did not mark.
  if (kind === 'chitchat' && families.size > 0 && IMPERATIVE_ENDING_PATTERN.test(trimmed)) {
    kind = 'action_request';
  }
  if (
    (kind === 'chitchat' || kind === 'confirmation' || kind === 'rejection_or_correction') &&
    families.size === 0
  ) {
    families.add('none');
  }
  if (kind === 'question' && families.size === 0) {
    families.add('none');
  }
  if (kind === 'meta' && families.size === 0) {
    families.add('none');
  }
  if (families.size === 0) {
    families.add('none');
  }

  return {
    kind,
    families: [...families],
    refersToTurn: null,
    referent: null,
    confidence: 'medium',
    needsClarification: null,
    clarificationOptions: [],
    source: 'regex',
    musicTarget: null,
    musicReference: null,
  };
}

/**
 * The config to classify with: the caller's provider and model, thinking off
 * wherever the model accepts that. chat() turns 'none' into the provider's
 * disable flag where one exists (OpenRouter, DeepSeek, Kimi) and drops it for
 * the CLI providers. A model that publishes a reasoning-effort list without
 * 'none' (the GPT reasoning models on the Responses API) would reject the value
 * with a 400 and the classifier would silently fall back on every turn, so for
 * those the caller's setting is left alone.
 */
export function withThinkingDisabled(config: LLMConfig): LLMConfig {
  // The Responses API maps any effort straight into reasoning.effort and adds
  // reasoning.encrypted_content; only gpt-5.1-class models publish 'none' as
  // accepted, and an o-series or unlisted model would 400 on it.
  if (shouldUseOpenAIResponses(config)) {
    return config;
  }
  const supported = getSupportedReasoningEfforts(config.provider, config.model);
  if (supported.length > 0 && !supported.includes(CLASSIFIER_REASONING_EFFORT)) {
    return config;
  }
  return { ...config, reasoningEffort: CLASSIFIER_REASONING_EFFORT };
}

/**
 * Whether temperature may be pinned for this request. Reasoning models (any
 * model that publishes an effort list) and the OpenAI Responses API reject the
 * parameter outright, and a rejected request is a classifier that never runs.
 */
export function canPinClassifierTemperature(config: LLMConfig): boolean {
  if (shouldUseOpenAIResponses(config)) {
    return false;
  }
  // MiniMax documents temperature in (0, 1]; a zero is an invalid-parameter
  // error, and a failing classifier call is indistinguishable from "off".
  if (config.provider === 'minimax') {
    return false;
  }
  return getSupportedReasoningEfforts(config.provider, config.model).length === 0;
}

/**
 * Run the classifier for one turn. Null on anything unusual -- gate closed,
 * timeout, provider error, no tool call, a value that failed validation -- so the
 * caller falls back to the regex reading exactly as before this existed.
 */
export async function classifyAoiTurn(
  params: {
    text: string;
    records: readonly AoiTurnRecord[];
    recentTurnsBlock: string;
    hasAttachments: boolean;
    enabled: boolean;
  },
  config: LLMConfig,
  options: { signal?: AbortSignal; timeoutMs?: number; now?: () => number } = {},
): Promise<AoiTurnUnderstanding | null> {
  if (
    !shouldClassifyAoiTurn({
      text: params.text,
      hasAttachments: params.hasAttachments,
      enabled: params.enabled,
    })
  ) {
    return null;
  }
  const now = options.now ?? (() => Date.now());
  const startedAt = now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_AOI_TURN_CLASSIFIER_TIMEOUT_MS;
  const controller = new AbortController();
  const onOuterAbort = () => {
    controller.abort();
  };
  if (options.signal) {
    if (options.signal.aborted) {
      return null;
    }
    options.signal.addEventListener('abort', onOuterAbort, { once: true });
  }
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  const classifierConfig = withThinkingDisabled(config);
  try {
    const response = await chat(
      buildAoiTurnUnderstandingMessages({
        text: params.text,
        recentTurnsBlock: params.recentTurnsBlock,
        records: params.records,
      }),
      [getAoiTurnUnderstandingToolDefinition()],
      classifierConfig,
      {
        signal: controller.signal,
        // A slot that changes between identical inputs is a bug, not personality,
        // so the temperature is pinned wherever the provider allows it.
        ...(canPinClassifierTemperature(classifierConfig) ? { temperature: 0 } : {}),
        maxOutputTokens: MAX_CLASSIFIER_OUTPUT_TOKENS,
      },
    );
    const call = response.toolCalls.find(
      (entry) => entry.function.name === AOI_TURN_UNDERSTANDING_TOOL_NAME,
    );
    if (!call) {
      return null;
    }
    let args: unknown = {};
    try {
      args = JSON.parse(call.function.arguments) as unknown;
    } catch {
      return null;
    }
    const understanding = parseAoiTurnUnderstandingToolCall(args, {
      text: params.text,
      records: params.records,
    });
    if (!understanding) {
      return null;
    }
    return { ...understanding, latencyMs: Math.max(0, now() - startedAt) };
  } catch {
    // A classifier outage, timeout, or abort must never break the turn.
    return null;
  } finally {
    clearTimeout(timer);
    if (options.signal) {
      options.signal.removeEventListener('abort', onOuterAbort);
    }
  }
}
