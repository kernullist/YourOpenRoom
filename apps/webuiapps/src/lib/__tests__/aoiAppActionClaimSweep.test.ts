import { describe, expect, it, vi } from 'vitest';

import {
  classifyAoiClaimSweepRun,
  formatAoiClaimSweepReport,
  resolveSweepAssistantMessage,
  sweepAoiAppActionClaims,
  type AoiClaimSweepLedgerRun,
} from '../aoiAppActionClaimSweep';
import {
  AOI_CLAIM_SWEEP_EXIT_CLEAN,
  AOI_CLAIM_SWEEP_EXIT_GAPS_FOUND,
  AOI_CLAIM_SWEEP_EXIT_RUN_ERROR,
  resolveAoiClaimSweepLedgerPath,
  runAoiClaimSweepCli,
} from '../aoiAppActionClaimSweepCli';

function run(overrides: Partial<AoiClaimSweepLedgerRun> = {}): AoiClaimSweepLedgerRun {
  return {
    id: 'run-1',
    createdAt: 1,
    goal: { sourceMessage: '아까 그거 틀어달라니까' },
    finalMessage: '틀어줄게. 재생 준비해뒀어.',
    includeAppTools: true,
    exposedToolNames: ['app_action', 'respond_to_user'],
    events: [],
    ...overrides,
  };
}

describe('classifyAoiClaimSweepRun', () => {
  it('ignores a turn that never asked an app to do anything', () => {
    expect(
      classifyAoiClaimSweepRun(
        run({ goal: { sourceMessage: '오늘 어땠어?' }, finalMessage: '나쁘지 않았어.' }),
      ).verdict,
    ).toBe('not_a_request');
  });

  it('counts a real dispatch as backed', () => {
    expect(
      classifyAoiClaimSweepRun(
        run({ events: [{ type: 'tool_result', toolNames: ['app_action'] }] }),
      ).verdict,
    ).toBe('dispatched');
    // The pending-summary shape the delivered event carries.
    expect(
      classifyAoiClaimSweepRun(
        run({ events: [{ type: 'assistant_delivered', toolNames: ['youtube/OPEN_SEARCH'] }] }),
      ).verdict,
    ).toBe('dispatched');
  });

  it('does not read run_started as evidence', () => {
    // run_started lists the tools EXPOSED for the turn. Counting it would mark
    // every app-tool turn as dispatched and the sweep would find nothing, ever.
    expect(
      classifyAoiClaimSweepRun(
        run({ events: [{ type: 'run_started', toolNames: ['app_action', 'respond_to_user'] }] }),
      ).verdict,
    ).not.toBe('dispatched');
  });

  it('separates "could not dispatch" from "did not dispatch"', () => {
    // A routing problem, not a wording one: widening the prose detector would
    // not have helped this turn at all.
    expect(classifyAoiClaimSweepRun(run({ includeAppTools: false })).verdict).toBe(
      'app_tools_unavailable',
    );
  });

  it('falls back to the exposed tool list when the flag is absent', () => {
    expect(
      classifyAoiClaimSweepRun(
        run({ includeAppTools: undefined, exposedToolNames: ['respond_to_user'] }),
      ).verdict,
    ).toBe('app_tools_unavailable');
  });

  it('marks a claim the runtime guard already recognizes', () => {
    expect(classifyAoiClaimSweepRun(run()).verdict).toBe('pattern_covers');
  });

  it('does not call an honest refusal a gap', () => {
    // Same shape as a gap from the outside -- nothing dispatched, no claim the
    // detector recognizes -- but the reply said so out loud. Reporting it would
    // fail a check over correct behaviour.
    const finding = classifyAoiClaimSweepRun(
      run({ finalMessage: '미안, 뭘 틀지 못 찾았어. 아직 아무것도 재생하지 않았어.' }),
    );
    expect(finding.verdict).toBe('honest_no_action');
  });

  it('keeps honest refusals out of the report and the exit code', async () => {
    const report = await sweepAoiAppActionClaims([
      run({ id: 'honest', finalMessage: '아직 아무것도 재생하지 않았어.' }),
    ]);
    expect(report.counts.honest_no_action).toBe(1);
    expect(report.counts.pattern_gap).toBe(0);
    expect(report.findings).toHaveLength(0);
  });

  it('flags a claim no pattern would catch', () => {
    // The bucket the sweep exists for: reads as an ordinary sentence, asserts
    // completion, nothing ran.
    const finding = classifyAoiClaimSweepRun(run({ finalMessage: '응, 다 됐어. 편하게 즐겨.' }));
    expect(finding.verdict).toBe('pattern_gap');
    expect(finding.kind).toBe('playback');
  });
});

describe('resolveSweepAssistantMessage', () => {
  it('prefers the recorded final message', () => {
    expect(resolveSweepAssistantMessage(run({ finalMessage: 'final' }))).toBe('final');
  });

  it('falls back to the last spoken event', () => {
    expect(
      resolveSweepAssistantMessage(
        run({
          finalMessage: undefined,
          events: [
            { type: 'model_response', message: 'first' },
            { type: 'plain_text_fallback', message: 'last' },
            { type: 'run_completed', message: 'bookkeeping' },
          ],
        }),
      ),
    ).toBe('last');
  });

  it('returns empty when the run said nothing', () => {
    expect(resolveSweepAssistantMessage(run({ finalMessage: undefined, events: [] }))).toBe('');
  });
});

