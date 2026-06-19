import { createHash } from 'crypto';
import { containsAoiSensitiveContent, type AoiMemoryEntry } from './aoiMemoryShared';
import { normalizeAoiAutonomySessionPath } from './aoiAutonomyStore';
import type {
  AoiInterestProfile,
  AoiInterestTopic,
  AoiInterestTopicSource,
} from './aoiAutonomyTypes';

const MIN_INTEREST_MEMORY_CONFIDENCE = 0.55;
const MAX_INTEREST_TOPICS = 50;
const MAX_TOPIC_ALIASES = 12;
const MAX_TOPIC_EVIDENCE_REFS = 24;
const MAX_TOPIC_MEMORY_IDS = 24;

const EXCLUDED_MEMORY_TAGS = new Set([
  'demoted',
  'one-off-correction',
  'proposal-negative-feedback',
  'private',
  'private-sensitive',
  'sensitive',
  'secret',
  'credential',
  'credentials',
  'api-key',
  'access-token',
  'temporary-instruction',
]);

const INTEREST_LIKE_TAGS = new Set([
  'interest',
  'research',
  'reverse-engineering',
  'reversing',
  'windows',
  'kernel',
  'driver',
  'driver-internals',
  'anti-cheat',
  'game-security',
  'security',
  'memory',
  'process-protection',
  'tpm',
  'verification',
  'unreal-engine',
  'ue5',
  'documentation',
  'automation',
  'workflow',
  'testing',
  'review',
]);

interface TopicAliasRule {
  label: string;
  aliases: string[];
  tags: string[];
  patterns: RegExp[];
}

interface ExtractedTopicSeed {
  label: string;
  aliases: string[];
  source: AoiInterestTopicSource;
}

