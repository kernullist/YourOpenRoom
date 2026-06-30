import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_DIRECT_CHAT_BUDGET_WINDOW_MS,
  DEFAULT_DIRECT_CHAT_DAILY_BUDGET,
  checkAoiDirectChatBudget,
  loadAoiDirectChatBudgetState,
  normalizeAoiDirectChatBudgetState,
  recordAoiDirectChatOffer,
  resolveAoiDirectChatCeiling,
  saveAoiDirectChatBudgetState,
  type AoiDirectChatBudgetState,
} from '../aoiDirectChatBudget';

const SESSION_PATH = 'aoi/default';
const NOW = 1_800_000_000_000;
const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'aoi-direct-chat-budget-test-'));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function makeState(partial: Partial<AoiDirectChatBudgetState> = {}): AoiDirectChatBudgetState {
  return {
    version: 1,
    sessionPath: SESSION_PATH,
    windowStartedAt: NOW,
    windowMs: DEFAULT_DIRECT_CHAT_BUDGET_WINDOW_MS,
    offersSpent: 0,
    recordCount: 0,
    ...partial,
  };
}

describe('resolveAoiDirectChatCeiling', () => {
  it('defaults when unset/invalid and honors explicit values including 0', () => {
    expect(resolveAoiDirectChatCeiling(undefined)).toBe(DEFAULT_DIRECT_CHAT_DAILY_BUDGET);
    expect(resolveAoiDirectChatCeiling(Number.NaN)).toBe(DEFAULT_DIRECT_CHAT_DAILY_BUDGET);
    expect(resolveAoiDirectChatCeiling(-2)).toBe(DEFAULT_DIRECT_CHAT_DAILY_BUDGET);
    expect(resolveAoiDirectChatCeiling(0)).toBe(0);
    expect(resolveAoiDirectChatCeiling(7)).toBe(7);
  });
});

describe('checkAoiDirectChatBudget', () => {
  it('starts a fresh window when there is no prior state', () => {
    const result = checkAoiDirectChatBudget({
      state: null,
      sessionPath: SESSION_PATH,
      now: NOW,
      windowMs: DEFAULT_DIRECT_CHAT_BUDGET_WINDOW_MS,
      ceilingCalls: 3,
      estimatedCalls: 1,
    });
    expect(result.allowed).toBe(true);
    expect(result.rolledState.windowStartedAt).toBe(NOW);
    expect(result.rolledState.offersSpent).toBe(0);
  });

  it('allows while spend + estimate stays under the ceiling and blocks past it', () => {
    const ok = checkAoiDirectChatBudget({
      state: makeState({ offersSpent: 2 }),
      sessionPath: SESSION_PATH,
      now: NOW + 1000,
      windowMs: DEFAULT_DIRECT_CHAT_BUDGET_WINDOW_MS,
      ceilingCalls: 3,
      estimatedCalls: 1,
    });
    expect(ok.allowed).toBe(true);

    const blocked = checkAoiDirectChatBudget({
      state: makeState({ offersSpent: 3 }),
      sessionPath: SESSION_PATH,
      now: NOW + 1000,
      windowMs: DEFAULT_DIRECT_CHAT_BUDGET_WINDOW_MS,
      ceilingCalls: 3,
      estimatedCalls: 1,
    });
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toBe('direct_chat_daily_budget_exhausted');
    expect(blocked.rolledState.offersSpent).toBe(3);
  });

  it('rolls the window once it has elapsed, resetting spend', () => {
    const result = checkAoiDirectChatBudget({
      state: makeState({ offersSpent: 999 }),
      sessionPath: SESSION_PATH,
      now: NOW + DEFAULT_DIRECT_CHAT_BUDGET_WINDOW_MS + 1,
      windowMs: DEFAULT_DIRECT_CHAT_BUDGET_WINDOW_MS,
      ceilingCalls: 3,
      estimatedCalls: 1,
    });
    expect(result.allowed).toBe(true);
    expect(result.rolledState.offersSpent).toBe(0);
    expect(result.rolledState.windowStartedAt).toBe(NOW + DEFAULT_DIRECT_CHAT_BUDGET_WINDOW_MS + 1);
  });

  it('treats a ceiling of 0 as unlimited and still returns a rolled window', () => {
    const result = checkAoiDirectChatBudget({
      state: makeState({ offersSpent: 1_000_000 }),
      sessionPath: SESSION_PATH,
      now: NOW + 1000,
      windowMs: DEFAULT_DIRECT_CHAT_BUDGET_WINDOW_MS,
      ceilingCalls: 0,
      estimatedCalls: 5,
    });
    expect(result.allowed).toBe(true);
    expect(result.rolledState.offersSpent).toBe(1_000_000);
  });
});

