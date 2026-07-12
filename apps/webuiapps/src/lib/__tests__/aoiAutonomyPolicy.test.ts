import { describe, expect, it } from 'vitest';
import {
  feedbackMemoryProposalFixture,
  feedbackRefreshProposalFixture,
  highRiskProcedureProposalFixture,
  makeFeedbackDecisionFixture,
} from '../__fixtures__/aoiAutonomyEvaluationFixtures';
import {
  DEFAULT_AOI_AUTONOMY_POLICY,
  applyAoiFeedbackCalibrationToProposal,
  checkAoiEnvironmentSourceOperation,
  checkAoiProposalPolicy,
  compareAoiAutonomyLevel,
  getDefaultAoiEnvironmentSourceRegistry,
  evaluateAoiProposalExecution,
  getAoiFeedbackAdjustedCooldownMs,
  isAoiEnvironmentSourceEnabled,
  getAoiProposalFeedbackPriorityBoost,
  getAoiToolAutonomyPolicy,
  isAoiToolAllowedAtLevel,
  normalizeAoiAutonomyPolicy,
  requiresAoiProposalApproval,
} from '../aoiAutonomyPolicy';
import {
  buildAoiPreviewOnlyFileWorkPreparedActionPlan,
  buildAoiValidationCommandPreparedActionPlan,
} from '../aoiSafeActionPlan';
import {
  AOI_COMMAND_APPROVAL_TTL_MS,
  compareAoiApprovedCommandApproval,
  createAoiApprovedCommandRequest,
  evaluateAoiApprovedCommandPolicy,
} from '../aoiApprovedCommandPolicy';
import {
  buildAoiPreferencePromptBlock,
  buildAoiPreferenceMemoryCandidates,
  classifyAoiPreferenceEvidence,
  resolveAoiPreferenceContext,
} from '../aoiPreferenceMemory';
import type { AoiMemoryEntry } from '../aoiMemoryShared';
import type { AoiProposal, AoiProposalDecision } from '../aoiAutonomyTypes';

function makeProposal(partial: Partial<AoiProposal> = {}): AoiProposal {
  return {
    version: 1,
    id: 'proposal-test-001',
    sessionPath: 'aoi/default',
    status: 'active',
    title: 'Open previous research',
    body: 'A previous Aoi research run may answer this.',
    reason: 'The current topic matches a completed research memory.',
    trigger: 'research_followup',
    createdAt: 1000,
    updatedAt: 1000,
    cooldownKey: 'research:kernel-memory',
    confidence: 0.8,
    risk: 'low',
    requiredAutonomyLevel: 'L2',
    requiresUserApproval: false,
    suggestedTools: ['read_research_artifact'],
    evidenceRefs: ['memory:aoi-memory-001'],
    memoryIds: ['aoi-memory-001'],
    artifactRefs: ['research:aoi-research-001/report'],
    riskSignals: [],
    ...partial,
  };
}

function makePreferenceMemory(partial: Partial<AoiMemoryEntry> = {}): AoiMemoryEntry {
  return {
    version: 2,
    id: 'memory-preference-test-001',
    scope: 'user',
    type: 'preference',
    status: 'active',
    content: 'The user prefers Korean by default. pref:response.language',
    normalizedContent: 'the user prefers korean by default',
    importance: 0.8,
    confidence: 0.82,
    hits: 2,
    createdAt: 1000,
    updatedAt: 2000,
    sourceEpisodeIds: ['episode-preference-test-001'],
    tags: ['preference', 'durable-preference', 'pref:response.language'],
    entities: ['response.language'],
    ...partial,
  };
}

