import { describe, expect, it } from 'vitest';
import type { AoiInterestTopic } from '../aoiAutonomyTypes';
import { buildAoiProactiveBriefSearchQuery } from '../aoiProactiveBriefResearch';

function makeTopic(partial: Partial<AoiInterestTopic> = {}): AoiInterestTopic {
  return {
    version: 1,
    id: partial.id ?? 'aoi-interest-test',
    sessionPath: partial.sessionPath ?? 'aoi/default',
    label: partial.label ?? 'Reverse Engineering',
    normalizedLabel: partial.normalizedLabel ?? 'reverse-engineering',
    aliases: partial.aliases ?? [],
    source: partial.source ?? 'memory',
    ...(partial.interestKind ? { interestKind: partial.interestKind } : {}),
    memoryIds: partial.memoryIds ?? [],
    evidenceRefs: partial.evidenceRefs ?? [],
    confidence: partial.confidence ?? 0.8,
    importance: partial.importance ?? 0.8,
    noveltyPreference: partial.noveltyPreference ?? 0.6,
    currentInfoPreference: partial.currentInfoPreference ?? 0.7,
    muted: partial.muted ?? false,
    pinned: partial.pinned ?? false,
    cooldownKey: partial.cooldownKey ?? 'interest:test',
    createdAt: partial.createdAt ?? 100,
    updatedAt: partial.updatedAt ?? 200,
  };
}

describe('buildAoiProactiveBriefSearchQuery category framing', () => {
  it('uses professional framing by default', () => {
    const query = buildAoiProactiveBriefSearchQuery(
      makeTopic({ label: 'Windows Kernel Internals' }),
    );
    expect(query).toContain('Windows Kernel Internals');
    expect(query).toMatch(/talks|writeups/);
  });

  it('uses entertainment framing for personal interests', () => {
    const query = buildAoiProactiveBriefSearchQuery(
      makeTopic({ label: 'Roguelike Games', interestKind: 'personal' }),
    );
    expect(query).toContain('Roguelike Games');
    expect(query).toMatch(/reviews|recommendations|new releases/);
  });
});
