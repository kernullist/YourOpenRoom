// Aoi self-expanding preference bank: instead of only asking the static seed
// questions, Aoi grows the bank from what it already knows about the user --
// their interest profile (derived from memory) plus preference/interest memories.
//
// Two generators, mirroring the memory distiller (heuristic + optional LLM):
//   1. buildHeuristicGeneratedQuestions -- deterministic, offline, template-based
//      "how deep do you want to go on <interest topic>?" questions per uncovered
//      interest topic. Always available, fully unit-testable.
//   2. generatePreferenceQuestionsWithLlm -- optional, gated on a usable LLM
//      config, proposes brand-new categories/questions grounded in a sanitized
//      summary of the user's known interests. Injectable `chat` for testing.
//
// Generated questions are stored single-language (the language they were made in)
// and adapted to the seed PreferencePollQuestion shape for asking / dashboard /
// memory derivation, so the rest of the pipeline needs no special cases.

import { chat, type ChatMessage } from './llmClient';
import type { LLMConfig } from './llmModels';
import {
  containsAoiSensitiveContent,
  redactAoiSensitiveContent,
  stripAoiSourceInstructions,
  type AoiMemoryEntry,
} from './aoiMemoryShared';
import type { AoiPreferenceLang, PreferencePollQuestion } from './aoiPreferencePoll';

// --- Stored shape ------------------------------------------------------------

export interface GeneratedPreferenceOption {
  id: string;
  label: string;
  // Preference key suffix shared by every option of the question.
  key: string;
  statement: string;
  tags: string[];
  // Non-empty only for options that should seed a technical interest topic.
  entities: string[];
}

export interface GeneratedPreferenceQuestion {
  version: 1;
  id: string;
  category: string;
  categoryLabel: string;
  lang: AoiPreferenceLang;
  prompt: string;
  options: GeneratedPreferenceOption[];
  source: 'heuristic' | 'llm';
  // Normalized label of the interest topic this was grown from (heuristic only),
  // used to avoid regenerating a question for the same topic.
  sourceTopicLabel?: string;
  sourceRefs: string[];
  createdAt: number;
}

export interface AoiGeneratedQuestionsState {
  version: 1;
  questions: GeneratedPreferenceQuestion[];
  lastGeneratedAt: number;
}

export const AOI_GENERATED_QUESTIONS_VERSION = 1 as const;

export const DEFAULT_AOI_GENERATED_QUESTIONS_STATE: AoiGeneratedQuestionsState = {
  version: AOI_GENERATED_QUESTIONS_VERSION,
  questions: [],
  lastGeneratedAt: 0,
};

// Keep at most this many generated questions (answered ones are always kept).
export const MAX_GENERATED_QUESTIONS = 24;
// Auto-expansion cooldown; a manual dashboard trigger bypasses it.
export const GENERATED_EXPANSION_COOLDOWN_MS = 6 * 60 * 60 * 1000;
// Expand when the answerable pool (seed + generated) drops to this or below.
export const GENERATED_EXPANSION_LOW_WATERMARK = 2;

const MAX_HEURISTIC_PER_RUN = 3;
const MAX_LLM_PER_RUN = 4;
const MAX_OPTIONS = 5;
const MIN_OPTIONS = 2;
const MAX_PROMPT_CHARS = 160;
const MAX_LABEL_CHARS = 60;
const MAX_STATEMENT_CHARS = 200;
const LLM_TIMEOUT_MS = 9_000;
const MAX_GROUNDING_TOPICS = 10;
const MAX_GROUNDING_MEMORIES = 8;
const MAX_GROUNDING_CHARS = 2000;

