import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_AOI_AUTONOMY_POLICY } from '../aoiAutonomyPolicy';
import { saveAoiAutonomyPolicy } from '../aoiAutonomyStore';
import type { AoiInterestProfile, AoiInterestTopic } from '../aoiAutonomyTypes';
import { evaluateAoiOperatorHealth } from '../aoiOperatorHealth';
import { buildAoiOperatorHealthState } from '../aoiOperatorHealthServer';
import {
  AOI_PROACTIVE_BRIEF_REPLAY_PRIVATE_TEXT_SAMPLES,
  buildAoiProactiveBriefDiagnostics,
  formatAoiProactiveBriefReplayReport,
  runBuiltInAoiProactiveBriefReplayFixtures,
} from '../aoiProactiveBriefReplay';
import { scoutAoiProactiveBriefTopic } from '../aoiProactiveBriefResearch';
import { saveAoiInterestProfile } from '../aoiProactiveBriefStore';

const tempRoots: string[] = [];
const SESSION_PATH = 'aoi/default';
const NOW = Date.parse('2026-06-19T00:00:00.000Z');

function makeTempRoot(): string {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'aoi-proactive-brief-replay-test-'));
  tempRoots.push(root);
  return root;
}

function makeTopic(partial: Partial<AoiInterestTopic> = {}): AoiInterestTopic {
  return {
    version: 1,
    id: partial.id ?? 'aoi-interest-reverse-engineering',
    sessionPath: partial.sessionPath ?? SESSION_PATH,
    label: partial.label ?? 'Reverse Engineering',
    normalizedLabel: partial.normalizedLabel ?? 'reverse engineering',
    aliases: partial.aliases ?? ['RE', 'malware reversing'],
    source: partial.source ?? 'memory',
    memoryIds: partial.memoryIds ?? ['memory-re-001'],
    evidenceRefs: partial.evidenceRefs ?? ['memory:memory-re-001'],
    confidence: partial.confidence ?? 0.88,
    importance: partial.importance ?? 0.86,
    noveltyPreference: partial.noveltyPreference ?? 0.72,
    currentInfoPreference: partial.currentInfoPreference ?? 0.94,
    muted: partial.muted ?? false,
    pinned: partial.pinned ?? true,
    cooldownKey: partial.cooldownKey ?? 'interest:reverse-engineering',
    createdAt: partial.createdAt ?? NOW - 60_000,
    updatedAt: partial.updatedAt ?? NOW - 30_000,
  };
}

function makeProfile(topic: AoiInterestTopic = makeTopic()): AoiInterestProfile {
  return {
    version: 1,
    sessionPath: SESSION_PATH,
    topics: [topic],
    generatedAt: NOW,
    sourceMemoryCount: 1,
    warnings: [],
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('Aoi proactive brief replay scenario pack', () => {
  it('runs all built-in scenarios deterministically without real network access', async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('Replay fixtures must not call real network.');
    });
    vi.stubGlobal('fetch', fetchSpy);

    const reports = await runBuiltInAoiProactiveBriefReplayFixtures();
    const summary = formatAoiProactiveBriefReplayReport(reports);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(reports).toHaveLength(7);
    expect(reports.map((report) => report.scenario)).toEqual([
      'fresh_public_sources',
      'tavily_missing',
      'quiet_mode',
      'too_frequent_feedback',
      'stale_sources',
      'private_memory_excluded',
      'useful_feedback_with_cooldown',
    ]);
    expect(reports.every((report) => report.passed)).toBe(true);
    expect(summary).toContain('7/7 passed');
  });

  it('keeps memory-only or missing-Tavily scenarios from producing latest claims', async () => {
    const reports = await runBuiltInAoiProactiveBriefReplayFixtures();
    const tavilyMissing = reports.find((report) => report.scenario === 'tavily_missing');
    const privateExcluded = reports.find((report) => report.scenario === 'private_memory_excluded');

    expect(tavilyMissing?.candidateCount).toBe(0);
    expect(tavilyMissing?.diagnosticLabels).toContain('tavily_unavailable');
    expect(
      tavilyMissing?.metrics.find((metric) => metric.name === 'no_fabricated_current_info')?.passed,
    ).toBe(true);
    expect(JSON.stringify(tavilyMissing)).not.toMatch(/\blatest\b/i);

    expect(privateExcluded?.candidateCount).toBe(0);
    expect(privateExcluded?.diagnosticLabels).toContain('no_eligible_topics');
    for (const sample of AOI_PROACTIVE_BRIEF_REPLAY_PRIVATE_TEXT_SAMPLES) {
      expect(JSON.stringify(privateExcluded)).not.toContain(sample);
    }
  });

  it('proves quiet mode, stale sources, and cooldown feedback suppress direct chat', async () => {
    const reports = await runBuiltInAoiProactiveBriefReplayFixtures();
    const quiet = reports.find((report) => report.scenario === 'quiet_mode');
    const stale = reports.find((report) => report.scenario === 'stale_sources');
    const tooFrequent = reports.find((report) => report.scenario === 'too_frequent_feedback');
    const usefulWithCooldown = reports.find(
      (report) => report.scenario === 'useful_feedback_with_cooldown',
    );

    expect(quiet?.candidates[0]?.chatHookAllowed).toBe(false);
    expect(quiet?.candidates[0]?.chatHookReasons).toContain('quiet_mode_suppresses_chat_hook');
    expect(stale?.diagnosticLabels).toContain('source_freshness_stale');
    expect(stale?.candidates[0]?.chatHookAllowed).toBe(false);
    expect(tooFrequent?.diagnosticLabels).toContain('cooldown_suppressed_all_candidates');
    expect(usefulWithCooldown?.diagnosticLabels).toContain('cooldown_suppressed_all_candidates');
    expect(
      usefulWithCooldown?.metrics.find((metric) => metric.name === 'feedback_adaptation')?.passed,
    ).toBe(true);
  });
});

