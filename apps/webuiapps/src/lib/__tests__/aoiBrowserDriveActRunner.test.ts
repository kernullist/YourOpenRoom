import { describe, expect, it, vi } from 'vitest';
import {
  executeAoiBrowserDriveActStep,
  previewAoiBrowserDriveActStep,
  type AoiBrowserDriveRunnerSession,
  type AoiBrowserDriveSessionFactory,
} from '../aoiBrowserDriveActRunner';
import {
  type AoiBrowserDriveActablePage,
  type AoiBrowserDriveApprovalGate,
} from '../aoiBrowserDriveExecutor';
import {
  addAoiBrowserDriveAllowlistEntry,
  type AoiBrowserDriveAllowlist,
} from '../aoiBrowserDriveAllowlist';
import type { AoiBrowserDrivePlan } from '../aoiBrowserDrivePlan';
import type { AoiBrowserDriveActionRequest } from '../aoiBrowserDriveAction';

// Denylist: block evil.test. example.com and other hosts are allowed by default.
const ALLOWLIST: AoiBrowserDriveAllowlist = addAoiBrowserDriveAllowlistEntry(
  { version: 1, entries: [], updatedAt: 0 },
  { domain: 'evil.test' },
  1,
).allowlist;

function fakePage(options: { landingUrl?: string; actLandingUrl?: string } = {}) {
  let current = 'about:blank';
  const landingUrl = options.landingUrl ?? 'https://example.com/account';
  const page = {
    url: () => current,
    goto: vi.fn(async (target: string) => {
      current = target === 'about:blank' ? 'about:blank' : landingUrl;
    }),
    content: vi.fn(async () => '<html><body><p>ok</p></body></html>'),
    title: vi.fn(async () => 'T'),
    click: vi.fn(async () => {
      if (options.actLandingUrl) {
        current = options.actLandingUrl;
      }
    }),
    fill: vi.fn(async () => {}),
    selectOption: vi.fn(async () => []),
    press: vi.fn(async () => {}),
    goBack: vi.fn(async () => null),
    screenshot: vi.fn(async () => new Uint8Array([9, 9, 9])),
    mouse: { wheel: vi.fn(async () => {}) },
  };
  return page as unknown as AoiBrowserDriveActablePage;
}

function sessionFactory(page: AoiBrowserDriveActablePage) {
  const close = vi.fn(async () => {});
  const factory: AoiBrowserDriveSessionFactory = async () =>
    ({ page, close }) as AoiBrowserDriveRunnerSession;
  return { factory, close };
}

const allowGate: AoiBrowserDriveApprovalGate = async () => ({ approved: true });
const denyGate: AoiBrowserDriveApprovalGate = async () => ({ approved: false, reason: 'nope' });

function plan(...actions: AoiBrowserDriveActionRequest[]): AoiBrowserDrivePlan {
  return {
    goal: 'do it',
    steps: actions.map((action, index) => ({ description: `step ${index}`, action })),
  };
}

const navStep: AoiBrowserDriveActionRequest = {
  kind: 'navigate',
  url: 'https://example.com/account',
};
const clickStep: AoiBrowserDriveActionRequest = { kind: 'click', selector: '#go' };

describe('runner guards', () => {
  it('rejects an out-of-range target', async () => {
    const { factory } = sessionFactory(fakePage());
    const result = await executeAoiBrowserDriveActStep({
      plan: plan(clickStep),
      targetStepIndex: 4,
      allowlist: ALLOWLIST,
      sessionFactory: factory,
      approvalGate: allowGate,
      now: 1,
    });
    expect(result).toMatchObject({ ok: false, reason: 'step_out_of_range' });
  });

  it('rejects a prefix that contains an act (stateless model allows one act)', async () => {
    const { factory, close } = sessionFactory(fakePage());
    const result = await executeAoiBrowserDriveActStep({
      plan: plan(navStep, clickStep, clickStep),
      targetStepIndex: 2,
      allowlist: ALLOWLIST,
      sessionFactory: factory,
      approvalGate: allowGate,
      now: 1,
    });
    expect(result).toMatchObject({ ok: false, reason: 'prefix_contains_act' });
    // Guard runs before opening a session.
    expect(close).not.toHaveBeenCalled();
  });

  it('reports session_start_failed when the factory throws', async () => {
    const factory: AoiBrowserDriveSessionFactory = async () => {
      throw new Error('SingletonLock');
    };
    const result = await executeAoiBrowserDriveActStep({
      plan: plan(clickStep),
      targetStepIndex: 0,
      allowlist: ALLOWLIST,
      sessionFactory: factory,
      approvalGate: allowGate,
      now: 1,
    });
    expect(result).toMatchObject({ ok: false, reason: 'session_start_failed' });
  });
});

