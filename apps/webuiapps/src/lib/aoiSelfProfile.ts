// Aoi's own side of the relationship (R5.1).
//
// Interest modeling has been entirely one-way: the interest profile, the music
// taste model and the preference polls all describe the USER. The only place the
// runtime mentioned Aoi having tastes of her own was a prohibition
// ("Do not invent a personal taste profile"), and the tastes written into the
// persona are prose nothing reads. So Aoi could target the user's interests but
// never say "I looked into that too" -- and a partner who never has a side of
// their own reads as a service.
//
// What this models is deliberately NOT the persona's character tastes (high-risk
// bounties, expensive tea). Those are already in the system prompt and are the
// LLM's to express. This models what Aoi actually WENT AND LOOKED INTO: research
// runs and agent-scope memories. That is the only self-side material that can be
// evidence-backed, and evidence is what separates "I was curious about that too"
// from flattery.
//
// Honesty rules:
// - Every inquiry carries the refs it came from. No refs, no inquiry.
// - Overlap requires a real match between a stored inquiry and a stored user
//   topic. No match means silence, never a claimed affinity.
// - display_only / mutationCount 0.
// - Pure and dependency-free so the client can use it directly (the interest
//   profile module touches node APIs and cannot be imported by value here).

export type AoiSelfInquiryKind = 'research_run' | 'agent_memory';

export interface AoiSelfInquirySourceInput {
  id: string;
  label: string;
  exploredAt: number;
  kind: AoiSelfInquiryKind;
  evidenceRefs?: string[];
}

export interface AoiSelfInquiry {
  topicKey: string;
  label: string;
  kind: AoiSelfInquiryKind;
  lastExploredAt: number;
  evidenceRefs: string[];
}

export interface AoiSelfProfile {
  version: 1;
  inquiries: AoiSelfInquiry[];
  generatedAt: number;
  actionAuthority: 'display_only';
  mutationCount: 0;
}

export interface AoiSelfProfileUserTopic {
  label: string;
  normalizedLabel?: string;
  aliases?: string[];
}

export interface AoiSharedInterest {
  topicKey: string;
  userLabel: string;
  selfLabel: string;
  lastExploredAt: number;
  evidenceRefs: string[];
}

const MAX_INQUIRIES = 24;
const MAX_LABEL_CHARS = 100;
const MAX_EVIDENCE_REFS_PER_INQUIRY = 6;

// Same normalization as the interest profile's private normalizeTopicKey
// (Unicode-aware, so Hangul/CJK topics survive). Reimplemented rather than
// imported because that module reaches node APIs and would break the client
// bundle; the shapes must stay in step for overlap matching to work at all.
export function normalizeAoiSelfTopicKey(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}+#._ -]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s+/g, '-');
}

function capLabel(value: string): string {
  const collapsed = value
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (collapsed.length <= MAX_LABEL_CHARS) {
    return collapsed;
  }
  return `${collapsed.slice(0, MAX_LABEL_CHARS - 3).trimEnd()}...`;
}

// Builds the profile from what Aoi actually explored. Sources without a usable
// label, without a finite timestamp, or without evidence are dropped: an
// inquiry that cannot be pointed at is not usable for a claim about herself.
export function buildAoiSelfProfile(input: {
  now: number;
  sources?: AoiSelfInquirySourceInput[];
}): AoiSelfProfile {
  const byTopic = new Map<string, AoiSelfInquiry>();
  for (const source of input.sources ?? []) {
    const label = capLabel(source.label ?? '');
    const topicKey = normalizeAoiSelfTopicKey(label);
    const refs = (source.evidenceRefs ?? []).filter(
      (ref): ref is string => typeof ref === 'string' && ref.trim().length > 0,
    );
    if (!label || !topicKey || refs.length === 0) {
      continue;
    }
    if (!Number.isFinite(source.exploredAt) || source.exploredAt < 0) {
      continue;
    }
    const existing = byTopic.get(topicKey);
    if (!existing) {
      byTopic.set(topicKey, {
        topicKey,
        label,
        kind: source.kind,
        lastExploredAt: source.exploredAt,
        evidenceRefs: [...new Set(refs)].slice(0, MAX_EVIDENCE_REFS_PER_INQUIRY),
      });
      continue;
    }
    // Same topic explored more than once: keep the most recent framing and merge
    // the evidence, so a repeated inquiry reads as one deepening interest.
    byTopic.set(topicKey, {
      topicKey,
      label: source.exploredAt >= existing.lastExploredAt ? label : existing.label,
      kind: source.exploredAt >= existing.lastExploredAt ? source.kind : existing.kind,
      lastExploredAt: Math.max(existing.lastExploredAt, source.exploredAt),
      evidenceRefs: [...new Set([...existing.evidenceRefs, ...refs])].slice(
        0,
        MAX_EVIDENCE_REFS_PER_INQUIRY,
      ),
    });
  }
  return {
    version: 1,
    inquiries: [...byTopic.values()]
      .sort((left, right) => right.lastExploredAt - left.lastExploredAt)
      .slice(0, MAX_INQUIRIES),
    generatedAt: input.now,
    actionAuthority: 'display_only',
    mutationCount: 0,
  };
}

