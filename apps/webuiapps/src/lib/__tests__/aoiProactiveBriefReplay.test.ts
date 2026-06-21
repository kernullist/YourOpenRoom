import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_AOI_AUTONOMY_POLICY } from '../aoiAutonomyPolicy';
import { saveAoiAutonomyPolicy } from '../aoiAutonomyStore';
import type {
  AoiInterestProfile,
  AoiInterestTopic,
  AoiProactiveBriefCalibrationLabel,
} from '../aoiAutonomyTypes';
import { evaluateAoiOperatorHealth } from '../aoiOperatorHealth';
import { buildAoiOperatorHealthState } from '../aoiOperatorHealthServer';
import {
  AOI_PROACTIVE_BRIEF_REPLAY_PRIVATE_TEXT_SAMPLES,
  buildAoiProactiveBriefCalibrationDiagnostics,
  buildAoiProactiveBriefDiagnostics,
  buildAoiProactiveBriefFieldDiagnostics,
  buildAoiProactiveBriefReadinessDiagnostics,
  buildAoiProactiveBriefReadinessSummary,
  buildAoiProactiveBriefReplayPromotionDrafts,
  formatAoiProactiveBriefReplayReport,
  runBuiltInAoiProactiveBriefReplayFixtures,
  runAoiProactiveBriefReplayFixture,
  type AoiProactiveBriefReplayFixtureDraft,
} from '../aoiProactiveBriefReplay';
import { scoutAoiProactiveBriefTopic } from '../aoiProactiveBriefResearch';
import {
  recordAoiProactiveBriefCalibrationLabel,
  recordAoiProactiveBriefFieldEvent,
  saveAoiInterestProfile,
} from '../aoiProactiveBriefStore';

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

function recordLabeledFieldEvent(params: {
  root: string;
  id: string;
  label: AoiProactiveBriefCalibrationLabel;
  createdAt: number;
}) {
  const event = recordAoiProactiveBriefFieldEvent(params.root, {
    kind: 'shown_dashboard',
    sessionPath: SESSION_PATH,
    briefId: `brief-${params.id}`,
    topicId: 'aoi-interest-reverse-engineering',
    deliveryMode: 'dashboard',
    policyReason: 'dashboard_allowed',
    title: `Field brief ${params.id}`,
    summary: `Field summary ${params.id}`,
    sourceRefs: [`https://${params.id}.example.com/re/writeup`],
    sourceHosts: [`${params.id}.example.com`],
    evidenceRefs: [`source:${params.id}.example.com:field`],
    freshness: {
      searchedAt: params.createdAt - 10_000,
      newestSourceAt: '2026-06-18T00:00:00.000Z',
      cannotKnow: ['Aoi cannot know whether sources changed after retrieval.'],
    },
    dedupeKey: `shown_dashboard:${params.id}`,
    createdAt: params.createdAt,
  });
  const label = recordAoiProactiveBriefCalibrationLabel(params.root, {
    sessionPath: SESSION_PATH,
    fieldEventId: event.id,
    label: params.label,
    actor: 'user',
    now: params.createdAt + 1,
  });
  return { event, label };
}