describe('Aoi autonomy policy defaults', () => {
  it('keeps autonomy conservative and preview-only by default', () => {
    expect(DEFAULT_AOI_AUTONOMY_POLICY.enabled).toBe(false);
    expect(DEFAULT_AOI_AUTONOMY_POLICY.previewMode).toBe(true);
    expect(DEFAULT_AOI_AUTONOMY_POLICY.level).toBe('L1');
    expect(DEFAULT_AOI_AUTONOMY_POLICY.proactiveSuggestionsEnabled).toBe(false);
    // P3.1: the bounded reason-act-observe reflection loop is OFF by default.
    expect(DEFAULT_AOI_AUTONOMY_POLICY.agenticReflectionEnabled).toBe(false);
    expect(DEFAULT_AOI_AUTONOMY_POLICY.proactiveBriefing.enabled).toBe(false);
    expect(DEFAULT_AOI_AUTONOMY_POLICY.proactiveBriefing.allowBackgroundScout).toBe(false);
    expect(DEFAULT_AOI_AUTONOMY_POLICY.proactiveBriefing.directChatHookOptIn).toBe(false);
    expect(DEFAULT_AOI_AUTONOMY_POLICY.maxActiveProposals).toBeLessThanOrEqual(8);
  });

  it('normalizes agenticReflectionEnabled: opt-in true survives, absent/garbage -> false (P3.1)', () => {
    expect(
      normalizeAoiAutonomyPolicy({ agenticReflectionEnabled: true }).agenticReflectionEnabled,
    ).toBe(true);
    // Absent -> falls back to the conservative default (off).
    expect(normalizeAoiAutonomyPolicy({}).agenticReflectionEnabled).toBe(false);
    // Non-boolean -> coerced to the fallback (off), never truthy-accidentally-enabled.
    expect(
      normalizeAoiAutonomyPolicy({ agenticReflectionEnabled: 'yes' as unknown as boolean })
        .agenticReflectionEnabled,
    ).toBe(false);
  });

  it('normalizes partial policy values with bounded numeric limits', () => {
    const policy = normalizeAoiAutonomyPolicy(
      {
        enabled: true,
        previewMode: false,
        level: 'L4',
        proactiveSuggestionsEnabled: true,
        confidenceFloor: 99,
        maxActiveProposals: 0,
        defaultCooldownMs: 1,
        proactiveBriefing: {
          version: 1,
          enabled: true,
          allowBackgroundScout: true,
          maxScoutRunsPerDay: 99,
          maxScoutRunsPerSession: 99,
          maxTopicsPerWakeup: 99,
          maxNetworkCallsPerWakeup: 99,
          minScoutCooldownMs: -1,
          maxSessionIdleMs: 1,
          quietWindow: {
            version: 1,
            enabled: true,
            startMinuteOfDay: -10,
            endMinuteOfDay: 3_000,
          },
          directChatHookOptIn: true,
          topicControls: {
            'aoi-interest-re': {
              version: 1,
              topicId: 'aoi-interest-re',
              allowed: false,
              muted: true,
              pinned: true,
              updatedAt: 10,
            },
          },
          sourceHostControls: {
            'Research.Example.COM': {
              version: 1,
              host: 'Research.Example.COM',
              allowed: false,
              muted: true,
              updatedAt: 10,
            },
          },
        },
      },
      DEFAULT_AOI_AUTONOMY_POLICY,
      1234,
    );

    expect(policy).toMatchObject({
      version: 1,
      enabled: true,
      previewMode: false,
      level: 'L4',
      proactiveSuggestionsEnabled: true,
      confidenceFloor: 1,
      maxActiveProposals: 1,
      defaultCooldownMs: 60_000,
      updatedAt: 1234,
    });
    expect(policy.proactiveBriefing).toMatchObject({
      enabled: true,
      allowBackgroundScout: true,
      maxScoutRunsPerDay: 24,
      maxScoutRunsPerSession: 48,
      maxTopicsPerWakeup: 5,
      maxNetworkCallsPerWakeup: 5,
      minScoutCooldownMs: 0,
      maxSessionIdleMs: 60_000,
      quietWindow: {
        enabled: true,
        startMinuteOfDay: 0,
        endMinuteOfDay: 1439,
      },
      directChatHookOptIn: true,
    });
    expect(policy.proactiveBriefing.topicControls['aoi-interest-re']).toMatchObject({
      allowed: false,
      muted: true,
      pinned: true,
      updatedAt: 10,
    });
    expect(policy.proactiveBriefing.sourceHostControls['research.example.com']).toMatchObject({
      host: 'research.example.com',
      allowed: false,
      muted: true,
      updatedAt: 10,
    });
  });
});

describe('Aoi autonomy tool policy', () => {
  it('allows only registered tools at sufficient autonomy levels', () => {
    expect(getAoiToolAutonomyPolicy('get_research_status')).toMatchObject({
      maxLevel: 'L3',
      requiresApproval: false,
    });
    expect(getAoiToolAutonomyPolicy('create_kira_work')).toMatchObject({
      maxLevel: 'L4',
      requiresApproval: true,
    });
    expect(isAoiToolAllowedAtLevel('get_research_status', 'L2')).toBe(false);
    expect(isAoiToolAllowedAtLevel('get_research_status', 'L3')).toBe(true);
    for (const blockedTool of ['file_write', 'file_patch', 'file_delete', 'run_command']) {
      expect(isAoiToolAllowedAtLevel(blockedTool, 'L4')).toBe(false);
      expect(isAoiToolAllowedAtLevel(blockedTool, 'L5')).toBe(false);
    }
  });

  it('blocks unknown tools by default', () => {
    const unknown = getAoiToolAutonomyPolicy('remote_shell');

    expect(unknown.blocked).toBe(true);
    expect(isAoiToolAllowedAtLevel('remote_shell', 'L5')).toBe(false);
    expect(requiresAoiProposalApproval('remote_shell')).toBe(true);
  });
});