describe('recordAoiDirectChatOffer', () => {
  it('accumulates offers and increments the record count, guarding negatives', () => {
    const next = recordAoiDirectChatOffer(makeState({ offersSpent: 1, recordCount: 1 }), NOW, 1);
    expect(next.offersSpent).toBe(2);
    expect(next.recordCount).toBe(2);
    const guarded = recordAoiDirectChatOffer(makeState({ offersSpent: 2 }), NOW, -4);
    expect(guarded.offersSpent).toBe(2);
    expect(guarded.recordCount).toBe(1);
  });
});

describe('direct chat budget persistence', () => {
  it('round-trips through save/load', () => {
    const root = makeTempRoot();
    const saved = saveAoiDirectChatBudgetState(
      root,
      SESSION_PATH,
      makeState({ offersSpent: 2, recordCount: 2 }),
    );
    expect(
      fs.existsSync(join(root, 'aoi', 'default', 'aoi-autonomy', 'direct-chat-budget-state.json')),
    ).toBe(true);
    expect(loadAoiDirectChatBudgetState(root, SESSION_PATH)).toEqual(saved);
  });

  it('returns null for a missing or malformed file', () => {
    const root = makeTempRoot();
    expect(loadAoiDirectChatBudgetState(root, SESSION_PATH)).toBeNull();
    const dir = join(root, 'aoi', 'default', 'aoi-autonomy');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(dir, 'direct-chat-budget-state.json'), 'not json {', 'utf-8');
    expect(loadAoiDirectChatBudgetState(root, SESSION_PATH)).toBeNull();
  });

  it('throws when the session path is invalid', () => {
    const root = makeTempRoot();
    expect(() => loadAoiDirectChatBudgetState(root, '')).toThrow();
  });

  it('normalizes malformed fields defensively', () => {
    const normalized = normalizeAoiDirectChatBudgetState(
      { windowStartedAt: -1, windowMs: 0, offersSpent: -9, recordCount: 'x' },
      SESSION_PATH,
    );
    expect(normalized).not.toBeNull();
    expect(normalized?.windowStartedAt).toBe(0);
    expect(normalized?.windowMs).toBe(DEFAULT_DIRECT_CHAT_BUDGET_WINDOW_MS);
    expect(normalized?.offersSpent).toBe(0);
    expect(normalized?.recordCount).toBe(0);
    expect(normalizeAoiDirectChatBudgetState(null, SESSION_PATH)).toBeNull();
  });
});

// Mirrors the exact composition the trend-delivery route runs on a 'direct_chat_offered'
// event: load -> roll (via a ceiling=0 check) -> record one offer -> persist.
describe('direct chat offer charging (delivery-route composition)', () => {
  function chargeOneOffer(root: string, now: number): AoiDirectChatBudgetState {
    const rolled = checkAoiDirectChatBudget({
      state: loadAoiDirectChatBudgetState(root, SESSION_PATH),
      sessionPath: SESSION_PATH,
      now,
      windowMs: DEFAULT_DIRECT_CHAT_BUDGET_WINDOW_MS,
      ceilingCalls: 0,
      estimatedCalls: 0,
    }).rolledState;
    return saveAoiDirectChatBudgetState(
      root,
      SESSION_PATH,
      recordAoiDirectChatOffer(rolled, now, 1),
    );
  }

  it('accumulates offers within the window and resets after it rolls', () => {
    const root = makeTempRoot();
    expect(chargeOneOffer(root, NOW).offersSpent).toBe(1);
    expect(chargeOneOffer(root, NOW + 1000).offersSpent).toBe(2);
    // Past the rolling window, the next charge starts a fresh window at one offer.
    const rolledOver = chargeOneOffer(root, NOW + DEFAULT_DIRECT_CHAT_BUDGET_WINDOW_MS + 1);
    expect(rolledOver.offersSpent).toBe(1);
    expect(rolledOver.windowStartedAt).toBe(NOW + DEFAULT_DIRECT_CHAT_BUDGET_WINDOW_MS + 1);
  });
});
