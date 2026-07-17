// @vitest-environment node
import * as fs from 'node:fs';
import * as os from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { loadAoiNonVoiceJarvisScorecardFromStores } from '../aoiNonVoiceJarvisScorecardServer';
import {
  AOI_NON_VOICE_REQUIRED_VALIDATION_COMMAND_IDS,
  resolveAoiNonVoiceValidationManifestPath,
} from '../aoiNonVoiceValidationManifest';
import { runAoiControlledRealFileExecutionHarness } from '../aoiControlledRealFileExecutionHarness';
import { saveAoiControlledRealFileEvidence } from '../aoiControlledRealFileEvidence';
import { recordAoiProactiveBriefFieldEvent } from '../aoiProactiveBriefStore';

const NOW = 1_800_000_000_000;
const SESSION_PATH = 'aoi/live';
const CODE_FINGERPRINT = 'd'.repeat(64);
const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'aoi-non-voice-server-'));
  tempRoots.push(root);
  return root;
}

function seedValidation(root: string): void {
  const filePath = resolveAoiNonVoiceValidationManifestPath(root, SESSION_PATH);
  fs.mkdirSync(dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      version: 1,
      sessionPath: SESSION_PATH,
      generatedAt: NOW,
      codeFingerprint: CODE_FINGERPRINT,
      commands: AOI_NON_VOICE_REQUIRED_VALIDATION_COMMAND_IDS.map((id, index) => ({
        id,
        passed: true,
        completedAt: NOW,
        evidenceRefs: [`command:${index + 1}`],
      })),
      supervisorRecoveryVerified: true,
      loopLockRecoveryVerified: true,
      evidenceRefs: ['validation:complete'],
      actionAuthority: 'display_only',
      mutationCount: 0,
    }),
    'utf8',
  );
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('Aoi non-voice scorecard server assembly', () => {
  it('accepts stored broad validation only when it matches the current code fingerprint', () => {
    const root = makeTempRoot();
    seedValidation(root);
    const matching = loadAoiNonVoiceJarvisScorecardFromStores({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      evidenceClass: 'live_field',
      configFile: join(root, 'config.json'),
      currentCodeFingerprint: CODE_FINGERPRINT,
      now: NOW,
    });
    const changed = loadAoiNonVoiceJarvisScorecardFromStores({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      evidenceClass: 'live_field',
      configFile: join(root, 'config.json'),
      currentCodeFingerprint: 'e'.repeat(64),
      now: NOW,
    });

    expect(matching.hardGates.find((item) => item.id === 'gate.broad_validation')?.passed).toBe(
      true,
    );
    expect(changed.hardGates.find((item) => item.id === 'gate.broad_validation')?.passed).toBe(
      false,
    );
  });

  it('credits current controlled-real success and recovery evidence but rejects stale code', () => {
    const root = makeTempRoot();
    fs.mkdirSync(join(root, SESSION_PATH), { recursive: true });
    const codeFingerprint = 'a'.repeat(64);
    saveAoiControlledRealFileEvidence({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      codeFingerprint,
      report: runAoiControlledRealFileExecutionHarness(NOW),
      now: NOW,
    });
    const current = loadAoiNonVoiceJarvisScorecardFromStores({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      evidenceClass: 'live_field',
      configFile: join(root, 'config.json'),
      currentCodeFingerprint: codeFingerprint,
      now: NOW,
    });
    const changed = loadAoiNonVoiceJarvisScorecardFromStores({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      evidenceClass: 'live_field',
      configFile: join(root, 'config.json'),
      currentCodeFingerprint: 'b'.repeat(64),
      now: NOW,
    });
    const currentAxis = current.axes.find((axis) => axis.id === 'action_validation_recovery');
    const changedAxis = changed.axes.find((axis) => axis.id === 'action_validation_recovery');
    expect(currentAxis?.sampleCount).toBe(3);
    expect(currentAxis?.blockers).not.toContain('controlled_real_execution_missing');
    expect(currentAxis?.blockers).not.toContain('verified_checkpoint_evidence_incomplete');
    expect(currentAxis?.blockers).not.toContain('verified_rollback_evidence_incomplete');
    expect(changedAxis?.blockers).toContain('controlled_real_execution_missing');
  });

  it('does not credit proactive field-event volume without real decisions or labels', () => {
    const root = makeTempRoot();
    for (let index = 0; index < 25; index += 1) {
      recordAoiProactiveBriefFieldEvent(root, {
        kind: 'shown_dashboard',
        sessionPath: SESSION_PATH,
        briefId: `brief-${index}`,
        topicId: `topic-${index}`,
        evidenceRefs: [`evidence:${index}`],
        dedupeKey: `dashboard:${index}`,
        createdAt: NOW - index,
      });
    }

    const scorecard = loadAoiNonVoiceJarvisScorecardFromStores({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      evidenceClass: 'live_field',
      configFile: join(root, 'config.json'),
      currentCodeFingerprint: CODE_FINGERPRINT,
      now: NOW,
    });
    const axis = scorecard.axes.find((item) => item.id === 'proactive_usefulness');

    expect(axis?.rawScore).toBe(0);
    expect(axis?.sampleCount).toBe(0);
    expect(axis?.blockers).toContain('unique_proactive_decisions_below_5');
  });
});
