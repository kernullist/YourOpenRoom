import { describe, expect, it } from 'vitest';
import { parseAoiAutonomyReflectionResponse } from '../aoiAutonomyEngine';

// Driver's-seat evidence handling: the LLM may originate proposals/reflections,
// and unverifiable evidence refs are filtered (not used to reject the whole
// item). Actionable proposals still need at least one known ref; reflections
// (thoughts) may stand alone. The execution policy gate is the final safety net.
describe('parseAoiAutonomyReflectionResponse driver-seat evidence handling', () => {
  const base = { sessionPath: 'demo', now: 1_000 };

  it('keeps an LLM proposal but drops unknown evidence refs', () => {
    const raw = JSON.stringify({
      proposals: [
        {
          title: 'Refresh stale research',
          body: 'Body',
          reason: 'Reason',
          confidence: 0.8,
          evidenceRefs: ['observation:obs-1', 'memory:ghost'],
        },
      ],
    });
    const result = parseAoiAutonomyReflectionResponse(raw, {
      ...base,
      knownEvidenceRefs: new Set(['observation:obs-1', 'memory:m-1']),
    });
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]?.evidenceRefs).toEqual(['observation:obs-1']);
    expect(result.warnings).toContain('proposal_evidence_filtered');
  });

  it('skips an LLM proposal whose evidence is entirely unknown', () => {
    const raw = JSON.stringify({
      proposals: [
        {
          title: 'Ungrounded',
          body: 'Body',
          reason: 'Reason',
          confidence: 0.8,
          evidenceRefs: ['memory:ghost'],
        },
      ],
    });
    const result = parseAoiAutonomyReflectionResponse(raw, {
      ...base,
      knownEvidenceRefs: new Set<string>(),
    });
    expect(result.proposals).toHaveLength(0);
    expect(result.warnings).toContain('proposal_rejected_no_known_evidence');
  });

  it('keeps a reflection even when it cites no known refs (a thought may stand alone)', () => {
    const raw = JSON.stringify({
      reflections: [
        {
          claim: 'The current research looks stale.',
          confidence: 0.7,
          evidenceRefs: ['memory:ghost'],
        },
      ],
    });
    const result = parseAoiAutonomyReflectionResponse(raw, {
      ...base,
      knownEvidenceRefs: new Set<string>(),
    });
    expect(result.reflections).toHaveLength(1);
    expect(result.reflections[0]?.evidenceRefs).toEqual([]);
  });
});