describe('Aoi proactive brief replay hardening', () => {
  it('rejects bad source data and zero-source candidates before candidate creation', async () => {
    const topic = makeTopic();
    const bad = await scoutAoiProactiveBriefTopic({
      topic,
      now: NOW,
      minSources: 2,
      search: async (request) => ({
        query: request.query,
        retrievedAt: request.now,
        results: [
          {
            title: 'Loopback source',
            url: 'http://127.0.0.1/private',
            content: 'Private loopback body.',
          },
          {
            title: 'Missing URL',
            content: 'No public URL.',
          },
          {
            title: 'Non-web URL',
            url: 'file:///C:/secret.txt',
            content: 'Local file.',
          },
        ],
      }),
    });
    const zero = await scoutAoiProactiveBriefTopic({
      topic,
      now: NOW,
      minSources: 2,
      search: async (request) => ({
        query: request.query,
        retrievedAt: request.now,
        results: [],
      }),
    });

    expect(bad.candidate).toBeUndefined();
    expect(bad.rejectedReason).toBe('low_evidence');
    expect(bad.evidence.sources).toHaveLength(0);
    expect(zero.candidate).toBeUndefined();
    expect(zero.rejectedReason).toBe('low_evidence');
    expect(zero.evidence.sources).toHaveLength(0);
  });

  it('maps proactive diagnostics into operator health warnings without leaking raw memory text', () => {
    const diagnostics = buildAoiProactiveBriefDiagnostics({
      profile: makeProfile(),
      scoutWarnings: ['tavily_not_configured:cannot_refresh_current_info'],
      now: NOW,
    });
    const health = evaluateAoiOperatorHealth({
      sessionPath: SESSION_PATH,
      proactiveBriefDiagnostics: diagnostics,
      now: NOW,
    });

    expect(health.issues.some((issue) => issue.code === 'proactive_brief_tavily_unavailable')).toBe(
      true,
    );
    expect(health.evidenceRefs).toContain('proactive-brief-diagnostic:tavily_unavailable');
    expect(JSON.stringify(health)).not.toContain('api_key=secret-value');
  });

  it('surfaces proactive Tavily diagnostics from persisted health state only when proactive artifacts exist', () => {
    const root = makeTempRoot();
    const configFile = join(root, 'config.json');
    fs.writeFileSync(configFile, JSON.stringify({}), 'utf-8');
    saveAoiAutonomyPolicy(
      root,
      SESSION_PATH,
      {
        ...DEFAULT_AOI_AUTONOMY_POLICY,
        enabled: true,
        proactiveSuggestionsEnabled: true,
        confidenceFloor: 0.5,
        updatedAt: NOW,
      },
      NOW,
    );
    saveAoiInterestProfile(root, SESSION_PATH, makeProfile(), NOW);

    const health = buildAoiOperatorHealthState({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      configFile,
      now: NOW,
    });

    expect(health.issues.some((issue) => issue.code === 'proactive_brief_tavily_unavailable')).toBe(
      true,
    );
    expect(
      health.issues.find((issue) => issue.code === 'proactive_brief_tavily_unavailable')?.title,
    ).toContain('Tavily');
  });
});