describe('Aoi environment source policy', () => {
  it('creates conservative defaults and keeps unknown sources fail-closed', () => {
    const registry = getDefaultAoiEnvironmentSourceRegistry('aoi/default', 1000);

    expect(registry.sources.map((source) => source.kind)).toEqual([
      'workspace_git',
      'workspace_build',
      'kira_board',
      'research_runs',
      'app_state',
      'app_activity',
      'browser_context',
      'manual_note',
      'calendar_metadata',
      'gmail_metadata',
      'notes_metadata',
    ]);
    expect(isAoiEnvironmentSourceEnabled(registry, 'research-runs')).toBe(true);
    expect(isAoiEnvironmentSourceEnabled(registry, 'workspace-git')).toBe(false);
    expect(
      checkAoiEnvironmentSourceOperation({
        registry,
        sourceId: 'unknown-source',
        operation: 'summarize',
      }),
    ).toMatchObject({
      allowed: false,
      reasons: ['unknown_source'],
    });
  });

  it('requires explicit target consent for browser and private sources', () => {
    const registry = getDefaultAoiEnvironmentSourceRegistry('aoi/default', 1000);

    const blocked = checkAoiEnvironmentSourceOperation({
      registry: {
        ...registry,
        sources: registry.sources.map((source) =>
          source.id === 'browser-context'
            ? {
                ...source,
                enabled: true,
                consentReason: undefined,
              }
            : source,
        ),
      },
      sourceId: 'browser-context',
      operation: 'summarize',
    });
    expect(blocked.allowed).toBe(false);
    expect(blocked.reasons).toContain('explicit_target_scope_required');

    const allowed = checkAoiEnvironmentSourceOperation({
      registry: {
        ...registry,
        sources: registry.sources.map((source) =>
          source.id === 'browser-context'
            ? {
                ...source,
                enabled: true,
                scope: 'explicit_target',
                consentReason: 'User attached the current page for this mission.',
              }
            : source,
        ),
      },
      sourceId: 'browser-context',
      operation: 'summarize',
    });
    expect(allowed).toMatchObject({
      allowed: true,
      reasons: [],
    });
  });

  it('requires reviewed explicit consent before personal metadata sources are usable', () => {
    const registry = getDefaultAoiEnvironmentSourceRegistry('aoi/default', 1000);
    const enabledWithoutReview = {
      ...registry,
      sources: registry.sources.map((source) =>
        source.id === 'gmail-metadata'
          ? {
              ...source,
              enabled: true,
              consentReason: 'User enabled Gmail metadata for this mission.',
            }
          : source,
      ),
    };

    const blocked = checkAoiEnvironmentSourceOperation({
      registry: enabledWithoutReview,
      sourceId: 'gmail-metadata',
      operation: 'summarize_counts',
    });
    expect(blocked.allowed).toBe(false);
    expect(blocked.reasons).toContain('source_consent_review_required');

    const enabledWithReview = {
      ...registry,
      sources: registry.sources.map((source) =>
        source.id === 'gmail-metadata'
          ? {
              ...source,
              enabled: true,
              consentReason: 'User enabled Gmail metadata for this mission.',
              lastReviewedAt: 1200,
            }
          : source,
      ),
    };
    expect(
      checkAoiEnvironmentSourceOperation({
        registry: enabledWithReview,
        sourceId: 'gmail-metadata',
        operation: 'summarize_counts',
      }),
    ).toMatchObject({
      allowed: true,
      reasons: [],
    });
  });

  it('keeps the live app activity stream dark until explicit reviewed consent', () => {
    const registry = getDefaultAoiEnvironmentSourceRegistry('aoi/default', 1000);

    const dark = checkAoiEnvironmentSourceOperation({
      registry,
      sourceId: 'app-activity',
      operation: 'read_metadata',
    });
    expect(dark.allowed).toBe(false);
    expect(dark.reasons).toContain('source_disabled');
    expect(dark.reasons).toContain('explicit_target_scope_required');
    expect(dark.source).toMatchObject({
      kind: 'app_activity',
      enabled: false,
      privateByDefault: true,
      scope: 'explicit_target',
      quietModeBehavior: 'suppress',
      risk: 'high',
    });

    const consented = {
      ...registry,
      sources: registry.sources.map((source) =>
        source.id === 'app-activity'
          ? {
              ...source,
              enabled: true,
              consentReason: 'User enabled live activity awareness for this session.',
              lastReviewedAt: 1200,
            }
          : source,
      ),
    };
    expect(
      checkAoiEnvironmentSourceOperation({
        registry: consented,
        sourceId: 'app-activity',
        operation: 'read_metadata',
      }),
    ).toMatchObject({
      allowed: true,
      reasons: [],
    });
    expect(
      checkAoiEnvironmentSourceOperation({
        registry: consented,
        sourceId: 'app-activity',
        operation: 'summarize',
      }).reasons,
    ).toContain('operation_not_allowed:summarize');
  });

  it('blocks disabled sources and disallowed operations', () => {
    const registry = getDefaultAoiEnvironmentSourceRegistry('aoi/default', 1000);

    expect(
      checkAoiEnvironmentSourceOperation({
        registry,
        sourceId: 'workspace-git',
        operation: 'status',
      }).reasons,
    ).toContain('source_disabled');
    expect(
      checkAoiEnvironmentSourceOperation({
        registry,
        sourceId: 'manual-note',
        operation: 'diff',
      }).reasons,
    ).toContain('operation_not_allowed:diff');
  });
});

describe('Aoi prepared action plan safety policy', () => {
  it('blocks high-risk file work when checkpoint evidence is missing', () => {
    const plan = buildAoiPreviewOnlyFileWorkPreparedActionPlan({
      objective: 'Preview direct file patch for Aoi autonomy',
      risk: 'high',
      affectedSurfaces: ['apps/webuiapps/src/lib/aoiAutonomyExecution.ts'],
      evidenceRefs: ['proposal:file-work-001'],
    });

    expect(plan.status).toBe('blocked');
    expect(plan.blockers).toContain('missing_checkpoint_for_risky_mutation');
    expect(plan.checkpoint).toMatchObject({
      kind: 'manual_checkpoint_required',
      available: false,
      required: true,
    });
  });

  it('allows validation-only plans while requiring approval before command execution', () => {
    const plan = buildAoiValidationCommandPreparedActionPlan({
      objective: 'Run Aoi autonomy validation',
      command:
        'pnpm --filter @openroom/webuiapps test -- src/lib/__tests__/aoiAutonomyPolicy.test.ts',
      evidenceRefs: ['proposal:validation-001'],
    });

    expect(plan.status).toBe('ready');
    expect(plan.risk.commandCapable).toBe(true);
    expect(plan.approval).toMatchObject({
      required: true,
      freshAcceptanceRequired: true,
    });
    expect(plan.validation).toMatchObject({
      required: true,
      approvalRequiredBeforeRun: true,
    });
    expect(plan.checkpoint.kind).toBe('not_applicable');
  });
});

