// Aoi host-bridge desktop-activity store (wiring slice 4): the bounded, rolling,
// metadata-only store that accumulates foreground samples posted by the capture
// helper, so the summarizer can turn them into a taste signal.
//
// Safety posture:
//   - METADATA ONLY (the sample shape has no free-text body beyond an optional,
//     already-redacted window title); bounded to the last N samples on a 24h TTL.
//   - Machine-scoped under ~/.openroom/host-bridge/desktop-activity.json.
//   - Consent + the kill switch gate ingestion at the route; this is the data
//     layer only.
//
// Server-only (fs). The prune/append shaping is pure and exported for testing.
import * as fs from 'fs';
import { dirname, resolve } from 'path';
import { randomUUID } from 'crypto';
import {
  summarizeAoiDesktopActivity,
  type AoiDesktopActivitySample,
  type AoiDesktopActivitySummary,
} from './aoiHostDesktopActivity';

const HOST_BRIDGE_DIR = 'host-bridge';
const DESKTOP_ACTIVITY_FILE = 'desktop-activity.json';
const MAX_SAMPLES = 500;
const SAMPLE_TTL_MS = 24 * 60 * 60 * 1000;

interface AoiHostDesktopActivityStoreData {
  version: 1;
  samples: AoiDesktopActivitySample[];
  updatedAt: number;
}

function isSample(value: unknown): value is AoiDesktopActivitySample {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const sample = value as Partial<AoiDesktopActivitySample>;
  return (
    sample.version === 1 &&
    typeof sample.appName === 'string' &&
    sample.appName.length > 0 &&
    typeof sample.focused === 'boolean' &&
    typeof sample.idleMs === 'number' &&
    typeof sample.observedAt === 'number' &&
    sample.privacyState === 'metadata_only'
  );
}

// Keep only unexpired samples, newest-bounded. Pure.
export function pruneAoiHostDesktopActivitySamples(
  samples: readonly AoiDesktopActivitySample[],
  now: number,
): AoiDesktopActivitySample[] {
  return samples
    .filter((sample) => isSample(sample) && now - sample.observedAt < SAMPLE_TTL_MS)
    .sort((left, right) => left.observedAt - right.observedAt)
    .slice(-MAX_SAMPLES);
}

function resolveStorePath(openroomHome: string): string {
  return resolve(openroomHome, HOST_BRIDGE_DIR, DESKTOP_ACTIVITY_FILE);
}

function loadStore(openroomHome: string): AoiHostDesktopActivityStoreData {
  try {
    const filePath = resolveStorePath(openroomHome);
    if (!fs.existsSync(filePath)) {
      return { version: 1, samples: [], updatedAt: 0 };
    }
    const raw = JSON.parse(
      fs.readFileSync(filePath, 'utf-8'),
    ) as Partial<AoiHostDesktopActivityStoreData>;
    const samples = Array.isArray(raw.samples) ? raw.samples.filter(isSample) : [];
    return {
      version: 1,
      samples,
      updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
    };
  } catch {
    return { version: 1, samples: [], updatedAt: 0 };
  }
}

function saveStore(openroomHome: string, store: AoiHostDesktopActivityStoreData): void {
  const filePath = resolveStorePath(openroomHome);
  fs.mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(store, null, 2)}\n`, 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

// Append one normalized sample, prune, and persist. Returns the new sample count.
export function appendAoiHostDesktopActivitySample(
  openroomHome: string,
  sample: AoiDesktopActivitySample,
  now: number,
): number {
  const store = loadStore(openroomHome);
  const samples = pruneAoiHostDesktopActivitySamples([...store.samples, sample], now);
  saveStore(openroomHome, { version: 1, samples, updatedAt: now });
  return samples.length;
}

// Build the foreground-usage summary from the stored samples (pruned).
export function loadAoiHostDesktopActivitySummary(
  openroomHome: string,
  now: number,
): AoiDesktopActivitySummary {
  const store = loadStore(openroomHome);
  const samples = pruneAoiHostDesktopActivitySamples(store.samples, now);
  return summarizeAoiDesktopActivity(samples, now);
}
