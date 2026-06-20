import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appendAoiFieldEvent,
  appendAoiFieldEvents,
  buildAoiFieldEventFromSignal,
  buildAoiFieldLedgerSummary,
  listAoiFieldEvents,
  loadAoiFieldEvents,
  loadAoiFieldLedgerSummary,
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
  });
});
