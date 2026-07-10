import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadAoiUnifiedOperatorSnapshotFromStores,
  loadAoiUnifiedOperatorSummaryFromStores,
} from '../aoiUnifiedOperatorModelServer';
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

  it('summarizes into a display_only operator summary', () => {
    const summary = loadAoiUnifiedOperatorSummaryFromStores(sessionsDir, {
      sessionPath: SESSION_PATH,
      now: NOW,
    });
    expect(summary.actionAuthority).toBe('display_only');
    expect(summary.sessionPath).toBe(SESSION_PATH);
  });
});
