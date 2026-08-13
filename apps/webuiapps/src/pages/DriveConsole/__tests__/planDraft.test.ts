import { describe, expect, it } from 'vitest';
import {
  classifyDraft,
  describeForbidReason,
  describeRejectReason,
  draftToPlan,
  DRIVE_ACTION_KINDS,
  inferFieldFromSelector,
  makeDraftStep,
  stepNeeds,
  summarizeDraft,
  type DraftStep,
  type PlanDraft,
} from '../planDraft';

// The console's whole promise is that you learn what a plan does BEFORE running
// it. These tests pin the classification the operator sees while typing --
// especially the cases where a step is blocked outright, since a plan that
// quietly looks fine and then fails at execute would be worse than no preview.

function step(overrides: Partial<DraftStep> = {}): DraftStep {
  return { ...makeDraftStep('s1'), ...overrides };
}

function draft(steps: DraftStep[], goal = '테스트 목표'): PlanDraft {
  return { goal, steps };
}

describe('stepNeeds', () => {
  it('asks for a url only for navigation', () => {
    expect(stepNeeds('navigate').url).toBe(true);
    expect(stepNeeds('click').url).toBe(false);
  });

  it('asks for a selector for anything that targets an element', () => {
    for (const kind of ['click', 'type', 'select', 'press', 'submit', 'extract'] as const) {
      expect(stepNeeds(kind).selector).toBe(true);
    }
    expect(stepNeeds('scroll').selector).toBe(false);
  });

  it('asks for a value only where one is typed or chosen', () => {
    expect(stepNeeds('type').value).toBe(true);
    expect(stepNeeds('select').value).toBe(true);
    expect(stepNeeds('click').value).toBe(false);
  });
});

describe('draftToPlan', () => {
  it('carries only the fields the action kind actually uses', () => {
    const plan = draftToPlan(
      draft([
        step({
          kind: 'navigate',
          url: ' https://example.com ',
          selector: 'button.ignored',
          value: 'ignored',
        }),
      ]),
    );

    expect(plan.steps[0].action).toEqual({ kind: 'navigate', url: 'https://example.com' });
  });

  it('keeps selector and value for a type step, with field metadata recovered', () => {
    const plan = draftToPlan(
      draft([step({ kind: 'type', selector: '#q', value: 'hello', targetText: 'Search' })]),
    );

    expect(plan.steps[0].action).toEqual({
      kind: 'type',
      selector: '#q',
      value: 'hello',
      targetText: 'Search',
      field: { id: 'q' },
    });
  });

  it('attaches field metadata only where a value is entered', () => {
    // A click has no field to be sensitive about; attaching one would be noise
    // in the approval card.
    const plan = draftToPlan(draft([step({ kind: 'click', selector: '#submit' })]));

    expect(plan.steps[0].action).not.toHaveProperty('field');
  });

  it('falls back to a recognizable description rather than an empty line', () => {
    // A blank description would reach the approval card as nothing at all.
    const plan = draftToPlan(draft([step({ kind: 'click', selector: '#buy', description: '  ' })]));

    expect(plan.steps[0].description).toBe('click #buy');
  });

  it('keeps an explicit description', () => {
    const plan = draftToPlan(
      draft([step({ kind: 'click', selector: '#buy', description: '구매' })]),
    );

    expect(plan.steps[0].description).toBe('구매');
  });

  it('trims the goal', () => {
    expect(draftToPlan(draft([], '  목표  ')).goal).toBe('목표');
  });
});