describe('Aoi approved command policy', () => {
  it('allows targeted pnpm tests, filtered build:test, and read-only git checks only', () => {
    expect(
      evaluateAoiApprovedCommandPolicy(
        createAoiApprovedCommandRequest({
          sessionPath: 'aoi/default',
          command:
            'pnpm --filter @openroom/webuiapps test -- src/lib/__tests__/aoiAutonomyPolicy.test.ts',
          cwd: '.',
          purpose: 'Validate Aoi policy changes.',
          risk: 'high',
          requestedAt: 1000,
        }),
      ),
    ).toMatchObject({
      allowed: true,
      program: 'pnpm',
      requiredAutonomyLevel: 'L5',
      cwdLabel: 'workspace root',
    });
    expect(
      evaluateAoiApprovedCommandPolicy(
        createAoiApprovedCommandRequest({
          sessionPath: 'aoi/default',
          command: 'pnpm --filter @openroom/webuiapps build:test',
          requestedAt: 1000,
        }),
      ).allowed,
    ).toBe(true);
    expect(
      evaluateAoiApprovedCommandPolicy(
        createAoiApprovedCommandRequest({
          sessionPath: 'aoi/default',
          command: 'git diff --check',
          requestedAt: 1000,
        }),
      ).allowed,
    ).toBe(true);
  });

  it('blocks destructive, chained, package mutation, secret, network, and background commands', () => {
    const cases = [
      ['Remove-Item src/lib/a.ts', 'destructive_file_operation'],
      ['git status && git diff --check', 'shell_metacharacters'],
      ['pnpm install', 'package_install_or_update'],
      ['git config user.password secret', 'credential_or_secret_command'],
      ['curl -X POST https://example.com', 'network_mutation_command'],
      ['Start-Process pnpm', 'background_process_launch'],
      ['powershell', 'interactive_shell'],
    ] as const;

    for (const [command, reason] of cases) {
      const policy = evaluateAoiApprovedCommandPolicy(
        createAoiApprovedCommandRequest({
          sessionPath: 'aoi/default',
          command,
          requestedAt: 1000,
        }),
      );
      expect(policy.allowed).toBe(false);
      expect(policy.blockReasons).toContain(reason);
    }
  });

  it('blocks command injection through test target arguments', () => {
    const policy = evaluateAoiApprovedCommandPolicy(
      createAoiApprovedCommandRequest({
        sessionPath: 'aoi/default',
        command:
          'pnpm --filter @openroom/webuiapps test -- src/lib/__tests__/aoiAutonomyPolicy.test.ts --watch',
        requestedAt: 1000,
      }),
    );

    expect(policy.allowed).toBe(false);
    expect(policy.blockReasons).toContain('unsafe_test_target');
  });

  it('expires exact command approval and invalidates command, cwd, risk, or purpose changes', () => {
    const approved = evaluateAoiApprovedCommandPolicy(
      createAoiApprovedCommandRequest({
        sessionPath: 'aoi/default',
        command: 'git diff --check',
        cwd: '.',
        purpose: 'Check current diff.',
        risk: 'high',
        requestedAt: 1000,
      }),
    );
    const changed = evaluateAoiApprovedCommandPolicy(
      createAoiApprovedCommandRequest({
        sessionPath: 'aoi/default',
        command: 'git status --short',
        cwd: 'apps/webuiapps',
        purpose: 'Inspect status.',
        risk: 'medium',
        requestedAt: 2000,
      }),
    );

    expect(
      compareAoiApprovedCommandApproval({
        approved,
        current: approved,
        now: 1000 + AOI_COMMAND_APPROVAL_TTL_MS + 1,
      }),
    ).toContain('approval_expired');
    expect(
      compareAoiApprovedCommandApproval({
        approved,
        current: changed,
        now: 2000,
      }),
    ).toEqual(
      expect.arrayContaining([
        'approval_command_changed',
        'approval_cwd_changed',
        'approval_risk_changed',
        'approval_purpose_changed',
      ]),
    );
  });
});

