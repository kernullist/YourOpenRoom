import { describe, expect, it } from 'vitest';

import {
  deriveAoiDesktopInterestSignals,
  normalizeAoiDesktopActivitySample,
  summarizeAoiDesktopActivity,
  type AoiDesktopActivitySample,
} from '../aoiHostDesktopActivity';

describe('normalizeAoiDesktopActivitySample', () => {
  it('produces a metadata-only sample and strips any path from the app name', () => {
    const sample = normalizeAoiDesktopActivitySample(
      { appName: 'C:\\Tools\\Ghidra\\ghidra.exe', focused: true, idleMs: 1200, observedAt: 500 },
      { now: 999 },
    );
    expect(sample).toEqual({
      version: 1,
      appName: 'ghidra.exe',
      focused: true,
      idleMs: 1200,
      observedAt: 500,
      privacyState: 'metadata_only',
    });
  });

  it('drops the window title unless title capture is enabled (structural boundary)', () => {
    const withoutToggle = normalizeAoiDesktopActivitySample(
      { appName: 'code.exe', windowTitle: 'secret-plan.md - VS Code', observedAt: 1 },
      { captureWindowTitles: false },
    );
    expect(withoutToggle && 'windowTitle' in withoutToggle).toBe(false);

    const withToggle = normalizeAoiDesktopActivitySample(
      { appName: 'code.exe', windowTitle: 'notes.md - VS Code', observedAt: 1 },
      { captureWindowTitles: true },
    );
    expect(withToggle?.windowTitle).toBe('notes.md - VS Code');
  });

  it('redacts emails, urls, and file paths from a captured title', () => {
    const emailSample = normalizeAoiDesktopActivitySample(
      {
        appName: 'outlook.exe',
        windowTitle: 'Mail to alice@example.com about the plan',
        observedAt: 1,
      },
      { captureWindowTitles: true },
    );
    expect(emailSample?.windowTitle).not.toContain('alice@example.com');

    const pathSample = normalizeAoiDesktopActivitySample(
      { appName: 'code.exe', windowTitle: 'C:\\secret\\roadmap.md - VS Code', observedAt: 1 },
      { captureWindowTitles: true },
    );
    expect(pathSample?.windowTitle).not.toContain('secret');

    const urlSample = normalizeAoiDesktopActivitySample(
      {
        appName: 'chrome.exe',
        windowTitle: 'Board - https://internal.example.com/secret-plan',
        observedAt: 1,
      },
      { captureWindowTitles: true },
    );
    expect(urlSample?.windowTitle).not.toContain('internal.example.com');
  });

  it('returns null without a usable app name and clamps idle', () => {
    expect(normalizeAoiDesktopActivitySample({ focused: true }, {})).toBeNull();
    expect(normalizeAoiDesktopActivitySample(null, {})).toBeNull();
    const clamped = normalizeAoiDesktopActivitySample(
      { appName: 'app.exe', idleMs: -50, observedAt: 1 },
      {},
    );
    expect(clamped?.idleMs).toBe(0);
    expect(clamped?.focused).toBe(true);
  });
});

describe('summarizeAoiDesktopActivity', () => {
  function focusedSample(appName: string, observedAt: number): AoiDesktopActivitySample {
    return {
      version: 1,
      appName,
      focused: true,
      idleMs: 0,
      observedAt,
      privacyState: 'metadata_only',
    };
  }

  it('ranks apps by focus-sample count and reports the newest active app', () => {
    const samples = [
      focusedSample('chrome.exe', 1),
      focusedSample('ghidra.exe', 2),
      focusedSample('ghidra.exe', 3),
      focusedSample('ghidra.exe', 4),
      focusedSample('chrome.exe', 5),
    ];
    const summary = summarizeAoiDesktopActivity(samples, 100);
    expect(summary.totalSamples).toBe(5);
    expect(summary.activeAppName).toBe('chrome.exe');
    expect(summary.topApps[0]).toMatchObject({ appName: 'ghidra.exe', focusedCount: 3 });
    expect(summary.lastObservedAt).toBe(5);
  });

  it('groups app names case-insensitively but keeps a display name', () => {
    const summary = summarizeAoiDesktopActivity(
      [focusedSample('Code.exe', 1), focusedSample('code.exe', 2)],
      100,
    );
    expect(summary.topApps).toHaveLength(1);
    expect(summary.topApps[0].focusedCount).toBe(2);
  });

  it('reports a cannotKnow statement when there are no samples', () => {
    const summary = summarizeAoiDesktopActivity([], 100);
    expect(summary.totalSamples).toBe(0);
    expect(summary.activeAppName).toBeNull();
    expect(summary.cannotKnow[0]).toContain('cannot know desktop activity');
  });

  it('ignores non-focused samples for the active app and top-apps ranking', () => {
    const summary = summarizeAoiDesktopActivity(
      [
        {
          version: 1,
          appName: 'bg.exe',
          focused: false,
          idleMs: 0,
          observedAt: 1,
          privacyState: 'metadata_only',
        },
        focusedSample('fg.exe', 2),
      ],
      100,
    );
    expect(summary.activeAppName).toBe('fg.exe');
    expect(summary.topApps.map((a) => a.appName)).toEqual(['fg.exe']);
  });
});

describe('deriveAoiDesktopInterestSignals', () => {
  it('turns the top apps into observation-only interest signal lines', () => {
    const summary = summarizeAoiDesktopActivity(
      [
        {
          version: 1,
          appName: 'ghidra.exe',
          focused: true,
          idleMs: 0,
          observedAt: 1,
          privacyState: 'metadata_only',
        },
        {
          version: 1,
          appName: 'ghidra.exe',
          focused: true,
          idleMs: 0,
          observedAt: 2,
          privacyState: 'metadata_only',
        },
      ],
      100,
    );
    const signals = deriveAoiDesktopInterestSignals(summary);
    expect(signals[0]).toContain('ghidra.exe');
    expect(signals[0]).toContain('foreground time');
  });
});
