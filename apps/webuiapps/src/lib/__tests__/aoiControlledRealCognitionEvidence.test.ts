import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { runAoiControlledRealCognitionHarness } from '../aoiControlledRealCognitionHarness';
import {
  loadAoiControlledRealCognitionEvidence,
  resolveAoiControlledRealCognitionEvidencePath,
  saveAoiControlledRealCognitionEvidence,
} from '../aoiControlledRealCognitionEvidence';
import {
  AOI_CONTROLLED_COGNITION_EXIT_RUN_ERROR,
  runAoiControlledRealCognitionEvidenceCli,
} from '../aoiControlledRealCognitionEvidenceCli';

const SESSION_PATH = 'aoi/default';
const NOW = 1_800_000_000_000;
const CODE_FINGERPRINT = 'a'.repeat(64);
const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'aoi-controlled-cognition-evidence-'));
  tempRoots.push(root);
  fs.mkdirSync(join(root, 'aoi', 'default'), { recursive: true });
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('Aoi controlled-real cognition evidence', () => {
  it('persists a session-bound self-validating report and reloads it', async () => {
    const root = makeTempRoot();
    const report = await runAoiControlledRealCognitionHarness(NOW);
    const saved = saveAoiControlledRealCognitionEvidence({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      codeFingerprint: CODE_FINGERPRINT,
      report,
      now: NOW,
    });

    expect(saved).toMatchObject({
      sessionPath: SESSION_PATH,
      codeFingerprint: CODE_FINGERPRINT,
      writeAuthority: 'operator_invoked_controlled_real',
    });
    expect(loadAoiControlledRealCognitionEvidence(root, SESSION_PATH)).toEqual(saved);
    expect(loadAoiControlledRealCognitionEvidence(root, 'aoi/other')).toBeNull();
  });

  it('rejects a forged pass when grounded cognition is below 85', async () => {
    const root = makeTempRoot();
    const report = await runAoiControlledRealCognitionHarness(NOW);
    saveAoiControlledRealCognitionEvidence({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      codeFingerprint: CODE_FINGERPRINT,
      report,
      now: NOW,
    });
    const filePath = resolveAoiControlledRealCognitionEvidencePath(root, SESSION_PATH);
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
      report: { scenarios: Array<Record<string, unknown>> };
    };
    const grounded = raw.report.scenarios.find(
      (scenario) => scenario.id === 'consented_grounded_situation',
    );
    if (!grounded) {
      throw new Error('Missing grounded scenario.');
    }
    grounded.cognitionScore = 84;
    grounded.passed = true;
    fs.writeFileSync(filePath, JSON.stringify(raw), 'utf8');

    expect(loadAoiControlledRealCognitionEvidence(root, SESSION_PATH)).toBeNull();
  });

  it('fails closed when required CLI authority arguments are missing', async () => {
    const errors: string[] = [];
    const exitCode = await runAoiControlledRealCognitionEvidenceCli({
      argv: [],
      logError: (message) => errors.push(message),
      now: NOW,
    });
    expect(exitCode).toBe(AOI_CONTROLLED_COGNITION_EXIT_RUN_ERROR);
    expect(errors[0]).toContain('--sessions-dir');
  });
});
