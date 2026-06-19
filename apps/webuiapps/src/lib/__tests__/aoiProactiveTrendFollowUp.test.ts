import { describe, expect, it } from 'vitest';
import type { AoiProactiveTrendOpinionCard } from '../aoiAutonomyTypes';
import {
  buildAoiProactiveTrendFollowUpContext,
  buildAoiProactiveTrendFollowUpPromptBlock,
  classifyAoiProactiveTrendFollowUpFeedback,
} from '../aoiProactiveTrendFollowUp';

const NOW = Date.parse('2026-06-19T00:00:00.000Z');

function makeTrendCard(
  partial: Partial<AoiProactiveTrendOpinionCard> = {},
): AoiProactiveTrendOpinionCard {
  return {
    version: 1,
    id: partial.id ?? 'trend-card-re',
    snapshotId: partial.snapshotId ?? 'trend-snapshot-re',
    candidateId: partial.candidateId ?? 'brief-re',
    topicId: partial.topicId ?? 'topic-re',
    topicLabel: partial.topicLabel ?? 'Reverse Engineering',
    title: partial.title ?? 'Fresh reversing writeup trend',
    whatChanged: partial.whatChanged ?? 'Two independent reversing writeups appeared.',
    whyItMatters: partial.whyItMatters ?? 'It maps to a pinned RE interest.',
    myTake:
      partial.myTake ??
      'This is worth a short review because the sources overlap with saved interests.',
    suggestedNextAction: partial.suggestedNextAction ?? 'Skim the sources and save the useful one.',
    confidenceLabel: partial.confidenceLabel ?? 'High (0.86)',
    freshnessLabel: partial.freshnessLabel ?? 'Fresh source evidence',
    noveltyLabel: partial.noveltyLabel ?? 'New signal (0.84)',
    sourceQualityLabel: partial.sourceQualityLabel ?? 'Source strong (0.92, 2 hosts)',
    interestDriftLabel: partial.interestDriftLabel ?? 'Interest aligned (0.88)',
    deliveryMode: partial.deliveryMode ?? 'direct_chat',
    deliverySummary: partial.deliverySummary ?? 'Direct chat allowed.',
    controlSummary: partial.controlSummary ?? 'No active suppression.',
    sourceHosts: partial.sourceHosts ?? ['research.example.com', 'security.example.net'],
    followUpPrompts: partial.followUpPrompts ?? [
      'Aoi, dig deeper into "Fresh reversing writeup trend" and compare the strongest evidence.',
      'Aoi, open the source evidence for "Fresh reversing writeup trend" from research.example.com.',
    ],
    directChatAllowed: partial.directChatAllowed ?? true,
    directChatBlockedReasons: partial.directChatBlockedReasons ?? [],
    quietUntil: partial.quietUntil,
    snoozedUntil: partial.snoozedUntil,
    chatHookText: partial.chatHookText ?? 'Aoi trend signal for Reverse Engineering.',
    evidenceRefs: partial.evidenceRefs ?? [
      'source:research.example.com',
      'source:security.example.net',
    ],
    createdAt: partial.createdAt ?? NOW,
  };
}

describe('Aoi proactive trend follow-up context', () => {
  it('builds a bounded context capsule from a trend card and prompt', () => {
    const context = buildAoiProactiveTrendFollowUpContext(
      makeTrendCard({
        sourceHosts: ['research.example.com', 'research.example.com', 'security.example.net'],
      }),
      '  Aoi, dig deeper into this.  ',
      NOW,
    );

    expect(context).toMatchObject({
      version: 1,
      prompt: 'Aoi, dig deeper into this.',
      cardId: 'trend-card-re',
      snapshotId: 'trend-snapshot-re',
      candidateId: 'brief-re',
      topicId: 'topic-re',
      topicLabel: 'Reverse Engineering',
      title: 'Fresh reversing writeup trend',
      createdAt: NOW,
    });
    expect(context?.sourceHosts).toEqual(['research.example.com', 'security.example.net']);
    expect(context?.evidenceRefs).toEqual([
      'source:research.example.com',
      'source:security.example.net',
    ]);
  });

  it('injects saved trend context without claiming source pages were opened', () => {
    const context = buildAoiProactiveTrendFollowUpContext(
      makeTrendCard(),
      'Aoi, open the source evidence for "Fresh reversing writeup trend" from research.example.com.',
      NOW,
    );

    const block = buildAoiProactiveTrendFollowUpPromptBlock(context);

    expect(block).toContain('Aoi proactive trend follow-up context:');
    expect(block).toContain('Trend: Fresh reversing writeup trend');
    expect(block).toContain('Topic: Reverse Engineering (topic-re)');
    expect(block).toContain('Snapshot: trend-snapshot-re, candidate brief-re');
    expect(block).toContain('Source hosts: research.example.com, security.example.net');
    expect(block).toContain(
      'Evidence refs: source:research.example.com, source:security.example.net',
    );
    expect(block).toContain('Do not claim that URLs or pages were opened');
  });

  it('classifies source-opening follow-ups separately from expansion prompts', () => {
    expect(classifyAoiProactiveTrendFollowUpFeedback('Aoi, open the source evidence.')).toBe(
      'open_sources',
    );
    expect(classifyAoiProactiveTrendFollowUpFeedback('Aoi, 링크 근거를 열어줘.')).toBe(
      'open_sources',
    );
    expect(classifyAoiProactiveTrendFollowUpFeedback('Aoi, turn this into a research plan.')).toBe(
      'expand_summary',
    );
  });
});
