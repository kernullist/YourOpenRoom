import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  pruneAoiHostSpawnAuditEntries,
  recordAoiHostSpawnedProcess,
  loadAoiHostSpawnedPids,
  type AoiHostSpawnAuditEntry,
} from '../aoiHostSpawnAudit';

const TTL_MS = 12 * 60 * 60 * 1000;

describe('aoiHostSpawnAudit', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'aoi-spawn-audit-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  describe('pruneAoiHostSpawnAuditEntries', () => {
    it('drops expired entries and keeps unexpired ones', () => {
      const now = 100_000_000;
      const fresh: AoiHostSpawnAuditEntry = { pid: 10, imageName: 'a.exe', spawnedAt: now - 1000 };
      const stale: AoiHostSpawnAuditEntry = {
        pid: 11,
        imageName: 'b.exe',
        spawnedAt: now - (TTL_MS + 1),
      };
      expect(pruneAoiHostSpawnAuditEntries([fresh, stale], now).map((e) => e.pid)).toEqual([10]);
    });

    it('keeps only the newest entry per pid', () => {
      const now = 100_000_000;
      const older: AoiHostSpawnAuditEntry = {
        pid: 20,
        imageName: 'old.exe',
        spawnedAt: now - 5000,
      };
      const newer: AoiHostSpawnAuditEntry = {
        pid: 20,
        imageName: 'new.exe',
        spawnedAt: now - 1000,
      };
      const pruned = pruneAoiHostSpawnAuditEntries([older, newer], now);
      expect(pruned).toHaveLength(1);
      expect(pruned[0].imageName).toBe('new.exe');
    });

    it('rejects malformed entries', () => {
      const now = 100_000_000;
      const good: AoiHostSpawnAuditEntry = { pid: 30, imageName: 'ok.exe', spawnedAt: now };
      const negative = { pid: -1, imageName: 'x', spawnedAt: now } as AoiHostSpawnAuditEntry;
      const missing = { pid: 31, spawnedAt: now } as unknown as AoiHostSpawnAuditEntry;
      expect(
        pruneAoiHostSpawnAuditEntries([good, negative, missing], now).map((e) => e.pid),
      ).toEqual([30]);
    });

    it('caps to the newest MAX_ENTRIES', () => {
      const now = 100_000_000;
      const entries: AoiHostSpawnAuditEntry[] = Array.from({ length: 300 }, (_, i) => ({
        pid: i + 1,
        imageName: `p${i}.exe`,
        spawnedAt: now - (300 - i),
      }));
      const pruned = pruneAoiHostSpawnAuditEntries(entries, now);
      expect(pruned).toHaveLength(256);
      expect(pruned[pruned.length - 1].pid).toBe(300);
    });
  });

  describe('record + load round-trip', () => {
    it('records a spawned pid and reads it back', () => {
      const now = 100_000_000;
      recordAoiHostSpawnedProcess(home, { pid: 4242, imageName: 'C:\\tools\\notepad.exe' }, now);
      expect(loadAoiHostSpawnedPids(home, now)).toEqual([4242]);
    });

    it('normalizes the recorded image to a basename', () => {
      const now = 100_000_000;
      recordAoiHostSpawnedProcess(home, { pid: 5, imageName: 'C:\\a\\b\\thing.exe' }, now);
      const raw = JSON.parse(
        fs.readFileSync(join(home, 'host-bridge', 'spawn-audit.json'), 'utf-8'),
      );
      expect(raw.entries[0].imageName).toBe('thing.exe');
    });

    it('ignores a non-positive pid (nothing to reclaim)', () => {
      const now = 100_000_000;
      recordAoiHostSpawnedProcess(home, { pid: 0, imageName: 'x.exe' }, now);
      recordAoiHostSpawnedProcess(home, { pid: -3, imageName: 'y.exe' }, now);
      expect(loadAoiHostSpawnedPids(home, now)).toEqual([]);
    });

    it('does not return expired pids on load', () => {
      const now = 100_000_000;
      recordAoiHostSpawnedProcess(home, { pid: 77, imageName: 'z.exe' }, now - (TTL_MS + 1));
      expect(loadAoiHostSpawnedPids(home, now)).toEqual([]);
    });

    it('returns an empty set for an absent store', () => {
      expect(loadAoiHostSpawnedPids(home, 1)).toEqual([]);
    });

    it('accumulates multiple distinct pids', () => {
      const now = 100_000_000;
      recordAoiHostSpawnedProcess(home, { pid: 1, imageName: 'one.exe' }, now - 200);
      recordAoiHostSpawnedProcess(home, { pid: 2, imageName: 'two.exe' }, now - 100);
      expect(loadAoiHostSpawnedPids(home, now).sort((a, b) => a - b)).toEqual([1, 2]);
    });
  });
});
