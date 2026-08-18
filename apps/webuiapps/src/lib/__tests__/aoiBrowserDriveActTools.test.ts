import { describe, expect, it, vi } from 'vitest';
import {
  BROWSER_DRIVE_PROPOSE_TOOL,
  BROWSER_DRIVE_RUN_TOOL,
  BROWSER_DRIVE_TASK_TOOL,
  executeBrowserDriveActTool,
  getBrowserDriveActToolDefinitions,
  getBrowserDriveActToolPendingSummary,
  isBrowserDriveActTool,
  parseBrowserDriveActParams,
  parseBrowserDriveTaskParams,
} from '../aoiBrowserDriveActTools';

const PLAN_PARAMS = {
  goal: 'refresh the dashboard',
  steps: [
    { description: 'open', action: { kind: 'navigate', url: 'https://example.com/account' } },
    { description: 'refresh', action: { kind: 'click', selector: '#refresh' } },
  ],
  target_step_index: 1,
};

describe('tool definitions + guards', () => {
  it('exposes propose + run tools', () => {
    const defs = getBrowserDriveActToolDefinitions();
    const names = defs.map((d) => d.function.name);
    expect(names).toContain(BROWSER_DRIVE_PROPOSE_TOOL);
    expect(names).toContain(BROWSER_DRIVE_RUN_TOOL);
    expect(isBrowserDriveActTool(BROWSER_DRIVE_PROPOSE_TOOL)).toBe(true);
    expect(isBrowserDriveActTool(BROWSER_DRIVE_RUN_TOOL)).toBe(true);
    expect(isBrowserDriveActTool('browser_read_auth')).toBe(false);
  });

  it('summarizes the pending call with the step index', () => {
    expect(getBrowserDriveActToolPendingSummary(BROWSER_DRIVE_RUN_TOOL, PLAN_PARAMS)).toContain(
      'step 1',
    );
  });
});

describe('parseBrowserDriveActParams', () => {
  it('accepts a well-formed plan', () => {
    const parsed = parseBrowserDriveActParams(PLAN_PARAMS);
    expect(parsed).not.toBeNull();
    expect(parsed?.targetStepIndex).toBe(1);
    expect(parsed?.plan.steps).toHaveLength(2);
  });

  it('rejects empty steps or an out-of-range index', () => {
    expect(parseBrowserDriveActParams({ goal: 'x', steps: [], target_step_index: 0 })).toBeNull();
    expect(
      parseBrowserDriveActParams({
        goal: 'x',
        steps: [{ action: { kind: 'click' } }],
        target_step_index: 5,
      }),
    ).toBeNull();
    expect(
      parseBrowserDriveActParams({ goal: 'x', steps: [{ action: { kind: 'click' } }] }),
    ).toBeNull();
  });
});

describe('propose (browser_drive_act)', () => {
  it('records approval and returns approval_required WITHOUT acting', async () => {
    const previewFetcher = vi.fn(async () => ({
      capability: 'os_browser_drive',
      approvalFingerprint: 'abc123def456',
      targetSummary: 'click #refresh on example.com',
      stepIndex: 1,
      hostname: 'example.com',
      finalUrl: 'https://example.com/account',
      expiresAt: 999,
      beforeScreenshotBase64: 'AAAA',
    }));
    const executeFetcher = vi.fn();
    const result = await executeBrowserDriveActTool(BROWSER_DRIVE_PROPOSE_TOOL, PLAN_PARAMS, {
      sessionPath: 'aoi/default',
      previewFetcher,
      executeFetcher,
    });
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('approval_required');
    expect(parsed.approval_fingerprint).toBe('abc123def456');
    expect(parsed.action).toBe('click #refresh on example.com');
    expect(parsed.before_screenshot_captured).toBe(true);
    expect(previewFetcher).toHaveBeenCalledWith(
      'aoi/default',
      { goal: 'refresh the dashboard', steps: PLAN_PARAMS.steps },
      1,
    );
    // Propose NEVER executes.
    expect(executeFetcher).not.toHaveBeenCalled();
  });

  it('surfaces a forbidden-step rejection as a permanent block message', async () => {
    const previewFetcher = vi.fn(async () => {
      throw new Error('forbidden_step');
    });
    const result = await executeBrowserDriveActTool(BROWSER_DRIVE_PROPOSE_TOOL, PLAN_PARAMS, {
      sessionPath: 'aoi/default',
      previewFetcher,
    });
    expect(result).toMatch(/permanently blocked/i);
  });

  it('errors without a session', async () => {
    const result = await executeBrowserDriveActTool(BROWSER_DRIVE_PROPOSE_TOOL, PLAN_PARAMS, {
      sessionPath: '',
    });
    expect(result).toMatch(/sessionPath missing/);
  });

  it('errors on a malformed plan', async () => {
    const result = await executeBrowserDriveActTool(
      BROWSER_DRIVE_PROPOSE_TOOL,
      { goal: 'x', steps: [] },
      { sessionPath: 'aoi/default' },
    );
    expect(result).toMatch(/needs goal, steps/);
  });
});

