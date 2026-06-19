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
  loadAoiProactiveBriefCooldownState,
  loadAoiProactiveBriefFeedback,
  saveAoiInterestProfile,
  upsertAoiProactiveBriefCandidate,
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
    expect(loadAoiProactiveBriefCooldownState(root, SESSION_PATH, NOW + 2000).cooldowns).toEqual(
      {},
    );
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
    expect(followUpDecision.digestVisible).toBe(false);
    expect(followUpDecision.inlineCardVisible).toBe(false);
    expect(followUpDecision.modeReasons.digest).toContain('topic_cooldown_active');
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
