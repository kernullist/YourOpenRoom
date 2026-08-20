// Aoi browser-drive audit observer + artifact writer (P2.4b): the capture half of
// the step audit. It plugs into the P2.2b executor's `observer` seam -- the executor
// calls onStep(before) right before a step and onStep(after) right after -- and,
// because it closes over the live session page, it screenshots the page and grabs
// the DOM at each phase, writes those large bytes to disk, and returns small REFS.
// The runner then records those refs plus the step outcome into the P2.4a ledger.
//
// Capture is BEST-EFFORT: a screenshot/DOM/write failure never throws (the executor
// already treats a throwing observer as a no-op), so auditing can never block or
// fail a driven step. Server-only (fs) via an injected writer, so the observer logic
// is unit-testable with a fake page + fake writer.

import * as fs from 'fs';
import { dirname, resolve, sep } from 'path';
import type {
  AoiBrowserDriveActablePage,
  AoiBrowserDriveObservation,
  AoiBrowserDriveObserver,
} from './aoiBrowserDriveExecutor';

const HOST_BRIDGE_DIR = 'host-bridge';
const ARTIFACT_DIR = 'browser-drive-artifacts';

export type AoiBrowserDriveArtifactWriter = (
  relPath: string,
  data: Uint8Array | string,
) => Promise<void> | void;

// Screenshot + DOM subset used here (a subset of AoiBrowserDriveActablePage).
type CapturablePage = Pick<AoiBrowserDriveActablePage, 'screenshot' | 'content'>;

function sanitizeSegment(value: string): string {
  // Strip everything but word chars + hyphen (dots too, so no ".." can survive in
  // the runId segment); the ".png"/".html" extension is appended AFTER this.
  return value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || 'x';
}

/**
 * Build an audit observer bound to a specific session page + run. Each phase writes
 * `<runId>/step-<index>-<phase>.png` and `.html` via the injected writer and returns
 * their refs. Any failure yields undefined refs (best-effort, never throws).
 */
export function makeAoiBrowserDriveAuditObserver(params: {
  page: CapturablePage;
  runId: string;
  writeArtifact: AoiBrowserDriveArtifactWriter;
}): AoiBrowserDriveObserver {
  const runId = sanitizeSegment(params.runId);
  return {
    onStep: async ({ stepIndex, phase }): Promise<AoiBrowserDriveObservation | void> => {
      const base = `${runId}/step-${stepIndex}-${phase}`;
      const observation: AoiBrowserDriveObservation = {};
      try {
        const bytes = await params.page.screenshot({});
        const ref = `${base}.png`;
        await params.writeArtifact(ref, bytes);
        observation.screenshotRef = ref;
      } catch {
        // best-effort screenshot
      }
      try {
        const dom = await params.page.content();
        const ref = `${base}.html`;
        await params.writeArtifact(ref, dom);
        observation.domRef = ref;
      } catch {
        // best-effort DOM
      }
      return observation.screenshotRef || observation.domRef ? observation : undefined;
    },
  };
}

// --- Production artifact persistence (server-only fs) -------------------------

export function resolveAoiBrowserDriveArtifactDir(openroomHome: string): string {
  return resolve(openroomHome, HOST_BRIDGE_DIR, ARTIFACT_DIR);
}

// Write one artifact under host-bridge/browser-drive-artifacts/<relPath>. The
// relPath is confined to that directory (path traversal in a segment is sanitized
// by the observer's runId/index/phase construction). Creates parent dirs.
export function writeAoiBrowserDriveArtifact(
  openroomHome: string,
  relPath: string,
  data: Uint8Array | string,
): void {
  const root = resolveAoiBrowserDriveArtifactDir(openroomHome);
  const target = resolve(root, relPath);
  // Containment: never write outside the artifact root.
  //
  // THROW rather than return. Returning quietly meant the caller carried on and
  // recorded an artifact ref in the ledger for a file that was never written --
  // a ledger pointing at evidence that does not exist is worse than a ledger
  // that says the capture failed, and the observer already treats a throw as a
  // failed capture and omits the ref.
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`refusing to write an artifact outside ${root}`);
  }
  fs.mkdirSync(dirname(target), { recursive: true });
  fs.writeFileSync(target, data);
}
