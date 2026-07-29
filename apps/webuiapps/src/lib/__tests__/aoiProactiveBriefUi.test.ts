import { describe, expect, it } from 'vitest';
import { DEFAULT_AOI_AUTONOMY_POLICY } from '../aoiAutonomyPolicy';
import type { AoiProactiveBriefCandidate, AoiProactiveBriefSource } from '../aoiAutonomyTypes';
import { buildAoiProactiveBriefPanelModel } from '../aoiProactiveBriefUi';

const NOW = 1_000_000;

function makeSource(partial: Partial<AoiProactiveBriefSource> = {}): AoiProactiveBriefSource {
  return {
    title: partial.title ?? 'Source',
    url: partial.url ?? 'https://example.com/a',
    host: partial.host ?? 'example.com',
    retrievedAt: partial.retrievedAt ?? NOW,
    snippet: partial.snippet ?? 'snippet',
    ...(partial.publishedAt ? { publishedAt: partial.publishedAt } : {}),
    ...(partial.mediaKind ? { mediaKind: partial.mediaKind } : {}),
  };
}

function makeCandidate(
  partial: Partial<AoiProactiveBriefCandidate> = {},
): AoiProactiveBriefCandidate {
  return {
    version: 1,
    id: partial.id ?? 'aoi-brief-ui-test',
    sessionPath: partial.sessionPath ?? 'aoi/default',
    topicId: partial.topicId ?? 'aoi-interest-re',
    topicLabel: partial.topicLabel ?? 'Reverse Engineering',
    status: partial.status ?? 'candidate',
    title: partial.title ?? 'Interest brief',
    hook: partial.hook ?? 'A fresh item matches your interests.',
    summary: partial.summary ?? 'Summary.',
    whyForOperator: partial.whyForOperator ?? 'Matches saved interests.',
    noveltyReason: partial.noveltyReason ?? 'New source.',
    sources: partial.sources ?? [makeSource({ mediaKind: 'article' })],
    ...(partial.mediaBucket ? { mediaBucket: partial.mediaBucket } : {}),
    ...(partial.interestKind ? { interestKind: partial.interestKind } : {}),
    evidenceRefs: partial.evidenceRefs ?? ['source:example.com'],
    memoryIds: partial.memoryIds ?? ['memory-re-001'],
    score: partial.score ?? 0.8,
    confidence: partial.confidence ?? 0.8,
    risk: partial.risk ?? 'low',
    freshness: partial.freshness ?? { searchedAt: NOW, cannotKnow: [] },
    delivery: partial.delivery ?? { allowedModes: ['dashboard'] },
    cooldownKey: partial.cooldownKey ?? 'interest:re',
    createdAt: partial.createdAt ?? NOW,
    updatedAt: partial.updatedAt ?? NOW,
    expiresAt: partial.expiresAt ?? NOW + 1000,
  };
}

function buildPanel(candidate: AoiProactiveBriefCandidate) {
  return buildAoiProactiveBriefPanelModel({
    candidates: [candidate],
    policy: DEFAULT_AOI_AUTONOMY_POLICY,
    profile: null,
    feedback: [],
    cooldownState: null,
    includeHidden: true,
    context: { now: NOW, quietMode: false, directChatOptIn: false },
  });
}

function buildVoicedPanel(candidate: AoiProactiveBriefCandidate) {
  return buildAoiProactiveBriefPanelModel({
    candidates: [candidate],
    policy: DEFAULT_AOI_AUTONOMY_POLICY,
    profile: null,
    feedback: [],
    cooldownState: null,
    includeHidden: true,
    context: { now: NOW, quietMode: false, directChatOptIn: false },
    voice: { lang: 'ko' },
  });
}