describe('sweepAoiAppActionClaims', () => {
  it('reports only the turns worth reading, newest first', async () => {
    const report = await sweepAoiAppActionClaims([
      run({
        id: 'ok',
        createdAt: 10,
        events: [{ type: 'tool_result', toolNames: ['app_action'] }],
      }),
      run({ id: 'chat', createdAt: 20, goal: { sourceMessage: '안녕' }, finalMessage: '안녕!' }),
      run({ id: 'gap', createdAt: 30, finalMessage: '응, 다 됐어.' }),
      run({ id: 'covered', createdAt: 40 }),
    ]);
    expect(report.scannedRuns).toBe(4);
    expect(report.counts).toMatchObject({
      dispatched: 1,
      not_a_request: 1,
      pattern_gap: 1,
      pattern_covers: 1,
    });
    // Backed and irrelevant turns are dropped from the list.
    expect(report.findings.map((finding) => finding.runId)).toEqual(['covered', 'gap']);
  });

  it('lets a judge clear a gap that was not really a claim', async () => {
    const judge = vi.fn().mockResolvedValue({ claimed: false, note: 'just asking' });
    const report = await sweepAoiAppActionClaims([run({ finalMessage: '뭘 틀어줄까 골라봐.' })], {
      judge,
    });
    expect(judge).toHaveBeenCalledTimes(1);
    expect(report.counts.pattern_gap).toBe(0);
    expect(report.findings).toHaveLength(0);
  });

  it('keeps a gap the judge confirms, with its note', async () => {
    const report = await sweepAoiAppActionClaims([run({ finalMessage: '응, 다 됐어.' })], {
      judge: async () => ({ claimed: true, note: 'says it is done' }),
    });
    expect(report.counts.pattern_gap).toBe(1);
    expect(report.findings[0].judgedAsClaim).toBe(true);
    expect(report.findings[0].judgeNote).toBe('says it is done');
  });

  it('never judges anything but the residue', async () => {
    const judge = vi.fn().mockResolvedValue({ claimed: true });
    await sweepAoiAppActionClaims(
      [
        run({ id: 'covered' }),
        run({ id: 'ok', events: [{ type: 'tool_result', toolNames: ['app_action'] }] }),
      ],
      { judge },
    );
    expect(judge).not.toHaveBeenCalled();
  });

  it('keeps a finding when the judge throws', async () => {
    // Losing a finding to a flaky judge would silently shrink the report.
    const report = await sweepAoiAppActionClaims([run({ finalMessage: '응, 다 됐어.' })], {
      judge: async () => {
        throw new Error('model unavailable');
      },
    });
    expect(report.counts.pattern_gap).toBe(1);
    expect(report.findings[0].judgedAsClaim).toBeUndefined();
  });
});

describe('formatAoiClaimSweepReport', () => {
  it('says so plainly when there is nothing to fix', async () => {
    const report = await sweepAoiAppActionClaims([
      run({ events: [{ type: 'tool_result', toolNames: ['app_action'] }] }),
    ]);
    expect(formatAoiClaimSweepReport(report)).toContain('No unbacked app-action requests found.');
  });

  it('shows each finding and points at what to do with a gap', async () => {
    const report = await sweepAoiAppActionClaims([run({ finalMessage: '응, 다 됐어.' })]);
    const text = formatAoiClaimSweepReport(report);
    expect(text).toContain('[pattern_gap]');
    expect(text).toContain('아까 그거 틀어달라니까');
    expect(text).toContain('aoiAppActionClaimContract');
  });
});

describe('reading a ledger written by an older build', () => {
  it('tolerates every field being absent', () => {
    const finding = classifyAoiClaimSweepRun({});
    expect(finding.runId).toBe('');
    expect(finding.createdAt).toBe(0);
    expect(finding.verdict).toBe('not_a_request');
  });

  it('falls back to the goal summary when there is no source message', () => {
    const finding = classifyAoiClaimSweepRun({
      goal: { summary: '노래 좀 틀어달라니까' },
      finalMessage: '응, 다 됐어.',
      includeAppTools: true,
    });
    expect(finding.userMessage).toBe('노래 좀 틀어달라니까');
    expect(finding.verdict).toBe('pattern_gap');
  });

  it('treats a run with no events as having dispatched nothing', () => {
    expect(
      classifyAoiClaimSweepRun({
        goal: { sourceMessage: '틀어달라니까' },
        finalMessage: '응, 다 됐어.',
        includeAppTools: true,
        events: undefined,
      }).verdict,
    ).toBe('pattern_gap');
  });

  it('ignores an event that carries no tool names', () => {
    expect(
      classifyAoiClaimSweepRun(
        run({ events: [{ type: 'tool_result' }], finalMessage: '응, 다 됐어.' }),
      ).verdict,
    ).toBe('pattern_gap');
  });
});

