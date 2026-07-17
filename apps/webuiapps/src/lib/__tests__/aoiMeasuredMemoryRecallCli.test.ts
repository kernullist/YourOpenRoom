// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  AOI_MEASURED_RECALL_EXIT_INPUT,
  AOI_MEASURED_RECALL_EXIT_OK,
  parseAoiMeasuredMemoryRecallCliOptions,
  runAoiMeasuredMemoryRecallCli,
  type AoiMeasuredMemoryRecallCliDeps,
  type AoiMeasuredMemoryRecallCliReport,
} from '../aoiMeasuredMemoryRecallCli';

function makeReport(): AoiMeasuredMemoryRecallCliReport {
  return {
    version: 1,
    trial: {
      version: 1,
      id: 'aoi-recall-trial-test',
      sessionPath: 'aoi/space_adventure',
      createdAt: 10_000,
      queryFingerprint: 'a'.repeat(64),
      retrievalPath: 'local_semantic',
      candidateCount: 3,
      selectedMemoryIds: ['memory-1'],
      expectedMemoryIds: ['memory-1'],
      hitMemoryIds: ['memory-1'],
      success: true,
      evidenceRefs: ['memory-recall-trial:aoi-recall-trial-test', 'memory:memory-1'],
      privacyState: 'metadata_only',
      actionAuthority: 'display_only',
      mutationCount: 0,
    },
    providerModel: 'aoi-local-hash-embedding-v1',
    embeddedCount: 3,
    pendingCount: 0,
  };
}

function makeDeps(over: Partial<AoiMeasuredMemoryRecallCliDeps> = {}): {
  deps: AoiMeasuredMemoryRecallCliDeps;
  logs: string[];
  errors: string[];
} {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    deps: {
      argv: [
        '--sessions-dir',
        'C:/sessions',
        '--session-path',
        'aoi/space_adventure',
        '--query',
        'Which answer depth does the user prefer?',
        '--expected-memory-ids',
        'memory-1,memory-2',
        '--limit',
        '3',
        '--local-embedder',
        '--embed-pending',
      ],
      env: {},
      runMeasurement: vi.fn(async () => makeReport()),
      log: (message) => logs.push(message),
      logError: (message) => errors.push(message),
      ...over,
    },
  };
}

describe('Aoi measured memory recall CLI', () => {
  it('parses explicit provenance, expected IDs, and local embedding controls', () => {
    const options = parseAoiMeasuredMemoryRecallCliOptions(makeDeps().deps.argv, {});
    expect(options).toEqual({
      sessionsDir: 'C:/sessions',
      sessionPath: 'aoi/space_adventure',
      query: 'Which answer depth does the user prefer?',
      expectedMemoryIds: ['memory-1', 'memory-2'],
      limit: 3,
      localEmbedder: true,
      embedPending: true,
    });
  });

  it('records a metadata-only measured result through the injected runner', async () => {
    const { deps, logs, errors } = makeDeps();
    expect(await runAoiMeasuredMemoryRecallCli(deps)).toBe(AOI_MEASURED_RECALL_EXIT_OK);
    expect(deps.runMeasurement).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionPath: 'aoi/space_adventure',
        expectedMemoryIds: ['memory-1', 'memory-2'],
        localEmbedder: true,
        embedPending: true,
      }),
      {},
    );
    expect(logs.some((line) => line.includes('trial HIT'))).toBe(true);
    expect(errors).toEqual([]);
  });

  it('fails closed before measurement when expected IDs or query are absent', async () => {
    const runMeasurement = vi.fn(async () => makeReport());
    const { deps, errors } = makeDeps({
      argv: ['--sessions-dir', 'C:/sessions', '--session-path', 'aoi/work'],
      runMeasurement,
    });
    expect(await runAoiMeasuredMemoryRecallCli(deps)).toBe(AOI_MEASURED_RECALL_EXIT_INPUT);
    expect(runMeasurement).not.toHaveBeenCalled();
    expect(errors[0]).toMatch(/required/i);
  });
});