describe('buildAoiProactiveBriefPanelModel companion voice', () => {
  it('keeps the stored operator-register copy when no voice is supplied', () => {
    const card = buildPanel(makeCandidate())?.cards[0];

    expect(card?.hook).toBe('A fresh item matches your interests.');
    expect(card?.whyForOperator).toBe('Matches saved interests.');
    expect(card?.feedbackActions[0]?.label).toBe('Useful');
    expect(card?.feedbackActions[0]?.title).toBe('Tell Aoi this topic and timing were useful.');
  });

  it('recomposes the hook, the reason, and the chips in the companion register', () => {
    const card = buildVoicedPanel(makeCandidate({ interestKind: 'personal' }))?.cards[0];

    expect(card?.hook).toContain('Reverse Engineering');
    expect(card?.hook).toContain('읽어볼 만한 자료');
    expect(card?.whyForOperator).toContain('좋아하는');
    expect(card?.feedbackActions[0]?.label).toBe('유용해');
    expect(card?.feedbackActions[0]?.title).not.toContain('Aoi');
    // The expanded summary reuses the companion reason, not the stored one.
    expect(card?.expandedSummaryLabel).toContain('좋아하는');
    expect(card?.expandedSummaryLabel).not.toContain('Matches saved interests.');
  });

  it('falls back to the professional phrasing when the topic kind is unknown', () => {
    const personal = buildVoicedPanel(makeCandidate({ interestKind: 'personal' }))?.cards[0];
    const unclassified = buildVoicedPanel(makeCandidate())?.cards[0];

    expect(unclassified?.whyForOperator).toContain('파고 있던');
    expect(unclassified?.whyForOperator).not.toBe(personal?.whyForOperator);
  });

  it('localizes the archived-card chip pair too', () => {
    const archived = buildVoicedPanel(makeCandidate({ status: 'archived' }))?.cards[0];
    const active = buildVoicedPanel(makeCandidate())?.cards[0];

    expect(archived?.feedbackActions.at(-1)?.action).toBe('expand_summary');
    expect(archived?.feedbackActions.at(-1)?.label).toBe('자세히');
    expect(active?.feedbackActions.at(-1)?.action).toBe('archive_brief');
    expect(active?.feedbackActions.at(-1)?.label).toBe('보관');
  });
});

describe('buildAoiProactiveBriefPanelModel media grouping', () => {
  it('derives a watch bucket from video sources', () => {
    const panel = buildPanel(
      makeCandidate({
        sources: [
          makeSource({
            host: 'youtube.com',
            mediaKind: 'video',
            url: 'https://youtube.com/watch?v=x',
          }),
          makeSource({ host: 'youtu.be', mediaKind: 'video', url: 'https://youtu.be/y' }),
        ],
      }),
    );
    expect(panel.cards[0].mediaBucket).toBe('watch');
    expect(panel.cards[0].mediaBucketLabel).toBe('Watch');
    expect(panel.cards[0].sources[0].mediaKindLabel).toBe('video');
  });

  it('derives a listen bucket from podcast and music sources', () => {
    const panel = buildPanel(
      makeCandidate({
        sources: [
          makeSource({ host: 'overcast.fm', mediaKind: 'podcast' }),
          makeSource({ host: 'soundcloud.com', mediaKind: 'music' }),
        ],
      }),
    );
    expect(panel.cards[0].mediaBucket).toBe('listen');
    expect(panel.cards[0].mediaBucketLabel).toBe('Listen');
  });

  it('defaults to a read bucket for article sources', () => {
    const panel = buildPanel(makeCandidate());
    expect(panel.cards[0].mediaBucket).toBe('read');
    expect(panel.cards[0].mediaBucketLabel).toBe('Read');
    expect(panel.cards[0].sources[0].mediaKindLabel).toBe('article');
  });

  it('respects a stored candidate mediaBucket over source-derived kinds', () => {
    const panel = buildPanel(
      makeCandidate({ mediaBucket: 'watch', sources: [makeSource({ mediaKind: 'article' })] }),
    );
    expect(panel.cards[0].mediaBucket).toBe('watch');
  });

  it('classifies source kind lazily when mediaKind is absent', () => {
    const panel = buildPanel(
      makeCandidate({
        sources: [makeSource({ host: 'youtube.com', url: 'https://youtube.com/watch?v=z' })],
      }),
    );
    expect(panel.cards[0].sources[0].mediaKindLabel).toBe('video');
    expect(panel.cards[0].mediaBucket).toBe('watch');
  });
});