describe('summarizeDraft', () => {
  it('separates read steps from steps that need approval', () => {
    // "3 steps" says nothing; the split is what tells the operator how much they
    // are being asked to vouch for.
    const summary = summarizeDraft(
      draft([
        step({ id: 'a', kind: 'navigate', url: 'https://example.com' }),
        step({ id: 'b', kind: 'click', selector: '#next', targetText: 'Next' }),
      ]),
    );

    expect(summary.total).toBe(2);
    expect(summary.read).toBe(1);
    expect(summary.act).toBe(1);
    expect(summary.forbidden).toBe(0);
    expect(summary.approvalStepIndexes).toContain(1);
  });

  it('is inadmissible and reports why when a step is blocked', () => {
    const summary = summarizeDraft(
      draft([step({ kind: 'click', selector: '#pay', targetText: 'Place order' })]),
    );

    expect(summary.forbidden).toBeGreaterThan(0);
    expect(summary.admissible).toBe(false);
    expect(summary.rejectReasons).toContain('contains_forbidden_step');
  });

  it('reports an empty plan as inadmissible rather than as a valid no-op', () => {
    const summary = summarizeDraft(draft([]));

    expect(summary.total).toBe(0);
    expect(summary.admissible).toBe(false);
    expect(summary.rejectReasons).toContain('empty_plan');
  });

  it('counts a read-only plan as fully admissible with no approvals', () => {
    const summary = summarizeDraft(
      draft([
        step({ id: 'a', kind: 'navigate', url: 'https://example.com' }),
        step({ id: 'b', kind: 'extract', selector: 'main' }),
        step({ id: 'c', kind: 'screenshot' }),
      ]),
    );

    expect(summary.read).toBe(3);
    expect(summary.act).toBe(0);
    expect(summary.admissible).toBe(true);
    expect(summary.approvalStepIndexes).toEqual([]);
  });

  it('rejects a plan that exceeds the step cap', () => {
    const many = Array.from({ length: 25 }, (_, index) =>
      step({ id: `s${index}`, kind: 'navigate', url: 'https://example.com' }),
    );

    const summary = summarizeDraft(draft(many));

    expect(summary.admissible).toBe(false);
    expect(summary.rejectReasons).toContain('too_many_steps');
  });
});

describe('classifyDraft', () => {
  it('marks a password field as forbidden with a reason', () => {
    const classification = classifyDraft(
      draft([step({ kind: 'type', selector: 'input[type=password]', value: 'hunter2' })]),
    );

    const decision = classification.steps[0].decision;
    expect(decision.category).toBe('forbidden');
    expect(decision.forbidReason).toBeTruthy();
  });

  it('exposes every action kind the editor offers', () => {
    // A kind in the picker that the classifier does not know would be surfaced
    // to the operator as 'unknown_action' only after they had built the step.
    for (const kind of DRIVE_ACTION_KINDS) {
      const classification = classifyDraft(
        draft([step({ kind, selector: '#x', url: 'https://e.com' })]),
      );
      expect(classification.steps[0].decision.category).not.toBe(undefined);
      expect(classification.steps[0].decision.forbidReason).not.toBe('unknown_action');
    }
  });
});

describe('inferFieldFromSelector', () => {
  it('recovers the input type a selector already states', () => {
    expect(inferFieldFromSelector('input[type=password]')).toEqual({ type: 'password' });
    expect(inferFieldFromSelector('input[type="email"]')).toEqual({ type: 'email' });
  });

  it('recovers name, autocomplete and id', () => {
    expect(inferFieldFromSelector('#card-number')).toEqual({ id: 'card-number' });
    expect(inferFieldFromSelector('[name=otp]')).toEqual({ name: 'otp' });
    expect(inferFieldFromSelector('[autocomplete="cc-number"]')).toEqual({
      autocomplete: 'cc-number',
    });
  });

  it('lets the operator override what the selector implies', () => {
    expect(inferFieldFromSelector('input.custom', { type: 'password' })).toEqual({
      type: 'password',
    });
  });

  it('returns null when the selector says nothing useful', () => {
    expect(inferFieldFromSelector('div > span')).toBeNull();
    expect(inferFieldFromSelector('')).toBeNull();
  });

  it('turns a hand-written password step into a hard block at authoring time', () => {
    // This is the whole reason the inference exists. Without it the step reads
    // as a routine act needing approval, and the block only appears at execute.
    const summary = summarizeDraft(
      draft([step({ kind: 'type', selector: 'input[type=password]', value: 'hunter2' })]),
    );

    expect(summary.forbidden).toBe(1);
    expect(summary.admissible).toBe(false);
  });
});

describe('reason phrasing', () => {
  it('explains each block in terms the operator can act on', () => {
    expect(describeForbidReason('sensitive_field')).toContain('민감');
    expect(describeForbidReason('financial_commit')).toContain('결제');
    expect(describeForbidReason('captcha')).toContain('CAPTCHA');
    expect(describeForbidReason('unknown_action')).toContain('알 수 없는');
  });

  it('falls back rather than showing a bare code', () => {
    expect(describeForbidReason(undefined)).toBeTruthy();
    expect(describeForbidReason('something_new')).toBeTruthy();
  });

  it('explains plan-level rejections', () => {
    expect(describeRejectReason('empty_plan')).toContain('단계가 없');
    expect(describeRejectReason('too_many_steps')).toContain('상한');
    expect(describeRejectReason('contains_forbidden_step')).toContain('차단');
    expect(describeRejectReason('brand_new_reason')).toBe('brand_new_reason');
  });
});
