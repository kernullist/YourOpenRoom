import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AoiMemoryEntry } from '../aoiMemoryShared';
import type { AoiProactiveBriefCandidate } from '../aoiAutonomyTypes';
import {
  AOI_PROACTIVE_FIELD_EVENT_AUDIT_TAIL_LIMIT,
  AOI_PROACTIVE_FIELD_EVENT_DEDUPE_WINDOW_MS,
  expireStaleAoiProactiveBriefCandidates,
  buildAoiProactiveBriefFieldMetrics,
  loadAoiProactiveBriefCalibrationInbox,
  loadAoiProactiveBriefCalibrationLabels,
  loadAoiProactiveBriefCalibrationTuning,
  loadAoiInterestProfile,
  loadAoiProactiveBriefCandidates,
  loadAoiProactiveBriefCooldownState,
  loadAoiProactiveBriefFieldEvents,
  loadAoiProactiveBriefFieldMetrics,
  normalizeAoiProactiveBriefCandidate,
  recordAoiProactiveBriefCalibrationLabel,
  recordAoiProactiveBriefDeliveryFieldEvents,
  recordAoiProactiveBriefFeedback,
  recordAoiProactiveBriefFieldEvent,
  rebuildAndSaveAoiInterestProfile,
  resolveAoiProactiveBriefPaths,
  upsertAoiProactiveBriefCandidate,
  upsertAoiProactiveBriefCooldown,
} from '../aoiProactiveBriefStore';
import { decideAoiProactiveBriefDelivery } from '../aoiProactiveBriefPolicy';

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'aoi-proactive-brief-test-'));
  tempRoots.push(root);
  return root;
}

function makeMemory(partial: Partial<AoiMemoryEntry> = {}): AoiMemoryEntry {
  const content = partial.content ?? 'The user is interested in reverse engineering.';
  return {
    version: 2,
    id: partial.id ?? 'memory-interest-001',
    scope: partial.scope ?? 'user',
    type: partial.type ?? 'preference',
    status: partial.status ?? 'active',
    content,
    normalizedContent: partial.normalizedContent ?? content.toLowerCase(),
    importance: partial.importance ?? 0.8,
    confidence: partial.confidence ?? 0.85,
    hits: partial.hits ?? 1,
    createdAt: partial.createdAt ?? 100,
    updatedAt: partial.updatedAt ?? 200,
    sourceEpisodeIds: partial.sourceEpisodeIds ?? ['episode-001'],
    tags: partial.tags ?? ['interest', 'reverse-engineering'],
    entities: partial.entities ?? ['reverse engineering'],
    ...(partial.expiresAt !== undefined ? { expiresAt: partial.expiresAt } : {}),
    ...(partial.permanent !== undefined ? { permanent: partial.permanent } : {}),
    ...(partial.supersedes !== undefined ? { supersedes: partial.supersedes } : {}),
    ...(partial.sessionPath !== undefined ? { sessionPath: partial.sessionPath } : {}),
    ...(partial.projectKey !== undefined ? { projectKey: partial.projectKey } : {}),
  };
}

