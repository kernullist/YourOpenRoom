import { describe, expect, it } from 'vitest';
import type { AoiProactiveTrendOpinionCard } from '../aoiAutonomyTypes';
import {
  buildAoiProactiveTrendFollowUpContext,
  buildAoiProactiveTrendFollowUpPromptBlock,
  buildAoiProactiveTrendSourceListText,
  classifyAoiProactiveTrendFollowUpFeedback,
  selectAoiProactiveTrendSourceToOpen,
  selectAoiProactiveTrendSourcesToOpen,
  shouldOpenAllAoiProactiveTrendSourcesFromPrompt,
  shouldOpenAoiProactiveTrendSourcesFromPrompt,
  shouldListAoiProactiveTrendSourcesFromPrompt,
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
    sources: partial.sources ?? [
      {
        title: 'Fresh reversing writeup',
        url: 'https://research.example.com/re/writeup',
        host: 'research.example.com',
        publishedAt: '2026-06-18T00:00:00.000Z',
        retrievedAt: NOW,
        snippet: 'Public source snippet.',
      },
      {
        title: 'Second reversing source',
        url: 'https://security.example.net/re/case-study',
        host: 'security.example.net',
        publishedAt: '2026-06-17T00:00:00.000Z',
        retrievedAt: NOW,
        snippet: 'Second public source snippet.',
      },
    ],
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
    expect(context?.sources).toEqual([
      expect.objectContaining({
        title: 'Fresh reversing writeup',
        url: 'https://research.example.com/re/writeup',
        host: 'research.example.com',
        snippet: 'Public source snippet.',
      }),
      expect.objectContaining({
        title: 'Second reversing source',
        url: 'https://security.example.net/re/case-study',
        host: 'security.example.net',
        snippet: 'Second public source snippet.',
      }),
    ]);
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
      '1. Fresh reversing writeup (research.example.com): https://research.example.com/re/writeup',
    );
    expect(block).toContain(
      '2. Second reversing source (security.example.net): https://security.example.net/re/case-study',
    );
    expect(block).toContain(
      'Evidence refs: source:research.example.com, source:security.example.net',
    );
    expect(block).toContain('Do not claim that URLs or pages were opened');
  });

  it('drops non-web source URLs before prompting Aoi to open evidence', () => {
    const context = buildAoiProactiveTrendFollowUpContext(
      makeTrendCard({
        sources: [
          {
            title: 'Local note',
            url: 'file:///C:/Users/kernulist/private/notes.md',
            host: 'local',
            retrievedAt: NOW,
            snippet: 'Private note.',
          },
          {
            title: 'Public reversing source',
            url: 'https://public.example.org/re',
            host: 'public.example.org',
            retrievedAt: NOW,
            snippet: 'Public note.',
          },
        ],
      }),
      'Aoi, open the source evidence.',
      NOW,
    );

    expect(context?.sources).toHaveLength(1);
    expect(context?.sources[0].url).toBe('https://public.example.org/re');
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

  it('only auto-opens sources for explicit open/visit follow-up prompts', () => {
    expect(
      shouldOpenAoiProactiveTrendSourcesFromPrompt(
        'Aoi, open the source evidence for "Fresh reversing writeup trend".',
      ),
    ).toBe(true);
    expect(shouldOpenAoiProactiveTrendSourcesFromPrompt('Aoi, 링크 근거를 열어줘.')).toBe(true);
    expect(
      shouldOpenAoiProactiveTrendSourcesFromPrompt(
        'Aoi, dig deeper and compare the strongest evidence.',
      ),
    ).toBe(false);
    expect(
      shouldOpenAoiProactiveTrendSourcesFromPrompt('Aoi, turn this trend into a research plan.'),
    ).toBe(false);
    expect(shouldOpenAoiProactiveTrendSourcesFromPrompt('Aoi, source evidence 열어줘.')).toBe(true);
    expect(shouldOpenAoiProactiveTrendSourcesFromPrompt('Aoi, open 근거 링크.')).toBe(true);
    expect(shouldOpenAoiProactiveTrendSourcesFromPrompt('Aoi, show the source evidence.')).toBe(
      false,
    );
    expect(shouldOpenAoiProactiveTrendSourcesFromPrompt('Aoi, 출처 보여줘.')).toBe(false);
    expect(shouldListAoiProactiveTrendSourcesFromPrompt('Aoi, show the source evidence.')).toBe(
      true,
    );
    expect(shouldListAoiProactiveTrendSourcesFromPrompt('Aoi, 출처 보여줘.')).toBe(true);
    expect(shouldListAoiProactiveTrendSourcesFromPrompt('Aoi, source evidence 열어줘.')).toBe(
      false,
    );
    expect(shouldListAoiProactiveTrendSourcesFromPrompt('Aoi, open 근거 링크.')).toBe(false);
    expect(shouldOpenAllAoiProactiveTrendSourcesFromPrompt('Aoi, open all source evidence.')).toBe(
      true,
    );
    expect(shouldOpenAllAoiProactiveTrendSourcesFromPrompt('Aoi, 모든 근거 링크 열어줘.')).toBe(
      true,
    );
    expect(shouldOpenAllAoiProactiveTrendSourcesFromPrompt('Aoi, 두 번째 근거 링크 열어줘.')).toBe(
      false,
    );
    expect(shouldOpenAllAoiProactiveTrendSourcesFromPrompt('Aoi, 다음 근거 링크 열어줘.')).toBe(
      false,
    );
  });

  it('selects requested source URLs for direct Browser opening', () => {
    const context = buildAoiProactiveTrendFollowUpContext(
      makeTrendCard(),
      'Aoi, open the source evidence.',
      NOW,
    );

    expect(selectAoiProactiveTrendSourceToOpen(context)).toEqual(
      expect.objectContaining({
        title: 'Fresh reversing writeup',
        url: 'https://research.example.com/re/writeup',
      }),
    );
    expect(selectAoiProactiveTrendSourceToOpen(context, 'Aoi, 두 번째 근거 링크 열어줘.')).toEqual(
      expect.objectContaining({
        title: 'Second reversing source',
        url: 'https://security.example.net/re/case-study',
      }),
    );
    expect(
      selectAoiProactiveTrendSourceToOpen(
        context,
        'Aoi, open the source evidence from security.example.net.',
      ),
    ).toEqual(
      expect.objectContaining({
        title: 'Second reversing source',
        url: 'https://security.example.net/re/case-study',
      }),
    );
    expect(
      selectAoiProactiveTrendSourceToOpen(
        context,
        'Aoi, open the source evidence for "Fresh reversing writeup trend" from security.example.net.',
      ),
    ).toEqual(
      expect.objectContaining({
        title: 'Second reversing source',
        url: 'https://security.example.net/re/case-study',
      }),
    );
    expect(
      selectAoiProactiveTrendSourceToOpen(context, 'Aoi, open Second reversing source.'),
    ).toEqual(
      expect.objectContaining({
        title: 'Second reversing source',
        url: 'https://security.example.net/re/case-study',
      }),
    );
    expect(selectAoiProactiveTrendSourceToOpen(context, 'Aoi, 이번 근거 링크 열어줘.')).toEqual(
      expect.objectContaining({
        title: 'Fresh reversing writeup',
        url: 'https://research.example.com/re/writeup',
      }),
    );
    expect(selectAoiProactiveTrendSourceToOpen(null)).toBeNull();
  });

  it('selects every saved source URL for all-source opening prompts', () => {
    const context = buildAoiProactiveTrendFollowUpContext(
      makeTrendCard(),
      'Aoi, open all source evidence.',
      NOW,
    );

    expect(selectAoiProactiveTrendSourcesToOpen(context).map((source) => source.url)).toEqual([
      'https://research.example.com/re/writeup',
      'https://security.example.net/re/case-study',
    ]);
    expect(
      selectAoiProactiveTrendSourcesToOpen(context, 'Aoi, 두 번째 근거 링크 열어줘.').map(
        (source) => source.url,
      ),
    ).toEqual(['https://security.example.net/re/case-study']);
    expect(selectAoiProactiveTrendSourcesToOpen(null)).toEqual([]);
  });

  it('builds a direct source evidence list without claiming pages were opened', () => {
    const context = buildAoiProactiveTrendFollowUpContext(
      makeTrendCard(),
      'Aoi, show the source evidence.',
      NOW,
    );

    const text = buildAoiProactiveTrendSourceListText(context);

    expect(text).toContain('저장된 근거는 2개');
    expect(text).toContain('1. Fresh reversing writeup (research.example.com)');
    expect(text).toContain('URL: https://research.example.com/re/writeup');
    expect(text).toContain('2. Second reversing source (security.example.net)');
    expect(text).toContain('URL: https://security.example.net/re/case-study');
    expect(text).not.toContain('Browser에서 열었어');
    expect(buildAoiProactiveTrendSourceListText(null)).toBe('');
  });
});
