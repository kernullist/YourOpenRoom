import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { queryAoiMemories, summarizeAoiMemoryLedger } from '../aoiMemoryLedger';
import type { AoiMemoryEntry } from '../aoiMemoryShared';

const tempRoots: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'aoi-memory-ledger-'));
  tempRoots.push(root);
  return fs.realpathSync(root);
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

let seq = 0;

function writeMemory(root: string, partial: Partial<AoiMemoryEntry> & { id: string }): void {
  seq += 1;
  const dir = join(root, 'aoi', 'memory-v2', 'memories');
  fs.mkdirSync(dir, { recursive: true });
  const entry: AoiMemoryEntry = {
    version: 2,
    scope: 'user',
    type: 'fact',
    status: 'active',
    content: `content ${seq}`,
    normalizedContent: `content ${seq}`,
    importance: 0.7,
    confidence: 0.7,
    hits: 1,
    createdAt: seq,
    updatedAt: seq,
    sourceEpisodeIds: [`aoi_ep_${seq}`],
    tags: [],
    entities: [],
    ...partial,
  };
  fs.writeFileSync(join(dir, `${entry.id}.json`), JSON.stringify(entry), 'utf-8');
}

function seedMixed(root: string): void {
  writeMemory(root, { id: 'chat-1', sourceEpisodeIds: ['aoi_ep_1'], content: 'chat one' });
  writeMemory(root, {
    id: 'kira-1',
    sourceEpisodeIds: ['aoi_kira_1'],
    scope: 'project',
    type: 'action',
    tags: ['kira', 'automation'],
    projectKey: 'alpha',
    sessionPath: 'aoi/default',
  });
  writeMemory(root, {
    id: 'research-1',
    sourceEpisodeIds: ['aoi_research_1'],
    scope: 'agent',
    tags: ['research'],
    permanent: true,
  });
  writeMemory(root, { id: 'superseded-1', status: 'superseded' });
  writeMemory(root, { id: 'archived-1', status: 'archived' });
}

describe('queryAoiMemories', () => {
  it('defaults to active status (excludes superseded / archived)', () => {
    const root = makeRoot();
    seedMixed(root);
    const ids = queryAoiMemories(root).map((memory) => memory.id);
    expect(new Set(ids)).toEqual(new Set(['chat-1', 'kira-1', 'research-1']));
  });

  it('includes non-active memories when status is given explicitly', () => {
    const root = makeRoot();
    seedMixed(root);
    expect(queryAoiMemories(root, { status: 'superseded' }).map((m) => m.id)).toEqual([
      'superseded-1',
    ]);
    expect(
      queryAoiMemories(root, { status: ['active', 'archived'] })
        .map((m) => m.id)
        .sort(),
    ).toEqual(['archived-1', 'chat-1', 'kira-1', 'research-1']);
  });

  it('filters by derived source (membership)', () => {
    const root = makeRoot();
    seedMixed(root);
    expect(queryAoiMemories(root, { source: 'automation' }).map((m) => m.id)).toEqual(['kira-1']);
    expect(queryAoiMemories(root, { source: 'research' }).map((m) => m.id)).toEqual(['research-1']);
    expect(queryAoiMemories(root, { source: 'chat' }).map((m) => m.id)).toEqual(['chat-1']);
    expect(
      queryAoiMemories(root, { source: ['automation', 'research'] })
        .map((m) => m.id)
        .sort(),
    ).toEqual(['kira-1', 'research-1']);
  });

  it('filters by scope, type, projectKey, sessionPath, and tags (AND)', () => {
    const root = makeRoot();
    seedMixed(root);
    expect(queryAoiMemories(root, { scope: 'project' }).map((m) => m.id)).toEqual(['kira-1']);
    expect(queryAoiMemories(root, { type: 'action' }).map((m) => m.id)).toEqual(['kira-1']);
    expect(queryAoiMemories(root, { projectKey: 'alpha' }).map((m) => m.id)).toEqual(['kira-1']);
    expect(queryAoiMemories(root, { sessionPath: 'aoi/default' }).map((m) => m.id)).toEqual([
      'kira-1',
    ]);
    expect(queryAoiMemories(root, { tags: ['kira', 'automation'] }).map((m) => m.id)).toEqual([
      'kira-1',
    ]);
    // AND semantics: a tag the memory lacks excludes it.
    expect(queryAoiMemories(root, { tags: ['kira', 'missing'] })).toEqual([]);
  });

  it('relevance-ranks and caps when text + limit are given', () => {
    const root = makeRoot();
    writeMemory(root, { id: 'a', content: 'windows kernel telemetry driver' });
    writeMemory(root, { id: 'b', content: 'unrelated cooking recipe' });
    writeMemory(root, { id: 'c', content: 'kernel driver security research' });

    const ranked = queryAoiMemories(root, { text: 'kernel driver', limit: 2 });
    expect(ranked).toHaveLength(2);
    // The two kernel/driver memories outrank the cooking one.
    expect(new Set(ranked.map((m) => m.id))).toEqual(new Set(['a', 'c']));

    // text WITHOUT a limit ranks the full matched set (unrelated memory ranks last).
    const all = queryAoiMemories(root, { text: 'kernel driver' });
    expect(all).toHaveLength(3);
    expect(all[all.length - 1].id).toBe('b');
  });

  it('recency-orders and slices to limit without text', () => {
    const root = makeRoot();
    writeMemory(root, { id: 'old', updatedAt: 10 });
    writeMemory(root, { id: 'new', updatedAt: 20 });
    const result = queryAoiMemories(root, { limit: 1 });
    expect(result.map((m) => m.id)).toEqual(['new']); // updatedAt desc
  });

  it('returns an empty list for an empty store', () => {
    const root = makeRoot();
    expect(queryAoiMemories(root)).toEqual([]);
  });
});

describe('summarizeAoiMemoryLedger', () => {
  it('counts across every status, with bySource membership', () => {
    const root = makeRoot();
    seedMixed(root);
    const summary = summarizeAoiMemoryLedger(root);

    expect(summary.total).toBe(5);
    expect(summary.byStatus).toEqual({ active: 3, superseded: 1, archived: 1 });
    expect(summary.bySource.automation).toBe(1);
    expect(summary.bySource.research).toBe(1);
    // chat-1 + the plain superseded/archived (aoi_ep_ default episode) = 3 chat.
    expect(summary.bySource.chat).toBe(3);
    expect(summary.byScope.project).toBe(1);
    expect(summary.byScope.agent).toBe(1);
    expect(summary.byType.action).toBe(1);
    // Exclusive dimensions sum to total.
    const statusSum = Object.values(summary.byStatus).reduce((a, b) => a + b, 0);
    expect(statusSum).toBe(summary.total);
  });

  it('returns zeroed counts for an empty store', () => {
    const root = makeRoot();
    const summary = summarizeAoiMemoryLedger(root);
    expect(summary.total).toBe(0);
    expect(summary.bySource).toEqual({ chat: 0, automation: 0, research: 0 });
  });
});