describe('Aoi preference memory model', () => {
  it('does not promote one-off corrections into permanent preferences', () => {
    const evidence = classifyAoiPreferenceEvidence({
      text: 'Actually, that correction was wrong in the previous proposal.',
      sourceRef: 'decision:one-off-correction',
      now: 3000,
    });

    expect(evidence.kind).toBe('one_off_correction');
    expect(
      buildAoiPreferenceMemoryCandidates({
        evidence: [evidence],
        now: 3000,
      }),
    ).toEqual([]);
  });

  it('promotes repeated consistent explicit preferences', () => {
    const first = classifyAoiPreferenceEvidence({
      text: 'I prefer Korean by default. pref:response.language',
      sourceRef: 'episode:first',
      now: 3000,
    });
    const second = classifyAoiPreferenceEvidence({
      text: 'Always answer me in Korean by default. pref:response.language',
      sourceRef: 'episode:second',
      now: 4000,
    });

    const candidates = buildAoiPreferenceMemoryCandidates({
      evidence: [first, second],
      now: 5000,
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      scope: 'user',
      type: 'preference',
    });
    expect(candidates[0].tags).toEqual(
      expect.arrayContaining(['durable-preference', 'repeated-evidence']),
    );
  });

  it('lets project conventions override global preferences with an explainable conflict', () => {
    const resolution = resolveAoiPreferenceContext({
      projectKey: 'youropenroom',
      memories: [
        makePreferenceMemory({
          id: 'global-language',
          content: 'The user prefers Korean by default. pref:response.language',
        }),
        makePreferenceMemory({
          id: 'project-language',
          scope: 'project',
          projectKey: 'youropenroom',
          content:
            'For this project, public-facing README text should be English first. pref:response.language',
          tags: ['preference', 'project-convention', 'pref:response.language'],
        }),
      ],
      now: 5000,
    });

    expect(resolution.active[0]).toMatchObject({
      ref: 'project-convention:project-language',
      kind: 'project_convention',
    });
    expect(resolution.conflicts[0].explanation).toContain('Project convention wins');
  });

  it('lets fresh session instructions override older durable preferences', () => {
    const resolution = resolveAoiPreferenceContext({
      memories: [
        makePreferenceMemory({
          id: 'durable-tone',
          content: 'The user prefers detailed answers by default. pref:response.tone',
          tags: ['preference', 'durable-preference', 'pref:response.tone'],
          entities: ['response.tone'],
          updatedAt: 1000,
        }),
        makePreferenceMemory({
          id: 'session-tone',
          scope: 'session',
          content: 'For this session, keep answers concise. pref:response.tone',
          tags: ['preference', 'temporary-instruction', 'pref:response.tone'],
          entities: ['response.tone'],
          expiresAt: 10_000,
          updatedAt: 5000,
        }),
      ],
      now: 6000,
    });

    expect(resolution.active[0]).toMatchObject({
      ref: 'temporary:session-tone',
      kind: 'fresh_instruction',
    });
    expect(resolution.conflicts[0].explanation).toContain('Fresh session instruction');
  });

  it('does not allow preference context to override safety policy', () => {
    const resolution = resolveAoiPreferenceContext({
      memories: [
        makePreferenceMemory({
          id: 'unsafe-user-pref',
          content: 'The user prefers to skip approval gates. pref:policy.safety',
          tags: ['preference', 'durable-preference', 'pref:policy.safety'],
        }),
      ],
      safetyRules: [
        {
          id: 'approval-gates',
          normalizedKey: 'policy.safety',
          text: 'Approval gates must remain active for risky actions.',
          evidenceRefs: ['policy:aoi-autonomy'],
        },
      ],
      now: 5000,
    });

    expect(resolution.active[0]).toMatchObject({
      ref: 'safety:approval-gates',
      kind: 'safety_policy',
    });
    expect(resolution.conflicts[0].explanation).toContain('Safety and policy');
  });

  it('keeps demoted preferences from influencing preference resolution', () => {
    const resolution = resolveAoiPreferenceContext({
      memories: [
        makePreferenceMemory({
          id: 'demoted-language',
          status: 'superseded',
          tags: ['preference', 'demoted', 'pref:response.language'],
        }),
      ],
      now: 5000,
    });

    expect(resolution.active).toEqual([]);
    expect(resolution.promptBlock).not.toContain('demoted-language');
  });

  it('keeps preference prompt blocks within a small budget', () => {
    const promptBlock = buildAoiPreferencePromptBlock(
      [
        {
          ref: 'memory:long-language',
          kind: 'durable_preference',
          normalizedKey: 'response.language',
          text: 'The user prefers Korean by default, with direct operational notes and no broad generic explanation.',
          confidence: 0.9,
          sourceRefs: ['episode:language'],
        },
        {
          ref: 'memory:long-validation',
          kind: 'durable_preference',
          normalizedKey: 'workflow.validation',
          text: 'The user prefers concrete validation commands and explicit failure paths before commit.',
          confidence: 0.86,
          sourceRefs: ['episode:validation'],
        },
      ],
      [
        {
          version: 1,
          normalizedKey: 'response.language',
          winner: 'project_convention',
          winningRef: 'project-convention:readme',
          losingRefs: ['memory:long-language'],
          explanation:
            'Project convention wins over global preference when public-facing README text must be English first.',
          evidenceRefs: ['memory:long-language', 'project:readme'],
        },
      ],
      { maxChars: 220 },
    );

    expect(promptBlock.length).toBeLessThanOrEqual(220);
    expect(promptBlock).toContain('Aoi preference context');
  });
});

