import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_LLM_BUDGET_WINDOW_MS,
  DEFAULT_LLM_DAILY_TOKEN_BUDGET,
  checkAoiLlmBudget,
  estimateAoiLlmTokens,
  loadAoiLlmBudgetState,
  normalizeAoiLlmBudgetState,
  recordAoiLlmSpend,
  resolveAoiLlmTokenCeiling,
  saveAoiLlmBudgetState,
  type AoiLlmBudgetState,
} from '../aoiAutonomyLlmBudget';

const SESSION_PATH = 'aoi/default';
const NOW = 1_800_000_000_000;
const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'aoi-llm-budget-test-'));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function makeState(partial: Partial<AoiLlmBudgetState> = {}): AoiLlmBudgetState {
  return {
    version: 1,
    sessionPath: SESSION_PATH,
    windowStartedAt: NOW,
    windowMs: DEFAULT_LLM_BUDGET_WINDOW_MS,
    tokensSpent: 0,
    callCount: 0,
    ...partial,
  };
}

describe('estimateAoiLlmTokens', () => {
  it('approximates tokens at chars/4 and is zero for empty/non-string', () => {
    expect(estimateAoiLlmTokens('')).toBe(0);
    expect(estimateAoiLlmTokens('abcd')).toBe(1);
    expect(estimateAoiLlmTokens('abcde')).toBe(2);
    expect(estimateAoiLlmTokens(undefined as unknown as string)).toBe(0);
  });
});

describe('resolveAoiLlmTokenCeiling', () => {
  it('defaults when unset/invalid and honors explicit values including 0', () => {
    expect(resolveAoiLlmTokenCeiling(undefined)).toBe(DEFAULT_LLM_DAILY_TOKEN_BUDGET);
    expect(resolveAoiLlmTokenCeiling(Number.NaN)).toBe(DEFAULT_LLM_DAILY_TOKEN_BUDGET);
    expect(resolveAoiLlmTokenCeiling(-5)).toBe(DEFAULT_LLM_DAILY_TOKEN_BUDGET);
    expect(resolveAoiLlmTokenCeiling(0)).toBe(0);
    expect(resolveAoiLlmTokenCeiling(5000)).toBe(5000);
  });
});

describe('checkAoiLlmBudget', () => {
  it('starts a fresh window when there is no prior state', () => {
    const result = checkAoiLlmBudget({
      state: null,
      sessionPath: SESSION_PATH,
      now: NOW,
      windowMs: DEFAULT_LLM_BUDGET_WINDOW_MS,
      ceilingTokens: 1000,
      estimatedTokens: 300,
    });
    expect(result.allowed).toBe(true);
    expect(result.rolledState.windowStartedAt).toBe(NOW);
    expect(result.rolledState.tokensSpent).toBe(0);
  });

  it('allows while spend + estimate stays under the ceiling and blocks past it', () => {
    const ok = checkAoiLlmBudget({
      state: makeState({ tokensSpent: 600 }),
      sessionPath: SESSION_PATH,
      now: NOW + 1000,
      windowMs: DEFAULT_LLM_BUDGET_WINDOW_MS,
      ceilingTokens: 1000,
      estimatedTokens: 300,
    });
    expect(ok.allowed).toBe(true);
    expect(ok.rolledState.tokensSpent).toBe(600);

    const blocked = checkAoiLlmBudget({
      state: makeState({ tokensSpent: 900 }),
      sessionPath: SESSION_PATH,
      now: NOW + 1000,
      windowMs: DEFAULT_LLM_BUDGET_WINDOW_MS,
      ceilingTokens: 1000,
      estimatedTokens: 300,
    });
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toBe('llm_token_budget_exhausted');
    expect(blocked.rolledState.tokensSpent).toBe(900);
  });

  it('rolls the window once it has elapsed, resetting spend', () => {
    const result = checkAoiLlmBudget({
      state: makeState({ tokensSpent: 999_999 }),
      sessionPath: SESSION_PATH,
      now: NOW + DEFAULT_LLM_BUDGET_WINDOW_MS + 1,
      windowMs: DEFAULT_LLM_BUDGET_WINDOW_MS,
      ceilingTokens: 1000,
      estimatedTokens: 300,
    });
    expect(result.allowed).toBe(true);
    expect(result.rolledState.tokensSpent).toBe(0);
    expect(result.rolledState.windowStartedAt).toBe(NOW + DEFAULT_LLM_BUDGET_WINDOW_MS + 1);
  });

  it('treats a ceiling of 0 as unlimited', () => {
    const result = checkAoiLlmBudget({
      state: makeState({ tokensSpent: 10_000_000 }),
      sessionPath: SESSION_PATH,
      now: NOW + 1000,
      windowMs: DEFAULT_LLM_BUDGET_WINDOW_MS,
      ceilingTokens: 0,
      estimatedTokens: 5000,
    });
    expect(result.allowed).toBe(true);
  });
});

describe('recordAoiLlmSpend', () => {
  it('accumulates tokens and increments the call count', () => {
    const next = recordAoiLlmSpend(makeState({ tokensSpent: 100, callCount: 2 }), NOW, 250);
    expect(next.tokensSpent).toBe(350);
    expect(next.callCount).toBe(3);
    const guarded = recordAoiLlmSpend(makeState({ tokensSpent: 100 }), NOW, -50);
    expect(guarded.tokensSpent).toBe(100);
  });
});

describe('llm budget persistence', () => {
  it('round-trips through save/load', () => {
    const root = makeTempRoot();
    const saved = saveAoiLlmBudgetState(
      root,
      SESSION_PATH,
      makeState({ tokensSpent: 4242, callCount: 7 }),
    );
    expect(
      fs.existsSync(join(root, 'aoi', 'default', 'aoi-autonomy', 'llm-budget-state.json')),
    ).toBe(true);
    expect(loadAoiLlmBudgetState(root, SESSION_PATH)).toEqual(saved);
  });

  it('returns null for a missing or malformed file', () => {
    const root = makeTempRoot();
    expect(loadAoiLlmBudgetState(root, SESSION_PATH)).toBeNull();
    const filePath = join(root, 'aoi', 'default', 'aoi-autonomy', 'llm-budget-state.json');
    fs.mkdirSync(join(root, 'aoi', 'default', 'aoi-autonomy'), { recursive: true });
    fs.writeFileSync(filePath, 'not json {', 'utf-8');
    expect(loadAoiLlmBudgetState(root, SESSION_PATH)).toBeNull();
  });

  it('normalizes malformed fields defensively', () => {
    const normalized = normalizeAoiLlmBudgetState(
      { windowStartedAt: -1, windowMs: 0, tokensSpent: -99, callCount: 'x' },
      SESSION_PATH,
    );
    expect(normalized).not.toBeNull();
    expect(normalized?.windowStartedAt).toBe(0);
    expect(normalized?.windowMs).toBe(DEFAULT_LLM_BUDGET_WINDOW_MS);
    expect(normalized?.tokensSpent).toBe(0);
    expect(normalized?.callCount).toBe(0);
    expect(normalizeAoiLlmBudgetState(null, SESSION_PATH)).toBeNull();
  });
});
