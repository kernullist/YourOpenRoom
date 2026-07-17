// @vitest-environment node
import * as fs from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { runAoiControlledRealFileExecutionHarness } from '../aoiControlledRealFileExecutionHarness';
import {
  loadAoiControlledRealFileEvidence,
  saveAoiControlledRealFileEvidence,
} from '../aoiControlledRealFileEvidence';

const SESSION_PATH = 'aoi/live';
const NOW = 1_800_000_000_000;
const CODE_FINGERPRINT = 'a'.repeat(64);
const tempRoots: string[] = [];

function makeRoot(): string {
  const root = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'aoi-controlled-evidence-')));
  tempRoots.push(root);
  fs.mkdirSync(join(root, 'aoi', 'live'), { recursive: true });
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('controlled-real file evidence store', () => {
  it('round-trips only a passing, session-bound, code-bound report', () => {
    const root = makeRoot();
    const report = runAoiControlledRealFileExecutionHarness(NOW);
    const saved = saveAoiControlledRealFileEvidence({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      codeFingerprint: CODE_FINGERPRINT,
      report,
      now: NOW,
    });
    const loaded = loadAoiControlledRealFileEvidence(root, SESSION_PATH);
    expect(loaded).toEqual(saved);
    expect(loaded?.report.passedScenarioCount).toBe(4);
    const replaced = saveAoiControlledRealFileEvidence({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      codeFingerprint: CODE_FINGERPRINT,
      report,
      now: NOW + 1,
    });
    expect(loadAoiControlledRealFileEvidence(root, SESSION_PATH)).toEqual(replaced);
    expect(loadAoiControlledRealFileEvidence(root, 'aoi/other')).toBeNull();
  });

  it('rejects a report that does not pass all controlled-real scenarios', () => {
    const root = makeRoot();
    const report = runAoiControlledRealFileExecutionHarness(NOW);
    expect(() =>
      saveAoiControlledRealFileEvidence({
        sessionsDir: root,
        sessionPath: SESSION_PATH,
        codeFingerprint: CODE_FINGERPRINT,
        report: { ...report, passed: false },
        now: NOW,
      }),
    ).toThrow(/did not pass validation/i);
  });
});
