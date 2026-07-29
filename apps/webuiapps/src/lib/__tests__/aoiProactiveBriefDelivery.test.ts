import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_AOI_AUTONOMY_POLICY } from '../aoiAutonomyPolicy';
import type {
  AoiAutonomyPolicy,
  AoiInterestProfile,
  AoiInterestTopic,
  AoiProactiveBriefCandidate,
} from '../aoiAutonomyTypes';
import { decideAoiProactiveBriefDelivery } from '../aoiProactiveBriefPolicy';
import { applyAoiProactiveBriefFeedbackAction } from '../aoiProactiveBriefFeedback';
import {
  loadAoiInterestProfile,
  loadAoiProactiveBriefCalibrationInbox,
  loadAoiProactiveBriefCalibrationTuning,
  loadAoiProactiveBriefCandidates,
  loadAoiProactiveBriefCooldownState,
  loadAoiProactiveBriefFieldEvents,
  loadAoiProactiveBriefFeedback,
  recordAoiProactiveBriefCalibrationLabel,
  recordAoiProactiveBriefDeliveryFieldEvents,
  saveAoiInterestProfile,
  upsertAoiProactiveBriefCandidate,
  upsertAoiProactiveBriefCooldown,
} from '../aoiProactiveBriefStore';
import { buildAoiProactiveBriefPanelModel } from '../aoiProactiveBriefUi';

const tempRoots: string[] = [];
const SESSION_PATH = 'aoi/default';
const NOW = Date.parse('2026-06-19T00:00:00.000Z');

function makeTempRoot(): string {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'aoi-proactive-brief-delivery-test-'));
  tempRoots.push(root);
  return root;
}

function makePolicy(partial: Partial<AoiAutonomyPolicy> = {}): AoiAutonomyPolicy {
  return {
    ...DEFAULT_AOI_AUTONOMY_POLICY,
    enabled: true,
    proactiveSuggestionsEnabled: true,
    confidenceFloor: 0.5,
    defaultCooldownMs: 6 * 60 * 60 * 1000,
    updatedAt: NOW,
    ...partial,
  };
}

function makeTopic(partial: Partial<AoiInterestTopic> = {}): AoiInterestTopic {
  return {
    version: 1,
    id: partial.id ?? 'aoi-interest-re',
    sessionPath: partial.sessionPath ?? SESSION_PATH,
    label: partial.label ?? 'Reverse Engineering',
    normalizedLabel: partial.normalizedLabel ?? 'reverse engineering',
    aliases: partial.aliases ?? ['RE', 'reversing'],
    source: partial.source ?? 'memory',
    memoryIds: partial.memoryIds ?? ['memory-re-001'],
    evidenceRefs: partial.evidenceRefs ?? ['memory:memory-re-001'],
    confidence: partial.confidence ?? 0.86,
    importance: partial.importance ?? 0.82,
    noveltyPreference: partial.noveltyPreference ?? 0.72,
    currentInfoPreference: partial.currentInfoPreference ?? 0.9,
    muted: partial.muted ?? false,
    pinned: partial.pinned ?? true,
    cooldownKey: partial.cooldownKey ?? 'interest:reverse-engineering',
    createdAt: partial.createdAt ?? NOW - 1000,
    updatedAt: partial.updatedAt ?? NOW - 500,
  };
}

function makeProfile(topic: AoiInterestTopic = makeTopic()): AoiInterestProfile {
  return {
    version: 1,
    sessionPath: SESSION_PATH,
    topics: [topic],
    generatedAt: NOW,
    sourceMemoryCount: 1,
    warnings: [],
  };
}

