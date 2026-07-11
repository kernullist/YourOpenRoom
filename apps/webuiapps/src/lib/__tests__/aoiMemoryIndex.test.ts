import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildAoiMemoryIndexEntry,
  indexEntryMatchesCriteria,
  loadActiveAoiMemoriesViaIndex,
  loadOrRefreshAoiMemoryIndex,
  rebuildAoiMemoryIndex,
  selectAoiMemoryIndexIds,
  sortAoiMemoryIndexEntries,
  type AoiMemoryIndexEntry,
} from '../aoiMemoryIndex';
import * as writer from '../aoiMemoryServerWriter';
import { loadServerAoiMemories } from '../aoiMemoryServerWriter';
import type { AoiMemoryEntry } from '../aoiMemoryShared';

const NOW = 1_800_000_000_000;
const tempRoots: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'aoi-memory-index-'));
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

function memoriesDir(root: string): string {
  return join(root, 'aoi', 'memory-v2', 'memories');
}

function writeMemory(root: string, partial: Partial<AoiMemoryEntry> & { id: string }): void {
  seq += 1;
  const dir = memoriesDir(root);
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

function indexFileExists(root: string): boolean {
  return fs.existsSync(join(root, 'aoi', 'memory-v2', 'index.json'));
}

function makeEntry(partial: Partial<AoiMemoryEntry> & { id: string }): AoiMemoryEntry {
  return {
    version: 2,
    scope: 'user',
    type: 'fact',
    status: 'active',
    content: 'x',
    normalizedContent: 'x',
    importance: 0.5,
    confidence: 0.5,
    hits: 0,
    createdAt: 0,
    updatedAt: 0,
    sourceEpisodeIds: [],
    tags: [],
    entities: [],
    ...partial,
  };
}

describe('buildAoiMemoryIndexEntry', () => {
  it('captures the metadata facets + stat signature + embedding flag', () => {
    const entry = buildAoiMemoryIndexEntry(
      makeEntry({
        id: 'm-1',
        status: 'archived',
        scope: 'project',
        type: 'action',
        updatedAt: 123,
        tags: ['automation', 'x'],
        sourceEpisodeIds: ['aoi_kira_9'],
        projectKey: 'alpha',
        sessionPath: 'aoi/default',
        embedding: [0.1, 0.2],
        embeddingModel: 'test-model',
      }),
      { mtimeMs: 555, size: 42 },
    );
    expect(entry).toMatchObject({
      id: 'm-1',
      mtimeMs: 555,
      size: 42,
      updatedAt: 123,
      status: 'archived',
      scope: 'project',
      type: 'action',
      tags: ['automation', 'x'],
      projectKey: 'alpha',
      sessionPath: 'aoi/default',
      hasEmbedding: true,
      embeddingModel: 'test-model',
    });
    // sources are derived (kira episode + automation tag -> automation).
    expect(entry.sources).toContain('automation');
  });

  it('marks hasEmbedding false when the vector is absent or empty', () => {
    expect(
      buildAoiMemoryIndexEntry(makeEntry({ id: 'a' }), { mtimeMs: 1, size: 1 }).hasEmbedding,
    ).toBe(false);
    expect(
      buildAoiMemoryIndexEntry(makeEntry({ id: 'b', embedding: [] }), { mtimeMs: 1, size: 1 })
        .hasEmbedding,
    ).toBe(false);
  });
});

describe('sortAoiMemoryIndexEntries', () => {
  it('orders by updatedAt desc with a stable id tiebreaker', () => {
    const entries: AoiMemoryIndexEntry[] = [
      buildAoiMemoryIndexEntry(makeEntry({ id: 'b', updatedAt: 5 }), { mtimeMs: 0, size: 0 }),
      buildAoiMemoryIndexEntry(makeEntry({ id: 'a', updatedAt: 5 }), { mtimeMs: 0, size: 0 }),
      buildAoiMemoryIndexEntry(makeEntry({ id: 'c', updatedAt: 9 }), { mtimeMs: 0, size: 0 }),
    ];
    expect(sortAoiMemoryIndexEntries(entries).map((e) => e.id)).toEqual(['c', 'a', 'b']);
  });
});

describe('indexEntryMatchesCriteria', () => {
  const entry = buildAoiMemoryIndexEntry(
    makeEntry({
      id: 'm',
      status: 'active',
      scope: 'project',
      type: 'action',
      tags: ['a', 'b'],
      sourceEpisodeIds: ['aoi_kira_1'],
      projectKey: 'alpha',
      sessionPath: 'aoi/default',
    }),
    { mtimeMs: 0, size: 0 },
  );

  it('matches on every metadata facet and rejects a status outside the set', () => {
    expect(indexEntryMatchesCriteria(entry, { scope: 'project' }, ['active'])).toBe(true);
    expect(indexEntryMatchesCriteria(entry, { source: 'automation' }, ['active'])).toBe(true);
    expect(indexEntryMatchesCriteria(entry, { tags: ['a', 'b'] }, ['active'])).toBe(true);
    expect(indexEntryMatchesCriteria(entry, { tags: ['a', 'missing'] }, ['active'])).toBe(false);
    expect(indexEntryMatchesCriteria(entry, {}, ['superseded'])).toBe(false);
    expect(indexEntryMatchesCriteria(entry, { projectKey: 'beta' }, ['active'])).toBe(false);
  });
});

describe('loadOrRefreshAoiMemoryIndex', () => {
  it('builds + persists an index covering all memory files', () => {
    const root = makeRoot();
    writeMemory(root, { id: 'a', updatedAt: 1 });
    writeMemory(root, { id: 'b', updatedAt: 2 });
    const index = loadOrRefreshAoiMemoryIndex(root, NOW);
    expect(index.entries.map((e) => e.id)).toEqual(['b', 'a']); // recency desc
    expect(indexFileExists(root)).toBe(true);
  });

  it('returns an empty index for an empty store', () => {
    const root = makeRoot();
    expect(loadOrRefreshAoiMemoryIndex(root, NOW).entries).toEqual([]);
  });

  it('self-heals when a memory file changes (status flip is reflected)', () => {
    const root = makeRoot();
    writeMemory(root, { id: 'a', status: 'active' });
    const first = loadOrRefreshAoiMemoryIndex(root, NOW);
    expect(first.entries[0].status).toBe('active');

    // Archive the memory on disk (different content + size -> detected).
    writeMemory(root, { id: 'a', status: 'archived' });
    const second = loadOrRefreshAoiMemoryIndex(root, NOW + 1);
    expect(second.entries[0].status).toBe('archived');
  });

  it('self-heals when a memory is added or removed', () => {
    const root = makeRoot();
    writeMemory(root, { id: 'a' });
    expect(loadOrRefreshAoiMemoryIndex(root, NOW).entries.map((e) => e.id)).toEqual(['a']);

    writeMemory(root, { id: 'b', updatedAt: 999 });
    expect(
      loadOrRefreshAoiMemoryIndex(root, NOW + 1)
        .entries.map((e) => e.id)
        .sort(),
    ).toEqual(['a', 'b']);

    fs.rmSync(join(memoriesDir(root), 'a.json'));
    expect(loadOrRefreshAoiMemoryIndex(root, NOW + 2).entries.map((e) => e.id)).toEqual(['b']);
  });

  it('is idempotent: a reload with no on-disk change returns the same entries', () => {
    const root = makeRoot();
    writeMemory(root, { id: 'a', updatedAt: 1 });
    writeMemory(root, { id: 'b', updatedAt: 2 });
    const first = loadOrRefreshAoiMemoryIndex(root, NOW);
    const second = loadOrRefreshAoiMemoryIndex(root, NOW + 1);
    expect(second.entries.map((e) => e.id)).toEqual(first.entries.map((e) => e.id));
  });

  it('recovers from a corrupt index file by rebuilding', () => {
    const root = makeRoot();
    writeMemory(root, { id: 'a' });
    loadOrRefreshAoiMemoryIndex(root, NOW);
    // Corrupt the persisted index.
    fs.writeFileSync(join(root, 'aoi', 'memory-v2', 'index.json'), '{ not json', 'utf-8');
    const recovered = loadOrRefreshAoiMemoryIndex(root, NOW + 1);
    expect(recovered.entries.map((e) => e.id)).toEqual(['a']);
  });
});

describe('loadActiveAoiMemoriesViaIndex', () => {
  it('returns active bodies in recency order, skipping archived/superseded', () => {
    const root = makeRoot();
    writeMemory(root, { id: 'old', status: 'active', updatedAt: 1 });
    writeMemory(root, { id: 'new', status: 'active', updatedAt: 2 });
    writeMemory(root, { id: 'archived-1', status: 'archived', updatedAt: 3 });
    writeMemory(root, { id: 'superseded-1', status: 'superseded', updatedAt: 4 });
    expect(loadActiveAoiMemoriesViaIndex(root).map((m) => m.id)).toEqual(['new', 'old']);
  });

  it('falls back to the authoritative full scan when a candidate read throws', () => {
    const root = makeRoot();
    writeMemory(root, { id: 'a', status: 'active' });
    writeMemory(root, { id: 'archived-1', status: 'archived' });
    const spy = vi.spyOn(writer, 'loadServerAoiMemoriesByIds').mockImplementation(() => {
      throw new Error('read boom');
    });
    try {
      // Fallback = loadServerAoiMemories().filter(active) -> only the active memory.
      expect(loadActiveAoiMemoriesViaIndex(root).map((m) => m.id)).toEqual(['a']);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('rebuildAoiMemoryIndex + selectAoiMemoryIndexIds', () => {
  it('rebuilds from the authoritative files and selects recency-ordered candidate ids', () => {
    const root = makeRoot();
    writeMemory(root, { id: 'old', updatedAt: 1 });
    writeMemory(root, { id: 'new', updatedAt: 2 });
    writeMemory(root, { id: 'archived-1', status: 'archived', updatedAt: 3 });
    const index = rebuildAoiMemoryIndex(root, NOW);
    // Default active-only selection, recency desc.
    expect(selectAoiMemoryIndexIds(index, {}, ['active'])).toEqual(['new', 'old']);
    // Index-selected active ids match the full-scan active set (contract).
    const fullScanActive = loadServerAoiMemories(root)
      .filter((m) => m.status === 'active')
      .map((m) => m.id);
    expect(new Set(selectAoiMemoryIndexIds(index, {}, ['active']))).toEqual(
      new Set(fullScanActive),
    );
  });
});
