import { describe, expect, it, vi } from 'vitest';
import {
  computeAoiBrowserDriveActionFingerprint,
  executeAoiBrowserDriveStep,
  runAoiBrowserDrivePlan,
  type AoiBrowserDriveActablePage,
  type AoiBrowserDriveApprovalGate,
  type AoiBrowserDriveObserver,
} from '../aoiBrowserDriveExecutor';
import {
  addAoiBrowserDriveAllowlistEntry,
  type AoiBrowserDriveAllowlist,
} from '../aoiBrowserDriveAllowlist';
import type { AoiBrowserDrivePlan } from '../aoiBrowserDrivePlan';
import type { AoiBrowserDriveActionRequest } from '../aoiBrowserDriveAction';

const ALLOWLIST: AoiBrowserDriveAllowlist = addAoiBrowserDriveAllowlistEntry(
  { version: 1, entries: [], updatedAt: 0 },
  { domain: 'example.com' },
  1,
).allowlist;

const SAMPLE_HTML =
  '<html><head><title>Dashboard</title></head><body><h1>My account</h1>' +
  '<p>You have three new messages waiting in the inbox for review today.</p></body></html>';

interface FakePageOptions {
  startUrl?: string;
  landingUrl?: string;
  // A url the page ends on after an ACT (to simulate drift or a same-site nav).
  actLandingUrl?: string;
  content?: string;
  failClick?: boolean;
  // Live-DOM values the executor reads to re-check the forbidden hard-block.
  domTextContent?: string;
  domAttributes?: Record<string, string>;
}

function fakePage(options: FakePageOptions = {}) {
  let current = options.startUrl ?? 'about:blank';
  const landingUrl = options.landingUrl ?? 'https://example.com/account';
  const calls: string[] = [];
  const page = {
    url: () => current,
    goto: vi.fn(async (target: string) => {
      calls.push(`goto:${target}`);
      current = target === 'about:blank' ? 'about:blank' : landingUrl;
    }),
    content: vi.fn(async () => options.content ?? SAMPLE_HTML),
    title: vi.fn(async () => 'Dashboard'),
    click: vi.fn(async (selector: string) => {
      calls.push(`click:${selector}`);
      if (options.failClick) {
        throw new Error('element not found');
      }
      if (options.actLandingUrl) {
        current = options.actLandingUrl;
      }
    }),
    fill: vi.fn(async (selector: string, value: string) => {
      calls.push(`fill:${selector}=${value}`);
    }),
    selectOption: vi.fn(async (selector: string, value: string) => {
      calls.push(`select:${selector}=${value}`);
      return [];
    }),
    press: vi.fn(async (selector: string, key: string) => {
      calls.push(`press:${selector}:${key}`);
    }),
    goBack: vi.fn(async () => {
      calls.push('back');
      if (options.actLandingUrl) {
        current = options.actLandingUrl;
      }
      return null;
    }),
    screenshot: vi.fn(async () => new Uint8Array([1, 2, 3, 4])),
    mouse: { wheel: vi.fn(async () => calls.push('wheel')) },
    textContent: vi.fn(async () =>
      typeof options.domTextContent === 'string' ? options.domTextContent : null,
    ),
    getAttribute: vi.fn(
      async (_selector: string, name: string) => options.domAttributes?.[name] ?? null,
    ),
  };
  return { page: page as unknown as AoiBrowserDriveActablePage, raw: page, calls };
}

const allowGate: AoiBrowserDriveApprovalGate = async () => ({ approved: true });
const denyGate: AoiBrowserDriveApprovalGate = async () => ({ approved: false, reason: 'nope' });

function plan(...actions: AoiBrowserDriveActionRequest[]): AoiBrowserDrivePlan {
  return {
    goal: 'do the thing',
    steps: actions.map((action, index) => ({ description: `step ${index}`, action })),
  };
}

