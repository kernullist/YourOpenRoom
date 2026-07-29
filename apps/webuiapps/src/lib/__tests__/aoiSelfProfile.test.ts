import { describe, expect, it } from 'vitest';

import {
  buildAoiSelfInquirySourcesFromMemories,
  buildAoiSelfProfile,
  buildAoiSelfProfilePromptBlock,
  findAoiSharedInterests,
  normalizeAoiSelfTopicKey,
  selectAoiSelfInquiryToShare,
  type AoiSelfInquirySourceInput,
} from '../aoiSelfProfile';

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;

function source(partial: Partial<AoiSelfInquirySourceInput>): AoiSelfInquirySourceInput {
  const id = partial.id ?? 'run-1';
  return {
    id,
    label: partial.label ?? 'kernel telemetry',
    exploredAt: partial.exploredAt ?? NOW,
    kind: partial.kind ?? 'research_run',
    // Default the ref off the id so each fixture is traceable to its own source.
    evidenceRefs: partial.evidenceRefs ?? [`research:${id}`],
  };
}

describe('buildAoiSelfProfile', () => {
  it('keeps only inquiries that can be pointed at', () => {
    const profile = buildAoiSelfProfile({
      now: NOW,
      sources: [
        source({ id: 'ok', label: 'TPM attestation' }),
        // No evidence: Aoi cannot claim to have looked into it.
        source({ id: 'no-refs', label: 'unfounded topic', evidenceRefs: [] }),
        source({ id: 'blank-refs', label: 'also unfounded', evidenceRefs: ['  '] }),
        // No usable label / key.
        source({ id: 'blank', label: '   ' }),
        source({ id: 'symbols', label: '!!!' }),
        // Impossible timestamps.
        source({ id: 'nan', label: 'bad time', exploredAt: Number.NaN }),
        source({ id: 'negative', label: 'worse time', exploredAt: -5 }),
      ],
    });

    expect(profile.inquiries.map((item) => item.label)).toEqual(['TPM attestation']);
    expect(profile.actionAuthority).toBe('display_only');
    expect(profile.mutationCount).toBe(0);
    expect(profile.generatedAt).toBe(NOW);
  });

  it('merges a repeated topic into one deepening interest', () => {
    const profile = buildAoiSelfProfile({
      now: NOW,
      sources: [
        source({
          id: 'first',
          label: 'IRQL violations',
          exploredAt: NOW - 5 * HOUR,
          evidenceRefs: ['research:first'],
        }),
        source({
          id: 'second',
          label: 'IRQL Violations',
          exploredAt: NOW - HOUR,
          kind: 'agent_memory',
          evidenceRefs: ['memory:second', 'research:first'],
        }),
      ],
    });

    expect(profile.inquiries).toHaveLength(1);
    const inquiry = profile.inquiries[0];
    // The most recent framing wins; evidence accumulates without duplicates.
    expect(inquiry.label).toBe('IRQL Violations');
    expect(inquiry.kind).toBe('agent_memory');
    expect(inquiry.lastExploredAt).toBe(NOW - HOUR);
    expect(inquiry.evidenceRefs).toEqual(['research:first', 'memory:second']);
  });

  it('keeps an earlier framing when the later record is older', () => {
    const profile = buildAoiSelfProfile({
      now: NOW,
      sources: [
        source({ id: 'newer', label: 'Newer framing', exploredAt: NOW }),
        source({
          id: 'older',
          label: 'newer framing',
          exploredAt: NOW - 10 * HOUR,
          kind: 'agent_memory',
          evidenceRefs: ['memory:older'],
        }),
      ],
    });

    expect(profile.inquiries[0].label).toBe('Newer framing');
    expect(profile.inquiries[0].kind).toBe('research_run');
  });

  it('orders newest first and caps the list', () => {
    const profile = buildAoiSelfProfile({
      now: NOW,
      sources: Array.from({ length: 30 }, (_unused, index) =>
        source({
          id: `run-${index}`,
          label: `topic ${index}`,
          exploredAt: NOW - index * HOUR,
          evidenceRefs: [`research:run-${index}`],
        }),
      ),
    });

    expect(profile.inquiries).toHaveLength(24);
    expect(profile.inquiries[0].label).toBe('topic 0');
    expect(profile.inquiries[23].label).toBe('topic 23');
  });

  it('caps a long label', () => {
    const profile = buildAoiSelfProfile({
      now: NOW,
      sources: [source({ label: 'z'.repeat(300) })],
    });
    expect(profile.inquiries[0].label.length).toBeLessThanOrEqual(100);
    expect(profile.inquiries[0].label.endsWith('...')).toBe(true);
  });

  it('handles no sources at all', () => {
    expect(buildAoiSelfProfile({ now: NOW }).inquiries).toEqual([]);
    expect(buildAoiSelfProfile({ now: NOW, sources: [] }).inquiries).toEqual([]);
  });
});