function makeCandidate(
  partial: Partial<AoiProactiveBriefCandidate> = {},
): AoiProactiveBriefCandidate {
  return {
    version: 1,
    id: partial.id ?? 'aoi-brief-delivery-test',
    sessionPath: partial.sessionPath ?? SESSION_PATH,
    topicId: partial.topicId ?? 'aoi-interest-re',
    topicLabel: partial.topicLabel ?? 'Reverse Engineering',
    status: partial.status ?? 'candidate',
    title: partial.title ?? 'Fresh reverse engineering writeup',
    hook: partial.hook ?? 'A fresh reverse engineering writeup matches your saved interests.',
    summary: partial.summary ?? 'A public source discusses a new reversing workflow.',
    whyForOperator:
      partial.whyForOperator ?? 'It matches saved RE and Windows internals interests.',
    noveltyReason: partial.noveltyReason ?? 'The source was not in earlier brief evidence.',
    sources: partial.sources ?? [
      {
        title: 'Fresh reverse engineering writeup',
        url: 'https://research.example.com/re/writeup',
        host: 'research.example.com',
        publishedAt: '2026-06-18T00:00:00.000Z',
        retrievedAt: NOW,
        snippet: 'Public source snippet for the reversing writeup.',
      },
    ],
    evidenceRefs: partial.evidenceRefs ?? ['source:research.example.com'],
    memoryIds: partial.memoryIds ?? ['memory-re-001'],
    ...(partial.researchRunId !== undefined ? { researchRunId: partial.researchRunId } : {}),
    score: partial.score ?? 0.86,
    confidence: partial.confidence ?? 0.89,
    risk: partial.risk ?? 'low',
    freshness: partial.freshness ?? {
      searchedAt: NOW,
      newestSourceAt: '2026-06-18T00:00:00.000Z',
      cannotKnow: ['Aoi cannot know whether the source changed after retrieval.'],
    },
    delivery: partial.delivery ?? {
      allowedModes: ['dashboard', 'digest', 'inline_card', 'chat_hook'],
    },
    cooldownKey: partial.cooldownKey ?? 'interest:reverse-engineering',
    ...(partial.dedupeKey !== undefined ? { dedupeKey: partial.dedupeKey } : {}),
    createdAt: partial.createdAt ?? NOW,
    updatedAt: partial.updatedAt ?? NOW,
    expiresAt: partial.expiresAt ?? NOW + 24 * 60 * 60 * 1000,
  };
}