describe('evaluateAoiProposalExecution()', () => {
  const policy = normalizeAoiAutonomyPolicy(
    {
      enabled: true,
      previewMode: true,
      level: 'L4',
    },
    DEFAULT_AOI_AUTONOMY_POLICY,
    2000,
  );
  const acceptDecision: AoiProposalDecision = {
    version: 1,
    id: 'decision-accept-001',
    proposalId: 'proposal-test-001',
    sessionPath: 'aoi/default',
    cooldownKey: 'research:kernel-memory',
    action: 'accept',
    actor: 'user',
    createdAt: 2500,
    previousStatus: 'active',
    nextStatus: 'accepted',
  };

  it('allows accepted read-only research artifact actions at L3', () => {
    const result = evaluateAoiProposalExecution(
      makeProposal({
        status: 'accepted',
        requiredAutonomyLevel: 'L3',
        acceptAction: {
          kind: 'read_research_artifact',
          params: { runId: 'aoi-research-test-001', artifact: 'report' },
        },
      }),
      normalizeAoiAutonomyPolicy({ enabled: true, previewMode: true, level: 'L3' }),
    );

    expect(result).toMatchObject({
      allowed: true,
      readOnly: true,
      actionKind: 'read_research_artifact',
    });
  });

  it('blocks start_research without fresh explicit acceptance', () => {
    const result = evaluateAoiProposalExecution(
      makeProposal({
        status: 'active',
        requiredAutonomyLevel: 'L4',
        suggestedTools: ['start_research'],
        acceptAction: {
          kind: 'start_research',
          params: {
            sessionPath: 'aoi/default',
            request: 'Investigate current ETW research',
            mode: 'standard',
          },
        },
      }),
      policy,
      { now: 3000, decisions: [] },
    );

    expect(result.allowed).toBe(false);
    expect(result.reasons).toContain('missing_fresh_acceptance');
  });

  it('allows start_research after fresh acceptance at L4', () => {
    const result = evaluateAoiProposalExecution(
      makeProposal({
        status: 'accepted',
        requiredAutonomyLevel: 'L4',
        suggestedTools: ['start_research'],
        acceptAction: {
          kind: 'start_research',
          params: {
            sessionPath: 'aoi/default',
            request: 'Investigate current ETW research',
            mode: 'standard',
          },
        },
      }),
      policy,
      { now: 3000, decisions: [acceptDecision] },
    );

    expect(result.allowed).toBe(true);
    expect(result.requiresFreshAcceptance).toBe(true);
  });

  it('requires fresh explicit acceptance for procedure memory promotion', () => {
    const withoutFreshAcceptance = evaluateAoiProposalExecution(
      highRiskProcedureProposalFixture,
      policy,
      { now: 3000, decisions: [] },
    );
    expect(withoutFreshAcceptance.allowed).toBe(false);
    expect(withoutFreshAcceptance.reasons).toContain('missing_fresh_acceptance');

    const withFreshAcceptance = evaluateAoiProposalExecution(
      highRiskProcedureProposalFixture,
      policy,
      {
        now: 3000,
        decisions: [
          {
            ...acceptDecision,
            proposalId: highRiskProcedureProposalFixture.id,
            cooldownKey: highRiskProcedureProposalFixture.cooldownKey,
          },
        ],
      },
    );
    expect(withFreshAcceptance).toMatchObject({
      allowed: true,
      actionKind: 'save_memory',
      requiresFreshAcceptance: true,
    });
  });

  it('requires accepted scoped proposals for supervised Kira handoff', () => {
    const kiraProposal = makeProposal({
      status: 'active',
      requiredAutonomyLevel: 'L4',
      suggestedTools: ['create_kira_work'],
      acceptAction: {
        kind: 'create_kira_work',
        params: {
          projectName: 'YourOpenRoom',
          objective: 'Implement one reviewed Aoi autonomy UI improvement.',
          scope: ['Aoi autonomy UI'],
          modules: ['ChatPanel', 'aoiAutonomyExecution'],
          validationProfile: 'aoi-autonomy',
        },
      },
    });

    const withoutAcceptance = evaluateAoiProposalExecution(kiraProposal, policy, {
      now: 3000,
      decisions: [],
    });
    expect(withoutAcceptance.allowed).toBe(false);
    expect(withoutAcceptance.reasons).toContain('kira_handoff_requires_accepted_proposal');
    expect(withoutAcceptance.reasons).toContain('missing_fresh_acceptance');

    const preview = evaluateAoiProposalExecution({ ...kiraProposal, status: 'accepted' }, policy, {
      now: 3000,
      decisions: [acceptDecision],
      executionMode: 'preview',
    });
    expect(preview).toMatchObject({
      allowed: true,
      actionKind: 'create_kira_work',
      requiresFreshAcceptance: false,
    });

    const execute = evaluateAoiProposalExecution({ ...kiraProposal, status: 'accepted' }, policy, {
      now: 3000,
      decisions: [acceptDecision],
    });
    expect(execute).toMatchObject({
      allowed: true,
      requiresFreshAcceptance: true,
    });
  });

  it('blocks Kira handoff with missing evidence, arbitrary paths, or broad scope', () => {
    const base = makeProposal({
      status: 'accepted',
      requiredAutonomyLevel: 'L4',
      suggestedTools: ['create_kira_work'],
      acceptAction: {
        kind: 'create_kira_work',
        params: {
          projectName: 'YourOpenRoom',
          objective: 'Rewrite the entire repository.',
          scope: ['entire repo'],
          modules: ['Aoi autonomy'],
        },
      },
    });
    const broad = evaluateAoiProposalExecution(base, policy, {
      now: 3000,
      decisions: [acceptDecision],
    });
    expect(broad.reasons).toContain('kira_handoff_scope_too_broad');
    expect(broad.safeAlternative).toContain('Narrow');

    const pathParam = evaluateAoiProposalExecution(
      {
        ...base,
        acceptAction: {
          kind: 'create_kira_work',
          params: {
            projectName: 'F:\\secret\\repo',
            objective: 'Implement one reviewed Aoi autonomy UI improvement.',
            scope: ['Aoi autonomy UI'],
          },
        },
      },
      policy,
      { now: 3000, decisions: [acceptDecision] },
    );
    expect(pathParam.reasons).toContain('action_params_include_filesystem_path');

    const missingEvidence = evaluateAoiProposalExecution(
      {
        ...base,
        evidenceRefs: [],
        acceptAction: {
          kind: 'create_kira_work',
          params: {
            projectName: 'YourOpenRoom',
            objective: 'Implement one reviewed Aoi autonomy UI improvement.',
            scope: ['Aoi autonomy UI'],
          },
        },
      },
      policy,
      { now: 3000, decisions: [acceptDecision] },
    );
    expect(missingEvidence.reasons).toContain('missing_evidence_refs');
  });

  it('blocks file writes, patches, deletes, unsafe commands, unknown actions, missing evidence, and filesystem path params', () => {
    // file_write / file_patch / file_delete are gated-executable: they require
    // L5 plus a fresh, content-addressed approval and a safe relative path. An
    // L4 policy with an absolute path and no approval is still blocked -- but
    // never via unknown_action_kind or the generic filesystem-path guard.
    for (const fileTool of ['file_write', 'file_patch', 'file_delete'] as const) {
      const result = evaluateAoiProposalExecution(
        makeProposal({
          status: 'accepted',
          suggestedTools: [fileTool],
          acceptAction: {
            kind: fileTool,
            params: { path: 'F:\\secret\\out.txt', content: 'x' },
          },
        }),
        policy,
        { now: 3000, decisions: [acceptDecision] },
      );
      expect(result.reasons).toEqual(
        expect.arrayContaining([`tool_blocked:${fileTool}`, 'file_mutation_requires_l5']),
      );
      expect(result.reasons.some((reason) => reason.startsWith('file_mutation_blocked:'))).toBe(
        true,
      );
      expect(result.reasons).not.toContain(`unknown_action_kind:${fileTool}`);
      expect(result.reasons).not.toContain('action_params_include_filesystem_path');
    }

    const unsafeCommand = evaluateAoiProposalExecution(
      makeProposal({
        status: 'accepted',
        risk: 'high',
        requiredAutonomyLevel: 'L5',
        requiresUserApproval: true,
        suggestedTools: ['run_command'],
        acceptAction: {
          kind: 'run_command',
          params: { command: 'Remove-Item src/lib/a.ts', cwd: '.' },
        },
      }),
      { ...policy, level: 'L5' },
      { now: 3000, decisions: [acceptDecision] },
    );
    expect(unsafeCommand.reasons).toEqual(
      expect.arrayContaining([
        'approved_command_blocked:destructive_file_operation',
        'tool_blocked:run_command',
      ]),
    );

    const unknown = evaluateAoiProposalExecution(
      makeProposal({
        status: 'accepted',
        acceptAction: {
          kind: 'remote_shell' as never,
          params: {},
        },
      }),
      policy,
      { now: 3000, decisions: [acceptDecision] },
    );
    expect(unknown.reasons).toContain('unknown_action_kind:remote_shell');

    const missingEvidence = evaluateAoiProposalExecution(
      makeProposal({
        status: 'accepted',
        evidenceRefs: [],
        acceptAction: {
          kind: 'read_research_artifact',
          params: { runId: 'aoi-research-test-001', artifact: 'report' },
        },
      }),
      policy,
      { now: 3000, decisions: [acceptDecision] },
    );
    expect(missingEvidence.reasons).toContain('missing_evidence_refs');
  });
});

