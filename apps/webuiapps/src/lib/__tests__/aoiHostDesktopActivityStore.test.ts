import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  appendAoiHostDesktopActivitySample,
  loadAoiHostDesktopActivitySummary,
  pruneAoiHostDesktopActivitySamples,
} from '../aoiHostDesktopActivityStore';
import type { AoiDesktopActivitySample } from '../aoiHostDesktopActivity';

const tempRoots: string[] = [];

function makeHome(): string {
  const home = fs.mkdtempSync(join(os.tmpdir(), 'aoi-desktop-store-'));
  tempRoots.push(home);
  return home;
}

function sample(appName: string, observedAt: number): AoiDesktopActivitySample {
  return {
    version: 1,
    appName,
    focused: true,
    idleMs: 0,
    observedAt,
    privacyState: 'metadata_only',
  };
}

afterAll(() => {
  for (const dir of tempRoots) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup.
    }
  }
});

describe('pruneAoiHostDesktopActivitySamples', () => {
  it('drops samples older than the 24h TTL and caps the count', () => {
    const now = 100_000_000;
    const fresh = sample('a.exe', now - 1000);
    const stale = sample('b.exe', now - 25 * 60 * 60 * 1000);
    const pruned = pruneAoiHostDesktopActivitySamples([stale, fresh], now);
    expect(pruned.map((s) => s.appName)).toEqual(['a.exe']);
  });
});

describe('append + summary round-trip', () => {
  it('accumulates samples on disk and summarizes them', () => {
    const home = makeHome();
    appendAoiHostDesktopActivitySample(home, sample('ghidra.exe', 1000), 1000);
    appendAoiHostDesktopActivitySample(home, sample('ghidra.exe', 2000), 2000);
    const count = appendAoiHostDesktopActivitySample(home, sample('chrome.exe', 3000), 3000);
    expect(count).toBe(3);

    const summary = loadAoiHostDesktopActivitySummary(home, 4000);
    expect(summary.totalSamples).toBe(3);
    expect(summary.activeAppName).toBe('chrome.exe');
    expect(summary.topApps[0]).toMatchObject({ appName: 'ghidra.exe', focusedCount: 2 });
  });

  it('returns an empty summary with a cannotKnow statement on a fresh store', () => {
    const home = makeHome();
    const summary = loadAoiHostDesktopActivitySummary(home, 1000);
    expect(summary.totalSamples).toBe(0);
    expect(summary.cannotKnow[0]).toContain('cannot know desktop activity');
  });
});