interface TopicAccumulator {
  label: string;
  normalizedLabel: string;
  aliases: Set<string>;
  source: AoiInterestTopicSource;
  memoryIds: Set<string>;
  evidenceRefs: Set<string>;
  confidenceTotal: number;
  importanceTotal: number;
  noveltyTotal: number;
  currentInfoTotal: number;
  sampleCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface AoiInterestProfileBuildInput {
  sessionPath: string;
  memories: AoiMemoryEntry[];
  now?: number;
}

const TOPIC_ALIAS_RULES: TopicAliasRule[] = [
  {
    label: 'Reverse Engineering',
    aliases: ['RE', 'reverse engineering', 'reversing'],
    tags: ['reverse-engineering', 'reversing'],
    patterns: [/\bRE\b/u, /\breverse engineering\b/iu, /\breversing\b/iu],
  },
  {
    label: 'Windows Kernel Internals',
    aliases: ['kernel', 'Windows kernel', 'driver internals', 'kernel driver', 'KMDF', 'WDM'],
    tags: ['kernel', 'driver', 'driver-internals'],
    patterns: [
      /\bwindows kernel\b/iu,
      /\bkernel\b/iu,
      /\bdriver internals?\b/iu,
      /\bkernel driver\b/iu,
      /\bKMDF\b/u,
      /\bWDM\b/u,
      /\bIRQL\b/u,
      /\bWinDbg\b/iu,
    ],
  },
  {
    label: 'Anti-Cheat and Game Security',
    aliases: ['anti-cheat', 'anticheat', 'game security'],
    tags: ['anti-cheat', 'game-security'],
    patterns: [/\banti-?cheat\b/iu, /\bgame security\b/iu],
  },
  {
    label: 'Windows Security Engineering',
    aliases: ['Windows security', 'Windows internals'],
    tags: ['windows', 'security'],
    patterns: [/\bwindows security\b/iu, /\bwindows internals?\b/iu],
  },
  {
    label: 'Memory Inspection and Process Protection',
    aliases: ['memory inspection', 'process protection', 'memory scanning', 'telemetry'],
    tags: ['memory', 'process-protection', 'telemetry'],
    patterns: [
      /\bmemory inspection\b/iu,
      /\bmemory scan(?:ning)?\b/iu,
      /\bprocess protection\b/iu,
      /\btelemetry\b/iu,
    ],
  },
  {
    label: 'TPM and Hardware Verification',
    aliases: ['TPM', 'attestation', 'hardware-backed verification'],
    tags: ['tpm', 'attestation', 'verification'],
    patterns: [/\bTPM\b/u, /\battestation\b/iu, /\bhardware-backed verification\b/iu],
  },
  {
    label: 'Unreal Engine Security',
    aliases: ['Unreal Engine', 'UE5', 'game tooling'],
    tags: ['unreal-engine', 'ue5'],
    patterns: [/\bUnreal Engine\b/iu, /\bUE5\b/u],
  },
  {
    label: 'Research and Technical Writing',
    aliases: ['research workflow', 'documentation workflow', 'technical writing'],
    tags: ['research', 'documentation'],
    patterns: [
      /\bresearch workflow\b/iu,
      /\btechnical writing\b/iu,
      /\bstructured documentation\b/iu,
    ],
  },
  {
    label: 'Automation and Coding Workflow',
    aliases: ['automation workflow', 'coding workflow', 'goal prompts'],
    tags: ['automation', 'workflow'],
    patterns: [/\bautomation workflow\b/iu, /\bcoding workflow\b/iu, /\bgoal prompts?\b/iu],
  },
  {
    label: 'Testing, Review, and Commit Hygiene',
    aliases: ['testing', 'review', 'validation', 'commit hygiene'],
    tags: ['testing', 'review', 'validation'],
    patterns: [/\btest(?:ing)?\b/iu, /\breview\b/iu, /\bvalidation\b/iu, /\bcommit hygiene\b/iu],
  },
  {
    label: 'Aoi Assistant Behavior',
    aliases: ['Aoi memory', 'personal assistant behavior', 'Jarvis behavior'],
    tags: ['aoi', 'assistant-memory'],
    patterns: [/\bAoi\b/u, /\bJarvis\b/u, /\bpersonal assistant\b/iu],
  },
];

const TAG_TOPIC_LABELS: Record<string, string> = {
  security: 'Security Engineering',
  research: 'Research and Technical Writing',
  documentation: 'Research and Technical Writing',
  validation: 'Testing, Review, and Commit Hygiene',
  workflow: 'Automation and Coding Workflow',
  automation: 'Automation and Coding Workflow',
};

function clampScore(value: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(1, Math.max(0, value));
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function normalizeTopicKey(value: string): string {
  return normalizeWhitespace(value)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9+#._ -]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s+/g, '-');
}

function normalizeTag(value: string): string {
  return normalizeWhitespace(value).toLowerCase().replace(/_/g, '-');
}

function hasExcludedTag(memory: AoiMemoryEntry): boolean {
  return memory.tags.some((tag) => {
    const normalized = normalizeTag(tag);
    return EXCLUDED_MEMORY_TAGS.has(normalized) || normalized.startsWith('demotion:');
  });
}

function hasInterestLikeTag(memory: AoiMemoryEntry): boolean {
  return memory.tags.some((tag) => INTEREST_LIKE_TAGS.has(normalizeTag(tag)));
}

function looksPrivateOrSensitiveText(value: string): boolean {
  return (
    containsAoiSensitiveContent(value) ||
    /\b[A-Z]:\\[^\s]+/i.test(value) ||
    /\bfile:\/\/[^\s]+/i.test(value) ||
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(value)
  );
}

function isSafeTopicLabel(value: string): boolean {
  const normalized = normalizeWhitespace(value);
  if (normalized.length > 80) {
    return false;
  }
  if (normalized.length < 3 && !/^[A-Z0-9+#]{2}$/u.test(normalized)) {
    return false;
  }
  if (looksPrivateOrSensitiveText(normalized)) {
    return false;
  }
  if (/https?:\/\//i.test(normalized) || /\bprivate\b/i.test(normalized)) {
    return false;
  }
  return /[A-Za-z0-9]/.test(normalized);
}

function toTitleCaseLabel(value: string): string {
  const acronymMap: Record<string, string> = {
    re: 'RE',
    tpm: 'TPM',
    ue5: 'UE5',
    kmdf: 'KMDF',
    wdm: 'WDM',
    irql: 'IRQL',
  };
  return normalizeWhitespace(value)
    .replace(/[_-]+/g, ' ')
    .split(' ')
    .map((part) => {
      const lower = part.toLowerCase();
      if (acronymMap[lower]) {
        return acronymMap[lower];
      }
      if (part.length <= 2 && part === part.toUpperCase()) {
        return part;
      }
      return lower.slice(0, 1).toUpperCase() + lower.slice(1);
    })
    .join(' ');
}

function normalizeAliases(values: string[]): string[] {
  const seen = new Set<string>();
  const aliases: string[] = [];
  for (const value of values) {
    const alias = normalizeWhitespace(value).slice(0, 80);
    const key = alias.toLowerCase();
    if (!alias || seen.has(key) || !isSafeTopicLabel(alias)) {
      continue;
    }
    seen.add(key);
    aliases.push(alias);
    if (aliases.length >= MAX_TOPIC_ALIASES) {
      break;
    }
  }
  return aliases;
}

function uniqueSorted(values: Iterable<string>, maxItems: number): string[] {
  return [...new Set([...values].map(normalizeWhitespace).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right))
    .slice(0, maxItems);
}

function scoreMemoryConfidence(memory: AoiMemoryEntry): number {
  const explicitBoost = memory.tags.some(
    (tag) => normalizeTag(tag) === 'explicit' || normalizeTag(tag) === 'explicit-save',
  )
    ? 0.05
    : 0;
  const interestBoost = hasInterestLikeTag(memory) ? 0.04 : 0;
  const preferenceBoost = memory.type === 'preference' ? 0.04 : 0;
  return clampScore(memory.confidence + explicitBoost + interestBoost + preferenceBoost, 0.55);
}

function scoreMemoryImportance(memory: AoiMemoryEntry): number {
  const permanentBoost = memory.permanent ? 0.06 : 0;
  const hitBoost = Math.min(0.08, Math.max(0, memory.hits) * 0.01);
  const interestBoost = hasInterestLikeTag(memory) ? 0.04 : 0;
  return clampScore(memory.importance + permanentBoost + hitBoost + interestBoost, 0.5);
}

function scoreNoveltyPreference(memory: AoiMemoryEntry): number {
  const text = `${memory.content} ${memory.tags.join(' ')}`.toLowerCase();
  if (/\b(?:latest|new|current|trend|fresh|recent|novel|research)\b/u.test(text)) {
    return 0.78;
  }
  if (hasInterestLikeTag(memory)) {
    return 0.62;
  }
  return 0.5;
}

function scoreCurrentInfoPreference(memory: AoiMemoryEntry): number {
  const text = `${memory.content} ${memory.tags.join(' ')}`.toLowerCase();
  if (/\b(?:latest|current|today|recent|trend|news|research)\b/u.test(text)) {
    return 0.82;
  }
  if (memory.tags.some((tag) => normalizeTag(tag) === 'research')) {
    return 0.72;
  }
  return 0.55;
}

export function isAoiMemoryEligibleForInterestProfile(
  memory: AoiMemoryEntry,
  now = Date.now(),
): boolean {
  if (memory.status !== 'active') {
    return false;
  }
  if (memory.confidence < MIN_INTEREST_MEMORY_CONFIDENCE) {
    return false;
  }
  if (memory.expiresAt && memory.expiresAt <= now) {
    return false;
  }
  if (hasExcludedTag(memory)) {
    return false;
  }
  if (looksPrivateOrSensitiveText(memory.content)) {
    return false;
  }
  if (memory.type === 'preference') {
    return true;
  }
  if (memory.type === 'fact' && hasInterestLikeTag(memory)) {
    return true;
  }
  return false;
}

function findAliasRuleSeeds(memory: AoiMemoryEntry): ExtractedTopicSeed[] {
  const text = `${memory.content} ${memory.tags.join(' ')} ${memory.entities.join(' ')}`;
  const normalizedTags = new Set(memory.tags.map(normalizeTag));
  const seeds: ExtractedTopicSeed[] = [];

  for (const rule of TOPIC_ALIAS_RULES) {
    const tagMatched = rule.tags.some((tag) => normalizedTags.has(tag));
    const patternMatched = rule.patterns.some((pattern) => pattern.test(text));
    if (!tagMatched && !patternMatched) {
      continue;
    }
    seeds.push({
      label: rule.label,
      aliases: rule.aliases,
      source: 'memory',
    });
  }

  return seeds;
}

function findTagSeeds(memory: AoiMemoryEntry): ExtractedTopicSeed[] {
  const seeds: ExtractedTopicSeed[] = [];
  for (const rawTag of memory.tags) {
    const tag = normalizeTag(rawTag);
    const label = TAG_TOPIC_LABELS[tag];
    if (!label || !INTEREST_LIKE_TAGS.has(tag)) {
      continue;
    }
    seeds.push({
      label,
      aliases: [rawTag],
      source: 'memory',
    });
  }
  return seeds;
}

function splitInterestPhrase(value: string): string[] {
  return value
    .split(/\s*(?:,|;|\/|\band\b|\bor\b|\+)\s*/iu)
    .map((item) => normalizeWhitespace(item.replace(/^["'`]+|["'`.]+$/g, '')))
    .filter(Boolean);
}

function findContentPhraseSeeds(memory: AoiMemoryEntry): ExtractedTopicSeed[] {
  if (!hasInterestLikeTag(memory) && memory.type !== 'preference') {
    return [];
  }
  const seeds: ExtractedTopicSeed[] = [];
  const patterns = [
    /\binterested in\s+([^.;:"']{3,100})/iu,
    /\binterest in\s+([^.;:"']{3,100})/iu,
    /\bprefers?\s+([^.;:"']{3,100})/iu,
    /\blikes?\s+([^.;:"']{3,100})/iu,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(memory.content);
    if (!match?.[1]) {
      continue;
    }
    for (const phrase of splitInterestPhrase(match[1])) {
      const label = toTitleCaseLabel(phrase).slice(0, 80);
      if (!isSafeTopicLabel(label)) {
        continue;
      }
      seeds.push({
        label,
        aliases: [phrase],
        source: 'memory',
      });
      if (seeds.length >= 4) {
        return seeds;
      }
    }
  }
  return seeds;
}

function findEntitySeeds(memory: AoiMemoryEntry): ExtractedTopicSeed[] {
  if (!hasInterestLikeTag(memory) && memory.type !== 'preference') {
    return [];
  }
  return memory.entities
    .map((entity) => toTitleCaseLabel(entity).slice(0, 80))
    .filter(isSafeTopicLabel)
    .filter((label) => !/^\d{4}-\d{2}-\d{2}$/.test(label))
    .slice(0, 8)
    .map((label) => ({
      label,
      aliases: [label],
      source: 'memory' as const,
    }));
}

function canonicalizeTopicSeed(seed: ExtractedTopicSeed): ExtractedTopicSeed {
  const text = `${seed.label} ${seed.aliases.join(' ')}`;
  const normalizedLabel = normalizeTopicKey(seed.label);
  const rule = TOPIC_ALIAS_RULES.find(
    (item) =>
      item.patterns.some((pattern) => pattern.test(text)) ||
      item.aliases.some((alias) => normalizeTopicKey(alias) === normalizedLabel),
  );
  if (!rule) {
    return seed;
  }
  return {
    label: rule.label,
    aliases: normalizeAliases([...rule.aliases, ...seed.aliases, seed.label]),
    source: seed.source,
  };
}

export function extractAoiInterestTopicSeeds(memory: AoiMemoryEntry): ExtractedTopicSeed[] {
  const seeds = [
    ...findAliasRuleSeeds(memory),
    ...findTagSeeds(memory),
    ...findContentPhraseSeeds(memory),
    ...findEntitySeeds(memory),
  ];
  const byKey = new Map<string, ExtractedTopicSeed>();
  for (const rawSeed of seeds) {
    const seed = canonicalizeTopicSeed(rawSeed);
    if (!isSafeTopicLabel(seed.label)) {
      continue;
    }
    const normalizedLabel = normalizeTopicKey(seed.label);
    const current = byKey.get(normalizedLabel);
    byKey.set(normalizedLabel, {
      label: current?.label ?? seed.label,
      aliases: normalizeAliases([...(current?.aliases ?? []), ...seed.aliases, seed.label]),
      source: current?.source ?? seed.source,
    });
  }
  return [...byKey.values()];
}

function addTopicSeed(
  accumulators: Map<string, TopicAccumulator>,
  memory: AoiMemoryEntry,
  seed: ExtractedTopicSeed,
): void {
  const normalizedLabel = normalizeTopicKey(seed.label);
  if (!normalizedLabel) {
    return;
  }
  const confidence = scoreMemoryConfidence(memory);
  const importance = scoreMemoryImportance(memory);
  const noveltyPreference = scoreNoveltyPreference(memory);
  const currentInfoPreference = scoreCurrentInfoPreference(memory);
  const existing = accumulators.get(normalizedLabel);
  const accumulator =
    existing ??
    ({
      label: seed.label,
      normalizedLabel,
      aliases: new Set<string>(),
      source: seed.source,
      memoryIds: new Set<string>(),
      evidenceRefs: new Set<string>(),
      confidenceTotal: 0,
      importanceTotal: 0,
      noveltyTotal: 0,
      currentInfoTotal: 0,
      sampleCount: 0,
      createdAt: memory.createdAt,
      updatedAt: memory.updatedAt,
    } satisfies TopicAccumulator);

  for (const alias of normalizeAliases([seed.label, ...seed.aliases])) {
    accumulator.aliases.add(alias);
  }
  accumulator.memoryIds.add(memory.id);
  accumulator.evidenceRefs.add(`memory:${memory.id}`);
  accumulator.confidenceTotal += confidence;
  accumulator.importanceTotal += importance;
  accumulator.noveltyTotal += noveltyPreference;
  accumulator.currentInfoTotal += currentInfoPreference;
  accumulator.sampleCount += 1;
  accumulator.createdAt = Math.min(accumulator.createdAt, memory.createdAt);
  accumulator.updatedAt = Math.max(accumulator.updatedAt, memory.updatedAt);
  accumulators.set(normalizedLabel, accumulator);
}

function topicFromAccumulator(
  sessionPath: string,
  accumulator: TopicAccumulator,
): AoiInterestTopic {
  const sampleCount = Math.max(1, accumulator.sampleCount);
  const confidence = clampScore(accumulator.confidenceTotal / sampleCount, 0.55);
  const importance = clampScore(accumulator.importanceTotal / sampleCount, 0.5);
  const noveltyPreference = clampScore(accumulator.noveltyTotal / sampleCount, 0.5);
  const currentInfoPreference = clampScore(accumulator.currentInfoTotal / sampleCount, 0.55);
  return {
    version: 1,
    id: `aoi-interest-${hashText(`${sessionPath}:${accumulator.normalizedLabel}`)}`,
    sessionPath,
    label: accumulator.label.slice(0, 80),
    normalizedLabel: accumulator.normalizedLabel,
    aliases: uniqueSorted(accumulator.aliases, MAX_TOPIC_ALIASES),
    source: accumulator.source,
    memoryIds: uniqueSorted(accumulator.memoryIds, MAX_TOPIC_MEMORY_IDS),
    evidenceRefs: uniqueSorted(accumulator.evidenceRefs, MAX_TOPIC_EVIDENCE_REFS),
    confidence,
    importance,
    noveltyPreference,
    currentInfoPreference,
    muted: false,
    pinned: false,
    cooldownKey: `interest:${accumulator.normalizedLabel}`,
    createdAt: accumulator.createdAt,
    updatedAt: accumulator.updatedAt,
  };
}

export function extractAoiInterestTopicsFromMemories(
  input: AoiInterestProfileBuildInput,
): AoiInterestTopic[] {
  const now = input.now ?? Date.now();
  const sessionPath = normalizeAoiAutonomySessionPath(input.sessionPath);
  if (!sessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }

  const accumulators = new Map<string, TopicAccumulator>();
  for (const memory of input.memories) {
    if (!isAoiMemoryEligibleForInterestProfile(memory, now)) {
      continue;
    }
    for (const seed of extractAoiInterestTopicSeeds(memory)) {
      addTopicSeed(accumulators, memory, seed);
    }
  }

  return [...accumulators.values()]
    .map((accumulator) => topicFromAccumulator(sessionPath, accumulator))
    .sort(
      (left, right) =>
        right.importance - left.importance ||
        right.confidence - left.confidence ||
        right.updatedAt - left.updatedAt ||
        left.normalizedLabel.localeCompare(right.normalizedLabel),
    )
    .slice(0, MAX_INTEREST_TOPICS);
}

export function buildAoiInterestProfileFromMemories(
  input: AoiInterestProfileBuildInput,
): AoiInterestProfile {
  const now = input.now ?? Date.now();
  const sessionPath = normalizeAoiAutonomySessionPath(input.sessionPath);
  if (!sessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const topics = extractAoiInterestTopicsFromMemories({
    ...input,
    sessionPath,
    now,
  });
  const sourceMemoryIds = new Set(topics.flatMap((topic) => topic.memoryIds));

  return {
    version: 1,
    sessionPath,
    topics,
    generatedAt: now,
    sourceMemoryCount: sourceMemoryIds.size,
    warnings: [],
  };
}
