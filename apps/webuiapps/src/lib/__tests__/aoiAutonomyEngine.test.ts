import * as fs from 'fs';
import * as os from 'os';
import { dirname, join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { runAoiAutonomyTick, type AoiAutonomyReflectionChat } from '../aoiAutonomyEngine';
import {
  appendAoiProposalDecision,
  loadAoiActiveProposals,
  saveAoiActiveProposals,
  saveAoiAutonomyPolicy,
} from '../aoiAutonomyStore';
import type { AoiMemoryEntry } from '../aoiMemoryShared';
import { buildAoiResearchArtifactPaths, type AoiResearchManifest } from '../aoiResearchTypes';
import type { AoiProposal, AoiProposalDecision } from '../aoiAutonomyTypes';
import type { LLMConfig } from '../llmModels';

const SESSION_PATH = 'aoi/default';
const NOW = 1_800_000_000_000;
const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'aoi-autonomy-engine-test-'));
  tempRoots.push(root);
  return root;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

function enablePolicy(root: string, level: 'L3' | 'L4' = 'L4'): void {
  saveAoiAutonomyPolicy(
    root,
    SESSION_PATH,
    {
      enabled: true,
      previewMode: true,
      level,
      confidenceFloor: 0.55,
      maxActiveProposals: 8,
      maxProposalsPerTick: 4,
    },
    NOW,
  );
}

function makeManifest(partial: Partial<AoiResearchManifest> = {}): AoiResearchManifest {
  const id = partial.id ?? 'aoi-research-done-001';
  return {
    version: 1,
    id,
    sessionPath: SESSION_PATH,
    request: 'Windows kernel driver security research',
    mode: 'standard',
    language: 'ko',
    recency: 'month',
    maxSources: 12,
    createdAt: NOW - 10_000,
    updatedAt: NOW - 5_000,
    completedAt: NOW - 5_000,
    status: 'completed',
    phase: 'completed',
    statusMessage: 'completed',
    sourceCounts: {
      planned: 10,
      candidates: 10,
      accepted: 6,
      failed: 0,
    },
    artifactPaths: buildAoiResearchArtifactPaths(id),
    artifactAvailability: {
      manifest: true,
      report: true,
      sources: false,
      evidence: false,
    },
    reportTitle: 'Windows kernel driver security research',
    claimCount: 4,
    ...partial,
  };
}

function writeResearchManifest(root: string, manifest: AoiResearchManifest): void {
  writeJson(
    join(root, SESSION_PATH, 'aoi-research', 'runs', manifest.id, 'manifest.json'),
    manifest,
  );
}

function makeMemory(partial: Partial<AoiMemoryEntry> = {}): AoiMemoryEntry {
  return {
    version: 2,
    id: 'memory-stale-001',
    scope: 'agent',
    type: 'fact',
    status: 'active',
    content:
      'Windows kernel driver security research was completed with useful current-info findings.',
    normalizedContent:
      'windows kernel driver security research was completed with useful current-info findings.',
    importance: 0.8,
    confidence: 0.82,
    hits: 0,
    createdAt: NOW - 60 * 24 * 60 * 60 * 1000,
    updatedAt: NOW - 45 * 24 * 60 * 60 * 1000,
    permanent: true,
    sourceEpisodeIds: ['episode-research-001'],
    sessionPath: SESSION_PATH,
    tags: ['research', 'aoi-research', 'windows', 'kernel', 'security'],
    entities: [],
    ...partial,
  };
}

function writeMemory(root: string, memory: AoiMemoryEntry): void {
  writeJson(join(root, 'aoi', 'memory-v2', 'memories', `${memory.id}.json`), memory);
}

function makeProposal(partial: Partial<AoiProposal> = {}): AoiProposal {
  return {
    version: 1,
    id: 'proposal-existing-001',
    sessionPath: SESSION_PATH,
    status: 'active',
    title: 'Open matching research',
    body: 'The completed research can answer the current topic.',
    reason: 'The latest message overlaps with a completed research run.',
    trigger: 'research_followup',
    createdAt: NOW - 1_000,
    updatedAt: NOW - 1_000,
    cooldownKey: 'research-followup:aoi-research-done-001',
    confidence: 0.82,
    risk: 'low',
    requiredAutonomyLevel: 'L3',
    requiresUserApproval: false,
    suggestedTools: ['read_research_artifact'],
    evidenceRefs: ['research:aoi-research-done-001/report'],
    memoryIds: [],
    artifactRefs: ['research:aoi-research-done-001/report'],
    riskSignals: [],
    ...partial,
  };
}