function saveProfileAndCandidate(
  root: string,
  candidate: AoiProactiveBriefCandidate = makeCandidate(),
  topic: AoiInterestTopic = makeTopic(),
): void {
  saveAoiInterestProfile(root, SESSION_PATH, makeProfile(topic), NOW);
  upsertAoiProactiveBriefCandidate(root, candidate, NOW);
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('Aoi proactive brief delivery policy', () => {
  it('keeps the compact candidate visible but suppresses direct chat in quiet mode', () => {
    const candidate = makeCandidate();
    const decision = decideAoiProactiveBriefDelivery({
      candidate,
      policy: makePolicy(),
      profile: makeProfile(),
      feedback: [],
      cooldownState: null,
      context: {
        now: NOW,
        quietMode: true,
        directChatOptIn: true,
      },
    });

    expect(decision.compactCardVisible).toBe(true);
    expect(decision.chatHook.allowed).toBe(false);
    expect(decision.chatHook.reasons).toContain('quiet_mode_suppresses_chat_hook');
    expect(decision.ladder.selectedLane).toBe('digest');
    expect(decision.ladder.steps.direct_chat.allowed).toBe(false);
    expect(decision.ladder.steps.direct_chat.reasons).toContain('quiet_mode_suppresses_chat_hook');
    expect(decision.ladder.steps.execute_after_approval.allowed).toBe(false);
    expect(decision.ladder.actionAuthority).toBe('display_only');
    expect(decision.ladder.mutationCount).toBe(0);
  });

  it('speaks the chat hook in the companion register when a voice is supplied', () => {
    const base = {
      candidate: { ...makeCandidate(), mediaBucket: 'read' as const },
      policy: makePolicy(),
      profile: makeProfile(),
      feedback: [],
      cooldownState: null,
      context: {
        now: NOW,
        quietMode: false,
        directChatOptIn: true,
      },
    };
    const withoutVoice = decideAoiProactiveBriefDelivery(base);
    const withVoice = decideAoiProactiveBriefDelivery({ ...base, voice: { lang: 'ko' } });

    expect(withoutVoice.chatHook.allowed).toBe(true);
    expect(withoutVoice.chatHook.text).toContain('Open the brief if you want the sources.');

    expect(withVoice.chatHook.allowed).toBe(true);
    expect(withVoice.chatHook.text).toContain('Reverse Engineering');
    expect(withVoice.chatHook.text).toContain('읽어볼 만한 자료');
    expect(withVoice.chatHook.text).toContain('열어볼래?');
    // The register contract: no third-person self-reference, no formal endings.
    expect(withVoice.chatHook.text).not.toContain('Aoi');
    expect(withVoice.chatHook.text).not.toMatch(/니다|세요/);
  });

  it('allows one short chat hook only after explicit opt-in', () => {
    const candidate = makeCandidate();
    const withoutOptIn = decideAoiProactiveBriefDelivery({
      candidate,
      policy: makePolicy(),
      profile: makeProfile(),
      feedback: [],
      cooldownState: null,
      context: {
        now: NOW,
        quietMode: false,
        directChatOptIn: false,
      },
    });
    const withOptIn = decideAoiProactiveBriefDelivery({
      candidate,
      policy: makePolicy(),
      profile: makeProfile(),
      feedback: [],
      cooldownState: null,
      context: {
        now: NOW,
        quietMode: false,
        directChatOptIn: true,
      },
    });

    expect(withoutOptIn.chatHook.allowed).toBe(false);
    expect(withoutOptIn.chatHook.reasons).toContain('chat_hook_not_opted_in');
    expect(withOptIn.chatHook.allowed).toBe(true);
    expect(withOptIn.chatHook.text.length).toBeLessThanOrEqual(140);
  });

  it('blocks chat hooks for stale source evidence', () => {
    const staleCandidate = makeCandidate({
      freshness: {
        searchedAt: NOW,
        newestSourceAt: '2026-01-01T00:00:00.000Z',
        cannotKnow: ['Source evidence is stale for a current-info claim.'],
      },
    });
    const decision = decideAoiProactiveBriefDelivery({
      candidate: staleCandidate,
      policy: makePolicy(),
      profile: makeProfile(),
      feedback: [],
      cooldownState: null,
      context: {
        now: NOW,
        quietMode: false,
        directChatOptIn: true,
      },
    });

    expect(decision.chatHook.allowed).toBe(false);
    expect(decision.chatHook.reasons).toContain('stale_source');
  });
});

describe('Aoi proactive brief feedback adaptation', () => {
  it('uses useful feedback to boost future topic relevance without removing cooldown gates', () => {
    const root = makeTempRoot();
    saveProfileAndCandidate(root);
    const before = decideAoiProactiveBriefDelivery({
      candidate: makeCandidate({ id: 'aoi-brief-future-before' }),
      policy: makePolicy(),
      profile: loadAoiInterestProfile(root, SESSION_PATH, NOW),
      feedback: [],
      cooldownState: loadAoiProactiveBriefCooldownState(root, SESSION_PATH, NOW),
      context: {
        now: NOW,
      },
    });

    applyAoiProactiveBriefFeedbackAction({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      briefId: 'aoi-brief-delivery-test',
      category: 'useful',
      now: NOW + 1000,
    });

    const afterProfile = loadAoiInterestProfile(root, SESSION_PATH, NOW + 2000);
    const afterFeedback = loadAoiProactiveBriefFeedback(root, SESSION_PATH);
    const after = decideAoiProactiveBriefDelivery({
      candidate: makeCandidate({
        id: 'aoi-brief-future-after',
        updatedAt: NOW + 2000,
      }),
      policy: makePolicy(),
      profile: afterProfile,
      feedback: afterFeedback,
      cooldownState: loadAoiProactiveBriefCooldownState(root, SESSION_PATH, NOW + 2000),
      context: {
        now: NOW + 2000,
      },
    });

    expect(afterProfile.topics[0].importance).toBeGreaterThan(0.82);
    expect(afterProfile.topics[0].currentInfoPreference).toBeGreaterThan(0.9);
    expect(after.deliveryScore).toBeGreaterThan(before.deliveryScore);
    expect(after.ladder.steps.dashboard.allowed).toBe(true);
    expect(after.ladder.steps.execute_after_approval.allowed).toBe(false);
    expect(after.ladder.steps.execute_after_approval.reasons).toEqual(
      expect.arrayContaining(['approval_sandbox_required', 'authority_registry_proof_required']),
    );
    expect(after.ladder.actionAuthority).toBe('display_only');
    expect(after.ladder.mutationCount).toBe(0);
    expect(loadAoiProactiveBriefCooldownState(root, SESSION_PATH, NOW + 2000).cooldowns).toEqual(
      {},
    );
  });

  it('does not let positive calibration bypass quiet mode, opt-in, freshness, or cooldown gates', () => {
    const root = makeTempRoot();
    saveProfileAndCandidate(root);

    applyAoiProactiveBriefFeedbackAction({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      briefId: 'aoi-brief-delivery-test',
      category: 'useful',
      now: NOW + 1000,
    });
    upsertAoiProactiveBriefCooldown(root, SESSION_PATH, {
      cooldownKey: 'interest:reverse-engineering',
      topicId: 'aoi-interest-re',
      nextAllowedAt: NOW + 60_000,
      reason: 'test:cooldown',
      now: NOW + 1000,
    });

    const tuning = loadAoiProactiveBriefCalibrationTuning(root, SESSION_PATH, NOW + 2000);
    const future = makeCandidate({
      id: 'aoi-brief-positive-calibration-future',
      score: 0.99,
      confidence: 0.99,
      updatedAt: NOW + 2000,
    });
    const staleFuture = makeCandidate({
      id: 'aoi-brief-positive-calibration-stale',
      score: 0.99,
      confidence: 0.99,
      sources: [
        {
          title: 'Old reverse engineering writeup',
          url: 'https://research.example.com/re/old-writeup',
          host: 'research.example.com',
          publishedAt: '2026-04-01T00:00:00.000Z',
          retrievedAt: NOW + 2000,
          snippet: 'Older public source snippet.',
        },
      ],
      freshness: {
        searchedAt: NOW + 2000,
        newestSourceAt: '2026-04-01T00:00:00.000Z',
        cannotKnow: [],
      },
      updatedAt: NOW + 2000,
    });

    const quietDecision = decideAoiProactiveBriefDelivery({
      candidate: future,
      policy: makePolicy(),
      profile: loadAoiInterestProfile(root, SESSION_PATH, NOW + 2000),
      feedback: loadAoiProactiveBriefFeedback(root, SESSION_PATH),
      cooldownState: { version: 1, sessionPath: SESSION_PATH, updatedAt: NOW, cooldowns: {} },
      calibrationTuning: tuning,
      context: {
        now: NOW + 2000,
        quietMode: true,
        directChatOptIn: true,
      },
    });
    const noOptInDecision = decideAoiProactiveBriefDelivery({
      candidate: future,
      policy: makePolicy(),
      profile: loadAoiInterestProfile(root, SESSION_PATH, NOW + 2000),
      feedback: loadAoiProactiveBriefFeedback(root, SESSION_PATH),
      cooldownState: { version: 1, sessionPath: SESSION_PATH, updatedAt: NOW, cooldowns: {} },
      calibrationTuning: tuning,
      context: {
        now: NOW + 2000,
        quietMode: false,
        directChatOptIn: false,
      },
    });
    const cooldownDecision = decideAoiProactiveBriefDelivery({
      candidate: future,
      policy: makePolicy(),
      profile: loadAoiInterestProfile(root, SESSION_PATH, NOW + 2000),
      feedback: loadAoiProactiveBriefFeedback(root, SESSION_PATH),
      cooldownState: loadAoiProactiveBriefCooldownState(root, SESSION_PATH, NOW + 2000),
      calibrationTuning: tuning,
      context: {
        now: NOW + 2000,
        quietMode: false,
        directChatOptIn: true,
      },
    });
    const staleDecision = decideAoiProactiveBriefDelivery({
      candidate: staleFuture,
      policy: makePolicy(),
      profile: loadAoiInterestProfile(root, SESSION_PATH, NOW + 2000),
      feedback: loadAoiProactiveBriefFeedback(root, SESSION_PATH),
      cooldownState: { version: 1, sessionPath: SESSION_PATH, updatedAt: NOW, cooldowns: {} },
      calibrationTuning: tuning,
      context: {
        now: NOW + 2000,
        quietMode: false,
        directChatOptIn: true,
      },
    });

    expect(tuning.labelDistribution.useful).toBe(1);
    expect(quietDecision.chatHook.allowed).toBe(false);
    expect(quietDecision.modeReasons.chat_hook).toContain('quiet_mode_suppresses_chat_hook');
    expect(noOptInDecision.chatHook.allowed).toBe(false);
    expect(noOptInDecision.modeReasons.chat_hook).toContain('chat_hook_not_opted_in');
    expect(cooldownDecision.chatHook.allowed).toBe(false);
    expect(cooldownDecision.modeReasons.chat_hook).toContain('topic_cooldown_active');
    expect(staleDecision.chatHook.allowed).toBe(false);
    expect(staleDecision.modeReasons.chat_hook).toContain('stale_source');
  });

  it('raises cooldown after too frequent feedback', () => {
    const root = makeTempRoot();
    saveProfileAndCandidate(root);

    applyAoiProactiveBriefFeedbackAction({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      briefId: 'aoi-brief-delivery-test',
      category: 'too_frequent',
      now: NOW,
      defaultCooldownMs: 60 * 60 * 1000,
    });

    const cooldown = loadAoiProactiveBriefCooldownState(root, SESSION_PATH, NOW).cooldowns[
      'interest:reverse-engineering'
    ];
    const fieldEvents = loadAoiProactiveBriefFieldEvents(root, SESSION_PATH, NOW + 1000);
    const followUpDecision = decideAoiProactiveBriefDelivery({
      candidate: makeCandidate({
        id: 'aoi-brief-after-too-frequent',
        updatedAt: NOW + 1000,
      }),
      policy: makePolicy(),
      profile: loadAoiInterestProfile(root, SESSION_PATH, NOW + 1000),
      feedback: loadAoiProactiveBriefFeedback(root, SESSION_PATH),
      cooldownState: loadAoiProactiveBriefCooldownState(root, SESSION_PATH, NOW + 1000),
      context: {
        now: NOW + 1000,
        directChatOptIn: true,
        maxInlineCards: 1,
        inlineCardsShown: 0,
      },
    });

    expect(cooldown.nextAllowedAt).toBeGreaterThanOrEqual(NOW + 24 * 60 * 60 * 1000);
    expect(fieldEvents.some((event) => event.kind === 'feedback_recorded')).toBe(true);
    expect(fieldEvents.some((event) => event.feedbackCategory === 'too_frequent')).toBe(true);
    expect(followUpDecision.digestVisible).toBe(false);
    expect(followUpDecision.inlineCardVisible).toBe(false);
    expect(followUpDecision.modeReasons.digest).toContain('topic_cooldown_active');
  });

  it('uses unsafe and stale calibration labels to tighten future direct chat delivery', () => {
    const root = makeTempRoot();
    saveProfileAndCandidate(root);
    const candidate = loadAoiProactiveBriefCandidates(root, SESSION_PATH, NOW)[0]!;
    const shownDecision = decideAoiProactiveBriefDelivery({
      candidate,
      policy: makePolicy(),
      profile: loadAoiInterestProfile(root, SESSION_PATH, NOW),
      context: {
        now: NOW,
      },
    });
    recordAoiProactiveBriefDeliveryFieldEvents({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      candidates: [candidate],
      decisions: [shownDecision],
      now: NOW,
    });
    const shown = loadAoiProactiveBriefFieldEvents(root, SESSION_PATH, NOW + 1).find((event) =>
      event.kind.startsWith('shown_'),
    )!;

    recordAoiProactiveBriefCalibrationLabel(root, {
      sessionPath: SESSION_PATH,
      fieldEventId: shown.id,
      label: 'unsafe',
      note: 'Do not show this in chat; contains private path C:\\Users\\operator\\secret.txt',
      now: NOW + 1000,
    });

    const tuning = loadAoiProactiveBriefCalibrationTuning(root, SESSION_PATH, NOW + 2000);
    const inbox = loadAoiProactiveBriefCalibrationInbox(root, SESSION_PATH, NOW + 2000);
    const future = makeCandidate({
      id: 'aoi-brief-after-unsafe-calibration',
      score: 0.99,
      confidence: 0.99,
      updatedAt: NOW + 2000,
    });
    const decision = decideAoiProactiveBriefDelivery({
      candidate: future,
      policy: makePolicy(),
      profile: loadAoiInterestProfile(root, SESSION_PATH, NOW + 2000),
      feedback: [],
      cooldownState: { version: 1, sessionPath: SESSION_PATH, updatedAt: NOW, cooldowns: {} },
      calibrationTuning: tuning,
      context: {
        now: NOW + 2000,
        quietMode: false,
        directChatOptIn: true,
      },
    });
    const panel = buildAoiProactiveBriefPanelModel({
      candidates: [future],
      policy: makePolicy(),
      profile: loadAoiInterestProfile(root, SESSION_PATH, NOW + 2000),
      feedback: [],
      cooldownState: { version: 1, sessionPath: SESSION_PATH, updatedAt: NOW, cooldowns: {} },
      calibrationInbox: inbox,
      calibrationTuning: tuning,
      context: {
        now: NOW + 2000,
        quietMode: false,
        directChatOptIn: true,
        maxInlineCards: 1,
        inlineCardsShown: 0,
      },
    });

    expect(tuning.unsafeLabelCount).toBe(1);
    expect(decision.chatHook.allowed).toBe(false);
    expect(decision.modeReasons.chat_hook).toContain('calibration_unsafe_direct_chat_block');
    expect(decision.ladder.steps.direct_chat.allowed).toBe(false);
    expect(decision.ladder.steps.approval_request.allowed).toBe(false);
    expect(decision.ladder.steps.approval_request.reasons).toContain(
      'unsafe_feedback_blocks_approval_request',
    );
    expect(decision.ladder.steps.execute_after_approval.allowed).toBe(false);
    expect(panel.calibrationSummaryLabels.length).toBeGreaterThan(0);
    expect(panel.cards[0]?.tuningLabels).toContain('Topic tuning: unsafe');
    expect(panel.cards[0]?.deliveryLadderLabels.join(' ')).toContain('Execute blocked');
    expect(panel.cards[0]?.actionAuthorityLabel).toContain('display_only');
    expect(JSON.stringify(panel)).not.toContain('C:\\Users\\operator\\secret.txt');
  });

  it('records expansion and source-open field events from feedback actions', () => {
    const root = makeTempRoot();
    saveProfileAndCandidate(root);

    applyAoiProactiveBriefFeedbackAction({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      briefId: 'aoi-brief-delivery-test',
      category: 'expand_summary',
      now: NOW + 1000,
    });
    applyAoiProactiveBriefFeedbackAction({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      briefId: 'aoi-brief-delivery-test',
      category: 'open_sources',
      now: NOW + 2000,
    });
    applyAoiProactiveBriefFeedbackAction({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      briefId: 'aoi-brief-delivery-test',
      category: 'archive_brief',
      now: NOW + 3000,
    });

    const fieldEvents = loadAoiProactiveBriefFieldEvents(root, SESSION_PATH, NOW + 4000);

    expect(fieldEvents.some((event) => event.kind === 'expanded')).toBe(true);
    expect(fieldEvents.some((event) => event.kind === 'source_opened')).toBe(true);
    expect(fieldEvents.some((event) => event.kind === 'archived')).toBe(true);
    expect(fieldEvents.some((event) => event.feedbackCategory === 'expand_summary')).toBe(true);
    expect(fieldEvents.some((event) => event.feedbackCategory === 'open_sources')).toBe(true);
    expect(fieldEvents.some((event) => event.feedbackCategory === 'archive_brief')).toBe(true);
  });

  it('lowers topic score and records feedback evidence for wrong topic', () => {
    const root = makeTempRoot();
    saveProfileAndCandidate(root);

    const result = applyAoiProactiveBriefFeedbackAction({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      briefId: 'aoi-brief-delivery-test',
      category: 'wrong_topic',
      now: NOW,
    });

    expect(result.profile.topics[0].importance).toBeLessThan(0.82);
    expect(result.profile.topics[0].confidence).toBeLessThan(0.86);
    expect(result.profile.topics[0].evidenceRefs).toContain(`feedback:${result.feedback.id}`);
    expect(result.allFeedback[0].category).toBe('wrong_topic');
  });
});

describe('Aoi proactive brief UI model', () => {
  it('shows sources, freshness, evidence, and cannot-know notes in card models', () => {
    const panel = buildAoiProactiveBriefPanelModel({
      candidates: [makeCandidate()],
      policy: makePolicy(),
      profile: makeProfile(),
      feedback: [],
      cooldownState: null,
      context: {
        now: NOW,
        quietMode: false,
        directChatOptIn: false,
        maxInlineCards: 1,
        inlineCardsShown: 0,
      },
    });

    expect(panel.visible).toBe(true);
    expect(panel.cards[0].sourceCountLabel).toBe('1 source');
    expect(panel.cards[0].freshnessLabel).toContain('searched');
    expect(panel.cards[0].cannotKnowLabels[0]).toContain('cannot know');
    expect(panel.cards[0].evidenceRefs).toContain('source:research.example.com');
    expect(panel.cards[0].sources[0]).toMatchObject({
      host: 'research.example.com',
      url: 'https://research.example.com/re/writeup',
    });
  });
});