describe('computeAoiBrowserDriveActionFingerprint', () => {
  it('is deterministic and matches the approval-store pattern', () => {
    const action: AoiBrowserDriveActionRequest = { kind: 'click', selector: '#go' };
    const a = computeAoiBrowserDriveActionFingerprint('goal', 2, action);
    const b = computeAoiBrowserDriveActionFingerprint('goal', 2, action);
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{4,64}$/i);
  });

  it('changes when the action or index changes', () => {
    const base = computeAoiBrowserDriveActionFingerprint('goal', 0, {
      kind: 'click',
      selector: '#a',
    });
    expect(base).not.toBe(
      computeAoiBrowserDriveActionFingerprint('goal', 1, { kind: 'click', selector: '#a' }),
    );
    expect(base).not.toBe(
      computeAoiBrowserDriveActionFingerprint('goal', 0, { kind: 'click', selector: '#b' }),
    );
    expect(base).not.toBe(
      computeAoiBrowserDriveActionFingerprint('other', 0, { kind: 'click', selector: '#a' }),
    );
  });
});

describe('executeAoiBrowserDriveStep - guards', () => {
  it('refuses an out-of-range step index', async () => {
    const { page } = fakePage();
    const result = await executeAoiBrowserDriveStep({
      page,
      plan: plan({ kind: 'scroll' }),
      stepIndex: 5,
      allowlist: ALLOWLIST,
      approvalGate: allowGate,
      now: 1,
    });
    expect(result.ok).toBe(false);
    expect(result.stopReason).toBe('step_out_of_range');
  });

  it('hard-blocks a forbidden step regardless of approval', async () => {
    const { page, raw } = fakePage({ startUrl: 'https://example.com/x' });
    const forbidden: AoiBrowserDriveActionRequest = {
      kind: 'type',
      selector: '#pw',
      text: 'hunter2',
      field: { type: 'password' },
    };
    const result = await executeAoiBrowserDriveStep({
      page,
      plan: plan(forbidden),
      stepIndex: 0,
      allowlist: ALLOWLIST,
      approvalGate: allowGate,
      now: 1,
    });
    expect(result.ok).toBe(false);
    expect(result.stopReason).toBe('forbidden');
    expect(raw.fill).not.toHaveBeenCalled();
  });

  it('refuses when the plan is inadmissible (too many steps) even for a benign step', async () => {
    const many = Array.from(
      { length: 3 },
      () => ({ kind: 'scroll' }) as AoiBrowserDriveActionRequest,
    );
    const { page } = fakePage({ startUrl: 'https://example.com/x' });
    const result = await executeAoiBrowserDriveStep({
      page,
      plan: plan(...many),
      stepIndex: 0,
      allowlist: ALLOWLIST,
      approvalGate: allowGate,
      now: 1,
      maxPlanSteps: 2,
    });
    expect(result.ok).toBe(false);
    expect(result.stopReason).toBe('plan_inadmissible');
    expect(result.detail).toContain('too_many_steps');
  });

  it('hard-blocks a financial-commit click discovered from the LIVE DOM even when the model omits targetText', async () => {
    // Model supplies an innocuous-looking click with NO targetText, but the real
    // element text is a money button -> the DOM re-check must forbid it.
    const { page, raw } = fakePage({
      startUrl: 'https://example.com/x',
      domTextContent: 'Place order',
    });
    const result = await executeAoiBrowserDriveStep({
      page,
      plan: plan({ kind: 'click', selector: '#submit-order' }),
      stepIndex: 0,
      allowlist: ALLOWLIST,
      approvalGate: allowGate,
      now: 1,
    });
    expect(result.ok).toBe(false);
    expect(result.stopReason).toBe('forbidden');
    expect(raw.click).not.toHaveBeenCalled();
  });

  it('hard-blocks typing into a password field discovered from the LIVE DOM (model omitted field.type)', async () => {
    const { page, raw } = fakePage({
      startUrl: 'https://example.com/x',
      domAttributes: { type: 'password' },
    });
    const result = await executeAoiBrowserDriveStep({
      page,
      // No field metadata supplied by the model; the DOM says type=password.
      plan: plan({ kind: 'type', selector: '#pw', text: 'secret' }),
      stepIndex: 0,
      allowlist: ALLOWLIST,
      approvalGate: allowGate,
      now: 1,
    });
    expect(result.ok).toBe(false);
    expect(result.stopReason).toBe('forbidden');
    expect(raw.fill).not.toHaveBeenCalled();
  });

  it('refuses to act on a page that is not allowlisted', async () => {
    const { page, raw } = fakePage({ startUrl: 'https://evil.test/x' });
    const result = await executeAoiBrowserDriveStep({
      page,
      plan: plan({ kind: 'click', selector: '#go' }),
      stepIndex: 0,
      allowlist: ALLOWLIST,
      approvalGate: allowGate,
      now: 1,
    });
    expect(result.ok).toBe(false);
    expect(result.stopReason).toBe('not_allowlisted');
    expect(raw.click).not.toHaveBeenCalled();
  });
});

