import { describe, expect, it, vi } from 'vitest';
import {
  AOI_BROWSER_DRIVE_TASK_MAX_ACTS,
  executeAoiBrowserDriveTask,
  type AoiBrowserDriveTask,
  type AoiBrowserDriveTaskStep,
} from '../aoiBrowserDriveTaskRunner';
import type {
  AoiBrowserDriveActExecuteResult,
  AoiBrowserDriveRunFailure,
} from '../aoiBrowserDriveActRunner';
import type { AoiBrowserDriveActionRequest } from '../aoiBrowserDriveAction';

const navStep: AoiBrowserDriveActionRequest = { kind: 'navigate', url: 'https://example.com/a' };
const clickStep: AoiBrowserDriveActionRequest = { kind: 'click', selector: '#go' };

// One task step = a single-act plan (one read prefix nav + the target click at idx 1).
function taskStep(): AoiBrowserDriveTaskStep {
  return {
    plan: {
      goal: 'sub',
      steps: [
        { description: 'nav', action: navStep },
        { description: 'click', action: clickStep },
      ],
    },
    targetStepIndex: 1,
  };
}

function task(owner: string, count: number): AoiBrowserDriveTask {
  return { owner, goal: 'do the task', steps: Array.from({ length: count }, () => taskStep()) };
}

function okOutcome(index: number): AoiBrowserDriveActExecuteResult {
  return {
    ok: true,
    stepIndex: 1,
    action: clickStep,
    prefix: [{ index: 0, category: 'read', ok: true }],
    target: { index: 1, category: 'act', ok: true, finalUrl: `https://example.com/done-${index}` },
  };
}

describe('consume-not-author + shape guards', () => {
  it('refuses a task not authored by the operator', async () => {
    const runStep = vi.fn();
    const result = await executeAoiBrowserDriveTask({ task: task('aoi', 1), runStep });
    expect(result).toMatchObject({ ok: false, stopReason: 'not_operator_authored' });
    expect(runStep).not.toHaveBeenCalled();
  });

  it('refuses an empty task', async () => {
    const result = await executeAoiBrowserDriveTask({ task: task('user', 0), runStep: vi.fn() });
    expect(result.stopReason).toBe('empty_task');
  });

  it('refuses a task with too many steps', async () => {
    const result = await executeAoiBrowserDriveTask({
      task: task('user', 3),
      runStep: vi.fn(),
      maxTaskSteps: 2,
    });
    expect(result.stopReason).toBe('too_many_steps');
  });
});

describe('happy path', () => {
  it('runs every step in order and completes', async () => {
    const seen: number[] = [];
    const runStep = vi.fn(async (_step: AoiBrowserDriveTaskStep, index: number) => {
      seen.push(index);
      return okOutcome(index);
    });
    const result = await executeAoiBrowserDriveTask({ task: task('user', 3), runStep });
    expect(result.ok).toBe(true);
    expect(result.stopReason).toBe('completed');
    expect(seen).toEqual([0, 1, 2]);
    expect(result.actsRun).toBe(3);
    // each step consumed prefix(1) + act(1) = 2 inner steps
    expect(result.stepsRun).toBe(6);
  });
});

describe('fail-stop', () => {
  it('stops on a runner-level failure and does not run later steps', async () => {
    const runStep = vi.fn(async (_s: AoiBrowserDriveTaskStep, index: number) => {
      if (index === 1) {
        return { ok: false, reason: 'prefix_failed' } as AoiBrowserDriveRunFailure;
      }
      return okOutcome(index);
    });
    const result = await executeAoiBrowserDriveTask({ task: task('user', 4), runStep });
    expect(result.ok).toBe(false);
    expect(result.stopReason).toBe('step_failed');
    expect(runStep).toHaveBeenCalledTimes(2); // step 0 then the failing step 1
    expect(result.results[1]).toMatchObject({ index: 1, ok: false, reason: 'prefix_failed' });
  });

  it('stops when the target act did not complete (e.g. denied)', async () => {
    const runStep = vi.fn(async (_s: AoiBrowserDriveTaskStep, index: number) => {
      if (index === 0) {
        return {
          ok: false,
          stepIndex: 1,
          action: clickStep,
          prefix: [{ index: 0, category: 'read' as const, ok: true }],
          target: {
            index: 1,
            category: 'act' as const,
            ok: false,
            stopReason: 'approval_denied' as const,
          },
        } satisfies AoiBrowserDriveActExecuteResult;
      }
      return okOutcome(index);
    });
    const result = await executeAoiBrowserDriveTask({ task: task('user', 3), runStep });
    expect(result.ok).toBe(false);
    expect(result.stopReason).toBe('step_failed');
    expect(result.results[0]).toMatchObject({ ok: false, reason: 'approval_denied' });
    expect(runStep).toHaveBeenCalledTimes(1);
  });
});

describe('budget', () => {
  it('stops before exceeding maxActs (irreversible acts capped)', async () => {
    const runStep = vi.fn(async (_s: AoiBrowserDriveTaskStep, index: number) => okOutcome(index));
    const result = await executeAoiBrowserDriveTask({
      task: task('user', 5),
      runStep,
      maxActs: 2,
    });
    expect(result.stopReason).toBe('budget_exhausted');
    expect(result.actsRun).toBe(2);
    expect(runStep).toHaveBeenCalledTimes(2);
  });

  it('stops before exceeding maxSteps (total inner steps capped)', async () => {
    // each step consumes 2 inner steps; maxSteps 3 allows only 1 step (2 <= 3, next would be 4)
    const runStep = vi.fn(async (_s: AoiBrowserDriveTaskStep, index: number) => okOutcome(index));
    const result = await executeAoiBrowserDriveTask({
      task: task('user', 5),
      runStep,
      maxSteps: 3,
    });
    expect(result.stopReason).toBe('budget_exhausted');
    expect(result.actsRun).toBe(1);
  });

  it('clamps a requested budget above the hard cap', async () => {
    const runStep = vi.fn(async (_s: AoiBrowserDriveTaskStep, index: number) => okOutcome(index));
    // request 100 acts but the hard cap is 10; a 12-step task stops at 10 acts.
    const result = await executeAoiBrowserDriveTask({
      task: task('user', 12),
      runStep,
      maxActs: 100,
      maxSteps: 1000,
      maxTaskSteps: 40,
    });
    expect(result.stopReason).toBe('budget_exhausted');
    expect(result.actsRun).toBe(AOI_BROWSER_DRIVE_TASK_MAX_ACTS);
  });
});