function makePromotedDraft(id: string): AoiProactiveBriefReplayFixtureDraft {
  return {
    version: 1,
    id: `draft-${id}`,
    sessionPath: SESSION_PATH,
    fieldEventId: `field-${id}`,
    calibrationLabelId: `label-${id}`,
    label: 'useful',
    status: 'promoted_candidate',
    fixture: {
      id: `fixture-${id}`,
      title: 'Ready field replay',
      scenario: 'fresh_public_sources',
      now: NOW,
      profile: makeProfile(),
      skipSearch: true,
      directCandidates: [],
    },
    validation: {
      deterministicClock: true,
      noNetworkDependency: true,
      rawPrivateTextAbsent: true,
      hasSourceEvidence: true,
      expectedOutcome: 'ready',
      blockers: [],
    },
    redaction: {
      applied: true,
      removedPrivateFieldCount: 0,
      removedRefs: [],
    },
    evidenceRefs: [`proactive-brief-field-event:${id}`],
    createdAt: NOW,
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
  it('promotes labeled field events into redacted deterministic replay drafts without network', async () => {
    const root = makeTempRoot();
    const event = recordAoiProactiveBriefFieldEvent(root, {
      kind: 'shown_dashboard',
      sessionPath: SESSION_PATH,
      briefId: 'brief-private-field',
      topicId: 'aoi-interest-reverse-engineering',
      deliveryMode: 'dashboard',
      policyReason: 'Checked C:\\Users\\operator\\private-policy.txt',
      title: 'Expanded private api_key=secret-value brief',
      summary:
        'User-local path F:\\private\\notes.txt and private-roadmap@example.com should be redacted.',
      sourceRefs: [
        'https://research.example.com/re/writeup?token=private-token-value',
        'C:\\Users\\operator\\secret-source.txt',
      ],
      sourceHosts: ['research.example.com'],
      evidenceRefs: ['memory:memory-re-001', 'C:\\Users\\operator\\secret-evidence.txt'],
      freshness: {
        searchedAt: NOW - 20_000,
        newestSourceAt: '2026-06-18T00:00:00.000Z',
        cannotKnow: ['Aoi cannot know whether sources changed after retrieval.'],
      },
      dedupeKey: 'shown_dashboard:brief-private-field',
      createdAt: NOW - 10_000,
    });
    const label = recordAoiProactiveBriefCalibrationLabel(root, {
      sessionPath: SESSION_PATH,
      fieldEventId: event.id,
      label: 'useful',
      actor: 'user',
      note: 'private-roadmap@example.com liked this, do not store the note body.',
      now: NOW - 5_000,
    });
    const fetchSpy = vi.fn(() => {
      throw new Error('Promoted replay drafts must not call real network.');
    });
    vi.stubGlobal('fetch', fetchSpy);

    const drafts = buildAoiProactiveBriefReplayPromotionDrafts({
      sessionPath: SESSION_PATH,
      events: [event],
      labels: [label],
      now: NOW,
    });
    const draft = drafts[0];

    expect(draft.status).toBe('promoted_candidate');
    expect(draft.validation).toMatchObject({
      deterministicClock: true,
      noNetworkDependency: true,
      rawPrivateTextAbsent: true,
      hasSourceEvidence: true,
    });
    const draftJson = JSON.stringify(draft);
    expect(draftJson).not.toContain('api_key=secret-value');
    expect(draftJson).not.toContain('F:\\private\\notes.txt');
    expect(draftJson).not.toContain('C:\\Users\\operator\\secret-source.txt');
    expect(draftJson).not.toContain('private-roadmap@example.com');
    expect(draft.fixture.skipSearch).toBe(true);

    const first = await runAoiProactiveBriefReplayFixture(draft.fixture);
    const second = await runAoiProactiveBriefReplayFixture(draft.fixture);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.passed).toBe(true);
  });

  it('summarizes readiness gates and refuses to pass unsafe field states', () => {
    const baseMetrics = {
      version: 1 as const,
      sessionPath: SESSION_PATH,
      generatedAt: NOW,
      status: 'field_events_recorded' as const,
      eventCount: 3,
      consideredCount: 3,
      shownCount: 2,
      shownByDeliveryMode: {
        dashboard: 2,
        digest: 0,
        inline_card: 0,
        chat_hook: 0,
      },
      expandedCount: 1,
      sourceOpenedCount: 1,
      feedbackRecordedCount: 3,
      usefulCount: 1,
      tooFrequentCount: 0,
      wrongTopicCount: 0,
      wrongTimingCount: 0,
      staleCount: 0,
      staleCurrentClaimCount: 0,
      unsafeCount: 0,
      suppressionCounts: {
        suppressed_cooldown: 1,
      },
      privateLeakCount: 0,
      unauthorizedMutationCount: 0,
      directChatHookCount: 0,
      lastEventAt: NOW,
      evidenceRefs: ['proactive-brief-field-event:ready'],
    };
    const promotedDraft = makePromotedDraft('ready');
    const ready = buildAoiProactiveBriefReadinessSummary({
      sessionPath: SESSION_PATH,
      metrics: baseMetrics,
      replayDrafts: [promotedDraft],
      policy: {
        ...DEFAULT_AOI_AUTONOMY_POLICY,
        enabled: true,
        proactiveSuggestionsEnabled: true,
        proactiveBriefing: {
          ...DEFAULT_AOI_AUTONOMY_POLICY.proactiveBriefing,
          enabled: true,
          directChatHookOptIn: true,
        },
        updatedAt: NOW,
      },
      tavilyConfigured: true,
      now: NOW,
    });
    const notFieldTested = buildAoiProactiveBriefReadinessSummary({
      sessionPath: SESSION_PATH,
      metrics: {
        ...baseMetrics,
        status: 'not_field_tested',
        eventCount: 0,
        evidenceRefs: [],
      },
      replayDrafts: [],
      now: NOW,
    });
    const blocked = buildAoiProactiveBriefReadinessSummary({
      sessionPath: SESSION_PATH,
      metrics: {
        ...baseMetrics,
        status: 'blocked',
        privateLeakCount: 1,
        unauthorizedMutationCount: 1,
        staleCurrentClaimCount: 1,
      },
      replayDrafts: [promotedDraft],
      now: NOW,
    });
    const diagnostics = buildAoiProactiveBriefReadinessDiagnostics(blocked, NOW);

    expect(ready.status).toBe('ready');
    expect(ready.summary).toContain('samples=3');
    expect(ready.summary).toContain('suppression=suppressed_cooldown=1');
    expect(ready.replayPromotionCandidateCount).toBe(1);
    expect(ready.directChatReadiness).toBe('eligible_opt_in');
    expect(notFieldTested.status).toBe('not_field_tested');
    expect(notFieldTested.gates.find((gate) => gate.id === 'field.sample_count')?.status).toBe(
      'block',
    );
    expect(blocked.status).toBe('blocked');
    expect(blocked.directChatReadiness).toBe('blocked_private_or_unsafe');
    expect(blocked.gates.map((gate) => gate.id)).toEqual(
      expect.arrayContaining([
        'field.private_leak_zero',
        'field.unauthorized_mutation_zero',
        'field.stale_current_claim_zero',
      ]),
    );
    expect(diagnostics.map((item) => item.code)).toContain('field_stale_current_claim_detected');
  });

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

  it('maps proactive field leak metrics into operator health blockers', () => {
    const diagnostics = buildAoiProactiveBriefFieldDiagnostics(
      {
        version: 1,
        sessionPath: SESSION_PATH,
        generatedAt: NOW,
        status: 'blocked',
        eventCount: 1,
        consideredCount: 1,
        shownCount: 0,
        shownByDeliveryMode: {
          dashboard: 0,
          digest: 0,
          inline_card: 0,
          chat_hook: 0,
        },
        expandedCount: 0,
        sourceOpenedCount: 0,
        feedbackRecordedCount: 0,
        usefulCount: 0,
        tooFrequentCount: 0,
        wrongTopicCount: 0,
        wrongTimingCount: 0,
        staleCount: 0,
        staleCurrentClaimCount: 0,
        unsafeCount: 0,
        suppressionCounts: {},
        privateLeakCount: 1,
        unauthorizedMutationCount: 1,
        directChatHookCount: 0,
        lastEventAt: NOW,
        evidenceRefs: ['proactive-brief-field-event:test'],
      },
      NOW,
    );
    const health = evaluateAoiOperatorHealth({
      sessionPath: SESSION_PATH,
      proactiveBriefDiagnostics: diagnostics,
      now: NOW,
    });

    expect(health.overallStatus).toBe('blocked');
    expect(health.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        'proactive_brief_field_private_leak_detected',
        'proactive_brief_field_unauthorized_mutation_detected',
      ]),
    );
  });

  it('maps proactive calibration tuning into operator health warnings', () => {
    const diagnostics = buildAoiProactiveBriefCalibrationDiagnostics(
      {
        version: 1,
        sessionPath: SESSION_PATH,
        generatedAt: NOW,
        status: 'blocked',
        labelCount: 2,
        labelDistribution: {
          useful: 0,
          show_more: 0,
          show_less: 0,
          too_frequent: 0,
          wrong_topic: 0,
          wrong_source: 0,
          wrong_timing: 0,
          stale: 1,
          unsafe: 1,
          mute_topic: 0,
          pin_topic: 0,
        },
        unsafeLabelCount: 1,
        staleLabelCount: 1,
        tooFrequentLabelCount: 0,
        wrongTimingLabelCount: 0,
        mutedTopicCount: 0,
        pinnedTopicCount: 0,
        topicTuning: {},
        sourceTuning: {},
        summaryLabels: ['2 calibration labels applied'],
        evidenceRefs: ['proactive-brief-calibration:test'],
      },
      NOW,
    );
    const health = evaluateAoiOperatorHealth({
      sessionPath: SESSION_PATH,
      proactiveBriefDiagnostics: diagnostics,
      now: NOW,
    });

    expect(health.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        'proactive_brief_calibration_tuning_active',
        'proactive_brief_calibration_stale_direct_chat_block',
        'proactive_brief_calibration_unsafe_label_blocker',
      ]),
    );
    expect(health.issues.some((issue) => issue.title.includes('unsafe calibration'))).toBe(true);
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
    expect(health.issues.some((issue) => issue.code === 'proactive_brief_field_not_tested')).toBe(
      true,
    );
    expect(
      health.issues.find((issue) => issue.code === 'proactive_brief_tavily_unavailable')?.title,
    ).toContain('Tavily');
  });

  it('surfaces proactive field readiness counts and replay promotion candidates in persisted health', () => {
    const root = makeTempRoot();
    const configFile = join(root, 'config.json');
    fs.writeFileSync(configFile, JSON.stringify({ tavily: { apiKey: 'tvly-test' } }), 'utf-8');
    saveAoiAutonomyPolicy(
      root,
      SESSION_PATH,
      {
        ...DEFAULT_AOI_AUTONOMY_POLICY,
        enabled: true,
        proactiveSuggestionsEnabled: true,
        confidenceFloor: 0.5,
        proactiveBriefing: {
          ...DEFAULT_AOI_AUTONOMY_POLICY.proactiveBriefing,
          enabled: true,
          directChatHookOptIn: true,
        },
        updatedAt: NOW,
      },
      NOW,
    );
    saveAoiInterestProfile(root, SESSION_PATH, makeProfile(), NOW);
    recordLabeledFieldEvent({
      root,
      id: 'field-ready-one',
      label: 'useful',
      createdAt: NOW - 30_000,
    });
    recordLabeledFieldEvent({
      root,
      id: 'field-ready-two',
      label: 'too_frequent',
      createdAt: NOW - 20_000,
    });
    recordLabeledFieldEvent({
      root,
      id: 'field-ready-three',
      label: 'wrong_topic',
      createdAt: NOW - 10_000,
    });

    const health = buildAoiOperatorHealthState({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      configFile,
      now: NOW,
    });
    const readinessIssue = health.issues.find(
      (issue) => issue.code === 'proactive_brief_field_readiness_ready',
    );

    expect(readinessIssue?.summary).toContain('samples=3');
    expect(readinessIssue?.summary).toContain('useful=1');
    expect(readinessIssue?.summary).toContain('too_frequent=1');
    expect(readinessIssue?.summary).toContain('wrong_topic=1');
    expect(readinessIssue?.summary).toContain('replay_candidates=3');
    expect(health.issues.map((issue) => issue.code)).toContain(
      'proactive_brief_field_replay_candidates_ready',
    );
    expect(health.issues.map((issue) => issue.code)).toContain(
      'proactive_brief_field_direct_chat_not_ready',
    );
  });
});