describe('normalizeAoiSelfTopicKey', () => {
  it('keeps non-Latin topics usable', () => {
    expect(normalizeAoiSelfTopicKey('커널 안티치트')).toBe('커널-안티치트');
    expect(normalizeAoiSelfTopicKey('Reverse Engineering')).toBe('reverse-engineering');
    expect(normalizeAoiSelfTopicKey('C++ & Rust')).toBe('c++-and-rust');
    expect(normalizeAoiSelfTopicKey('  !!!  ')).toBe('');
  });
});

describe('findAoiSharedInterests', () => {
  const profile = buildAoiSelfProfile({
    now: NOW,
    sources: [
      source({ id: 'a', label: 'Reverse Engineering', exploredAt: NOW }),
      source({ id: 'b', label: 'TPM attestation', exploredAt: NOW - HOUR }),
      source({ id: 'c', label: 'Unrelated hobby', exploredAt: NOW - 2 * HOUR }),
    ],
  });

  it('matches on label, normalized label, and alias', () => {
    const byLabel = findAoiSharedInterests(profile, [{ label: 'Reverse Engineering' }]);
    expect(byLabel.map((item) => item.topicKey)).toEqual(['reverse-engineering']);

    const byNormalized = findAoiSharedInterests(profile, [
      { label: 'Something else', normalizedLabel: 'tpm attestation' },
    ]);
    expect(byNormalized.map((item) => item.topicKey)).toEqual(['tpm-attestation']);

    const byAlias = findAoiSharedInterests(profile, [
      { label: 'RE work', aliases: ['reverse engineering'] },
    ]);
    expect(byAlias[0].userLabel).toBe('RE work');
    expect(byAlias[0].selfLabel).toBe('Reverse Engineering');
    expect(byAlias[0].evidenceRefs).toEqual(['research:a']);
  });

  it('stays silent without a real match', () => {
    expect(findAoiSharedInterests(profile, [{ label: 'gardening' }])).toEqual([]);
    expect(findAoiSharedInterests(profile, [])).toEqual([]);
    expect(findAoiSharedInterests(profile, null)).toEqual([]);
    expect(findAoiSharedInterests(null, [{ label: 'Reverse Engineering' }])).toEqual([]);
  });

  it('reports each shared topic once and respects the limit', () => {
    const duplicated = findAoiSharedInterests(profile, [
      { label: 'Reverse Engineering' },
      { label: 'reverse engineering' },
      { label: 'TPM attestation' },
    ]);
    expect(duplicated.map((item) => item.topicKey)).toEqual([
      'reverse-engineering',
      'tpm-attestation',
    ]);

    expect(
      findAoiSharedInterests(
        profile,
        [{ label: 'Reverse Engineering' }, { label: 'TPM attestation' }],
        { limit: 1 },
      ),
    ).toHaveLength(1);
    expect(
      findAoiSharedInterests(profile, [{ label: 'Reverse Engineering' }], { limit: 0 }),
    ).toEqual([]);
  });
});

