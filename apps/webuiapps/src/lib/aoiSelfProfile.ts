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

// Research-completion memories are stored as audit prose by
// aoiMemoryServerWriter:
//   Aoi completed research "TITLE" on YYYY-MM-DD. Findings: ...
// That string is useful for recall/dedup, but speaking it as a topic label
// produces companion lines like
//   "나 요즘 Aoi completed research "TITLE" on ... 쪽 혼자 좀 들여다봤어."
// Extract a human topic title before any user-facing self-inquiry use.
//
// Only the audit PREFIX is authoritative. Tags like `research` / `aoi-research`
// also appear on ordinary interest memories, so tags alone must never trigger
// audit stripping (that would eat legitimate "Findings:" prose in other facts).
const RESEARCH_COMPLETED_PREFIX_RE = /^Aoi completed research\b/i;
// Clean quoted title: only requires a closing quote. Truncated mid-title
// content (memory body is capped at 360 chars) has no closer, so it fails here
// and the caller falls through to entities[0] instead of speaking a stump.
const RESEARCH_COMPLETED_TITLE_RE = /^Aoi completed research\s+"([^"]+)"/i;

function collapseLabelText(value: string): string {
  return value
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isResearchAuditContent(content: string): boolean {
  return RESEARCH_COMPLETED_PREFIX_RE.test(collapseLabelText(content));
}

function isUsableEntityLabel(value: string): boolean {
  if (value.length < 2) {
    return false;
  }
  // Skip date stamps and research/run ids that research memories also store.
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) {
    return false;
  }
  if (/^(?:run_|research_|mem_|memory_)/i.test(value)) {
    return false;
  }
  // Common run-id shapes: aoi-research-..., uuid-like, pure hex blobs.
  if (/^aoi-research(?:-|$)/i.test(value)) {
    return false;
  }
  if (/^[a-f0-9]{8,}(?:-[a-f0-9]+)+$/i.test(value)) {
    return false;
  }
  if (/^[a-f0-9]{16,}$/i.test(value)) {
    return false;
  }
  return Boolean(normalizeAoiSelfTopicKey(value));
}

function pickEntityLabel(entities: string[] | undefined): string {
  for (const entity of entities ?? []) {
    const cleaned = collapseLabelText(entity ?? '');
    if (isUsableEntityLabel(cleaned)) {
      return cleaned;
    }
  }
  return '';
}

function isWeakTopicLabel(value: string): boolean {
  if (!value || !isUsableEntityLabel(value)) {
    return true;
  }
  // Exact residual tokens after peeling -- not natural-language titles that
  // merely begin with English words like "On-device attestation".
  if (/^(?:on|findings|accepted|claims|run)$/i.test(value)) {
    return true;
  }
  if (/^(?:accepted|claims|run)=\S*$/i.test(value)) {
    return true;
  }
  if (/^on\s+\d{4}-\d{2}-\d{2}\b/i.test(value)) {
    return true;
  }
  // Truncation ellipsis from truncateAoiMemoryContent -- partial titles are not
  // trustworthy when a full entity title may still be available.
  if (/\.\.\.$|…$/.test(value)) {
    return true;
  }
  // Still looks like audit prose rather than a topic.
  if (/Aoi completed research/i.test(value)) {
    return true;
  }
  if (
    /\bFindings\s*:/i.test(value) ||
    /\baccepted=\d+/i.test(value) ||
    /\brun=[\w-]+/i.test(value)
  ) {
    return true;
  }
  return false;
}

function extractQuotedResearchTitle(content: string): string {
  const cleaned = collapseLabelText(content);
  const quoted = cleaned.match(RESEARCH_COMPLETED_TITLE_RE);
  if (!quoted?.[1]) {
    return '';
  }
  const title = collapseLabelText(quoted[1]);
  // Reject titles that look truncated mid-string even if a closing quote somehow
  // landed (defensive; the writer should not produce this).
  if (!title || isWeakTopicLabel(title)) {
    return '';
  }
  return title;
}