describe('previewAoiBrowserDriveActStep', () => {
  it('replays the read prefix and captures a before-screenshot', async () => {
    const page = fakePage();
    const { factory, close } = sessionFactory(page);
    const result = await previewAoiBrowserDriveActStep({
      plan: plan(navStep, clickStep),
      targetStepIndex: 1,
      allowlist: ALLOWLIST,
      sessionFactory: factory,
      now: 1,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.hostname).toBe('example.com');
      expect(result.finalUrl).toBe('https://example.com/account');
      expect(result.beforeScreenshotBase64).toBe(Buffer.from([9, 9, 9]).toString('base64'));
      expect(result.prefix).toHaveLength(1);
    }
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('fails when a prefix read drifts onto a denylisted host', async () => {
    const page = fakePage({ landingUrl: 'https://evil.test/x' });
    const { factory, close } = sessionFactory(page);
    const result = await previewAoiBrowserDriveActStep({
      plan: plan(navStep, clickStep),
      targetStepIndex: 1,
      allowlist: ALLOWLIST,
      sessionFactory: factory,
      now: 1,
    });
    expect(result).toMatchObject({ ok: false, reason: 'prefix_failed' });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('rejects a bad target index before opening a session', async () => {
    const { factory, close } = sessionFactory(fakePage());
    const result = await previewAoiBrowserDriveActStep({
      plan: plan(clickStep),
      targetStepIndex: 7,
      allowlist: ALLOWLIST,
      sessionFactory: factory,
      now: 1,
    });
    expect(result).toMatchObject({ ok: false, reason: 'step_out_of_range' });
    expect(close).not.toHaveBeenCalled();
  });

  it('reports session_start_failed on factory error', async () => {
    const factory: AoiBrowserDriveSessionFactory = async () => {
      throw new Error('locked');
    };
    const result = await previewAoiBrowserDriveActStep({
      plan: plan(navStep, clickStep),
      targetStepIndex: 1,
      allowlist: ALLOWLIST,
      sessionFactory: factory,
      now: 1,
    });
    expect(result).toMatchObject({ ok: false, reason: 'session_start_failed' });
  });

  it('returns ok without a screenshot when the capture throws (best-effort)', async () => {
    const page = fakePage();
    (page as unknown as { screenshot: () => Promise<Uint8Array> }).screenshot = vi.fn(async () => {
      throw new Error('surface lost');
    });
    const { factory } = sessionFactory(page);
    const observer = { onStep: vi.fn(async () => ({ screenshotRef: 'r' })) };
    const result = await previewAoiBrowserDriveActStep({
      plan: plan(navStep, clickStep),
      targetStepIndex: 1,
      allowlist: ALLOWLIST,
      sessionFactory: factory,
      now: 1,
      timeoutMs: 5_000,
      observer,
      maxPlanSteps: 10,
      sleep: async () => {},
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.beforeScreenshotBase64).toBeUndefined();
    }
  });
});

describe('executeAoiBrowserDriveActStep', () => {
  it('replays the read prefix then runs the approved target act', async () => {
    const page = fakePage();
    const { factory, close } = sessionFactory(page);
    const result = await executeAoiBrowserDriveActStep({
      plan: plan(navStep, clickStep),
      targetStepIndex: 1,
      allowlist: ALLOWLIST,
      sessionFactory: factory,
      approvalGate: allowGate,
      now: 1,
    });
    expect(result.ok).toBe(true);
    if ('target' in result) {
      expect(result.target.ok).toBe(true);
      expect(result.target.category).toBe('act');
      expect(result.prefix).toHaveLength(1);
    }
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('does not run the act when the gate denies (target result carries the reason)', async () => {
    const page = fakePage();
    const { factory, close } = sessionFactory(page);
    const result = await executeAoiBrowserDriveActStep({
      plan: plan(navStep, clickStep),
      targetStepIndex: 1,
      allowlist: ALLOWLIST,
      sessionFactory: factory,
      approvalGate: denyGate,
      now: 1,
    });
    expect(result.ok).toBe(false);
    if ('target' in result) {
      expect(result.target.stopReason).toBe('approval_denied');
    }
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('runs a single-act plan with no prefix', async () => {
    const page = fakePage({ landingUrl: 'https://example.com/account' });
    // Seed the page onto an allowlisted url via a nav-free plan: the act step must
    // find the page already allowlisted, so start it there.
    (page as unknown as { goto: (u: string) => Promise<void> }).goto('https://example.com/account');
    const { factory } = sessionFactory(page);
    const result = await executeAoiBrowserDriveActStep({
      plan: plan(clickStep),
      targetStepIndex: 0,
      allowlist: ALLOWLIST,
      sessionFactory: factory,
      approvalGate: allowGate,
      now: 1,
    });
    // No prefix; the page is already on an allowlisted url.
    if ('target' in result) {
      expect(result.prefix).toHaveLength(0);
      expect(result.target.ok).toBe(true);
    }
  });

  it('stops with prefix_failed when a prefix read fails', async () => {
    const page = fakePage({ landingUrl: 'https://evil.test/x' });
    const { factory, close } = sessionFactory(page);
    const result = await executeAoiBrowserDriveActStep({
      plan: plan(navStep, clickStep),
      targetStepIndex: 1,
      allowlist: ALLOWLIST,
      sessionFactory: factory,
      approvalGate: allowGate,
      now: 1,
    });
    expect(result).toMatchObject({ ok: false, reason: 'prefix_failed' });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('records an audit entry per step with before/after artifact refs', async () => {
    const page = fakePage();
    const { factory } = sessionFactory(page);
    const artifacts: string[] = [];
    const entries: Array<Record<string, unknown>> = [];
    const result = await executeAoiBrowserDriveActStep({
      plan: plan(navStep, clickStep),
      targetStepIndex: 1,
      allowlist: ALLOWLIST,
      sessionFactory: factory,
      approvalGate: allowGate,
      now: 1,
      audit: {
        runId: 'run-x',
        writeArtifact: (relPath) => {
          artifacts.push(relPath);
        },
        recordEntry: (entry) => entries.push(entry as unknown as Record<string, unknown>),
      },
    });
    expect(result.ok).toBe(true);
    // One entry for the prefix navigate (step 0) and one for the target click (step 1).
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ runId: 'run-x', stepIndex: 0, category: 'read', ok: true });
    expect(entries[1]).toMatchObject({ runId: 'run-x', stepIndex: 1, category: 'act', ok: true });
    // The target act carries before/after screenshot refs from the audit observer.
    expect(entries[1].beforeScreenshotRef).toBe('run-x/step-1-before.png');
    expect(entries[1].afterScreenshotRef).toBe('run-x/step-1-after.png');
    expect(artifacts).toContain('run-x/step-1-before.png');
    expect(artifacts).toContain('run-x/step-1-after.html');
  });

  it('aborts before opening a session when panic is already engaged', async () => {
    const page = fakePage();
    const { factory, close } = sessionFactory(page);
    const result = await executeAoiBrowserDriveActStep({
      plan: plan(navStep, clickStep),
      targetStepIndex: 1,
      allowlist: ALLOWLIST,
      sessionFactory: factory,
      approvalGate: allowGate,
      now: 1,
      isPanicked: () => true,
    });
    expect(result).toMatchObject({ ok: false, reason: 'panicked' });
    expect(close).not.toHaveBeenCalled();
  });

  it('aborts before the act when panic engages during the read prefix (act not run)', async () => {
    const page = fakePage();
    const raw = page as unknown as { click: ReturnType<typeof vi.fn> };
    const { factory, close } = sessionFactory(page);
    let calls = 0;
    // Not panicked at the entry check; panicked by the pre-act re-check.
    const result = await executeAoiBrowserDriveActStep({
      plan: plan(navStep, clickStep),
      targetStepIndex: 1,
      allowlist: ALLOWLIST,
      sessionFactory: factory,
      approvalGate: allowGate,
      now: 1,
      isPanicked: () => {
        calls += 1;
        return calls > 1;
      },
    });
    expect(result).toMatchObject({ ok: false, reason: 'panicked' });
    expect(raw.click).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('is fail-closed when the panic check throws', async () => {
    const page = fakePage();
    const { factory } = sessionFactory(page);
    const result = await executeAoiBrowserDriveActStep({
      plan: plan(clickStep),
      targetStepIndex: 0,
      allowlist: ALLOWLIST,
      sessionFactory: factory,
      approvalGate: allowGate,
      now: 1,
      isPanicked: () => {
        throw new Error('kill-switch read failed');
      },
    });
    expect(result).toMatchObject({ ok: false, reason: 'panicked' });
  });

  it('records the denied target step in the audit ledger too', async () => {
    const page = fakePage();
    const { factory } = sessionFactory(page);
    const entries: Array<Record<string, unknown>> = [];
    await executeAoiBrowserDriveActStep({
      plan: plan(navStep, clickStep),
      targetStepIndex: 1,
      allowlist: ALLOWLIST,
      sessionFactory: factory,
      approvalGate: denyGate,
      now: 1,
      audit: {
        runId: 'run-y',
        writeArtifact: () => {},
        recordEntry: (entry) => entries.push(entry as unknown as Record<string, unknown>),
      },
    });
    const target = entries.find((e) => e.stepIndex === 1);
    expect(target).toMatchObject({ ok: false, stopReason: 'approval_denied' });
  });
});