describe('selectAoiSelfInquiryToShare', () => {
  it('offers the most recent inquiry, skipping excluded topics', () => {
    const profile = buildAoiSelfProfile({
      now: NOW,
      sources: [
        source({ id: 'new', label: 'Newest topic', exploredAt: NOW }),
        source({ id: 'old', label: 'Older topic', exploredAt: NOW - HOUR }),
      ],
    });

    expect(selectAoiSelfInquiryToShare(profile)?.label).toBe('Newest topic');
    expect(
      selectAoiSelfInquiryToShare(profile, { excludeTopicKeys: ['newest-topic'] })?.label,
    ).toBe('Older topic');
    expect(
      selectAoiSelfInquiryToShare(profile, {
        excludeTopicKeys: ['newest-topic', 'older-topic'],
      }),
    ).toBeNull();
    expect(selectAoiSelfInquiryToShare(null)).toBeNull();
    expect(selectAoiSelfInquiryToShare(buildAoiSelfProfile({ now: NOW }))).toBeNull();
  });
});

describe('buildAoiSelfProfilePromptBlock', () => {
  const profile = buildAoiSelfProfile({
    now: NOW,
    sources: [
      source({ id: 'a', label: 'Reverse Engineering', exploredAt: NOW }),
      source({ id: 'b', label: 'TPM attestation', exploredAt: NOW - HOUR }),
    ],
  });

  it('lists inquiries with their evidence and states the no-invention rule', () => {
    const block = buildAoiSelfProfilePromptBlock({ profile });

    expect(block).toContain('## Your own side (evidence-backed)');
    expect(block).toContain('- Reverse Engineering [research:a]');
    expect(block).toContain('- TPM attestation [research:b]');
    expect(block).toContain('Never claim an interest, taste, or past inquiry that is not listed');
    expect(block).toContain("never present your own preference as the user's");
  });

  it('calls out shared ground separately', () => {
    const block = buildAoiSelfProfilePromptBlock({
      profile,
      sharedInterests: findAoiSharedInterests(profile, [
        { label: 'RE work', aliases: ['reverse engineering'] },
      ]),
    });

    expect(block).toContain('Shared ground');
    expect(block).toContain('RE work -- you looked at "Reverse Engineering" [research:a]');
  });

  it('adds nothing when there is nothing evidence-backed to say', () => {
    expect(buildAoiSelfProfilePromptBlock({ profile: null })).toBe('');
    expect(buildAoiSelfProfilePromptBlock({ profile: buildAoiSelfProfile({ now: NOW }) })).toBe('');
  });

  it('respects the inquiry cap', () => {
    const block = buildAoiSelfProfilePromptBlock({ profile, maxInquiries: 1 });
    expect(block).toContain('Reverse Engineering');
    expect(block).not.toContain('TPM attestation');
  });
});

describe('buildAoiSelfInquirySourcesFromMemories', () => {
  it('takes only active agent-scope memories, which are what Aoi researched', () => {
    const sources = buildAoiSelfInquirySourcesFromMemories([
      {
        id: 'm1',
        scope: 'agent',
        status: 'active',
        content: 'kernel telemetry survey',
        updatedAt: NOW,
      },
      // The user's own memories are not Aoi's inquiries.
      { id: 'm2', scope: 'user', status: 'active', content: 'user prefers Korean', updatedAt: NOW },
      // Archived/superseded research is no longer a live curiosity.
      { id: 'm3', scope: 'agent', status: 'archived', content: 'old survey', updatedAt: NOW },
    ]);

    expect(sources).toEqual([
      {
        id: 'm1',
        label: 'kernel telemetry survey',
        exploredAt: NOW,
        kind: 'agent_memory',
        evidenceRefs: ['memory:m1'],
      },
    ]);
  });

  it('falls back to createdAt and tolerates a missing status', () => {
    const sources = buildAoiSelfInquirySourcesFromMemories([
      { id: 'm4', scope: 'agent', content: 'no status', createdAt: NOW - HOUR },
    ]);
    expect(sources[0].exploredAt).toBe(NOW - HOUR);
  });

  it('yields nothing for an empty list', () => {
    expect(buildAoiSelfInquirySourcesFromMemories([])).toEqual([]);
  });
});
