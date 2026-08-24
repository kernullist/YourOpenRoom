import { describe, expect, it } from 'vitest';

import {
  buildAoiSelfInquirySourcesFromMemories,
  buildAoiSelfProfile,
  buildAoiSelfProfilePromptBlock,
  deriveAoiSelfInquiryLabel,
  findAoiSharedInterests,
  humanizeAoiSelfInquiryTopicLabel,
  humanizeAoiSpeakableTopicLabel,
  normalizeAoiSelfTopicKey,
  selectAoiSelfInquiryToShare,
  selectAoiSpeakableSessionSummary,
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
    // Default stays silent when every topic is excluded (pure selector contract).
    expect(
      selectAoiSelfInquiryToShare(profile, {
        excludeTopicKeys: ['newest-topic', 'older-topic'],
      }),
    ).toBeNull();
    // Opt-in repeat for surfaces that prefer "say something" over silence. The
    // exclusion list is most-recently-spoken first, so the repeat is the topic
    // that has waited longest -- not the newest, which would pin the rotation.
    expect(
      selectAoiSelfInquiryToShare(profile, {
        excludeTopicKeys: ['newest-topic', 'older-topic'],
        allowRepeatFallback: true,
      })?.label,
    ).toBe('Older topic');
    expect(
      selectAoiSelfInquiryToShare(profile, {
        excludeTopicKeys: ['older-topic', 'newest-topic'],
        allowRepeatFallback: true,
      })?.label,
    ).toBe('Newest topic');
    expect(selectAoiSelfInquiryToShare(null)).toBeNull();
    expect(selectAoiSelfInquiryToShare(buildAoiSelfProfile({ now: NOW }))).toBeNull();
  });

  // Regression: with a one-slot exclusion the rotation alternated between the
  // two newest topics forever and the third was never spoken. Driving the
  // selector with a growing most-recent-first history must visit every topic.
  it('cycles the whole pool instead of ping-ponging the newest two', () => {
    const profile = buildAoiSelfProfile({
      now: NOW,
      sources: [
        source({ id: 'a', label: 'Topic A', exploredAt: NOW }),
        source({ id: 'b', label: 'Topic B', exploredAt: NOW - HOUR }),
        source({ id: 'c', label: 'Topic C', exploredAt: NOW - 2 * HOUR }),
      ],
    });

    const spoken: string[] = [];
    let history: string[] = [];
    for (let turn = 0; turn < 7; turn += 1) {
      const picked = selectAoiSelfInquiryToShare(profile, {
        excludeTopicKeys: history,
        allowRepeatFallback: true,
      });
      expect(picked).not.toBeNull();
      spoken.push(picked?.label ?? '');
      history = [picked?.topicKey ?? '', ...history.filter((key) => key !== picked?.topicKey)];
    }

    expect(spoken).toEqual([
      'Topic A',
      'Topic B',
      'Topic C',
      'Topic A',
      'Topic B',
      'Topic C',
      'Topic A',
    ]);
    expect(new Set(spoken).size).toBe(3);
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

describe('deriveAoiSelfInquiryLabel', () => {
  it('extracts the research title from audit memory content', () => {
    expect(
      deriveAoiSelfInquiryLabel({
        content:
          'Aoi completed research "2026년 개인정보 보호 메타데이터 수집 가이드라인" on 2026-07-17. Findings: scope; retention. accepted=4. claims=2. run=run_abc.',
      }),
    ).toBe('2026년 개인정보 보호 메타데이터 수집 가이드라인');
  });

  it('falls back to entities when the audit quote is missing', () => {
    expect(
      deriveAoiSelfInquiryLabel({
        content: 'Aoi completed research on 2026-07-17. Findings: none. run=run_1.',
        entities: ['Windows kernel BYOVD trends', 'run_1', '2026-07-17'],
        tags: ['research', 'aoi-research'],
      }),
    ).toBe('Windows kernel BYOVD trends');
  });

  it('prefers the full entity title over a truncated mid-title content string', () => {
    // Memory content is capped at 360 chars; a long title can lose its closing quote.
    const truncated =
      'Aoi completed research "' +
      '개인정보 보호 메타데이터 수집 가이드라인과 장기 보관 정책 검토 '.repeat(8).trim() +
      '...';
    expect(truncated).not.toMatch(/" on /);
    expect(
      deriveAoiSelfInquiryLabel({
        content: truncated,
        entities: [
          '개인정보 보호 메타데이터 수집 가이드라인 전체 제목',
          'aoi-research-run-9',
          '2026-07-17',
        ],
      }),
    ).toBe('개인정보 보호 메타데이터 수집 가이드라인 전체 제목');
  });

  it('does not audit-strip ordinary memories that merely carry a research tag', () => {
    // Tags alone used to trigger Findings: truncation and could rewrite real facts.
    expect(
      deriveAoiSelfInquiryLabel({
        content: 'Procedure note with Findings: keep the report short and cite sources.',
        tags: ['research', 'aoi-research', 'documentation'],
      }),
    ).toBe('Procedure note with Findings: keep the report short and cite sources.');
  });

  it('rejects run-id shaped entities so Aoi does not speak internal ids', () => {
    expect(
      deriveAoiSelfInquiryLabel({
        content: 'Aoi completed research on 2026-07-17. run=aoi-research-test-1234.',
        entities: ['aoi-research-test-1234', '2026-07-17'],
      }),
    ).toBe('');
  });

  it('keeps ordinary agent memory content as the label', () => {
    expect(
      deriveAoiSelfInquiryLabel({
        content: 'kernel telemetry survey',
      }),
    ).toBe('kernel telemetry survey');
  });

  it('allows natural-language titles that start with English prepositions', () => {
    expect(
      deriveAoiSelfInquiryLabel({
        content: 'Aoi completed research "On-device attestation for TPM 2.0" on 2026-07-17.',
      }),
    ).toBe('On-device attestation for TPM 2.0');
  });
});

describe('humanizeAoiSelfInquiryTopicLabel', () => {
  it('extracts a title for companion defense-in-depth', () => {
    expect(
      humanizeAoiSelfInquiryTopicLabel(
        'Aoi completed research "kernel telemetry" on 2026-07-17. Findings: x.',
      ),
    ).toBe('kernel telemetry');
  });

  it('returns empty rather than speaking unparseable audit residue', () => {
    expect(
      humanizeAoiSelfInquiryTopicLabel(
        'Aoi completed research on 2026-07-17. Findings: none. accepted=0. run=run_1.',
      ),
    ).toBe('');
  });
});

describe('humanizeAoiSpeakableTopicLabel', () => {
  it('extracts proposal titles from active-proposal audit prose', () => {
    expect(
      humanizeAoiSpeakableTopicLabel('Active proposal "리서치 좁혀서 재시도" status=accepted'),
    ).toBe('리서치 좁혀서 재시도');
  });

  it('strips strategic-brief focus prefixes', () => {
    expect(humanizeAoiSpeakableTopicLabel('Pursuing: kernel telemetry')).toBe('kernel telemetry');
    expect(humanizeAoiSpeakableTopicLabel('Blocked: Risky delete -- needs L5')).toBe(
      'Risky delete -- needs L5',
    );
  });

  it('drops decision-id audit lines rather than speaking them', () => {
    expect(
      humanizeAoiSpeakableTopicLabel(
        'Recent autonomy proposal decision accept for proposal_abc123.',
      ),
    ).toBe('');
  });
});

describe('selectAoiSpeakableSessionSummary', () => {
  it('keeps real user topics after humanizing audit wrappers', () => {
    expect(
      selectAoiSpeakableSessionSummary('Pursuing: Active proposal "kernel path" status=accepted'),
    ).toBe('kernel path');
  });

  it('refuses operator recovery action titles as continuity topics', () => {
    expect(selectAoiSpeakableSessionSummary('리서치 좁혀서 재시도')).toBe('');
    expect(
      selectAoiSpeakableSessionSummary('Active proposal "리서치 좁혀서 재시도" status=accepted'),
    ).toBe('');
    expect(selectAoiSpeakableSessionSummary('Refresh research narrowly')).toBe('');
    expect(selectAoiSpeakableSessionSummary('일치하는 Aoi 리서치 보고서 열기')).toBe('');
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

  it('humanizes research-completion audit content into a topic title', () => {
    const sources = buildAoiSelfInquirySourcesFromMemories([
      {
        id: 'm-research',
        scope: 'agent',
        status: 'active',
        content:
          'Aoi completed research "2026년 개인정보 보호 메타데이터 수집 가이드라인" on 2026-07-17. Findings: retention windows; consent metadata. accepted=3. run=run_privacy.',
        entities: ['2026년 개인정보 보호 메타데이터 수집 가이드라인', 'run_privacy', '2026-07-17'],
        tags: ['research', 'aoi-research', 'permanent'],
        updatedAt: NOW,
      },
    ]);

    expect(sources).toHaveLength(1);
    expect(sources[0].label).toBe('2026년 개인정보 보호 메타데이터 수집 가이드라인');
    expect(sources[0].kind).toBe('research_run');
    expect(sources[0].label).not.toMatch(/Aoi completed research/i);
    expect(sources[0].label).not.toMatch(/Findings:/i);

    const profile = buildAoiSelfProfile({ now: NOW, sources });
    expect(profile.inquiries[0]?.label).toBe('2026년 개인정보 보호 메타데이터 수집 가이드라인');
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