function makeCandidate(
  partial: Partial<AoiProactiveBriefCandidate> = {},
): AoiProactiveBriefCandidate {
  return {
    version: 1,
    id: partial.id ?? 'aoi-brief-test-001',
    sessionPath: partial.sessionPath ?? 'aoi/default',
    topicId: partial.topicId ?? 'aoi-interest-reverse',
    topicLabel: partial.topicLabel ?? 'Reverse Engineering',
    status: partial.status ?? 'candidate',
    title: partial.title ?? 'Fresh reverse engineering writeup',
    hook: partial.hook ?? 'A fresh reverse engineering writeup looks relevant.',
    summary: partial.summary ?? 'Short source-backed summary placeholder.',
    whyForOperator: partial.whyForOperator ?? 'Matches the operator interest profile.',
    noveltyReason: partial.noveltyReason ?? 'New source for a saved topic.',
    sources: partial.sources ?? [
      {
        title: 'Reverse engineering writeup',
        url: 'https://example.com/re/writeup',
        host: 'example.com',
        retrievedAt: 1000,
        snippet: 'A public source snippet.',
      },
    ],
    evidenceRefs: partial.evidenceRefs ?? ['memory:memory-interest-001'],
    memoryIds: partial.memoryIds ?? ['memory-interest-001'],
    ...(partial.researchRunId !== undefined ? { researchRunId: partial.researchRunId } : {}),
    score: partial.score ?? 0.78,
    confidence: partial.confidence ?? 0.82,
    risk: partial.risk ?? 'low',
    freshness: partial.freshness ?? {
      searchedAt: 1000,
      cannotKnow: [],
    },
    delivery: partial.delivery ?? {
      allowedModes: ['dashboard'],
    },
    cooldownKey: partial.cooldownKey ?? 'interest:reverse-engineering',
    ...(partial.dedupeKey !== undefined ? { dedupeKey: partial.dedupeKey } : {}),
    createdAt: partial.createdAt ?? 1000,
    updatedAt: partial.updatedAt ?? 1000,
    expiresAt: partial.expiresAt ?? 2000,
  };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('Aoi proactive brief profile storage', () => {
  it('roundtrips an interest profile under the autonomy root', () => {
    const root = makeTempRoot();
    const profile = rebuildAndSaveAoiInterestProfile({
      sessionsDir: root,
      sessionPath: 'aoi/default',
      now: 1000,
      memories: [makeMemory()],
    });
    const paths = resolveAoiProactiveBriefPaths(root, 'aoi/default');
    const loaded = loadAoiInterestProfile(root, 'aoi/default', 2000);

    expect(paths.profile).toBe(join(paths.root, 'proactive-interest-profile.json'));
    expect(fs.existsSync(paths.profile)).toBe(true);
    expect(loaded).toMatchObject({
      sessionPath: 'aoi/default',
      topics: profile.topics,
      sourceMemoryCount: 1,
    });
  });

  it('normalizes malformed profile records without throwing', () => {
    const root = makeTempRoot();
    const paths = resolveAoiProactiveBriefPaths(root, 'aoi/default');
    fs.mkdirSync(paths.root, { recursive: true });
    fs.writeFileSync(
      paths.profile,
      JSON.stringify({
        version: 1,
        topics: [
          {
            id: '../bad',
            label: 123,
            confidence: 'bad',
            aliases: ['reverse engineering', 5],
          },
        ],
      }),
      'utf-8',
    );

    const loaded = loadAoiInterestProfile(root, 'aoi/default', 3000);

    expect(loaded.sessionPath).toBe('aoi/default');
    expect(loaded.topics).toHaveLength(1);
    expect(loaded.topics[0]).toMatchObject({
      label: 'Interest Topic',
      confidence: 0.55,
    });
  });
});

describe('Aoi proactive brief candidate storage', () => {
  it('upserts equivalent candidates by topic, title, source URL, and cooldown key', () => {
    const root = makeTempRoot();
    const first = upsertAoiProactiveBriefCandidate(root, makeCandidate(), 1200);
    const second = upsertAoiProactiveBriefCandidate(
      root,
      makeCandidate({
        id: 'aoi-brief-test-duplicate',
        updatedAt: 1300,
      }),
      1300,
    );
    const candidates = loadAoiProactiveBriefCandidates(root, 'aoi/default', 1400);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.candidate.id).toBe(first.candidate.id);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.dedupeKey).toBe(first.dedupeKey);
    expect(loadAoiProactiveBriefFieldEvents(root, 'aoi/default', 1400)).toMatchObject([
      {
        kind: 'candidate_created',
        briefId: first.candidate.id,
        topicId: first.candidate.topicId,
      },
    ]);
  });

  it('expires stale candidates without deleting their audit files', () => {
    const root = makeTempRoot();
    const upserted = upsertAoiProactiveBriefCandidate(
      root,
      makeCandidate({
        expiresAt: 1100,
      }),
      1000,
    );
    const paths = resolveAoiProactiveBriefPaths(root, 'aoi/default');
    const candidatePath = join(paths.candidatesDir, `${upserted.candidate.id}.json`);

    const expired = expireStaleAoiProactiveBriefCandidates(root, 'aoi/default', 1200);
    const events = loadAoiProactiveBriefFieldEvents(root, 'aoi/default', 1300);

    expect(expired[0]?.status).toBe('expired');
    expect(fs.existsSync(candidatePath)).toBe(true);
    expect(loadAoiProactiveBriefCandidates(root, 'aoi/default', 1300)[0]?.status).toBe('expired');
    expect(events.some((event) => event.kind === 'expired')).toBe(true);
  });

  it('normalizes malformed candidates without throwing', () => {
    const normalized = normalizeAoiProactiveBriefCandidate(
      {
        version: 1,
        sessionPath: 'aoi/default',
        topicLabel: 123,
        title: 456,
        sources: [
          { url: 'not-a-url' },
          { url: 'https://example.com/item', title: 5, snippet: 'ok', retrievedAt: 'bad' },
        ],
        delivery: {
          allowedModes: ['bad-mode'],
        },
      },
      undefined,
      1000,
    );

    expect(normalized).toMatchObject({
      sessionPath: 'aoi/default',
      topicLabel: 'Interest Topic',
      title: 'Untitled proactive brief',
      sources: [
        {
          url: 'https://example.com/item',
          retrievedAt: 1000,
        },
      ],
      delivery: {
        allowedModes: ['dashboard'],
      },
    });
  });

  it('stores cooldown state for later planner gates', () => {
    const root = makeTempRoot();

    upsertAoiProactiveBriefCooldown(root, 'aoi/default', {
      cooldownKey: 'interest:reverse-engineering',
      topicId: 'aoi-interest-reverse',
      nextAllowedAt: 5000,
      reason: 'candidate_created',
      sourceBriefIds: ['aoi-brief-test-001'],
      now: 2000,
    });

    expect(loadAoiProactiveBriefCooldownState(root, 'aoi/default', 3000)).toMatchObject({
      sessionPath: 'aoi/default',
      cooldowns: {
        'interest:reverse-engineering': {
          nextAllowedAt: 5000,
          sourceBriefIds: ['aoi-brief-test-001'],
        },
      },
    });
  });

  it('records append-only redacted field events and deterministic metrics', () => {
    const root = makeTempRoot();

    const first = recordAoiProactiveBriefFieldEvent(root, {
      kind: 'expanded',
      sessionPath: 'aoi/default',
      briefId: 'aoi-brief-field-test',
      topicId: 'aoi-interest-reverse',
      title: 'Expanded private api_key=secret-value brief',
      summary: 'User-local path F:\\private\\notes.txt should be redacted.',
      policyReason: 'Checked C:\\Users\\operator\\private-policy.txt',
      sourceRefs: ['https://example.com/re/writeup'],
      sourceHosts: ['example.com'],
      evidenceRefs: ['source:example.com'],
      freshness: {
        searchedAt: 1400,
        cannotKnow: ['Source is outside the freshness window and must not be claimed current.'],
      },
      createdAt: 1500,
    });
    const second = recordAoiProactiveBriefFieldEvent(root, {
      kind: 'source_opened',
      sessionPath: 'aoi/default',
      briefId: 'aoi-brief-field-test',
      topicId: 'aoi-interest-reverse',
      sourceRefs: ['https://example.com/re/writeup'],
      sourceHosts: ['example.com'],
      evidenceRefs: ['source:example.com'],
      createdAt: 1600,
    });
    const events = loadAoiProactiveBriefFieldEvents(root, 'aoi/default', 1700);
    const metrics = buildAoiProactiveBriefFieldMetrics('aoi/default', events, 1700);

    expect(first.id).not.toBe(second.id);
    expect(events).toHaveLength(2);
    expect(JSON.stringify(events)).not.toContain('api_key=secret-value');
    expect(JSON.stringify(events)).not.toContain('F:\\private\\notes.txt');
    expect(JSON.stringify(events)).not.toContain('C:\\Users\\operator\\private-policy.txt');
    expect(first.privacy.redacted).toBe(true);
    expect(metrics).toMatchObject({
      status: 'field_events_recorded',
      eventCount: 2,
      expandedCount: 1,
      sourceOpenedCount: 1,
      staleCount: 1,
      staleCurrentClaimCount: 1,
      privateLeakCount: 0,
      unauthorizedMutationCount: 0,
    });
  });

  it('deduplicates field decisions only within the bounded evidence window', () => {
    const root = makeTempRoot();
    const base = {
      kind: 'shown_dashboard' as const,
      sessionPath: 'aoi/default',
      briefId: 'aoi-brief-bounded-dedupe',
      topicId: 'aoi-interest-reverse',
      sourceRefs: ['https://example.com/re/writeup'],
      sourceHosts: ['example.com'],
      evidenceRefs: ['source:example.com'],
      dedupeKey: 'decision:evidence-v1',
    };
    const first = recordAoiProactiveBriefFieldEvent(root, { ...base, createdAt: 10_000 });
    const duplicate = recordAoiProactiveBriefFieldEvent(root, {
      ...base,
      createdAt: 10_000 + AOI_PROACTIVE_FIELD_EVENT_DEDUPE_WINDOW_MS - 1,
    });
    const later = recordAoiProactiveBriefFieldEvent(root, {
      ...base,
      createdAt: 10_000 + AOI_PROACTIVE_FIELD_EVENT_DEDUPE_WINDOW_MS + 1,
    });

    expect(duplicate.id).toBe(first.id);
    expect(later.id).not.toBe(first.id);
    expect(
      loadAoiProactiveBriefFieldEvents(
        root,
        'aoi/default',
        10_000 + AOI_PROACTIVE_FIELD_EVENT_DEDUPE_WINDOW_MS + 1,
      ),
    ).toHaveLength(2);
  });

  it('retains 500 proactive audit records and compacts older records without raw text', () => {
    const root = makeTempRoot();
    const privateBait = 'PRIVATE_BAIT_PROACTIVE_COMPACTION';
    const template = recordAoiProactiveBriefFieldEvent(root, {
      kind: 'shown_dashboard',
      sessionPath: 'aoi/default',
      briefId: 'aoi-brief-template',
      topicId: 'aoi-interest-template',
      evidenceRefs: ['source:template'],
      dedupeKey: 'template',
      createdAt: 1000,
    });
    const paths = resolveAoiProactiveBriefPaths(root, 'aoi/default');
    const seedEvents = Array.from({ length: 501 }, (_, index) => ({
      ...template,
      id: `aoi-brief-field-retention-${index.toString().padStart(3, '0')}`,
      briefId: `aoi-brief-retention-${index}`,
      title: index === 0 ? privateBait : `Retention event ${index}`,
      summary: index === 0 ? privateBait : `Retention summary ${index}`,
      dedupeKey: `retention:${index}`,
      createdAt: 10_000 + index,
    }));
    for (const event of seedEvents) {
      fs.writeFileSync(
        join(paths.fieldEventRecordsDir, `${event.id}.json`),
        `${JSON.stringify(event)}\n`,
      );
    }
    fs.writeFileSync(
      paths.fieldEventIndex,
      `${JSON.stringify({
        version: 1,
        sessionPath: 'aoi/default',
        updatedAt: 20_000,
        entries: seedEvents.map((event) => ({
          id: event.id,
          kind: event.kind,
          createdAt: event.createdAt,
          briefId: event.briefId,
          topicId: event.topicId,
          dedupeKey: event.dedupeKey,
        })),
      })}\n`,
    );

    recordAoiProactiveBriefFieldEvent(root, {
      kind: 'shown_dashboard',
      sessionPath: 'aoi/default',
      briefId: 'aoi-brief-newest',
      topicId: 'aoi-interest-newest',
      evidenceRefs: ['source:newest'],
      dedupeKey: 'retention:newest',
      createdAt: 100_000,
    });

    const recordFiles = fs
      .readdirSync(paths.fieldEventRecordsDir)
      .filter((name) => name.endsWith('.json'));
    const compactionText = fs.readFileSync(paths.fieldEventCompaction, 'utf-8');
    expect(recordFiles).toHaveLength(AOI_PROACTIVE_FIELD_EVENT_AUDIT_TAIL_LIMIT);
    expect(compactionText).not.toContain(privateBait);
    expect(JSON.parse(compactionText)).toMatchObject({
      sessionPath: 'aoi/default',
      actionAuthority: 'display_only',
      mutationCount: 0,
    });
    expect(JSON.parse(compactionText).compactedEventCount).toBeGreaterThanOrEqual(2);
  });

  it('aggregates delivery suppression and feedback metrics by reason', () => {
    const root = makeTempRoot();
    const upserted = upsertAoiProactiveBriefCandidate(root, makeCandidate(), 2000);
    const suppressed = upsertAoiProactiveBriefCandidate(
      root,
      makeCandidate({
        id: 'aoi-brief-no-source',
        sources: [],
        evidenceRefs: [],
      }),
      2050,
    );
    const shownDecision = decideAoiProactiveBriefDelivery({
      candidate: upserted.candidate,
      context: {
        now: 2100,
        quietMode: true,
        directChatOptIn: true,
      },
    });
    const suppressedDecision = decideAoiProactiveBriefDelivery({
      candidate: suppressed.candidate,
      context: {
        now: 2100,
      },
    });

    recordAoiProactiveBriefDeliveryFieldEvents({
      sessionsDir: root,
      sessionPath: 'aoi/default',
      candidates: [upserted.candidate, suppressed.candidate],
      decisions: [shownDecision, suppressedDecision],
      now: 2100,
    });
    recordAoiProactiveBriefFieldEvent(root, {
      kind: 'feedback_recorded',
      sessionPath: 'aoi/default',
      briefId: upserted.candidate.id,
      topicId: upserted.candidate.topicId,
      feedbackId: 'aoi-brief-feedback-metrics',
      feedbackCategory: 'too_frequent',
      evidenceRefs: ['feedback:aoi-brief-feedback-metrics'],
      createdAt: 2200,
    });
    const metrics = loadAoiProactiveBriefFieldMetrics(root, 'aoi/default', 2300);
    const shown = loadAoiProactiveBriefFieldEvents(root, 'aoi/default', 2300).find(
      (event) => event.kind === 'shown_digest',
    );

    expect(metrics.consideredCount).toBe(2);
    expect(metrics.shownByDeliveryMode.digest).toBe(1);
    expect(metrics.suppressionCounts.suppressed_no_topics).toBe(1);
    expect(metrics.suppressionCounts.missing_sources).toBe(1);
    expect(metrics.feedbackRecordedCount).toBe(1);
    expect(metrics.tooFrequentCount).toBe(1);
    expect(shown?.suppressionReasons).toContain('quiet_mode_suppresses_chat_hook');
    expect(shown?.policyReason).toContain('direct_chat_suppressed');
  });

  it('persists append-only calibration labels and derives inbox tuning from field events', () => {
    const root = makeTempRoot();
    const upserted = upsertAoiProactiveBriefCandidate(root, makeCandidate(), 3000);
    const decision = decideAoiProactiveBriefDelivery({
      candidate: upserted.candidate,
      context: {
        now: 3100,
      },
    });

    recordAoiProactiveBriefDeliveryFieldEvents({
      sessionsDir: root,
      sessionPath: 'aoi/default',
      candidates: [upserted.candidate],
      decisions: [decision],
      now: 3100,
    });
    const shown = loadAoiProactiveBriefFieldEvents(root, 'aoi/default', 3200).find((event) =>
      event.kind.startsWith('shown_'),
    );

    expect(shown).toBeTruthy();

    const first = recordAoiProactiveBriefCalibrationLabel(root, {
      sessionPath: 'aoi/default',
      fieldEventId: shown!.id,
      label: 'useful',
      note: 'Good hit, but redact api_key=secret-value and C:\\Users\\operator\\note.txt',
      now: 3300,
    });
    const second = recordAoiProactiveBriefCalibrationLabel(root, {
      sessionPath: 'aoi/default',
      fieldEventId: shown!.id,
      label: 'show_less',
      now: 3400,
    });
    const labels = loadAoiProactiveBriefCalibrationLabels(root, 'aoi/default', 3500);
    const inbox = loadAoiProactiveBriefCalibrationInbox(root, 'aoi/default', 3500);
    const tuning = loadAoiProactiveBriefCalibrationTuning(root, 'aoi/default', 3500);

    expect(first.id).not.toBe(second.id);
    expect(labels).toHaveLength(2);
    expect(labels.map((label) => label.fieldEventId)).toEqual([second, first].map(() => shown!.id));
    expect(JSON.stringify(labels)).not.toContain('api_key=secret-value');
    expect(JSON.stringify(labels)).not.toContain('C:\\Users\\operator\\note.txt');
    expect(inbox.items[0]).toMatchObject({
      fieldEventId: shown!.id,
      labelState: 'labeled',
    });
    expect(inbox.items[0]?.labels).toHaveLength(2);
    expect(tuning.labelCount).toBe(2);
    expect(tuning.labelDistribution.useful).toBe(1);
    expect(tuning.labelDistribution.show_less).toBe(1);
    expect(tuning.topicTuning[upserted.candidate.topicId]!.chatHookThresholdDelta).toBeGreaterThan(
      0,
    );
    expect(tuning.sourceTuning['example.com']!.preferenceDelta).toBeGreaterThan(0);
  });

  it('turns wrong-source feedback into source trust tuning without execute authority', () => {
    const root = makeTempRoot();
    const upserted = upsertAoiProactiveBriefCandidate(root, makeCandidate(), 3600);
    const decision = decideAoiProactiveBriefDelivery({
      candidate: upserted.candidate,
      context: {
        now: 3650,
      },
    });

    recordAoiProactiveBriefDeliveryFieldEvents({
      sessionsDir: root,
      sessionPath: 'aoi/default',
      candidates: [upserted.candidate],
      decisions: [decision],
      now: 3650,
    });
    recordAoiProactiveBriefFeedback(root, {
      version: 1,
      briefId: upserted.candidate.id,
      topicId: upserted.candidate.topicId,
      sessionPath: 'aoi/default',
      category: 'wrong_source',
      note: 'The source was not the right evidence for this topic.',
      createdAt: 3700,
    });

    const tuning = loadAoiProactiveBriefCalibrationTuning(root, 'aoi/default', 3800);
    const topicTuning = tuning.topicTuning[upserted.candidate.topicId]!;
    const sourceTuning = tuning.sourceTuning['example.com']!;

    expect(tuning.labelDistribution.wrong_source).toBe(1);
    expect(topicTuning.sourcePreferenceDelta).toBeLessThan(0);
    expect(topicTuning.conservativeReasons).toContain('wrong_source');
    expect(sourceTuning.preferenceDelta).toBeLessThan(0);
    expect(sourceTuning.directChatBlocked).toBe(true);
    expect(decision.ladder.steps.execute_after_approval.allowed).toBe(false);
    expect(decision.ladder.actionAuthority).toBe('display_only');
  });

  it('lets latest topic mute and pin calibration labels supersede topic state', () => {
    const root = makeTempRoot();
    const upserted = upsertAoiProactiveBriefCandidate(root, makeCandidate(), 4000);
    const decision = decideAoiProactiveBriefDelivery({
      candidate: upserted.candidate,
      context: {
        now: 4100,
      },
    });

    recordAoiProactiveBriefDeliveryFieldEvents({
      sessionsDir: root,
      sessionPath: 'aoi/default',
      candidates: [upserted.candidate],
      decisions: [decision],
      now: 4100,
    });
    const shown = loadAoiProactiveBriefFieldEvents(root, 'aoi/default', 4200).find((event) =>
      event.kind.startsWith('shown_'),
    );

    expect(shown).toBeTruthy();

    recordAoiProactiveBriefCalibrationLabel(root, {
      sessionPath: 'aoi/default',
      fieldEventId: shown!.id,
      label: 'mute_topic',
      now: 4300,
    });
    recordAoiProactiveBriefCalibrationLabel(root, {
      sessionPath: 'aoi/default',
      fieldEventId: shown!.id,
      label: 'pin_topic',
      now: 4400,
    });

    const pinnedTuning = loadAoiProactiveBriefCalibrationTuning(root, 'aoi/default', 4500);
    const pinnedTopic = pinnedTuning.topicTuning[upserted.candidate.topicId]!;

    expect(loadAoiProactiveBriefCalibrationLabels(root, 'aoi/default', 4500)).toHaveLength(2);
    expect(pinnedTopic.muted).toBe(false);
    expect(pinnedTopic.pinned).toBe(true);
    expect(pinnedTopic.directChatBlocked).toBe(false);
    expect(pinnedTopic.conservativeReasons).not.toContain('muted');
    expect(pinnedTuning.sourceTuning['example.com']!.directChatBlocked).toBe(false);

    recordAoiProactiveBriefCalibrationLabel(root, {
      sessionPath: 'aoi/default',
      fieldEventId: shown!.id,
      label: 'mute_topic',
      now: 4600,
    });

    const mutedTuning = loadAoiProactiveBriefCalibrationTuning(root, 'aoi/default', 4700);
    const mutedTopic = mutedTuning.topicTuning[upserted.candidate.topicId]!;

    expect(loadAoiProactiveBriefCalibrationLabels(root, 'aoi/default', 4700)).toHaveLength(3);
    expect(mutedTopic.muted).toBe(true);
    expect(mutedTopic.pinned).toBe(false);
    expect(mutedTopic.directChatBlocked).toBe(true);
    expect(mutedTopic.conservativeReasons).toContain('muted');
    expect(mutedTuning.mutedTopicCount).toBe(1);
    expect(mutedTuning.pinnedTopicCount).toBe(0);
    expect(mutedTuning.sourceTuning['example.com']!.directChatBlocked).toBe(true);
  });

  it('does not import network, research, or command execution helpers in this layer', () => {
    const source = [
      fs.readFileSync(join(process.cwd(), 'src/lib/aoiInterestProfile.ts'), 'utf-8'),
      fs.readFileSync(join(process.cwd(), 'src/lib/aoiProactiveBriefStore.ts'), 'utf-8'),
    ].join('\n');

    expect(source).not.toMatch(
      /tavily|search_web|start_research|child_process|runAoiApprovedCommand|executeAoiApprovedCommand/i,
    );
  });
});
