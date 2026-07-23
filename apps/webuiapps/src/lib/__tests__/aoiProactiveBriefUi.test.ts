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