function makeDecision(partial: Partial<AoiProposalDecision> = {}): AoiProposalDecision {
  return {
    version: 1,
    id: 'decision-test-001',
    proposalId: 'proposal-old-001',
    sessionPath: SESSION_PATH,
    cooldownKey: 'research-followup:aoi-research-done-001',
    action: 'dismiss',
    actor: 'user',
    createdAt: NOW - 1_000,
    previousStatus: 'active',
    nextStatus: 'dismissed',
    ...partial,
  };
}

const TEST_LLM_CONFIG: LLMConfig = {
  provider: 'openai',
  apiKey: 'test-key',
  baseUrl: 'http://localhost',
  model: 'test-model',
};

function reflectionChat(content: string): AoiAutonomyReflectionChat {
  return (async () => ({
    content,
    toolCalls: [],
  })) as AoiAutonomyReflectionChat;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('runAoiAutonomyTick()', () => {
  it('creates a deterministic proposal to open a matching completed research report', async () => {
    const root = makeTempRoot();
    enablePolicy(root, 'L4');
    writeResearchManifest(root, makeManifest());

    const result = await runAoiAutonomyTick({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      reason: 'manual',
      latestUserMessage: 'Windows kernel driver security research 다시 보여줘',
      now: NOW,
    });

    const proposals = loadAoiActiveProposals(root, SESSION_PATH);
    expect(result.newActiveProposalCount).toBe(1);
    expect(proposals[0]).toMatchObject({
      trigger: 'research_followup',
      cooldownKey: 'research-followup:aoi-research-done-001',
      suggestedTools: ['read_research_artifact'],
      requiresUserApproval: false,
    });
    expect(proposals[0].evidenceRefs).toContain('research:aoi-research-done-001/report');
    expect(proposals[0].acceptAction).toMatchObject({
      kind: 'read_research_artifact',
      params: {
        runId: 'aoi-research-done-001',
        artifact: 'report',
      },
    });
  });

  it('proposes an approval-gated retry for failed or timed-out research', async () => {
    const root = makeTempRoot();
    enablePolicy(root, 'L4');
    writeResearchManifest(
      root,
      makeManifest({
        id: 'aoi-research-fail-001',
        status: 'failed',
        phase: 'failed',
        completedAt: undefined,
        artifactAvailability: {
          manifest: true,
          report: false,
          sources: false,
          evidence: false,
        },
        error: {
          code: 'research_run_timeout',
          message: 'Timed out while reading sources.',
          phase: 'reading_sources',
          createdAt: NOW - 4_000,
        },
      }),
    );

    const result = await runAoiAutonomyTick({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      reason: 'research_run',
      now: NOW,
    });

    const proposals = loadAoiActiveProposals(root, SESSION_PATH);
    expect(result.newActiveProposalCount).toBe(1);
    expect(proposals[0]).toMatchObject({
      trigger: 'research_retry',
      risk: 'medium',
      requiredAutonomyLevel: 'L4',
      requiresUserApproval: true,
      suggestedTools: ['start_research'],
    });
    expect(proposals[0].riskSignals).toEqual(
      expect.arrayContaining(['research-failed', 'timeout']),
    );
  });

  it('proposes fresh research when current-info asks match stale permanent research memory', async () => {
    const root = makeTempRoot();
    enablePolicy(root, 'L4');
    writeMemory(root, makeMemory());

    const result = await runAoiAutonomyTick({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      reason: 'turn',
      latestUserMessage: '최신 Windows kernel driver security 동향 조사해줘',
      now: NOW,
    });

    const proposals = loadAoiActiveProposals(root, SESSION_PATH);
    expect(result.newActiveProposalCount).toBe(1);
    expect(proposals[0]).toMatchObject({
      trigger: 'stale_research_memory',
      cooldownKey: 'research-refresh:memory-stale-001',
      suggestedTools: ['start_research'],
      requiresUserApproval: true,
    });
    expect(proposals[0].evidenceRefs).toEqual(['memory:memory-stale-001']);
  });

  it('proposes approval-gated procedure promotion for repeated successful research memories', async () => {
    const root = makeTempRoot();
    enablePolicy(root, 'L4');
    writeMemory(
      root,
      makeMemory({
        id: 'memory-research-success-001',
        tags: ['permanent', 'research', 'aoi-research', 'completed', 'windows'],
        updatedAt: NOW - 10_000,
      }),
    );
    writeMemory(
      root,
      makeMemory({
        id: 'memory-research-success-002',
        content: 'Aoi completed research "Windows kernel exploit mitigation trends".',
        normalizedContent: 'aoi completed research "windows kernel exploit mitigation trends".',
        tags: ['permanent', 'research', 'aoi-research', 'completed', 'kernel'],
        updatedAt: NOW - 8_000,
      }),
    );

    const result = await runAoiAutonomyTick({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      reason: 'manual',
      latestUserMessage: '이 반복 research workflow를 절차로 저장해줘',
      now: NOW,
    });

    const proposals = loadAoiActiveProposals(root, SESSION_PATH);
    const procedure = proposals.find(
      (proposal) => proposal.cooldownKey === 'procedure:repeated-research-workflow',
    );
    expect(result.newActiveProposalCount).toBeGreaterThanOrEqual(1);
    expect(procedure).toMatchObject({
      trigger: 'procedure_candidate',
      requiresUserApproval: true,
      requiredAutonomyLevel: 'L4',
      suggestedTools: ['save_memory'],
    });
    expect(procedure?.evidenceRefs).toEqual(
      expect.arrayContaining([
        'memory:memory-research-success-001',
        'memory:memory-research-success-002',
      ]),
    );
    expect(procedure?.acceptAction).toMatchObject({
      kind: 'save_memory',
      params: {
        type: 'procedure',
      },
    });
  });

  it('proposes approval-gated procedure promotion for repeated reviewed Kira outcomes', async () => {
    const root = makeTempRoot();
    enablePolicy(root, 'L4');
    writeMemory(
      root,
      makeMemory({
        id: 'memory-kira-success-001',
        scope: 'project',
        type: 'action',
        content: 'Kira completed reviewed project work "Add autonomy controls".',
        normalizedContent: 'kira completed reviewed project work "add autonomy controls".',
        permanent: undefined,
        tags: ['kira', 'automation', 'completed', 'reviewed'],
        updatedAt: NOW - 10_000,
      }),
    );
    writeMemory(
      root,
      makeMemory({
        id: 'memory-kira-success-002',
        scope: 'project',
        type: 'action',
        content: 'Kira completed reviewed project work "Fix validation evidence".',
        normalizedContent: 'kira completed reviewed project work "fix validation evidence".',
        permanent: undefined,
        tags: ['kira', 'automation', 'completed', 'reviewed'],
        updatedAt: NOW - 8_000,
      }),
    );

    await runAoiAutonomyTick({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      reason: 'manual',
      latestUserMessage: 'Kira 반복 review workflow를 절차로 저장해줘',
      now: NOW,
    });

    const proposals = loadAoiActiveProposals(root, SESSION_PATH);
    const procedure = proposals.find(
      (proposal) => proposal.cooldownKey === 'procedure:repeated-kira-review-workflow',
    );
    expect(procedure).toMatchObject({
      trigger: 'procedure_candidate',
      requiresUserApproval: true,
      suggestedTools: ['save_memory'],
    });
    expect(procedure?.evidenceRefs).toEqual(
      expect.arrayContaining(['memory:memory-kira-success-001', 'memory:memory-kira-success-002']),
    );
  });

  it('suppresses duplicate proposals that share an active cooldown key', async () => {
    const root = makeTempRoot();
    enablePolicy(root, 'L4');
    writeResearchManifest(root, makeManifest());
    saveAoiActiveProposals(root, SESSION_PATH, [makeProposal()]);

    const result = await runAoiAutonomyTick({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      reason: 'manual',
      latestUserMessage: 'Windows kernel driver security research 다시 보여줘',
      now: NOW,
    });

    expect(result.newActiveProposalCount).toBe(0);
    expect(result.blockedProposalCount).toBe(1);
    expect(result.blockedProposals[0].reasons).toContain('duplicate_active_proposal');
    expect(loadAoiActiveProposals(root, SESSION_PATH)).toHaveLength(1);
  });

  it('honors a recent dismissed cooldown decision', async () => {
    const root = makeTempRoot();
    enablePolicy(root, 'L4');
    writeResearchManifest(root, makeManifest());
    appendAoiProposalDecision(root, makeDecision());

    const result = await runAoiAutonomyTick({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      reason: 'manual',
      latestUserMessage: 'Windows kernel driver security research 다시 보여줘',
      now: NOW,
    });

    expect(result.newActiveProposalCount).toBe(0);
    expect(result.blockedProposalCount).toBe(1);
    expect(result.blockedProposals[0].reasons).toContain('cooldown_active');
  });

  it('keeps deterministic proposals when optional LLM reflection returns malformed JSON', async () => {
    const root = makeTempRoot();
    enablePolicy(root, 'L4');
    writeResearchManifest(root, makeManifest());

    const result = await runAoiAutonomyTick({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      reason: 'manual',
      latestUserMessage: 'Windows kernel driver security research 다시 보여줘',
      llmConfig: TEST_LLM_CONFIG,
      reflectionChat: reflectionChat('not json'),
      now: NOW,
    });

    expect(result.newActiveProposalCount).toBe(1);
    expect(result.warnings).toContain('reflection_json_missing');
    expect(loadAoiActiveProposals(root, SESSION_PATH)[0].trigger).toBe('research_followup');
  });

  it('rejects LLM proposals that cite hallucinated evidence refs', async () => {
    const root = makeTempRoot();
    enablePolicy(root, 'L4');
    const llmJson = JSON.stringify({
      reflections: [],
      proposals: [
        {
          title: 'Open missing memory',
          body: 'This cites memory that was not supplied.',
          reason: 'The evidence ref is not in the observation set.',
          cooldownKey: 'llm:missing-memory',
          confidence: 0.9,
          risk: 'low',
          requiredAutonomyLevel: 'L2',
          requiresUserApproval: false,
          suggestedTools: ['read_research_artifact'],
          evidenceRefs: ['memory:ghost'],
        },
      ],
    });

    const result = await runAoiAutonomyTick({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      reason: 'manual',
      latestUserMessage: '검토해줘',
      llmConfig: TEST_LLM_CONFIG,
      reflectionChat: reflectionChat(llmJson),
      now: NOW,
    });

    expect(result.newActiveProposalCount).toBe(0);
    expect(result.warnings).toContain('proposal_rejected_evidence');
    expect(loadAoiActiveProposals(root, SESSION_PATH)).toEqual([]);
  });

  it('blocks high-risk LLM proposals that exceed the configured policy level', async () => {
    const root = makeTempRoot();
    enablePolicy(root, 'L4');
    const llmJson = JSON.stringify({
      reflections: [],
      proposals: [
        {
          title: 'Run workspace command',
          body: 'Inspect the local workspace through a command.',
          reason: 'The user asked for inspection.',
          cooldownKey: 'llm:run-command',
          confidence: 0.9,
          risk: 'high',
          requiredAutonomyLevel: 'L5',
          requiresUserApproval: true,
          suggestedTools: ['run_command'],
          evidenceRefs: ['observation:latest-user-message'],
        },
      ],
    });

    const result = await runAoiAutonomyTick({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      reason: 'manual',
      latestUserMessage: 'workspace 상태 확인해줘',
      llmConfig: TEST_LLM_CONFIG,
      reflectionChat: reflectionChat(llmJson),
      now: NOW,
    });

    expect(result.newActiveProposalCount).toBe(0);
    expect(result.blockedProposalCount).toBe(1);
    expect(result.blockedProposals[0].reasons).toEqual(
      expect.arrayContaining(['autonomy_level_too_low', 'tool_blocked:run_command']),
    );
    expect(loadAoiActiveProposals(root, SESSION_PATH)).toEqual([]);
  });
});
