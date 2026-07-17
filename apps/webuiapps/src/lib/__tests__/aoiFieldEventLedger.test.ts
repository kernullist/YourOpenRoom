import * as fs from 'fs';
import * as os from 'os';
import { createHash } from 'crypto';
import { dirname, join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AOI_FIELD_EVENT_DEDUPE_WINDOW_MS,
  appendAoiFieldEvent,
  appendAoiFieldEvents,
  buildAoiFieldEventFromSignal,
  buildAoiFieldLedgerSummary,
  compactAoiFieldEventLedger,
  listAoiFieldEvents,
  loadAoiFieldEventCompactionState,
  loadAoiFieldEvents,
  loadAoiFieldLedgerSummary,
  normalizeAoiFieldEvent,
  pruneAoiFieldEvents,
  resolveAoiFieldEventLedgerPaths,
  saveAoiFieldEvents,
} from '../aoiFieldEventLedger';
import {
  buildAoiKiraOutcomeFieldSignal,
  buildAoiPersonalMetadataFieldSignal,
  buildAoiResearchFieldSignal,
} from '../aoiFieldSignalBridge';

const SESSION_PATH = 'aoi/default';
const NOW = 1_800_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'aoi-field-event-ledger-test-'));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('Aoi Field Event Ledger', () => {
  it('records a Kira validation signal as a display-only field event', () => {
    const signal = buildAoiKiraOutcomeFieldSignal(
      {
        sessionPath: SESSION_PATH,
        outcomeId: 'validation-001',
        status: 'failed',
        summary: 'Kira validation failed on focused test evidence.',
        validatedAt: NOW,
        evidenceRefs: ['kira:validation-001'],
      },
      NOW,
    );
    const event = buildAoiFieldEventFromSignal(signal);

    expect(event).toMatchObject({
      sessionPath: SESSION_PATH,
      category: 'signal_observed',
      privacyState: 'metadata_only',
      actionAuthority: 'display_only',
      mutationCount: 0,
      createdAt: NOW,
    });
    expect(event.sourceRefs[0]).toContain('kira:');
    expect(event.evidenceRefs).toContain('kira:validation-001');
  });

  it('append-only saves, loads, lists, and prunes field events', () => {
    const root = makeTempRoot();
    const paths = resolveAoiFieldEventLedgerPaths(root, SESSION_PATH);
    const active = appendAoiFieldEvent(
      root,
      {
        sessionPath: SESSION_PATH,
        category: 'opportunity_created',
        summary: 'A dashboard opportunity was created from workspace evidence.',
        sourceRefs: ['workspace:aoi-field-signal-workspace'],
        evidenceRefs: ['workspace:git-status'],
        privacyState: 'metadata_only',
        createdAt: NOW,
        expiresAt: NOW + DAY_MS,
      },
      NOW,
    );
    const expired = appendAoiFieldEvent(
      root,
      {
        sessionPath: SESSION_PATH,
        category: 'delivery_hidden',
        summary: 'An old hidden delivery event expired.',
        sourceRefs: ['manual:old-event'],
        evidenceRefs: ['manual:old-event'],
        privacyState: 'metadata_only',
        createdAt: NOW - 2 * DAY_MS,
        expiresAt: NOW - DAY_MS,
      },
      NOW,
    );
    const loaded = loadAoiFieldEvents(root, SESSION_PATH, NOW);
    const listed = listAoiFieldEvents(root, SESSION_PATH, NOW);
    const pruned = pruneAoiFieldEvents(root, SESSION_PATH, NOW);
    const afterPrune = loadAoiFieldEvents(root, SESSION_PATH, NOW);

    expect(fs.existsSync(paths.events)).toBe(true);
    expect(loaded.map((event) => event.id)).toEqual([active.id, expired.id]);
    expect(listed).toHaveLength(2);
    expect(pruned.map((event) => event.id)).toEqual([active.id]);
    expect(afterPrune).toHaveLength(1);
    expect(afterPrune[0]).toMatchObject({
      id: active.id,
      mutationCount: 0,
      actionAuthority: 'display_only',
    });
  });

  it('supports batch save as append-only event recording', () => {
    const root = makeTempRoot();
    const first = saveAoiFieldEvents(
      root,
      [
        {
          sessionPath: SESSION_PATH,
          category: 'deliberation_ready',
          summary: 'Deliberation became ready.',
          sourceRefs: ['research:ready'],
          evidenceRefs: ['research:ready'],
          createdAt: NOW,
        },
      ],
      NOW,
    );
    const second = appendAoiFieldEvents(
      root,
      [
        {
          sessionPath: SESSION_PATH,
          category: 'action_ladder_blocked',
          summary: 'Action ladder blocked mutation until approval.',
          sourceRefs: ['kira:validation-001'],
          evidenceRefs: ['policy:approval-required'],
          createdAt: NOW + 1,
        },
      ],
      NOW + 1,
    );
    const loaded = loadAoiFieldEvents(root, SESSION_PATH, NOW + 1);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(loaded).toHaveLength(2);
    expect(loaded[0].category).toBe('action_ladder_blocked');
    expect(loaded[1].category).toBe('deliberation_ready');
  });

  it('ignores malformed ledger lines instead of inventing field events', () => {
    const root = makeTempRoot();
    const paths = resolveAoiFieldEventLedgerPaths(root, SESSION_PATH);
    fs.mkdirSync(paths.root, { recursive: true });
    fs.writeFileSync(paths.events, '{"sessionPath":"aoi/default"}\nnot-json\n', 'utf-8');
    const valid = appendAoiFieldEvent(
      root,
      {
        sessionPath: SESSION_PATH,
        category: 'feedback_recorded',
        summary: 'Operator feedback was recorded as metadata.',
        sourceRefs: ['manual:feedback'],
        evidenceRefs: ['feedback:manual'],
        privacyState: 'metadata_only',
        createdAt: NOW,
        expiresAt: NOW + DAY_MS,
      },
      NOW,
    );
    const loaded = loadAoiFieldEvents(root, SESSION_PATH, NOW);

    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe(valid.id);
  });

  it('aggregates field ledger summary with zero mutation count', () => {
    const researchSignal = buildAoiResearchFieldSignal(
      {
        sessionPath: SESSION_PATH,
        runId: 'run-stale',
        title: 'Stale research',
        summary: 'Old public source metadata.',
        freshness: 'stale',
        completedAt: NOW - 1_000,
        evidenceRefs: ['research:run-stale'],
      },
      NOW,
    );
    const personalSignal = buildAoiPersonalMetadataFieldSignal(
      {
        sessionPath: SESSION_PATH,
        sourceId: 'calendar-primary',
        label: 'Calendar primary',
        kind: 'calendar_metadata',
        consentState: 'revoked',
        freshness: 'unknown',
        metadataSummary: 'Calendar metadata disabled.',
        bodyPreview: 'body: private meeting content',
        evidenceRefs: ['personal-metadata:calendar-primary'],
      },
      NOW,
    );
    const events = [
      buildAoiFieldEventFromSignal(researchSignal),
      buildAoiFieldEventFromSignal(personalSignal),
    ];
    expect(events[1].privacyState).toBe('none');
    const summary = buildAoiFieldLedgerSummary({
      sessionPath: SESSION_PATH,
      events,
      now: NOW,
    });

    expect(summary.totalEventCount).toBe(2);
    expect(summary.activeEventCount).toBe(2);
    expect(summary.categoryCounts.signal_observed).toBe(2);
    expect(summary.privacyCounts.metadata_only).toBe(1);
    expect(summary.privacyCounts.none).toBe(1);
    expect(summary.sourceKindCounts.research).toBe(1);
    expect(summary.sourceKindCounts.personal_metadata).toBe(1);
    expect(summary.cannotKnow.join(' ')).toContain('Current state cannot be claimed');
    expect(summary.cannotKnow.join(' ')).toContain('Private personal source body was not read');
    expect(summary.actionAuthority).toBe('display_only');
    expect(summary.mutationCount).toBe(0);
    expect(summary.zeroMutation).toBe(true);
  });

  it('loads a compact ledger summary from the session store', () => {
    const root = makeTempRoot();
    appendAoiFieldEvent(
      root,
      {
        sessionPath: SESSION_PATH,
        category: 'readiness_gate_changed',
        summary: 'Readiness gate changed after validation evidence.',
        sourceRefs: ['workspace:validation'],
        evidenceRefs: ['validation:passed'],
        privacyState: 'metadata_only',
        createdAt: NOW,
        expiresAt: NOW + DAY_MS,
      },
      NOW,
    );
    const summary = loadAoiFieldLedgerSummary(root, SESSION_PATH, NOW);

    expect(summary.activeEventCount).toBe(1);
    expect(summary.recentEvents[0]).toMatchObject({
      category: 'readiness_gate_changed',
      mutationCount: 0,
    });
    expect(summary.readinessCreditEventCount).toBe(0);
  });

  it('deduplicates the same decision and evidence only inside the bounded window', () => {
    const root = makeTempRoot();
    const input = {
      sessionPath: SESSION_PATH,
      category: 'delivery_dashboard',
      summary: 'The same evidence-backed dashboard decision was shown.',
      sourceRefs: ['workspace:decision-1'],
      evidenceRefs: ['workspace:evidence-1'],
      privacyState: 'metadata_only',
      dedupeKey: 'decision-1',
    };
    const first = appendAoiFieldEvent(root, { ...input, createdAt: NOW }, NOW);
    const duplicate = appendAoiFieldEvent(
      root,
      { ...input, createdAt: NOW + AOI_FIELD_EVENT_DEDUPE_WINDOW_MS - 1 },
      NOW + AOI_FIELD_EVENT_DEDUPE_WINDOW_MS - 1,
    );
    const later = appendAoiFieldEvent(
      root,
      { ...input, createdAt: NOW + AOI_FIELD_EVENT_DEDUPE_WINDOW_MS + 1 },
      NOW + AOI_FIELD_EVENT_DEDUPE_WINDOW_MS + 1,
    );

    expect(duplicate.id).toBe(first.id);
    expect(later.id).not.toBe(first.id);
    expect(loadAoiFieldEvents(root, SESSION_PATH, later.createdAt)).toHaveLength(2);
    expect(loadAoiFieldEventCompactionState(root, SESSION_PATH, later.createdAt)).toMatchObject({
      duplicateSuppressionCount: 1,
      compactedEventCount: 0,
    });
  });

  it('compacts expired private-bait events into aggregate-only metadata', () => {
    const root = makeTempRoot();
    const privateBait = 'PRIVATE_BAIT_NEVER_PERSIST_IN_COMPACTION';
    appendAoiFieldEvent(
      root,
      {
        sessionPath: SESSION_PATH,
        category: 'delivery_hidden',
        summary: `Expired ${privateBait}`,
        sourceRefs: [`manual:${privateBait}`],
        evidenceRefs: [`manual:${privateBait}`],
        privacyState: 'metadata_only',
        dedupeKey: privateBait,
        createdAt: NOW - DAY_MS,
        expiresAt: NOW - 1,
      },
      NOW,
    );

    const compacted = compactAoiFieldEventLedger(root, SESSION_PATH, NOW);
    const paths = resolveAoiFieldEventLedgerPaths(root, SESSION_PATH);
    const compactedText = fs.readFileSync(paths.compaction, 'utf-8');

    expect(compacted.retainedEvents).toHaveLength(0);
    expect(compacted.compaction).toMatchObject({
      compactedEventCount: 1,
      expiredEventCount: 1,
      duplicateSuppressionCount: 0,
    });
    expect(compactedText).not.toContain(privateBait);
    expect(fs.readFileSync(paths.events, 'utf-8')).not.toContain(privateBait);
  });

  it('compacts a large ledger to a bounded 1000-event audit tail', () => {
    const root = makeTempRoot();
    const paths = resolveAoiFieldEventLedgerPaths(root, SESSION_PATH);
    const events = Array.from({ length: 5000 }, (_, index) => {
      const event = normalizeAoiFieldEvent(
        {
          sessionPath: SESSION_PATH,
          category: 'signal_observed',
          summary: `Large ledger event ${index}.`,
          sourceRefs: [`workspace:item-${index}`],
          evidenceRefs: [`workspace:evidence-${index}`],
          privacyState: 'metadata_only',
          dedupeKey: `large-ledger-${index}`,
          createdAt: NOW - index,
          expiresAt: NOW + DAY_MS,
        },
        SESSION_PATH,
        NOW,
      );
      if (!event) {
        throw new Error('Failed to build large-ledger event fixture.');
      }
      return event;
    });
    fs.mkdirSync(paths.root, { recursive: true });
    fs.writeFileSync(paths.events, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);

    const startedAt = performance.now();
    const compacted = compactAoiFieldEventLedger(root, SESSION_PATH, NOW);
    const durationMs = performance.now() - startedAt;

    expect(compacted.retainedEvents).toHaveLength(1000);
    expect(compacted.compaction.overflowEventCount).toBe(4000);
    expect(loadAoiFieldEvents(root, SESSION_PATH, NOW, 5000)).toHaveLength(1000);
    expect(durationMs).toBeLessThan(5000);
  });

  it('recovers an interrupted aggregate-first compaction without losing or double-counting events', () => {
    const sourceRoot = makeTempRoot();
    const recoveryRoot = makeTempRoot();
    const privateBait = 'PRIVATE_INTERRUPTED_COMPACTION_BAIT';
    const expired = normalizeAoiFieldEvent(
      {
        sessionPath: SESSION_PATH,
        category: 'delivery_hidden',
        summary: `Expired ${privateBait}`,
        sourceRefs: [`manual:${privateBait}`],
        evidenceRefs: [`manual:${privateBait}`],
        createdAt: NOW - DAY_MS,
        expiresAt: NOW - 1,
        dedupeKey: 'interrupted-expired',
      },
      SESSION_PATH,
      NOW,
    );
    const active = normalizeAoiFieldEvent(
      {
        sessionPath: SESSION_PATH,
        category: 'delivery_dashboard',
        summary: 'Active event survives interrupted compaction recovery.',
        sourceRefs: ['workspace:active'],
        evidenceRefs: ['workspace:active'],
        createdAt: NOW,
        expiresAt: NOW + DAY_MS,
        dedupeKey: 'interrupted-active',
      },
      SESSION_PATH,
      NOW,
    );
    if (!expired || !active) {
      throw new Error('Failed to build interrupted-compaction fixtures.');
    }

    const sourcePaths = resolveAoiFieldEventLedgerPaths(sourceRoot, SESSION_PATH);
    fs.mkdirSync(sourcePaths.root, { recursive: true });
    fs.writeFileSync(sourcePaths.events, `${JSON.stringify(expired)}\n${JSON.stringify(active)}\n`);
    const targetCompaction = compactAoiFieldEventLedger(sourceRoot, SESSION_PATH, NOW).compaction;
    if (!targetCompaction.lastTransactionId) {
      throw new Error('Compaction transaction id was not persisted.');
    }

    const recoveryPaths = resolveAoiFieldEventLedgerPaths(recoveryRoot, SESSION_PATH);
    fs.mkdirSync(recoveryPaths.root, { recursive: true });
    fs.writeFileSync(
      recoveryPaths.events,
      `${JSON.stringify(expired)}\n${JSON.stringify(active)}\n`,
    );
    fs.writeFileSync(
      recoveryPaths.compactionJournal,
      `${JSON.stringify({
        version: 1,
        sessionPath: SESSION_PATH,
        transactionId: targetCompaction.lastTransactionId,
        createdAt: NOW,
        targetCompaction,
        removedRecordFingerprints: [
          createHash('sha256').update(JSON.stringify(expired)).digest('hex'),
        ],
      })}\n`,
    );

    expect(fs.readFileSync(recoveryPaths.compactionJournal, 'utf-8')).not.toContain(privateBait);
    expect(loadAoiFieldEvents(recoveryRoot, SESSION_PATH, NOW).map((event) => event.id)).toEqual([
      active.id,
    ]);
    expect(fs.existsSync(recoveryPaths.compactionJournal)).toBe(false);
    expect(loadAoiFieldEventCompactionState(recoveryRoot, SESSION_PATH, NOW)).toMatchObject({
      compactedEventCount: 1,
      expiredEventCount: 1,
      lastTransactionId: targetCompaction.lastTransactionId,
    });
    expect(compactAoiFieldEventLedger(recoveryRoot, SESSION_PATH, NOW).compaction).toMatchObject({
      compactedEventCount: 1,
      expiredEventCount: 1,
    });
  });

  it('fails closed when the field ledger directory is redirected through a symlink or junction', () => {
    const root = makeTempRoot();
    const outside = makeTempRoot();
    const paths = resolveAoiFieldEventLedgerPaths(root, SESSION_PATH);
    fs.mkdirSync(dirname(paths.root), { recursive: true });
    fs.symlinkSync(outside, paths.root, process.platform === 'win32' ? 'junction' : 'dir');

    expect(() =>
      appendAoiFieldEvent(
        root,
        {
          sessionPath: SESSION_PATH,
          category: 'delivery_dashboard',
          summary: 'This event must not escape the trusted sessions root.',
          sourceRefs: ['workspace:symlink-test'],
          evidenceRefs: ['workspace:symlink-test'],
          createdAt: NOW,
        },
        NOW,
      ),
    ).toThrow(/trusted sessions root/i);
    expect(fs.readdirSync(outside)).toEqual([]);
  });
});