// --- Small utilities ---------------------------------------------------------

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function slug(value: string): string {
  return (
    normalizeWhitespace(value)
      .toLowerCase()
      .replace(/[^a-z0-9가-힣]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'x'
  );
}

function normalizePromptKey(value: string): string {
  return normalizeWhitespace(value)
    .toLowerCase()
    .replace(/[\s'"“”'`.!?]+/g, '');
}

function clampText(value: string, maxChars: number): string {
  const text = normalizeWhitespace(value);
  if (text.length <= maxChars) {
    return text;
  }
  // Reserve room for the ellipsis so the result never exceeds maxChars.
  return `${text.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

// Redact + strip embedded instructions, and reject anything still sensitive.
function safeText(value: string, maxChars: number): string | null {
  const cleaned = clampText(stripAoiSourceInstructions(redactAoiSensitiveContent(value)), maxChars);
  if (!cleaned || containsAoiSensitiveContent(cleaned)) {
    return null;
  }
  if (/\[redacted[_-]/i.test(cleaned)) {
    return null;
  }
  return cleaned;
}

// --- Adapter to the seed question shape --------------------------------------

function replicate(text: string): Record<AoiPreferenceLang, string> {
  return { ko: text, ja: text, zh: text, en: text };
}

// Adapt one stored (single-language) generated question to the seed
// PreferencePollQuestion shape used by the asking loop, dashboard, and memory
// derivation. The stored language text is replicated across locales because a
// generated question is personal and made in the user's active language.
export function generatedQuestionToSeedShape(
  generated: GeneratedPreferenceQuestion,
): PreferencePollQuestion {
  return {
    id: generated.id,
    category: generated.category,
    categoryLabels: replicate(generated.categoryLabel),
    prompts: replicate(generated.prompt),
    generated: true,
    options: generated.options.map((option) => ({
      id: option.id,
      labels: replicate(option.label),
      learn: {
        key: option.key,
        statement: replicate(option.statement),
        tags: option.tags,
        entities: option.entities,
      },
    })),
  };
}

export function generatedQuestionsToSeedShape(
  state: AoiGeneratedQuestionsState | null | undefined,
): PreferencePollQuestion[] {
  return normalizeGeneratedState(state).questions.map(generatedQuestionToSeedShape);
}

// --- Deterministic (heuristic) generator -------------------------------------

const DEPTH_CATEGORY = 'interest_depth';
const DEPTH_CATEGORY_LABEL: Record<AoiPreferenceLang, string> = {
  ko: '관심 심화',
  ja: '関心の深掘り',
  zh: '兴趣深化',
  en: 'Interest depth',
};

function depthPrompt(lang: AoiPreferenceLang, label: string): string {
  switch (lang) {
    case 'ko':
      return `'${label}', 지금 얼마나 더 파고들고 싶어?`;
    case 'ja':
      return `「${label}」、今どれくらい深掘りしたい?`;
    case 'zh':
      return `“${label}”，你现在想深入到什么程度?`;
    default:
      return `How deep do you want to go on "${label}" right now?`;
  }
}

interface DepthOptionSeed {
  id: string;
  label: string;
  statement: string;
  interest: boolean;
}

function depthOptions(lang: AoiPreferenceLang, label: string): DepthOptionSeed[] {
  switch (lang) {
    case 'ko':
      return [
        {
          id: 'deeper',
          label: '더 깊게 파고들래',
          statement: `요즘 '${label}' 주제를 더 깊게 파고들고 싶어 한다.`,
          interest: true,
        },
        {
          id: 'maintain',
          label: '지금 수준 유지',
          statement: `'${label}'는 지금 수준으로만 유지하고 싶어 한다.`,
          interest: false,
        },
        {
          id: 'light',
          label: '가볍게만',
          statement: `'${label}'는 가볍게만 살펴보고 싶어 한다.`,
          interest: false,
        },
        {
          id: 'pause',
          label: '당분간 관심 없음',
          statement: `당분간 '${label}' 주제에는 관심이 적다.`,
          interest: false,
        },
      ];
    case 'ja':
      return [
        {
          id: 'deeper',
          label: 'もっと深掘りしたい',
          statement: `最近「${label}」をもっと深掘りしたいと考えている。`,
          interest: true,
        },
        {
          id: 'maintain',
          label: '今の水準を維持',
          statement: `「${label}」は今の水準を維持したい。`,
          interest: false,
        },
        {
          id: 'light',
          label: '軽くだけ',
          statement: `「${label}」は軽く見る程度でいい。`,
          interest: false,
        },
        {
          id: 'pause',
          label: '当面は関心薄い',
          statement: `当面は「${label}」への関心は薄い。`,
          interest: false,
        },
      ];
    case 'zh':
      return [
        {
          id: 'deeper',
          label: '想更深入',
          statement: `最近想更深入钻研“${label}”。`,
          interest: true,
        },
        {
          id: 'maintain',
          label: '保持现有水平',
          statement: `“${label}”保持现有水平即可。`,
          interest: false,
        },
        {
          id: 'light',
          label: '只想大致了解',
          statement: `“${label}”只想大致了解一下。`,
          interest: false,
        },
        {
          id: 'pause',
          label: '暂时兴趣不大',
          statement: `暂时对“${label}”兴趣不大。`,
          interest: false,
        },
      ];
    default:
      return [
        {
          id: 'deeper',
          label: 'Go deeper',
          statement: `Wants to dig deeper into "${label}" right now.`,
          interest: true,
        },
        {
          id: 'maintain',
          label: 'Keep current level',
          statement: `Wants to keep "${label}" at the current level.`,
          interest: false,
        },
        {
          id: 'light',
          label: 'Only lightly',
          statement: `Wants only a light look at "${label}".`,
          interest: false,
        },
        {
          id: 'pause',
          label: 'Not right now',
          statement: `Not very interested in "${label}" for now.`,
          interest: false,
        },
      ];
  }
}

// Tags that mark a memory as NOT an interest topic to grow a question from.
const NON_INTEREST_MEMORY_TAGS = new Set([
  'preference-only',
  'identity',
  'private',
  'private-sensitive',
  'sensitive',
  'secret',
  'credential',
  'credentials',
  'api-key',
  'access-token',
]);

export interface DerivedInterestLabel {
  label: string;
  normalizedLabel: string;
  count: number;
  sourceMemoryIds: string[];
}

// Client-safe interest signal: the entities Aoi has remembered on active,
// non-private preference/fact memories (e.g. from answered interest polls or
// distilled chat). Ranked by how often they recur. This replaces the Node-only
// interest-profile module so generation can run in the browser bundle.
export function deriveInterestLabelsFromMemories(
  memories: readonly AoiMemoryEntry[],
): DerivedInterestLabel[] {
  const byLabel = new Map<string, { label: string; count: number; ids: Set<string> }>();
  for (const memory of memories) {
    if (memory.status !== 'active') {
      continue;
    }
    if (memory.type !== 'preference' && memory.type !== 'fact') {
      continue;
    }
    if (memory.tags.some((tag) => NON_INTEREST_MEMORY_TAGS.has(tag.toLowerCase()))) {
      continue;
    }
    for (const entity of memory.entities) {
      const label = safeText(entity, MAX_LABEL_CHARS);
      if (!label || label.trim().length < 3 || /^\d{4}-\d{2}-\d{2}$/.test(label)) {
        continue;
      }
      const normalizedLabel = label.toLowerCase();
      const current = byLabel.get(normalizedLabel) ?? { label, count: 0, ids: new Set<string>() };
      current.count += 1;
      current.ids.add(memory.id);
      byLabel.set(normalizedLabel, current);
    }
  }
  return [...byLabel.entries()]
    .map(([normalizedLabel, value]) => ({
      label: value.label,
      normalizedLabel,
      count: value.count,
      sourceMemoryIds: [...value.ids],
    }))
    .sort(
      (left, right) =>
        right.count - left.count || left.normalizedLabel.localeCompare(right.normalizedLabel),
    );
}

export interface HeuristicGenerationInput {
  memories: readonly AoiMemoryEntry[];
  existing: AoiGeneratedQuestionsState | null | undefined;
  lang: AoiPreferenceLang;
  now: number;
  max?: number;
}

// One "how deep?" question per remembered interest label not already covered by a
// generated question. Deterministic and offline.
export function buildHeuristicGeneratedQuestions(
  input: HeuristicGenerationInput,
): GeneratedPreferenceQuestion[] {
  const existing = normalizeGeneratedState(input.existing);
  const covered = new Set(
    existing.questions
      .map((question) => question.sourceTopicLabel)
      .filter((value): value is string => Boolean(value)),
  );
  const max = Math.max(1, Math.min(MAX_HEURISTIC_PER_RUN, input.max ?? MAX_HEURISTIC_PER_RUN));
  const out: GeneratedPreferenceQuestion[] = [];

  for (const interest of deriveInterestLabelsFromMemories(input.memories)) {
    if (out.length >= max) {
      break;
    }
    if (covered.has(interest.normalizedLabel)) {
      continue;
    }
    const label = interest.label;
    const key = `gen.interest-depth.${slug(interest.normalizedLabel)}`;
    const options: GeneratedPreferenceOption[] = depthOptions(input.lang, label).map((seed) => ({
      id: seed.id,
      label: seed.label,
      key,
      statement: seed.statement,
      tags: [],
      entities: seed.interest ? [label] : [],
    }));
    out.push({
      version: 1,
      id: `gen-depth-${fnv1a(interest.normalizedLabel)}`,
      category: DEPTH_CATEGORY,
      categoryLabel: DEPTH_CATEGORY_LABEL[input.lang],
      lang: input.lang,
      prompt: depthPrompt(input.lang, label),
      options,
      source: 'heuristic',
      sourceTopicLabel: interest.normalizedLabel,
      sourceRefs: interest.sourceMemoryIds.slice(0, 6).map((id) => `memory:${id}`),
      createdAt: input.now,
    });
    covered.add(interest.normalizedLabel);
  }
  return out;
}

// --- LLM generator -----------------------------------------------------------

export function hasUsableQuestionGenConfig(
  config: LLMConfig | null | undefined,
): config is LLMConfig {
  if (!config?.model.trim()) {
    return false;
  }
  if (
    config.provider === 'codex-auth' ||
    config.provider === 'codex-cli' ||
    config.provider === 'claude-cli'
  ) {
    return false;
  }
  return Boolean(config.baseUrl.trim());
}

function extractJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : trimmed;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return null;
  }
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

export interface QuestionGenGroundingInput {
  memories: readonly AoiMemoryEntry[];
  existingPrompts: readonly string[];
}

export function buildQuestionGenGroundingText(input: QuestionGenGroundingInput): string {
  const lines: string[] = [];
  const topics = deriveInterestLabelsFromMemories(input.memories).slice(0, MAX_GROUNDING_TOPICS);
  if (topics.length > 0) {
    lines.push('Known interest topics:');
    for (const topic of topics) {
      lines.push(`- ${topic.label}`);
    }
  }
  const memoryHighlights = input.memories
    .filter(
      (memory) =>
        memory.status === 'active' &&
        (memory.type === 'preference' || memory.type === 'fact') &&
        !memory.tags.includes('preference-only'),
    )
    .slice(0, MAX_GROUNDING_MEMORIES)
    .map((memory) => safeText(memory.content, 120))
    .filter((value): value is string => Boolean(value));
  if (memoryHighlights.length > 0) {
    lines.push('Known facts / preferences:');
    for (const highlight of memoryHighlights) {
      lines.push(`- ${highlight}`);
    }
  }
  const existing = input.existingPrompts
    .map((prompt) => clampText(prompt, MAX_PROMPT_CHARS))
    .filter(Boolean)
    .slice(0, 24);
  if (existing.length > 0) {
    lines.push('Questions already asked (do not duplicate):');
    for (const prompt of existing) {
      lines.push(`- ${prompt}`);
    }
  }
  return clampText(lines.join('\n'), MAX_GROUNDING_CHARS);
}

export function buildQuestionGenMessages(params: {
  grounding: string;
  lang: AoiPreferenceLang;
}): ChatMessage[] {
  return [
    {
      role: 'system',
      content: [
        'You are Aoi, expanding a multiple-choice poll you use to learn about the user.',
        `Propose NEW multiple-choice questions, written entirely in language code "${params.lang}".`,
        'Ground every question in the provided known interests/preferences; invent nothing about the user.',
        'You may introduce new category ids and labels. Do not duplicate questions already asked.',
        'Return strict JSON only, with this shape:',
        '{"questions":[{"category":"short_snake_id","categoryLabel":"short label","prompt":"the question","options":[{"label":"short choice","statement":"first-person sentence describing what choosing this means","interestEntities":["Topic Name"]}]}]}',
        'Rules:',
        '- 1 to 4 questions, each with 2 to 4 options.',
        '- interestEntities: include 1-2 topic names ONLY for options that represent a real technical interest to track; omit or leave empty for taste/working-style options.',
        '- Keep prompts and labels short; statements are one concise sentence.',
        '- No secrets, credentials, file paths, emails, or private data.',
        '- Prefer no output over low-quality or duplicate questions.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: params.grounding || 'No grounding available; return {"questions":[]}.',
    },
  ];
}

function parseGeneratedOptions(raw: unknown, key: string): GeneratedPreferenceOption[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const options: GeneratedPreferenceOption[] = [];
  const seenLabels = new Set<string>();
  for (const item of raw.slice(0, MAX_OPTIONS)) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const record = item as Record<string, unknown>;
    const label = safeText(typeof record.label === 'string' ? record.label : '', MAX_LABEL_CHARS);
    const statement = safeText(
      typeof record.statement === 'string' ? record.statement : '',
      MAX_STATEMENT_CHARS,
    );
    if (!label || !statement) {
      continue;
    }
    const labelKey = label.toLowerCase();
    if (seenLabels.has(labelKey)) {
      continue;
    }
    seenLabels.add(labelKey);
    const entities = Array.isArray(record.interestEntities)
      ? record.interestEntities
          .map((entity) => (typeof entity === 'string' ? safeText(entity, MAX_LABEL_CHARS) : null))
          .filter((value): value is string => Boolean(value))
          .slice(0, 2)
      : [];
    options.push({
      id: `o${options.length}`,
      label,
      key,
      statement,
      tags: [],
      entities,
    });
  }
  return options;
}

export function parseGeneratedQuestionsLlmResponse(
  raw: string,
  params: { lang: AoiPreferenceLang; now: number },
): GeneratedPreferenceQuestion[] {
  const parsed = extractJsonObject(raw);
  if (!parsed || typeof parsed !== 'object') {
    return [];
  }
  const maybeQuestions = (parsed as { questions?: unknown }).questions;
  if (!Array.isArray(maybeQuestions)) {
    return [];
  }
  const out: GeneratedPreferenceQuestion[] = [];
  for (const item of maybeQuestions.slice(0, MAX_LLM_PER_RUN)) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const record = item as Record<string, unknown>;
    const prompt = safeText(
      typeof record.prompt === 'string' ? record.prompt : '',
      MAX_PROMPT_CHARS,
    );
    if (!prompt) {
      continue;
    }
    const categoryLabel =
      safeText(
        typeof record.categoryLabel === 'string' ? record.categoryLabel : '',
        MAX_LABEL_CHARS,
      ) ?? prompt.slice(0, 24);
    const category = slug(
      typeof record.category === 'string' && record.category.trim()
        ? record.category
        : categoryLabel,
    );
    const key = `gen.${category}.${fnv1a(normalizePromptKey(prompt))}`;
    const options = parseGeneratedOptions(record.options, key);
    if (options.length < MIN_OPTIONS) {
      continue;
    }
    out.push({
      version: 1,
      id: `gen-llm-${fnv1a(`${normalizePromptKey(prompt)}:${params.lang}`)}`,
      category,
      categoryLabel,
      lang: params.lang,
      prompt,
      options,
      source: 'llm',
      sourceRefs: ['generated_by:preference_question_gen', 'model:llm'],
      createdAt: params.now,
    });
  }
  return out;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export type QuestionGenChat = typeof chat;

export interface LlmGenerationInput {
  memories: readonly AoiMemoryEntry[];
  existingPrompts: readonly string[];
  lang: AoiPreferenceLang;
  llmConfig: LLMConfig | null | undefined;
  now: number;
  chatFn?: QuestionGenChat;
}

export async function generatePreferenceQuestionsWithLlm(
  input: LlmGenerationInput,
): Promise<GeneratedPreferenceQuestion[]> {
  if (!hasUsableQuestionGenConfig(input.llmConfig)) {
    return [];
  }
  const grounding = buildQuestionGenGroundingText({
    memories: input.memories,
    existingPrompts: input.existingPrompts,
  });
  if (!grounding.trim()) {
    return [];
  }
  const chatFn = input.chatFn ?? chat;
  const config: LLMConfig = {
    ...input.llmConfig,
    reasoningEffort: 'low',
    reasoningSummary: 'none',
    verbosity: 'low',
    parallelToolCalls: false,
  };
  const abortController = new AbortController();
  try {
    const response = await withTimeout(
      chatFn(buildQuestionGenMessages({ grounding, lang: input.lang }), [], config, {
        signal: abortController.signal,
      }),
      LLM_TIMEOUT_MS,
      'Aoi preference question generator',
    );
    return parseGeneratedQuestionsLlmResponse(response.content, {
      lang: input.lang,
      now: input.now,
    });
  } finally {
    abortController.abort();
  }
}

// --- Merge / persistence -----------------------------------------------------

// Merge freshly generated questions into the store: drop duplicates (by id, by
// normalized prompt, and by preference key), prepend the new ones, and cap the
// total while always keeping answered questions.
export function mergeGeneratedQuestions(
  existing: AoiGeneratedQuestionsState | null | undefined,
  incoming: readonly GeneratedPreferenceQuestion[],
  params: { max?: number; keepIds?: readonly string[]; now: number },
): { state: AoiGeneratedQuestionsState; addedCount: number } {
  const base = normalizeGeneratedState(existing);
  const max = Math.max(1, params.max ?? MAX_GENERATED_QUESTIONS);
  const keep = new Set(params.keepIds ?? []);

  const seenIds = new Set(base.questions.map((question) => question.id));
  const seenPromptKeys = new Set(
    base.questions.map((question) => normalizePromptKey(question.prompt)),
  );
  const seenPrefKeys = new Set(base.questions.map((question) => question.options[0]?.key));

  const added: GeneratedPreferenceQuestion[] = [];
  for (const question of incoming) {
    const promptKey = normalizePromptKey(question.prompt);
    const prefKey = question.options[0]?.key;
    if (seenIds.has(question.id) || seenPromptKeys.has(promptKey) || seenPrefKeys.has(prefKey)) {
      continue;
    }
    seenIds.add(question.id);
    seenPromptKeys.add(promptKey);
    seenPrefKeys.add(prefKey);
    added.push(question);
  }

  // Newest first, but answered questions are never dropped by the cap.
  const combined = [...added, ...base.questions];
  const kept: GeneratedPreferenceQuestion[] = [];
  const overflow: GeneratedPreferenceQuestion[] = [];
  for (const question of combined) {
    if (keep.has(question.id)) {
      kept.push(question);
    } else {
      overflow.push(question);
    }
  }
  const room = Math.max(0, max - kept.length);
  const questions = [...kept, ...overflow.slice(0, room)];

  return {
    state: {
      version: AOI_GENERATED_QUESTIONS_VERSION,
      questions,
      lastGeneratedAt: params.now,
    },
    addedCount: added.length,
  };
}

export interface ExpandBankInput {
  memories: readonly AoiMemoryEntry[];
  existing: AoiGeneratedQuestionsState | null | undefined;
  seedPrompts: readonly string[];
  answeredIds?: readonly string[];
  lang: AoiPreferenceLang;
  llmConfig: LLMConfig | null | undefined;
  now: number;
  chatFn?: QuestionGenChat;
  max?: number;
}

// Orchestrate one expansion round: deterministic questions first, then optional
// LLM questions, merged into the store. LLM failures degrade to heuristic-only.
export async function expandAoiPreferenceQuestionBank(
  input: ExpandBankInput,
): Promise<{ state: AoiGeneratedQuestionsState; addedCount: number }> {
  const heuristic = buildHeuristicGeneratedQuestions({
    memories: input.memories,
    existing: input.existing,
    lang: input.lang,
    now: input.now,
  });

  let llm: GeneratedPreferenceQuestion[] = [];
  if (hasUsableQuestionGenConfig(input.llmConfig)) {
    const existingPrompts = [
      ...input.seedPrompts,
      ...normalizeGeneratedState(input.existing).questions.map((question) => question.prompt),
      ...heuristic.map((question) => question.prompt),
    ];
    try {
      llm = await generatePreferenceQuestionsWithLlm({
        memories: input.memories,
        existingPrompts,
        lang: input.lang,
        llmConfig: input.llmConfig,
        now: input.now,
        ...(input.chatFn ? { chatFn: input.chatFn } : {}),
      });
    } catch {
      llm = [];
    }
  }

  return mergeGeneratedQuestions(input.existing, [...heuristic, ...llm], {
    max: input.max ?? MAX_GENERATED_QUESTIONS,
    ...(input.answeredIds ? { keepIds: input.answeredIds } : {}),
    now: input.now,
  });
}

// --- Storage -----------------------------------------------------------------

const GENERATED_QUESTIONS_STORAGE_KEY = 'aoi-preference-generated-v1';

function isValidGeneratedOption(value: unknown): value is GeneratedPreferenceOption {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === 'string' &&
    typeof record.label === 'string' &&
    record.label.trim().length > 0 &&
    typeof record.key === 'string' &&
    typeof record.statement === 'string' &&
    Array.isArray(record.tags) &&
    Array.isArray(record.entities)
  );
}

function isValidGeneratedQuestion(value: unknown): value is GeneratedPreferenceQuestion {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.version === AOI_GENERATED_QUESTIONS_VERSION &&
    typeof record.id === 'string' &&
    typeof record.category === 'string' &&
    typeof record.categoryLabel === 'string' &&
    typeof record.prompt === 'string' &&
    record.prompt.trim().length > 0 &&
    Array.isArray(record.options) &&
    record.options.length >= MIN_OPTIONS &&
    record.options.every(isValidGeneratedOption)
  );
}

export function normalizeGeneratedState(
  state: AoiGeneratedQuestionsState | null | undefined,
): AoiGeneratedQuestionsState {
  if (
    !state ||
    state.version !== AOI_GENERATED_QUESTIONS_VERSION ||
    !Array.isArray(state.questions)
  ) {
    return { ...DEFAULT_AOI_GENERATED_QUESTIONS_STATE, questions: [] };
  }
  return {
    version: AOI_GENERATED_QUESTIONS_VERSION,
    questions: state.questions.filter(isValidGeneratedQuestion),
    lastGeneratedAt: typeof state.lastGeneratedAt === 'number' ? state.lastGeneratedAt : 0,
  };
}

export function loadAoiGeneratedQuestionsState(): AoiGeneratedQuestionsState {
  try {
    const raw = localStorage.getItem(GENERATED_QUESTIONS_STORAGE_KEY);
    if (!raw) {
      return normalizeGeneratedState(null);
    }
    return normalizeGeneratedState(JSON.parse(raw) as AoiGeneratedQuestionsState);
  } catch {
    return normalizeGeneratedState(null);
  }
}

export function saveAoiGeneratedQuestionsState(state: AoiGeneratedQuestionsState): void {
  try {
    localStorage.setItem(
      GENERATED_QUESTIONS_STORAGE_KEY,
      JSON.stringify(normalizeGeneratedState(state)),
    );
  } catch {
    // Best-effort persistence; ignore quota / privacy-mode failures.
  }
}
