import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { ingestAoiObservation } from '../aoiAutonomyObserver';
import { loadAoiRelationIndex } from '../aoiAutonomyRelations';
import { loadAoiObservationIndex, loadAoiObservations } from '../aoiAutonomyStore';

const SESSION_PATH = 'aoi/default';
const NOW = 1_800_000_000_000;
const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'aoi-autonomy-observer-test-'));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('Aoi autonomy observer', () => {
  it('deduplicates repeated observation ingest by stable key', () => {
    const root = makeTempRoot();

    const first = ingestAoiObservation(root, {
      source: 'research_run',
      sessionPath: SESSION_PATH,
      stableKey: 'research-001',
      createdAt: NOW,
      summary: 'Research completed.',
      artifactRefs: ['research:research-001/report'],
    });
    const second = ingestAoiObservation(root, {
      source: 'research_run',
      sessionPath: SESSION_PATH,
      stableKey: 'research-001',
      createdAt: NOW + 1000,
      summary: 'Research completed with updated summary.',
      artifactRefs: ['research:research-001/report'],
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.observation.id).toBe(first.observation.id);
    expect(loadAoiObservations(root, SESSION_PATH)).toHaveLength(1);
    expect(loadAoiObservations(root, SESSION_PATH)[0].summary).toContain('updated summary');
  });

  it('keeps the recent observation index bounded', () => {
    const root = makeTempRoot();

    for (let index = 0; index < 205; index += 1) {
      ingestAoiObservation(root, {
        source: 'app',
        sessionPath: SESSION_PATH,
        stableKey: `app-open-${index}`,
        createdAt: NOW + index,
        summary: `App session opened ${index}.`,
      });
    }

    const observationIndex = loadAoiObservationIndex(root, SESSION_PATH);
    const observations = loadAoiObservations(root, SESSION_PATH);
    expect(observationIndex.entries).toHaveLength(200);
    expect(observations).toHaveLength(200);
    expect(
      observations.some((observation) => observation.summary === 'App session opened 0.'),
    ).toBe(false);
  });

  it('rejects traversal session paths before writing observations', () => {
    const root = makeTempRoot();

    expect(() =>
      ingestAoiObservation(root, {
        source: 'app',
        sessionPath: '../escape',
        stableKey: 'bad',
        createdAt: NOW,
        summary: 'Should not write.',
      }),
    ).toThrow(/sessionPath/);
  });

  it('records relation links for observation evidence refs', () => {
    const root = makeTempRoot();

    const result = ingestAoiObservation(root, {
      source: 'proposal',
      sessionPath: SESSION_PATH,
      stableKey: 'decision-001',
      createdAt: NOW,
      summary: 'Aoi proposal accepted.',
      memoryIds: ['memory-001'],
      artifactRefs: ['research:run-001/report'],
      proposalIds: ['proposal-001'],
    });

    const relations = loadAoiRelationIndex(root, SESSION_PATH);
    expect(result.relationRecorded).toBe(true);
    expect(
      relations.nodes.some((node) => node.ref === `observation:${result.observation.id}`),
    ).toBe(true);
    expect(relations.nodes.some((node) => node.ref === 'memory:memory-001')).toBe(true);
    expect(relations.nodes.some((node) => node.ref === 'proposal:proposal-001')).toBe(true);
    expect(relations.edges.some((edge) => edge.kind === 'supports')).toBe(true);
  });

  it('does not fail observation ingest when relation writes fail', () => {
    const root = makeTempRoot();

    const result = ingestAoiObservation(
      root,
      {
        source: 'memory',
        sessionPath: SESSION_PATH,
        stableKey: 'memory-001',
        createdAt: NOW,
        summary: 'Memory refreshed.',
        memoryIds: ['memory-001'],
      },
      {
        recordRelations: () => {
          throw new Error('relation failure');
        },
      },
    );

    expect(result.created).toBe(true);
    expect(result.relationRecorded).toBe(false);
    expect(result.warnings).toContain('observation_relation_write_failed');
    expect(loadAoiObservations(root, SESSION_PATH)).toHaveLength(1);
  });
});