describe('report formatting with a judge', () => {
  it('shows the verdict and note the judge gave', async () => {
    const report = await sweepAoiAppActionClaims([run({ finalMessage: '응, 다 됐어.' })], {
      judge: async () => ({ claimed: true, note: 'asserts completion' }),
    });
    const text = formatAoiClaimSweepReport(report);
    expect(text).toContain('judge: CLAIM');
    expect(text).toContain('note : asserts completion');
  });

  it('truncates a long reply rather than dumping it', async () => {
    const report = await sweepAoiAppActionClaims([
      run({ finalMessage: `응, 다 됐어. ${'가'.repeat(400)}` }),
    ]);
    expect(formatAoiClaimSweepReport(report)).toContain('...');
  });
});

describe('runAoiClaimSweepCli', () => {
  function deps(overrides: Partial<Parameters<typeof runAoiClaimSweepCli>[0]> = {}) {
    return {
      argv: ['--ledger', '/tmp/runs.json'] as readonly string[],
      env: {} as Record<string, string | undefined>,
      loadRuns: async () => [run()],
      log: vi.fn(),
      logError: vi.fn(),
      ...overrides,
    };
  }

  it('exits clean when no gaps were found', async () => {
    expect(await runAoiClaimSweepCli(deps())).toBe(AOI_CLAIM_SWEEP_EXIT_CLEAN);
  });

  it('exits non-zero on a gap so it can gate a check', async () => {
    expect(
      await runAoiClaimSweepCli(
        deps({ loadRuns: async () => [run({ finalMessage: '응, 다 됐어.' })] }),
      ),
    ).toBe(AOI_CLAIM_SWEEP_EXIT_GAPS_FOUND);
  });

  it('refuses to run without a ledger', async () => {
    const d = deps({ argv: [] });
    expect(await runAoiClaimSweepCli(d)).toBe(AOI_CLAIM_SWEEP_EXIT_RUN_ERROR);
    expect(d.logError).toHaveBeenCalledWith(expect.stringContaining('no ledger given'));
  });

  it('reports a read failure instead of pretending the ledger was clean', async () => {
    const d = deps({
      loadRuns: async () => {
        throw new Error('ENOENT');
      },
    });
    expect(await runAoiClaimSweepCli(d)).toBe(AOI_CLAIM_SWEEP_EXIT_RUN_ERROR);
    expect(d.logError).toHaveBeenCalledWith(expect.stringContaining('ENOENT'));
  });

  it('refuses --judge when no judge is configured', async () => {
    const d = deps({ argv: ['--ledger', '/tmp/runs.json', '--judge'] });
    expect(await runAoiClaimSweepCli(d)).toBe(AOI_CLAIM_SWEEP_EXIT_RUN_ERROR);
    expect(d.logError).toHaveBeenCalledWith(expect.stringContaining('no judge is configured'));
  });

  it('uses the judge when one is available', async () => {
    const judge = vi.fn().mockResolvedValue({ claimed: false });
    await runAoiClaimSweepCli(
      deps({
        argv: ['--ledger', '/tmp/runs.json', '--judge'],
        loadRuns: async () => [run({ finalMessage: '응, 다 됐어.' })],
        judge,
      }),
    );
    expect(judge).toHaveBeenCalledTimes(1);
  });

  it('emits raw JSON on request', async () => {
    const d = deps({ argv: ['--ledger', '/tmp/runs.json', '--json'] });
    await runAoiClaimSweepCli(d);
    expect(d.log).toHaveBeenCalledWith(expect.stringContaining('"scannedRuns"'));
  });

  it('prints usage for --help without needing a ledger', async () => {
    const d = deps({ argv: ['--help'] });
    expect(await runAoiClaimSweepCli(d)).toBe(AOI_CLAIM_SWEEP_EXIT_CLEAN);
    expect(d.log).toHaveBeenCalledWith(expect.stringContaining('aoi-claim-sweep'));
  });

  it('does not advertise --judge as if this binary could judge', () => {
    // The shipped entry supplies no judge, so listing it as an option would
    // promise something every invocation then refuses to do.
    const d = deps({ argv: ['--help'] });
    void runAoiClaimSweepCli(d);
    const usage = (d.log as unknown as { mock: { calls: string[][] } }).mock.calls
      .map((call) => call[0])
      .join('\n');
    expect(usage).not.toMatch(/^\s*--judge\s/m);
    expect(usage).toContain('This binary ships none');
  });

  it('resolves the ledger from flag, inline form, or env', () => {
    expect(resolveAoiClaimSweepLedgerPath(['--ledger', '/a.json'], {})).toBe('/a.json');
    expect(resolveAoiClaimSweepLedgerPath(['--ledger=/b.json'], {})).toBe('/b.json');
    expect(resolveAoiClaimSweepLedgerPath([], { AOI_CLAIM_SWEEP_LEDGER: '/c.json' })).toBe(
      '/c.json',
    );
    expect(resolveAoiClaimSweepLedgerPath([], {})).toBe('');
  });
});