describe('run (browser_drive_run)', () => {
  it('does NOT report done on transport success alone', async () => {
    // This used to assert status:'done' for exactly this input. Transport
    // success means the call ran and no gate stopped it; with no verdict there
    // is nothing proving the action landed, and telling the model "done" is how
    // a delivered-but-unproven act became a completion claim.
    const executeFetcher = vi.fn(async () => ({
      ok: true,
      stepIndex: 1,
      finalUrl: 'https://example.com/account',
    }));
    const result = await executeBrowserDriveActTool(BROWSER_DRIVE_RUN_TOOL, PLAN_PARAMS, {
      sessionPath: 'aoi/default',
      executeFetcher,
    });
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('delivered_unverified');
    expect(parsed.ok).toBe(true);
    expect(parsed.note).toContain('Nothing here proves it landed');
    expect(executeFetcher).toHaveBeenCalledWith(
      'aoi/default',
      { goal: 'refresh the dashboard', steps: PLAN_PARAMS.steps },
      1,
    );
  });

  it('reports done only on a confirmed verdict', async () => {
    const executeFetcher = vi.fn(async () => ({
      ok: true,
      stepIndex: 1,
      finalUrl: 'https://example.com/account',
      verdict: { effect: 'confirmed' as const, verified: true },
    }));
    const parsed = JSON.parse(
      await executeBrowserDriveActTool(BROWSER_DRIVE_RUN_TOOL, PLAN_PARAMS, {
        sessionPath: 'aoi/default',
        executeFetcher,
      }),
    );
    expect(parsed.status).toBe('done');
    expect(parsed.effect).toBe('confirmed');
    expect(parsed.verified).toBe(true);
    expect(parsed.next).toBe('done');
    expect(parsed.note).toContain('Do not repeat');
  });

  it('tells the model to re-read rather than claim success on an unverifiable act', async () => {
    const executeFetcher = vi.fn(async () => ({
      ok: true,
      stepIndex: 1,
      verdict: {
        effect: 'unverifiable' as const,
        verified: false,
        escalation: { recommended: 'fresh_state' as const, reason: 'nothing changed' },
      },
    }));
    const parsed = JSON.parse(
      await executeBrowserDriveActTool(BROWSER_DRIVE_RUN_TOOL, PLAN_PARAMS, {
        sessionPath: 'aoi/default',
        executeFetcher,
      }),
    );
    expect(parsed.status).toBe('delivered_unverified');
    expect(parsed.next).toBe('verify_fresh_state');
    expect(parsed.note).toContain('do NOT repeat');
  });

  it('reports a suspected no-op as not performed, with the rung to try', async () => {
    const executeFetcher = vi.fn(async () => ({
      ok: true,
      stepIndex: 1,
      verdict: {
        effect: 'suspected_noop' as const,
        verified: false,
        escalation: { recommended: 'alternate_selector' as const, reason: 'read-back mismatch' },
      },
    }));
    const parsed = JSON.parse(
      await executeBrowserDriveActTool(BROWSER_DRIVE_RUN_TOOL, PLAN_PARAMS, {
        sessionPath: 'aoi/default',
        executeFetcher,
      }),
    );
    expect(parsed.status).toBe('not_performed');
    expect(parsed.next).toBe('escalate');
    expect(parsed.escalation.recommended).toBe('alternate_selector');
    expect(parsed.note).toContain('Do NOT tell the user it happened');
  });

  it('maps an unapproved (403) execute to an approve-first hint', async () => {
    const executeFetcher = vi.fn(async () => {
      throw new Error('approval_missing');
    });
    const result = await executeBrowserDriveActTool(BROWSER_DRIVE_RUN_TOOL, PLAN_PARAMS, {
      sessionPath: 'aoi/default',
      executeFetcher,
    });
    expect(result).toMatch(/not approved yet/i);
    expect(result).toMatch(/Approvals/);
  });

  it('reports a non-ok run with its stop reason', async () => {
    const executeFetcher = vi.fn(async () => ({
      ok: false,
      stepIndex: 1,
      stopReason: 'drift_to_denylist',
    }));
    const result = await executeBrowserDriveActTool(BROWSER_DRIVE_RUN_TOOL, PLAN_PARAMS, {
      sessionPath: 'aoi/default',
      executeFetcher,
    });
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('failed');
    expect(parsed.stop_reason).toBe('drift_to_denylist');
  });

  it('errors without a session and on a malformed plan', async () => {
    expect(
      await executeBrowserDriveActTool(BROWSER_DRIVE_RUN_TOOL, PLAN_PARAMS, { sessionPath: '' }),
    ).toMatch(/sessionPath missing/);
    expect(
      await executeBrowserDriveActTool(
        BROWSER_DRIVE_RUN_TOOL,
        { goal: 'x', steps: [] },
        { sessionPath: 'aoi/default' },
      ),
    ).toMatch(/needs goal, steps/);
  });
});

