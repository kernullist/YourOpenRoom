// Persona/operator bridge (R7.2).
//
// This is the seam the whole relationship roadmap was written to close. Two
// lineages coexist in the system prompt with nothing joining them: a dense
// character persona (a bounty hunter with her own tastes, quirks and register)
// followed by ~150 lines of tool policy and nine appended operator-register
// blocks. Nothing ever said that the operator work IS hers, or that the policy
// blocks govern what is permitted rather than how she speaks. The persona was
// injected and then buried.
//
// The bridge is short on purpose. It states the reconciliation, summarizes the
// relationship in a few evidence-backed lines, and adds one register note. It
// does not restate the persona (already above it) and does not touch the policy
// blocks' meaning -- their semantic content is untouched by design, since those
// blocks are load-bearing safety text.
//
// Honesty: every line comes from the stored relationship record. With no record
// the block is empty, so a first-ever run gets the persona exactly as before.
//
// Pure and dependency-free (types only), so the client can build it inline.

import type { AoiMoodKind } from './aoiMoodState';

export interface AoiPersonaBridgeMilestone {
  label: string;
  occurredAt: number;
}

export interface AoiPersonaBridgeInput {
  characterName: string;
  sessionCount?: number | null;
  firstMetAt?: number | null;
  // Newest-first is not required; the most recent is selected here.
  milestones?: AoiPersonaBridgeMilestone[];
  mood?: AoiMoodKind | null;
  openThreadTitles?: string[];
  arc?: { arcName: string } | null;
}

const MAX_BLOCK_CHARS = 900;
const MAX_LINE_CHARS = 140;
const MAX_OPEN_THREADS_SHOWN = 2;

function cap(value: string, maxChars = MAX_LINE_CHARS): string {
  const collapsed = value
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (collapsed.length <= maxChars) {
    return collapsed;
  }
  return `${collapsed.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

// Plain descriptions of the stored mood. Neutral is omitted: there is nothing to
// tell the model about a background state that is not there.
const MOOD_LINE: Record<Exclude<AoiMoodKind, 'neutral'>, string> = {
  content: 'Your current background mood is settled -- recent work has been landing.',
  proud: 'Your current background mood is quietly pleased about something that landed.',
  curious: 'Your current background mood is unsettled by loose ends you have not closed.',
  worried: 'Your current background mood is uneasy -- some recent work did not land.',
};

export function buildAoiPersonaBridgeBlock(input: AoiPersonaBridgeInput): string {
  const name = cap(input.characterName, 40) || 'you';
  const facts: string[] = [];

  const sessionCount =
    typeof input.sessionCount === 'number' && Number.isFinite(input.sessionCount)
      ? Math.max(0, Math.floor(input.sessionCount))
      : 0;
  if (sessionCount > 1) {
    const since =
      typeof input.firstMetAt === 'number' && Number.isFinite(input.firstMetAt)
        ? ` since ${formatDate(input.firstMetAt)}`
        : '';
    facts.push(cap(`You have worked together across ${sessionCount} sessions${since}.`));
  }
  if (input.arc?.arcName) {
    facts.push(cap(`You finished "${cap(input.arc.arcName, 60)}" together.`));
  }
  const newestMilestone = [...(input.milestones ?? [])]
    .filter((milestone) => milestone.label)
    .sort((left, right) => (right.occurredAt ?? 0) - (left.occurredAt ?? 0))[0];
  if (newestMilestone) {
    facts.push(cap(`Most recent milestone: ${newestMilestone.label}`));
  }
  if (input.mood && input.mood !== 'neutral') {
    facts.push(cap(MOOD_LINE[input.mood]));
  }
  const openThreads = (input.openThreadTitles ?? [])
    .map((title) => cap(title, 60))
    .filter(Boolean)
    .slice(0, MAX_OPEN_THREADS_SHOWN);
  if (openThreads.length > 0) {
    facts.push(cap(`Still unresolved between you: ${openThreads.join('; ')}.`));
  }

  // No stored relationship means no bridge: the persona stands alone exactly as
  // it did before this existed.
  if (facts.length === 0) {
    return '';
  }

  const assemble = (factLines: string[]): string =>
    [
      '',
      '## Who you are in this work',
      `You are ${name}. The operator work described below -- the tools, the approval bands, the proposals, the briefs -- is YOUR work, not a separate role you switch into. Do it as yourself, in your own register.`,
      // The register note. This is the line that stops the policy prose from
      // flattening the voice; it makes no claim about what is permitted.
      'The policy and tool sections that follow define what is ALLOWED, not how you talk. Follow them exactly, and say what they mean in your own words.',
      '',
      'What you actually have with this person (on record -- never invent beyond this):',
      ...factLines.map((fact) => `- ${fact}`),
      '',
    ].join('\n');

  // Bounded by dropping the least important facts (they are appended in
  // significance order) rather than truncating mid-sentence, which would leave a
  // dangling claim about the relationship.
  const shown = [...facts];
  let block = assemble(shown);
  while (shown.length > 1 && block.length > MAX_BLOCK_CHARS) {
    shown.pop();
    block = assemble(shown);
  }
  return block;
}