describe('executeAoiBrowserDriveStep - approval gating', () => {
  it('does not execute an ACT when approval is denied', async () => {
    const { page, raw } = fakePage({ startUrl: 'https://example.com/x' });
    const result = await executeAoiBrowserDriveStep({
      page,
      plan: plan({ kind: 'click', selector: '#go' }),
      stepIndex: 0,
      allowlist: ALLOWLIST,
      approvalGate: denyGate,
      now: 1,
    });
    expect(result.ok).toBe(false);
    expect(result.stopReason).toBe('approval_denied');
    expect(result.approvalFingerprint).toMatch(/^[a-f0-9]+$/i);
    expect(raw.click).not.toHaveBeenCalled();
  });

  it('is fail-closed when the approval gate throws', async () => {
    const { page, raw } = fakePage({ startUrl: 'https://example.com/x' });
    const throwGate: AoiBrowserDriveApprovalGate = async () => {
      throw new Error('store unreachable');
    };
    const result = await executeAoiBrowserDriveStep({
      page,
      plan: plan({ kind: 'click', selector: '#go' }),
      stepIndex: 0,
      allowlist: ALLOWLIST,
      approvalGate: throwGate,
      now: 1,
    });
    expect(result.ok).toBe(false);
    expect(result.stopReason).toBe('approval_gate_error');
    expect(raw.click).not.toHaveBeenCalled();
  });

  it('passes the exact fingerprint to the gate', async () => {
    const { page } = fakePage({ startUrl: 'https://example.com/x' });
    const action: AoiBrowserDriveActionRequest = { kind: 'click', selector: '#go' };
    const seen: string[] = [];
    const gate: AoiBrowserDriveApprovalGate = async ({ fingerprint }) => {
      seen.push(fingerprint);
      return { approved: true };
    };
    const p = plan(action);
    await executeAoiBrowserDriveStep({
      page,
      plan: p,
      stepIndex: 0,
      allowlist: ALLOWLIST,
      approvalGate: gate,
      now: 1,
    });
    // Fingerprint is bound to the acting host (example.com from the start URL).
    expect(seen[0]).toBe(computeAoiBrowserDriveActionFingerprint(p.goal, 0, action, 'example.com'));
  });
});

