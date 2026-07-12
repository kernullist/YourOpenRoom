// @vitest-environment node
// SA5.3: the situational-awareness roadmap's measurable Definition of Done,
// proven end-to-end against the REAL stores and the REAL autonomy tick (no
// LLM, no network):
//   1. An arbitrary session produces an evidence-cited current-situation
//      brief (every segment carries evidenceRefs).
//   2. Proactive proposals cite the live context they were authored under.
//   3. The cognition-readiness scorecard computes from real stores and the
//      seeded live flow reaches the target band (grounded+ with zero
//      hard-gate violations; this flow reaches live_grounded, score >= 85).
// Privacy invariants are asserted on the persisted artifacts themselves:
// metadata only -- action params/content never reach any store.
import * as fs from 'fs';
import * as os from 'os';
import { dirname, join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { runAoiAutonomyTick } from '../aoiAutonomyEngine';
import {
  loadAoiActiveProposals,
  saveAoiAutonomyPolicy,
  updateAoiEnvironmentSource,
} from '../aoiAutonomyStore';
import { recordAoiActivityEvent } from '../aoiActivityStream';
import { loadAoiIntentState } from '../aoiIntentInference';
import {
  countAoiCurrentSituationHistory,
  loadAoiCurrentSituation,
} from '../aoiCurrentSituationModel';
import { buildAoiServerCognitionReadinessScorecard } from '../aoiCognitionReadinessServer';
import { buildAoiServerJarvisReadinessScorecard } from '../aoiServerJarvisGovernor';
import { buildAoiResearchArtifactPaths, type AoiResearchManifest } from '../aoiResearchTypes';

const SESSION_PATH = 'aoi/default';
const NOW = 1_800_000_000_000;
const MINUTE = 60 * 1000;
const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'aoi-sa-acceptance-'));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

function seedResearchManifest(root: string): void {
  const id = 'aoi-research-done-001';
  const manifest: AoiResearchManifest = {
    version: 1,
    id,
    sessionPath: SESSION_PATH,
    request: 'Windows kernel driver security research',
    mode: 'standard',
    language: 'ko',
    recency: 'month',
    maxSources: 12,
    createdAt: NOW - 10 * MINUTE,
    updatedAt: NOW - 5 * MINUTE,
    completedAt: NOW - 5 * MINUTE,
    status: 'completed',
    phase: 'completed',
    statusMessage: 'completed',
    sourceCounts: { planned: 10, candidates: 10, accepted: 6, failed: 0 },
    artifactPaths: buildAoiResearchArtifactPaths(id),
    artifactAvailability: { manifest: true, report: true, sources: false, evidence: false },
    reportTitle: 'Windows kernel driver security research',
    claimCount: 4,
  };
  writeJson(join(root, SESSION_PATH, 'aoi-research', 'runs', id, 'manifest.json'), manifest);
}

describe('situational-awareness Definition of Done (SA5.3)', () => {
  it('grounds, cites, and measures a live session end-to-end', async () => {
    const root = makeTempRoot();

    // --- Operator setup: enable autonomy + consent the live activity source.
    saveAoiAutonomyPolicy(
      root,
      SESSION_PATH,
      { enabled: true, previewMode: true, level: 'L4' },
      NOW,
    );
    updateAoiEnvironmentSource(root, SESSION_PATH, {
      sourceId: 'app-activity',
      patch: {
        enabled: true,
        consentReason: 'User enabled live activity awareness for this session.',
        lastReviewedAt: NOW,
      },
      now: NOW,
    });
    seedResearchManifest(root);

    // --- Live signals: real capture through the consent-gated ledger. The
    // malicious payload is rejected by the metadata-only validation and the
    // params of the valid one never reach any store.
    expect(
      recordAoiActivityEvent(root, SESSION_PATH, { kind: 'keylog', appId: 'musicapp' }, NOW)
        .recorded,
    ).toBe(false);
    recordAoiActivityEvent(root, SESSION_PATH, { kind: 'app_opened', appId: 'musicapp' }, NOW);
    recordAoiActivityEvent(
      root,
      SESSION_PATH,
      {
        kind: 'app_action',
        appId: 'musicapp',
        actionType: 'PLAY_TRACK',
        params: { secret: 'PRIVATE-BODY-MARKER' },
        observedAt: NOW + MINUTE,
      } as never,
      NOW + MINUTE,
    );

    // --- Three real wakeups (the grounding-practice cadence).
    for (const tickNow of [NOW + 2 * MINUTE, NOW + 6 * MINUTE, NOW + 10 * MINUTE]) {
      await runAoiAutonomyTick({
        sessionsDir: root,
        sessionPath: SESSION_PATH,
        reason: 'manual',
        latestUserMessage: 'Windows kernel driver security research 다시 보여줘',
        now: tickNow,
      });
    }
    const finalNow = NOW + 10 * MINUTE;

    // --- Done 1: an evidence-cited current-situation brief exists.
    const situation = loadAoiCurrentSituation(root, SESSION_PATH);
    expect(situation).not.toBeNull();
    expect(situation!.staleAt).toBeGreaterThan(finalNow);
    expect(situation!.segments.length).toBeGreaterThanOrEqual(3);
    expect(situation!.segments.every((segment) => segment.evidenceRefs.length > 0)).toBe(true);
    expect(situation!.segments.map((segment) => segment.kind)).toEqual(
      expect.arrayContaining(['activity', 'intent', 'conversation', 'research']),
    );
    expect(situation!.headline).toContain('active app musicapp');
    const intentState = loadAoiIntentState(root, SESSION_PATH);
    expect(intentState?.current?.evidenceRefs.length ?? 0).toBeGreaterThan(0);

    // --- Done 2: proactive proposals cite the live context.
    const proposals = loadAoiActiveProposals(root, SESSION_PATH);
    expect(proposals.length).toBeGreaterThan(0);
    for (const proposal of proposals) {
      expect(
        proposal.evidenceRefs.some(
          (ref) => ref.startsWith('situation:') || ref.startsWith('activity:'),
        ),
      ).toBe(true);
    }

    // --- Done 3: cognition readiness computes from real stores and reaches
    // the target band with zero hard-gate violations.
    const scorecard = buildAoiServerCognitionReadinessScorecard({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      now: finalNow,
    });
    expect(scorecard.gates.every((gate) => !gate.blocked)).toBe(true);
    expect(scorecard.canSupportPromotion).toBe(true);
    expect(['grounded', 'live_grounded']).toContain(scorecard.level);
    expect(scorecard.level).toBe('live_grounded');
    expect(scorecard.score).toBeGreaterThanOrEqual(85);
    expect(countAoiCurrentSituationHistory(root, SESSION_PATH)).toBeGreaterThanOrEqual(3);

    // The trust ladder consumes grounding as a PASS gate here (tighten-only).
    const jarvis = buildAoiServerJarvisReadinessScorecard({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      now: finalNow,
    });
    expect(jarvis.gates.find((gate) => gate.id === 'gate.cognition_grounding')).toMatchObject({
      status: 'pass',
    });

    // --- Privacy invariants on the PERSISTED artifacts: metadata only.
    const persisted = [
      JSON.stringify(situation),
      JSON.stringify(intentState),
      JSON.stringify(proposals),
      fs.readFileSync(
        join(root, SESSION_PATH, 'aoi-autonomy', 'activity', 'events.jsonl'),
        'utf-8',
      ),
    ].join('\n');
    expect(persisted).not.toContain('PRIVATE-BODY-MARKER');
    expect(persisted).not.toContain('keylog');
  });
});
