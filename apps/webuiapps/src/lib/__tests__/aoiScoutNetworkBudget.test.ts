import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SCOUT_NETWORK_BUDGET_WINDOW_MS,
  DEFAULT_SCOUT_NETWORK_DAILY_BUDGET,
  checkAoiScoutNetworkBudget,
  loadAoiScoutNetworkBudgetState,
  normalizeAoiScoutNetworkBudgetState,
  recordAoiScoutNetworkSpend,
  resolveAoiScoutNetworkCeiling,
  saveAoiScoutNetworkBudgetState,
  type AoiScoutNetworkBudgetState,
} from '../aoiScoutNetworkBudget';

const SESSION_PATH = 'aoi/default';
const NOW = 1_800_000_000_000;
const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'aoi-scout-network-budget-test-'));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function makeState(partial: Partial<AoiScoutNetworkBudgetState> = {}): AoiScoutNetworkBudgetState {
  return {
    version: 1,
    sessionPath: SESSION_PATH,
    windowStartedAt: NOW,
    windowMs: DEFAULT_SCOUT_NETWORK_BUDGET_WINDOW_MS,
    callsSpent: 0,
    recordCount: 0,
    ...partial,
  };
}

describe('resolveAoiScoutNetworkCeiling', () => {
  it('defaults when unset/invalid and honors explicit values including 0', () => {
    expect(resolveAoiScoutNetworkCeiling(undefined)).toBe(DEFAULT_SCOUT_NETWORK_DAILY_BUDGET);
    expect(resolveAoiScoutNetworkCeiling(Number.NaN)).toBe(DEFAULT_SCOUT_NETWORK_DAILY_BUDGET);
    expect(resolveAoiScoutNetworkCeiling(-2)).toBe(DEFAULT_SCOUT_NETWORK_DAILY_BUDGET);
    expect(resolveAoiScoutNetworkCeiling(0)).toBe(0);
    expect(resolveAoiScoutNetworkCeiling(20)).toBe(20);
  });
});

describe('checkAoiScoutNetworkBudget', () => {
  it('starts a fresh window when there is no prior state', () => {
    const result = checkAoiScoutNetworkBudget({
      state: null,
      sessionPath: SESSION_PATH,
      now: NOW,
      windowMs: DEFAULT_SCOUT_NETWORK_BUDGET_WINDOW_MS,
      ceilingCalls: 8,
      estimatedCalls: 1,
    });
    expect(result.allowed).toBe(true);
    expect(result.rolledState.windowStartedAt).toBe(NOW);
    expect(result.rolledState.callsSpent).toBe(0);
  });

  it('allows while spend + estimate stays under the ceiling and blocks past it', () => {
    const ok = checkAoiScoutNetworkBudget({
      state: makeState({ callsSpent: 6 }),
      sessionPath: SESSION_PATH,
      now: NOW + 1000,
      windowMs: DEFAULT_SCOUT_NETWORK_BUDGET_WINDOW_MS,
      ceilingCalls: 8,
      estimatedCalls: 1,
    });
    expect(ok.allowed).toBe(true);

    const blocked = checkAoiScoutNetworkBudget({
      state: makeState({ callsSpent: 8 }),
      sessionPath: SESSION_PATH,
      now: NOW + 1000,
      windowMs: DEFAULT_SCOUT_NETWORK_BUDGET_WINDOW_MS,
      ceilingCalls: 8,
      estimatedCalls: 1,
    });
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toBe('scout_network_budget_exhausted');
    expect(blocked.rolledState.callsSpent).toBe(8);
  });

  it('rolls the window once it has elapsed, resetting spend', () => {
    const result = checkAoiScoutNetworkBudget({
      state: makeState({ callsSpent: 999 }),
      sessionPath: SESSION_PATH,
      now: NOW + DEFAULT_SCOUT_NETWORK_BUDGET_WINDOW_MS + 1,
      windowMs: DEFAULT_SCOUT_NETWORK_BUDGET_WINDOW_MS,
      ceilingCalls: 8,
      estimatedCalls: 1,
    });
    expect(result.allowed).toBe(true);
    expect(result.rolledState.callsSpent).toBe(0);
    expect(result.rolledState.windowStartedAt).toBe(
      NOW + DEFAULT_SCOUT_NETWORK_BUDGET_WINDOW_MS + 1,
    );
  });

  it('treats a ceiling of 0 as unlimited', () => {
    const result = checkAoiScoutNetworkBudget({
      state: makeState({ callsSpent: 1_000_000 }),
      sessionPath: SESSION_PATH,
      now: NOW + 1000,
      windowMs: DEFAULT_SCOUT_NETWORK_BUDGET_WINDOW_MS,
      ceilingCalls: 0,
      estimatedCalls: 5,
    });
    expect(result.allowed).toBe(true);
  });
});

describe('recordAoiScoutNetworkSpend', () => {
  it('accumulates calls and increments the record count, guarding negatives', () => {
    const next = recordAoiScoutNetworkSpend(makeState({ callsSpent: 2, recordCount: 1 }), NOW, 3);
    expect(next.callsSpent).toBe(5);
    expect(next.recordCount).toBe(2);
    const guarded = recordAoiScoutNetworkSpend(makeState({ callsSpent: 2 }), NOW, -4);
    expect(guarded.callsSpent).toBe(2);
    expect(guarded.recordCount).toBe(1);
  });
});

describe('scout network budget persistence', () => {
  it('round-trips through save/load', () => {
    const root = makeTempRoot();
    const saved = saveAoiScoutNetworkBudgetState(
      root,
      SESSION_PATH,
      makeState({ callsSpent: 5, recordCount: 3 }),
    );
    expect(
      fs.existsSync(
        join(root, 'aoi', 'default', 'aoi-autonomy', 'scout-network-budget-state.json'),
      ),
    ).toBe(true);
    expect(loadAoiScoutNetworkBudgetState(root, SESSION_PATH)).toEqual(saved);
  });

  it('returns null for a missing or malformed file', () => {
    const root = makeTempRoot();
    expect(loadAoiScoutNetworkBudgetState(root, SESSION_PATH)).toBeNull();
    const dir = join(root, 'aoi', 'default', 'aoi-autonomy');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(dir, 'scout-network-budget-state.json'), 'not json {', 'utf-8');
    expect(loadAoiScoutNetworkBudgetState(root, SESSION_PATH)).toBeNull();
  });

  it('normalizes malformed fields defensively', () => {
    const normalized = normalizeAoiScoutNetworkBudgetState(
      { windowStartedAt: -1, windowMs: 0, callsSpent: -9, recordCount: 'x' },
      SESSION_PATH,
    );
    expect(normalized).not.toBeNull();
    expect(normalized?.windowStartedAt).toBe(0);
    expect(normalized?.windowMs).toBe(DEFAULT_SCOUT_NETWORK_BUDGET_WINDOW_MS);
    expect(normalized?.callsSpent).toBe(0);
    expect(normalized?.recordCount).toBe(0);
    expect(normalizeAoiScoutNetworkBudgetState(null, SESSION_PATH)).toBeNull();
  });
});