describe('checkAoiProposalPolicy()', () => {
  const policy = normalizeAoiAutonomyPolicy(
    {
      enabled: true,
      previewMode: true,
      level: 'L4',
      confidenceFloor: 0.55,
      maxActiveProposals: 4,
    },
    DEFAULT_AOI_AUTONOMY_POLICY,
    2000,
  );

  it('accepts an evidence-backed proposal within the active autonomy level', () => {
    expect(checkAoiProposalPolicy({ policy, proposal: makeProposal() })).toEqual({
      allowed: true,
      reasons: [],
    });
  });

  it('raises the approval bar for a strongly follow-through-suppressed source', () => {
    const strong = checkAoiProposalPolicy({
      policy,
      proposal: makeProposal({ requiresUserApproval: false }),
      followThroughSuppression: -0.12,
    });
    expect(strong.reasons).toContain('follow_through_source_suppressed_requires_approval');

    // Mild suppression does not raise the bar.
    expect(
      checkAoiProposalPolicy({
        policy,
        proposal: makeProposal({ requiresUserApproval: false }),
        followThroughSuppression: -0.05,
      }).reasons,
    ).not.toContain('follow_through_source_suppressed_requires_approval');

    // A proposal that already requires approval is not gated twice.
    expect(
      checkAoiProposalPolicy({
        policy,
        proposal: makeProposal({ requiresUserApproval: true }),
        followThroughSuppression: -0.5,
      }).reasons,
    ).not.toContain('follow_through_source_suppressed_requires_approval');
  });

  it('blocks proposals when autonomy is neither enabled nor in preview mode', () => {
    const disabled = normalizeAoiAutonomyPolicy(
      { enabled: false, previewMode: false, level: 'L4' },
      DEFAULT_AOI_AUTONOMY_POLICY,
      2000,
    );

    expect(
      checkAoiProposalPolicy({ policy: disabled, proposal: makeProposal() }).reasons,
    ).toContain('autonomy_disabled');
  });

  it('blocks low-confidence and evidence-free proposals', () => {
    const result = checkAoiProposalPolicy({
      policy,
      proposal: makeProposal({ confidence: 0.1, evidenceRefs: [] }),
    });

    expect(result.allowed).toBe(false);
    expect(result.reasons).toEqual(
      expect.arrayContaining(['confidence_below_floor', 'missing_evidence_refs']),
    );
  });

  it('blocks duplicate active proposals by cooldown key', () => {
    const result = checkAoiProposalPolicy({
      policy,
      proposal: makeProposal({ id: 'proposal-new-001' }),
      activeProposals: [makeProposal({ id: 'proposal-existing-001' })],
    });

    expect(result.reasons).toContain('duplicate_active_proposal');
  });

  it('uses dismissed and snoozed decisions as cooldown evidence for the same key', () => {
    const recentDecision: AoiProposalDecision = {
      version: 1,
      id: 'decision-test-001',
      proposalId: 'proposal-old-001',
      sessionPath: 'aoi/default',
      cooldownKey: 'research:kernel-memory',
      action: 'dismiss',
      actor: 'user',
      createdAt: 2500,
      previousStatus: 'active',
      nextStatus: 'dismissed',
    };

    const result = checkAoiProposalPolicy({
      policy,
      proposal: makeProposal({ id: 'proposal-new-001' }),
      recentDecisions: [recentDecision],
      now: 3000,
    });

    expect(result.reasons).toContain('cooldown_active');
  });

  it('blocks unknown suggested tools and high-risk proposals without approval', () => {
    const result = checkAoiProposalPolicy({
      policy,
      proposal: makeProposal({
        risk: 'high',
        requiresUserApproval: false,
        suggestedTools: ['remote_shell'],
        requiredAutonomyLevel: 'L5',
      }),
    });

    expect(result.reasons).toEqual(
      expect.arrayContaining([
        'autonomy_level_too_low',
        'tool_blocked:remote_shell',
        'high_risk_requires_approval',
      ]),
    );
  });

  it('reinforces useful proposals without bypassing cooldown checks', () => {
    const usefulDecision = makeFeedbackDecisionFixture({
      action: 'accept',
      nextStatus: 'accepted',
      feedbackCategory: 'useful',
    });
    const tooFrequentDecision = makeFeedbackDecisionFixture({
      id: 'decision-too-frequent-001',
      feedbackCategory: 'too_frequent',
      action: 'snooze',
      nextStatus: 'snoozed',
    });
    const calibrated = applyAoiFeedbackCalibrationToProposal(feedbackMemoryProposalFixture, [
      usefulDecision,
    ]);

    expect(calibrated.confidence).toBe(feedbackMemoryProposalFixture.confidence);
    expect(getAoiProposalFeedbackPriorityBoost(calibrated, [usefulDecision])).toBeGreaterThan(0);
    expect(
      checkAoiProposalPolicy({
        policy,
        proposal: {
          ...calibrated,
          confidence: policy.confidenceFloor - 0.01,
        },
        recentDecisions: [usefulDecision],
        now: 4000,
      }).reasons,
    ).toContain('confidence_below_floor');
    expect(
      checkAoiProposalPolicy({
        policy,
        proposal: calibrated,
        recentDecisions: [tooFrequentDecision],
        now: tooFrequentDecision.createdAt + policy.defaultCooldownMs + 1,
      }).reasons,
    ).toContain('cooldown_active');
  });

  it('penalizes proposals that reuse memory marked as wrong', () => {
    const wrongMemoryDecision = makeFeedbackDecisionFixture({
      feedbackCategory: 'wrong_memory',
    });
    const result = checkAoiProposalPolicy({
      policy: normalizeAoiAutonomyPolicy(
        { enabled: true, previewMode: true, level: 'L4', confidenceFloor: 0.65 },
        DEFAULT_AOI_AUTONOMY_POLICY,
        4000,
      ),
      proposal: feedbackMemoryProposalFixture,
      recentDecisions: [wrongMemoryDecision],
      now: 4000,
    });

    expect(result.reasons).toContain('confidence_below_floor');
  });

  it('prefers refresh proposals after stale-memory feedback', () => {
    const staleDecision = makeFeedbackDecisionFixture({
      feedbackCategory: 'stale',
    });

    expect(
      checkAoiProposalPolicy({
        policy,
        proposal: feedbackMemoryProposalFixture,
        recentDecisions: [staleDecision],
        now: 4000,
      }).reasons,
    ).toContain('stale_memory_requires_refresh');

    expect(
      checkAoiProposalPolicy({
        policy,
        proposal: feedbackRefreshProposalFixture,
        recentDecisions: [staleDecision],
        now: 4000,
      }).reasons,
    ).not.toContain('stale_memory_requires_refresh');
  });

  it('escalates cooldown when proposals are marked too frequent', () => {
    const decisions = [
      makeFeedbackDecisionFixture({
        id: 'decision-too-frequent-001',
        feedbackCategory: 'too_frequent',
        action: 'dismiss',
      }),
      makeFeedbackDecisionFixture({
        id: 'decision-too-frequent-002',
        feedbackCategory: 'too_frequent',
        action: 'snooze',
        nextStatus: 'snoozed',
      }),
    ];

    expect(
      getAoiFeedbackAdjustedCooldownMs({
        proposal: feedbackMemoryProposalFixture,
        recentDecisions: decisions,
        baseCooldownMs: policy.defaultCooldownMs,
      }),
    ).toBe(policy.defaultCooldownMs * 3);
  });

  it('maps proactive timing and evidence feedback into calibration', () => {
    const timingDecisions = [
      makeFeedbackDecisionFixture({
        id: 'decision-too-much-001',
        feedbackCategory: 'too_much',
        action: 'snooze',
        nextStatus: 'snoozed',
      }),
      makeFeedbackDecisionFixture({
        id: 'decision-wrong-timing-001',
        feedbackCategory: 'wrong_timing',
        action: 'snooze',
        nextStatus: 'snoozed',
      }),
    ];
    const wrongEvidenceDecision = makeFeedbackDecisionFixture({
      id: 'decision-wrong-evidence-001',
      feedbackCategory: 'wrong_evidence',
    });

    expect(
      getAoiFeedbackAdjustedCooldownMs({
        proposal: feedbackMemoryProposalFixture,
        recentDecisions: timingDecisions,
        baseCooldownMs: policy.defaultCooldownMs,
      }),
    ).toBe(policy.defaultCooldownMs * 3);
    expect(
      checkAoiProposalPolicy({
        policy: normalizeAoiAutonomyPolicy(
          { enabled: true, previewMode: true, level: 'L4', confidenceFloor: 0.65 },
          DEFAULT_AOI_AUTONOMY_POLICY,
          4000,
        ),
        proposal: feedbackMemoryProposalFixture,
        recentDecisions: [wrongEvidenceDecision],
        now: 4000,
      }).reasons,
    ).toContain('confidence_below_floor');
  });

  it('treats unsafe feedback as risk escalation, never risk reduction', () => {
    const unsafeDecision = makeFeedbackDecisionFixture({
      feedbackCategory: 'unsafe',
    });
    const calibrated = applyAoiFeedbackCalibrationToProposal(feedbackMemoryProposalFixture, [
      unsafeDecision,
    ]);

    expect(calibrated.risk).toBe('medium');
    expect(calibrated.requiresUserApproval).toBe(true);
    expect(compareAoiAutonomyLevel(calibrated.requiredAutonomyLevel, 'L4')).toBeGreaterThanOrEqual(
      0,
    );
  });
});
