import { describe, expect, it } from 'vitest';
import {
  getAoiAutonomyRoute,
  resolveAoiServerWakeupDailyBudgets,
  sanitizeAoiWakeupBudgetFromHttp,
} from '../aoiAutonomyPlugin';

describe('Aoi autonomy plugin routes', () => {
  it('matches only the Aoi autonomy API prefix', () => {
    expect(getAoiAutonomyRoute('/api/aoi-autonomy/status')).toBe('/status');
    expect(getAoiAutonomyRoute('/api/aoi-autonomy/tick')).toBe('/tick');
    expect(getAoiAutonomyRoute('/api/aoi-autonomy/goals')).toBe('/goals');
    expect(getAoiAutonomyRoute('/api/aoi-autonomy/evaluation')).toBe('/evaluation');
    expect(getAoiAutonomyRoute('/api/aoi-autonomy/sources')).toBe('/sources');
    expect(getAoiAutonomyRoute('/api/aoi-autonomy/workspace')).toBe('/workspace');
    expect(getAoiAutonomyRoute('/api/aoi-autonomy/workspace/validation')).toBe(
      '/workspace/validation',
    );
    expect(getAoiAutonomyRoute('/api/aoi-autonomy/outcomes')).toBe('/outcomes');
    expect(getAoiAutonomyRoute('/api/aoi-autonomy/outcomes/operator-feedback')).toBe(
      '/outcomes/operator-feedback',
    );
    expect(getAoiAutonomyRoute('/api/aoi-autonomy/goal/decision')).toBe('/goal/decision');
    expect(getAoiAutonomyRoute('/api/aoi-autonomy/goal/check')).toBe('/goal/check');
    expect(getAoiAutonomyRoute('/api/aoi-autonomy/proposal/feedback')).toBe('/proposal/feedback');
    expect(getAoiAutonomyRoute('/api/aoi-autonomy/proactive-briefs')).toBe('/proactive-briefs');
    expect(getAoiAutonomyRoute('/api/aoi-autonomy/proactive-briefs/feedback')).toBe(
      '/proactive-briefs/feedback',
    );
    expect(getAoiAutonomyRoute('/api/aoi-autonomy/proactive-briefs/scout')).toBe(
      '/proactive-briefs/scout',
    );
    expect(getAoiAutonomyRoute('/api/aoi-autonomy')).toBe('/');
    expect(getAoiAutonomyRoute('/api/aoi-autonomyx/status')).toBeNull();
    expect(getAoiAutonomyRoute('/api/aoi-research/status')).toBeNull();
  });
});

describe('sanitizeAoiWakeupBudgetFromHttp', () => {
  const serverDailyBudgets = {
    llmDailyTokenBudget: 200_000,
    scoutNetworkDailyBudget: 8,
    directChatDailyBudget: 3,
  };
  const open = { policyAllowsNetwork: true, ceilingPermitsNetwork: true, serverDailyBudgets };

  it('grants network only when the request, the policy and the deployment ceiling all allow it', () => {
    expect(sanitizeAoiWakeupBudgetFromHttp({ allowNetwork: true }, open).allowNetwork).toBe(true);
    // The deployment hard-off wins over a client that asks for network.
    expect(
      sanitizeAoiWakeupBudgetFromHttp(
        { allowNetwork: true },
        { ...open, ceilingPermitsNetwork: false },
      ).allowNetwork,
    ).toBe(false);
    expect(
      sanitizeAoiWakeupBudgetFromHttp(
        { allowNetwork: true },
        { ...open, policyAllowsNetwork: false },
      ).allowNetwork,
    ).toBe(false);
    expect(sanitizeAoiWakeupBudgetFromHttp({}, open).allowNetwork).toBe(false);
    expect(sanitizeAoiWakeupBudgetFromHttp(undefined, open).allowNetwork).toBe(false);
  });

  it('lets daily budgets only tighten and keeps capability opt-ins server-side', () => {
    const budget = sanitizeAoiWakeupBudgetFromHttp(
      {
        // 0 is "unlimited" downstream, -5 is invalid: both get the server budget.
        llmDailyTokenBudget: 0,
        scoutNetworkDailyBudget: -5,
        directChatDailyBudget: 2,
        goalSynthesisEnabled: true,
        idleConfidenceSurgeEnabled: true,
        maxSchedulerRuntimeMs: 150000,
      },
      open,
    );
    expect(budget.llmDailyTokenBudget).toBe(200_000);
    expect(budget.scoutNetworkDailyBudget).toBe(8);
    expect(budget.directChatDailyBudget).toBe(2);
    expect(budget.goalSynthesisEnabled).toBeUndefined();
    expect(budget.idleConfidenceSurgeEnabled).toBeUndefined();
    // Runtime and count fields are clamped by the scheduler itself.
    expect(budget.maxSchedulerRuntimeMs).toBe(150000);
  });

  it('never lets a request raise a daily budget above the server one', () => {
    // A larger number used to pass straight through and lift the token ceiling.
    const raised = sanitizeAoiWakeupBudgetFromHttp(
      { llmDailyTokenBudget: 1e12, scoutNetworkDailyBudget: 9, directChatDailyBudget: 99 },
      open,
    );
    expect(raised).toMatchObject(serverDailyBudgets);
    // Nothing asked: the server's budget, not the module default, applies.
    expect(sanitizeAoiWakeupBudgetFromHttp(undefined, open)).toMatchObject(serverDailyBudgets);
    // An operator's explicit unlimited (0) is kept, and a request may only narrow it.
    const unlimited = { ...serverDailyBudgets, llmDailyTokenBudget: 0 };
    expect(
      sanitizeAoiWakeupBudgetFromHttp({}, { ...open, serverDailyBudgets: unlimited })
        .llmDailyTokenBudget,
    ).toBe(0);
    expect(
      sanitizeAoiWakeupBudgetFromHttp(
        { llmDailyTokenBudget: 5_000 },
        { ...open, serverDailyBudgets: unlimited },
      ).llmDailyTokenBudget,
    ).toBe(5_000);
  });
});

describe('resolveAoiServerWakeupDailyBudgets', () => {
  it('reads the env budgets the background runner uses, else the defaults', () => {
    expect(resolveAoiServerWakeupDailyBudgets({})).toEqual({
      llmDailyTokenBudget: 200_000,
      scoutNetworkDailyBudget: 8,
      directChatDailyBudget: 3,
    });
    expect(
      resolveAoiServerWakeupDailyBudgets({
        AOI_AUTONOMY_LLM_DAILY_TOKEN_BUDGET: '50000',
        AOI_AUTONOMY_SCOUT_NETWORK_DAILY_BUDGET: '0',
        AOI_AUTONOMY_DIRECT_CHAT_DAILY_BUDGET: 'not a number',
      }),
    ).toEqual({
      llmDailyTokenBudget: 50_000,
      scoutNetworkDailyBudget: 0,
      directChatDailyBudget: 3,
    });
  });
});