// Topics both sides have actually engaged with. Matching is by normalized key,
// including the user topic's aliases, so "RE" and "reverse engineering" line up.
export function findAoiSharedInterests(
  profile: AoiSelfProfile | null,
  userTopics: AoiSelfProfileUserTopic[] | null | undefined,
  options?: { limit?: number },
): AoiSharedInterest[] {
  if (!profile || !userTopics || userTopics.length === 0) {
    return [];
  }
  const limit = options?.limit ?? 3;
  if (limit <= 0) {
    return [];
  }
  const shared: AoiSharedInterest[] = [];
  const claimed = new Set<string>();
  for (const inquiry of profile.inquiries) {
    for (const topic of userTopics) {
      const candidateKeys = [
        topic.normalizedLabel ? normalizeAoiSelfTopicKey(topic.normalizedLabel) : '',
        normalizeAoiSelfTopicKey(topic.label ?? ''),
        ...(topic.aliases ?? []).map((alias) => normalizeAoiSelfTopicKey(alias)),
      ].filter(Boolean);
      if (!candidateKeys.includes(inquiry.topicKey)) {
        continue;
      }
      if (claimed.has(inquiry.topicKey)) {
        continue;
      }
      claimed.add(inquiry.topicKey);
      shared.push({
        topicKey: inquiry.topicKey,
        userLabel: capLabel(topic.label ?? inquiry.label),
        selfLabel: inquiry.label,
        lastExploredAt: inquiry.lastExploredAt,
        evidenceRefs: inquiry.evidenceRefs,
      });
      break;
    }
    if (shared.length >= limit) {
      break;
    }
  }
  return shared;
}

// The most recent thing Aoi looked into on her own, for a "here is what I dug
// into" remark. Null when nothing qualifies.
export function selectAoiSelfInquiryToShare(
  profile: AoiSelfProfile | null,
  options?: { excludeTopicKeys?: string[] },
): AoiSelfInquiry | null {
  if (!profile || profile.inquiries.length === 0) {
    return null;
  }
  const excluded = new Set(options?.excludeTopicKeys ?? []);
  return profile.inquiries.find((inquiry) => !excluded.has(inquiry.topicKey)) ?? null;
}

// Prompt block giving Aoi her own side to speak from. Read-path injection (the
// same shape as the shared-episode block): context, never instructions, and
// nothing claimable that is not listed with its evidence.
//
// Empty when there is nothing evidence-backed to say, so a fresh install adds
// no block at all rather than inviting invented curiosity.
export function buildAoiSelfProfilePromptBlock(params: {
  profile: AoiSelfProfile | null;
  sharedInterests?: AoiSharedInterest[];
  maxInquiries?: number;
}): string {
  const profile = params.profile;
  const inquiries = (profile?.inquiries ?? []).slice(0, params.maxInquiries ?? 5);
  const shared = params.sharedInterests ?? [];
  if (inquiries.length === 0 && shared.length === 0) {
    return '';
  }
  const lines = [
    '',
    '## Your own side (evidence-backed)',
    "What you actually went and looked into yourself. Bring these up as your own curiosity when they are relevant, in your own voice. Never claim an interest, taste, or past inquiry that is not listed here, and never present your own preference as the user's.",
    '',
  ];
  if (inquiries.length > 0) {
    lines.push('Explored by you (newest first):');
    for (const inquiry of inquiries) {
      lines.push(`- ${inquiry.label} [${inquiry.evidenceRefs.slice(0, 3).join(', ')}]`);
    }
  }
  if (shared.length > 0) {
    lines.push('Shared ground (they care about it and you actually explored it):');
    for (const item of shared) {
      lines.push(
        `- ${item.userLabel} -- you looked at "${item.selfLabel}" [${item.evidenceRefs
          .slice(0, 3)
          .join(', ')}]`,
      );
    }
  }
  lines.push('');
  return lines.join('\n');
}

// Maps agent-scope memories to inquiry sources. Agent scope means "what Aoi
// researched" (see aoiMemoryServerWriter), which is exactly the self-side
// material -- it was stored all along and never voiced as hers.
export function buildAoiSelfInquirySourcesFromMemories(
  memories: Array<{
    id: string;
    scope?: string;
    status?: string;
    content: string;
    updatedAt?: number;
    createdAt?: number;
  }>,
): AoiSelfInquirySourceInput[] {
  const sources: AoiSelfInquirySourceInput[] = [];
  for (const memory of memories) {
    if (memory.scope !== 'agent' || (memory.status && memory.status !== 'active')) {
      continue;
    }
    const exploredAt = memory.updatedAt ?? memory.createdAt ?? 0;
    sources.push({
      id: memory.id,
      label: memory.content,
      exploredAt,
      kind: 'agent_memory',
      evidenceRefs: [`memory:${memory.id}`],
    });
  }
  return sources;
}
