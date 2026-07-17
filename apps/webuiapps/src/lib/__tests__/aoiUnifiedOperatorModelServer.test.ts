import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadAoiUnifiedOperatorSnapshotFromStores,
  loadAoiUnifiedOperatorSummaryFromStores,
} from '../aoiUnifiedOperatorModelServer';
import { saveAoiInterestProfile } from '../aoiProactiveBriefStore';
import type { AoiMemoryEntry } from '../aoiMemoryShared';

const SESSION_PATH = 'aoi/default';
const NOW = 1_800_000_000_000;

function memory(partial: Partial<AoiMemoryEntry>): AoiMemoryEntry {
  return {
    version: 2,
    id: 'mem',
    scope: 'user',
    type: 'fact',
    status: 'active',
    content: 'content',
    normalizedContent: 'content',
    importance: 0.7,
    confidence: 0.8,
    hits: 1,
    createdAt: 1,
    updatedAt: 1,
    sourceEpisodeIds: ['ep-1'],
    sessionPath: SESSION_PATH,
    tags: [],
    entities: [],
    ...partial,
  } as AoiMemoryEntry;
}

describe('loadAoiUnifiedOperatorSnapshotFromStores (P5.3)', () => {
  let sessionsDir: string;

  beforeEach(() => {
    sessionsDir = mkdtempSync(join(tmpdir(), 'aoi-operator-model-'));
  });

  afterEach(() => {
    rmSync(sessionsDir, { recursive: true, force: true });
  });

  function seedMemories(memories: AoiMemoryEntry[]): void {
    const dir = join(sessionsDir, 'aoi', 'memory-v2', 'memories');
    mkdirSync(dir, { recursive: true });
    for (const entry of memories) {
      writeFileSync(join(dir, `${entry.id}.json`), JSON.stringify(entry), 'utf8');
    }
  }

  it('builds a display_only snapshot from empty stores without throwing', () => {
    const snapshot = loadAoiUnifiedOperatorSnapshotFromStores(sessionsDir, {
      sessionPath: SESSION_PATH,
      now: NOW,
    });
    expect(snapshot.sessionPath).toBe(SESSION_PATH);
    expect(snapshot.actionAuthority.actionAuthority).toBe('display_only');
    // A fresh store still yields a well-formed snapshot (all evidence sections present).
    expect(Array.isArray(snapshot.interests)).toBe(true);
    expect(snapshot.sourceTrust.length).toBeGreaterThan(0);
    expect(snapshot.feedback).toBeDefined();
    // The store loaders are actually wired in: their evidence flows into the snapshot.
    expect(snapshot.evidenceRefs).toContain('follow_through_learning:v1');
    expect(snapshot.evidenceRefs.some((ref) => ref.startsWith('source-registry:'))).toBe(true);
    // A readiness scorecard (backed by closed-loop metrics) is now always assembled, so the
    // readiness section is no longer the empty "no scorecard provided" placeholder.
    expect(snapshot.readiness.summary).not.toBe('No readiness scorecard was provided.');
    expect(snapshot.readiness.cannotKnow).not.toContain(
      'Aoi cannot know delivery readiness without a readiness scorecard.',
    );
  });

  it('reads real seeded stores and still builds a well-formed display_only snapshot', () => {
    seedMemories([
      memory({
        id: 'mem-re',
        content: 'The user works on Windows anti-cheat kernel telemetry.',
        normalizedContent: 'the user works on windows anti-cheat kernel telemetry.',
        entities: ['anti-cheat', 'kernel'],
      }),
    ]);
    // The assembly must load the real memory store (loadServerAoiMemories) without error
    // and hand it to the pure builder; the derivation of raw memories into interest topics
    // is the builder's own (separately tested) concern.
    const snapshot = loadAoiUnifiedOperatorSnapshotFromStores(sessionsDir, {
      sessionPath: SESSION_PATH,
      now: NOW,
      currentUserMessage: 'anti-cheat kernel work',
    });
    expect(snapshot.actionAuthority.actionAuthority).toBe('display_only');
    expect(snapshot.actionAuthority.mutationCount).toBe(0);
    expect(Array.isArray(snapshot.interests)).toBe(true);
  });

  it('does not load memories owned by another session', () => {
    seedMemories([
      memory({
        id: 'mem-session-b',
        sessionPath: 'aoi/session-b',
        updatedAt: NOW,
      }),
    ]);
    saveAoiInterestProfile(
      sessionsDir,
      SESSION_PATH,
      {
        version: 1,
        sessionPath: SESSION_PATH,
        topics: [
          {
            version: 1,
            id: 'topic-session-a',
            sessionPath: SESSION_PATH,
            label: 'Session A Topic',
            normalizedLabel: 'session a topic',
            aliases: [],
            source: 'memory',
            memoryIds: ['mem-session-b'],
            evidenceRefs: ['memory:mem-session-b'],
            confidence: 0.9,
            importance: 0.8,
            noveltyPreference: 0.7,
            currentInfoPreference: 0.7,
            muted: false,
            pinned: false,
            cooldownKey: 'interest:session-a-topic',
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        generatedAt: 1,
        sourceMemoryCount: 1,
        warnings: [],
      },
      NOW,
    );
    const snapshot = loadAoiUnifiedOperatorSnapshotFromStores(sessionsDir, {
      sessionPath: SESSION_PATH,
      now: NOW,
    });
    expect(snapshot.interests[0]?.freshness).toBe('expired');
    expect(snapshot.interests[0]?.confidence).toBeLessThan(0.5);
  });

  it('summarizes into a display_only operator summary', () => {
    const summary = loadAoiUnifiedOperatorSummaryFromStores(sessionsDir, {
      sessionPath: SESSION_PATH,
      now: NOW,
    });
    expect(summary.actionAuthority).toBe('display_only');
    expect(summary.sessionPath).toBe(SESSION_PATH);
  });
});