describe('executeAoiBrowserDriveStep - ACT execution', () => {
  it('executes an approved click and confirms it stayed on-allowlist', async () => {
    const { page, raw } = fakePage({
      startUrl: 'https://example.com/x',
      actLandingUrl: 'https://example.com/y',
    });
    const result = await executeAoiBrowserDriveStep({
      page,
      plan: plan({ kind: 'click', selector: '#go' }),
      stepIndex: 0,
      allowlist: ALLOWLIST,
      approvalGate: allowGate,
      now: 1,
    });
    expect(result.ok).toBe(true);
    expect(result.finalUrl).toBe('https://example.com/y');
    expect(raw.click).toHaveBeenCalledWith('#go', expect.anything());
  });

  it('blanks and stops when an ACT drifts off-allowlist', async () => {
    const { page, raw } = fakePage({
      startUrl: 'https://example.com/x',
      actLandingUrl: 'https://evil.test/steal',
    });
    const result = await executeAoiBrowserDriveStep({
      page,
      plan: plan({ kind: 'click', selector: '#go' }),
      stepIndex: 0,
      allowlist: ALLOWLIST,
      approvalGate: allowGate,
      now: 1,
    });
    expect(result.ok).toBe(false);
    expect(result.stopReason).toBe('drift_off_allowlist');
    expect(raw.goto).toHaveBeenCalledWith('about:blank', expect.anything());
  });

  it('maps type->fill, select->selectOption, press, submit->click', async () => {
    for (const [action, method] of [
      [{ kind: 'type', selector: '#name', text: 'kkulbo' } as AoiBrowserDriveActionRequest, 'fill'],
      [
        { kind: 'select', selector: '#opt', value: 'a' } as AoiBrowserDriveActionRequest,
        'selectOption',
      ],
      [{ kind: 'press', selector: '#f', key: 'Enter' } as AoiBrowserDriveActionRequest, 'press'],
      [{ kind: 'submit', selector: '#form button' } as AoiBrowserDriveActionRequest, 'click'],
    ] as const) {
      const { page, raw } = fakePage({ startUrl: 'https://example.com/x' });
      const result = await executeAoiBrowserDriveStep({
        page,
        plan: plan(action),
        stepIndex: 0,
        allowlist: ALLOWLIST,
        approvalGate: allowGate,
        now: 1,
      });
      expect(result.ok).toBe(true);
      expect(
        (raw as unknown as Record<string, ReturnType<typeof vi.fn>>)[method],
      ).toHaveBeenCalled();
    }
  });

  it('requires a selector for an ACT', async () => {
    const { page } = fakePage({ startUrl: 'https://example.com/x' });
    const result = await executeAoiBrowserDriveStep({
      page,
      plan: plan({ kind: 'click' }),
      stepIndex: 0,
      allowlist: ALLOWLIST,
      approvalGate: allowGate,
      now: 1,
    });
    expect(result.ok).toBe(false);
    expect(result.stopReason).toBe('action_failed');
  });

  it('reports action_failed when the page throws', async () => {
    const { page } = fakePage({ startUrl: 'https://example.com/x', failClick: true });
    const result = await executeAoiBrowserDriveStep({
      page,
      plan: plan({ kind: 'click', selector: '#go' }),
      stepIndex: 0,
      allowlist: ALLOWLIST,
      approvalGate: allowGate,
      now: 1,
    });
    expect(result.ok).toBe(false);
    expect(result.stopReason).toBe('action_failed');
    expect(result.detail).toContain('element not found');
  });
});

describe('executeAoiBrowserDriveStep - READ execution', () => {
  it('navigate reuses navigateAndExtract and returns a snapshot', async () => {
    const { page } = fakePage();
    const result = await executeAoiBrowserDriveStep({
      page,
      plan: plan({ kind: 'navigate', url: 'https://example.com/account' }),
      stepIndex: 0,
      allowlist: ALLOWLIST,
      approvalGate: allowGate,
      now: 1000,
    });
    expect(result.ok).toBe(true);
    expect(result.extract?.ok).toBe(true);
    expect(result.extract?.hostname).toBe('example.com');
  });

  it('navigate to a non-allowlisted url stops with not_allowlisted (no approval needed)', async () => {
    const { page, raw } = fakePage();
    const result = await executeAoiBrowserDriveStep({
      page,
      plan: plan({ kind: 'navigate', url: 'https://evil.test/x' }),
      stepIndex: 0,
      allowlist: ALLOWLIST,
      approvalGate: denyGate,
      now: 1,
    });
    expect(result.ok).toBe(false);
    expect(result.stopReason).toBe('not_allowlisted');
    expect(raw.goto).not.toHaveBeenCalled();
  });

  it('extract reads the current page', async () => {
    const { page } = fakePage({ startUrl: 'https://example.com/account' });
    const result = await executeAoiBrowserDriveStep({
      page,
      plan: plan({ kind: 'extract' }),
      stepIndex: 0,
      allowlist: ALLOWLIST,
      approvalGate: allowGate,
      now: 1,
    });
    expect(result.ok).toBe(true);
    expect(result.extract?.title).toBe('Dashboard');
    expect(result.extract?.text).toContain('messages');
  });

  it('scroll, screenshot, wait, back run without approval', async () => {
    const sleep = vi.fn(async () => {});
    const { page, raw } = fakePage({ startUrl: 'https://example.com/x' });

    const scroll = await executeAoiBrowserDriveStep({
      page,
      plan: plan({ kind: 'scroll', value: 'up' }),
      stepIndex: 0,
      allowlist: ALLOWLIST,
      approvalGate: denyGate,
      now: 1,
    });
    expect(scroll.ok).toBe(true);
    expect(raw.mouse.wheel).toHaveBeenCalledWith(0, -600);

    const shot = await executeAoiBrowserDriveStep({
      page,
      plan: plan({ kind: 'screenshot' }),
      stepIndex: 0,
      allowlist: ALLOWLIST,
      approvalGate: denyGate,
      now: 1,
    });
    expect(shot.ok).toBe(true);
    expect(shot.screenshotBase64).toBe(Buffer.from([1, 2, 3, 4]).toString('base64'));

    const wait = await executeAoiBrowserDriveStep({
      page,
      plan: plan({ kind: 'wait', value: '250' }),
      stepIndex: 0,
      allowlist: ALLOWLIST,
      approvalGate: denyGate,
      now: 1,
      sleep,
    });
    expect(wait.ok).toBe(true);
    expect(sleep).toHaveBeenCalledWith(250);

    const back = await executeAoiBrowserDriveStep({
      page,
      plan: plan({ kind: 'back' }),
      stepIndex: 0,
      allowlist: ALLOWLIST,
      approvalGate: denyGate,
      now: 1,
    });
    expect(back.ok).toBe(true);
  });

  it('back that drifts off-allowlist is blanked and stopped', async () => {
    const { page, raw } = fakePage({
      startUrl: 'https://example.com/x',
      actLandingUrl: 'https://evil.test/z',
    });
    const result = await executeAoiBrowserDriveStep({
      page,
      plan: plan({ kind: 'back' }),
      stepIndex: 0,
      allowlist: ALLOWLIST,
      approvalGate: allowGate,
      now: 1,
    });
    expect(result.ok).toBe(false);
    expect(result.stopReason).toBe('drift_off_allowlist');
    expect(raw.goto).toHaveBeenCalledWith('about:blank', expect.anything());
  });
});

