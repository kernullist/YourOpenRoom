// @vitest-environment node
import * as fs from 'node:fs';
import * as os from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  AOI_CONTROLLED_REAL_EXIT_PASSED,
  AOI_CONTROLLED_REAL_EXIT_RUN_ERROR,
  runAoiControlledRealFileEvidenceCli,
} from '../aoiControlledRealFileEvidenceCli';
import { loadAoiControlledRealFileEvidence } from '../aoiControlledRealFileEvidence';

const SESSION_PATH = 'aoi/live';
const tempRoots: string[] = [];

function makeRoot(): string {
  const root = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'aoi-controlled-cli-')));
  tempRoots.push(root);
  fs.mkdirSync(join(root, 'aoi', 'live'), { recursive: true });
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('controlled-real file evidence CLI', () => {
  it('fails closed when required explicit paths are missing', () => {
    const errors: string[] = [];
    const exitCode = runAoiControlledRealFileEvidenceCli({
      argv: [],
      logError: (message) => errors.push(message),
    });
    expect(exitCode).toBe(AOI_CONTROLLED_REAL_EXIT_RUN_ERROR);
    expect(errors.join('\n')).toContain('--sessions-dir');
  });

  it('runs the disposable harness and records code-bound evidence', () => {
    const root = makeRoot();
    const logs: string[] = [];
    const exitCode = runAoiControlledRealFileEvidenceCli({
      argv: [
        '--sessions-dir',
        root,
        '--session-path',
        SESSION_PATH,
        '--workspace-root',
        resolve(process.cwd(), '..', '..'),
      ],
      log: (message) => logs.push(message),
      now: 1_800_000_000_000,
    });
    expect(exitCode).toBe(AOI_CONTROLLED_REAL_EXIT_PASSED);
    expect(logs.join('\n')).toContain('PASSED');
    const evidence = loadAoiControlledRealFileEvidence(root, SESSION_PATH);
    expect(evidence?.report.passedScenarioCount).toBe(4);
    expect(evidence?.codeFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });
});