function stripResearchAuditBoilerplate(content: string): string {
  let cleaned = collapseLabelText(content);
  if (!cleaned || !isResearchAuditContent(cleaned)) {
    return '';
  }
  const quoted = extractQuotedResearchTitle(cleaned);
  if (quoted) {
    return quoted;
  }
  // Partial / already-truncated audit text: peel known tails until a title remains.
  cleaned = cleaned.replace(RESEARCH_COMPLETED_PREFIX_RE, '').trim();
  cleaned = cleaned.replace(/^["'“”]+|["'“”]+$/g, '').trim();
  cleaned = cleaned.replace(/^(?:on\s+)?\d{4}-\d{2}-\d{2}\b.*$/i, '').trim();
  cleaned = cleaned.replace(/\s+on\s+\d{4}-\d{2}-\d{2}\b.*$/i, '').trim();
  cleaned = cleaned.replace(/\s*Findings\s*:.*$/i, '').trim();
  cleaned = cleaned.replace(/\s*accepted=\d+\b.*$/i, '').trim();
  cleaned = cleaned.replace(/\s*claims=\d+\b.*$/i, '').trim();
  cleaned = cleaned.replace(/\s*run=[\w-]+\b.*$/i, '').trim();
  cleaned = cleaned.replace(/^["'“”]+|["'“”]+$/g, '').trim();
  // Drop trailing truncation markers left by the 360-char content cap.
  cleaned = cleaned.replace(/(?:\.\.\.|…)$/u, '').trim();
  if (isWeakTopicLabel(cleaned)) {
    return '';
  }
  return cleaned;
}

// Humanize a topic string that may still carry research-audit prose. Used by
// companion copy as defense-in-depth when a caller passes raw memory content.
// Empty string means "do not speak" -- never invent a topic.
export function humanizeAoiSelfInquiryTopicLabel(value: string | null | undefined): string {
  const content = collapseLabelText(value ?? '');
  if (!content) {
    return '';
  }
  if (!isResearchAuditContent(content)) {
    // Non-audit labels still reject residual audit fragments if a bad caller
    // concatenated them after a real title.
    if (isWeakTopicLabel(content) && /Aoi completed research|\bFindings\s*:/i.test(content)) {
      return '';
    }
    return capLabel(content);
  }
  const quoted = extractQuotedResearchTitle(content);
  if (quoted) {
    return capLabel(quoted);
  }
  const stripped = stripResearchAuditBoilerplate(content);
  return stripped ? capLabel(stripped) : '';
}

// Derive a companion-safe topic label from an agent-scope memory. Prefer a real
// research title over the audit sentence that stores findings/run metadata.
//
// Priority for research-audit content:
//   1. Clean quoted title from content (complete, non-truncated)
//   2. entities[0] (writer stores the full title there; survives 360-char content cap)
//   3. Best-effort strip of truncated audit prose
//   4. empty (silence beats speaking "Aoi completed research...")
export function deriveAoiSelfInquiryLabel(params: {
  content: string;
  entities?: string[];
  tags?: string[];
}): string {
  const content = collapseLabelText(params.content ?? '');
  const entityLabel = pickEntityLabel(params.entities);
  // tags are intentionally ignored for audit detection -- see comment above.
  void params.tags;

  if (isResearchAuditContent(content)) {
    const quoted = extractQuotedResearchTitle(content);
    if (quoted) {
      return capLabel(quoted);
    }
    if (entityLabel) {
      return capLabel(entityLabel);
    }
    const stripped = stripResearchAuditBoilerplate(content);
    return stripped ? capLabel(stripped) : '';
  }

  // Ordinary agent memories already store human-readable facts.
  return capLabel(content || entityLabel);
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
//
// Default is hard silence when every inquiry is excluded (preserves the pure
// selector contract). Callers that want "repeat the newest rather than go
// quiet forever" must opt in with allowRepeatFallback: true (ChatPanel does).
export function selectAoiSelfInquiryToShare(
  profile: AoiSelfProfile | null,
  options?: { excludeTopicKeys?: string[]; allowRepeatFallback?: boolean },
): AoiSelfInquiry | null {
  if (!profile || profile.inquiries.length === 0) {
    return null;
  }
  const excluded = new Set(options?.excludeTopicKeys ?? []);
  const preferred = profile.inquiries.find((inquiry) => !excluded.has(inquiry.topicKey)) ?? null;
  if (preferred) {
    return preferred;
  }
  if (options?.allowRepeatFallback === true) {
    return profile.inquiries[0] ?? null;
  }
  return null;
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
//
// Research-completion memories keep their audit `content` for recall, but the
// inquiry label is a human topic title (quoted research title / entities[0]),
// never the "Aoi completed research ..." sentence.
export function buildAoiSelfInquirySourcesFromMemories(
  memories: Array<{
    id: string;
    scope?: string;
    status?: string;
    content: string;
    updatedAt?: number;
    createdAt?: number;
    entities?: string[];
    tags?: string[];
  }>,
): AoiSelfInquirySourceInput[] {
  const sources: AoiSelfInquirySourceInput[] = [];
  for (const memory of memories) {
    if (memory.scope !== 'agent' || (memory.status && memory.status !== 'active')) {
      continue;
    }
    const exploredAt = memory.updatedAt ?? memory.createdAt ?? 0;
    const label = deriveAoiSelfInquiryLabel({
      content: memory.content,
      entities: memory.entities,
      tags: memory.tags,
    });
    if (!label) {
      continue;
    }
    // Kind follows content shape only -- research tags alone are not enough
    // (they also mark non-audit interest/procedure memories).
    const kind: AoiSelfInquiryKind = isResearchAuditContent(memory.content)
      ? 'research_run'
      : 'agent_memory';
    sources.push({
      id: memory.id,
      label,
      exploredAt,
      kind,
      evidenceRefs: [`memory:${memory.id}`],
    });
  }
  return sources;
}
