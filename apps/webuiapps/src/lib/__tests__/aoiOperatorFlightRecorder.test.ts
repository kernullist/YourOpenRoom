import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildAoiOperatorFlightRecorderSummary,
  buildAoiOperatorFlightReplayDraft,
  createAoiOperatorFlightReplayDraft,
  loadAoiOperatorFlightRecords,
  loadAoiOperatorFlightRecorderSummary,
  loadAoiOperatorFlightReplayDrafts,
  recordAoiOperatorFlightRecord,
  resolveAoiOperatorFlightRecorderPaths,
} from '../aoiOperatorFlightRecorder';

const NOW = 1_800_000_000_000;
const SESSION_PATH = 'aoi/default';
const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'aoi-flight-recorder-test-'));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('Aoi operator flight recorder', () => {
  it('stores append-only redacted runtime decision records under the autonomy session root', () => {
    const root = makeTempRoot();

    const first = recordAoiOperatorFlightRecord(
      root,
      {
        sessionPath: SESSION_PATH,
        createdAt: NOW,
        signalClass: 'user_message',
        decisionLane: 'dashboard',
        sourceStates: [
          {
            sourceId: 'gmail-metadata',
            label:
              'Gmail message body: api_key=secret-value honey@example.com C:\\Users\\secret\\note.txt',
            kind: 'gmail_metadata',
            state: 'disconnected',
            freshness: 'unknown',
            cannotKnow: ['message body: do not leak password=secret1234'],
            evidenceRefs: ['gmail:honey@example.com'],
          },
        ],
        evidenceRefs: ['research:https://example.com/private?token=secret'],
        whySpeak: ['Show dashboard because C:\\Users\\secret\\note.txt changed.'],
        whyQuiet: ['Do not read email body: password=secret1234.'],
        preparedActionRefs: ['work-order:C:\\Users\\secret\\work.md'],
        approvalState: {
          status: 'required',
          required: true,
          approvalRef: 'approval:https://example.com/private',
          reason: 'Needs approval before reading source body.',
        },
        outcomeRefs: ['outcome:honey@example.com'],
      },
      NOW,
    );
    const second = recordAoiOperatorFlightRecord(
      root,
      {
        sessionPath: SESSION_PATH,
        createdAt: NOW + 1,
        signalClass: 'workspace',
        decisionLane: 'hidden',
        sourceStates: [
          {
            sourceId: 'workspace',
            label: 'Workspace',
            kind: 'workspace',
            state: 'available',
            freshness: 'fresh',
            evidenceRefs: ['workspace:clean'],
          },
        ],
        evidenceRefs: ['workspace:clean'],
        whyQuiet: ['Low value duplicate signal.'],
      },
      NOW + 1,
    );
    const paths = resolveAoiOperatorFlightRecorderPaths(root, SESSION_PATH);
    const rawFile = fs.readFileSync(paths.records, 'utf-8');
    const loaded = loadAoiOperatorFlightRecords(root, SESSION_PATH, NOW + 2);
    const serialized = JSON.stringify(loaded);

    expect(rawFile.trim().split(/\r?\n/)).toHaveLength(2);
    expect(loaded.map((record) => record.id)).toEqual([second.id, first.id]);
    expect(first.redaction.replacementCount).toBeGreaterThan(0);
    expect(first.actionAuthority).toBe('display_only');
    expect(first.mutationCount).toBe(0);
    expect(serialized).not.toContain('honey@example.com');
    expect(serialized).not.toContain('secret-value');
    expect(serialized).not.toContain('secret1234');
    expect(serialized).not.toContain('C:\\Users\\secret');
    expect(serialized).not.toContain('https://example.com/private');
    expect(serialized).toContain('[private-body]');
    expect(serialized).toContain('[local-path]');
  });

  it('summarizes decision lanes, blind spots, freshness gaps, and hard-fail counters', () => {
    const root = makeTempRoot();
    const hidden = recordAoiOperatorFlightRecord(
      root,
      {
        sessionPath: SESSION_PATH,
        createdAt: NOW,
        signalClass: 'research',
        decisionLane: 'hidden',
        sourceStates: [
          {
            sourceId: 'research-cache',
            label: 'Research cache',
            kind: 'research',
            state: 'stale',
            freshness: 'stale',
            cannotKnow: ['Aoi cannot make a current claim from stale research.'],
            evidenceRefs: ['research:stale'],
          },
        ],
        evidenceRefs: ['research:stale'],
        whyQuiet: ['Stale source blocks current claim.'],
        hardFailCounters: {
          staleCurrentClaimCount: 1,
        },
      },
      NOW,
    );
    const approval = recordAoiOperatorFlightRecord(
      root,
      {
        sessionPath: SESSION_PATH,
        createdAt: NOW + 1,
        signalClass: 'capability',
        decisionLane: 'approval_request',
        sourceStates: [
          {
            sourceId: 'kira-settings',
            label: 'Kira settings',
            kind: 'app_state',
            state: 'available',
            freshness: 'fresh',
            evidenceRefs: ['app:kira'],
          },
        ],
        evidenceRefs: ['capability:kira-settings'],
        whySpeak: ['Prepared settings change requires explicit approval.'],
        approvalState: {
          status: 'required',
          required: true,
          approvalRef: 'approval:kira-settings',
        },
        hardFailCounters: {
          privateLeakCount: 2,
          unauthorizedMutationCount: 1,
          approvalBypassCount: 1,
        },
      },
      NOW + 1,
    );
    const records = loadAoiOperatorFlightRecords(root, SESSION_PATH, NOW + 2);
    const summary = buildAoiOperatorFlightRecorderSummary({
      sessionPath: SESSION_PATH,
      records,
      replayDraftCount: 3,
      now: NOW + 2,
    });
    const loadedSummary = loadAoiOperatorFlightRecorderSummary(root, SESSION_PATH, NOW + 2);

    expect(summary.totalRecordCount).toBe(2);
    expect(summary.laneCounts.hidden).toBe(1);
    expect(summary.laneCounts.approval_request).toBe(1);
    expect(summary.hardFailCounters).toMatchObject({
      privateLeakCount: 2,
      unauthorizedMutationCount: 1,
      staleCurrentClaimCount: 1,
      approvalBypassCount: 1,
    });
    expect(summary.latestSourceFreshnessGapLabels.join(' ')).toContain('Research cache');
    expect(summary.recentRecords.map((record) => record.id)).toEqual([approval.id, hidden.id]);
    expect(summary.actionAuthority).toBe('display_only');
    expect(loadedSummary.hardFailCounters.staleCurrentClaimCount).toBe(1);
  });

  it('extracts deterministic replay drafts without live operations or private content', () => {
    const root = makeTempRoot();
    const fetchMock = vi.fn(() => {
      throw new Error('Flight replay draft extraction must not call live fetch.');
    });
    vi.stubGlobal('fetch', fetchMock);
    const record = recordAoiOperatorFlightRecord(
      root,
      {
        sessionPath: SESSION_PATH,
        createdAt: NOW,
        signalClass: 'user_message',
        decisionLane: 'blocked',
        sourceStates: [
          {
            sourceId: 'calendar-metadata',
            label: 'Calendar message body: honey@example.com password=secret1234',
            kind: 'calendar_metadata',
            state: 'revoked',
            freshness: 'unknown',
            cannotKnow: ['calendar body: private appointment details'],
            evidenceRefs: ['calendar:honey@example.com'],
          },
        ],
        evidenceRefs: ['calendar:honey@example.com'],
        whyQuiet: ['Calendar body is not authorized.'],
      },
      NOW,
    );

    const firstDraft = buildAoiOperatorFlightReplayDraft({
      record,
      now: NOW,
    });
    const secondDraft = buildAoiOperatorFlightReplayDraft({
      record,
      now: NOW,
    });
    const persisted = createAoiOperatorFlightReplayDraft({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      recordId: record.id,
      now: NOW,
    });
    const drafts = loadAoiOperatorFlightReplayDrafts(root, SESSION_PATH);
    const serialized = JSON.stringify([firstDraft, persisted, drafts]);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(firstDraft.fixture).toEqual(secondDraft.fixture);
    expect(firstDraft.status).toBe('draft_needs_review');
    expect(firstDraft.fixture.inputEvents).toHaveLength(1);
    expect(firstDraft.fixture.inputEvents[0]).toMatchObject({
      kind: 'proposal_decision',
      createdAt: NOW,
    });
    expect(firstDraft.todoExpectations.join(' ')).toContain('Replace the placeholder expectation');
    expect(persisted.sourceRecordId).toBe(record.id);
    expect(drafts).toHaveLength(1);
    expect(serialized).not.toContain('honey@example.com');
    expect(serialized).not.toContain('secret1234');
    expect(serialized).toContain('[private-body]');
    expect(persisted.mutationCount).toBe(0);
  });
});