describe('executeAoiBrowserDriveStep - observer', () => {
  it('captures before/after observations and never fails the step on observer error', async () => {
    const { page } = fakePage({ startUrl: 'https://example.com/x' });
    const observer: AoiBrowserDriveObserver = {
      onStep: vi.fn(async (ctx) => {
        if (ctx.phase === 'after') {
          throw new Error('capture crashed');
        }
        return { screenshotRef: `ref-${ctx.phase}` };
      }),
    };
    const result = await executeAoiBrowserDriveStep({
      page,
      plan: plan({ kind: 'click', selector: '#go' }),
      stepIndex: 0,
      allowlist: ALLOWLIST,
      approvalGate: allowGate,
      now: 1,
      observer,
    });
    expect(result.ok).toBe(true);
    expect(result.observation?.before?.screenshotRef).toBe('ref-before');
    expect(result.observation?.after).toBeUndefined();
  });
});

describe('runAoiBrowserDrivePlan', () => {
  it('runs an all-read plan to completion', async () => {
    const { page } = fakePage({ startUrl: 'https://example.com/x' });
    const result = await runAoiBrowserDrivePlan({
      page,
      plan: plan({ kind: 'scroll' }, { kind: 'extract' }),
      allowlist: ALLOWLIST,
      approvalGate: allowGate,
      now: 1,
    });
    expect(result.admissible).toBe(true);
    expect(result.stopped).toBe(false);
    expect(result.steps).toHaveLength(2);
  });

  it('refuses an inadmissible plan without touching the browser', async () => {
    const { page, raw } = fakePage({ startUrl: 'https://example.com/x' });
    const result = await runAoiBrowserDrivePlan({
      page,
      plan: { goal: 'x', steps: [] },
      allowlist: ALLOWLIST,
      approvalGate: allowGate,
      now: 1,
    });
    expect(result.admissible).toBe(false);
    expect(result.stopped).toBe(true);
    expect(result.stopReason).toBe('plan_inadmissible');
    expect(raw.content).not.toHaveBeenCalled();
  });

  it('stops at the first non-ok step', async () => {
    const { page } = fakePage({ startUrl: 'https://example.com/x' });
    const result = await runAoiBrowserDrivePlan({
      page,
      plan: plan({ kind: 'scroll' }, { kind: 'click', selector: '#go' }, { kind: 'extract' }),
      allowlist: ALLOWLIST,
      approvalGate: denyGate,
      now: 1,
    });
    expect(result.stopped).toBe(true);
    expect(result.stopReason).toBe('approval_denied');
    expect(result.steps).toHaveLength(2);
  });
});
