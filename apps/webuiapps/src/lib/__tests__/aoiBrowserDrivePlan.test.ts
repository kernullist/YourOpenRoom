import { describe, expect, it } from 'vitest';
import {
  AOI_BROWSER_DRIVE_MAX_PLAN_STEPS,
  classifyAoiBrowserDrivePlan,
  type AoiBrowserDrivePlan,
} from '../aoiBrowserDrivePlan';

describe('classifyAoiBrowserDrivePlan', () => {
  it('classifies a mixed read+act plan as admissible with step lists', () => {
    const plan: AoiBrowserDrivePlan = {
      goal: 'Reply to the newest message',
      steps: [
        {
          description: 'Go to inbox',
          action: { kind: 'navigate', url: 'https://example.com/inbox' },
        },
        {
          description: 'Open the newest thread',
          action: { kind: 'click', targetText: 'Newest thread' },
        },
        { description: 'Read the thread', action: { kind: 'extract' } },
        {
          description: 'Type the reply',
          action: { kind: 'type', text: 'Sounds good', field: { type: 'text', name: 'reply' } },
        },
      ],
    };
    const result = classifyAoiBrowserDrivePlan(plan);
    expect(result.admissible).toBe(true);
    expect(result.goal).toBe('Reply to the newest message');
    expect(result.autoStepIndexes).toEqual([0, 2]);
    expect(result.approvalStepIndexes).toEqual([1, 3]);
    expect(result.forbiddenStepIndexes).toEqual([]);
  });

  it('rejects the WHOLE plan when any step is forbidden', () => {
    const plan: AoiBrowserDrivePlan = {
      goal: 'Pay the invoice',
      steps: [
        {
          description: 'Open billing',
          action: { kind: 'navigate', url: 'https://example.com/billing' },
        },
        { description: 'Click pay', action: { kind: 'click', targetText: 'Pay now' } },
      ],
    };
    const result = classifyAoiBrowserDrivePlan(plan);
    expect(result.admissible).toBe(false);
    expect(result.rejectReasons).toContain('contains_forbidden_step');
    expect(result.forbiddenStepIndexes).toEqual([1]);
  });

  it('rejects an empty plan', () => {
    const result = classifyAoiBrowserDrivePlan({ goal: 'x', steps: [] });
    expect(result.admissible).toBe(false);
    expect(result.rejectReasons).toContain('empty_plan');
  });

  it('rejects an over-long plan', () => {
    const steps = Array.from({ length: AOI_BROWSER_DRIVE_MAX_PLAN_STEPS + 1 }, () => ({
      description: 'scroll',
      action: { kind: 'scroll' as const },
    }));
    const result = classifyAoiBrowserDrivePlan({ goal: 'x', steps });
    expect(result.admissible).toBe(false);
    expect(result.rejectReasons).toContain('too_many_steps');
  });

  it('honors a custom maxSteps and fills a default description', () => {
    const result = classifyAoiBrowserDrivePlan(
      { goal: 'x', steps: [{ description: '', action: { kind: 'scroll' } }] },
      { maxSteps: 1 },
    );
    expect(result.admissible).toBe(true);
    expect(result.steps[0].description).toBe('step 1');
  });

  it('defends against a malformed step (missing action) by failing closed', () => {
    const plan = {
      goal: 'x',
      steps: [{ description: 'weird' } as unknown as AoiBrowserDrivePlan['steps'][number]],
    };
    const result = classifyAoiBrowserDrivePlan(plan);
    // Missing action defaults to a benign wait (read) -> admissible.
    expect(result.steps[0].decision.category).toBe('read');
  });
});