describe('task tool (browser_drive_task)', () => {
  const taskParams = {
    goal: 'refresh twice',
    steps: [
      {
        plan: { goal: 'p', steps: [{ action: { kind: 'click', selector: '#a' } }] },
        target_step_index: 0,
      },
      {
        plan: { goal: 'p', steps: [{ action: { kind: 'click', selector: '#b' } }] },
        target_step_index: 0,
      },
    ],
    max_acts: 5,
  };

  it('is recognized and summarized by step count', () => {
    expect(isBrowserDriveActTool(BROWSER_DRIVE_TASK_TOOL)).toBe(true);
    expect(getBrowserDriveActToolPendingSummary(BROWSER_DRIVE_TASK_TOOL, taskParams)).toContain(
      '2 steps',
    );
  });

  it('parses params into an owner=user task + budget', () => {
    const parsed = parseBrowserDriveTaskParams(taskParams);
    expect(parsed).not.toBeNull();
    expect(parsed?.task.owner).toBe('user');
    expect(parsed?.task.steps).toHaveLength(2);
    expect(parsed?.budget.maxActs).toBe(5);
  });

  it('rejects malformed task steps', () => {
    expect(parseBrowserDriveTaskParams({ goal: 'x', steps: [] })).toBeNull();
    expect(parseBrowserDriveTaskParams({ goal: 'x', steps: [{ plan: { steps: [] } }] })).toBeNull();
  });

  it('runs the task and reports completion (owner forced to user)', async () => {
    const taskFetcher = vi.fn(async () => ({
      ok: true,
      goal: 'refresh twice',
      stopReason: 'completed',
      actsRun: 2,
      stepsRun: 4,
      steps: [
        { index: 0, ok: true },
        { index: 1, ok: true },
      ],
    }));
    const result = await executeBrowserDriveActTool(BROWSER_DRIVE_TASK_TOOL, taskParams, {
      sessionPath: 'aoi/default',
      taskFetcher,
    });
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('done');
    expect(parsed.acts_run).toBe(2);
    const call = taskFetcher.mock.calls[0] as unknown as [
      string,
      { owner: string },
      { maxActs: number },
    ];
    expect(call[1].owner).toBe('user');
    expect(call[2].maxActs).toBe(5);
  });

  it('maps a disabled-toggle 403 to an enable hint', async () => {
    const taskFetcher = vi.fn(async () => {
      throw new Error('task_capability_disabled');
    });
    const result = await executeBrowserDriveActTool(BROWSER_DRIVE_TASK_TOOL, taskParams, {
      sessionPath: 'aoi/default',
      taskFetcher,
    });
    expect(result).toMatch(/bounded tasks are off/i);
  });
});

describe('gate-error mapping', () => {
  const cases: Array<[string, RegExp]> = [
    ['prefix_contains_act', /at most one act/i],
    ['not_an_act', /must point at an act/i],
    ['plan_inadmissible: too_many_steps', /plan was rejected/i],
    ['url_denylisted', /denylist/i],
    ['host_denylisted', /denylist/i],
    ['drift_to_denylist', /denylist/i],
    ['url_not_allowlisted', /denylist/i],
    ['drift_off_allowlist', /denylist/i],
    ['source_not_consented', /Enable Browser drive/i],
    ['attach_timeout', /could not drive the browser/i],
    ['session_start_failed', /could not drive the browser/i],
    ['something weird', /browser drive act failed/i],
  ];
  for (const [thrown, expected] of cases) {
    it(`maps "${thrown}"`, async () => {
      const executeFetcher = vi.fn(async () => {
        throw new Error(thrown);
      });
      const result = await executeBrowserDriveActTool(BROWSER_DRIVE_RUN_TOOL, PLAN_PARAMS, {
        sessionPath: 'aoi/default',
        executeFetcher,
      });
      expect(result).toMatch(expected);
    });
  }
});
