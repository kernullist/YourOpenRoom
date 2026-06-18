import React, { useState, useRef, useEffect, useCallback, useMemo, memo } from 'react';
import {
  Archive,
  Settings,
  Trash2,
  RotateCcw,
  Minus,
  Maximize2,
  ZoomIn,
  ZoomOut,
  ChevronDown,
  ChevronRight,
  Pencil,
  List,
  PanelLeft,
  PanelRight,
  GripVertical,
  Plus,
  ImagePlus,
  Square,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import {
  chat,
  checkCodexAuthStatus,
  checkClaudeCliConnection,
  fetchCurrentModelUsage,
  getCodexAuthDeviceLoginStatus,
  loadConfig,
  loadConfigSync,
  resolveLlmOverride,
  saveConfig,
  startCodexAuthDeviceLogin,
  SUPPORTED_CHAT_IMAGE_MIME_TYPES,
  supportsChatImageAttachments,
  type CodexAuthDeviceLoginSession,
  type CodexAuthStatusResult,
  type ClaudeCliConnectionCheckResult,
  type ChatImageAttachment,
  type ChatMessage,
  type CurrentModelUsageStatus,
} from '@/lib/llmClient';
import { parseDirectMusicIntent } from '@/lib/chatDirectActions';
import {
  LLM_REASONING_EFFORTS,
  LLM_REASONING_SUMMARIES,
  LLM_VERBOSITIES,
  PROVIDER_MODELS,
  getDefaultProviderConfig,
  getModelInfo,
  getProviderDisplayName,
  isDeepSeekProvider,
  type LLMApiStyle,
  type LLMConfig,
  type LLMProvider,
  type LLMReasoningEffort,
  type LLMReasoningSummary,
  type LLMVerbosity,
} from '@/lib/llmModels';
import {
  loadImageGenConfig,
  loadImageGenConfigSync,
  saveImageGenConfig,
  getDefaultImageGenConfig,
  type ImageGenConfig,
  type ImageGenProvider,
} from '@/lib/imageGenClient';
import {
  getAppActionToolDefinition,
  resolveAppAction,
  getListAppsToolDefinition,
  executeListApps,
  APP_REGISTRY,
  loadActionsFromMeta,
  describeAppActionResultForModel,
  formatAppReference,
  getOsActionTargetApp,
} from '@/lib/appRegistry';
import { parseAppActionToolParams } from '@/lib/appActionParams';
import { shouldSuppressUserActionConversation } from '@/lib/chatActionSuppression';
import { seedMetaFiles } from '@/lib/seedMeta';
import { dispatchAgentAction, onUserAction } from '@/lib/vibeContainerMock';
import { closeAllWindows, getWindows } from '@/lib/windowManager';
import { getFileToolDefinitions, isFileTool, executeFileTool } from '@/lib/fileTools';
import { setSessionPath } from '@/lib/sessionPath';
import {
  getMemoryToolDefinitions,
  isMemoryTool,
  executeMemoryTool,
  loadMemories,
  saveMemory,
  buildMemoryPrompt,
  type MemoryEntry,
} from '@/lib/memoryManager';
import {
  archiveAoiMemory,
  buildAoiMemoryPrompt,
  deleteAoiMemory,
  demoteAoiPreferenceMemory,
  loadAoiMemories,
  markAoiMemoryTemporary,
  saveAoiManualMemory,
  saveAoiPreferenceMemory,
  shouldTreatAoiMemoryAsPermanent,
  syncAoiMemoryFromTurn,
  type AoiMemoryEntry,
  type AoiMemoryEpisodeSource,
  type AoiMemoryType,
} from '@/lib/aoiMemoryManager';
import { logger } from '@/lib/logger';
import {
  condenseConversationHistory,
  resolveAoiActionConfirmationRequest,
  resolveAoiResearchConfirmationRequest,
  shouldEnableAppTools,
  shouldUseAoiResearchRun,
  shouldUseDialogModel,
  shouldUseWebSearch,
  summarizeToolResultForModel,
} from '@/lib/chatTokenControl';
import { parseChatMessageContent } from '@/lib/chatMessageLinks';
import {
  buildPromptBudgetSnapshot,
  summarizePromptBudget,
  type PromptBudgetEntry,
} from '@/lib/promptBudget';
import {
  getImageGenToolDefinitions,
  isImageGenTool,
  executeImageGenTool,
} from '@/lib/imageGenTools';
import {
  DEFAULT_TAVILY_BASE_URL,
  loadTavilyConfig,
  loadTavilyConfigSync,
  type TavilyConfig,
} from '@/lib/tavilyClient';
import { executeTavilyTool, getTavilyToolDefinitions, isTavilyTool } from '@/lib/tavilyTools';
import {
  executeAoiResearchTool,
  getAoiResearchToolDefinitions,
  getAoiResearchToolPendingSummary,
  isAoiResearchTool,
} from '@/lib/aoiResearchTools';
import { buildAoiResearchStartAckMessage, type AoiResearchAckLanguage } from '@/lib/aoiResearchAck';
import {
  executeWorkspaceTool,
  getWorkspaceToolDefinitions,
  isWorkspaceTool,
} from '@/lib/workspaceTools';
import {
  executeAppSchemaTool,
  getAppSchemaToolDefinitions,
  isAppSchemaTool,
} from '@/lib/appSchemaTools';
import {
  executeIdeTool,
  getIdeToolDefinitions,
  getIdeToolPendingSummary,
  isIdeMutationTool,
  isIdeTool,
} from '@/lib/ideTools';
import {
  executeSemanticTool,
  getSemanticToolDefinitions,
  isSemanticTool,
} from '@/lib/semanticTools';
import { executeCommandTool, getCommandToolDefinitions, isCommandTool } from '@/lib/commandTools';
import { executeUrlTool, getUrlToolDefinitions, isUrlTool } from '@/lib/urlTools';
import {
  executeAppStateTool,
  getAppStateToolDefinitions,
  isAppStateTool,
} from '@/lib/appStateTools';
import { canParallelizeToolBatch } from '@/lib/toolBatching';
import { executePreviewTool, getPreviewToolDefinitions, isPreviewTool } from '@/lib/previewTools';
import { executeUndoTool, getUndoToolDefinitions, isUndoTool } from '@/lib/undoTools';
import {
  executeDiagnosticsTool,
  getDiagnosticsToolDefinitions,
  isDiagnosticsTool,
} from '@/lib/diagnosticsTools';
import { executeSymbolTool, getSymbolToolDefinitions, isSymbolTool } from '@/lib/symbolTools';
import {
  executeCheckpointTool,
  getCheckpointToolDefinitions,
  isCheckpointTool,
} from '@/lib/checkpointTools';
import {
  executeAutofixMacroTool,
  getAutofixMacroToolDefinitions,
  isAutofixMacroTool,
} from '@/lib/autofixMacroTools';
import {
  executeBackgroundWatchTool,
  getBackgroundWatchToolDefinitions,
  isBackgroundWatchTool,
  listBackgroundWatches,
  pollBackgroundWatches,
} from '@/lib/backgroundWatchTools';
import { createToolResultCache } from '@/lib/toolResultCache';
import { listRecentMutations } from '@/lib/toolMutationHistory';
import {
  loadToolSafetyPolicy,
  saveToolSafetyPolicy,
  type ToolSafetyPolicy,
} from '@/lib/toolSafetyPolicy';
import {
  AOI_DEFAULT_CAPABILITY_NAMES,
  buildAoiCapabilityPrompt,
  getAoiCapabilityRows,
  summarizeAoiCapabilityRegistry,
} from '@/lib/aoiCapabilityRegistry';
import {
  appendAoiRunLedgerEvent,
  buildAoiRunGoalPrompt,
  createAoiRunGoalFromMessage,
  createAoiRunLedgerEntry,
  finalizeAoiRunLedgerEntry,
  loadAoiRunLedger,
  saveAoiRunLedger,
  summarizeAoiRunLedger,
  upsertAoiRunLedgerEntry,
  type AoiRunLedgerEntry,
} from '@/lib/aoiRunLedger';
import {
  decideAoiGoal,
  decideAoiMission,
  decideAoiProposal,
  executeAoiProposalAction,
  fetchAoiAutonomyDashboard,
  fetchAoiProposalDecisions,
  fetchAoiContextRouter,
  fetchAoiMissionState,
  previewAoiProposalAction,
  recordAoiContextSourceFeedback,
  recordAoiOperatorVoiceDecision,
  recordAoiProposalFeedback,
  resetAoiTrustCalibrationCategory,
  runAoiAutonomyManualWakeup,
  runAoiAutonomySessionOpenWakeup,
  updateAoiEnvironmentSource,
  updateAoiAutonomyPolicy,
  type AoiAutonomyProposalPreviewResult,
  type AoiAutonomyProposalExecutionResult,
} from '@/lib/aoiAutonomyClient';
import {
  AOI_AUTONOMY_UI_LEVELS,
  buildAoiBlockedStateSummary,
  buildAoiBlockedProactiveExplanation,
  buildAoiAutonomySchedulerPanelSummary,
  buildAoiAutonomyNotificationBadge,
  buildAoiContextSourcePanelSummaries,
  buildAoiEnvironmentSourcePanelSummaries,
  buildAoiMissionPanelSummary,
  buildAoiMissionResumePrompt,
  buildAoiOperatorDigestPanelSummary,
  buildAoiOperatorHealthPanelSummary,
  buildAoiPlaybookPanelSummary,
  buildAoiApprovedCommandPanelSummary,
  buildAoiPreferenceInfluencePanelSummary,
  buildAoiPreparedActionPlanPanelSummary,
  buildAoiProposalActionPresentation,
  buildAoiProposalInspectorSummary,
  buildAoiProactiveExplanation,
  buildAoiRecoveryPreviewSummary,
  buildAoiWorkspaceSignalPanelSummary,
  canShowAoiProposalPrimaryAction,
  loadAoiAutonomyPanelSettings,
  sanitizeAoiProposalDisplayText,
  saveAoiAutonomyPanelSettings,
  selectAoiInlineProposal,
  summarizeAoiAutonomyProposalCounts,
  type AoiAutonomyPanelSettings,
} from '@/lib/aoiAutonomyUi';
import { buildAoiOperatorDigest } from '@/lib/aoiOperatorDigest';
import { compareAoiAutonomyLevel, isAoiToolAllowedAtLevel } from '@/lib/aoiAutonomyPolicy';
import type {
  AoiAutonomyBlockedProposal,
  AoiCalibrationDimension,
  AoiAutonomyLevel,
  AoiAutonomyPolicy,
  AoiAutonomySchedulerState,
  AoiAutonomyStatus,
  AoiContextRouterResult,
  AoiEnvironmentSource,
  AoiEnvironmentSourceRegistry,
  AoiGoal,
  AoiMissionDecisionAction,
  AoiMissionState,
  AoiOperatorDigest,
  AoiOperatorHealthState,
  AoiOperatorVoiceEventCategory,
  AoiOperatorVoicePolicy,
  AoiApprovedCommandPolicy,
  AoiApprovedCommandResult,
  AoiPreparedActionPlan,
  AoiPlaybook,
  AoiProposal,
  AoiProposalDecision,
  AoiProposalDecisionAction,
  AoiProposalFeedbackCategory,
  AoiVoiceRenderDecision,
  AoiWorkspaceSnapshot,
} from '@/lib/aoiAutonomyTypes';
import {
  AOI_OPERATOR_VOICE_CATEGORY_LABELS,
  buildAoiOperatorVoiceEventFromDigest,
  buildAoiOperatorVoicePanelSummary,
  decideAoiOperatorVoiceRender,
  normalizeAoiOperatorVoicePolicy,
} from '@/lib/aoiOperatorVoice';
import { buildAoiPreparedActionPlan } from '@/lib/aoiSafeActionPlan';
import {
  createAoiApprovedCommandRequest,
  evaluateAoiApprovedCommandPolicy,
} from '@/lib/aoiApprovedCommandPolicy';
import type { AoiAutonomyEvaluationResult } from '@/lib/aoiAutonomyEvaluation';
import {
  buildAoiSkillsPrompt,
  createUserAoiWorkshopSkill,
  loadAoiSkillsWorkshop,
  removeAoiWorkshopSkill,
  resolveAoiActiveSkills,
  saveAoiSkillsWorkshop,
  summarizeAoiSkillsWorkshop,
  updateAoiWorkshopSkill,
  upsertAoiWorkshopSkill,
  type AoiWorkshopSkill,
} from '@/lib/aoiSkillsWorkshop';
import {
  applyAoiMcpPluginHealthCheckResult,
  buildAoiMcpPluginPrompt,
  createUserAoiMcpPluginEntry,
  isAoiMcpPluginTrustLocked,
  loadAoiMcpPluginAdmin,
  probeAoiMcpPluginEndpoint,
  removeAoiMcpPluginEntry,
  saveAoiMcpPluginAdmin,
  summarizeAoiMcpPluginAdmin,
  updateAoiMcpPluginEntry,
  upsertAoiMcpPluginEntry,
  type AoiMcpPluginEntry,
  type AoiMcpPluginKind,
} from '@/lib/aoiMcpPluginAdmin';
import { createAppFileApi } from '@/lib/fileApi';
import {
  loadConversationPreferencesSync,
  loadPersistedConfig,
  normalizeResponseLanguageMode,
  loadUserProfileConfigSync,
  normalizeUserProfileDisplayName,
  saveConversationPreferences,
  saveUserProfileConfig,
  type ConversationPreferencesConfig,
  type DialogLlmConfig,
  type IdaPeConfig,
  type KiraAgentApiStyle,
  type KiraAgentProvider,
  type KiraConfig,
  type KiraRoleLlmConfig,
  type ResponseLanguageMode,
  type UserProfileConfig,
} from '@/lib/configPersistence';
import {
  OPEN_APP_SETTINGS_EVENT,
  dispatchAppSettingsSaved,
  type AppSettingsTabKey,
  type OpenAppSettingsDetail,
} from '@/lib/settingsEvents';
import {
  getAoiTtsStatusSnapshot,
  playAoiTtsMessage,
  prewarmAoiTtsCommonPhrases,
  prewarmAoiTtsLines,
  subscribeAoiTtsStatus,
  stopAoiTtsPlayback,
  type AoiTtsStatusSnapshot,
} from '@/lib/aoiTts';
import {
  loadChatHistory,
  loadChatHistorySync,
  saveChatHistory,
  clearChatHistory,
  buildSessionPath,
  type ChatHistoryData,
  type DisplayMessage,
} from '@/lib/chatHistoryStorage';
import {
  type CharacterConfig,
  type CharacterCollection,
  DEFAULT_COLLECTION as DEFAULT_CHAR_COLLECTION,
  loadCharacterCollection,
  loadCharacterCollectionSync,
  saveCharacterCollection,
  getActiveCharacter,
  getCharacterPromptContext,
  resolveEmotionMedia,
  clearEmotionVideoCache,
} from '@/lib/characterManager';
import {
  ModManager,
  type ModCollection,
  DEFAULT_MOD_COLLECTION,
  loadModCollection,
  loadModCollectionSync,
  saveModCollection,
  getActiveModEntry,
} from '@/lib/modManager';
import CharacterPanel from './CharacterPanel';
import ModPanel from './ModPanel';
import styles from './index.module.scss';

// ---------------------------------------------------------------------------
// Extended DisplayMessage with character-specific fields
// ---------------------------------------------------------------------------

interface CharacterDisplayMessage extends DisplayMessage {
  emotion?: string;
  suggestedReplies?: string[];
  toolCalls?: string[]; // collapsed tool call summaries
}

interface ChatLoadingInfo {
  startedAt: number;
  status: string;
  cancellable: boolean;
  provider?: LLMProvider;
  model?: string;
}

interface ConversationRunOptions {
  signal?: AbortSignal;
  onStatus?: (status: string) => void;
}

const MAX_PROMPT_BUDGET_ENTRIES = 10;

type ChatDockSide = 'left' | 'right';

const CHAT_DOCK_SIDE_KEY = 'openroom-chat-dock-side';
const CHAT_DOCK_SIDE_EVENT = 'openroom-chat-dock-side-changed';
const CHAT_PANEL_WIDTH_KEY = 'openroom-chat-panel-width';
const CHAT_PANEL_WIDTH_EVENT = 'openroom-chat-panel-width-changed';
const CHAT_FONT_SIZE_KEY = 'openroom-chat-font-size';
const AOI_OPERATOR_LAST_SEEN_STORAGE_PREFIX = 'openroom-aoi-operator-last-seen:';
const CHAT_PANEL_FULL_WIDTH_DEFAULT = 960;
const CHAT_PANEL_FULL_WIDTH_MIN = 780;
const CHAT_PANEL_FULL_WIDTH_MAX = 1320;
const CHAT_PANEL_COMPACT_WIDTH_DEFAULT = 420;
const CHAT_PANEL_COMPACT_WIDTH_MIN = 360;
const CHAT_PANEL_COMPACT_WIDTH_MAX = 760;
const CHAT_FONT_SIZE_DEFAULT = 13;
const CHAT_FONT_SIZE_MIN = 11;
const CHAT_FONT_SIZE_MAX = 22;
const CHAT_FONT_SIZE_STEP = 1;
const MAX_CHAT_IMAGE_ATTACHMENTS = 4;
const MAX_CHAT_IMAGE_BYTES = 8 * 1024 * 1024;
const MODEL_USAGE_REFRESH_INTERVAL_MS = 10 * 60 * 1000;
const ACTION_QUEUE_CONVERSATION_TIMEOUT_MS = 45_000;

interface CalendarReminderEvent {
  id: string;
  title: string;
  notes: string;
  startAt: string;
  remindBeforeMinutes: number;
  completed: boolean;
  createdAt: number;
  updatedAt: number;
  lastReminderSentAt?: number;
}

interface ReminderMessagePayload {
  content: string;
  emotion?: string;
  replies: string[];
}

interface KiraAutomationEvent {
  id: string;
  workId: string;
  title: string;
  projectName: string;
  message: string;
  createdAt: number;
  type: 'started' | 'resumed' | 'completed' | 'needs_attention' | 'steered' | 'interrupted';
}

const calendarReminderFileApi = createAppFileApi('calendar');
const CALENDAR_REMINDER_POLL_INTERVAL_MS = 30_000;
const CALENDAR_REMINDER_GRACE_MS = 60_000;
const KIRA_AUTOMATION_POLL_INTERVAL_MS = 10_000;
const KIRA_APP_ID = 18;
const IDE_APP_ID = 19;
const PE_ANALYST_APP_ID = 20;
const KIRA_AUTOMATION_NOTICE_EVENT = 'openroom-kira-automation-notice';
const YOUTUBE_APP_ID = 3;

async function triggerKiraAutomationScan(sessionPath: string): Promise<void> {
  await fetch('/api/kira-automation/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionPath }),
  });
}

async function drainKiraAutomationEvents(sessionPath: string): Promise<KiraAutomationEvent[]> {
  const res = await fetch(
    `/api/kira-automation/events?sessionPath=${encodeURIComponent(sessionPath)}`,
  );
  if (!res.ok) throw new Error(`Kira automation event API error ${res.status}`);
  const data = (await res.json()) as { events?: KiraAutomationEvent[] };
  return Array.isArray(data.events)
    ? data.events.filter((event) => !isRecoverableKiraAutomationLockNotice(event))
    : [];
}

function isRecoverableKiraAutomationLockNotice(event: KiraAutomationEvent): boolean {
  return (
    event.title === 'Kira automation scan' &&
    event.type === 'needs_attention' &&
    /\b(EACCES|EBUSY|EEXIST|ENOENT|ENOTDIR|EPERM)\b/i.test(event.message) &&
    /\b(?:automation-locks|kira-automation-locks)\b/i.test(event.message)
  );
}

function hasPersistedConversation(data: ChatHistoryData | null): boolean {
  const messages = data?.messages ?? [];
  const history = data?.chatHistory ?? [];
  return messages.length > 0 || history.length > 0;
}

function clampChatFontSize(value: number): number {
  return Math.min(CHAT_FONT_SIZE_MAX, Math.max(CHAT_FONT_SIZE_MIN, value));
}

function loadChatFontSize(): number {
  try {
    const raw = localStorage.getItem(CHAT_FONT_SIZE_KEY);
    if (raw !== null) {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) {
        return clampChatFontSize(parsed);
      }
    }
  } catch {
    // ignore persistence failures
  }

  return CHAT_FONT_SIZE_DEFAULT;
}

function getChatPanelWidthStorageKey(compact: boolean): string {
  return `${CHAT_PANEL_WIDTH_KEY}:${compact ? 'compact' : 'full'}`;
}

function getChatPanelWidthBounds(
  compact: boolean,
  viewportWidth = typeof window !== 'undefined'
    ? window.innerWidth || document.documentElement.clientWidth
    : 1024,
): { min: number; max: number } {
  const configuredMin = compact ? CHAT_PANEL_COMPACT_WIDTH_MIN : CHAT_PANEL_FULL_WIDTH_MIN;
  const configuredMax = compact ? CHAT_PANEL_COMPACT_WIDTH_MAX : CHAT_PANEL_FULL_WIDTH_MAX;
  const viewportMax = Math.max(280, viewportWidth - 32);
  const min = Math.min(configuredMin, viewportMax);
  const max = Math.max(min, Math.min(configuredMax, viewportMax));
  return { min, max };
}

function clampChatPanelWidth(width: number, compact: boolean): number {
  const { min, max } = getChatPanelWidthBounds(compact);
  return Math.round(Math.min(max, Math.max(min, width)));
}

function loadChatPanelWidth(compact: boolean): number {
  const fallback = compact ? CHAT_PANEL_COMPACT_WIDTH_DEFAULT : CHAT_PANEL_FULL_WIDTH_DEFAULT;
  try {
    const raw = localStorage.getItem(getChatPanelWidthStorageKey(compact));
    if (raw !== null) {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) {
        return clampChatPanelWidth(parsed, compact);
      }
    }
  } catch {
    // ignore persistence failures
  }

  return clampChatPanelWidth(fallback, compact);
}

function formatAttachmentSize(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function formatUsageNumber(value: number): string {
  if (Number.isInteger(value)) {
    return String(value);
  }
  return value.toFixed(1).replace(/\.0$/, '');
}

function formatCurrentModelUsageLabel(
  usageStatus: CurrentModelUsageStatus | null,
  config: LLMConfig | null,
): string {
  if (!config) {
    return 'Weekly usage - configure a model first';
  }
  if (!usageStatus) {
    return `${getProviderDisplayName(config.provider)} / ${config.model} - checking weekly usage`;
  }

  const providerLabel = getProviderDisplayName(usageStatus.provider);
  const modelLabel = usageStatus.model || config.model;
  const usage = usageStatus.usage;
  if (usageStatus.status === 'available' && usage) {
    const usageParts: string[] = [];
    if (typeof usage.percent === 'number' && Number.isFinite(usage.percent)) {
      usageParts.push(`${Math.round(usage.percent)}%`);
    }
    if (
      typeof usage.used === 'number' &&
      Number.isFinite(usage.used) &&
      typeof usage.limit === 'number' &&
      Number.isFinite(usage.limit)
    ) {
      usageParts.push(
        `${formatUsageNumber(usage.used)}/${formatUsageNumber(usage.limit)}${
          usage.unit ? ` ${usage.unit}` : ''
        }`,
      );
    } else if (typeof usage.remaining === 'number' && Number.isFinite(usage.remaining)) {
      usageParts.push(
        `${formatUsageNumber(usage.remaining)}${usage.unit ? ` ${usage.unit}` : ''} left`,
      );
    }
    if (usage.resetAt) {
      usageParts.push(`resets ${usage.resetAt}`);
    }
    return `${providerLabel} / ${modelLabel} - weekly usage ${
      usageParts.join(' - ') || 'available'
    }`;
  }

  if (usageStatus.status === 'error') {
    return `${providerLabel} / ${modelLabel} - weekly usage check failed`;
  }

  return `${providerLabel} / ${modelLabel} - weekly usage unavailable`;
}

function formatCurrentModelUsageTitle(usageStatus: CurrentModelUsageStatus | null): string {
  if (!usageStatus) {
    return 'Checking current model weekly account usage.';
  }
  const parts = [
    usageStatus.message,
    usageStatus.account?.authMethod ? `Auth: ${usageStatus.account.authMethod}` : null,
    usageStatus.account?.label ? `Account: ${usageStatus.account.label}` : null,
    usageStatus.source ? `Source: ${usageStatus.source}` : null,
    usageStatus.refreshedAt
      ? `Refreshed: ${new Date(usageStatus.refreshedAt).toLocaleString()}`
      : null,
  ].filter((part): part is string => Boolean(part));
  return parts.join('\n') || 'Current model weekly account usage.';
}

function isAoiExecutableActionKind(kind: string | undefined): boolean {
  return (
    kind === 'open_research_artifact' ||
    kind === 'read_research_artifact' ||
    kind === 'get_research_status' ||
    kind === 'start_research' ||
    kind === 'create_kira_work' ||
    kind === 'run_command' ||
    kind === 'save_memory'
  );
}

function canExecuteAoiProposalAtCurrentLevel(
  proposal: AoiProposal,
  policy: AoiAutonomyPolicy | null,
): boolean {
  const actionKind = proposal.acceptAction?.kind;
  if (
    !policy ||
    proposal.status !== 'accepted' ||
    !isAoiExecutableActionKind(actionKind) ||
    proposal.evidenceRefs.length === 0 ||
    proposal.blockedReason ||
    compareAoiAutonomyLevel(policy.level, proposal.requiredAutonomyLevel) < 0
  ) {
    return false;
  }

  if (actionKind === 'run_command') {
    if (compareAoiAutonomyLevel(policy.level, 'L5') < 0) {
      return false;
    }
    return evaluateAoiApprovedCommandPolicy(
      createAoiApprovedCommandRequest({
        sessionPath: proposal.sessionPath,
        proposalId: proposal.id,
        command: proposal.acceptAction?.params.command,
        cwd: proposal.acceptAction?.params.cwd ?? proposal.acceptAction?.params.directory,
        purpose: proposal.acceptAction?.params.purpose ?? proposal.title,
        risk: proposal.risk,
        timeoutMs:
          proposal.acceptAction?.params.timeoutMs ?? proposal.acceptAction?.params.timeout_ms,
        requestedAt: Date.now(),
        evidenceRefs: [...proposal.evidenceRefs, ...proposal.artifactRefs],
      }),
    ).allowed;
  }

  const tools = new Set<string>(proposal.suggestedTools);
  tools.add(actionKind);
  return [...tools].every((tool) => isAoiToolAllowedAtLevel(tool, policy.level));
}

function getAoiProposalGoalId(proposal: AoiProposal): string | null {
  const refs = [...proposal.evidenceRefs, ...proposal.artifactRefs];
  const goalRef = refs.find((ref) => /^goal:[^/]+$/.test(ref));
  return goalRef ? goalRef.slice('goal:'.length) : null;
}

const AOI_PROPOSAL_FEEDBACK_CONTROLS: Array<{
  label: string;
  title: string;
  action: Extract<AoiProposalDecisionAction, 'accept' | 'dismiss' | 'snooze'>;
  category: AoiProposalFeedbackCategory;
}> = [
  {
    label: 'Useful',
    title: 'Mark this proactive suggestion as useful',
    action: 'accept',
    category: 'useful',
  },
  {
    label: 'Too much',
    title: 'Snooze this suggestion because it is too much',
    action: 'snooze',
    category: 'too_much',
  },
  {
    label: 'Wrong timing',
    title: 'Snooze this suggestion because the timing is wrong',
    action: 'snooze',
    category: 'wrong_timing',
  },
  {
    label: 'Wrong evidence',
    title: 'Dismiss this suggestion because the evidence is wrong',
    action: 'dismiss',
    category: 'wrong_evidence',
  },
  {
    label: 'Wrong source',
    title: 'Dismiss this suggestion because the source selection is wrong',
    action: 'dismiss',
    category: 'wrong_source',
  },
  {
    label: 'Unsafe',
    title: 'Dismiss this suggestion as unsafe for future calibration',
    action: 'dismiss',
    category: 'unsafe',
  },
];

function summarizeAoiExecutionResult(result: AoiAutonomyProposalExecutionResult): string {
  if (result.executed) {
    const kind =
      result.result && typeof result.result.kind === 'string' ? result.result.kind : 'proposal';
    if (kind === 'start_research') {
      const run = result.result?.run as { id?: unknown; status?: unknown } | undefined;
      const runId = typeof run?.id === 'string' ? run.id : 'new run';
      const status = typeof run?.status === 'string' ? run.status : 'started';
      return `Execution completed: started research ${runId} (${status}).`;
    }
    if (kind === 'read_research_artifact') {
      const artifact =
        result.result && typeof result.result.artifact === 'string'
          ? result.result.artifact
          : 'artifact';
      const truncated = result.result?.truncated === true ? ' Preview was capped.' : '';
      return `Execution completed: read ${artifact}.${truncated}`;
    }
    if (kind === 'get_research_status') {
      return 'Execution completed: read research status.';
    }
    if (kind === 'open_research_artifact') {
      return 'Execution completed: prepared artifact open payload.';
    }
    if (kind === 'save_memory') {
      const target = typeof result.result?.target === 'string' ? result.result.target : 'memory';
      if (target === 'skill') {
        return 'Execution completed: promoted procedure as an untrusted user skill draft.';
      }
      return 'Execution completed: promoted procedure memory.';
    }
    if (kind === 'create_kira_work') {
      const work = result.result?.work as { id?: unknown; title?: unknown } | undefined;
      const workId = typeof work?.id === 'string' ? work.id : 'new work item';
      const title = typeof work?.title === 'string' ? `: ${work.title}` : '';
      return `Execution completed: created Kira work item ${workId}${title}.`;
    }
    if (kind === 'run_command') {
      const commandResult = result.result?.commandResult as
        | { ok?: unknown; exitCode?: unknown; durationMs?: unknown; timedOut?: unknown }
        | undefined;
      const exitCode =
        typeof commandResult?.exitCode === 'number' ? commandResult.exitCode : 'unknown';
      const duration =
        typeof commandResult?.durationMs === 'number' ? ` in ${commandResult.durationMs}ms` : '';
      const status = commandResult?.ok === true ? 'passed' : 'finished';
      const timeout = commandResult?.timedOut === true ? ' (timed out)' : '';
      return `Execution completed: approved command ${status} with exit ${exitCode}${duration}${timeout}.`;
    }
    return 'Execution completed.';
  }
  const reason = result.reasons.length > 0 ? result.reasons.join(', ') : result.outcome;
  return `Execution ${result.outcome}: ${reason}`;
}

function getAoiKiraHandoffPreview(
  previewResult: AoiAutonomyProposalPreviewResult | undefined,
): Record<string, unknown> | null {
  const preview = previewResult?.result?.preview;
  return preview && typeof preview === 'object' && !Array.isArray(preview)
    ? (preview as Record<string, unknown>)
    : null;
}

function getAoiPreparedActionPlan(
  proposal: AoiProposal,
  previewResult: AoiAutonomyProposalPreviewResult | undefined,
): AoiPreparedActionPlan {
  return (
    previewResult?.preparedActionPlan ??
    previewResult?.result?.preparedActionPlan ??
    buildAoiPreparedActionPlan(proposal)
  );
}

function getAoiApprovedCommandPolicy(
  proposal: AoiProposal,
  previewResult: AoiAutonomyProposalPreviewResult | undefined,
): AoiApprovedCommandPolicy | undefined {
  if (proposal.acceptAction?.kind !== 'run_command') {
    return undefined;
  }
  return (
    previewResult?.approvedCommandPolicy ??
    previewResult?.result?.approvedCommandPolicy ??
    evaluateAoiApprovedCommandPolicy(
      createAoiApprovedCommandRequest({
        sessionPath: proposal.sessionPath,
        proposalId: proposal.id,
        command: proposal.acceptAction.params.command,
        cwd: proposal.acceptAction.params.cwd ?? proposal.acceptAction.params.directory,
        purpose: proposal.acceptAction.params.purpose ?? proposal.title,
        risk: proposal.risk,
        timeoutMs:
          proposal.acceptAction.params.timeoutMs ?? proposal.acceptAction.params.timeout_ms,
        requestedAt: Date.now(),
        evidenceRefs: [...proposal.evidenceRefs, ...proposal.artifactRefs],
      }),
    )
  );
}

function getAoiApprovedCommandResult(
  previewResult: AoiAutonomyProposalPreviewResult | undefined,
): AoiApprovedCommandResult | undefined {
  const result = previewResult?.result?.commandResult;
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return undefined;
  }
  const commandResult = result as Partial<AoiApprovedCommandResult>;
  return commandResult.version === 1 && typeof commandResult.command === 'string'
    ? (commandResult as AoiApprovedCommandResult)
    : undefined;
}

function getPreviewText(preview: Record<string, unknown>, key: string): string {
  const value = preview[key];
  return typeof value === 'string' ? value : '';
}

function getPreviewList(preview: Record<string, unknown>, key: string): string[] {
  const value = preview[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function makeImageAttachmentId(): string {
  return `chat_img_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function isSupportedImageFile(file: File): boolean {
  return SUPPORTED_CHAT_IMAGE_MIME_TYPES.has(file.type.toLowerCase());
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
      } else {
        reject(new Error('Failed to read image data.'));
      }
    };
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read image data.'));
    reader.readAsDataURL(file);
  });
}

function readImageDimensions(dataUrl: string): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      resolve({ width: image.naturalWidth, height: image.naturalHeight });
    };
    image.onerror = () => resolve(null);
    image.src = dataUrl;
  });
}

async function fileToChatImageAttachment(file: File): Promise<ChatImageAttachment> {
  if (!isSupportedImageFile(file)) {
    throw new Error('Only PNG, JPEG, WebP, and GIF images are supported.');
  }
  if (file.size > MAX_CHAT_IMAGE_BYTES) {
    throw new Error(`Image is too large. Limit is ${formatAttachmentSize(MAX_CHAT_IMAGE_BYTES)}.`);
  }

  const dataUrl = await readFileAsDataUrl(file);
  const dimensions = await readImageDimensions(dataUrl);
  return {
    id: makeImageAttachmentId(),
    type: 'image',
    name: file.name || 'pasted-image.png',
    mimeType: file.type,
    dataUrl,
    size: file.size,
    ...(dimensions ? dimensions : {}),
  };
}

function getClipboardImageFiles(dataTransfer: DataTransfer): File[] {
  const files: File[] = [];
  for (const item of Array.from(dataTransfer.items ?? [])) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (file && file.type.startsWith('image/')) {
      files.push(file);
    }
  }
  if (files.length > 0) return files;
  return Array.from(dataTransfer.files ?? []).filter((file) => file.type.startsWith('image/'));
}

function describeImageAttachmentsForMemory(attachments: ChatImageAttachment[]): string {
  if (attachments.length === 0) return '';
  return attachments
    .map((attachment) => {
      const size = formatAttachmentSize(attachment.size);
      const dimensions =
        attachment.width && attachment.height ? `, ${attachment.width}x${attachment.height}` : '';
      return `${attachment.name} (${attachment.mimeType}, ${size}${dimensions})`;
    })
    .join('; ');
}

function detectReplyLanguage(text: string): 'ko' | 'ja' | 'zh' | 'en' {
  if (/[가-힣]/.test(text)) return 'ko';
  if (/[\u3040-\u30ff]/.test(text)) return 'ja';
  if (/[\u4e00-\u9fff]/.test(text)) return 'zh';
  return 'en';
}

function detectPreferredLanguage(
  latestUserText: string,
  responseLanguageMode: ResponseLanguageMode = 'match-user',
): 'ko' | 'ja' | 'zh' | 'en' {
  if (responseLanguageMode === 'english') return 'en';
  if (latestUserText.trim()) return detectReplyLanguage(latestUserText);
  const locale = (navigator.language || 'en').toLowerCase();
  if (locale.startsWith('ko')) return 'ko';
  if (locale.startsWith('ja')) return 'ja';
  if (locale.startsWith('zh')) return 'zh';
  return 'en';
}

function buildMemoryAckMessage(
  text: string,
  responseLanguageMode: ResponseLanguageMode = 'match-user',
): string {
  const lang = detectPreferredLanguage(text, responseLanguageMode);
  switch (lang) {
    case 'ko':
      return '알겠어, 기억해둘게.';
    case 'ja':
      return '分かった。覚えておくよ。';
    case 'zh':
      return '好，我记住了。';
    default:
      return "Got it. I'll remember that.";
  }
}

function buildChatCancelledAck(responseLanguageMode: ResponseLanguageMode = 'match-user'): string {
  const lang = detectPreferredLanguage('', responseLanguageMode);
  switch (lang) {
    case 'ko':
      return '중지했어.';
    case 'ja':
      return '停止したよ。';
    case 'zh':
      return '已停止。';
    default:
      return 'Stopped.';
  }
}

function createChatAbortError(): Error {
  const error = new Error('Conversation cancelled.');
  error.name = 'AbortError';
  return error;
}

function isChatAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === 'AbortError') ||
    (typeof DOMException !== 'undefined' &&
      error instanceof DOMException &&
      error.name === 'AbortError')
  );
}

function throwIfConversationAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createChatAbortError();
  }
}

function formatLoadingElapsed(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${remainder.toString().padStart(2, '0')}s`;
}

function buildLoadingStatus(info: ChatLoadingInfo | null, elapsedSeconds: number): string {
  const base = info?.status || 'Thinking';
  if (!info?.provider || elapsedSeconds < 20) {
    return base;
  }
  return `${base} · ${getProviderDisplayName(info.provider)} / ${info.model || 'model'}`;
}

function buildDefaultImagePrompt(
  responseLanguageMode: ResponseLanguageMode = 'match-user',
): string {
  const lang = detectPreferredLanguage('', responseLanguageMode);
  switch (lang) {
    case 'ko':
      return '첨부한 이미지를 분석해줘.';
    case 'ja':
      return '添付した画像を分析して。';
    case 'zh':
      return '请分析这张附加图片。';
    default:
      return 'Please analyze the attached image.';
  }
}

function extractNameMemory(text: string): string | null {
  const trimmed = text.trim();

  const patterns = [
    /(?:내 이름은|제 이름은)\s*([A-Za-z가-힣0-9_-]{2,30})/u,
    /(?:나는|전|저는)\s*([A-Za-z가-힣0-9_-]{2,30})(?:이야|예요|이에요|야)\b/u,
    /(?:my name is|i am|i'm)\s+([A-Za-z][A-Za-z0-9 _-]{1,30})/i,
  ];

  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    const candidate = match?.[1]?.trim();
    if (candidate) {
      return `The user's name is ${candidate}.`;
    }
  }

  return null;
}

function mapMemoryCategoryToAoiType(category: string | undefined): AoiMemoryType {
  switch (category) {
    case 'preference':
      return 'preference';
    case 'event':
      return 'event';
    case 'emotion':
      return 'emotion';
    case 'fact':
      return 'fact';
    default:
      return 'fact';
  }
}

function isDirectPlaylistPlaybackIntent(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;

  const patterns = [
    /^(?:마지막|최근|방금|아까)?\s*(?:들었던|재생한)?\s*(?:유튜브\s*)?플레이리스트\s*(?:틀어줘|재생해줘|재생해|틀어|실행해|들려줘)?$/i,
    /^(?:플레이리스트|playlist)\s*(?:틀어줘|재생해줘|재생해|틀어|play|resume)$/i,
    /^(?:play|resume)\s+(?:the\s+)?(?:last\s+)?playlist$/i,
    /^(?:유튜브\s*)?플레이리스트\s*(?:다시\s*)?(?:틀어줘|재생해줘|재생해)$/i,
  ];

  return patterns.some((pattern) => pattern.test(trimmed));
}

function buildPlaylistPlaybackAck(
  userText: string,
  responseLanguageMode: ResponseLanguageMode = 'match-user',
): string {
  const lang = detectPreferredLanguage(userText, responseLanguageMode);
  switch (lang) {
    case 'ko':
      return '마지막 재생한 플레이리스트를 틀어볼게.';
    case 'ja':
      return '最後に再生したプレイリストを流してみるね。';
    case 'zh':
      return '我来播放你上次听的播放列表。';
    default:
      return "I'll play your most recent playlist.";
  }
}

function buildPlaylistPlaybackErrorAck(
  userText: string,
  responseLanguageMode: ResponseLanguageMode = 'match-user',
): string {
  const lang = detectPreferredLanguage(userText, responseLanguageMode);
  switch (lang) {
    case 'ko':
      return '아직 재생할 플레이리스트가 없어. 먼저 하나 만들어서 틀어줘.';
    case 'ja':
      return 'まだ再生できるプレイリストがないよ。先に一つ再生してみて。';
    case 'zh':
      return '现在还没有可播放的播放列表，先播放一次列表吧。';
    default:
      return "There isn't a playlist ready to play yet. Try playing one first.";
  }
}

function buildDirectMusicAck(
  query: string,
  userText: string,
  responseLanguageMode: ResponseLanguageMode = 'match-user',
): string {
  const lang = detectPreferredLanguage(userText, responseLanguageMode);
  switch (lang) {
    case 'ko':
      return `"${query}" 유튜브에서 틀어볼게.`;
    case 'ja':
      return `「${query}」をYouTubeで流してみるね。`;
    case 'zh':
      return `我来用 YouTube 播放“${query}”。`;
    default:
      return `I'll play "${query}" in YouTube.`;
  }
}

function isDirectYouTubeOpenIntent(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;

  const patterns = [
    /\b(?:youtube|you tube|music app)\b.*(?:open|launch|run|start|show)/i,
    /\b(?:open|launch|run|start|show).*(?:youtube|you tube|music app)\b/i,
    /유튜브.*(?:실행해|열어줘|띄워줘|켜줘|보여줘)/,
    /(?:실행해|열어줘|띄워줘|켜줘|보여줘).*(?:유튜브|youtube|뮤직 앱|music app)/,
    /youtube 실행해/i,
    /유튜브 실행해/i,
  ];

  return patterns.some((pattern) => pattern.test(text));
}

function buildYouTubeOpenAck(
  userText: string,
  responseLanguageMode: ResponseLanguageMode = 'match-user',
): string {
  const lang = detectPreferredLanguage(userText, responseLanguageMode);
  switch (lang) {
    case 'ko':
      return 'YouTube를 열어둘게.';
    case 'ja':
      return 'YouTubeを開いておくね。';
    case 'zh':
      return '我把 YouTube 打开给你。';
    default:
      return "I'll open YouTube for you.";
  }
}

function isDirectKiraOpenIntent(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;

  const patterns = [
    /\bkira\b.*(?:open|launch|run|start|show)/i,
    /(?:open|launch|run|start|show).*\bkira\b/i,
    /\b(?:project management|manage the project|project board|task board|kanban|work board)\b/i,
    /\b(?:show|open|launch|run|start).*(?:project board|task board|kanban|work board)\b/i,
    /키라.*(?:실행해|열어줘|띄워줘|켜줘|보여줘)/,
    /(?:실행해|열어줘|띄워줘|켜줘|보여줘).*(?:키라|kira)/,
    /kira 실행해/i,
    /키라 띄워줘/,
    /프로젝트.*(?:관리하자|관리해|관리하고 싶어|보여줘|보자|확인하자|열어줘|띄워줘)/,
    /(?:작업|할 일|업무).*(?:관리하자|관리해|보여줘|보자|확인하자|열어줘|띄워줘)/,
    /칸반.*(?:열어줘|보여줘|실행해|띄워줘)/,
  ];

  return patterns.some((pattern) => pattern.test(text));
}

function buildKiraOpenAck(
  userText: string,
  responseLanguageMode: ResponseLanguageMode = 'match-user',
): string {
  const lang = detectPreferredLanguage(userText, responseLanguageMode);
  switch (lang) {
    case 'ko':
      return 'Kira를 열어둘게.';
    case 'ja':
      return 'Kiraを開いておくね。';
    case 'zh':
      return '我把 Kira 打开给你。';
    default:
      return "I'll open Kira for you.";
  }
}

function isDirectIdeOpenIntent(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;

  const patterns = [
    /\baoi'?s ide\b.*(?:open|launch|run|start|show)/i,
    /\bide\b.*(?:open|launch|run|start|show)/i,
    /\bcode editor\b.*(?:open|launch|run|start|show)/i,
    /\b(?:open|launch|run|start|show).*(?:aoi'?s ide|ide|code editor)\b/i,
    /(?:아오이.?ide|ide|에디터|코드 에디터).*(?:실행해|열어줘|띄워줘|켜줘|보여줘)/,
    /(?:실행해|열어줘|띄워줘|켜줘|보여줘).*(?:아오이.?ide|ide|에디터|코드 에디터)/,
  ];

  return patterns.some((pattern) => pattern.test(text));
}

function buildIdeOpenAck(
  userText: string,
  responseLanguageMode: ResponseLanguageMode = 'match-user',
): string {
  const lang = detectPreferredLanguage(userText, responseLanguageMode);
  switch (lang) {
    case 'ko':
      return "Aoi's IDE를 열어둘게.";
    case 'ja':
      return "Aoi's IDEを開いておくね。";
    case 'zh':
      return "我把 Aoi's IDE 打开给你。";
    default:
      return "I'll open Aoi's IDE for you.";
  }
}

function hasUsableLLMConfig(config: LLMConfig | null | undefined): config is LLMConfig {
  if (
    config?.provider === 'codex-auth' ||
    config?.provider === 'codex-cli' ||
    config?.provider === 'claude-cli'
  ) {
    return !!config.model.trim();
  }
  return !!config?.baseUrl.trim() && !!config.model.trim();
}

function supportsStructuredConversationTools(config: LLMConfig | null | undefined): boolean {
  return Boolean(config);
}

function selectConversationModel(
  history: ChatMessage[],
  primaryConfig: LLMConfig | null | undefined,
  dialogConfig: DialogLlmConfig | null | undefined,
): { config: LLMConfig | null; useDialogModel: boolean } {
  const latestUserTurn = [...history].reverse().find((m) => m.role === 'user');
  const latestUserMessage = latestUserTurn?.content ?? '';
  if (latestUserTurn?.attachments?.length) {
    return { config: primaryConfig ?? null, useDialogModel: false };
  }
  const resolvedDialogConfig = resolveLlmOverride(primaryConfig ?? null, dialogConfig);
  const useDialogModel =
    hasUsableLLMConfig(resolvedDialogConfig) && shouldUseDialogModel(latestUserMessage, history);

  if (useDialogModel) {
    return { config: resolvedDialogConfig, useDialogModel: true };
  }

  return { config: primaryConfig ?? null, useDialogModel: false };
}

function buildTavilyPreSearchParams(query: string): Record<string, unknown> {
  const normalizedQuery = query.trim();
  const isNewsQuery =
    /\b(news|latest|recent|today|breaking)\b/i.test(normalizedQuery) ||
    /(뉴스|최신|최근|오늘|속보)/.test(normalizedQuery);

  return {
    query: normalizedQuery,
    topic: isNewsQuery ? 'news' : 'general',
    search_depth: 'basic',
    max_results: 5,
    ...(isNewsQuery ? { time_range: 'month' } : {}),
  };
}

function isPlaceholderAssistantResponse(content: string, replies: string[]): boolean {
  const normalizedContent = content.trim().toLowerCase();
  const normalizedReplies = replies.map((reply) => reply.trim().toLowerCase()).filter(Boolean);
  const placeholderContent = /^(?:test|테스트|placeholder|sample)$/i.test(normalizedContent);
  if (!placeholderContent) {
    return false;
  }

  if (normalizedReplies.length === 0) {
    return true;
  }

  const abcReplies =
    normalizedReplies.length >= 3 &&
    normalizedReplies[0] === 'a' &&
    normalizedReplies[1] === 'b' &&
    normalizedReplies[2] === 'c';
  const singleLetterReplies =
    normalizedReplies.length >= 2 && normalizedReplies.every((reply) => /^[a-z]$/.test(reply));

  return abcReplies || singleLetterReplies;
}

// ---------------------------------------------------------------------------
// Tool definitions for character system
// ---------------------------------------------------------------------------

function getRespondToUserToolDef() {
  return {
    type: 'function' as const,
    function: {
      name: 'respond_to_user',
      description:
        'Send a message to the user as the character. ALWAYS use this tool to respond — never output plain text.',
      parameters: {
        type: 'object' as const,
        properties: {
          character_expression: {
            type: 'object',
            properties: {
              content: {
                type: 'string',
                description:
                  'The message text (dialogue with optional action descriptions in parentheses)',
              },
              emotion: {
                type: 'string',
                description: 'Character emotion: happy, shy, peaceful, depressing, angry',
              },
            },
            required: ['content'],
          },
          user_interaction: {
            type: 'object',
            properties: {
              suggested_replies: {
                type: 'array',
                items: { type: 'string' },
                description: 'List of 3 suggested user replies (under 25 chars each)',
              },
            },
          },
        },
        required: ['character_expression'],
      },
    },
  };
}

function getFinishTargetToolDef() {
  return {
    type: 'function' as const,
    function: {
      name: 'finish_target',
      description:
        'Mark story targets as completed when achieved through conversation. Do not announce this to the user.',
      parameters: {
        type: 'object' as const,
        properties: {
          target_ids: {
            type: 'array',
            items: { type: 'number' },
            description: 'IDs of targets to mark as completed',
          },
        },
        required: ['target_ids'],
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Build system prompt with Character + Mod context
// ---------------------------------------------------------------------------

function buildSystemPrompt(
  character: CharacterConfig,
  modManager: ModManager | null,
  hasImageGen: boolean,
  userProfile: UserProfileConfig | null,
  conversationPreferences: ConversationPreferencesConfig | null,
  memories: MemoryEntry[] = [],
  hasTavily = false,
  hasResearchTools = false,
  aoiMemoryPrompt = '',
  missionPrompt = '',
  contextPrompt = '',
  capabilityPrompt = '',
  runGoalPrompt = '',
  skillsPrompt = '',
  mcpPluginPrompt = '',
  toolCallRuntimeAvailable = true,
): string {
  let prompt = getCharacterPromptContext(character);
  const preferredName = normalizeUserProfileDisplayName(userProfile?.displayName);
  const responseLanguageMode = normalizeResponseLanguageMode(
    conversationPreferences?.responseLanguageMode,
  );

  if (modManager) {
    prompt += '\n' + modManager.buildStageReminder();
  }

  if (preferredName) {
    prompt += `

Persistent user profile:
- The user's preferred name is ${JSON.stringify(preferredName)}.
- Use this name naturally when addressing the user.
- If older memories conflict with this name, prefer this configured profile.`;
  }

  if (toolCallRuntimeAvailable) {
    prompt += `
You can interact with apps on the user's device using tools.

When the user wants to interact with an app, first identify the target app from the user's intent, then:
1. list_apps — discover available apps
2. file_read("apps/{appName}/meta.yaml") — learn the target app's available actions
2a. get_app_schema — if available, use the machine-readable schema for the target app's data files.
3. If you do not know the exact file path yet, use workspace_search to find candidate paths before file_read.
3a. If the user is asking about the real IDE workspace or source code, use ide_search instead.
3a-1. If the user says current file, active file, opened file, currently visible file, selected text, selection, 현재 파일, 활성 파일, 열린 파일, 선택 영역, or 선택한 텍스트 in Aoi's IDE, first use ide_current_file or get_app_state(app_name="openvscode"). Do not guess the file path.
3b. If the user asks for a specific symbol or definition, use open_symbol.
4. Decide whether the action is:
   - an operation action (open, search, play, navigate, switch mode, etc.), or
   - a data mutation action (create, update, delete, save)
5. For operation actions:
   - call app_action directly after reading meta.yaml
   - read guide.md only if you need extra state or schema context
6. For data mutation actions:
   - file_read("apps/{appName}/guide.md")
   - workspace_search/file_list/file_read — explore existing data in "apps/{appName}/data/"
   - file_patch/file_write/file_delete — create/modify/delete data following the JSON schema from guide.md
   - app_action — notify the app to reload or reflect the new state

Rules:
- Always operate on the app the user specified. Do not redirect the operation to a different app or OS action.
- When talking to the user about an app, use the app's displayName or appName from list_apps/event context. Do not call known apps by raw numeric app_id such as "app 22"; app_id is only a tool parameter.
- Data mutations MUST go through file_patch/file_write/file_delete unless the target app's meta.yaml declares an app-owned operation or settings action that explicitly persists state through that app's validation path. app_action normally notifies the app to reload, but declared operation/settings actions may write when the user explicitly asks for that app operation. Exception examples: Kira APPLY_PROJECT_SETTINGS persists project settings through Kira's settings API; Aoi's IDE workspace actions such as CREATE_FILE and CREATE_FOLDER write inside the configured IDE workspace, active-editor actions such as PREVIEW_APPEND_ACTIVE_FILE, PREVIEW_PATCH_ACTIVE_FILE, PREVIEW_REPLACE_ACTIVE_FILE, PREVIEW_REPLACE_ACTIVE_SELECTION, APPLY_ACTIVE_FILE_PREVIEW, APPEND_ACTIVE_FILE, PATCH_ACTIVE_FILE, REPLACE_ACTIVE_FILE, REPLACE_ACTIVE_SELECTION, and UNDO_MODEL_ACTION intentionally operate on the current editor buffer and save it when requested, and SWITCH_WORKSPACE_ROOT persists the IDE workspace setting when the user explicitly asks to change roots.
- Operation actions do NOT require file_write when the app action itself performs the interaction.
- After file_patch/file_write, ALWAYS call app_action with the corresponding REFRESH action.
- Do NOT skip step 6. If the user asked to save/create/add something, you must persist the data with file_patch/file_write/file_delete. file_list alone does not save anything.
- Do NOT skip step 2 before app actions, and do NOT skip step 6 before ANY file_patch or file_write. The guide defines the ONLY valid directory structure and file schemas. Writing to paths not defined in guide.md will cause data loss — the app will not see the files.
- Prefer get_app_schema over guessing field names whenever it is available for the target app.
- Use workspace_search before file_read/file_patch/file_write whenever the exact file path is unknown.
- workspace_search is for app storage under apps/{appName}/data. ide_search is for the real OpenVSCode workspace on disk.
- workspace_search is read-only. Never treat it as a write or refresh action.
- For reviewing the current IDE file, use ide_current_file. For reading a known workspace file, use ide_read_file.
- For reviewing selected IDE text, use ide_current_file and read active_file.selection. For replacing only the selected text, use PREVIEW_REPLACE_ACTIVE_SELECTION when the user asks to inspect, preview, review, or approve first, then APPLY_ACTIVE_FILE_PREVIEW after approval. For direct selected-text edits, use REPLACE_ACTIVE_SELECTION.
- For adding or editing the current active IDE file, prefer app_action on Aoi's IDE so unsaved editor content is respected. When the user asks to inspect, preview, review, or approve the change first, use PREVIEW_APPEND_ACTIVE_FILE, PREVIEW_PATCH_ACTIVE_FILE, or PREVIEW_REPLACE_ACTIVE_FILE, then wait for approval before APPLY_ACTIVE_FILE_PREVIEW. For direct edits, use APPEND_ACTIVE_FILE, PATCH_ACTIVE_FILE, or REPLACE_ACTIVE_FILE. Pass save=true unless the user explicitly asks for a draft-only buffer edit.
- If an Aoi's IDE active-editor action went wrong, use UNDO_MODEL_ACTION on Aoi's IDE to restore the latest reversible model edit instead of file_patch/file_write.
- For editing a known IDE workspace file that is not the active editor buffer, use ide_patch_file or ide_write_file with an explicit relative path.
- To change Aoi's IDE workspace root when the user explicitly asks, use SWITCH_WORKSPACE_ROOT with an absolute local folder path.
- Prefer file_patch over file_write when you only need a small exact text replacement in an existing file.
- Use preview_changes before risky file mutations when you want to inspect the exact impact first.
- If a mutation went wrong, use undo_last_action to revert the latest reversible file change in this session.
- Use read_url when the user gives you a specific URL and wants the page contents or a clean article-style extract.
- Use get_app_state when you need to know which app window is open, focused, or what an app state.json currently contains.
- Use run_command only for safe, read-only workspace verification in Aoi's IDE context, such as git status/diff or pnpm/npm test/lint/build.
- Use structured_diagnostics when the user wants lint/typecheck/test failures in structured form instead of raw command output.
- Use RUN_DIAGNOSTICS on Aoi's IDE when the user wants diagnostics to appear in the IDE Problems panel.
- Use RUN_TESTS on Aoi's IDE when the user wants test execution and pass/fail history visible in the IDE Tests panel.
- Use CREATE_WORKSPACE_CHECKPOINT, LIST_WORKSPACE_CHECKPOINTS, RESTORE_WORKSPACE_CHECKPOINT, and DELETE_WORKSPACE_CHECKPOINT on Aoi's IDE when the user wants restore points visible in the IDE Checkpoints panel.
- Use REFRESH_GIT_STATUS on Aoi's IDE when the user wants current Git changes shown in the Source Control panel.
- Use OPEN_SEMANTIC_NAVIGATION on Aoi's IDE when the user wants definition, references, or exports results visible inside the IDE.
- Use find_references and list_exports for codebase understanding when raw text search is not enough.
- Use peek_definition for a tight symbol definition excerpt, and rename_preview before any broad refactor or rename.
- Use apply_semantic_rename only after rename_preview, and prefer it over raw text patching for straightforward symbol renames in the IDE workspace.
- Use workspace_checkpoint to create or restore a workspace snapshot before risky edits.
- Use autofix_diagnostics to start a fix cycle with an IDE checkpoint plus structured diagnostics together.
- Use background_watch to create a background watcher for IDE or app-storage directories when you need to react to future file changes.
- NEVER invent or guess file paths. ALL file_write paths MUST exactly follow the directory structure in guide.md. For example, if guide.md defines entries under "/entries/{id}.json", you MUST write to "apps/{appName}/data/entries/{id}.json" — NOT to "apps/{appName}/data/{id}.json" or any other path.
- NAS paths in guide.md like "/articles/xxx.json" map to "apps/{appName}/data/articles/xxx.json". This prefix rule applies to ALL paths — always preserve the full subdirectory structure from guide.md.

Music follow-up rule:
- When you recommend a song or artist and the user agrees, confirms, or says "let's go with that", treat it as an instruction to operate the YouTube app.
- In that case, use the YouTube app's search action with the exact artist + song title you recommended, instead of only replying conversationally.
- Korean intent phrases such as "듣자", "틀어줘", "재생해줘", "들려줘" should also be treated as music playback instructions when they refer to the current recommendation or music context.

When you receive "[User performed action in ... (appName: xxx)]", the appName is already provided. Read its meta.yaml to understand available actions, then respond accordingly. For games, respond with your own move — think strategically.

IMPORTANT: You MUST use the respond_to_user tool to send all messages to the user. Do NOT output plain text responses. Include your emotion and 3 suggested replies. respond_to_user is terminal and must be the final tool call in the assistant turn.${hasImageGen ? '\n\nYou can use generate_image to create images from text prompts. The generated image will be displayed in chat.' : ''}`;
  } else {
    prompt += `

Tool availability:
- The current model provider cannot return structured OpenRoom tool calls in this chat UI.
- Reply in plain text instead of claiming that you called tools.
- Do not claim that you opened apps, edited files, searched live web, ran commands, or saved memory unless the user-visible context already proves it.
- If the request requires an app action or workspace mutation, say what is missing and give the next safe manual step.`;
  }

  if (hasTavily) {
    prompt += `

Web search rule:
- When the user asks you to search, look up, verify, compare current information, find recent news, or answer a fact that may have changed, use search_web first.
- Korean verification questions like "진짜야?", "사실이야?", or "맞아?" require search_web first when they mention dates, API availability, product/model changes, vendor policy, releases, or support status.
- Base current-information answers on search_web results instead of guessing.
- When helpful, mention the source site names or URLs naturally in your reply.`;
  }

  if (hasResearchTools) {
    prompt += `

Research run rule:
- Use start_research for research or document-generation requests that require web investigation, source collection, evidence extraction, and a structured cited report.
- Use search_web or read_url instead for small one-off lookups, quick fact checks, or a single URL summary. Do not turn every web question into a long research run.
- After start_research, inspect the returned run id, status, phase, statusMessage, source counts, and artifactAvailability.
- If the run is completed and the report artifact is available, you may call read_research_artifact with artifact="report" before summarizing the document.
- If the run is queued or running, tell the user the run id and current phase/status, then stop instead of polling forever.
- If the run failed or was cancelled, give the precise failure reason and mention any partial artifact availability. Do not fabricate citations or claim the document is complete unless status is completed.
- If Durable Aoi memory mentions a completed research run that matches the user's question, answer from that memory first; use read_research_artifact when the user needs details, citations, or the full report.
- Use get_research_status when the user asks about an active run or provides a run id. Use cancel_research only when the user asks to stop that run.`;
  }

  prompt +=
    responseLanguageMode === 'english'
      ? `

Language rule:
- Always reply in English, even if the user's latest message is in another language.
- Keep suggested replies in English as well.`
      : `

Language rule:
- Always reply in the same language as the user's latest message.
- If the user switches languages, immediately switch with them.
- Keep suggested replies in that same language as well.`;

  if (toolCallRuntimeAvailable) {
    prompt += `

Tool rule:
- If you call save_memory, you must also call respond_to_user in the same assistant turn.
- Call save_memory before respond_to_user. respond_to_user must be the last tool call because the runtime treats it as the end of the visible chat turn.
- Never call save_memory by itself and stop there.`;
  }

  prompt += runGoalPrompt;
  prompt += missionPrompt;
  prompt += contextPrompt;
  prompt += skillsPrompt;
  prompt += mcpPluginPrompt;
  prompt += capabilityPrompt;
  prompt += aoiMemoryPrompt;
  prompt += buildMemoryPrompt(memories);

  return prompt;
}

function buildUserActionMessage(
  app: { appId: number; appName: string; displayName: string },
  action: { action_type: string; params?: Record<string, string> },
): string {
  const targetApp =
    app.appName === 'os' ? getOsActionTargetApp(action.action_type, action.params) : null;
  const source = `${app.displayName} (appName: ${app.appName}, appId: ${app.appId})`;
  const target = targetApp ? `, targetApp: ${formatAppReference(targetApp)}` : '';
  return `[User performed action in ${source}${target}] action_type: ${action.action_type}, params: ${JSON.stringify(action.params || {})}`;
}

function formatReminderTime(dateTime: string, language: 'ko' | 'ja' | 'zh' | 'en'): string {
  const date = new Date(dateTime);
  if (Number.isNaN(date.getTime())) return dateTime;
  const localeMap = {
    ko: 'ko-KR',
    ja: 'ja-JP',
    zh: 'zh-CN',
    en: 'en-US',
  } as const;
  return new Intl.DateTimeFormat(localeMap[language], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

async function loadDueCalendarReminderEvents(nowMs: number): Promise<CalendarReminderEvent[]> {
  const nodes = await calendarReminderFileApi.listFiles('/events');
  const events = await Promise.all(
    nodes
      .filter((node) => node.type === 'file')
      .map(async (node) => {
        try {
          const result = await calendarReminderFileApi.readFile(node.path);
          const raw = result.content;
          const parsed =
            typeof raw === 'string'
              ? (JSON.parse(raw) as CalendarReminderEvent)
              : (raw as CalendarReminderEvent);
          if (!parsed?.id || !parsed?.title || !parsed?.startAt) return null;
          return {
            ...parsed,
            notes: parsed.notes ?? '',
            remindBeforeMinutes: parsed.remindBeforeMinutes ?? 15,
            completed: parsed.completed ?? false,
          };
        } catch (error) {
          console.warn('[ChatPanel] Failed to parse calendar reminder event', node.path, error);
          return null;
        }
      }),
  );

  return events
    .filter((event): event is CalendarReminderEvent => event !== null)
    .filter((event) => {
      if (event.completed || event.lastReminderSentAt) return false;
      const startMs = new Date(event.startAt).getTime();
      if (Number.isNaN(startMs)) return false;
      const reminderAt = startMs - Math.max(0, event.remindBeforeMinutes || 0) * 60_000;
      return nowMs >= reminderAt && nowMs <= startMs + CALENDAR_REMINDER_GRACE_MS;
    })
    .sort((a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime());
}

async function markCalendarReminderSent(event: CalendarReminderEvent): Promise<void> {
  await calendarReminderFileApi.writeFile(`/events/${event.id}.json`, {
    ...event,
    lastReminderSentAt: Date.now(),
    updatedAt: Date.now(),
  });
}

function buildFallbackReminderMessage(
  event: CalendarReminderEvent,
  language: 'ko' | 'ja' | 'zh' | 'en',
): ReminderMessagePayload {
  const when = formatReminderTime(event.startAt, language);
  switch (language) {
    case 'ko':
      return {
        content: `${event.title} 일정이 ${when}에 있어. ${event.notes ? `${event.notes} ` : ''}슬슬 준비하자.`,
        emotion: 'peaceful',
        replies: ['열어줘', '알겠어', '나중에 다시 알려줘'],
      };
    case 'ja':
      return {
        content: `${when}に「${event.title}」があるよ。${event.notes ? `${event.notes} ` : ''}そろそろ準備しよう。`,
        emotion: 'peaceful',
        replies: ['予定を開いて', '分かった', 'あとでまた教えて'],
      };
    case 'zh':
      return {
        content: `${when} 有「${event.title}」。${event.notes ? `${event.notes} ` : ''}该准备一下了。`,
        emotion: 'peaceful',
        replies: ['打开日程', '知道了', '等会再提醒我'],
      };
    default:
      return {
        content: `You have "${event.title}" at ${when}. ${event.notes ? `${event.notes} ` : ''}Time to get ready.`,
        emotion: 'peaceful',
        replies: ['Open calendar', 'Got it', 'Remind me later'],
      };
  }
}

async function generateCalendarReminderMessage(
  event: CalendarReminderEvent,
  config: LLMConfig | null,
  character: CharacterConfig,
  latestUserText: string,
  responseLanguageMode: ResponseLanguageMode,
): Promise<ReminderMessagePayload> {
  const language = detectPreferredLanguage(latestUserText, responseLanguageMode);
  const fallback = buildFallbackReminderMessage(event, language);
  if (!hasUsableLLMConfig(config)) return fallback;

  const languageLabel =
    language === 'ko'
      ? 'Korean'
      : language === 'ja'
        ? 'Japanese'
        : language === 'zh'
          ? 'Chinese'
          : 'English';
  const when = formatReminderTime(event.startAt, language);

  try {
    const response = await chat(
      [
        {
          role: 'system',
          content: `${getCharacterPromptContext(character)}

You are proactively reminding the user about an upcoming calendar event.
Rules:
- Stay in character.
- Reply in ${languageLabel}.
- Keep it concise: 1-3 short sentences.
- Mention the event title and exact local time.
- Be warm and gently urgent.
- Always use respond_to_user.`,
        },
        {
          role: 'user',
          content: JSON.stringify({
            kind: 'calendar_reminder',
            title: event.title,
            when,
            remindBeforeMinutes: event.remindBeforeMinutes,
            notes: event.notes,
          }),
        },
      ],
      [getRespondToUserToolDef()],
      config,
    );

    const respondTool = response.toolCalls.find((tool) => tool.function.name === 'respond_to_user');
    if (!respondTool) return fallback;
    const params = JSON.parse(respondTool.function.arguments) as {
      character_expression?: { content?: string; emotion?: string };
      user_interaction?: { suggested_replies?: string[] };
    };
    const content = params.character_expression?.content?.trim();
    if (!content) return fallback;
    return {
      content,
      emotion: params.character_expression?.emotion ?? fallback.emotion,
      replies: params.user_interaction?.suggested_replies?.length
        ? params.user_interaction.suggested_replies
        : fallback.replies,
    };
  } catch (error) {
    console.warn('[ChatPanel] Calendar reminder LLM generation failed, using fallback', error);
    return fallback;
  }
}

function isDirectPeAnalystOpenIntent(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;

  const patterns = [
    /\bpe analyst\b.*(?:open|launch|run|start|show)/i,
    /\bpe analyzer\b.*(?:open|launch|run|start|show)/i,
    /\bpe analysis\b.*(?:open|launch|run|start|show)/i,
    /\b(?:open|launch|run|start|show).*(?:pe analyst|pe analyzer|pe analysis)\b/i,
    /\b(?:analyze|analysis|reverse|triage|inspect|review).*(?:a\s+)?pe\b/i,
    /\b(?:want to|wanna|would like to|let'?s)\s+(?:analyze|inspect|review).*(?:a\s+)?pe\b/i,
    /\bpe\b.*(?:analyze|analysis|reverse|triage|inspect|review)/i,
    /(?:pe 분석기|pe 분석|분석기).*(?:실행해|열어줘|띄워줘|켜줘|보여줘)/,
    /(?:실행해|열어줘|띄워줘|켜줘|보여줘).*(?:pe 분석기|pe 분석|분석기)/,
    /pe.*분석하고 싶어/,
    /pe.*분석하자/,
    /pe.*분석해보자/,
    /pe.*분석할래/,
    /pe.*분석 좀 해줘/,
    /분석하고 싶어.*pe/,
    /분석하자.*pe/,
    /분석해보자.*pe/,
    /pe analyst 열어줘/i,
    /pe analyzer 열어줘/i,
  ];

  return patterns.some((pattern) => pattern.test(text));
}

function buildPeAnalystOpenAck(
  userText: string,
  responseLanguageMode: ResponseLanguageMode = 'match-user',
): string {
  const lang = detectPreferredLanguage(userText, responseLanguageMode);
  switch (lang) {
    case 'ko':
      return 'PE Analyst를 열어둘게.';
    case 'ja':
      return 'PE Analystを開いておくね。';
    case 'zh':
      return '我把 PE Analyst 打开给你。';
    default:
      return "I'll open PE Analyst for you.";
  }
}

function resolveOpeningLocalizationConfig(
  mainConfig: LLMConfig | null,
  dialogConfig: DialogLlmConfig | null,
): LLMConfig | null {
  const dialogOverride = resolveLlmOverride(mainConfig, dialogConfig);
  if (hasUsableLLMConfig(dialogOverride)) return dialogOverride;
  return hasUsableLLMConfig(mainConfig) ? mainConfig : null;
}

async function localizeOpeningScene(
  prologue: string,
  openingReplies: string[],
  config: LLMConfig | null,
  character: CharacterConfig,
): Promise<{ prologue: string; replies: string[] }> {
  if (!hasUsableLLMConfig(config)) {
    return { prologue, replies: openingReplies };
  }

  try {
    const response = await chat(
      [
        {
          role: 'system',
          content: `${getCharacterPromptContext(character)}

You are preparing the very first opening message shown in chat.
Rules:
- Rewrite the provided opening message into natural English.
- Preserve the same scenario, tone, and intent.
- Do not mention translation, localization, or that the text was rewritten.
- Suggested replies must be short natural user replies in English, ideally 1-6 words each.
- Keep the same number of suggested replies when possible.
- Return the result using respond_to_user.`,
        },
        {
          role: 'user',
          content: JSON.stringify({
            openingMessage: prologue,
            suggestedReplies: openingReplies,
          }),
        },
      ],
      [getRespondToUserToolDef()],
      config,
    );

    const respondTool = response.toolCalls.find((tool) => tool.function.name === 'respond_to_user');
    if (!respondTool) {
      return { prologue, replies: openingReplies };
    }

    const params = JSON.parse(respondTool.function.arguments) as {
      character_expression?: { content?: string };
      user_interaction?: { suggested_replies?: string[] };
    };
    const localizedPrologue = params.character_expression?.content?.trim() || prologue;
    const localizedReplies = params.user_interaction?.suggested_replies?.filter(Boolean) ?? [];

    return {
      prologue: localizedPrologue,
      replies: localizedReplies.length > 0 ? localizedReplies : openingReplies,
    };
  } catch (error) {
    console.warn('[ChatPanel] Opening scene localization failed, using original prologue', error);
    return { prologue, replies: openingReplies };
  }
}

// ---------------------------------------------------------------------------
// Helper: render action markers and clickable links
// ---------------------------------------------------------------------------

function renderMessageContent(
  content: string,
  onOpenExternal: (url: string) => void,
  onOpenLink: (url: string) => void,
): React.ReactNode {
  return parseChatMessageContent(content).map((segment, i) => {
    if (segment.type === 'link') {
      return (
        <span key={i} className={styles.messageLinkGroup}>
          <button
            type="button"
            className={styles.messageLink}
            onClick={() => onOpenExternal(segment.url)}
          >
            {segment.label}
          </button>
          <button
            type="button"
            className={styles.messageLinkInlineAction}
            onClick={() => onOpenLink(segment.url)}
          >
            In-app
          </button>
        </span>
      );
    }

    if (segment.type === 'emotion') {
      return (
        <span key={i} className={styles.emotion}>
          {segment.text}
        </span>
      );
    }

    return <React.Fragment key={i}>{segment.text}</React.Fragment>;
  });
}

// ---------------------------------------------------------------------------
// Actions Taken (collapsible)
// ---------------------------------------------------------------------------

const ActionsTaken: React.FC<{ calls: string[] }> = ({ calls }) => {
  const [open, setOpen] = useState(false);
  if (calls.length === 0) return null;

  return (
    <div className={styles.actionsTaken}>
      <button className={styles.actionsTakenToggle} onClick={() => setOpen(!open)}>
        Actions taken
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      </button>
      {open && (
        <div className={styles.actionsTakenList}>
          {calls.map((c, i) => (
            <div key={i}>{c}</div>
          ))}
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// CharacterAvatar – crossfade between emotion media without flashing
// ---------------------------------------------------------------------------

interface AvatarLayer {
  url: string;
  type: 'video' | 'image';
  active: boolean;
}

const CharacterAvatar: React.FC<{
  character: CharacterConfig;
  emotion?: string;
  onEmotionEnd: () => void;
}> = memo(({ character, emotion, onEmotionEnd }) => {
  const isIdle = !emotion;
  const media = resolveEmotionMedia(character, emotion || 'default');

  const [layers, setLayers] = useState<AvatarLayer[]>(() =>
    media ? [{ url: media.url, type: media.type, active: true }] : [],
  );
  const activeUrl = layers.find((l) => l.active)?.url;

  useEffect(() => {
    if (!media) {
      setLayers([]);
      return;
    }
    if (media.url === activeUrl) return;
    setLayers((prev) => {
      if (prev.some((l) => l.url === media.url)) return prev;
      return [...prev, { url: media.url, type: media.type, active: false }];
    });
  }, [media?.url, activeUrl]);

  const handleMediaReady = useCallback((readyUrl: string) => {
    setLayers((prev) => {
      const staleUrls = prev.filter((l) => l.url !== readyUrl).map((l) => l.url);
      setTimeout(() => {
        setLayers((curr) => curr.filter((l) => !staleUrls.includes(l.url)));
      }, 300);
      return prev.map((l) => ({ ...l, active: l.url === readyUrl }));
    });
  }, []);

  if (layers.length === 0) {
    return <div className={styles.avatarPlaceholder}>{character.character_name.charAt(0)}</div>;
  }

  return (
    <>
      {layers.map((layer) => {
        const layerStyle: React.CSSProperties = {
          position: 'absolute',
          inset: 0,
          opacity: layer.active ? 1 : 0,
          transition: 'opacity 0.25s ease-out',
        };
        if (layer.type === 'video') {
          return (
            <video
              key={layer.url}
              className={styles.avatarImage}
              style={layerStyle}
              src={layer.url}
              autoPlay
              loop={layer.active ? isIdle : false}
              muted
              playsInline
              onCanPlay={!layer.active ? () => handleMediaReady(layer.url) : undefined}
              onEnded={layer.active && !isIdle ? onEmotionEnd : undefined}
            />
          );
        }
        return (
          <img
            key={layer.url}
            className={styles.avatarImage}
            style={layerStyle}
            src={layer.url}
            alt={character.character_name}
            onLoad={!layer.active ? () => handleMediaReady(layer.url) : undefined}
          />
        );
      })}
    </>
  );
});

// ---------------------------------------------------------------------------
// ChatPanel
// ---------------------------------------------------------------------------

const ChatPanel: React.FC<{
  onClose: () => void;
  visible?: boolean;
  zIndex?: number;
  onFocus?: () => void;
  compact?: boolean;
}> = ({ onClose, visible = true, zIndex, onFocus, compact = false }) => {
  // Character + Mod state (collection-based)
  const [charCollection, setCharCollection] = useState<CharacterCollection>(
    () => loadCharacterCollectionSync() ?? DEFAULT_CHAR_COLLECTION,
  );
  const character = getActiveCharacter(charCollection);

  const [modCollection, setModCollection] = useState<ModCollection>(
    () => loadModCollectionSync() ?? DEFAULT_MOD_COLLECTION,
  );
  const [modManager, setModManager] = useState<ModManager | null>(() => {
    const col = loadModCollectionSync() ?? DEFAULT_MOD_COLLECTION;
    const entry = getActiveModEntry(col);
    return new ModManager(entry.config, entry.state);
  });

  // Session key for chat history isolation (character × mod)
  const sessionPath = buildSessionPath(charCollection.activeId, modCollection.activeId);
  setSessionPath(sessionPath);

  // Chat state — initialized from session-scoped cache
  const [messages, setMessages] = useState<CharacterDisplayMessage[]>(() => {
    const cache = loadChatHistorySync(sessionPath);
    return (cache?.messages ?? []) as CharacterDisplayMessage[];
  });
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>(() => {
    const cache = loadChatHistorySync(sessionPath);
    return cache?.chatHistory ?? [];
  });
  const [input, setInput] = useState('');
  const [pendingImageAttachments, setPendingImageAttachments] = useState<ChatImageAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState('');
  const [imageDropActive, setImageDropActive] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingInfo, setLoadingInfo] = useState<ChatLoadingInfo | null>(null);
  const [loadingElapsedSeconds, setLoadingElapsedSeconds] = useState(0);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<AppSettingsTabKey>('chat');
  const [config, setConfig] = useState<LLMConfig | null>(loadConfigSync);
  const [currentModelUsageStatus, setCurrentModelUsageStatus] =
    useState<CurrentModelUsageStatus | null>(null);
  const [dialogLlmConfig, setDialogLlmConfig] = useState<DialogLlmConfig | null>(null);
  const [idaPeConfig, setIdaPeConfig] = useState<IdaPeConfig | null>(null);
  const [kiraConfig, setKiraConfig] = useState<KiraConfig | null>(null);
  const [persistedConfigLoaded, setPersistedConfigLoaded] = useState(false);
  const [userProfile, setUserProfile] = useState<UserProfileConfig | null>(
    loadUserProfileConfigSync,
  );
  const [conversationPreferences, setConversationPreferences] =
    useState<ConversationPreferencesConfig | null>(loadConversationPreferencesSync);
  const [imageGenConfig, setImageGenConfig] = useState<ImageGenConfig | null>(
    loadImageGenConfigSync,
  );
  const [tavilyConfig, setTavilyConfig] = useState<TavilyConfig | null>(loadTavilyConfigSync);
  const [toolSafetyPolicy, setToolSafetyPolicy] = useState<ToolSafetyPolicy>(loadToolSafetyPolicy);
  const [ttsStatusSnapshot, setTtsStatusSnapshot] = useState<AoiTtsStatusSnapshot>(() =>
    getAoiTtsStatusSnapshot(),
  );
  const [aoiOperatorVoiceMuted, setAoiOperatorVoiceMuted] = useState(false);
  const [aoiLastOperatorVoiceDecision, setAoiLastOperatorVoiceDecision] =
    useState<AoiVoiceRenderDecision | null>(null);

  // Suggested replies from latest assistant message
  const [suggestedReplies, setSuggestedReplies] = useState<string[]>([]);
  const [showCharacterPanel, setShowCharacterPanel] = useState(false);
  const [showModPanel, setShowModPanel] = useState(false);
  const [initialEditModId, setInitialEditModId] = useState<string | undefined>();
  const [currentEmotion, setCurrentEmotion] = useState<string | undefined>();
  const [dockSide, setDockSide] = useState<ChatDockSide>(() => {
    try {
      const raw = localStorage.getItem(CHAT_DOCK_SIDE_KEY);
      return raw === 'left' ? 'left' : 'right';
    } catch {
      return 'right';
    }
  });
  const [chatPanelWidth, setChatPanelWidth] = useState(() => loadChatPanelWidth(compact));
  const [chatFontSize, setChatFontSize] = useState(loadChatFontSize);
  const panelResizeRef = useRef<{
    startX: number;
    width: number;
    dockSide: ChatDockSide;
    compact: boolean;
  } | null>(null);
  const panelResizeFrameRef = useRef<number | null>(null);
  const pendingPanelWidthRef = useRef<number | null>(null);
  const panelStyle = useMemo(() => {
    const style = {
      '--chat-panel-width': `${chatPanelWidth}px`,
    } as React.CSSProperties;
    if (zIndex !== null && zIndex !== undefined) {
      style.zIndex = zIndex;
    }
    return style;
  }, [chatPanelWidth, zIndex]);
  const chatFontStyle = useMemo(
    () =>
      ({
        '--chat-font-size': `${chatFontSize}px`,
      }) as React.CSSProperties,
    [chatFontSize],
  );

  useEffect(() => {
    try {
      localStorage.setItem(CHAT_DOCK_SIDE_KEY, dockSide);
      window.dispatchEvent(new CustomEvent(CHAT_DOCK_SIDE_EVENT, { detail: { side: dockSide } }));
    } catch {
      // ignore persistence failures
    }
  }, [dockSide]);

  useEffect(() => {
    setChatPanelWidth(loadChatPanelWidth(compact));
  }, [compact]);

  useEffect(() => {
    const nextWidth = clampChatPanelWidth(chatPanelWidth, compact);
    if (nextWidth !== chatPanelWidth) {
      setChatPanelWidth(nextWidth);
      return;
    }

    try {
      localStorage.setItem(getChatPanelWidthStorageKey(compact), String(nextWidth));
      window.dispatchEvent(
        new CustomEvent(CHAT_PANEL_WIDTH_EVENT, {
          detail: { width: nextWidth, compact },
        }),
      );
    } catch {
      // ignore persistence failures
    }
  }, [chatPanelWidth, compact]);

  useEffect(() => {
    const handleResize = () => {
      setChatPanelWidth((prev) => clampChatPanelWidth(prev, compact));
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [compact]);

  const handlePanelResizeMouseDown = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      onFocus?.();

      panelResizeRef.current = {
        startX: event.clientX,
        width: chatPanelWidth,
        dockSide,
        compact,
      };

      const previousCursor = document.body.style.cursor;
      const previousUserSelect = document.body.style.userSelect;
      document.body.style.cursor = 'ew-resize';
      document.body.style.userSelect = 'none';

      const handleMouseMove = (moveEvent: MouseEvent) => {
        const resizeState = panelResizeRef.current;
        if (!resizeState) {
          return;
        }

        const delta =
          resizeState.dockSide === 'right'
            ? resizeState.startX - moveEvent.clientX
            : moveEvent.clientX - resizeState.startX;
        pendingPanelWidthRef.current = clampChatPanelWidth(
          resizeState.width + delta,
          resizeState.compact,
        );

        if (panelResizeFrameRef.current !== null) {
          return;
        }

        panelResizeFrameRef.current = window.requestAnimationFrame(() => {
          panelResizeFrameRef.current = null;
          const pendingWidth = pendingPanelWidthRef.current;
          if (pendingWidth !== null) {
            setChatPanelWidth(pendingWidth);
          }
        });
      };

      const finishResize = () => {
        if (panelResizeFrameRef.current !== null) {
          window.cancelAnimationFrame(panelResizeFrameRef.current);
          panelResizeFrameRef.current = null;
        }

        const pendingWidth = pendingPanelWidthRef.current;
        if (pendingWidth !== null) {
          setChatPanelWidth(pendingWidth);
        }
        pendingPanelWidthRef.current = null;
        panelResizeRef.current = null;
        document.body.style.cursor = previousCursor;
        document.body.style.userSelect = previousUserSelect;
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', finishResize);
      };

      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', finishResize);
    },
    [chatPanelWidth, compact, dockSide, onFocus],
  );

  useEffect(() => {
    try {
      localStorage.setItem(CHAT_FONT_SIZE_KEY, String(chatFontSize));
    } catch {
      // ignore persistence failures
    }
  }, [chatFontSize]);

  useEffect(() => {
    const handler = (event: Event) => {
      const tab = (event as CustomEvent<OpenAppSettingsDetail>).detail?.tab ?? 'chat';
      setSettingsInitialTab(tab);
      setShowSettings(true);
    };
    window.addEventListener(OPEN_APP_SETTINGS_EVENT, handler);
    return () => window.removeEventListener(OPEN_APP_SETTINGS_EVENT, handler);
  }, []);

  // Open mod editor when triggered from Shell (e.g. after card import mod generation)
  useEffect(() => {
    const handler = (e: Event) => {
      const modId = (e as CustomEvent<{ modId: string }>).detail?.modId;
      if (modId) {
        setInitialEditModId(modId);
        setShowModPanel(true);
      }
    };
    window.addEventListener('open-mod-editor', handler);
    return () => window.removeEventListener('open-mod-editor', handler);
  }, []);

  // Memories loaded for SP injection
  const [memories, setMemories] = useState<MemoryEntry[]>([]);
  const [aoiMemories, setAoiMemories] = useState<AoiMemoryEntry[]>([]);
  const [promptBudgetEntries, setPromptBudgetEntries] = useState<PromptBudgetEntry[]>([]);
  const [aoiRunLedger, setAoiRunLedger] = useState<AoiRunLedgerEntry[]>([]);
  const [aoiSkills, setAoiSkills] = useState<AoiWorkshopSkill[]>(() => loadAoiSkillsWorkshop());
  const [aoiMcpPlugins, setAoiMcpPlugins] = useState<AoiMcpPluginEntry[]>(() =>
    loadAoiMcpPluginAdmin(),
  );
  const [aoiAutonomyStatus, setAoiAutonomyStatus] = useState<AoiAutonomyStatus | null>(null);
  const [aoiAutonomyActiveProposals, setAoiAutonomyActiveProposals] = useState<AoiProposal[]>([]);
  const [aoiAutonomyArchivedProposals, setAoiAutonomyArchivedProposals] = useState<AoiProposal[]>(
    [],
  );
  const [aoiRecentProposalDecisions, setAoiRecentProposalDecisions] = useState<
    AoiProposalDecision[]
  >([]);
  const [aoiAutonomyActiveGoals, setAoiAutonomyActiveGoals] = useState<AoiGoal[]>([]);
  const [aoiActivePlaybooks, setAoiActivePlaybooks] = useState<AoiPlaybook[]>([]);
  const [aoiMissionState, setAoiMissionState] = useState<AoiMissionState | null>(null);
  const [aoiEnvironmentSources, setAoiEnvironmentSources] =
    useState<AoiEnvironmentSourceRegistry | null>(null);
  const [aoiWorkspaceSnapshot, setAoiWorkspaceSnapshot] = useState<AoiWorkspaceSnapshot | null>(
    null,
  );
  const [aoiContextRouter, setAoiContextRouter] = useState<AoiContextRouterResult | null>(null);
  const [aoiAutonomyScheduler, setAoiAutonomyScheduler] =
    useState<AoiAutonomySchedulerState | null>(null);
  const [aoiAutonomyEvaluation, setAoiAutonomyEvaluation] =
    useState<AoiAutonomyEvaluationResult | null>(null);
  const [aoiOperatorHealth, setAoiOperatorHealth] = useState<AoiOperatorHealthState | null>(null);
  const [aoiAutonomyPanelSettings, setAoiAutonomyPanelSettings] =
    useState<AoiAutonomyPanelSettings>(() => loadAoiAutonomyPanelSettings());
  const [aoiAutonomyBlockedProposals, setAoiAutonomyBlockedProposals] = useState<
    AoiAutonomyBlockedProposal[]
  >([]);
  const [aoiAutonomyLoading, setAoiAutonomyLoading] = useState(false);
  const [aoiAutonomyError, setAoiAutonomyError] = useState('');
  const [aoiAutonomyActionId, setAoiAutonomyActionId] = useState<string | null>(null);
  const [aoiAutonomyLastTickAt, setAoiAutonomyLastTickAt] = useState<number | null>(null);
  const [aoiAutonomyLastSeenAt, setAoiAutonomyLastSeenAt] = useState<number | null>(null);
  const [dismissedAoiResumeBriefId, setDismissedAoiResumeBriefId] = useState<string | null>(null);
  const [aoiAutonomyExecutionMessages, setAoiAutonomyExecutionMessages] = useState<
    Record<string, string>
  >({});
  const [aoiKiraHandoffPreviews, setAoiKiraHandoffPreviews] = useState<
    Record<string, AoiAutonomyProposalPreviewResult>
  >({});
  const [aoiAutonomyPendingFeedback, setAoiAutonomyPendingFeedback] = useState<{
    decisionId: string;
    proposalId: string;
    action: Extract<AoiProposalDecisionAction, 'dismiss' | 'snooze'>;
    title: string;
  } | null>(null);
  const [aoiInlineDismissedProposalIds, setAoiInlineDismissedProposalIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [aoiInlineSnoozedProposalIds, setAoiInlineSnoozedProposalIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [aoiInlineHiddenAt, setAoiInlineHiddenAt] = useState<number | null>(null);
  const [aoiInlineShownCount, setAoiInlineShownCount] = useState(0);

  // Pending tool calls for current response (grouped per assistant turn)
  const pendingToolCallsRef = useRef<string[]>([]);
  const hasUserInteractedRef = useRef(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const pendingImageAttachmentsRef = useRef(pendingImageAttachments);
  pendingImageAttachmentsRef.current = pendingImageAttachments;
  const chatHistoryRef = useRef(chatHistory);
  chatHistoryRef.current = chatHistory;
  const suggestedRepliesRef = useRef(suggestedReplies);
  suggestedRepliesRef.current = suggestedReplies;
  const aoiAutonomyRefreshInFlightRef = useRef(false);
  const aoiAutonomySessionOpenTickPathsRef = useRef(new Set<string>());
  const aoiInlineShownProposalIdsRef = useRef(new Set<string>());
  const aoiOperatorVoiceSpokenKeysRef = useRef(new Set<string>());
  const aoiOperatorVoiceDecisionRecordKeyRef = useRef('');

  // Debounced save
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    saveAoiAutonomyPanelSettings(aoiAutonomyPanelSettings);
  }, [aoiAutonomyPanelSettings]);

  const recentToolActivity = useMemo(
    () =>
      messages
        .flatMap((message) => message.toolCalls ?? [])
        .filter(Boolean)
        .slice(-18)
        .reverse(),
    [messages],
  );

  const sessionPathRef = useRef(sessionPath);
  sessionPathRef.current = sessionPath;
  const openingLocalizationCacheRef = useRef(
    new Map<string, { prologue: string; replies: string[] }>(),
  );
  const seedPrologueRequestRef = useRef(0);

  useEffect(() => {
    if (messages.length === 0 && chatHistory.length === 0) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveChatHistory(
        sessionPathRef.current,
        messagesRef.current,
        chatHistoryRef.current,
        suggestedRepliesRef.current,
      );
    }, 500);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [messages, chatHistory, suggestedReplies]);

  /** Seed prologue and opening replies from the current active mod */
  const seedPrologue = useCallback(
    async (collection?: ModCollection) => {
      const entry = getActiveModEntry(collection ?? modCollection);
      const prologue = entry.config.prologue;
      const openingReplies =
        entry.config.opening_rec_replies?.map((reply) => reply.reply_text) ?? [];
      const requestId = ++seedPrologueRequestRef.current;

      let nextPrologue = prologue ?? '';
      let nextReplies = openingReplies;
      const responseLanguageMode = normalizeResponseLanguageMode(
        conversationPreferences?.responseLanguageMode,
      );

      if (prologue && responseLanguageMode === 'english') {
        const cacheKey = JSON.stringify({
          modId: entry.config.id,
          prologue,
          openingReplies,
          responseLanguageMode,
        });
        const cached = openingLocalizationCacheRef.current.get(cacheKey);
        if (cached) {
          nextPrologue = cached.prologue;
          nextReplies = cached.replies;
        } else {
          const localized = await localizeOpeningScene(
            prologue,
            openingReplies,
            resolveOpeningLocalizationConfig(config, dialogLlmConfig),
            character,
          );
          openingLocalizationCacheRef.current.set(cacheKey, localized);
          nextPrologue = localized.prologue;
          nextReplies = localized.replies;
        }
      }

      if (requestId !== seedPrologueRequestRef.current) {
        return;
      }

      if (prologue) {
        const prologueMsg: CharacterDisplayMessage = {
          id: 'prologue',
          role: 'assistant',
          content: nextPrologue,
        };
        setMessages([prologueMsg]);
        setChatHistory([{ role: 'assistant', content: nextPrologue }]);
      } else {
        setMessages([]);
        setChatHistory([]);
      }
      setSuggestedReplies(nextReplies);
      setCurrentEmotion(undefined);
    },
    [
      character,
      config,
      conversationPreferences?.responseLanguageMode,
      dialogLlmConfig,
      modCollection,
    ],
  );

  // Reload chat history only when the session path itself changes.
  // Depending on the whole mod collection here can re-run this effect during async
  // config hydration and overwrite newly typed messages with the default prologue.
  useEffect(() => {
    console.info('[ChatPanel] Loading session state', { sessionPath });
    setAoiAutonomyStatus(null);
    setAoiAutonomyActiveProposals([]);
    setAoiAutonomyArchivedProposals([]);
    setAoiAutonomyActiveGoals([]);
    setAoiActivePlaybooks([]);
    setAoiMissionState(null);
    setAoiEnvironmentSources(null);
    setAoiWorkspaceSnapshot(null);
    setAoiContextRouter(null);
    setAoiAutonomyEvaluation(null);
    setAoiOperatorHealth(null);
    setAoiAutonomyBlockedProposals([]);
    setAoiAutonomyError('');
    setAoiAutonomyActionId(null);
    setAoiAutonomyLastTickAt(null);
    setAoiAutonomyLastSeenAt(null);
    setDismissedAoiResumeBriefId(null);
    setAoiAutonomyExecutionMessages({});
    setAoiKiraHandoffPreviews({});
    setAoiAutonomyPendingFeedback(null);
    setAoiInlineDismissedProposalIds(new Set());
    setAoiInlineSnoozedProposalIds(new Set());
    setAoiInlineHiddenAt(null);
    setAoiInlineShownCount(0);
    aoiInlineShownProposalIdsRef.current = new Set();
    loadChatHistory(sessionPath).then(async (data) => {
      const loadedMessages = (data?.messages ?? []) as CharacterDisplayMessage[];
      const loadedHistory = data?.chatHistory ?? [];
      const hasSavedConversation = hasPersistedConversation(data);

      if (!hasSavedConversation) {
        console.info('[ChatPanel] No persisted conversation found, seeding prologue');
        // No history — seed prologue
        await seedPrologue();
      } else {
        const onlyPrologue = loadedMessages.length === 1 && loadedMessages[0].id === 'prologue';
        let nextMessages = loadedMessages;
        let nextHistory = loadedHistory;
        let nextSuggestedReplies = data?.suggestedReplies?.length ? data.suggestedReplies : [];

        if (
          onlyPrologue &&
          normalizeResponseLanguageMode(conversationPreferences?.responseLanguageMode) === 'english'
        ) {
          const entry = getActiveModEntry(modCollection);
          const fallbackReplies =
            nextSuggestedReplies.length > 0
              ? nextSuggestedReplies
              : (entry.config.opening_rec_replies?.map((reply) => reply.reply_text) ?? []);
          const localized = await localizeOpeningScene(
            loadedMessages[0].content,
            fallbackReplies,
            resolveOpeningLocalizationConfig(config, dialogLlmConfig),
            character,
          );
          nextMessages = [{ ...loadedMessages[0], content: localized.prologue }];
          nextHistory = [{ role: 'assistant', content: localized.prologue }];
          nextSuggestedReplies = localized.replies;
        }

        console.info('[ChatPanel] Persisted conversation found, restoring chat history', {
          messageCount: nextMessages.length,
          historyCount: nextHistory.length,
        });
        setMessages(nextMessages);
        setChatHistory(nextHistory);
        pendingImageAttachmentsRef.current = [];
        setPendingImageAttachments([]);
        setAttachmentError('');
        setImageDropActive(false);
        // Restore suggested replies from saved data, or from mod config if only prologue
        if (nextSuggestedReplies.length) {
          setSuggestedReplies(nextSuggestedReplies);
        } else {
          if (onlyPrologue) {
            const entry = getActiveModEntry(modCollection);
            const openingReplies = entry.config.opening_rec_replies;
            setSuggestedReplies(
              openingReplies?.length ? openingReplies.map((r) => r.reply_text) : [],
            );
          } else {
            setSuggestedReplies([]);
          }
        }
        setCurrentEmotion(undefined);
      }
    });
    // Load memories for SP injection
    loadMemories(sessionPath).then(setMemories);
    loadAoiMemories().then(setAoiMemories);
    loadAoiRunLedger(sessionPath).then((entries) => {
      aoiRunLedgerRef.current = entries;
      setAoiRunLedger(entries);
    });
  }, [sessionPath]);

  // Load configs from file (async override).
  // Empty deps [] is intentional: configs (character collection, mod collection,
  // chat config, image-gen config) are loaded inside the effect and written to
  // state — they are not external dependencies that should trigger re-runs.
  useEffect(() => {
    loadConfig().then((fileConfig) => {
      if (fileConfig) setConfig(fileConfig);
    });
    loadPersistedConfig()
      .then((persisted) => {
        if (persisted?.llm) {
          setConfig(persisted.llm);
        }
        if (persisted?.imageGen) {
          setImageGenConfig(persisted.imageGen);
        }
        if (persisted?.dialogLlm) {
          setDialogLlmConfig(persisted.dialogLlm);
        }
        if (persisted?.idaPe) {
          setIdaPeConfig(persisted.idaPe);
        }
        setKiraConfig(persisted?.kira ?? null);
        const nextUserProfile = persisted
          ? (persisted.userProfile ?? null)
          : loadUserProfileConfigSync();
        const nextConversationPreferences = persisted
          ? (persisted.conversationPreferences ?? null)
          : loadConversationPreferencesSync();
        setUserProfile(nextUserProfile);
        setConversationPreferences(nextConversationPreferences);
        saveUserProfileConfig(nextUserProfile);
        saveConversationPreferences(nextConversationPreferences);
      })
      .finally(() => {
        setPersistedConfigLoaded(true);
      });
    loadImageGenConfig().then((fileConfig) => {
      if (fileConfig) setImageGenConfig(fileConfig);
    });
    loadTavilyConfig().then((fileConfig) => {
      if (fileConfig) setTavilyConfig(fileConfig);
    });
    loadCharacterCollection().then((col) => {
      if (col && !hasUserInteractedRef.current) {
        console.info('[ChatPanel] Applying async character collection');
        setCharCollection(col);
      }
    });
    loadModCollection().then((col) => {
      if (col && !hasUserInteractedRef.current) {
        console.info('[ChatPanel] Applying async mod collection');
        setModCollection(col);
        const entry = getActiveModEntry(col);
        setModManager(new ModManager(entry.config, entry.state));
      }
    });
  }, []);

  useEffect(() => {
    const activeConfig = config;
    let active = true;
    let intervalId: ReturnType<typeof setInterval> | null = null;

    if (!persistedConfigLoaded || !hasUsableLLMConfig(activeConfig)) {
      setCurrentModelUsageStatus(null);
      return () => {
        active = false;
      };
    }

    const refreshUsageStatus = async () => {
      try {
        const status = await fetchCurrentModelUsage(activeConfig);
        if (active) {
          setCurrentModelUsageStatus(status);
        }
      } catch (error) {
        if (!active) {
          return;
        }
        const now = Date.now();
        setCurrentModelUsageStatus({
          ok: false,
          provider: activeConfig.provider,
          model: activeConfig.model,
          period: 'week',
          status: 'error',
          source: 'chat-panel',
          refreshedAt: now,
          nextRefreshAt: now + MODEL_USAGE_REFRESH_INTERVAL_MS,
          message: 'Unable to check weekly model usage.',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    setCurrentModelUsageStatus(null);
    void refreshUsageStatus();
    intervalId = setInterval(() => {
      void refreshUsageStatus();
    }, MODEL_USAGE_REFRESH_INTERVAL_MS);

    return () => {
      active = false;
      if (intervalId) {
        clearInterval(intervalId);
      }
    };
  }, [config?.command, config?.model, config?.provider, persistedConfigLoaded]);

  // Listen for mod collection changes from Shell (e.g. after mod generation)
  useEffect(() => {
    const handler = (e: Event) => {
      const col = (e as CustomEvent<ModCollection>).detail;
      if (col) {
        setModCollection(col);
        const entry = getActiveModEntry(col);
        setModManager(new ModManager(entry.config, entry.state));
      }
    };
    window.addEventListener('mod-collection-changed', handler);
    return () => window.removeEventListener('mod-collection-changed', handler);
  }, []);

  const handleClearHistory = useCallback(async () => {
    await clearChatHistory(sessionPathRef.current);
    pendingImageAttachmentsRef.current = [];
    setPendingImageAttachments([]);
    setAttachmentError('');
    setImageDropActive(false);
    await seedPrologue();
  }, [seedPrologue]);

  /** Reset entire session — clears chat, memories, app data, and mod state */
  const handleResetSession = useCallback(async () => {
    const sp = sessionPathRef.current;
    // Clear server-side session directory
    try {
      await fetch(`/api/session-reset?path=${encodeURIComponent(sp)}`, { method: 'DELETE' });
    } catch {
      // ignore
    }
    // Clear local state
    localStorage.removeItem(`openroom_chat_${sp.replace(/\//g, '_')}`);
    setMessages([]);
    setChatHistory([]);
    setSuggestedReplies([]);
    setMemories([]);
    aoiRunLedgerRef.current = [];
    setAoiRunLedger([]);
    setCurrentEmotion(undefined);
    pendingImageAttachmentsRef.current = [];
    setPendingImageAttachments([]);
    setAttachmentError('');
    setImageDropActive(false);

    // Close all open app windows
    closeAllWindows();

    // Reset mod state
    if (modManagerRef.current) {
      modManagerRef.current.reset();
      const mm = modManagerRef.current;
      setModManager(new ModManager(mm.getConfig(), mm.getState()));
      setModCollection((prev) => {
        const entry = getActiveModEntry(prev);
        const updated = {
          ...prev,
          items: {
            ...prev.items,
            [entry.config.id]: { config: entry.config, state: mm.getState() },
          },
        };
        saveModCollection(updated);
        return updated;
      });
    }

    // Re-seed prologue and opening replies
    await seedPrologue();

    // Re-seed meta files
    await seedMetaFiles();
  }, [modCollection, seedPrologue]);

  const handleResetSessionHistory = useCallback(async () => {
    console.info('[ChatPanel] Resetting current session history only');
    await handleResetSession();
    setShowSettings(false);
    console.info('[ChatPanel] Current session history reset complete');
  }, [handleResetSession]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  const addMessage = useCallback((msg: CharacterDisplayMessage) => {
    setMessages((prev) => [...prev, msg]);
  }, []);

  useEffect(() => {
    if (!loadingInfo) {
      return;
    }

    const updateElapsed = () => {
      setLoadingElapsedSeconds(
        Math.max(0, Math.floor((Date.now() - loadingInfo.startedAt) / 1000)),
      );
    };

    updateElapsed();
    const timer = window.setInterval(updateElapsed, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [loadingInfo]);

  const beginChatLoading = useCallback(
    (
      status: string,
      options: {
        cancellable?: boolean;
        provider?: LLMProvider;
        model?: string;
      } = {},
    ): number => {
      const runId = loadingRunIdRef.current + 1;
      loadingRunIdRef.current = runId;
      setLoading(true);
      setLoadingElapsedSeconds(0);
      setLoadingInfo({
        startedAt: Date.now(),
        status,
        cancellable: options.cancellable !== false,
        provider: options.provider,
        model: options.model,
      });
      return runId;
    },
    [],
  );

  const updateChatLoadingStatus = useCallback((status: string) => {
    setLoadingInfo((prev) => (prev ? { ...prev, status } : prev));
  }, []);

  const finishChatLoading = useCallback((runId?: number) => {
    if (runId !== undefined && runId !== loadingRunIdRef.current) {
      return;
    }
    conversationAbortRef.current = null;
    setLoading(false);
    setLoadingInfo(null);
    setLoadingElapsedSeconds(0);
  }, []);

  const handleCancelChatRun = useCallback(() => {
    const controller = conversationAbortRef.current;
    if (!controller) {
      return;
    }

    controller.abort();
    loadingRunIdRef.current += 1;
    conversationAbortRef.current = null;
    setLoading(false);
    setLoadingInfo(null);
    setLoadingElapsedSeconds(0);
    addMessage({
      id: String(Date.now()),
      role: 'assistant',
      content: buildChatCancelledAck(
        normalizeResponseLanguageMode(conversationPreferencesRef.current?.responseLanguageMode),
      ),
    });
  }, [addMessage]);

  const refreshConversationConfigs = useCallback(async () => {
    const [latestMainConfig, persisted] = await Promise.all([
      loadConfig().catch(() => null),
      loadPersistedConfig().catch(() => null),
    ]);
    const latestDialogConfig = persisted?.dialogLlm ?? null;
    const latestKiraConfig = persisted?.kira ?? null;
    const latestUserProfile = persisted
      ? (persisted.userProfile ?? null)
      : loadUserProfileConfigSync();
    const latestConversationPreferences = persisted
      ? (persisted.conversationPreferences ?? null)
      : loadConversationPreferencesSync();

    if (latestMainConfig) {
      setConfig(latestMainConfig);
      configRef.current = latestMainConfig;
    }
    setDialogLlmConfig(latestDialogConfig);
    dialogLlmConfigRef.current = latestDialogConfig;
    setKiraConfig(latestKiraConfig);
    setUserProfile(latestUserProfile);
    userProfileRef.current = latestUserProfile;
    setConversationPreferences(latestConversationPreferences);
    conversationPreferencesRef.current = latestConversationPreferences;
    saveUserProfileConfig(latestUserProfile);
    saveConversationPreferences(latestConversationPreferences);

    return {
      mainConfig: latestMainConfig ?? configRef.current,
      dialogConfig: latestDialogConfig,
    };
  }, []);

  const configRef = useRef(config);
  configRef.current = config;
  const dialogLlmConfigRef = useRef(dialogLlmConfig);
  dialogLlmConfigRef.current = dialogLlmConfig;
  const imageGenConfigRef = useRef(imageGenConfig);
  imageGenConfigRef.current = imageGenConfig;
  const tavilyConfigRef = useRef(tavilyConfig);
  tavilyConfigRef.current = tavilyConfig;
  const userProfileRef = useRef(userProfile);
  userProfileRef.current = userProfile;
  const conversationPreferencesRef = useRef(conversationPreferences);
  conversationPreferencesRef.current = conversationPreferences;
  const toolSafetyPolicyRef = useRef(toolSafetyPolicy);
  toolSafetyPolicyRef.current = toolSafetyPolicy;
  const modManagerRef = useRef(modManager);
  modManagerRef.current = modManager;
  const characterRef = useRef(character);
  characterRef.current = character;
  const memoriesRef = useRef(memories);
  memoriesRef.current = memories;
  const aoiMemoriesRef = useRef(aoiMemories);
  aoiMemoriesRef.current = aoiMemories;
  const aoiRunLedgerRef = useRef(aoiRunLedger);
  aoiRunLedgerRef.current = aoiRunLedger;
  const aoiSkillsRef = useRef(aoiSkills);
  aoiSkillsRef.current = aoiSkills;
  const aoiMcpPluginsRef = useRef(aoiMcpPlugins);
  aoiMcpPluginsRef.current = aoiMcpPlugins;
  const toolCacheRef = useRef(createToolResultCache());
  const conversationAbortRef = useRef<AbortController | null>(null);
  const loadingRunIdRef = useRef(0);

  const clearToolCache = useCallback(() => {
    toolCacheRef.current.clear();
  }, []);

  const refreshAoiMemories = useCallback(() => {
    loadAoiMemories()
      .then(setAoiMemories)
      .catch((error) => {
        console.warn('[ChatPanel] Failed to refresh Aoi memory', error);
      });
  }, []);

  const archiveAoiMemoryEntry = useCallback(async (memoryId: string) => {
    const nextMemories = await archiveAoiMemory(memoryId);
    setAoiMemories(nextMemories);
  }, []);

  const saveAoiPreferenceEntry = useCallback(async (memoryId: string) => {
    const nextMemories = await saveAoiPreferenceMemory(memoryId);
    setAoiMemories(nextMemories);
  }, []);

  const demoteAoiMemoryEntry = useCallback(async (memoryId: string) => {
    const nextMemories = await demoteAoiPreferenceMemory(memoryId);
    setAoiMemories(nextMemories);
  }, []);

  const markAoiMemoryTemporaryEntry = useCallback(async (memoryId: string) => {
    const nextMemories = await markAoiMemoryTemporary(memoryId);
    setAoiMemories(nextMemories);
  }, []);

  const deleteAoiMemoryEntry = useCallback(async (memoryId: string) => {
    const nextMemories = await deleteAoiMemory(memoryId);
    setAoiMemories(nextMemories);
  }, []);

  const recordAoiMemoryTurn = useCallback(
    (params: {
      userMessage: string;
      assistantMessage: string;
      toolCalls?: string[];
      source?: AoiMemoryEpisodeSource;
      llmConfig?: LLMConfig | null;
    }) => {
      if (!params.userMessage.trim() && !params.assistantMessage.trim()) return;
      void syncAoiMemoryFromTurn({
        sessionPath: sessionPathRef.current,
        userMessage: params.userMessage,
        assistantMessage: params.assistantMessage,
        toolCalls: params.toolCalls,
        source: params.source,
        llmConfig: params.llmConfig,
      })
        .then(setAoiMemories)
        .catch((error) => {
          console.warn('[ChatPanel] Aoi memory sync failed', error);
        });
    },
    [],
  );

  const publishAoiRunLedgerEntry = useCallback(
    (sessionPathForRun: string, entry: AoiRunLedgerEntry, persist = false) => {
      const nextEntries = upsertAoiRunLedgerEntry(aoiRunLedgerRef.current, entry);
      aoiRunLedgerRef.current = nextEntries;
      setAoiRunLedger(nextEntries);

      if (persist) {
        void saveAoiRunLedger(sessionPathForRun, nextEntries).catch((error) => {
          console.warn('[ChatPanel] Aoi run ledger save failed', error);
        });
      }
    },
    [],
  );

  const recordAoiAutonomyLedgerEvent = useCallback(
    (
      proposal: AoiProposal,
      eventType:
        | 'proposal_accepted'
        | 'proposal_execution_started'
        | 'proposal_execution_completed'
        | 'proposal_execution_failed'
        | 'proposal_execution_blocked',
      message: string,
    ) => {
      const now = Date.now();
      const started = createAoiRunLedgerEntry({
        goal: {
          summary: `Aoi proposal: ${proposal.title}`,
          sourceMessage: proposal.reason,
          createdAt: now,
        },
        modelRoute: 'main',
        includeAppTools: false,
        exposedToolNames: proposal.suggestedTools,
        createdAt: now,
      });
      const withProposalEvent = appendAoiRunLedgerEvent(started, {
        type: eventType,
        message,
        toolNames: proposal.suggestedTools,
        createdAt: now,
      });
      const finalStatus =
        eventType === 'proposal_execution_failed' || eventType === 'proposal_execution_blocked'
          ? 'failed'
          : 'completed';
      publishAoiRunLedgerEntry(
        sessionPathRef.current,
        finalizeAoiRunLedgerEntry(withProposalEvent, finalStatus, message),
        true,
      );
    },
    [publishAoiRunLedgerEntry],
  );

  const refreshAoiAutonomy = useCallback(async (options: { silent?: boolean } = {}) => {
    if (aoiAutonomyRefreshInFlightRef.current) {
      return;
    }

    const sessionPathForAutonomy = sessionPathRef.current;
    aoiAutonomyRefreshInFlightRef.current = true;
    if (!options.silent) {
      setAoiAutonomyLoading(true);
    }
    setAoiAutonomyError('');

    try {
      const [snapshot, decisions] = await Promise.all([
        fetchAoiAutonomyDashboard(sessionPathForAutonomy),
        fetchAoiProposalDecisions(sessionPathForAutonomy, 50),
      ]);
      setAoiAutonomyStatus(snapshot.status);
      setAoiAutonomyActiveProposals(snapshot.proposals.active);
      setAoiAutonomyArchivedProposals(snapshot.proposals.archived);
      setAoiRecentProposalDecisions(decisions.decisions);
      setAoiAutonomyActiveGoals(snapshot.goals.active);
      setAoiActivePlaybooks(snapshot.playbooks.active);
      setAoiMissionState(snapshot.mission);
      setAoiEnvironmentSources(snapshot.environmentSources);
      setAoiWorkspaceSnapshot(snapshot.workspaceSnapshot);
      setAoiContextRouter(snapshot.contextRouter);
      setAoiAutonomyScheduler(snapshot.scheduler);
      setAoiAutonomyEvaluation(snapshot.evaluation);
      setAoiOperatorHealth(snapshot.health);
    } catch (error) {
      setAoiAutonomyError(error instanceof Error ? error.message : String(error));
    } finally {
      aoiAutonomyRefreshInFlightRef.current = false;
      if (!options.silent) {
        setAoiAutonomyLoading(false);
      }
    }
  }, []);

  const handleAoiAutonomyAdvancedVisible = useCallback(() => {
    void refreshAoiAutonomy();
  }, [refreshAoiAutonomy]);

  const runAoiAutonomySessionOpenTick = useCallback(async () => {
    const sessionPathForAutonomy = sessionPathRef.current;
    if (
      !sessionPathForAutonomy ||
      aoiAutonomySessionOpenTickPathsRef.current.has(sessionPathForAutonomy)
    ) {
      return;
    }

    aoiAutonomySessionOpenTickPathsRef.current.add(sessionPathForAutonomy);
    const latestUserMessage = [...chatHistoryRef.current]
      .reverse()
      .find((message) => message.role === 'user')?.content;
    const now = Date.now();
    const lastSeenStorageKey = `${AOI_OPERATOR_LAST_SEEN_STORAGE_PREFIX}${encodeURIComponent(
      sessionPathForAutonomy,
    )}`;
    let lastSeenAt: number | null = null;
    try {
      const rawLastSeenAt = localStorage.getItem(lastSeenStorageKey);
      const parsedLastSeenAt = rawLastSeenAt ? Number(rawLastSeenAt) : 0;
      lastSeenAt =
        Number.isFinite(parsedLastSeenAt) && parsedLastSeenAt > 0 ? parsedLastSeenAt : null;
      localStorage.setItem(lastSeenStorageKey, String(now));
    } catch {
      lastSeenAt = null;
    }
    setAoiAutonomyLastSeenAt(lastSeenAt);
    setDismissedAoiResumeBriefId(null);
    const userIdleMs = lastSeenAt ? Math.max(0, now - lastSeenAt) : undefined;

    try {
      const result = await runAoiAutonomySessionOpenWakeup({
        sessionPath: sessionPathForAutonomy,
        latestUserMessage,
        llmConfig: configRef.current ?? undefined,
        quietMode: aoiAutonomyPanelSettings.quietMode,
        ...(typeof userIdleMs === 'number' ? { userIdleMs } : {}),
      });
      if (sessionPathRef.current !== sessionPathForAutonomy) {
        return;
      }
      setAoiAutonomyStatus(result.status);
      setAoiAutonomyScheduler(result.state);
      setAoiAutonomyBlockedProposals(result.tickResult?.blockedProposals ?? []);
      setAoiAutonomyLastTickAt(result.status.lastTickAt ?? result.record.completedAt);
      await refreshAoiAutonomy({ silent: true });
    } catch (error) {
      console.warn('[ChatPanel] Aoi autonomy session-open tick failed', error);
    }
  }, [aoiAutonomyPanelSettings.quietMode, refreshAoiAutonomy]);

  const updateAoiAutonomyPolicyFromPanel = useCallback(
    async (patch: Partial<AoiAutonomyPolicy>) => {
      const sessionPathForAutonomy = sessionPathRef.current;
      setAoiAutonomyActionId('policy');
      setAoiAutonomyError('');

      try {
        const result = await updateAoiAutonomyPolicy(sessionPathForAutonomy, patch);
        setAoiAutonomyStatus((prev) =>
          prev
            ? {
                ...prev,
                policy: result.policy,
                updatedAt: Date.now(),
              }
            : null,
        );
        await refreshAoiAutonomy({ silent: true });
      } catch (error) {
        setAoiAutonomyError(error instanceof Error ? error.message : String(error));
      } finally {
        setAoiAutonomyActionId(null);
      }
    },
    [refreshAoiAutonomy],
  );

  const updateAoiEnvironmentSourceFromPanel = useCallback(
    async (sourceId: string, patch: Partial<AoiEnvironmentSource>) => {
      const sessionPathForAutonomy = sessionPathRef.current;
      if (!sessionPathForAutonomy) {
        return;
      }
      const actionId = `source:${sourceId}`;
      setAoiAutonomyActionId(actionId);
      setAoiAutonomyError('');
      try {
        const result = await updateAoiEnvironmentSource(sessionPathForAutonomy, {
          sourceId,
          patch,
        });
        setAoiEnvironmentSources(result.registry);
        if (result.status) {
          setAoiAutonomyStatus(result.status);
        }
        await refreshAoiAutonomy({ silent: true });
      } catch (error) {
        setAoiAutonomyError(error instanceof Error ? error.message : String(error));
      } finally {
        setAoiAutonomyActionId(null);
      }
    },
    [refreshAoiAutonomy],
  );

  const recordAoiContextSourceFeedbackFromPanel = useCallback(
    async (
      sourceId: string,
      contextSummaryId: string,
      feedbackCategory: Extract<
        AoiProposalFeedbackCategory,
        'wrong_evidence' | 'wrong_source' | 'wrong_timing' | 'stale' | 'not_useful' | 'too_much'
      >,
      evidenceRefs: string[],
    ) => {
      const sessionPathForAutonomy = sessionPathRef.current;
      if (!sessionPathForAutonomy) {
        return;
      }
      const actionId = `context:${contextSummaryId}:${feedbackCategory}`;
      setAoiAutonomyActionId(actionId);
      setAoiAutonomyError('');
      try {
        const result = await recordAoiContextSourceFeedback(sessionPathForAutonomy, {
          sourceId,
          contextSummaryId,
          feedbackCategory,
          evidenceRefs,
        });
        setAoiContextRouter(result.context);
        await refreshAoiAutonomy({ silent: true });
      } catch (error) {
        setAoiAutonomyError(error instanceof Error ? error.message : String(error));
      } finally {
        setAoiAutonomyActionId(null);
      }
    },
    [refreshAoiAutonomy],
  );

  const resetAoiTrustCalibrationFromPanel = useCallback(
    async (dimension: AoiCalibrationDimension, key: string) => {
      const sessionPathForAutonomy = sessionPathRef.current;
      if (!sessionPathForAutonomy || !key.trim()) {
        return;
      }
      const actionId = `trust-reset:${dimension}:${key}`;
      setAoiAutonomyActionId(actionId);
      setAoiAutonomyError('');
      try {
        const result = await resetAoiTrustCalibrationCategory(sessionPathForAutonomy, {
          dimension,
          key,
        });
        setAoiAutonomyEvaluation(result.evaluation);
        await refreshAoiAutonomy({ silent: true });
      } catch (error) {
        setAoiAutonomyError(error instanceof Error ? error.message : String(error));
      } finally {
        setAoiAutonomyActionId(null);
      }
    },
    [refreshAoiAutonomy],
  );

  const updateAoiAutonomyPanelSettingsFromPanel = useCallback(
    (patch: Partial<AoiAutonomyPanelSettings>) => {
      setAoiAutonomyPanelSettings((prev) => ({
        ...prev,
        ...patch,
      }));
    },
    [],
  );

  const runAoiAutonomyCheckFromPanel = useCallback(async () => {
    const sessionPathForAutonomy = sessionPathRef.current;
    const latestUserMessage = [...chatHistoryRef.current]
      .reverse()
      .find((message) => message.role === 'user')?.content;

    setAoiAutonomyActionId('tick');
    setAoiAutonomyLoading(true);
    setAoiAutonomyError('');

    try {
      const result = await runAoiAutonomyManualWakeup({
        sessionPath: sessionPathForAutonomy,
        latestUserMessage,
        llmConfig: configRef.current ?? undefined,
        quietMode: aoiAutonomyPanelSettings.quietMode,
      });
      setAoiAutonomyStatus(result.status);
      setAoiAutonomyScheduler(result.state);
      setAoiAutonomyBlockedProposals(result.tickResult?.blockedProposals ?? []);
      setAoiAutonomyLastTickAt(result.status.lastTickAt ?? result.record.completedAt);
      await refreshAoiAutonomy({ silent: true });
    } catch (error) {
      setAoiAutonomyError(error instanceof Error ? error.message : String(error));
    } finally {
      setAoiAutonomyLoading(false);
      setAoiAutonomyActionId(null);
    }
  }, [aoiAutonomyPanelSettings.quietMode, refreshAoiAutonomy]);

  const decideAoiMissionFromPanel = useCallback(
    async (action: AoiMissionDecisionAction) => {
      const actionId = `mission:${action}`;
      const sessionPathForAutonomy = sessionPathRef.current;
      setAoiAutonomyActionId(actionId);
      setAoiAutonomyError('');

      try {
        const result = await decideAoiMission(sessionPathForAutonomy, {
          action,
          reason: `User selected ${action} in Aoi Autonomy mission panel.`,
          evidenceRefs: aoiMissionState?.evidenceRefs,
        });
        setAoiMissionState(result.mission);
        if (result.status) {
          setAoiAutonomyStatus(result.status);
        }
        await refreshAoiAutonomy({ silent: true });
      } catch (error) {
        setAoiAutonomyError(error instanceof Error ? error.message : String(error));
      } finally {
        setAoiAutonomyActionId(null);
      }
    },
    [aoiMissionState?.evidenceRefs, refreshAoiAutonomy],
  );

  const decideAoiProposalFromPanel = useCallback(
    async (
      proposalId: string,
      action: AoiProposalDecisionAction,
      feedbackCategory?: AoiProposalFeedbackCategory,
    ) => {
      const actionId = `proposal:${proposalId}:${action}`;
      const sessionPathForAutonomy = sessionPathRef.current;
      setAoiAutonomyActionId(actionId);
      setAoiAutonomyError('');

      try {
        const result = await decideAoiProposal(sessionPathForAutonomy, {
          proposalId,
          action,
          reason: feedbackCategory
            ? `User selected ${action} with ${feedbackCategory} feedback in Aoi Autonomy UI.`
            : `User selected ${action} in Aoi Autonomy UI.`,
          feedbackCategory,
        });
        setAoiAutonomyActiveProposals(result.active);
        setAoiAutonomyArchivedProposals(result.archived);
        setAoiAutonomyExecutionMessages((prev) => {
          const next = { ...prev };
          delete next[proposalId];
          return next;
        });
        setAoiKiraHandoffPreviews((prev) => {
          const next = { ...prev };
          delete next[proposalId];
          return next;
        });
        setAoiInlineHiddenAt(Date.now());
        if (action === 'accept') {
          setAoiAutonomyPendingFeedback(null);
          recordAoiAutonomyLedgerEvent(
            result.proposal,
            'proposal_accepted',
            'User accepted Aoi autonomy proposal. No tool executed yet.',
          );
        }
        if (action === 'dismiss') {
          setAoiInlineDismissedProposalIds((prev) => new Set(prev).add(proposalId));
        }
        if (action === 'snooze') {
          setAoiInlineSnoozedProposalIds((prev) => new Set(prev).add(proposalId));
        }
        if ((action === 'dismiss' || action === 'snooze') && !feedbackCategory) {
          setAoiAutonomyPendingFeedback({
            decisionId: result.decision.id,
            proposalId,
            action,
            title: result.proposal.title,
          });
        } else if (feedbackCategory) {
          setAoiAutonomyPendingFeedback(null);
        }
        await refreshAoiAutonomy({ silent: true });
      } catch (error) {
        setAoiAutonomyError(error instanceof Error ? error.message : String(error));
      } finally {
        setAoiAutonomyActionId(null);
      }
    },
    [recordAoiAutonomyLedgerEvent, refreshAoiAutonomy],
  );

  const pauseAoiGoalForRecoveryFromPanel = useCallback(
    async (proposal: AoiProposal) => {
      const goalId = getAoiProposalGoalId(proposal);
      if (!goalId) {
        return;
      }
      const actionId = `goal:${goalId}:pause`;
      const sessionPathForAutonomy = sessionPathRef.current;
      setAoiAutonomyActionId(actionId);
      setAoiAutonomyError('');

      try {
        const result = await decideAoiGoal(sessionPathForAutonomy, {
          goalId,
          action: 'pause',
          reason: `User paused goal from recovery proposal ${proposal.id}.`,
          evidenceRefs: proposal.evidenceRefs,
        });
        setAoiAutonomyActiveGoals(result.active);
        if (result.status) {
          setAoiAutonomyStatus(result.status);
        }
        await refreshAoiAutonomy({ silent: true });
      } catch (error) {
        setAoiAutonomyError(error instanceof Error ? error.message : String(error));
      } finally {
        setAoiAutonomyActionId(null);
      }
    },
    [refreshAoiAutonomy],
  );

  const recordAoiProposalFeedbackFromPanel = useCallback(
    async (feedbackCategory: AoiProposalFeedbackCategory) => {
      const pending = aoiAutonomyPendingFeedback;
      if (!pending) {
        return;
      }
      const actionId = `proposal-feedback:${pending.decisionId}:${feedbackCategory}`;
      const sessionPathForAutonomy = sessionPathRef.current;
      setAoiAutonomyActionId(actionId);
      setAoiAutonomyError('');

      try {
        await recordAoiProposalFeedback(sessionPathForAutonomy, {
          decisionId: pending.decisionId,
          feedbackCategory,
        });
        setAoiAutonomyPendingFeedback(null);
        await refreshAoiAutonomy({ silent: true });
      } catch (error) {
        setAoiAutonomyError(error instanceof Error ? error.message : String(error));
      } finally {
        setAoiAutonomyActionId(null);
      }
    },
    [aoiAutonomyPendingFeedback, refreshAoiAutonomy],
  );

  const prepareAoiKiraHandoffFromPanel = useCallback(
    async (proposal: AoiProposal) => {
      const actionId = `proposal:${proposal.id}:preview`;
      const sessionPathForAutonomy = sessionPathRef.current;
      setAoiAutonomyActionId(actionId);
      setAoiAutonomyError('');

      try {
        const result = await previewAoiProposalAction({
          sessionPath: sessionPathForAutonomy,
          proposalId: proposal.id,
        });
        setAoiKiraHandoffPreviews((prev) => ({
          ...prev,
          [proposal.id]: result,
        }));
        const safeAlternative =
          typeof result.result?.safeAlternative === 'string' ? result.result.safeAlternative : '';
        setAoiAutonomyExecutionMessages((prev) => ({
          ...prev,
          [proposal.id]: result.previewed
            ? 'Kira handoff preview is ready. Review it before creating the work item.'
            : `Kira handoff blocked: ${
                result.reasons.join(', ') || result.outcome
              }${safeAlternative ? ` Safe narrowing: ${safeAlternative}` : ''}`,
        }));
        setAoiAutonomyStatus(result.status);
        await refreshAoiAutonomy({ silent: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setAoiAutonomyError(message);
        setAoiAutonomyExecutionMessages((prev) => ({
          ...prev,
          [proposal.id]: `Kira handoff preview failed: ${message}`,
        }));
      } finally {
        setAoiAutonomyActionId(null);
      }
    },
    [refreshAoiAutonomy],
  );

  const executeAoiProposalFromPanel = useCallback(
    async (proposal: AoiProposal) => {
      if (
        proposal.acceptAction?.kind === 'create_kira_work' &&
        !getAoiKiraHandoffPreview(aoiKiraHandoffPreviews[proposal.id])
      ) {
        await prepareAoiKiraHandoffFromPanel(proposal);
        return;
      }
      const actionId = `proposal:${proposal.id}:execute`;
      const sessionPathForAutonomy = sessionPathRef.current;
      setAoiAutonomyActionId(actionId);
      setAoiAutonomyError('');
      recordAoiAutonomyLedgerEvent(
        proposal,
        'proposal_execution_started',
        `Started Aoi proposal execution: ${proposal.acceptAction?.kind ?? 'unknown action'}.`,
      );

      try {
        const result = await executeAoiProposalAction({
          sessionPath: sessionPathForAutonomy,
          proposalId: proposal.id,
        });
        const skillDraft =
          result.executed &&
          result.result &&
          typeof result.result.skillDraft === 'object' &&
          result.result.skillDraft !== null
            ? (result.result.skillDraft as {
                name?: unknown;
                description?: unknown;
                triggerTerms?: unknown;
                body?: unknown;
              })
            : null;
        if (
          skillDraft &&
          typeof skillDraft.name === 'string' &&
          typeof skillDraft.body === 'string'
        ) {
          const skill = createUserAoiWorkshopSkill({
            name: skillDraft.name,
            description:
              typeof skillDraft.description === 'string' ? skillDraft.description : undefined,
            triggerTerms: Array.isArray(skillDraft.triggerTerms)
              ? skillDraft.triggerTerms.filter((term): term is string => typeof term === 'string')
              : [],
            body: skillDraft.body,
          });
          setAoiSkills((prev) => {
            const next = upsertAoiWorkshopSkill(prev, skill);
            aoiSkillsRef.current = next;
            saveAoiSkillsWorkshop(next);
            return next;
          });
        }
        setAoiAutonomyStatus(result.status);
        setAoiAutonomyExecutionMessages((prev) => ({
          ...prev,
          [proposal.id]: summarizeAoiExecutionResult(result),
        }));
        setAoiKiraHandoffPreviews((prev) => {
          const commandResult = result.result?.commandResult;
          const approvedCommandPolicy = result.result?.policy;
          if (
            proposal.acceptAction?.kind === 'run_command' &&
            commandResult &&
            typeof commandResult === 'object'
          ) {
            return {
              ...prev,
              [proposal.id]: {
                ok: true,
                sessionPath: result.sessionPath,
                proposal: result.proposal,
                status: result.status,
                previewed: true,
                outcome: 'previewed',
                reasons: result.reasons,
                ...(approvedCommandPolicy && typeof approvedCommandPolicy === 'object'
                  ? { approvedCommandPolicy: approvedCommandPolicy as AoiApprovedCommandPolicy }
                  : {}),
                result: {
                  commandResult,
                  ...(approvedCommandPolicy && typeof approvedCommandPolicy === 'object'
                    ? { approvedCommandPolicy: approvedCommandPolicy as AoiApprovedCommandPolicy }
                    : {}),
                  preparedActionPlan: buildAoiPreparedActionPlan(result.proposal),
                },
              },
            };
          }
          const next = { ...prev };
          delete next[proposal.id];
          return next;
        });
        recordAoiAutonomyLedgerEvent(
          result.proposal,
          result.executed
            ? 'proposal_execution_completed'
            : result.outcome === 'failed'
              ? 'proposal_execution_failed'
              : 'proposal_execution_blocked',
          summarizeAoiExecutionResult(result),
        );
        await refreshAoiAutonomy({ silent: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setAoiAutonomyError(message);
        setAoiAutonomyExecutionMessages((prev) => ({
          ...prev,
          [proposal.id]: `Execution failed: ${message}`,
        }));
        recordAoiAutonomyLedgerEvent(
          proposal,
          'proposal_execution_failed',
          `Execution failed: ${message}`,
        );
      } finally {
        setAoiAutonomyActionId(null);
      }
    },
    [
      aoiKiraHandoffPreviews,
      prepareAoiKiraHandoffFromPanel,
      recordAoiAutonomyLedgerEvent,
      refreshAoiAutonomy,
    ],
  );

  useEffect(() => {
    if (!showSettings) {
      return;
    }

    void refreshAoiAutonomy({ silent: true });
    const intervalId = window.setInterval(() => {
      void refreshAoiAutonomy({ silent: true });
    }, 120000);

    return () => window.clearInterval(intervalId);
  }, [refreshAoiAutonomy, showSettings]);

  useEffect(() => {
    void refreshAoiAutonomy({ silent: true });
    void runAoiAutonomySessionOpenTick();
    const intervalId = window.setInterval(() => {
      void refreshAoiAutonomy({ silent: true });
    }, 300000);

    return () => window.clearInterval(intervalId);
  }, [refreshAoiAutonomy, runAoiAutonomySessionOpenTick, sessionPath]);

  useEffect(() => {
    clearToolCache();
  }, [clearToolCache, sessionPath]);

  const addPendingImageFiles = useCallback(async (files: File[]) => {
    const imageFiles = files.filter((file) => file.type.startsWith('image/'));
    if (imageFiles.length === 0) {
      setAttachmentError('Only PNG, JPEG, WebP, and GIF images can be attached.');
      return;
    }

    const availableSlots = MAX_CHAT_IMAGE_ATTACHMENTS - pendingImageAttachmentsRef.current.length;
    if (availableSlots <= 0) {
      setAttachmentError(`Up to ${MAX_CHAT_IMAGE_ATTACHMENTS} images can be attached per message.`);
      return;
    }

    const selectedFiles = imageFiles.slice(0, availableSlots);
    const skippedCount = imageFiles.length - selectedFiles.length;
    const nextAttachments: ChatImageAttachment[] = [];
    const errors: string[] = [];

    for (const file of selectedFiles) {
      try {
        nextAttachments.push(await fileToChatImageAttachment(file));
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }

    if (nextAttachments.length > 0) {
      setPendingImageAttachments((prev) => {
        const availableSlots = MAX_CHAT_IMAGE_ATTACHMENTS - prev.length;
        if (availableSlots <= 0) {
          return prev;
        }
        const next = [...prev, ...nextAttachments.slice(0, availableSlots)];
        pendingImageAttachmentsRef.current = next;
        return next;
      });
    }

    const notices = [
      ...errors,
      ...(skippedCount > 0
        ? [`${skippedCount} image(s) skipped because the per-message limit was reached.`]
        : []),
    ];
    setAttachmentError(notices[0] ?? '');
  }, []);

  const removePendingImageAttachment = useCallback((attachmentId: string) => {
    setPendingImageAttachments((prev) => {
      const next = prev.filter((attachment) => attachment.id !== attachmentId);
      pendingImageAttachmentsRef.current = next;
      return next;
    });
    setAttachmentError('');
  }, []);

  const handleImageFileInputChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files ?? []);
      event.target.value = '';
      void addPendingImageFiles(files);
    },
    [addPendingImageFiles],
  );

  const handleInputPaste = useCallback(
    (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const clipboard = event.clipboardData;
      if (!clipboard) return;
      const imageFiles = getClipboardImageFiles(clipboard);
      if (imageFiles.length === 0) return;
      if (!clipboard.getData('text/plain')) {
        event.preventDefault();
      }
      void addPendingImageFiles(imageFiles);
    },
    [addPendingImageFiles],
  );

  const handleInputDragOver = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      const hasImageFile = Array.from(event.dataTransfer.items ?? []).some(
        (item) => item.kind === 'file' && item.type.startsWith('image/'),
      );
      if (!hasImageFile) return;
      if (loading) {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'none';
        setImageDropActive(false);
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      setImageDropActive(true);
    },
    [loading],
  );

  const handleInputDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    const relatedTarget = event.relatedTarget;
    if (relatedTarget instanceof Node && event.currentTarget.contains(relatedTarget)) {
      return;
    }
    setImageDropActive(false);
  }, []);

  const handleInputDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      const files = Array.from(event.dataTransfer.files ?? []);
      const hasImageFile = files.some((file) => file.type.startsWith('image/'));
      if (!hasImageFile) {
        setImageDropActive(false);
        return;
      }
      event.preventDefault();
      if (loading) {
        setImageDropActive(false);
        return;
      }
      void addPendingImageFiles(files);
      setImageDropActive(false);
    },
    [addPendingImageFiles, loading],
  );

  const clearPendingImages = useCallback(() => {
    pendingImageAttachmentsRef.current = [];
    setPendingImageAttachments([]);
    setAttachmentError('');
  }, []);

  useEffect(() => subscribeAoiTtsStatus(setTtsStatusSnapshot), []);

  const speakAssistantMessage = useCallback((content: string, emotion?: string) => {
    if (!conversationPreferencesRef.current?.ttsEnabled) return;
    const latestUserText =
      [...chatHistoryRef.current].reverse().find((message) => message.role === 'user')?.content ??
      '';
    const language = detectPreferredLanguage(
      latestUserText,
      normalizeResponseLanguageMode(conversationPreferencesRef.current?.responseLanguageMode),
    );
    void playAoiTtsMessage({
      text: content,
      emotion,
      language,
      characterName: characterRef.current.character_name,
      characterDescription: characterRef.current.character_desc,
    }).catch((error) => {
      console.warn('[ChatPanel] TTS playback failed', error);
    });
  }, []);

  const emitAssistantMessage = useCallback(
    (
      message: CharacterDisplayMessage,
      options?: {
        updateSuggestedReplies?: boolean;
        applyEmotion?: boolean;
        speak?: boolean;
      },
    ) => {
      addMessage(message);
      setChatHistory((prev) => [...prev, { role: 'assistant', content: message.content }]);
      if (options?.updateSuggestedReplies) {
        setSuggestedReplies(message.suggestedReplies ?? []);
      }
      if (options?.applyEmotion && message.emotion) {
        clearEmotionVideoCache(characterRef.current.id);
        setCurrentEmotion(message.emotion);
      }
      if (options?.speak !== false) {
        speakAssistantMessage(message.content, message.emotion);
      }
    },
    [addMessage, speakAssistantMessage],
  );

  useEffect(() => {
    if (conversationPreferences?.ttsEnabled) return;
    stopAoiTtsPlayback();
  }, [conversationPreferences?.ttsEnabled]);

  useEffect(() => {
    if (!conversationPreferences?.ttsEnabled) return;
    if (conversationPreferences?.ttsPreloadCommonPhrases === false) return;

    const latestUserText =
      [...chatHistoryRef.current].reverse().find((message) => message.role === 'user')?.content ??
      '';
    const language = detectPreferredLanguage(
      latestUserText,
      normalizeResponseLanguageMode(conversationPreferences?.responseLanguageMode),
    );

    void prewarmAoiTtsCommonPhrases({
      language,
      characterName: character.character_name,
      characterDescription: character.character_desc,
    }).catch((error) => {
      console.warn('[ChatPanel] TTS prewarm failed', error);
    });
  }, [
    conversationPreferences?.ttsEnabled,
    conversationPreferences?.ttsPreloadCommonPhrases,
    conversationPreferences?.responseLanguageMode,
    character.character_name,
    character.character_desc,
  ]);

  useEffect(() => {
    if (!conversationPreferences?.ttsEnabled) return;
    if (conversationPreferences?.ttsPreloadCommonPhrases === false) return;

    const latestUserText =
      [...chatHistoryRef.current].reverse().find((message) => message.role === 'user')?.content ??
      '';
    const language = detectPreferredLanguage(
      latestUserText,
      normalizeResponseLanguageMode(conversationPreferences?.responseLanguageMode),
    );
    const recentAssistantLines = messages
      .filter((message) => message.role === 'assistant' && typeof message.content === 'string')
      .map((message) => message.content.trim())
      .filter(Boolean)
      .filter((content) => content.length <= 280)
      .slice(-12);

    if (recentAssistantLines.length === 0) return;

    void prewarmAoiTtsLines({
      lines: recentAssistantLines,
      language,
      characterName: character.character_name,
      characterDescription: character.character_desc,
    }).catch((error) => {
      console.warn('[ChatPanel] Recent TTS prewarm failed', error);
    });
  }, [
    messages,
    conversationPreferences?.ttsEnabled,
    conversationPreferences?.ttsPreloadCommonPhrases,
    conversationPreferences?.responseLanguageMode,
    character.character_name,
    character.character_desc,
  ]);

  const buildRequiredPreviewParams = useCallback(
    (toolName: string, params: Record<string, unknown>): Record<string, unknown> | null => {
      const filePath = typeof params.file_path === 'string' ? params.file_path : '';
      if (!filePath) return null;
      if (toolName === 'file_write') {
        return {
          operation: 'write',
          file_path: filePath,
          content:
            typeof params.content === 'string' ? params.content : String(params.content ?? ''),
        };
      }
      if (toolName === 'file_patch') {
        return {
          operation: 'patch',
          file_path: filePath,
          old_text:
            typeof params.old_text === 'string' ? params.old_text : String(params.old_text ?? ''),
          new_text:
            typeof params.new_text === 'string' ? params.new_text : String(params.new_text ?? ''),
          replace_all: params.replace_all === true,
        };
      }
      if (toolName === 'file_delete') {
        return {
          operation: 'delete',
          file_path: filePath,
        };
      }
      return null;
    },
    [],
  );

  const runCachedTool = useCallback(
    async (
      toolName: string,
      params: Record<string, unknown>,
      runner: () => Promise<string>,
    ): Promise<string> => {
      const cached = toolCacheRef.current.get(toolName, params);
      if (cached !== null) {
        console.info('[ChatPanel] Tool cache hit', { toolName, params });
        return cached;
      }
      const result = await runner();
      if (!/^error:/i.test(result.trim())) {
        toolCacheRef.current.set(toolName, params, result);
      }
      return result;
    },
    [],
  );

  // User action queue
  const actionQueueRef = useRef<string[]>([]);
  const processingRef = useRef(false);

  const processActionQueue = useCallback(async () => {
    if (processingRef.current) return;
    processingRef.current = true;

    while (actionQueueRef.current.length > 0) {
      const actionMsg = actionQueueRef.current.shift()!;
      const { mainConfig: cfg, dialogConfig } = await refreshConversationConfigs();
      if (!hasUsableLLMConfig(cfg)) break;
      hasUserInteractedRef.current = true;

      const newHistory: ChatMessage[] = [
        ...chatHistoryRef.current,
        { role: 'user', content: actionMsg },
      ];
      setChatHistory(newHistory);
      const abortController = new AbortController();
      conversationAbortRef.current = abortController;
      let didTimeout = false;
      const timeoutId = window.setTimeout(() => {
        didTimeout = true;
        abortController.abort();
      }, ACTION_QUEUE_CONVERSATION_TIMEOUT_MS);
      const loadingRunId = beginChatLoading('Responding to app action', {
        provider: cfg.provider,
        model: cfg.model,
      });
      try {
        await runConversation(newHistory, cfg, dialogConfig, {
          signal: abortController.signal,
          onStatus: updateChatLoadingStatus,
        });
      } catch (err) {
        if (isChatAbortError(err) && didTimeout) {
          logger.warn(
            'ChatPanel',
            `App action conversation timed out after ${ACTION_QUEUE_CONVERSATION_TIMEOUT_MS}ms.`,
            { actionMsg },
          );
          continue;
        }
        if (isChatAbortError(err)) {
          logger.info('ChatPanel', 'App action conversation cancelled.');
          continue;
        }
        logger.error('ChatPanel', 'User action error:', err);
      } finally {
        window.clearTimeout(timeoutId);
        finishChatLoading(loadingRunId);
      }
    }
    processingRef.current = false;
  }, [beginChatLoading, finishChatLoading, refreshConversationConfigs, updateChatLoadingStatus]);

  // Listen for user actions from apps
  useEffect(() => {
    const unsubscribe = onUserAction((event: unknown) => {
      const cfg = configRef.current;
      if (!hasUsableLLMConfig(cfg)) return;

      const evt = event as {
        app_action?: {
          app_id: number;
          action_type: string;
          params?: Record<string, string>;
          trigger_by?: number;
        };
        action_result?: string;
      };
      logger.info('ChatPanel', 'onUserAction received:', evt);
      if (evt.action_result !== undefined) return;
      const action = evt.app_action;
      if (!action) return;
      if (action.trigger_by === 2) return;

      const app = APP_REGISTRY.find((a) => a.appId === action.app_id);
      if (!app) return;

      if (shouldSuppressUserActionConversation(app, action)) {
        logger.info('ChatPanel', 'Suppressing low-signal user action conversation:', {
          appName: app.appName,
          actionType: action.action_type,
          params: action.params,
        });
        return;
      }

      if (
        app.appName === 'kira' &&
        ['CREATE_WORK', 'UPDATE_WORK', 'REFRESH_KIRA'].includes(action.action_type)
      ) {
        void triggerKiraAutomationScan(sessionPathRef.current).catch((error) => {
          logger.error('ChatPanel', 'Kira automation scan trigger failed:', error);
        });
      }

      const actionMsg = buildUserActionMessage(app, action);
      clearToolCache();
      actionQueueRef.current.push(actionMsg);
      processActionQueue();
    });
    return unsubscribe;
  }, [clearToolCache, processActionQueue]);

  useEffect(() => {
    let disposed = false;

    const tick = async () => {
      if (disposed) return;
      try {
        const triggered = await pollBackgroundWatches();
        if (disposed || triggered.length === 0) return;
        clearToolCache();
        for (const item of triggered) {
          const actionMsg = `[Background watch triggered] label: ${item.watch.label}, scope: ${item.watch.scope}, directory: ${item.watch.directory}, triggerCount: ${item.watch.triggered_count}`;
          actionQueueRef.current.push(actionMsg);
        }
        processActionQueue();
      } catch (error) {
        logger.error('ChatPanel', 'Background watch polling failed:', error);
      }
    };

    const timer = window.setInterval(() => {
      void tick();
    }, 4000);

    void tick();

    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [clearToolCache, processActionQueue]);

  useEffect(() => {
    let disposed = false;

    const pollKiraAutomationEvents = async () => {
      if (!sessionPathRef.current) return;
      try {
        const events = await drainKiraAutomationEvents(sessionPathRef.current);
        if (disposed || events.length === 0) return;

        for (const event of events) {
          if (disposed) break;
          emitAssistantMessage({
            id: `kira-automation-${event.id}`,
            role: 'assistant',
            content: event.message,
          });
          window.dispatchEvent(
            new CustomEvent<KiraAutomationEvent>(KIRA_AUTOMATION_NOTICE_EVENT, {
              detail: event,
            }),
          );
          const isKiraOpen = getWindows().some((win) => win.appId === 18 && !win.minimized);
          if (isKiraOpen) {
            try {
              await dispatchAgentAction({
                app_id: 18,
                action_type: 'REFRESH_KIRA',
                params: { focusId: event.workId, focusType: 'work' },
              });
            } catch (error) {
              logger.error('ChatPanel', 'Failed to refresh Kira after automation event:', error);
            }
          }
        }
      } catch (error) {
        logger.error('ChatPanel', 'Kira automation event polling failed:', error);
      }
    };

    void triggerKiraAutomationScan(sessionPath).catch((error) => {
      logger.error('ChatPanel', 'Initial Kira automation scan failed:', error);
    });
    void pollKiraAutomationEvents();

    const timer = window.setInterval(() => {
      void pollKiraAutomationEvents();
    }, KIRA_AUTOMATION_POLL_INTERVAL_MS);

    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [emitAssistantMessage, sessionPath]);

  useEffect(() => {
    let disposed = false;
    let running = false;

    const checkCalendarReminders = async () => {
      if (running) return;
      running = true;
      try {
        const dueEvents = await loadDueCalendarReminderEvents(Date.now());
        if (dueEvents.length === 0) return;

        for (const event of dueEvents) {
          if (disposed) break;
          const latestUserText =
            [...chatHistoryRef.current].reverse().find((message) => message.role === 'user')
              ?.content ?? '';
          const reminder = await generateCalendarReminderMessage(
            event,
            configRef.current,
            characterRef.current,
            latestUserText,
            normalizeResponseLanguageMode(conversationPreferencesRef.current?.responseLanguageMode),
          );

          emitAssistantMessage(
            {
              id: `calendar-reminder-${event.id}-${Date.now()}`,
              role: 'assistant',
              content: reminder.content,
              emotion: reminder.emotion,
              suggestedReplies: reminder.replies,
            },
            { updateSuggestedReplies: true, applyEmotion: true },
          );

          await markCalendarReminderSent(event);
        }
      } catch (error) {
        logger.error('ChatPanel', 'Calendar reminder polling failed:', error);
      } finally {
        running = false;
      }
    };

    void checkCalendarReminders();
    const timer = window.setInterval(() => {
      void checkCalendarReminders();
    }, CALENDAR_REMINDER_POLL_INTERVAL_MS);

    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [emitAssistantMessage]);

  // Send message
  const handleSend = useCallback(
    async (overrideText?: string) => {
      const text = (overrideText ?? input).trim();
      const outgoingAttachments = overrideText ? [] : pendingImageAttachmentsRef.current;
      const hasImageAttachments = outgoingAttachments.length > 0;
      const messageText =
        text ||
        (hasImageAttachments
          ? buildDefaultImagePrompt(
              normalizeResponseLanguageMode(
                conversationPreferencesRef.current?.responseLanguageMode,
              ),
            )
          : '');
      if (!messageText || loading) return;
      const { mainConfig: liveMainConfig, dialogConfig: liveDialogConfig } =
        await refreshConversationConfigs();
      const outgoingUserMessage: ChatMessage = {
        role: 'user',
        content: messageText,
        ...(hasImageAttachments ? { attachments: outgoingAttachments } : {}),
      };
      const selectedConversationModel = hasImageAttachments
        ? { config: liveMainConfig, useDialogModel: false }
        : selectConversationModel(
            [...chatHistory, outgoingUserMessage],
            liveMainConfig,
            liveDialogConfig,
          );
      const selectedConfig = selectedConversationModel.config;

      if (!selectedConfig || !hasUsableLLMConfig(selectedConfig)) {
        console.info('[ChatPanel] Missing usable LLM config, opening settings modal');
        setSettingsInitialTab('models');
        setShowSettings(true);
        return;
      }

      if (hasImageAttachments && !supportsChatImageAttachments(selectedConfig)) {
        setAttachmentError(
          `Image input is not supported by ${selectedConfig.provider}/${selectedConfig.model}. Select a vision-capable main model.`,
        );
        setSettingsInitialTab('models');
        setShowSettings(true);
        return;
      }

      if (!overrideText) {
        setInput('');
        clearPendingImages();
      }
      setSuggestedReplies([]);
      hasUserInteractedRef.current = true;
      stopAoiTtsPlayback();
      console.info('[ChatPanel] Sending user message', {
        text: messageText,
        imageAttachmentCount: outgoingAttachments.length,
        provider: selectedConfig.provider,
        model: selectedConfig.model,
        baseUrl: selectedConfig.baseUrl,
      });

      const userDisplay: CharacterDisplayMessage = {
        id: String(Date.now()),
        role: 'user',
        content: messageText,
        ...(hasImageAttachments ? { attachments: outgoingAttachments } : {}),
      };
      addMessage(userDisplay);

      const newHistory: ChatMessage[] = [...chatHistory, outgoingUserMessage];
      setChatHistory(newHistory);

      const inferredMemory = extractNameMemory(text);
      if (inferredMemory) {
        try {
          const saved = await saveMemory(sessionPathRef.current, inferredMemory, 'fact');
          await saveAoiManualMemory(sessionPathRef.current, {
            type: 'fact',
            scope: 'user',
            content: inferredMemory,
            importance: 0.95,
            confidence: 0.9,
            tags: ['identity', 'legacy-auto'],
          });
          console.info('[ChatPanel] Auto-saved name memory', saved);
          loadMemories(sessionPathRef.current).then(setMemories);
          refreshAoiMemories();
        } catch (err) {
          console.error('[ChatPanel] Failed to auto-save name memory', err);
        }
      }

      if (!hasImageAttachments && isDirectKiraOpenIntent(text)) {
        try {
          await dispatchAgentAction({
            app_id: KIRA_APP_ID,
            action_type: 'OPEN_APP',
            params: { app_id: String(KIRA_APP_ID) },
          });
          const ack = buildKiraOpenAck(
            text,
            normalizeResponseLanguageMode(conversationPreferencesRef.current?.responseLanguageMode),
          );
          emitAssistantMessage({
            id: String(Date.now()),
            role: 'assistant',
            content: ack,
          });
          recordAoiMemoryTurn({
            userMessage: text,
            assistantMessage: ack,
            toolCalls: ['direct:open_kira'],
            source: 'direct_action',
            llmConfig: selectedConfig,
          });
          return;
        } catch (err) {
          console.error('[ChatPanel] Direct Kira open dispatch failed', err);
        }
      }

      if (!hasImageAttachments && isDirectIdeOpenIntent(text)) {
        try {
          await dispatchAgentAction({
            app_id: IDE_APP_ID,
            action_type: 'OPEN_APP',
            params: { app_id: String(IDE_APP_ID) },
          });
          const ack = buildIdeOpenAck(
            text,
            normalizeResponseLanguageMode(conversationPreferencesRef.current?.responseLanguageMode),
          );
          emitAssistantMessage({
            id: String(Date.now()),
            role: 'assistant',
            content: ack,
          });
          recordAoiMemoryTurn({
            userMessage: text,
            assistantMessage: ack,
            toolCalls: ['direct:open_ide'],
            source: 'direct_action',
            llmConfig: selectedConfig,
          });
          return;
        } catch (err) {
          console.error('[ChatPanel] Direct IDE open dispatch failed', err);
        }
      }

      if (!hasImageAttachments && isDirectPeAnalystOpenIntent(text)) {
        try {
          await dispatchAgentAction({
            app_id: PE_ANALYST_APP_ID,
            action_type: 'OPEN_APP',
            params: { app_id: String(PE_ANALYST_APP_ID) },
          });
          const ack = buildPeAnalystOpenAck(
            text,
            normalizeResponseLanguageMode(conversationPreferencesRef.current?.responseLanguageMode),
          );
          emitAssistantMessage({
            id: String(Date.now()),
            role: 'assistant',
            content: ack,
          });
          recordAoiMemoryTurn({
            userMessage: text,
            assistantMessage: ack,
            toolCalls: ['direct:open_pe_analyst'],
            source: 'direct_action',
            llmConfig: selectedConfig,
          });
          return;
        } catch (err) {
          console.error('[ChatPanel] Direct PE Analyst open dispatch failed', err);
        }
      }

      if (!hasImageAttachments && isDirectYouTubeOpenIntent(text)) {
        try {
          await dispatchAgentAction({
            app_id: YOUTUBE_APP_ID,
            action_type: 'OPEN_APP',
            params: { app_id: String(YOUTUBE_APP_ID) },
          });
          const ack = buildYouTubeOpenAck(
            text,
            normalizeResponseLanguageMode(conversationPreferencesRef.current?.responseLanguageMode),
          );
          emitAssistantMessage({
            id: String(Date.now()),
            role: 'assistant',
            content: ack,
          });
          recordAoiMemoryTurn({
            userMessage: text,
            assistantMessage: ack,
            toolCalls: ['direct:open_youtube'],
            source: 'direct_action',
            llmConfig: selectedConfig,
          });
          return;
        } catch (err) {
          console.error('[ChatPanel] Direct YouTube open dispatch failed', err);
        }
      }

      if (!hasImageAttachments && isDirectPlaylistPlaybackIntent(text)) {
        try {
          const result = await dispatchAgentAction({
            app_id: YOUTUBE_APP_ID,
            action_type: 'PLAY_LAST_PLAYLIST',
          });
          const ack = result.startsWith('error:')
            ? buildPlaylistPlaybackErrorAck(
                text,
                normalizeResponseLanguageMode(
                  conversationPreferencesRef.current?.responseLanguageMode,
                ),
              )
            : buildPlaylistPlaybackAck(
                text,
                normalizeResponseLanguageMode(
                  conversationPreferencesRef.current?.responseLanguageMode,
                ),
              );
          emitAssistantMessage({
            id: String(Date.now()),
            role: 'assistant',
            content: ack,
          });
          recordAoiMemoryTurn({
            userMessage: text,
            assistantMessage: ack,
            toolCalls: ['direct:play_last_playlist'],
            source: 'direct_action',
            llmConfig: selectedConfig,
          });
          return;
        } catch (err) {
          console.error('[ChatPanel] Direct playlist playback dispatch failed', err);
        }
      }

      const directMusicIntent = parseDirectMusicIntent(text, chatHistory);
      if (!hasImageAttachments && directMusicIntent) {
        try {
          await dispatchAgentAction({
            app_id: YOUTUBE_APP_ID,
            action_type: 'OPEN_SEARCH',
            params: { query: directMusicIntent.query },
          });
          const ack = buildDirectMusicAck(
            directMusicIntent.query,
            text,
            normalizeResponseLanguageMode(conversationPreferencesRef.current?.responseLanguageMode),
          );
          emitAssistantMessage({
            id: String(Date.now()),
            role: 'assistant',
            content: ack,
          });
          recordAoiMemoryTurn({
            userMessage: text,
            assistantMessage: ack,
            toolCalls: ['direct:play_music'],
            source: 'direct_action',
            llmConfig: selectedConfig,
          });
          return;
        } catch (err) {
          console.error('[ChatPanel] Direct music intent dispatch failed', err);
        }
      }

      const abortController = new AbortController();
      conversationAbortRef.current = abortController;
      const loadingRunId = beginChatLoading('Preparing Aoi context', {
        provider: selectedConfig.provider,
        model: selectedConfig.model,
      });
      try {
        await runConversation(newHistory, selectedConfig, liveDialogConfig, {
          signal: abortController.signal,
          onStatus: updateChatLoadingStatus,
        });
      } catch (err) {
        if (isChatAbortError(err)) {
          console.info('[ChatPanel] runConversation cancelled');
          return;
        }
        console.error('[ChatPanel] runConversation failed', err);
        logger.error('ChatPanel', 'Error:', err);
        addMessage({
          id: String(Date.now()),
          role: 'assistant',
          content: `Error: ${err instanceof Error ? err.message : String(err)}`,
        });
      } finally {
        finishChatLoading(loadingRunId);
      }
    },
    [
      input,
      loading,
      config,
      chatHistory,
      addMessage,
      beginChatLoading,
      clearPendingImages,
      emitAssistantMessage,
      finishChatLoading,
      publishAoiRunLedgerEntry,
      recordAoiMemoryTurn,
      refreshAoiMemories,
      refreshConversationConfigs,
      updateChatLoadingStatus,
    ],
  );

  // Core conversation loop
  const runConversation = async (
    history: ChatMessage[],
    cfg: LLMConfig,
    dialogCfg?: DialogLlmConfig | null,
    options: ConversationRunOptions = {},
  ) => {
    const updateStatus = options.onStatus ?? (() => undefined);
    throwIfConversationAborted(options.signal);
    updateStatus('Preparing Aoi context');
    console.info('[ChatPanel] runConversation start', {
      historyLength: history.length,
      provider: cfg.provider,
      model: cfg.model,
    });
    await seedMetaFiles();
    throwIfConversationAborted(options.signal);
    await loadActionsFromMeta();
    throwIfConversationAborted(options.signal);
    const hasImageGen = !!imageGenConfigRef.current?.apiKey;
    const hasTavily = !!tavilyConfigRef.current?.apiKey;
    const mm = modManagerRef.current;
    const char = characterRef.current;
    const latestUserTurn = [...history].reverse().find((m) => m.role === 'user');
    const latestUserMessage = latestUserTurn?.content ?? '';
    const latestUserMemoryMessage = latestUserTurn?.attachments?.length
      ? `${latestUserMessage}\n[Attached image(s): ${describeImageAttachmentsForMemory(
          latestUserTurn.attachments,
        )}]`
      : latestUserMessage;
    const { config: activeCfg, useDialogModel } = selectConversationModel(history, cfg, dialogCfg);
    if (!hasUsableLLMConfig(activeCfg)) {
      throw new Error('No usable LLM config was found for this conversation turn.');
    }
    const toolCallRuntimeAvailable = supportsStructuredConversationTools(activeCfg);
    const activeModelRoute: PromptBudgetEntry['modelRoute'] = useDialogModel ? 'dialog' : 'main';
    const confirmedActionRequest = resolveAoiActionConfirmationRequest(latestUserMessage, history);
    const includeAppTools =
      toolCallRuntimeAvailable &&
      !useDialogModel &&
      shouldEnableAppTools(latestUserMessage, history);
    const hasResearchTools = toolCallRuntimeAvailable && !useDialogModel && hasTavily;
    const confirmedResearchRequest = resolveAoiResearchConfirmationRequest(
      latestUserMessage,
      history,
    );
    const shouldPreferResearchRun =
      hasResearchTools && shouldUseAoiResearchRun(latestUserMessage, history);
    const shouldPreSearchWeb =
      hasTavily &&
      !includeAppTools &&
      !shouldPreferResearchRun &&
      shouldUseWebSearch(latestUserMessage);
    const condensedHistory = condenseConversationHistory(history);

    const tools = toolCallRuntimeAvailable
      ? useDialogModel
        ? [getRespondToUserToolDef(), getFinishTargetToolDef()]
        : [
            getRespondToUserToolDef(),
            getFinishTargetToolDef(),
            ...getMemoryToolDefinitions(),
            ...(hasTavily ? getTavilyToolDefinitions() : []),
            ...(hasResearchTools ? getAoiResearchToolDefinitions() : []),
            ...(hasImageGen ? getImageGenToolDefinitions() : []),
            ...(includeAppTools
              ? [
                  getListAppsToolDefinition(),
                  getAppActionToolDefinition(),
                  ...getFileToolDefinitions(),
                  ...getAppSchemaToolDefinitions(),
                  ...getWorkspaceToolDefinitions(),
                  ...getIdeToolDefinitions(),
                  ...getSymbolToolDefinitions(),
                  ...getSemanticToolDefinitions(),
                  ...getAppStateToolDefinitions(),
                  ...getUrlToolDefinitions(),
                  ...getCommandToolDefinitions(),
                  ...getDiagnosticsToolDefinitions(),
                  ...getCheckpointToolDefinitions(),
                  ...getAutofixMacroToolDefinitions(),
                  ...getPreviewToolDefinitions(),
                  ...getUndoToolDefinitions(),
                  ...getBackgroundWatchToolDefinitions(),
                ]
              : []),
          ]
      : [];
    const selectedToolNames = tools.map((tool) => tool.function.name);
    const capabilityPrompt = toolCallRuntimeAvailable
      ? buildAoiCapabilityPrompt(selectedToolNames)
      : '';
    const runGoal = createAoiRunGoalFromMessage(latestUserMessage);
    const runGoalPrompt = buildAoiRunGoalPrompt(runGoal);
    const activeSkillMatches = resolveAoiActiveSkills(latestUserMessage, aoiSkillsRef.current);
    const skillsPrompt = buildAoiSkillsPrompt(activeSkillMatches);
    const mcpPluginPrompt = buildAoiMcpPluginPrompt(aoiMcpPluginsRef.current);
    console.info('[ChatPanel] Tool selection', {
      latestUserMessage,
      useDialogModel,
      activeModel: activeCfg.model,
      toolCallRuntimeAvailable,
      includeAppTools,
      hasResearchTools,
      shouldPreferResearchRun,
      confirmedActionRequest,
      confirmedResearchRequest,
      shouldPreSearchWeb,
      toolNames: selectedToolNames,
      activeSkills: activeSkillMatches.map((match) => match.skill.id),
      activeMcpPlugins: aoiMcpPluginsRef.current
        .filter((entry) => entry.enabled && entry.trusted)
        .map((entry) => entry.id),
    });

    const currentMemories = memoriesRef.current;
    let latestAoiMemories = aoiMemoriesRef.current;
    try {
      updateStatus('Refreshing Aoi memory');
      latestAoiMemories = await loadAoiMemories();
      throwIfConversationAborted(options.signal);
      aoiMemoriesRef.current = latestAoiMemories;
      setAoiMemories(latestAoiMemories);
    } catch (error) {
      if (isChatAbortError(error)) {
        throw error;
      }
      console.warn('[ChatPanel] Failed to refresh Aoi memories before prompt build', error);
    }
    const currentAoiMemoryPrompt = buildAoiMemoryPrompt(latestAoiMemories, latestUserMessage);
    let currentAoiMissionPrompt = '';
    try {
      updateStatus('Refreshing mission state');
      const missionResponse = await fetchAoiMissionState(sessionPathRef.current);
      throwIfConversationAborted(options.signal);
      setAoiMissionState(missionResponse.mission);
      currentAoiMissionPrompt = buildAoiMissionResumePrompt(missionResponse.mission);
    } catch (error) {
      if (isChatAbortError(error)) {
        throw error;
      }
      console.warn('[ChatPanel] Failed to refresh Aoi mission state before prompt build', error);
    }
    let currentAoiContextPrompt = '';
    try {
      updateStatus('Checking current context');
      const contextResponse = await fetchAoiContextRouter(sessionPathRef.current, {
        latestUserMessage,
      });
      throwIfConversationAborted(options.signal);
      setAoiContextRouter(contextResponse.context);
      currentAoiContextPrompt = contextResponse.context?.promptBlock ?? '';
    } catch (error) {
      if (isChatAbortError(error)) {
        throw error;
      }
      console.warn('[ChatPanel] Failed to refresh Aoi context router before prompt build', error);
    }
    const systemPrompt = buildSystemPrompt(
      char,
      mm,
      hasImageGen,
      userProfileRef.current,
      conversationPreferencesRef.current,
      currentMemories,
      hasTavily && toolCallRuntimeAvailable,
      hasResearchTools,
      currentAoiMemoryPrompt,
      currentAoiMissionPrompt,
      currentAoiContextPrompt,
      capabilityPrompt,
      runGoalPrompt,
      skillsPrompt,
      mcpPluginPrompt,
      toolCallRuntimeAvailable,
    );
    const fullMessages: ChatMessage[] = [
      {
        role: 'system',
        content: systemPrompt,
      },
      ...(confirmedResearchRequest
        ? [
            {
              role: 'system' as const,
              content: hasResearchTools
                ? [
                    "The latest user message is a short affirmative reply confirming Aoi's previous research-run proposal.",
                    `Confirmed research request: ${confirmedResearchRequest}`,
                    'Treat this as an instruction to start that research run now. Call start_research before responding to the user.',
                  ].join('\n')
                : [
                    "The latest user message is a short affirmative reply confirming Aoi's previous research-run proposal.",
                    `Confirmed research request: ${confirmedResearchRequest}`,
                    'Research tools are not currently available, so explain that Tavily/Aoi research must be configured before starting the run.',
                  ].join('\n'),
            },
          ]
        : []),
      ...(confirmedActionRequest && !confirmedResearchRequest
        ? [
            {
              role: 'system' as const,
              content: [
                "The latest user message is a short affirmative reply confirming Aoi's previous actionable proposal.",
                `Previous Aoi proposal: ${confirmedActionRequest}`,
                'Treat the latest user message as an instruction to carry out that previous proposal now.',
                toolCallRuntimeAvailable
                  ? 'Use the available tools when the proposal requires app, file, workspace, browser, URL, command, memory, image, or web capabilities.'
                  : 'Tool calls are unavailable in the current provider route, so do not claim execution; give a concise manual fallback or say which configured provider is needed.',
                'If the required tool or configuration is unavailable, say what is missing instead of silently doing nothing.',
              ].join('\n'),
            },
          ]
        : []),
      ...(condensedHistory.summaryMessage ? [condensedHistory.summaryMessage] : []),
      ...condensedHistory.recentHistory,
    ];
    const seedBudgetSnapshot = buildPromptBudgetSnapshot({
      systemPrompt,
      historySummary: condensedHistory.summaryMessage?.content,
      recentHistory: condensedHistory.recentHistory,
      allMessagesForRequest: fullMessages,
      tools,
    });
    logger.info('PromptBudget', 'conversation-seed', seedBudgetSnapshot);
    setPromptBudgetEntries((prev) =>
      [
        ...prev,
        {
          label: 'conversation-seed',
          modelRoute: activeModelRoute,
          modelId: activeCfg.model,
          snapshot: seedBudgetSnapshot,
          createdAt: Date.now(),
        },
      ].slice(-MAX_PROMPT_BUDGET_ENTRIES),
    );
    const runSessionPath = sessionPathRef.current;
    let runLedgerEntry = createAoiRunLedgerEntry({
      goal: runGoal,
      modelRoute: activeModelRoute,
      modelId: activeCfg.model,
      includeAppTools,
      exposedToolNames: selectedToolNames,
    });
    publishAoiRunLedgerEntry(runSessionPath, runLedgerEntry);

    const recordRunLedgerEvent = (
      event: Parameters<typeof appendAoiRunLedgerEvent>[1],
      persist = false,
    ) => {
      runLedgerEntry = appendAoiRunLedgerEvent(runLedgerEntry, event);
      publishAoiRunLedgerEntry(runSessionPath, runLedgerEntry, persist);
    };

    const finalizeRunLedger = (status: 'completed' | 'failed', message?: string) => {
      runLedgerEntry = finalizeAoiRunLedgerEntry(runLedgerEntry, status, message);
      publishAoiRunLedgerEntry(runSessionPath, runLedgerEntry, true);
    };

    let currentMessages: ChatMessage[] = fullMessages;
    let iterations = 0;
    const maxIterations = 10;
    pendingToolCallsRef.current = [];
    let latestDiagnosticsParams: Record<string, unknown> | null = null;
    let latestDiagnosticsHadIssues = false;
    let fileMutatedSinceDiagnostics = false;
    let deliveredAssistantContent = '';
    let deliveredToolCalls: string[] = [];
    let pendingResearchStartAck: string | null = null;
    const researchAckLanguage = detectPreferredLanguage(
      latestUserMessage,
      normalizeResponseLanguageMode(conversationPreferencesRef.current?.responseLanguageMode),
    ) as AoiResearchAckLanguage;
    const rememberResearchStartAck = (result: string): void => {
      const ack = buildAoiResearchStartAckMessage(result, researchAckLanguage);
      if (ack) {
        pendingResearchStartAck = ack;
      }
    };

    if (shouldPreSearchWeb) {
      throwIfConversationAborted(options.signal);
      updateStatus('Searching web evidence');
      const preSearchParams = buildTavilyPreSearchParams(latestUserMessage);
      const pendingSummary = `search_web(${String(preSearchParams.query || '').slice(0, 48)})`;
      pendingToolCallsRef.current.push(pendingSummary);
      try {
        const result = await executeTavilyTool(preSearchParams, tavilyConfigRef.current);
        throwIfConversationAborted(options.signal);
        const summarizedResult = summarizeToolResultForModel('search_web', result);
        console.info('[ChatPanel] Tavily pre-search result', {
          resultPreview: result.slice(0, 200),
        });
        currentMessages = [
          ...currentMessages,
          {
            role: 'system',
            content: [
              'Web search evidence for this turn:',
              '- Tavily search was required because the user asked about current or time-sensitive information.',
              '- Use these search results before answering. Do not call search_web again unless this evidence is insufficient.',
              '',
              summarizedResult,
            ].join('\n'),
          },
        ];
      } catch (err) {
        if (isChatAbortError(err)) {
          throw err;
        }
        const message = err instanceof Error ? err.message : String(err);
        console.error('[ChatPanel] Tavily pre-search failed', err);
        currentMessages = [
          ...currentMessages,
          {
            role: 'system',
            content: [
              'Web search was required for this turn, but the pre-search failed.',
              `search_web error: ${message}`,
              'Tell the user that live verification failed instead of guessing.',
            ].join('\n'),
          },
        ];
      }
    }

    const diagnosticsResultHasIssues = (result: string): boolean => {
      if (/^error:/i.test(result.trim())) return true;
      try {
        const parsed = JSON.parse(result) as {
          diagnostic_count?: number;
          exitCode?: number;
          timedOut?: boolean;
        };
        return (
          (parsed.diagnostic_count ?? 0) > 0 || !!parsed.timedOut || (parsed.exitCode ?? 0) !== 0
        );
      } catch {
        return true;
      }
    };

    while (iterations < maxIterations) {
      throwIfConversationAborted(options.signal);
      iterations++;
      updateStatus(
        `Waiting for ${getProviderDisplayName(activeCfg.provider)} / ${activeCfg.model}`,
      );
      console.info('[ChatPanel] LLM iteration start', {
        iteration: iterations,
        messageCount: currentMessages.length,
        toolCount: tools.length,
      });
      const iterationBudgetSnapshot = buildPromptBudgetSnapshot({
        systemPrompt,
        historySummary: condensedHistory.summaryMessage?.content,
        recentHistory: condensedHistory.recentHistory,
        allMessagesForRequest: currentMessages,
        tools,
      });
      logger.info('PromptBudget', 'iteration-request', {
        iteration: iterations,
        ...iterationBudgetSnapshot,
      });
      setPromptBudgetEntries((prev) =>
        [
          ...prev,
          {
            label: 'iteration-request',
            iteration: iterations,
            modelRoute: activeModelRoute,
            modelId: activeCfg.model,
            snapshot: iterationBudgetSnapshot,
            createdAt: Date.now(),
          },
        ].slice(-MAX_PROMPT_BUDGET_ENTRIES),
      );
      let response: Awaited<ReturnType<typeof chat>>;
      try {
        response = await chat(currentMessages, tools, activeCfg, { signal: options.signal });
        throwIfConversationAborted(options.signal);
      } catch (error) {
        finalizeRunLedger(
          'failed',
          error instanceof Error ? error.message : `Model call failed: ${String(error)}`,
        );
        throw error;
      }
      console.info('[ChatPanel] LLM iteration response', {
        iteration: iterations,
        contentPreview: response.content.slice(0, 200),
        toolCallCount: response.toolCalls.length,
        toolNames: response.toolCalls.map((tc) => tc.function.name),
      });
      recordRunLedgerEvent({
        type: 'model_response',
        iteration: iterations,
        message: response.content.slice(0, 200),
        toolNames: response.toolCalls.map((tc) => tc.function.name),
      });

      if (response.toolCalls.length === 0) {
        // No tool calls — fallback plain text (shouldn't happen with respond_to_user requirement)
        const fallbackContent = response.content.trim()
          ? response.content
          : pendingResearchStartAck;
        if (fallbackContent) {
          console.info('[ChatPanel] Assistant plain-text fallback response', {
            contentPreview: fallbackContent.slice(0, 200),
          });
          emitAssistantMessage({
            id: String(Date.now()),
            role: 'assistant',
            content: fallbackContent,
            toolCalls:
              pendingToolCallsRef.current.length > 0 ? [...pendingToolCallsRef.current] : undefined,
          });
          deliveredAssistantContent = fallbackContent;
          deliveredToolCalls =
            pendingToolCallsRef.current.length > 0 ? [...pendingToolCallsRef.current] : [];
          pendingToolCallsRef.current = [];
          pendingResearchStartAck = null;
          recordRunLedgerEvent({
            type: 'plain_text_fallback',
            iteration: iterations,
            message: fallbackContent.slice(0, 200),
            toolNames: deliveredToolCalls,
          });
        }
        break;
      }

      // Has tool calls
      const batchHasRespondTool = response.toolCalls.some(
        (tc) => tc.function.name === 'respond_to_user',
      );
      const batchHasMemoryTool = response.toolCalls.some((tc) => isMemoryTool(tc.function.name));
      const assistantMsg: ChatMessage = {
        role: 'assistant',
        content: response.content,
        tool_calls: response.toolCalls,
        reasoning_content: response.reasoningContent,
      };
      currentMessages = [...currentMessages, assistantMsg];

      if (canParallelizeToolBatch(response.toolCalls)) {
        throwIfConversationAborted(options.signal);
        updateStatus('Running tool actions');
        const parallelResults = await Promise.allSettled(
          response.toolCalls.map(async (tc) => {
            throwIfConversationAborted(options.signal);
            let params: Record<string, unknown> = {};
            try {
              params = JSON.parse(tc.function.arguments);
            } catch {
              // ignore malformed args and let the tool fail naturally
            }

            if (tc.function.name === 'list_apps') {
              const result = await runCachedTool(tc.function.name, params, async () =>
                executeListApps(),
              );
              return {
                toolCallId: tc.id,
                pendingSummary: 'list_apps',
                summarizedResult: summarizeToolResultForModel(tc.function.name, result),
              };
            }

            if (isFileTool(tc.function.name)) {
              const result =
                tc.function.name === 'file_read' || tc.function.name === 'file_list'
                  ? await runCachedTool(tc.function.name, params, () =>
                      executeFileTool(tc.function.name, params),
                    )
                  : await executeFileTool(tc.function.name, params);
              return {
                toolCallId: tc.id,
                pendingSummary: `${tc.function.name}(${JSON.stringify(params).slice(0, 60)})`,
                summarizedResult: summarizeToolResultForModel(tc.function.name, result),
              };
            }

            if (isWorkspaceTool(tc.function.name)) {
              const result = await runCachedTool(tc.function.name, params, () =>
                executeWorkspaceTool(params),
              );
              return {
                toolCallId: tc.id,
                pendingSummary: `workspace_search(${String(params.query || '').slice(0, 48)})`,
                summarizedResult: summarizeToolResultForModel(tc.function.name, result),
              };
            }

            if (isAppSchemaTool(tc.function.name)) {
              const result = await runCachedTool(tc.function.name, params, () =>
                executeAppSchemaTool(params),
              );
              return {
                toolCallId: tc.id,
                pendingSummary: `get_app_schema(${String(params.app_name || params.file_path || '').slice(0, 48)})`,
                summarizedResult: summarizeToolResultForModel(tc.function.name, result),
              };
            }

            if (isIdeTool(tc.function.name)) {
              const result = isIdeMutationTool(tc.function.name)
                ? await executeIdeTool(tc.function.name, params)
                : await runCachedTool(tc.function.name, params, () =>
                    executeIdeTool(tc.function.name, params),
                  );
              if (!/^error:/i.test(result) && isIdeMutationTool(tc.function.name)) {
                clearToolCache();
                if (latestDiagnosticsParams && latestDiagnosticsHadIssues) {
                  fileMutatedSinceDiagnostics = true;
                }
              }
              return {
                toolCallId: tc.id,
                pendingSummary: getIdeToolPendingSummary(tc.function.name, params),
                summarizedResult: summarizeToolResultForModel(tc.function.name, result),
              };
            }

            if (isSemanticTool(tc.function.name)) {
              const result = await runCachedTool(tc.function.name, params, () =>
                executeSemanticTool(tc.function.name, params),
              );
              return {
                toolCallId: tc.id,
                pendingSummary: `${tc.function.name}(${String(params.symbol || params.directory || '').slice(0, 48)})`,
                summarizedResult: summarizeToolResultForModel(tc.function.name, result),
              };
            }

            if (isAppStateTool(tc.function.name)) {
              const result = await runCachedTool(tc.function.name, params, () =>
                executeAppStateTool(params),
              );
              return {
                toolCallId: tc.id,
                pendingSummary: `get_app_state(${String(params.app_name || 'all').slice(0, 48)})`,
                summarizedResult: summarizeToolResultForModel(tc.function.name, result),
              };
            }

            if (isUrlTool(tc.function.name)) {
              const result = await runCachedTool(tc.function.name, params, () =>
                executeUrlTool(params),
              );
              return {
                toolCallId: tc.id,
                pendingSummary: `read_url(${String(params.url || '').slice(0, 48)})`,
                summarizedResult: summarizeToolResultForModel(tc.function.name, result),
              };
            }

            if (isCommandTool(tc.function.name)) {
              if (!toolSafetyPolicyRef.current.allowWorkspaceCommands) {
                throw new Error('Workspace commands are disabled by the current safety policy.');
              }
              const result = await runCachedTool(tc.function.name, params, () =>
                executeCommandTool(params),
              );
              return {
                toolCallId: tc.id,
                pendingSummary: `run_command(${String(params.command || '').slice(0, 48)})`,
                summarizedResult: summarizeToolResultForModel(tc.function.name, result),
              };
            }

            if (isDiagnosticsTool(tc.function.name)) {
              if (!toolSafetyPolicyRef.current.allowWorkspaceCommands) {
                throw new Error('Workspace commands are disabled by the current safety policy.');
              }
              const result = await runCachedTool(tc.function.name, params, () =>
                executeDiagnosticsTool(params),
              );
              return {
                toolCallId: tc.id,
                pendingSummary: `structured_diagnostics(${String(params.command || '').slice(0, 48)})`,
                summarizedResult: summarizeToolResultForModel(tc.function.name, result),
              };
            }

            if (isPreviewTool(tc.function.name)) {
              const result = await runCachedTool(tc.function.name, params, () =>
                executePreviewTool(params),
              );
              return {
                toolCallId: tc.id,
                pendingSummary: `preview_changes(${String(params.file_path || '').slice(0, 48)})`,
                summarizedResult: summarizeToolResultForModel(tc.function.name, result),
              };
            }

            if (isAoiResearchTool(tc.function.name)) {
              const result = await runCachedTool(tc.function.name, params, () =>
                executeAoiResearchTool(tc.function.name, params, sessionPathRef.current),
              );
              return {
                toolCallId: tc.id,
                pendingSummary: getAoiResearchToolPendingSummary(tc.function.name, params),
                summarizedResult: summarizeToolResultForModel(tc.function.name, result),
              };
            }

            if (isTavilyTool(tc.function.name)) {
              const result = await runCachedTool(tc.function.name, params, () =>
                executeTavilyTool(params, tavilyConfigRef.current),
              );
              return {
                toolCallId: tc.id,
                pendingSummary: `search_web(${String(params.query || '').slice(0, 48)})`,
                summarizedResult: summarizeToolResultForModel(tc.function.name, result),
              };
            }

            return {
              toolCallId: tc.id,
              pendingSummary: tc.function.name,
              summarizedResult: 'error: unsupported parallel tool',
            };
          }),
        );

        throwIfConversationAborted(options.signal);
        for (let index = 0; index < parallelResults.length; index++) {
          const settled = parallelResults[index];
          const toolCall = response.toolCalls[index];
          const item =
            settled.status === 'fulfilled'
              ? settled.value
              : {
                  toolCallId: toolCall.id,
                  pendingSummary: toolCall.function.name,
                  summarizedResult: `error: ${settled.reason instanceof Error ? settled.reason.message : String(settled.reason)}`,
                };

          pendingToolCallsRef.current.push(item.pendingSummary);
          currentMessages = [
            ...currentMessages,
            { role: 'tool', content: item.summarizedResult, tool_call_id: item.toolCallId },
          ];
        }

        continue;
      }

      // Execute each tool call
      let shouldStopAfterToolBatch = false;
      for (const tc of response.toolCalls) {
        throwIfConversationAborted(options.signal);
        updateStatus(`Running ${tc.function.name}`);
        let params: Record<string, unknown> = {};
        try {
          params = JSON.parse(tc.function.arguments);
        } catch {
          // ignore
        }
        console.info('[ChatPanel] Executing tool call', {
          tool: tc.function.name,
          params,
          toolCallId: tc.id,
        });

        // ---- respond_to_user ----
        if (tc.function.name === 'respond_to_user') {
          if (
            toolSafetyPolicyRef.current.autoVerifyFixes &&
            latestDiagnosticsParams &&
            fileMutatedSinceDiagnostics
          ) {
            const verificationResult = await executeDiagnosticsTool(latestDiagnosticsParams);
            latestDiagnosticsHadIssues = diagnosticsResultHasIssues(verificationResult);
            fileMutatedSinceDiagnostics = false;
            currentMessages = [
              ...currentMessages,
              {
                role: 'system',
                content: latestDiagnosticsHadIssues
                  ? `Auto-fix verification reran structured_diagnostics after file changes and still found issues: ${summarizeToolResultForModel('structured_diagnostics', verificationResult)}. Continue fixing before responding.`
                  : `Auto-fix verification reran structured_diagnostics after file changes and the diagnostics are now clean: ${summarizeToolResultForModel('structured_diagnostics', verificationResult)}. You may now respond to the user.`,
              },
            ];
            continue;
          }

          const expr =
            (params.character_expression as { content?: string; emotion?: string }) ?? {};
          const interaction = (params.user_interaction as { suggested_replies?: string[] }) ?? {};

          const rawContent = expr.content ?? '';
          const content = rawContent.trim() ? rawContent : (pendingResearchStartAck ?? '');
          const emotion = expr.emotion;
          const replies = interaction.suggested_replies ?? [];
          console.info('[ChatPanel] respond_to_user received', {
            contentPreview: content.slice(0, 200),
            emotion,
            replies,
          });
          if (!content.trim()) {
            console.warn('[ChatPanel] respond_to_user returned empty content; requesting retry');
            currentMessages = [
              ...currentMessages,
              {
                role: 'tool',
                content:
                  'respond_to_user error: character_expression.content was empty. Send a non-empty user-visible message.',
                tool_call_id: tc.id,
              },
            ];
            recordRunLedgerEvent({
              type: 'model_response',
              iteration: iterations,
              message: 'respond_to_user returned empty content',
              toolNames: ['respond_to_user'],
            });
            continue;
          }
          if (isPlaceholderAssistantResponse(content, replies)) {
            console.warn(
              '[ChatPanel] respond_to_user returned placeholder content; requesting retry',
            );
            currentMessages = [
              ...currentMessages,
              {
                role: 'tool',
                content:
                  'respond_to_user error: The reply looked like a placeholder/test response. Send a substantive answer to the user and natural suggested replies.',
                tool_call_id: tc.id,
              },
            ];
            recordRunLedgerEvent({
              type: 'model_response',
              iteration: iterations,
              message: 'respond_to_user returned placeholder content',
              toolNames: ['respond_to_user'],
            });
            continue;
          }
          const deliveredPendingToolCalls =
            pendingToolCallsRef.current.length > 0 ? [...pendingToolCallsRef.current] : [];

          emitAssistantMessage(
            {
              id: String(Date.now()),
              role: 'assistant',
              content,
              emotion,
              suggestedReplies: replies,
              toolCalls:
                pendingToolCallsRef.current.length > 0
                  ? [...pendingToolCallsRef.current]
                  : undefined,
            },
            { updateSuggestedReplies: true, applyEmotion: true },
          );
          deliveredAssistantContent = content;
          deliveredToolCalls = deliveredPendingToolCalls;
          pendingToolCallsRef.current = [];
          pendingResearchStartAck = null;
          recordRunLedgerEvent({
            type: 'assistant_delivered',
            iteration: iterations,
            message: content.slice(0, 200),
            toolNames: deliveredToolCalls,
          });
          currentMessages = [
            ...currentMessages,
            { role: 'tool', content: 'Message delivered.', tool_call_id: tc.id },
          ];
          shouldStopAfterToolBatch = true;
          break;
        }

        // ---- finish_target ----
        if (tc.function.name === 'finish_target') {
          const targetIds = (params.target_ids as number[]) ?? [];
          if (mm) {
            const result = mm.finishTarget(targetIds);
            console.info('[ChatPanel] finish_target result', result);
            // Persist state via collection
            const updatedEntry = { config: mm.getConfig(), state: mm.getState() };
            setModCollection((prev) => {
              const updated = {
                ...prev,
                items: { ...prev.items, [updatedEntry.config.id]: updatedEntry },
              };
              saveModCollection(updated);
              return updated;
            });
            setModManager(new ModManager(mm.getConfig(), mm.getState()));

            currentMessages = [
              ...currentMessages,
              { role: 'tool', content: JSON.stringify(result), tool_call_id: tc.id },
            ];
          } else {
            currentMessages = [
              ...currentMessages,
              { role: 'tool', content: 'No mod loaded.', tool_call_id: tc.id },
            ];
          }
          continue;
        }

        // ---- list_apps ----
        if (tc.function.name === 'list_apps') {
          const result = executeListApps();
          console.info('[ChatPanel] list_apps result', result);
          pendingToolCallsRef.current.push(`list_apps`);
          const summarizedResult = summarizeToolResultForModel(tc.function.name, result);
          currentMessages = [
            ...currentMessages,
            { role: 'tool', content: summarizedResult, tool_call_id: tc.id },
          ];
          continue;
        }

        // ---- File tools ----
        if (isFileTool(tc.function.name)) {
          pendingToolCallsRef.current.push(
            `${tc.function.name}(${JSON.stringify(params).slice(0, 60)})`,
          );
          try {
            if (
              toolSafetyPolicyRef.current.requirePreviewBeforeMutation &&
              ['file_write', 'file_patch', 'file_delete'].includes(tc.function.name)
            ) {
              const requiredPreviewParams = buildRequiredPreviewParams(tc.function.name, params);
              if (
                requiredPreviewParams &&
                toolCacheRef.current.get('preview_changes', requiredPreviewParams) === null
              ) {
                throw new Error(
                  'Preview required by safety policy. Run preview_changes for this mutation first.',
                );
              }
            }

            const result =
              tc.function.name === 'file_read' || tc.function.name === 'file_list'
                ? await runCachedTool(tc.function.name, params, () =>
                    executeFileTool(tc.function.name, params as Record<string, unknown>),
                  )
                : await executeFileTool(tc.function.name, params as Record<string, unknown>);
            console.info('[ChatPanel] File tool result', {
              tool: tc.function.name,
              resultPreview: result.slice(0, 200),
            });
            if (
              !/^error:/i.test(result) &&
              ['file_write', 'file_patch', 'file_delete'].includes(tc.function.name)
            ) {
              clearToolCache();
              if (latestDiagnosticsParams && latestDiagnosticsHadIssues) {
                fileMutatedSinceDiagnostics = true;
              }
            }
            const summarizedResult = summarizeToolResultForModel(tc.function.name, result);
            currentMessages = [
              ...currentMessages,
              { role: 'tool', content: summarizedResult, tool_call_id: tc.id },
            ];
          } catch (err) {
            console.error('[ChatPanel] File tool failed', {
              tool: tc.function.name,
              err,
            });
            currentMessages = [
              ...currentMessages,
              {
                role: 'tool',
                content: `error: ${err instanceof Error ? err.message : String(err)}`,
                tool_call_id: tc.id,
              },
            ];
          }
          continue;
        }

        // ---- Preview changes ----
        if (isPreviewTool(tc.function.name)) {
          pendingToolCallsRef.current.push(
            `preview_changes(${String(params.file_path || '').slice(0, 48)})`,
          );
          try {
            const result = await runCachedTool(tc.function.name, params, () =>
              executePreviewTool(params),
            );
            console.info('[ChatPanel] Preview tool result', {
              resultPreview: result.slice(0, 200),
            });
            const summarizedResult = summarizeToolResultForModel(tc.function.name, result);
            currentMessages = [
              ...currentMessages,
              { role: 'tool', content: summarizedResult, tool_call_id: tc.id },
            ];
          } catch (err) {
            console.error('[ChatPanel] Preview tool failed', err);
            currentMessages = [
              ...currentMessages,
              {
                role: 'tool',
                content: `error: ${err instanceof Error ? err.message : String(err)}`,
                tool_call_id: tc.id,
              },
            ];
          }
          continue;
        }

        // ---- Undo last mutation ----
        if (isUndoTool(tc.function.name)) {
          pendingToolCallsRef.current.push('undo_last_action');
          try {
            const result = await executeUndoTool();
            console.info('[ChatPanel] Undo tool result', {
              resultPreview: result.slice(0, 200),
            });
            if (!/^error:/i.test(result)) {
              clearToolCache();
            }
            const summarizedResult = summarizeToolResultForModel(tc.function.name, result);
            currentMessages = [
              ...currentMessages,
              { role: 'tool', content: summarizedResult, tool_call_id: tc.id },
            ];
          } catch (err) {
            console.error('[ChatPanel] Undo tool failed', err);
            currentMessages = [
              ...currentMessages,
              {
                role: 'tool',
                content: `error: ${err instanceof Error ? err.message : String(err)}`,
                tool_call_id: tc.id,
              },
            ];
          }
          continue;
        }

        // ---- Workspace search ----
        if (isWorkspaceTool(tc.function.name)) {
          pendingToolCallsRef.current.push(
            `workspace_search(${String(params.query || '').slice(0, 48)})`,
          );
          try {
            const result = await runCachedTool(tc.function.name, params, () =>
              executeWorkspaceTool(params),
            );
            console.info('[ChatPanel] Workspace tool result', {
              resultPreview: result.slice(0, 200),
            });
            const summarizedResult = summarizeToolResultForModel(tc.function.name, result);
            currentMessages = [
              ...currentMessages,
              { role: 'tool', content: summarizedResult, tool_call_id: tc.id },
            ];
          } catch (err) {
            console.error('[ChatPanel] Workspace tool failed', err);
            currentMessages = [
              ...currentMessages,
              {
                role: 'tool',
                content: `error: ${err instanceof Error ? err.message : String(err)}`,
                tool_call_id: tc.id,
              },
            ];
          }
          continue;
        }

        // ---- App schema ----
        if (isAppSchemaTool(tc.function.name)) {
          pendingToolCallsRef.current.push(
            `get_app_schema(${String(params.app_name || params.file_path || '').slice(0, 48)})`,
          );
          try {
            const result = await runCachedTool(tc.function.name, params, () =>
              executeAppSchemaTool(params),
            );
            console.info('[ChatPanel] App schema tool result', {
              resultPreview: result.slice(0, 200),
            });
            const summarizedResult = summarizeToolResultForModel(tc.function.name, result);
            currentMessages = [
              ...currentMessages,
              { role: 'tool', content: summarizedResult, tool_call_id: tc.id },
            ];
          } catch (err) {
            console.error('[ChatPanel] App schema tool failed', err);
            currentMessages = [
              ...currentMessages,
              {
                role: 'tool',
                content: `error: ${err instanceof Error ? err.message : String(err)}`,
                tool_call_id: tc.id,
              },
            ];
          }
          continue;
        }

        // ---- IDE workspace search ----
        if (isIdeTool(tc.function.name)) {
          pendingToolCallsRef.current.push(getIdeToolPendingSummary(tc.function.name, params));
          try {
            const result = isIdeMutationTool(tc.function.name)
              ? await executeIdeTool(tc.function.name, params)
              : await runCachedTool(tc.function.name, params, () =>
                  executeIdeTool(tc.function.name, params),
                );
            console.info('[ChatPanel] IDE tool result', {
              tool: tc.function.name,
              resultPreview: result.slice(0, 200),
            });
            if (!/^error:/i.test(result) && isIdeMutationTool(tc.function.name)) {
              clearToolCache();
              if (latestDiagnosticsParams && latestDiagnosticsHadIssues) {
                fileMutatedSinceDiagnostics = true;
              }
            }
            const summarizedResult = summarizeToolResultForModel(tc.function.name, result);
            currentMessages = [
              ...currentMessages,
              { role: 'tool', content: summarizedResult, tool_call_id: tc.id },
            ];
          } catch (err) {
            console.error('[ChatPanel] IDE tool failed', err);
            currentMessages = [
              ...currentMessages,
              {
                role: 'tool',
                content: `error: ${err instanceof Error ? err.message : String(err)}`,
                tool_call_id: tc.id,
              },
            ];
          }
          continue;
        }

        // ---- Semantic IDE tools ----
        if (isSemanticTool(tc.function.name)) {
          pendingToolCallsRef.current.push(
            `${tc.function.name}(${String(params.symbol || params.directory || '').slice(0, 48)})`,
          );
          try {
            if (tc.function.name === 'apply_semantic_rename') {
              if (!toolSafetyPolicyRef.current.allowSemanticRefactors) {
                throw new Error('Semantic refactors are disabled by the current safety policy.');
              }
              if (toolSafetyPolicyRef.current.requirePreviewBeforeMutation) {
                const previewSignature = String(params.preview_signature || '').trim();
                if (!previewSignature) {
                  throw new Error(
                    'Preview required by safety policy. Run rename_preview first and pass preview_signature.',
                  );
                }
              }
            }
            const result = await runCachedTool(tc.function.name, params, () =>
              executeSemanticTool(tc.function.name, params),
            );
            console.info('[ChatPanel] Semantic tool result', {
              tool: tc.function.name,
              resultPreview: result.slice(0, 200),
            });
            if (!/^error:/i.test(result) && tc.function.name === 'apply_semantic_rename') {
              clearToolCache();
              if (latestDiagnosticsParams && latestDiagnosticsHadIssues) {
                fileMutatedSinceDiagnostics = true;
              }
            }
            const summarizedResult = summarizeToolResultForModel(tc.function.name, result);
            currentMessages = [
              ...currentMessages,
              { role: 'tool', content: summarizedResult, tool_call_id: tc.id },
            ];
          } catch (err) {
            console.error('[ChatPanel] Semantic tool failed', err);
            currentMessages = [
              ...currentMessages,
              {
                role: 'tool',
                content: `error: ${err instanceof Error ? err.message : String(err)}`,
                tool_call_id: tc.id,
              },
            ];
          }
          continue;
        }

        // ---- Symbol lookup ----
        if (isSymbolTool(tc.function.name)) {
          pendingToolCallsRef.current.push(
            `open_symbol(${String(params.symbol || '').slice(0, 48)})`,
          );
          try {
            const result = await runCachedTool(tc.function.name, params, () =>
              executeSymbolTool(params),
            );
            console.info('[ChatPanel] Symbol tool result', {
              resultPreview: result.slice(0, 200),
            });

            if (!/^error:/i.test(result) && params.open_in_ide === true) {
              const parsed = JSON.parse(result) as { matches?: Array<{ path?: string }> };
              const bestMatch = parsed.matches?.[0]?.path;
              if (bestMatch) {
                await dispatchAgentAction({
                  app_id: 1,
                  action_type: 'OPEN_APP',
                  params: { app_id: '19' },
                });
                await dispatchAgentAction({
                  app_id: 19,
                  action_type: 'OPEN_FILE',
                  params: { path: bestMatch },
                });
              }
            }

            const summarizedResult = summarizeToolResultForModel(tc.function.name, result);
            currentMessages = [
              ...currentMessages,
              { role: 'tool', content: summarizedResult, tool_call_id: tc.id },
            ];
          } catch (err) {
            console.error('[ChatPanel] Symbol tool failed', err);
            currentMessages = [
              ...currentMessages,
              {
                role: 'tool',
                content: `error: ${err instanceof Error ? err.message : String(err)}`,
                tool_call_id: tc.id,
              },
            ];
          }
          continue;
        }

        // ---- App state ----
        if (isAppStateTool(tc.function.name)) {
          pendingToolCallsRef.current.push(
            `get_app_state(${String(params.app_name || 'all').slice(0, 48)})`,
          );
          try {
            const result = await runCachedTool(tc.function.name, params, () =>
              executeAppStateTool(params),
            );
            console.info('[ChatPanel] App state tool result', {
              resultPreview: result.slice(0, 200),
            });
            const summarizedResult = summarizeToolResultForModel(tc.function.name, result);
            currentMessages = [
              ...currentMessages,
              { role: 'tool', content: summarizedResult, tool_call_id: tc.id },
            ];
          } catch (err) {
            console.error('[ChatPanel] App state tool failed', err);
            currentMessages = [
              ...currentMessages,
              {
                role: 'tool',
                content: `error: ${err instanceof Error ? err.message : String(err)}`,
                tool_call_id: tc.id,
              },
            ];
          }
          continue;
        }

        // ---- URL reader ----
        if (isUrlTool(tc.function.name)) {
          pendingToolCallsRef.current.push(`read_url(${String(params.url || '').slice(0, 48)})`);
          try {
            const result = await runCachedTool(tc.function.name, params, () =>
              executeUrlTool(params),
            );
            console.info('[ChatPanel] URL tool result', {
              resultPreview: result.slice(0, 200),
            });
            const summarizedResult = summarizeToolResultForModel(tc.function.name, result);
            currentMessages = [
              ...currentMessages,
              { role: 'tool', content: summarizedResult, tool_call_id: tc.id },
            ];
          } catch (err) {
            console.error('[ChatPanel] URL tool failed', err);
            currentMessages = [
              ...currentMessages,
              {
                role: 'tool',
                content: `error: ${err instanceof Error ? err.message : String(err)}`,
                tool_call_id: tc.id,
              },
            ];
          }
          continue;
        }

        // ---- Safe workspace command ----
        if (isCommandTool(tc.function.name)) {
          pendingToolCallsRef.current.push(
            `run_command(${String(params.command || '').slice(0, 48)})`,
          );
          try {
            if (!toolSafetyPolicyRef.current.allowWorkspaceCommands) {
              throw new Error('Workspace commands are disabled by the current safety policy.');
            }
            const result = await runCachedTool(tc.function.name, params, () =>
              executeCommandTool(params),
            );
            console.info('[ChatPanel] Command tool result', {
              resultPreview: result.slice(0, 200),
            });
            const summarizedResult = summarizeToolResultForModel(tc.function.name, result);
            currentMessages = [
              ...currentMessages,
              { role: 'tool', content: summarizedResult, tool_call_id: tc.id },
            ];
          } catch (err) {
            console.error('[ChatPanel] Command tool failed', err);
            currentMessages = [
              ...currentMessages,
              {
                role: 'tool',
                content: `error: ${err instanceof Error ? err.message : String(err)}`,
                tool_call_id: tc.id,
              },
            ];
          }
          continue;
        }

        // ---- Structured diagnostics ----
        if (isDiagnosticsTool(tc.function.name)) {
          pendingToolCallsRef.current.push(
            `structured_diagnostics(${String(params.command || '').slice(0, 48)})`,
          );
          try {
            if (!toolSafetyPolicyRef.current.allowWorkspaceCommands) {
              throw new Error('Workspace commands are disabled by the current safety policy.');
            }
            const result = await runCachedTool(tc.function.name, params, () =>
              executeDiagnosticsTool(params),
            );
            console.info('[ChatPanel] Diagnostics tool result', {
              resultPreview: result.slice(0, 200),
            });
            latestDiagnosticsParams = { ...params };
            latestDiagnosticsHadIssues = diagnosticsResultHasIssues(result);
            fileMutatedSinceDiagnostics = false;
            const summarizedResult = summarizeToolResultForModel(tc.function.name, result);
            currentMessages = [
              ...currentMessages,
              { role: 'tool', content: summarizedResult, tool_call_id: tc.id },
            ];
          } catch (err) {
            console.error('[ChatPanel] Diagnostics tool failed', err);
            currentMessages = [
              ...currentMessages,
              {
                role: 'tool',
                content: `error: ${err instanceof Error ? err.message : String(err)}`,
                tool_call_id: tc.id,
              },
            ];
          }
          continue;
        }

        // ---- Workspace checkpoint ----
        if (isCheckpointTool(tc.function.name)) {
          pendingToolCallsRef.current.push(
            `workspace_checkpoint(${String(params.mode || '').slice(0, 24)})`,
          );
          try {
            const result = await executeCheckpointTool(params);
            console.info('[ChatPanel] Checkpoint tool result', {
              resultPreview: result.slice(0, 200),
            });
            if (!/^error:/i.test(result) && String(params.mode || '').trim() === 'restore') {
              clearToolCache();
            }
            const summarizedResult = summarizeToolResultForModel(tc.function.name, result);
            currentMessages = [
              ...currentMessages,
              { role: 'tool', content: summarizedResult, tool_call_id: tc.id },
            ];
          } catch (err) {
            console.error('[ChatPanel] Checkpoint tool failed', err);
            currentMessages = [
              ...currentMessages,
              {
                role: 'tool',
                content: `error: ${err instanceof Error ? err.message : String(err)}`,
                tool_call_id: tc.id,
              },
            ];
          }
          continue;
        }

        // ---- Autofix diagnostics macro ----
        if (isAutofixMacroTool(tc.function.name)) {
          pendingToolCallsRef.current.push(
            `autofix_diagnostics(${String(params.command || '').slice(0, 48)})`,
          );
          try {
            if (!toolSafetyPolicyRef.current.allowWorkspaceCommands) {
              throw new Error('Workspace commands are disabled by the current safety policy.');
            }
            const result = await executeAutofixMacroTool(params);
            console.info('[ChatPanel] Autofix macro tool result', {
              resultPreview: result.slice(0, 200),
            });
            const parsed = JSON.parse(result) as { diagnostics?: string | Record<string, unknown> };
            if (parsed.diagnostics && typeof parsed.diagnostics === 'object') {
              latestDiagnosticsParams = {
                command: params.command,
                ...(params.directory ? { directory: params.directory } : {}),
              };
              latestDiagnosticsHadIssues =
                ((parsed.diagnostics as { diagnostic_count?: number; exitCode?: number })
                  .diagnostic_count ?? 0) > 0 ||
                ((parsed.diagnostics as { exitCode?: number }).exitCode ?? 0) !== 0;
              fileMutatedSinceDiagnostics = false;
            }
            const summarizedResult = summarizeToolResultForModel(tc.function.name, result);
            currentMessages = [
              ...currentMessages,
              { role: 'tool', content: summarizedResult, tool_call_id: tc.id },
            ];
          } catch (err) {
            console.error('[ChatPanel] Autofix macro tool failed', err);
            currentMessages = [
              ...currentMessages,
              {
                role: 'tool',
                content: `error: ${err instanceof Error ? err.message : String(err)}`,
                tool_call_id: tc.id,
              },
            ];
          }
          continue;
        }

        // ---- Background watch ----
        if (isBackgroundWatchTool(tc.function.name)) {
          pendingToolCallsRef.current.push(
            `background_watch(${String(params.mode || '').slice(0, 24)})`,
          );
          try {
            if (
              !toolSafetyPolicyRef.current.allowBackgroundWatches &&
              String(params.mode || '').trim() === 'create'
            ) {
              throw new Error(
                'Background watch creation is disabled by the current safety policy.',
              );
            }
            const result = await executeBackgroundWatchTool(params);
            console.info('[ChatPanel] Background watch tool result', {
              resultPreview: result.slice(0, 200),
            });
            const summarizedResult = summarizeToolResultForModel(tc.function.name, result);
            currentMessages = [
              ...currentMessages,
              { role: 'tool', content: summarizedResult, tool_call_id: tc.id },
            ];
          } catch (err) {
            console.error('[ChatPanel] Background watch tool failed', err);
            currentMessages = [
              ...currentMessages,
              {
                role: 'tool',
                content: `error: ${err instanceof Error ? err.message : String(err)}`,
                tool_call_id: tc.id,
              },
            ];
          }
          continue;
        }

        // ---- Aoi research tools ----
        if (isAoiResearchTool(tc.function.name)) {
          pendingToolCallsRef.current.push(
            getAoiResearchToolPendingSummary(tc.function.name, params),
          );
          try {
            const result = await runCachedTool(tc.function.name, params, () =>
              executeAoiResearchTool(tc.function.name, params, sessionPathRef.current),
            );
            if (tc.function.name === 'start_research') {
              rememberResearchStartAck(result);
            }
            console.info('[ChatPanel] Aoi research tool result', {
              tool: tc.function.name,
              resultPreview: result.slice(0, 200),
            });
            const summarizedResult = summarizeToolResultForModel(tc.function.name, result);
            currentMessages = [
              ...currentMessages,
              { role: 'tool', content: summarizedResult, tool_call_id: tc.id },
            ];
          } catch (err) {
            console.error('[ChatPanel] Aoi research tool failed', {
              tool: tc.function.name,
              err,
            });
            currentMessages = [
              ...currentMessages,
              {
                role: 'tool',
                content: `error: ${err instanceof Error ? err.message : String(err)}`,
                tool_call_id: tc.id,
              },
            ];
          }
          continue;
        }

        // ---- Tavily web search ----
        if (isTavilyTool(tc.function.name)) {
          pendingToolCallsRef.current.push(
            `search_web(${String(params.query || '').slice(0, 48)})`,
          );
          try {
            const result = await runCachedTool(tc.function.name, params, () =>
              executeTavilyTool(params, tavilyConfigRef.current),
            );
            console.info('[ChatPanel] Tavily tool result', {
              resultPreview: result.slice(0, 200),
            });
            const summarizedResult = summarizeToolResultForModel(tc.function.name, result);
            currentMessages = [
              ...currentMessages,
              { role: 'tool', content: summarizedResult, tool_call_id: tc.id },
            ];
          } catch (err) {
            console.error('[ChatPanel] Tavily tool failed', err);
            currentMessages = [
              ...currentMessages,
              {
                role: 'tool',
                content: `error: ${err instanceof Error ? err.message : String(err)}`,
                tool_call_id: tc.id,
              },
            ];
          }
          continue;
        }

        // ---- Image gen ----
        if (isImageGenTool(tc.function.name)) {
          pendingToolCallsRef.current.push('generate_image');
          try {
            const { result, dataUrl } = await executeImageGenTool(
              params as Record<string, string>,
              imageGenConfigRef.current,
            );
            console.info('[ChatPanel] Image tool result', {
              resultPreview: result.slice(0, 200),
              hasDataUrl: !!dataUrl,
            });
            if (dataUrl) {
              addMessage({
                id: String(Date.now()) + '-img',
                role: 'assistant',
                content: '',
                imageUrl: dataUrl,
              });
            }
            const summarizedResult = summarizeToolResultForModel(tc.function.name, result);
            currentMessages = [
              ...currentMessages,
              { role: 'tool', content: summarizedResult, tool_call_id: tc.id },
            ];
          } catch (err) {
            console.error('[ChatPanel] Image tool failed', err);
            currentMessages = [
              ...currentMessages,
              {
                role: 'tool',
                content: `error: ${err instanceof Error ? err.message : String(err)}`,
                tool_call_id: tc.id,
              },
            ];
          }
          continue;
        }

        // ---- Memory tools ----
        if (isMemoryTool(tc.function.name)) {
          pendingToolCallsRef.current.push(`save_memory`);
          try {
            const result = await executeMemoryTool(
              sessionPathRef.current,
              params as Record<string, string>,
            );
            console.info('[ChatPanel] Memory tool result', {
              resultPreview: result.slice(0, 200),
            });
            const memoryContent = typeof params.content === 'string' ? params.content : '';
            const memoryCategory = typeof params.category === 'string' ? params.category : 'other';
            if (memoryContent.trim()) {
              const permanentParam = (params as Record<string, unknown>).permanent;
              const permanent =
                permanentParam === true ||
                (typeof permanentParam === 'string' &&
                  /^(?:true|yes|1)$/i.test(permanentParam.trim())) ||
                shouldTreatAoiMemoryAsPermanent(latestUserMessage) ||
                shouldTreatAoiMemoryAsPermanent(memoryContent);
              await saveAoiManualMemory(sessionPathRef.current, {
                type: mapMemoryCategoryToAoiType(memoryCategory),
                scope: 'user',
                content: memoryContent,
                importance: permanent ? 0.93 : 0.85,
                confidence: permanent ? 0.88 : 0.82,
                permanent,
                tags: ['manual', memoryCategory],
              });
            }
            // Refresh memories for next turn's SP
            loadMemories(sessionPathRef.current).then(setMemories);
            refreshAoiMemories();
            const summarizedResult = summarizeToolResultForModel(tc.function.name, result);
            currentMessages = [
              ...currentMessages,
              { role: 'tool', content: summarizedResult, tool_call_id: tc.id },
            ];
          } catch (err) {
            console.error('[ChatPanel] Memory tool failed', err);
            currentMessages = [
              ...currentMessages,
              {
                role: 'tool',
                content: `error: ${err instanceof Error ? err.message : String(err)}`,
                tool_call_id: tc.id,
              },
            ];
          }
          continue;
        }

        // ---- app_action ----
        if (tc.function.name === 'app_action') {
          const appAction = parseAppActionToolParams(params);
          const resolved = resolveAppAction(appAction.appName, appAction.actionType);
          if (typeof resolved === 'string') {
            console.error('[ChatPanel] app_action resolve failed', resolved);
            currentMessages = [
              ...currentMessages,
              { role: 'tool', content: resolved, tool_call_id: tc.id },
            ];
            continue;
          }

          pendingToolCallsRef.current.push(`${appAction.appName}/${appAction.actionType}`);

          try {
            const result = await dispatchAgentAction({
              app_id: resolved.appId,
              action_type: resolved.actionType,
              params: appAction.params,
            });
            console.info('[ChatPanel] app_action result', {
              appName: appAction.appName,
              actionType: resolved.actionType,
              result,
            });
            clearToolCache();
            const resultForModel = describeAppActionResultForModel({
              sourceAppId: resolved.appId,
              actionType: resolved.actionType,
              params: appAction.params,
              rawResult: result,
            });
            const summarizedResult = summarizeToolResultForModel(tc.function.name, resultForModel);
            currentMessages = [
              ...currentMessages,
              { role: 'tool', content: summarizedResult, tool_call_id: tc.id },
            ];
          } catch (err) {
            console.error('[ChatPanel] app_action failed', {
              appName: appAction.appName,
              actionType: resolved.actionType,
              err,
            });
            currentMessages = [
              ...currentMessages,
              {
                role: 'tool',
                content: `error: ${err instanceof Error ? err.message : String(err)}`,
                tool_call_id: tc.id,
              },
            ];
          }
          continue;
        }

        // Unknown tool
        currentMessages = [
          ...currentMessages,
          { role: 'tool', content: 'error: unknown tool', tool_call_id: tc.id },
        ];
        console.error('[ChatPanel] Unknown tool call received', tc.function.name);
      }

      if (!batchHasRespondTool && batchHasMemoryTool) {
        const latestUserMessage =
          [...history].reverse().find((m) => m.role === 'user')?.content ?? '';
        const fallbackContent = buildMemoryAckMessage(
          latestUserMessage,
          normalizeResponseLanguageMode(conversationPreferencesRef.current?.responseLanguageMode),
        );
        console.info('[ChatPanel] Using fallback memory acknowledgement', {
          latestUserMessage,
          fallbackContent,
        });
        emitAssistantMessage({
          id: String(Date.now()),
          role: 'assistant',
          content: fallbackContent,
          toolCalls:
            pendingToolCallsRef.current.length > 0 ? [...pendingToolCallsRef.current] : undefined,
        });
        deliveredAssistantContent = fallbackContent;
        deliveredToolCalls =
          pendingToolCallsRef.current.length > 0 ? [...pendingToolCallsRef.current] : [];
        setSuggestedReplies([]);
        pendingToolCallsRef.current = [];
        pendingResearchStartAck = null;
        recordRunLedgerEvent({
          type: 'assistant_delivered',
          iteration: iterations,
          message: fallbackContent.slice(0, 200),
          toolNames: deliveredToolCalls,
        });
        break;
      }

      if (shouldStopAfterToolBatch) {
        console.info('[ChatPanel] Stopping conversation loop after respond_to_user');
        break;
      }
    }
    if (!deliveredAssistantContent.trim() && pendingResearchStartAck) {
      const deliveredPendingToolCalls =
        pendingToolCallsRef.current.length > 0 ? [...pendingToolCallsRef.current] : [];
      emitAssistantMessage({
        id: String(Date.now()),
        role: 'assistant',
        content: pendingResearchStartAck,
        toolCalls:
          pendingToolCallsRef.current.length > 0 ? [...pendingToolCallsRef.current] : undefined,
      });
      deliveredAssistantContent = pendingResearchStartAck;
      deliveredToolCalls = deliveredPendingToolCalls;
      pendingToolCallsRef.current = [];
      pendingResearchStartAck = null;
      recordRunLedgerEvent({
        type: 'assistant_delivered',
        iteration: iterations,
        message: deliveredAssistantContent.slice(0, 200),
        toolNames: deliveredToolCalls,
      });
    }
    if (deliveredAssistantContent.trim()) {
      recordAoiMemoryTurn({
        userMessage: latestUserMemoryMessage,
        assistantMessage: deliveredAssistantContent,
        toolCalls: deliveredToolCalls,
        source: 'chat_turn',
        llmConfig: activeCfg,
      });
      finalizeRunLedger('completed', deliveredAssistantContent);
    } else {
      finalizeRunLedger('failed', 'No assistant response was delivered before the run ended.');
    }

    console.info('[ChatPanel] runConversation end', {
      iterations,
      finalMessageCount: currentMessages.length,
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleOpenLinkInBrowser = useCallback((url: string) => {
    try {
      const parsed = new URL(url);
      const host = parsed.hostname.toLowerCase();
      const isYoutube =
        host === 'youtu.be' ||
        host === 'youtube.com' ||
        host === 'www.youtube.com' ||
        host === 'm.youtube.com';

      void dispatchAgentAction(
        isYoutube
          ? {
              app_id: 3,
              action_type: 'OPEN_VIDEO',
              params: { url },
            }
          : {
              app_id: 17,
              action_type: 'OPEN_URL',
              params: { url },
            },
      );
    } catch {
      void dispatchAgentAction({
        app_id: 17,
        action_type: 'OPEN_URL',
        params: { url },
      });
    }
  }, []);

  const handleOpenLinkExternal = useCallback((url: string) => {
    window.open(url, '_blank', 'noopener,noreferrer');
  }, []);

  const handleChatWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    if (!event.ctrlKey && !event.metaKey) {
      return;
    }
    if (event.deltaY === 0) {
      return;
    }

    event.preventDefault();
    const direction = event.deltaY < 0 ? 1 : -1;
    setChatFontSize((prev) => clampChatFontSize(prev + direction * CHAT_FONT_SIZE_STEP));
  }, []);

  const decreaseChatFontSize = useCallback(() => {
    setChatFontSize((prev) => clampChatFontSize(prev - CHAT_FONT_SIZE_STEP));
  }, []);

  const increaseChatFontSize = useCallback(() => {
    setChatFontSize((prev) => clampChatFontSize(prev + CHAT_FONT_SIZE_STEP));
  }, []);

  const resetChatFontSize = useCallback(() => {
    setChatFontSize(CHAT_FONT_SIZE_DEFAULT);
  }, []);

  const openAoiAutonomySettings = useCallback(() => {
    setSettingsInitialTab('advanced');
    setShowSettings(true);
    void refreshAoiAutonomy({ silent: true });
  }, [refreshAoiAutonomy]);

  const aoiOperatorDigest = useMemo(
    () =>
      buildAoiOperatorDigest({
        sessionPath,
        now: aoiAutonomyStatus?.updatedAt ?? aoiAutonomyLastTickAt ?? Date.now(),
        mission: aoiMissionState,
        activeProposals: aoiAutonomyActiveProposals,
        blockedProposals: aoiAutonomyBlockedProposals,
        recentDecisions: aoiRecentProposalDecisions,
        workspaceSnapshot: aoiWorkspaceSnapshot,
        memories: aoiMemories,
        quietMode: aoiAutonomyPanelSettings.quietMode,
        lastSeenAt: aoiAutonomyLastSeenAt,
        trustCalibrationProfile: aoiAutonomyEvaluation?.trustCalibration,
        operatorHealth: aoiOperatorHealth,
      }),
    [
      aoiAutonomyActiveProposals,
      aoiAutonomyBlockedProposals,
      aoiAutonomyEvaluation?.trustCalibration,
      aoiAutonomyLastSeenAt,
      aoiAutonomyLastTickAt,
      aoiAutonomyPanelSettings.quietMode,
      aoiAutonomyStatus?.updatedAt,
      aoiRecentProposalDecisions,
      aoiMemories,
      aoiMissionState,
      aoiOperatorHealth,
      aoiWorkspaceSnapshot,
      sessionPath,
    ],
  );

  const aoiOperatorVoicePolicy = useMemo(
    () => normalizeAoiOperatorVoicePolicy(conversationPreferences?.operatorVoicePolicy),
    [conversationPreferences?.operatorVoicePolicy],
  );
  const aoiOperatorVoicePanelSummary = useMemo(
    () => buildAoiOperatorVoicePanelSummary(aoiLastOperatorVoiceDecision),
    [aoiLastOperatorVoiceDecision],
  );

  useEffect(() => {
    const event = buildAoiOperatorVoiceEventFromDigest({
      digest: aoiOperatorDigest,
      mission: aoiMissionState,
      now: aoiOperatorDigest.generatedAt,
    });
    const decision = decideAoiOperatorVoiceRender({
      sessionPath,
      event,
      policy: aoiOperatorVoicePolicy,
      mission: aoiMissionState,
      ttsEnabled: conversationPreferences?.ttsEnabled === true,
      mutedForSession: aoiOperatorVoiceMuted,
      previousSpokenDedupeKeys: aoiOperatorVoiceSpokenKeysRef.current,
      recentDecisions: aoiRecentProposalDecisions,
      trustCalibrationProfile: aoiAutonomyEvaluation?.trustCalibration,
      now: aoiOperatorDigest.generatedAt,
    });
    const recordKey = [
      decision.eventDedupeKey ?? 'no-event',
      decision.status,
      decision.summaryId ?? decision.silentReason,
    ].join('|');

    setAoiLastOperatorVoiceDecision(decision);

    if (aoiOperatorVoiceDecisionRecordKeyRef.current !== recordKey) {
      aoiOperatorVoiceDecisionRecordKeyRef.current = recordKey;
      void recordAoiOperatorVoiceDecision(sessionPath, decision).catch((error) => {
        console.warn('[ChatPanel] Failed to record Aoi operator voice decision', error);
      });
    }

    if (!decision.shouldSpeak || !decision.spokenSummary || !event) {
      return;
    }

    const latestUserText =
      [...chatHistoryRef.current].reverse().find((message) => message.role === 'user')?.content ??
      '';
    const language = detectPreferredLanguage(
      latestUserText,
      normalizeResponseLanguageMode(conversationPreferences?.responseLanguageMode),
    );

    void playAoiTtsMessage({
      text: decision.spokenSummary,
      emotion: 'peaceful',
      language,
      characterName: characterRef.current.character_name,
      characterDescription: characterRef.current.character_desc,
    })
      .then(() => {
        aoiOperatorVoiceSpokenKeysRef.current.add(event.dedupeKey);
        aoiOperatorVoiceSpokenKeysRef.current.add(event.id);
      })
      .catch((error) => {
        console.warn('[ChatPanel] Aoi operator voice playback failed', error);
        const failedDecision: AoiVoiceRenderDecision = {
          ...decision,
          id: `${decision.id}-playback-failed`.slice(0, 127),
          status: 'playback_failed',
          shouldSpeak: false,
          silentReason: 'TTS playback failed.',
          reasons: [...decision.reasons, 'playback_failed'],
        };
        setAoiLastOperatorVoiceDecision(failedDecision);
        void recordAoiOperatorVoiceDecision(sessionPath, failedDecision).catch((recordError) => {
          console.warn('[ChatPanel] Failed to record Aoi operator voice failure', recordError);
        });
      });
  }, [
    aoiMissionState,
    aoiOperatorDigest,
    aoiAutonomyEvaluation?.trustCalibration,
    aoiOperatorVoiceMuted,
    aoiOperatorVoicePolicy,
    aoiRecentProposalDecisions,
    conversationPreferences?.responseLanguageMode,
    conversationPreferences?.ttsEnabled,
    sessionPath,
  ]);

  const replayAoiLastOperatorVoice = useCallback(() => {
    if (!aoiLastOperatorVoiceDecision?.spokenSummary) {
      return;
    }
    const latestUserText =
      [...chatHistoryRef.current].reverse().find((message) => message.role === 'user')?.content ??
      '';
    const language = detectPreferredLanguage(
      latestUserText,
      normalizeResponseLanguageMode(conversationPreferencesRef.current?.responseLanguageMode),
    );
    void playAoiTtsMessage({
      text: aoiLastOperatorVoiceDecision.spokenSummary,
      emotion: 'peaceful',
      language,
      characterName: characterRef.current.character_name,
      characterDescription: characterRef.current.character_desc,
    }).catch((error) => {
      console.warn('[ChatPanel] Aoi operator voice replay failed', error);
    });
  }, [aoiLastOperatorVoiceDecision?.spokenSummary]);

  const stopAoiOperatorVoice = useCallback(() => {
    stopAoiTtsPlayback();
  }, []);

  const inlineAoiProposal = useMemo(
    () =>
      selectAoiInlineProposal(aoiAutonomyActiveProposals, aoiAutonomyStatus?.policy, {
        dismissedProposalIds: aoiInlineDismissedProposalIds,
        snoozedProposalIds: aoiInlineSnoozedProposalIds,
        lastShownAt: aoiInlineHiddenAt,
        shownCount: aoiInlineShownCount,
        maxPerSession: aoiAutonomyPanelSettings.maxSuggestionsPerSession,
        quietMode: aoiAutonomyPanelSettings.quietMode,
      }),
    [
      aoiAutonomyActiveProposals,
      aoiAutonomyPanelSettings.maxSuggestionsPerSession,
      aoiAutonomyPanelSettings.quietMode,
      aoiAutonomyStatus?.policy,
      aoiInlineDismissedProposalIds,
      aoiInlineHiddenAt,
      aoiInlineShownCount,
      aoiInlineSnoozedProposalIds,
    ],
  );
  const inlineAoiProposalActionPresentation = useMemo(
    () => (inlineAoiProposal ? buildAoiProposalActionPresentation(inlineAoiProposal) : null),
    [inlineAoiProposal],
  );
  const inlineAoiProposalExplanation = useMemo(
    () =>
      inlineAoiProposal
        ? buildAoiProactiveExplanation({
            proposal: inlineAoiProposal,
            policy: aoiAutonomyStatus?.policy,
            activeProposals: aoiAutonomyActiveProposals,
          })
        : null,
    [aoiAutonomyActiveProposals, aoiAutonomyStatus?.policy, inlineAoiProposal],
  );
  const aoiResumeBrief = aoiOperatorDigest.resumeBrief ?? null;
  const showAoiResumeBrief = Boolean(
    aoiResumeBrief?.visible &&
    aoiResumeBrief.id !== dismissedAoiResumeBriefId &&
    !inlineAoiProposal,
  );

  useEffect(() => {
    if (!inlineAoiProposal) {
      return;
    }
    if (aoiInlineShownProposalIdsRef.current.has(inlineAoiProposal.id)) {
      return;
    }
    aoiInlineShownProposalIdsRef.current.add(inlineAoiProposal.id);
    setAoiInlineShownCount((prev) => prev + 1);
  }, [inlineAoiProposal]);

  if (!visible) return null;

  return (
    <>
      <div
        className={`${styles.panel} ${compact ? styles.compact : ''} ${
          dockSide === 'left' ? styles.dockLeft : styles.dockRight
        }`}
        data-testid="chat-panel"
        style={panelStyle}
        onMouseDown={onFocus}
      >
        <button
          type="button"
          className={`${styles.resizeHandle} ${
            dockSide === 'left' ? styles.resizeHandleRight : styles.resizeHandleLeft
          }`}
          onMouseDown={handlePanelResizeMouseDown}
          aria-label="Resize chat panel width"
          title="Resize chat panel"
          data-testid="chat-panel-resize-handle"
        >
          <GripVertical size={14} />
        </button>

        {/* Left: Character Avatar */}
        {!compact && (
          <div className={styles.avatarSide}>
            <CharacterAvatar
              character={character}
              emotion={currentEmotion}
              onEmotionEnd={() => setCurrentEmotion(undefined)}
            />
          </div>
        )}

        {/* Right: Chat */}
        <div
          className={styles.chatSide}
          style={chatFontStyle}
          onWheel={handleChatWheel}
          data-chat-font-size={chatFontSize}
          title="Ctrl+mouse wheel adjusts chat font size"
        >
          <div className={styles.header}>
            <div
              className={styles.headerLeft}
              onClick={() => setShowCharacterPanel(true)}
              style={{ cursor: 'pointer' }}
            >
              <span className={styles.characterName}>{character.character_name}</span>
              {conversationPreferences?.ttsEnabled && (
                <span className={styles.ttsStatusPill}>
                  {ttsStatusSnapshot.pendingCount > 0
                    ? `TTS warming ${ttsStatusSnapshot.pendingCount}`
                    : `TTS cached ${ttsStatusSnapshot.cachedCount}`}
                </span>
              )}
              <ChevronRight size={14} style={{ color: 'rgba(255,255,255,0.4)' }} />
            </div>
            <div className={styles.headerActions}>
              <div
                className={styles.fontSizeControls}
                aria-label="Chat text size"
                data-testid="chat-font-size-controls"
              >
                <button
                  className={styles.fontSizeBtn}
                  onClick={decreaseChatFontSize}
                  disabled={chatFontSize <= CHAT_FONT_SIZE_MIN}
                  title="Decrease chat text size"
                  data-testid="chat-font-decrease"
                  type="button"
                >
                  <ZoomOut size={14} />
                </button>
                <button
                  className={styles.fontSizeValue}
                  onClick={resetChatFontSize}
                  title="Reset chat text size"
                  data-testid="chat-font-reset"
                  type="button"
                >
                  {chatFontSize}px
                </button>
                <button
                  className={styles.fontSizeBtn}
                  onClick={increaseChatFontSize}
                  disabled={chatFontSize >= CHAT_FONT_SIZE_MAX}
                  title="Increase chat text size"
                  data-testid="chat-font-increase"
                  type="button"
                >
                  <ZoomIn size={14} />
                </button>
              </div>
              <button
                className={styles.iconBtn}
                onClick={handleResetSession}
                title="Reset session"
                data-testid="reset-session"
              >
                <RotateCcw size={16} />
              </button>
              <button
                className={styles.iconBtn}
                onClick={handleClearHistory}
                title="Clear chat"
                data-testid="clear-chat"
              >
                <Trash2 size={16} />
              </button>
              <button
                className={styles.iconBtn}
                onClick={() => setDockSide((prev) => (prev === 'right' ? 'left' : 'right'))}
                title={dockSide === 'right' ? 'Dock left' : 'Dock right'}
                data-testid="toggle-chat-dock"
              >
                {dockSide === 'right' ? <PanelLeft size={16} /> : <PanelRight size={16} />}
              </button>
              <button
                className={styles.iconBtn}
                onClick={() => {
                  setSettingsInitialTab('chat');
                  setShowSettings(true);
                }}
                title="Settings"
                data-testid="settings-btn"
              >
                <Settings size={16} />
              </button>
              <button className={styles.iconBtn} onClick={onClose} title="Minimize">
                <Minus size={16} />
              </button>
              <button className={styles.iconBtn} title="Maximize">
                <Maximize2 size={16} />
              </button>
            </div>
          </div>

          <div className={styles.messages} data-testid="chat-messages">
            {messages.length === 0 && (
              <div className={styles.emptyState}>
                {hasUsableLLMConfig(config)
                  ? `${character.character_name} is ready to chat...`
                  : 'Click the gear icon to configure your LLM connection'}
              </div>
            )}
            {messages.map((msg) => (
              <React.Fragment key={msg.id}>
                <div
                  data-testid="chat-message"
                  className={`${styles.message} ${
                    msg.role === 'user'
                      ? styles.user
                      : msg.role === 'tool'
                        ? styles.toolInfo
                        : styles.assistant
                  }`}
                >
                  {msg.role === 'assistant'
                    ? renderMessageContent(
                        msg.content,
                        handleOpenLinkExternal,
                        handleOpenLinkInBrowser,
                      )
                    : msg.content}
                  {msg.attachments?.map((attachment) => (
                    <div key={attachment.id} className={styles.messageAttachment}>
                      <img
                        src={attachment.dataUrl}
                        alt={attachment.name}
                        className={styles.messageAttachmentImage}
                        data-testid="chat-message-image"
                      />
                      <span className={styles.messageAttachmentMeta}>
                        {attachment.name} · {formatAttachmentSize(attachment.size)}
                      </span>
                    </div>
                  ))}
                  {msg.imageUrl && (
                    <img src={msg.imageUrl} alt="Generated" className={styles.messageImage} />
                  )}
                </div>
                {msg.toolCalls && msg.toolCalls.length > 0 && (
                  <ActionsTaken calls={msg.toolCalls} />
                )}
              </React.Fragment>
            ))}
            {loading && (
              <div className={styles.loading} data-testid="chat-loading">
                <div className={styles.loadingMain}>
                  <span>Thinking...</span>
                  <span className={styles.loadingElapsed}>
                    {formatLoadingElapsed(loadingElapsedSeconds)}
                  </span>
                </div>
                <div className={styles.loadingDetail}>
                  {buildLoadingStatus(loadingInfo, loadingElapsedSeconds)}
                </div>
                {loadingInfo?.cancellable && (
                  <button
                    type="button"
                    className={styles.loadingCancelBtn}
                    onClick={handleCancelChatRun}
                    title="Stop"
                  >
                    <Square size={11} />
                    Stop
                  </button>
                )}
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {showAoiResumeBrief && aoiResumeBrief && !loading && (
            <div className={styles.aoiInlineSuggestion} data-testid="aoi-resume-brief">
              <div className={styles.aoiInlineSuggestionMain}>
                <div className={styles.aoiInlineSuggestionMeta}>
                  <span>Aoi resume brief</span>
                  <span>{aoiOperatorDigest.summary}</span>
                  <span>evidence {aoiResumeBrief.evidenceRefs.length}</span>
                  {aoiOperatorDigest.approvalInbox.length > 0 && (
                    <span>approvals {aoiOperatorDigest.approvalInbox.length}</span>
                  )}
                </div>
                <div className={styles.aoiInlineSuggestionTitle}>
                  {sanitizeAoiProposalDisplayText(aoiResumeBrief.whatChanged, 140)}
                </div>
                <div className={styles.aoiInlineSuggestionBody}>
                  {sanitizeAoiProposalDisplayText(aoiResumeBrief.nextSafeAction, 320)}
                </div>
                <div className={styles.aoiInlineSuggestionHint}>
                  {sanitizeAoiProposalDisplayText(aoiResumeBrief.safetyBoundary, 360)}
                </div>
              </div>
              <div className={styles.aoiInlineSuggestionActions}>
                <button
                  type="button"
                  className={styles.inlineActionBtn}
                  onClick={openAoiAutonomySettings}
                  title="Open Aoi Autonomy digest details"
                >
                  Details
                </button>
                <button
                  type="button"
                  className={styles.inlineActionBtn}
                  onClick={() => setDismissedAoiResumeBriefId(aoiResumeBrief.id)}
                  title="Hide this resume brief"
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}

          {inlineAoiProposal && !loading && (
            <div className={styles.aoiInlineSuggestion} data-testid="aoi-inline-suggestion">
              <div className={styles.aoiInlineSuggestionMain}>
                <div className={styles.aoiInlineSuggestionMeta}>
                  <span>Aoi proposal</span>
                  <span>{inlineAoiProposalExplanation?.confidenceLabel ?? 'proposal'}</span>
                  <span>{inlineAoiProposalExplanation?.risk ?? inlineAoiProposal.risk} risk</span>
                  <span>
                    evidence{' '}
                    {inlineAoiProposalExplanation?.evidenceCount ??
                      inlineAoiProposal.evidenceRefs.length}
                  </span>
                </div>
                <div className={styles.aoiInlineSuggestionTitle}>
                  {sanitizeAoiProposalDisplayText(inlineAoiProposal.title, 120)}
                </div>
                <div className={styles.aoiInlineSuggestionBody}>
                  {sanitizeAoiProposalDisplayText(
                    inlineAoiProposalExplanation?.messageSummary ?? inlineAoiProposal.body,
                    360,
                  )}
                </div>
                <div className={styles.aoiInlineSuggestionHint}>
                  {inlineAoiProposalExplanation?.willNotDoWithoutApproval ??
                    'This is only a proposal. No tool has run.'}
                </div>
              </div>
              <div className={styles.aoiInlineSuggestionActions}>
                <button
                  type="button"
                  className={styles.inlineActionBtn}
                  onClick={() => void decideAoiProposalFromPanel(inlineAoiProposal.id, 'accept')}
                  disabled={aoiAutonomyActionId !== null}
                  title={
                    inlineAoiProposalActionPresentation?.primaryTitle ??
                    'Record approval without executing tools'
                  }
                >
                  {inlineAoiProposalActionPresentation?.primaryLabel ?? 'Approve exact action'}
                </button>
                <button
                  type="button"
                  className={styles.inlineActionBtn}
                  onClick={() => void decideAoiProposalFromPanel(inlineAoiProposal.id, 'snooze')}
                  disabled={aoiAutonomyActionId !== null}
                  title={`Pause this proposal family by cooldown key: ${sanitizeAoiProposalDisplayText(
                    inlineAoiProposal.cooldownKey,
                    120,
                  )}`}
                >
                  Pause suggestion family
                </button>
                {AOI_PROPOSAL_FEEDBACK_CONTROLS.filter((item) => item.category !== 'useful').map(
                  (item) => (
                    <button
                      type="button"
                      key={`inline-${inlineAoiProposal.id}-${item.category}`}
                      className={styles.inlineActionBtn}
                      onClick={() =>
                        void decideAoiProposalFromPanel(
                          inlineAoiProposal.id,
                          item.action,
                          item.category,
                        )
                      }
                      disabled={aoiAutonomyActionId !== null}
                      title={item.title}
                    >
                      {item.label}
                    </button>
                  ),
                )}
                <button
                  type="button"
                  className={styles.inlineActionBtn}
                  onClick={openAoiAutonomySettings}
                  title="Open Aoi Autonomy details"
                >
                  Details
                </button>
              </div>
            </div>
          )}

          {/* Suggested Replies */}
          {suggestedReplies.length > 0 && !loading && (
            <div className={styles.suggestedReplies}>
              {suggestedReplies.map((reply, i) => (
                <button key={i} className={styles.suggestedReply} onClick={() => handleSend(reply)}>
                  {reply}
                </button>
              ))}
            </div>
          )}

          <div
            className={`${styles.inputArea} ${imageDropActive ? styles.inputAreaDropActive : ''}`}
            onDragOver={handleInputDragOver}
            onDragLeave={handleInputDragLeave}
            onDrop={handleInputDrop}
          >
            {pendingImageAttachments.length > 0 && (
              <div className={styles.attachmentTray} data-testid="chat-image-attachment-tray">
                {pendingImageAttachments.map((attachment) => (
                  <div key={attachment.id} className={styles.attachmentPreview}>
                    <img
                      src={attachment.dataUrl}
                      alt={attachment.name}
                      className={styles.attachmentPreviewImage}
                    />
                    <div className={styles.attachmentPreviewMeta}>
                      <span>{attachment.name}</span>
                      <span>
                        {formatAttachmentSize(attachment.size)}
                        {attachment.width && attachment.height
                          ? ` · ${attachment.width}x${attachment.height}`
                          : ''}
                      </span>
                    </div>
                    <button
                      type="button"
                      className={styles.attachmentRemoveBtn}
                      onClick={() => removePendingImageAttachment(attachment.id)}
                      title="Remove image"
                    >
                      <X size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {attachmentError && <div className={styles.attachmentError}>{attachmentError}</div>}
            <div className={styles.inputRow}>
              <button
                type="button"
                className={styles.attachImageBtn}
                onClick={() => imageInputRef.current?.click()}
                disabled={loading || pendingImageAttachments.length >= MAX_CHAT_IMAGE_ATTACHMENTS}
                title="Attach image"
                aria-label="Attach image"
              >
                <ImagePlus size={17} />
              </button>
              <input
                ref={imageInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                multiple
                className={styles.hiddenFileInput}
                onChange={handleImageFileInputChange}
                disabled={loading}
                data-testid="chat-image-file-input"
              />
              <textarea
                className={styles.input}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onPaste={handleInputPaste}
                onKeyDown={handleKeyDown}
                placeholder={
                  pendingImageAttachments.length > 0
                    ? 'Ask about the attached image...'
                    : 'Type a message...'
                }
                rows={1}
                disabled={loading}
                data-testid="chat-input"
              />
              <button
                className={styles.sendBtn}
                onClick={() => handleSend()}
                disabled={loading || (!input.trim() && pendingImageAttachments.length === 0)}
                data-testid="send-btn"
              >
                Send
              </button>
            </div>
            <div
              className={styles.modelUsageHint}
              title={formatCurrentModelUsageTitle(currentModelUsageStatus)}
              data-testid="current-model-usage"
              aria-live="polite"
            >
              {formatCurrentModelUsageLabel(currentModelUsageStatus, config)}
            </div>
          </div>
        </div>
      </div>

      {showSettings && !persistedConfigLoaded && (
        <div className={styles.overlay}>
          <div className={styles.settingsModal} data-testid="settings-loading-modal">
            <div className={styles.settingsHeader}>
              <div className={styles.settingsHeading}>
                <div className={styles.settingsTitle}>Settings</div>
                <div className={styles.settingsSubtitle}>Loading saved settings...</div>
              </div>
              <button className={styles.cancelBtn} onClick={() => setShowSettings(false)}>
                Close
              </button>
            </div>
            <div className={styles.settingsBody}>
              <div className={styles.settingsSection}>
                <span className={styles.modelHint}>
                  Saved configuration is still loading. The settings form will open after the
                  persisted config is ready.
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {showSettings && persistedConfigLoaded && (
        <SettingsModal
          config={config}
          dialogConfig={dialogLlmConfig}
          idaPeConfig={idaPeConfig}
          kiraConfig={kiraConfig}
          userProfile={userProfile}
          conversationPreferences={conversationPreferences}
          ttsStatusSnapshot={ttsStatusSnapshot}
          imageGenConfig={imageGenConfig}
          tavilyConfig={tavilyConfig}
          promptBudgetEntries={promptBudgetEntries}
          aoiMemories={aoiMemories}
          aoiRunLedger={aoiRunLedger}
          aoiAutonomyStatus={aoiAutonomyStatus}
          aoiAutonomyActiveProposals={aoiAutonomyActiveProposals}
          aoiAutonomyArchivedProposals={aoiAutonomyArchivedProposals}
          aoiAutonomyActiveGoals={aoiAutonomyActiveGoals}
          aoiActivePlaybooks={aoiActivePlaybooks}
          aoiMissionState={aoiMissionState}
          aoiEnvironmentSources={aoiEnvironmentSources}
          aoiWorkspaceSnapshot={aoiWorkspaceSnapshot}
          aoiContextRouter={aoiContextRouter}
          aoiAutonomyScheduler={aoiAutonomyScheduler}
          aoiAutonomyEvaluation={aoiAutonomyEvaluation}
          aoiOperatorDigest={aoiOperatorDigest}
          aoiOperatorHealth={aoiOperatorHealth}
          aoiOperatorVoicePolicy={aoiOperatorVoicePolicy}
          aoiOperatorVoiceMuted={aoiOperatorVoiceMuted}
          aoiLastOperatorVoiceDecision={aoiLastOperatorVoiceDecision}
          aoiOperatorVoicePanelSummary={aoiOperatorVoicePanelSummary}
          aoiAutonomyPanelSettings={aoiAutonomyPanelSettings}
          aoiAutonomyBlockedProposals={aoiAutonomyBlockedProposals}
          aoiAutonomyLoading={aoiAutonomyLoading}
          aoiAutonomyError={aoiAutonomyError}
          aoiAutonomyActionId={aoiAutonomyActionId}
          aoiAutonomyLastTickAt={aoiAutonomyLastTickAt}
          aoiAutonomyExecutionMessages={aoiAutonomyExecutionMessages}
          aoiKiraHandoffPreviews={aoiKiraHandoffPreviews}
          aoiAutonomyPendingFeedback={aoiAutonomyPendingFeedback}
          aoiSkills={aoiSkills}
          aoiMcpPlugins={aoiMcpPlugins}
          recentToolActivity={recentToolActivity}
          toolSafetyPolicy={toolSafetyPolicy}
          initialTab={settingsInitialTab}
          onRefreshAoiMemories={refreshAoiMemories}
          onRefreshAoiAutonomy={refreshAoiAutonomy}
          onAdvancedTabVisible={handleAoiAutonomyAdvancedVisible}
          onUpdateAoiAutonomyPolicy={updateAoiAutonomyPolicyFromPanel}
          onUpdateAoiEnvironmentSource={updateAoiEnvironmentSourceFromPanel}
          onRecordAoiContextSourceFeedback={recordAoiContextSourceFeedbackFromPanel}
          onResetAoiTrustCalibration={resetAoiTrustCalibrationFromPanel}
          onUpdateAoiAutonomyPanelSettings={updateAoiAutonomyPanelSettingsFromPanel}
          onRunAoiAutonomyCheck={runAoiAutonomyCheckFromPanel}
          onDecideAoiMission={decideAoiMissionFromPanel}
          onDecideAoiProposal={decideAoiProposalFromPanel}
          onPauseAoiGoalForRecovery={pauseAoiGoalForRecoveryFromPanel}
          onRecordAoiProposalFeedback={recordAoiProposalFeedbackFromPanel}
          onPrepareAoiKiraHandoff={prepareAoiKiraHandoffFromPanel}
          onExecuteAoiProposal={executeAoiProposalFromPanel}
          onToggleAoiOperatorVoiceMute={() => setAoiOperatorVoiceMuted((prev) => !prev)}
          onReplayAoiOperatorVoice={replayAoiLastOperatorVoice}
          onStopAoiOperatorVoice={stopAoiOperatorVoice}
          onSaveAoiPreference={saveAoiPreferenceEntry}
          onDemoteAoiMemory={demoteAoiMemoryEntry}
          onMarkAoiMemoryTemporary={markAoiMemoryTemporaryEntry}
          onArchiveAoiMemory={archiveAoiMemoryEntry}
          onDeleteAoiMemory={deleteAoiMemoryEntry}
          onResetAll={handleResetSessionHistory}
          onSave={(
            c,
            igc,
            dcfg,
            nextIdaPeConfig,
            nextKiraConfig,
            nextUserProfile,
            nextConversationPreferences,
            nextToolSafetyPolicy,
            nextAoiSkills,
            nextAoiMcpPlugins,
            nextTavilyConfig,
          ) => {
            setConfig(c);
            setDialogLlmConfig(dcfg);
            setIdaPeConfig(nextIdaPeConfig);
            setKiraConfig(nextKiraConfig);
            setUserProfile(nextUserProfile);
            setConversationPreferences(nextConversationPreferences);
            setImageGenConfig(igc);
            setTavilyConfig(nextTavilyConfig);
            setToolSafetyPolicy(nextToolSafetyPolicy);
            setAoiSkills(nextAoiSkills);
            setAoiMcpPlugins(nextAoiMcpPlugins);
            userProfileRef.current = nextUserProfile;
            conversationPreferencesRef.current = nextConversationPreferences;
            aoiSkillsRef.current = nextAoiSkills;
            aoiMcpPluginsRef.current = nextAoiMcpPlugins;
            tavilyConfigRef.current = nextTavilyConfig;
            saveConfig(
              c,
              igc,
              dcfg,
              nextIdaPeConfig,
              nextUserProfile,
              nextConversationPreferences,
              nextKiraConfig,
              nextTavilyConfig,
            );
            if (igc) saveImageGenConfig(igc);
            saveUserProfileConfig(nextUserProfile);
            saveConversationPreferences(nextConversationPreferences);
            saveToolSafetyPolicy(nextToolSafetyPolicy);
            saveAoiSkillsWorkshop(nextAoiSkills);
            saveAoiMcpPluginAdmin(nextAoiMcpPlugins);
            dispatchAppSettingsSaved(settingsInitialTab);
            setShowSettings(false);
          }}
          onClose={() => setShowSettings(false)}
        />
      )}

      {showCharacterPanel && (
        <CharacterPanel
          collection={charCollection}
          onSave={(col) => {
            setCharCollection(col);
            saveCharacterCollection(col);
            setShowCharacterPanel(false);
          }}
          onClose={() => setShowCharacterPanel(false)}
        />
      )}

      {showModPanel && (
        <ModPanel
          collection={modCollection}
          initialEditId={initialEditModId}
          onSave={(col) => {
            setModCollection(col);
            saveModCollection(col);
            const entry = getActiveModEntry(col);
            setModManager(new ModManager(entry.config, entry.state));
            setShowModPanel(false);
            setInitialEditModId(undefined);
          }}
          onClose={() => {
            setShowModPanel(false);
            setInitialEditModId(undefined);
          }}
        />
      )}
    </>
  );
};

// ---------------------------------------------------------------------------
// Settings Modal (extended with Character + Mod)
// ---------------------------------------------------------------------------

type SettingsTabKey = AppSettingsTabKey;
type ParallelToolCallsOption = '' | 'enabled' | 'disabled';

interface KiraRoleDraft {
  id: string;
  name: string;
  provider: KiraAgentProvider;
  apiKey: string;
  baseUrl: string;
  model: string;
  customHeaders: string;
  command: string;
  apiStyle: KiraAgentApiStyle | '';
  reasoningEffort: LLMReasoningEffort | '';
  reasoningSummary: LLMReasoningSummary | '';
  verbosity: LLMVerbosity | '';
  serviceTier: string;
  parallelToolCalls: ParallelToolCallsOption;
}

interface RuntimeModelOption {
  id: string;
  name: string;
}

type RuntimeModelStatus = 'idle' | 'loading' | 'loaded' | 'error';
type ClaudeCliConnectionCheckState = 'idle' | 'checking' | 'ok' | 'error';
type CodexAuthState = 'idle' | 'checking' | 'logging-in' | 'ok' | 'error';

interface ClaudeCliConnectionCheckStatus {
  state: ClaudeCliConnectionCheckState;
  message: string;
  details: string[];
}

interface CodexAuthUiStatus {
  state: CodexAuthState;
  message: string;
  details: string[];
  sessionId?: string;
}

function formatClaudeCliCheckSuccess(result: ClaudeCliConnectionCheckResult): {
  message: string;
  details: string[];
} {
  const version = result.version?.trim() || 'Claude CLI';
  const duration =
    typeof result.durationMs === 'number' ? ` in ${(result.durationMs / 1000).toFixed(1)}s` : '';
  const details = [
    result.auth?.summary ? `Auth: ${result.auth.summary}` : null,
    result.safeMode ? 'Mode: safe-mode smoke test' : null,
    result.smokeTest ? `Smoke: ${result.smokeTest}` : null,
  ].filter((entry): entry is string => Boolean(entry));

  return {
    message: `${version} connected${duration}.`,
    details,
  };
}

function formatCodexAuthStatus(result: CodexAuthStatusResult): {
  state: CodexAuthState;
  message: string;
  details: string[];
} {
  const version = result.version?.trim() || 'Codex Auth';
  const duration =
    typeof result.durationMs === 'number' ? ` in ${(result.durationMs / 1000).toFixed(1)}s` : '';
  const details = [result.auth?.summary ? `Auth: ${result.auth.summary}` : null].filter(
    (entry): entry is string => Boolean(entry),
  );

  if (result.auth?.loggedIn === false || result.ok === false) {
    return {
      state: 'error',
      message: result.error || `${version} is not logged in.`,
      details,
    };
  }

  return {
    state: 'ok',
    message: `${version} ready${duration}.`,
    details,
  };
}

const ANSI_ESCAPE_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g');

function stripAnsiForDisplay(value: string): string {
  return value.replace(ANSI_ESCAPE_PATTERN, '');
}

function formatCodexAuthLoginSession(session: CodexAuthDeviceLoginSession): CodexAuthUiStatus {
  const cleanOutput = stripAnsiForDisplay(session.output).trim();
  const details = [
    session.authorizationUrl ? `URL: ${session.authorizationUrl}` : null,
    session.userCode ? `Code: ${session.userCode}` : null,
    session.browserOpened === true ? 'Browser opened for account OAuth.' : null,
    cleanOutput ? `Output:\n${cleanOutput}` : null,
    session.exitCode !== undefined && session.exitCode !== null
      ? `Exit code: ${session.exitCode}`
      : null,
  ].filter((entry): entry is string => Boolean(entry));

  if (session.state === 'running') {
    return {
      state: 'logging-in',
      message: 'Waiting for Codex account OAuth authorization...',
      details,
      sessionId: session.id,
    };
  }
  if (session.state === 'completed') {
    return {
      state: 'ok',
      message: 'Codex account OAuth authorization completed.',
      details,
      sessionId: session.id,
    };
  }
  return {
    state: 'error',
    message: session.error || 'Codex account OAuth authorization failed.',
    details,
    sessionId: session.id,
  };
}

const MODEL_PROVIDER_OPTIONS: Array<{ value: LLMProvider; label: string }> = [
  'openai',
  'anthropic',
  'deepseek',
  'llama.cpp',
  'minimax',
  'z.ai',
  'kimi',
  'openrouter',
  'codex-auth',
  'claude-cli',
  'codex-cli',
  'opencode',
  'opencode-go',
].map((value) => ({
  value: value as LLMProvider,
  label: getProviderDisplayName(value as LLMProvider),
}));

const KIRA_PROVIDER_OPTIONS: Array<{ value: KiraAgentProvider; label: string }> =
  MODEL_PROVIDER_OPTIONS;

const KIRA_API_STYLE_OPTIONS: Array<{ value: KiraAgentApiStyle | ''; label: string }> = [
  { value: '', label: 'Auto' },
  { value: 'openai-chat', label: 'OpenAI Chat Completions' },
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'anthropic-messages', label: 'Anthropic Messages' },
];

const MODEL_REASONING_OPTIONS: Array<{ value: LLMReasoningEffort | ''; label: string }> = [
  { value: '', label: 'Model default' },
  ...LLM_REASONING_EFFORTS.map((value) => ({ value, label: value })),
];

const MODEL_REASONING_SUMMARY_OPTIONS: Array<{ value: LLMReasoningSummary | ''; label: string }> = [
  { value: '', label: 'Model default' },
  ...LLM_REASONING_SUMMARIES.map((value) => ({ value, label: value })),
];

const MODEL_VERBOSITY_OPTIONS: Array<{ value: LLMVerbosity | ''; label: string }> = [
  { value: '', label: 'Model default' },
  ...LLM_VERBOSITIES.map((value) => ({ value, label: value })),
];

const MODEL_PARALLEL_TOOL_CALL_OPTIONS: Array<{ value: ParallelToolCallsOption; label: string }> = [
  { value: '', label: 'Model default' },
  { value: 'enabled', label: 'Enabled' },
  { value: 'disabled', label: 'Disabled' },
];

function parallelToolCallsToOption(value: boolean | undefined): ParallelToolCallsOption {
  if (value === true) {
    return 'enabled';
  }
  if (value === false) {
    return 'disabled';
  }
  return '';
}

function parallelToolCallsOptionToConfig(value: ParallelToolCallsOption): boolean | undefined {
  if (value === 'enabled') {
    return true;
  }
  if (value === 'disabled') {
    return false;
  }
  return undefined;
}

function canInheritKiraApiKey(
  roleProvider: KiraAgentProvider,
  mainProvider: LLMProvider,
  mainApiKey: string,
): boolean {
  return (
    !isLoginCliProvider(roleProvider) &&
    !isCodexAuthProvider(roleProvider) &&
    roleProvider === mainProvider &&
    Boolean(mainApiKey.trim())
  );
}

function getProviderModelOptions(
  provider: LLMProvider,
  runtimeModels: Partial<Record<LLMProvider, RuntimeModelOption[]>> = {},
): string[] {
  const liveModels = runtimeModels[provider];
  if (liveModels?.length) return liveModels.map((modelInfo) => modelInfo.id);
  return PROVIDER_MODELS[provider] ?? [];
}

function formatProviderModelLabel(
  provider: LLMProvider,
  modelId: string,
  runtimeModelLabels: Partial<Record<LLMProvider, Record<string, string>>> = {},
): string {
  const runtimeName = runtimeModelLabels[provider]?.[modelId];
  if (runtimeName) return `${runtimeName} (${modelId})`;
  const modelInfo = getModelInfo(provider, modelId);
  return modelInfo ? `${modelInfo.name} (${modelId})` : modelId;
}

function isCodexCliProvider(provider: LLMProvider): boolean {
  return provider === 'codex-cli';
}

function isCodexAuthProvider(provider: LLMProvider): boolean {
  return provider === 'codex-auth';
}

function isClaudeCliProvider(provider: LLMProvider): boolean {
  return provider === 'claude-cli';
}

function isLoginCliProvider(provider: LLMProvider): boolean {
  return isCodexCliProvider(provider) || isClaudeCliProvider(provider);
}

function getDefaultCliCommand(provider: LLMProvider): string {
  return isClaudeCliProvider(provider) ? 'claude' : 'codex';
}

function getLoginCliHint(provider: LLMProvider): string {
  if (isClaudeCliProvider(provider)) {
    return 'Uses your local Claude CLI auth session. Run `claude auth` or complete the Claude Code login flow before using this provider.';
  }
  return 'Runs the local Codex CLI command directly. Use Codex Auth for browser OAuth sign-in.';
}

function getCodexAuthHint(): string {
  return 'Uses Codex account OAuth. Sign in through the browser with a device key code before using this provider.';
}

function isOpenCodeProvider(provider: LLMProvider): boolean {
  return provider === 'opencode' || provider === 'opencode-go';
}

function getProviderApiKeyPlaceholder(provider: LLMProvider, fallback: string): string {
  if (isDeepSeekProvider(provider)) {
    return 'DeepSeek API key';
  }
  if (isOpenCodeProvider(provider)) {
    return 'OpenCode API key';
  }
  return fallback;
}

function getDefaultKiraRoleConfig(
  provider: KiraAgentProvider,
  _mainConfig: LLMConfig | null,
): KiraRoleLlmConfig {
  if (isCodexAuthProvider(provider)) {
    const defaults = getDefaultProviderConfig(provider);
    return {
      provider,
      model: defaults.model,
    };
  }
  if (isLoginCliProvider(provider)) {
    const defaults = getDefaultProviderConfig(provider);
    return {
      provider,
      command: defaults.command ?? getDefaultCliCommand(provider),
      model: defaults.model,
    };
  }
  if (provider === 'opencode') {
    return {
      provider,
      baseUrl: 'https://opencode.ai/zen',
      model: 'opencode/claude-sonnet-4-6',
    };
  }
  if (provider === 'opencode-go') {
    return {
      provider,
      baseUrl: 'https://opencode.ai/zen/go',
      model: 'opencode-go/kimi-k2.5',
    };
  }

  const defaults = getDefaultProviderConfig(provider);
  return {
    provider,
    baseUrl: defaults.baseUrl,
    model: defaults.model,
  };
}

function makeKiraRoleDraft(
  role: KiraRoleLlmConfig | undefined,
  mainConfig: LLMConfig | null,
  id: string,
): KiraRoleDraft {
  const fallbackProvider = mainConfig?.provider ?? 'openrouter';
  const provider =
    role?.provider && KIRA_PROVIDER_OPTIONS.some((item) => item.value === role.provider)
      ? role.provider
      : fallbackProvider;
  const defaults = getDefaultKiraRoleConfig(provider, mainConfig);

  return {
    id,
    name: role?.name ?? '',
    provider,
    apiKey: role?.apiKey ?? '',
    baseUrl: role?.baseUrl ?? defaults.baseUrl ?? '',
    model: role?.model ?? defaults.model ?? '',
    customHeaders: role?.customHeaders ?? '',
    command: role?.command ?? defaults.command ?? '',
    apiStyle: role?.apiStyle ?? '',
    reasoningEffort: role?.reasoningEffort ?? '',
    reasoningSummary: role?.reasoningSummary ?? '',
    verbosity: role?.verbosity ?? '',
    serviceTier: role?.serviceTier ?? '',
    parallelToolCalls: parallelToolCallsToOption(role?.parallelToolCalls),
  };
}

function resolveInitialKiraWorkers(
  kiraConfig: KiraConfig | null,
  mainConfig: LLMConfig | null,
): KiraRoleDraft[] {
  const rawWorkers =
    Array.isArray(kiraConfig?.workers) && kiraConfig.workers.length > 0
      ? kiraConfig.workers.slice(0, 3)
      : [
          {
            ...(kiraConfig?.workerLlm ?? {}),
            ...(kiraConfig?.workerModel ? { model: kiraConfig.workerModel } : {}),
          },
        ];
  return rawWorkers
    .slice(0, 3)
    .map((worker, index) => makeKiraRoleDraft(worker, mainConfig, `worker-${index}`));
}

function resolveInitialKiraReviewer(
  kiraConfig: KiraConfig | null,
  mainConfig: LLMConfig | null,
): KiraRoleDraft {
  const reviewer = {
    ...(kiraConfig?.reviewerLlm ?? {}),
    ...(kiraConfig?.reviewerModel ? { model: kiraConfig.reviewerModel } : {}),
  };
  return makeKiraRoleDraft(reviewer, mainConfig, 'reviewer');
}

function kiraDraftToConfig(draft: KiraRoleDraft): KiraRoleLlmConfig {
  const normalizedApiKey = draft.apiKey.trim();
  const parallelToolCalls = parallelToolCallsOptionToConfig(draft.parallelToolCalls);
  const base: KiraRoleLlmConfig = {
    provider: draft.provider,
    ...(draft.name.trim() ? { name: draft.name.trim() } : {}),
    ...(draft.model.trim() ? { model: draft.model.trim() } : {}),
    ...(draft.reasoningEffort ? { reasoningEffort: draft.reasoningEffort } : {}),
    ...(draft.reasoningSummary ? { reasoningSummary: draft.reasoningSummary } : {}),
    ...(draft.verbosity ? { verbosity: draft.verbosity } : {}),
    ...(draft.serviceTier.trim() ? { serviceTier: draft.serviceTier.trim() } : {}),
    ...(parallelToolCalls !== undefined ? { parallelToolCalls } : {}),
  };

  if (isLoginCliProvider(draft.provider)) {
    const defaultCommand = getDefaultCliCommand(draft.provider);
    return {
      ...base,
      ...(draft.command.trim() && draft.command.trim() !== defaultCommand
        ? { command: draft.command.trim() }
        : {}),
    };
  }
  if (isCodexAuthProvider(draft.provider)) {
    return base;
  }

  return {
    ...base,
    ...(normalizedApiKey && normalizedApiKey !== '***' ? { apiKey: normalizedApiKey } : {}),
    ...(draft.baseUrl.trim() ? { baseUrl: draft.baseUrl.trim() } : {}),
    ...(draft.customHeaders.trim() ? { customHeaders: draft.customHeaders.trim() } : {}),
    ...(draft.apiStyle ? { apiStyle: draft.apiStyle } : {}),
  };
}

const SettingsModal: React.FC<{
  config: LLMConfig | null;
  dialogConfig: DialogLlmConfig | null;
  idaPeConfig: IdaPeConfig | null;
  kiraConfig: KiraConfig | null;
  userProfile: UserProfileConfig | null;
  conversationPreferences: ConversationPreferencesConfig | null;
  ttsStatusSnapshot: AoiTtsStatusSnapshot;
  imageGenConfig: ImageGenConfig | null;
  tavilyConfig: TavilyConfig | null;
  promptBudgetEntries: PromptBudgetEntry[];
  aoiMemories: AoiMemoryEntry[];
  aoiRunLedger: AoiRunLedgerEntry[];
  aoiAutonomyStatus: AoiAutonomyStatus | null;
  aoiAutonomyActiveProposals: AoiProposal[];
  aoiAutonomyArchivedProposals: AoiProposal[];
  aoiAutonomyActiveGoals: AoiGoal[];
  aoiActivePlaybooks: AoiPlaybook[];
  aoiMissionState: AoiMissionState | null;
  aoiEnvironmentSources: AoiEnvironmentSourceRegistry | null;
  aoiWorkspaceSnapshot: AoiWorkspaceSnapshot | null;
  aoiContextRouter: AoiContextRouterResult | null;
  aoiAutonomyScheduler: AoiAutonomySchedulerState | null;
  aoiAutonomyEvaluation: AoiAutonomyEvaluationResult | null;
  aoiOperatorDigest: AoiOperatorDigest | null;
  aoiOperatorHealth: AoiOperatorHealthState | null;
  aoiOperatorVoicePolicy: AoiOperatorVoicePolicy;
  aoiOperatorVoiceMuted: boolean;
  aoiLastOperatorVoiceDecision: AoiVoiceRenderDecision | null;
  aoiOperatorVoicePanelSummary: ReturnType<typeof buildAoiOperatorVoicePanelSummary>;
  aoiAutonomyPanelSettings: AoiAutonomyPanelSettings;
  aoiAutonomyBlockedProposals: AoiAutonomyBlockedProposal[];
  aoiAutonomyLoading: boolean;
  aoiAutonomyError: string;
  aoiAutonomyActionId: string | null;
  aoiAutonomyLastTickAt: number | null;
  aoiAutonomyExecutionMessages: Record<string, string>;
  aoiKiraHandoffPreviews: Record<string, AoiAutonomyProposalPreviewResult>;
  aoiAutonomyPendingFeedback: {
    decisionId: string;
    proposalId: string;
    action: Extract<AoiProposalDecisionAction, 'dismiss' | 'snooze'>;
    title: string;
  } | null;
  aoiSkills: AoiWorkshopSkill[];
  aoiMcpPlugins: AoiMcpPluginEntry[];
  recentToolActivity: string[];
  toolSafetyPolicy: ToolSafetyPolicy;
  initialTab?: AppSettingsTabKey;
  onRefreshAoiMemories: () => void;
  onRefreshAoiAutonomy: (options?: { silent?: boolean }) => Promise<void>;
  onAdvancedTabVisible: () => void;
  onUpdateAoiAutonomyPolicy: (patch: Partial<AoiAutonomyPolicy>) => Promise<void>;
  onUpdateAoiEnvironmentSource: (
    sourceId: string,
    patch: Partial<AoiEnvironmentSource>,
  ) => Promise<void>;
  onRecordAoiContextSourceFeedback: (
    sourceId: string,
    contextSummaryId: string,
    feedbackCategory: Extract<
      AoiProposalFeedbackCategory,
      'wrong_evidence' | 'wrong_source' | 'wrong_timing' | 'stale' | 'not_useful' | 'too_much'
    >,
    evidenceRefs: string[],
  ) => Promise<void>;
  onResetAoiTrustCalibration: (dimension: AoiCalibrationDimension, key: string) => Promise<void>;
  onUpdateAoiAutonomyPanelSettings: (patch: Partial<AoiAutonomyPanelSettings>) => void;
  onRunAoiAutonomyCheck: () => Promise<void>;
  onDecideAoiMission: (action: AoiMissionDecisionAction) => Promise<void>;
  onDecideAoiProposal: (
    proposalId: string,
    action: AoiProposalDecisionAction,
    feedbackCategory?: AoiProposalFeedbackCategory,
  ) => Promise<void>;
  onPauseAoiGoalForRecovery: (proposal: AoiProposal) => Promise<void>;
  onRecordAoiProposalFeedback: (feedbackCategory: AoiProposalFeedbackCategory) => Promise<void>;
  onPrepareAoiKiraHandoff: (proposal: AoiProposal) => Promise<void>;
  onExecuteAoiProposal: (proposal: AoiProposal) => Promise<void>;
  onToggleAoiOperatorVoiceMute: () => void;
  onReplayAoiOperatorVoice: () => void;
  onStopAoiOperatorVoice: () => void;
  onSaveAoiPreference: (memoryId: string) => Promise<void>;
  onDemoteAoiMemory: (memoryId: string) => Promise<void>;
  onMarkAoiMemoryTemporary: (memoryId: string) => Promise<void>;
  onArchiveAoiMemory: (memoryId: string) => Promise<void>;
  onDeleteAoiMemory: (memoryId: string) => Promise<void>;
  onResetAll: () => void;
  onSave: (
    _config: LLMConfig,
    _igConfig: ImageGenConfig | null,
    _dialogConfig: DialogLlmConfig | null,
    _idaPeConfig: IdaPeConfig | null,
    _kiraConfig: KiraConfig | null,
    _userProfile: UserProfileConfig | null,
    _conversationPreferences: ConversationPreferencesConfig | null,
    _toolSafetyPolicy: ToolSafetyPolicy,
    _aoiSkills: AoiWorkshopSkill[],
    _aoiMcpPlugins: AoiMcpPluginEntry[],
    _tavilyConfig: TavilyConfig | null,
  ) => void;
  onClose: () => void;
}> = ({
  config,
  dialogConfig,
  idaPeConfig,
  kiraConfig,
  userProfile,
  conversationPreferences,
  ttsStatusSnapshot,
  imageGenConfig,
  tavilyConfig,
  promptBudgetEntries,
  aoiMemories,
  aoiRunLedger,
  aoiAutonomyStatus,
  aoiAutonomyActiveProposals,
  aoiAutonomyArchivedProposals,
  aoiAutonomyActiveGoals,
  aoiActivePlaybooks,
  aoiMissionState,
  aoiEnvironmentSources,
  aoiWorkspaceSnapshot,
  aoiContextRouter,
  aoiAutonomyScheduler,
  aoiAutonomyEvaluation,
  aoiOperatorDigest,
  aoiOperatorHealth,
  aoiOperatorVoicePolicy,
  aoiOperatorVoiceMuted,
  aoiLastOperatorVoiceDecision,
  aoiOperatorVoicePanelSummary,
  aoiAutonomyPanelSettings,
  aoiAutonomyBlockedProposals,
  aoiAutonomyLoading,
  aoiAutonomyError,
  aoiAutonomyActionId,
  aoiAutonomyLastTickAt,
  aoiAutonomyExecutionMessages,
  aoiKiraHandoffPreviews,
  aoiAutonomyPendingFeedback,
  aoiSkills,
  aoiMcpPlugins,
  recentToolActivity,
  toolSafetyPolicy,
  initialTab = 'chat',
  onRefreshAoiMemories,
  onRefreshAoiAutonomy,
  onAdvancedTabVisible,
  onUpdateAoiAutonomyPolicy,
  onUpdateAoiEnvironmentSource,
  onRecordAoiContextSourceFeedback,
  onResetAoiTrustCalibration,
  onUpdateAoiAutonomyPanelSettings,
  onRunAoiAutonomyCheck,
  onDecideAoiMission,
  onDecideAoiProposal,
  onPauseAoiGoalForRecovery,
  onRecordAoiProposalFeedback,
  onPrepareAoiKiraHandoff,
  onExecuteAoiProposal,
  onToggleAoiOperatorVoiceMute,
  onReplayAoiOperatorVoice,
  onStopAoiOperatorVoice,
  onSaveAoiPreference,
  onDemoteAoiMemory,
  onMarkAoiMemoryTemporary,
  onArchiveAoiMemory,
  onDeleteAoiMemory,
  onResetAll,
  onSave,
  onClose,
}) => {
  // LLM settings
  const [provider, setProvider] = useState<LLMProvider>(config?.provider || 'openrouter');
  const [apiKey, setApiKey] = useState(config?.apiKey || '');
  const [baseUrl, setBaseUrl] = useState(
    config?.baseUrl || getDefaultProviderConfig('openrouter').baseUrl,
  );
  const [model, setModel] = useState(config?.model || getDefaultProviderConfig('openrouter').model);
  const [command, setCommand] = useState(
    config?.command ||
      (isLoginCliProvider(config?.provider || 'codex-cli')
        ? getDefaultCliCommand(config?.provider || 'codex-cli')
        : ''),
  );
  const [apiStyle, setApiStyle] = useState<LLMApiStyle | ''>(config?.apiStyle || '');
  const [customHeaders, setCustomHeaders] = useState(config?.customHeaders || '');
  const [reasoningEffort, setReasoningEffort] = useState<LLMReasoningEffort | ''>(
    config?.reasoningEffort || '',
  );
  const [reasoningSummary, setReasoningSummary] = useState<LLMReasoningSummary | ''>(
    config?.reasoningSummary || '',
  );
  const [verbosity, setVerbosity] = useState<LLMVerbosity | ''>(config?.verbosity || '');
  const [serviceTier, setServiceTier] = useState(config?.serviceTier || '');
  const [parallelToolCalls, setParallelToolCalls] = useState<ParallelToolCallsOption>(
    parallelToolCallsToOption(config?.parallelToolCalls),
  );
  const [manualModelMode, setManualModelMode] = useState(false);
  const [preferredName, setPreferredName] = useState(userProfile?.displayName || '');
  const [responseLanguageMode, setResponseLanguageMode] = useState<ResponseLanguageMode>(
    normalizeResponseLanguageMode(conversationPreferences?.responseLanguageMode),
  );
  const [activeTab, setActiveTab] = useState<SettingsTabKey>(initialTab);
  const [focusedKiraApiKeyId, setFocusedKiraApiKeyId] = useState<string | null>(null);
  const [ttsEnabled, setTtsEnabled] = useState(Boolean(conversationPreferences?.ttsEnabled));
  const [ttsPreloadCommonPhrases, setTtsPreloadCommonPhrases] = useState(
    conversationPreferences?.ttsPreloadCommonPhrases !== false,
  );
  const [operatorVoicePolicy, setOperatorVoicePolicy] =
    useState<AoiOperatorVoicePolicy>(aoiOperatorVoicePolicy);
  const [openRouterModels, setOpenRouterModels] = useState<RuntimeModelOption[]>([]);
  const [openRouterModelsStatus, setOpenRouterModelsStatus] = useState<RuntimeModelStatus>('idle');
  const [openRouterModelsError, setOpenRouterModelsError] = useState('');
  const [claudeCliCheckStatus, setClaudeCliCheckStatus] = useState<ClaudeCliConnectionCheckStatus>({
    state: 'idle',
    message: '',
    details: [],
  });
  const [codexAuthStatus, setCodexAuthStatus] = useState<CodexAuthUiStatus>({
    state: 'idle',
    message: '',
    details: [],
  });

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

  useEffect(() => {
    setOperatorVoicePolicy(aoiOperatorVoicePolicy);
  }, [aoiOperatorVoicePolicy]);

  const setOperatorVoiceCategoryEnabled = useCallback(
    (category: AoiOperatorVoiceEventCategory, enabled: boolean) => {
      setOperatorVoicePolicy((prev) =>
        normalizeAoiOperatorVoicePolicy({
          ...prev,
          allowedCategories: {
            ...prev.allowedCategories,
            [category]: enabled,
          },
        }),
      );
    },
    [],
  );

  useEffect(() => {
    if (activeTab === 'advanced') {
      onAdvancedTabVisible();
    }
  }, [activeTab, onAdvancedTabVisible]);

  // Image gen settings
  const [igProvider, setIgProvider] = useState<ImageGenProvider>(
    imageGenConfig?.provider || 'gemini',
  );
  const [igApiKey, setIgApiKey] = useState(imageGenConfig?.apiKey || '');
  const [igBaseUrl, setIgBaseUrl] = useState(
    imageGenConfig?.baseUrl || getDefaultImageGenConfig('gemini').baseUrl,
  );
  const [igModel, setIgModel] = useState(
    imageGenConfig?.model || getDefaultImageGenConfig('gemini').model,
  );
  const [igCustomHeaders, setIgCustomHeaders] = useState(imageGenConfig?.customHeaders || '');
  const [tavilyApiKey, setTavilyApiKey] = useState(tavilyConfig?.apiKey || '');
  const [tavilyBaseUrl, setTavilyBaseUrl] = useState(
    tavilyConfig?.baseUrl || DEFAULT_TAVILY_BASE_URL,
  );
  const [dialogEnabled, setDialogEnabled] = useState(
    Boolean(
      dialogConfig?.model?.trim() &&
      ((dialogConfig.provider && isLoginCliProvider(dialogConfig.provider)) ||
        dialogConfig?.baseUrl?.trim()),
    ),
  );
  const [dialogProvider, setDialogProvider] = useState<LLMProvider>(
    dialogConfig?.provider || config?.provider || 'openrouter',
  );
  const [dialogApiKey, setDialogApiKey] = useState(dialogConfig?.apiKey || '');
  const [dialogBaseUrl, setDialogBaseUrl] = useState(
    dialogConfig?.baseUrl || config?.baseUrl || getDefaultProviderConfig('openrouter').baseUrl,
  );
  const [dialogModel, setDialogModel] = useState(dialogConfig?.model || '');
  const [dialogCommand, setDialogCommand] = useState(
    dialogConfig?.command ||
      (isLoginCliProvider(dialogConfig?.provider || 'codex-cli')
        ? getDefaultCliCommand(dialogConfig?.provider || 'codex-cli')
        : ''),
  );
  const [dialogApiStyle, setDialogApiStyle] = useState<LLMApiStyle | ''>(
    dialogConfig?.apiStyle || '',
  );
  const [dialogCustomHeaders, setDialogCustomHeaders] = useState(dialogConfig?.customHeaders || '');
  const [dialogReasoningEffort, setDialogReasoningEffort] = useState<LLMReasoningEffort | ''>(
    dialogConfig?.reasoningEffort || '',
  );
  const [dialogReasoningSummary, setDialogReasoningSummary] = useState<LLMReasoningSummary | ''>(
    dialogConfig?.reasoningSummary || '',
  );
  const [dialogVerbosity, setDialogVerbosity] = useState<LLMVerbosity | ''>(
    dialogConfig?.verbosity || '',
  );
  const [dialogServiceTier, setDialogServiceTier] = useState(dialogConfig?.serviceTier || '');
  const [dialogParallelToolCalls, setDialogParallelToolCalls] = useState<ParallelToolCallsOption>(
    parallelToolCallsToOption(dialogConfig?.parallelToolCalls),
  );
  const [dialogManualModelMode, setDialogManualModelMode] = useState(false);
  const [idaPeMode, setIdaPeMode] = useState<'prescan-only' | 'mcp-http'>(
    idaPeConfig?.mode || 'prescan-only',
  );
  const [idaPeBackendUrl, setIdaPeBackendUrl] = useState(idaPeConfig?.backendUrl || '');
  const [kiraWorkRootDirectory, setKiraWorkRootDirectory] = useState(
    kiraConfig?.workRootDirectory || '',
  );
  const [kiraAutoCommit, setKiraAutoCommit] = useState(
    kiraConfig?.projectDefaults?.autoCommit !== false,
  );
  const [kiraRequiredInstructions, setKiraRequiredInstructions] = useState(
    kiraConfig?.projectDefaults?.requiredInstructions || '',
  );
  const [kiraWorkers, setKiraWorkers] = useState<KiraRoleDraft[]>(() =>
    resolveInitialKiraWorkers(kiraConfig, config),
  );
  const [kiraReviewer, setKiraReviewer] = useState<KiraRoleDraft>(() =>
    resolveInitialKiraReviewer(kiraConfig, config),
  );
  const runtimeModels = useMemo<Partial<Record<LLMProvider, RuntimeModelOption[]>>>(
    () => (openRouterModels.length ? { openrouter: openRouterModels } : {}),
    [openRouterModels],
  );
  const runtimeModelLabels = useMemo<Partial<Record<LLMProvider, Record<string, string>>>>(
    () =>
      openRouterModels.length
        ? {
            openrouter: Object.fromEntries(
              openRouterModels.map((modelInfo) => [modelInfo.id, modelInfo.name]),
            ),
          }
        : {},
    [openRouterModels],
  );
  const modelOptions = getProviderModelOptions(provider, runtimeModels);
  const isPresetModel = modelOptions.includes(model);
  const showDropdown = !manualModelMode && modelOptions.length > 0;
  const promptBudgetOverview = useMemo(
    () => summarizePromptBudget(promptBudgetEntries),
    [promptBudgetEntries],
  );
  const runLedgerSummary = useMemo(() => summarizeAoiRunLedger(aoiRunLedger), [aoiRunLedger]);
  const recentRunLedgerEntries = useMemo(() => aoiRunLedger.slice(0, 6), [aoiRunLedger]);
  const aoiMemoryOverview = useMemo(() => {
    const activeCount = aoiMemories.filter((memory) => memory.status === 'active').length;
    const archivedCount = aoiMemories.filter((memory) => memory.status === 'archived').length;
    const supersededCount = aoiMemories.filter((memory) => memory.status === 'superseded').length;
    const permanentCount = aoiMemories.filter(
      (memory) => memory.status === 'active' && memory.permanent,
    ).length;
    const promptEligibleCount = aoiMemories.filter(
      (memory) => memory.status === 'active' && (memory.permanent || memory.confidence >= 0.45),
    ).length;
    return {
      activeCount,
      archivedCount,
      supersededCount,
      permanentCount,
      promptEligibleCount,
    };
  }, [aoiMemories]);
  const visibleAoiMemories = useMemo(
    () =>
      aoiMemories
        .slice()
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .slice(0, 12),
    [aoiMemories],
  );
  const aoiAutonomyProposalCounts = useMemo(
    () =>
      summarizeAoiAutonomyProposalCounts(
        aoiAutonomyActiveProposals,
        aoiAutonomyArchivedProposals,
        aoiAutonomyStatus,
      ),
    [aoiAutonomyActiveProposals, aoiAutonomyArchivedProposals, aoiAutonomyStatus],
  );
  const aoiApprovalInboxProposalIds = useMemo(
    () => new Set((aoiOperatorDigest?.approvalInbox ?? []).map((item) => item.proposalId)),
    [aoiOperatorDigest],
  );
  const visibleAoiAutonomyProposals = useMemo(
    () =>
      aoiAutonomyActiveProposals
        .filter((proposal) => !aoiApprovalInboxProposalIds.has(proposal.id))
        .slice()
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .slice(0, 8),
    [aoiApprovalInboxProposalIds, aoiAutonomyActiveProposals],
  );
  const visibleAoiAutonomyGoals = useMemo(
    () =>
      aoiAutonomyActiveGoals
        .slice()
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .slice(0, 4),
    [aoiAutonomyActiveGoals],
  );
  const aoiAutonomyNotificationBadge = useMemo(
    () =>
      buildAoiAutonomyNotificationBadge({
        status: aoiAutonomyStatus,
        proposals: aoiAutonomyActiveProposals,
        blockedProposals: aoiAutonomyBlockedProposals,
        settings: aoiAutonomyPanelSettings,
      }),
    [
      aoiAutonomyActiveProposals,
      aoiAutonomyBlockedProposals,
      aoiAutonomyPanelSettings,
      aoiAutonomyStatus,
    ],
  );
  const [pendingAoiMemoryActionId, setPendingAoiMemoryActionId] = useState<string | null>(null);
  const [expandedAoiProposalId, setExpandedAoiProposalId] = useState<string | null>(null);
  const [expandedAoiMissionEvidence, setExpandedAoiMissionEvidence] = useState(false);
  const aoiMissionPanelSummary = useMemo(
    () => buildAoiMissionPanelSummary(aoiMissionState, expandedAoiMissionEvidence),
    [aoiMissionState, expandedAoiMissionEvidence],
  );
  const aoiOperatorDigestSummary = useMemo(
    () =>
      buildAoiOperatorDigestPanelSummary(
        aoiOperatorDigest,
        expandedAoiMissionEvidence || Boolean(expandedAoiProposalId),
      ),
    [aoiOperatorDigest, expandedAoiMissionEvidence, expandedAoiProposalId],
  );
  const aoiOperatorHealthSummary = useMemo(
    () =>
      buildAoiOperatorHealthPanelSummary(
        aoiOperatorHealth,
        expandedAoiMissionEvidence || Boolean(expandedAoiProposalId),
      ),
    [aoiOperatorHealth, expandedAoiMissionEvidence, expandedAoiProposalId],
  );
  const latestAoiPlaybook = useMemo(
    () =>
      aoiActivePlaybooks.slice().sort((left, right) => right.updatedAt - left.updatedAt)[0] ?? null,
    [aoiActivePlaybooks],
  );
  const aoiPlaybookSummary = useMemo(
    () =>
      buildAoiPlaybookPanelSummary(
        latestAoiPlaybook,
        expandedAoiMissionEvidence || Boolean(expandedAoiProposalId),
      ),
    [latestAoiPlaybook, expandedAoiMissionEvidence, expandedAoiProposalId],
  );
  const aoiWorkspaceSignalSummary = useMemo(
    () => buildAoiWorkspaceSignalPanelSummary(aoiWorkspaceSnapshot),
    [aoiWorkspaceSnapshot],
  );
  const aoiAutonomySchedulerSummary = useMemo(
    () =>
      buildAoiAutonomySchedulerPanelSummary(
        aoiAutonomyScheduler,
        expandedAoiMissionEvidence || Boolean(expandedAoiProposalId),
      ),
    [aoiAutonomyScheduler, expandedAoiMissionEvidence, expandedAoiProposalId],
  );
  const aoiContextSourceSummaries = useMemo(
    () => buildAoiContextSourcePanelSummaries(aoiContextRouter),
    [aoiContextRouter],
  );
  const aoiEnvironmentSourceSummaries = useMemo(
    () => buildAoiEnvironmentSourcePanelSummaries(aoiEnvironmentSources),
    [aoiEnvironmentSources],
  );
  const enabledAoiEnvironmentSourceCount =
    aoiAutonomyStatus?.enabledEnvironmentSourceCount ??
    aoiEnvironmentSourceSummaries.filter((source) => source.enabled).length;
  const privateAoiEnvironmentSourceCount =
    aoiAutonomyStatus?.privateEnvironmentSourceCount ??
    aoiEnvironmentSourceSummaries.filter((source) => source.privateLabel === 'private by default')
      .length;
  const [autoVerifyFixes, setAutoVerifyFixes] = useState(toolSafetyPolicy.autoVerifyFixes);
  const [allowWorkspaceCommands, setAllowWorkspaceCommands] = useState(
    toolSafetyPolicy.allowWorkspaceCommands,
  );
  const [allowSemanticRefactors, setAllowSemanticRefactors] = useState(
    toolSafetyPolicy.allowSemanticRefactors,
  );
  const [allowBackgroundWatches, setAllowBackgroundWatches] = useState(
    toolSafetyPolicy.allowBackgroundWatches,
  );
  const [requirePreviewBeforeMutation, setRequirePreviewBeforeMutation] = useState(
    toolSafetyPolicy.requirePreviewBeforeMutation,
  );
  const [aoiSkillDrafts, setAoiSkillDrafts] = useState<AoiWorkshopSkill[]>(aoiSkills);
  const [newAoiSkillName, setNewAoiSkillName] = useState('');
  const [newAoiSkillTriggers, setNewAoiSkillTriggers] = useState('');
  const [newAoiSkillBody, setNewAoiSkillBody] = useState('');
  const [aoiMcpPluginDrafts, setAoiMcpPluginDrafts] = useState<AoiMcpPluginEntry[]>(aoiMcpPlugins);
  const [newAoiMcpName, setNewAoiMcpName] = useState('');
  const [newAoiMcpUrl, setNewAoiMcpUrl] = useState('');
  const [newAoiMcpKind, setNewAoiMcpKind] = useState<AoiMcpPluginKind>('mcp-server');
  const recentMutations = useMemo(() => listRecentMutations().slice(0, 8), []);
  const activeBackgroundWatches = useMemo(() => listBackgroundWatches().slice(0, 8), []);
  const capabilitySummary = useMemo(
    () => summarizeAoiCapabilityRegistry(AOI_DEFAULT_CAPABILITY_NAMES),
    [],
  );
  const skillsWorkshopSummary = useMemo(
    () => summarizeAoiSkillsWorkshop(aoiSkillDrafts),
    [aoiSkillDrafts],
  );
  const visibleAoiSkills = useMemo(() => aoiSkillDrafts.slice(0, 8), [aoiSkillDrafts]);
  const mcpPluginSummary = useMemo(
    () => summarizeAoiMcpPluginAdmin(aoiMcpPluginDrafts),
    [aoiMcpPluginDrafts],
  );
  const visibleMcpPlugins = useMemo(() => aoiMcpPluginDrafts.slice(0, 8), [aoiMcpPluginDrafts]);
  const capabilityRows = useMemo(
    () =>
      getAoiCapabilityRows(AOI_DEFAULT_CAPABILITY_NAMES)
        .filter((row) => row.risk === 'high' || !row.registered)
        .slice(0, 12),
    [],
  );
  const formatModelLabel = useCallback(
    (modelProvider: LLMProvider, modelId: string) =>
      formatProviderModelLabel(modelProvider, modelId, runtimeModelLabels),
    [runtimeModelLabels],
  );
  const openRouterStatusHint =
    openRouterModelsStatus === 'loading'
      ? 'Loading live OpenRouter model catalog...'
      : openRouterModelsStatus === 'loaded'
        ? `Loaded ${openRouterModels.length} text models from OpenRouter.`
        : openRouterModelsStatus === 'error'
          ? `Using fallback model list. ${openRouterModelsError}`
          : 'Loads the live OpenRouter model catalog when this provider is selected.';
  const usesOpenRouterModels =
    provider === 'openrouter' ||
    dialogProvider === 'openrouter' ||
    kiraReviewer.provider === 'openrouter' ||
    kiraWorkers.some((worker) => worker.provider === 'openrouter');

  const addAoiSkillDraft = useCallback(() => {
    if (!newAoiSkillName.trim() || !newAoiSkillBody.trim()) {
      return;
    }
    const skill = createUserAoiWorkshopSkill({
      name: newAoiSkillName,
      triggerTerms: newAoiSkillTriggers
        .split(',')
        .map((term) => term.trim())
        .filter(Boolean),
      body: newAoiSkillBody,
    });
    setAoiSkillDrafts((prev) => upsertAoiWorkshopSkill(prev, skill));
    setNewAoiSkillName('');
    setNewAoiSkillTriggers('');
    setNewAoiSkillBody('');
  }, [newAoiSkillBody, newAoiSkillName, newAoiSkillTriggers]);

  const updateAoiSkillDraft = useCallback(
    (skillId: string, updates: Parameters<typeof updateAoiWorkshopSkill>[2]) => {
      setAoiSkillDrafts((prev) => updateAoiWorkshopSkill(prev, skillId, updates));
    },
    [],
  );

  const deleteAoiSkillDraft = useCallback((skillId: string) => {
    setAoiSkillDrafts((prev) => removeAoiWorkshopSkill(prev, skillId));
  }, []);

  const addAoiMcpPluginDraft = useCallback(() => {
    if (!newAoiMcpName.trim() || !newAoiMcpUrl.trim()) {
      return;
    }
    const entry = createUserAoiMcpPluginEntry({
      name: newAoiMcpName,
      endpointUrl: newAoiMcpUrl,
      kind: newAoiMcpKind,
    });
    setAoiMcpPluginDrafts((prev) => upsertAoiMcpPluginEntry(prev, entry));
    setNewAoiMcpName('');
    setNewAoiMcpUrl('');
    setNewAoiMcpKind('mcp-server');
  }, [newAoiMcpKind, newAoiMcpName, newAoiMcpUrl]);

  const updateAoiMcpPluginDraft = useCallback(
    (entryId: string, updates: Parameters<typeof updateAoiMcpPluginEntry>[2]) => {
      setAoiMcpPluginDrafts((prev) => updateAoiMcpPluginEntry(prev, entryId, updates));
    },
    [],
  );

  const deleteAoiMcpPluginDraft = useCallback((entryId: string) => {
    setAoiMcpPluginDrafts((prev) => removeAoiMcpPluginEntry(prev, entryId));
  }, []);

  const checkAoiMcpPluginDraft = useCallback(async (entry: AoiMcpPluginEntry) => {
    const checked = await probeAoiMcpPluginEndpoint(entry);
    setAoiMcpPluginDrafts((prev) => applyAoiMcpPluginHealthCheckResult(prev, checked));
  }, []);

  const refreshOpenRouterModels = useCallback(async () => {
    setOpenRouterModelsStatus('loading');
    setOpenRouterModelsError('');
    try {
      const res = await fetch('/api/openrouter-models');
      const payload = (await res.json()) as {
        data?: Array<{ id?: unknown; name?: unknown }>;
        error?: string;
      };
      if (!res.ok) {
        throw new Error(payload.error || `OpenRouter model list failed with ${res.status}`);
      }
      const nextModels = (Array.isArray(payload.data) ? payload.data : [])
        .map((entry) => {
          const id = typeof entry.id === 'string' ? entry.id.trim() : '';
          const name = typeof entry.name === 'string' ? entry.name.trim() : id;
          return id ? { id, name } : null;
        })
        .filter((entry): entry is RuntimeModelOption => Boolean(entry));
      if (nextModels.length === 0) {
        throw new Error('OpenRouter returned no models.');
      }
      setOpenRouterModels(nextModels);
      setOpenRouterModelsStatus('loaded');
    } catch (error) {
      setOpenRouterModelsStatus('error');
      setOpenRouterModelsError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    setClaudeCliCheckStatus({
      state: 'idle',
      message: '',
      details: [],
    });
    setCodexAuthStatus({
      state: 'idle',
      message: '',
      details: [],
    });
  }, [provider, command, model, reasoningEffort]);

  useEffect(() => {
    if (usesOpenRouterModels && openRouterModelsStatus === 'idle') {
      void refreshOpenRouterModels();
    }
  }, [openRouterModelsStatus, refreshOpenRouterModels, usesOpenRouterModels]);

  const handleClaudeCliConnectionCheck = useCallback(async () => {
    if (!isClaudeCliProvider(provider)) {
      return;
    }

    setClaudeCliCheckStatus({
      state: 'checking',
      message: 'Checking Claude CLI...',
      details: [],
    });
    try {
      const result = await checkClaudeCliConnection({
        provider,
        model,
        command,
        reasoningEffort: reasoningEffort || undefined,
      });
      const formatted = formatClaudeCliCheckSuccess(result);
      setClaudeCliCheckStatus({
        state: 'ok',
        message: formatted.message,
        details: formatted.details,
      });
    } catch (error) {
      setClaudeCliCheckStatus({
        state: 'error',
        message: error instanceof Error ? error.message : String(error),
        details: [],
      });
    }
  }, [command, model, provider, reasoningEffort]);

  const handleCodexAuthStatusCheck = useCallback(async () => {
    if (!isCodexAuthProvider(provider)) {
      return;
    }

    setCodexAuthStatus({
      state: 'checking',
      message: 'Checking Codex account OAuth...',
      details: [],
    });
    try {
      const result = await checkCodexAuthStatus({
        provider,
      });
      setCodexAuthStatus(formatCodexAuthStatus(result));
    } catch (error) {
      setCodexAuthStatus({
        state: 'error',
        message: error instanceof Error ? error.message : String(error),
        details: [],
      });
    }
  }, [provider]);

  const handleCodexAuthDeviceLogin = useCallback(async () => {
    if (!isCodexAuthProvider(provider)) {
      return;
    }

    setCodexAuthStatus({
      state: 'logging-in',
      message: 'Starting Codex account OAuth device authorization...',
      details: [],
    });
    try {
      const session = await startCodexAuthDeviceLogin({
        provider,
      });
      setCodexAuthStatus(formatCodexAuthLoginSession(session));
    } catch (error) {
      setCodexAuthStatus({
        state: 'error',
        message: error instanceof Error ? error.message : String(error),
        details: [],
      });
    }
  }, [provider]);

  useEffect(() => {
    if (!isCodexAuthProvider(provider) || codexAuthStatus.state !== 'logging-in') {
      return;
    }
    const sessionId = codexAuthStatus.sessionId;
    if (!sessionId) {
      return;
    }

    let disposed = false;
    const timer = window.setInterval(() => {
      void getCodexAuthDeviceLoginStatus(sessionId)
        .then((session) => {
          if (disposed) {
            return;
          }
          setCodexAuthStatus(formatCodexAuthLoginSession(session));
          if (session.state !== 'running') {
            window.clearInterval(timer);
          }
        })
        .catch((error) => {
          if (disposed) {
            return;
          }
          setCodexAuthStatus({
            state: 'error',
            message: error instanceof Error ? error.message : String(error),
            details: [],
            sessionId,
          });
          window.clearInterval(timer);
        });
    }, 1500);

    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [codexAuthStatus.sessionId, codexAuthStatus.state, provider]);

  const claudeCliCheckClassName =
    claudeCliCheckStatus.state === 'ok'
      ? styles.connectionCheckOk
      : claudeCliCheckStatus.state === 'error'
        ? styles.connectionCheckError
        : styles.connectionCheckMuted;
  const codexAuthClassName =
    codexAuthStatus.state === 'ok'
      ? styles.connectionCheckOk
      : codexAuthStatus.state === 'error'
        ? styles.connectionCheckError
        : styles.connectionCheckMuted;

  const handleAoiMemoryAction = useCallback(
    async (memoryId: string, action: (id: string) => Promise<void>) => {
      setPendingAoiMemoryActionId(memoryId);
      try {
        await action(memoryId);
      } finally {
        setPendingAoiMemoryActionId(null);
      }
    },
    [],
  );

  const handleProviderChange = (p: LLMProvider) => {
    setProvider(p);
    const defaults = getDefaultProviderConfig(p);
    setBaseUrl(defaults.baseUrl);
    setModel(defaults.model);
    setCommand(defaults.command || (isLoginCliProvider(p) ? getDefaultCliCommand(p) : ''));
    setApiStyle(defaults.apiStyle || '');
    setReasoningEffort('');
    setReasoningSummary('');
    setVerbosity('');
    setServiceTier('');
    setParallelToolCalls('');
    setManualModelMode(false);
  };

  const handleModelChange = (newModel: string) => {
    setModel(newModel);
    setManualModelMode(false);
  };

  const handleIgProviderChange = (p: ImageGenProvider) => {
    setIgProvider(p);
    const defaults = getDefaultImageGenConfig(p);
    setIgBaseUrl(defaults.baseUrl);
    setIgModel(defaults.model);
  };

  const handleDialogProviderChange = (p: LLMProvider) => {
    setDialogProvider(p);
    const defaults = getDefaultProviderConfig(p);
    setDialogBaseUrl(defaults.baseUrl);
    setDialogCommand(defaults.command || (isLoginCliProvider(p) ? getDefaultCliCommand(p) : ''));
    setDialogApiStyle(defaults.apiStyle || '');
    setDialogModel(defaults.model);
    setDialogReasoningEffort('');
    setDialogReasoningSummary('');
    setDialogVerbosity('');
    setDialogServiceTier('');
    setDialogParallelToolCalls('');
    setDialogManualModelMode(false);
  };

  const updateKiraWorker = (id: string, patch: Partial<KiraRoleDraft>) => {
    setKiraWorkers((prev) =>
      prev.map((worker) => (worker.id === id ? { ...worker, ...patch } : worker)),
    );
  };

  const updateKiraReviewer = (patch: Partial<KiraRoleDraft>) => {
    setKiraReviewer((prev) => ({ ...prev, ...patch }));
  };

  const handleKiraWorkerProviderChange = (id: string, nextProvider: KiraAgentProvider) => {
    const defaults = getDefaultKiraRoleConfig(nextProvider, config);
    updateKiraWorker(id, {
      provider: nextProvider,
      apiKey: '',
      baseUrl: defaults.baseUrl ?? '',
      model: defaults.model ?? '',
      customHeaders: '',
      command: defaults.command ?? '',
      apiStyle: defaults.apiStyle ?? '',
      reasoningEffort: '',
      reasoningSummary: '',
      verbosity: '',
      serviceTier: '',
      parallelToolCalls: '',
    });
  };

  const handleKiraReviewerProviderChange = (nextProvider: KiraAgentProvider) => {
    const defaults = getDefaultKiraRoleConfig(nextProvider, config);
    updateKiraReviewer({
      provider: nextProvider,
      apiKey: '',
      baseUrl: defaults.baseUrl ?? '',
      model: defaults.model ?? '',
      customHeaders: '',
      command: defaults.command ?? '',
      apiStyle: defaults.apiStyle ?? '',
      reasoningEffort: '',
      reasoningSummary: '',
      verbosity: '',
      serviceTier: '',
      parallelToolCalls: '',
    });
  };

  const addKiraWorker = () => {
    setKiraWorkers((prev) => {
      if (prev.length >= 3) return prev;
      const nextIndex = prev.length;
      return [
        ...prev,
        makeKiraRoleDraft(
          getDefaultKiraRoleConfig(config?.provider ?? 'openrouter', config),
          config,
          `worker-${Date.now()}-${nextIndex}`,
        ),
      ];
    });
  };

  const removeKiraWorker = (id: string) => {
    setKiraWorkers((prev) => (prev.length <= 1 ? prev : prev.filter((worker) => worker.id !== id)));
  };

  const dialogModelOptions = getProviderModelOptions(dialogProvider, runtimeModels);
  const isPresetDialogModel = dialogModelOptions.includes(dialogModel);
  const showDialogDropdown = !dialogManualModelMode && dialogModelOptions.length > 0;
  const ttsLastWarmLabel = ttsStatusSnapshot.lastWarmAt
    ? new Date(ttsStatusSnapshot.lastWarmAt).toLocaleTimeString()
    : 'Not yet';
  const aoiAutonomyPolicy = aoiAutonomyStatus?.policy ?? null;
  const aoiAutonomyLastTickMs = aoiAutonomyStatus?.lastTickAt ?? aoiAutonomyLastTickAt;
  const aoiAutonomyLastTickLabel = aoiAutonomyLastTickMs
    ? new Date(aoiAutonomyLastTickMs).toLocaleString()
    : 'Not run in this panel';
  const aoiAutonomyNextTickLabel =
    aoiAutonomyStatus?.nextAllowedTickAt && aoiAutonomyStatus.nextAllowedTickAt > Date.now()
      ? new Date(aoiAutonomyStatus.nextAllowedTickAt).toLocaleTimeString()
      : 'Ready';
  const aoiAutonomyCurrentGoalLabel = aoiAutonomyStatus?.currentGoalTitle
    ? sanitizeAoiProposalDisplayText(aoiAutonomyStatus.currentGoalTitle, 80)
    : 'None';
  const aoiAutonomyNextGoalStepLabel = aoiAutonomyStatus?.nextGoalStepTitle
    ? sanitizeAoiProposalDisplayText(aoiAutonomyStatus.nextGoalStepTitle, 96)
    : 'None';
  const aoiAutonomyBlockedCount = Math.max(
    aoiAutonomyProposalCounts.blocked,
    aoiAutonomyBlockedProposals.length,
  );
  const aoiAutonomyAcceptanceLabel = aoiAutonomyEvaluation
    ? `${Math.round(aoiAutonomyEvaluation.metrics.proposalAcceptanceRate * 100)}%`
    : 'n/a';
  const aoiAutonomyEvidenceLabel = aoiAutonomyEvaluation
    ? `${Math.round(aoiAutonomyEvaluation.metrics.evidenceCoverage * 100)}%`
    : 'n/a';
  const aoiAutonomyNoisyTypeLabel =
    aoiAutonomyEvaluation?.calibration.noisyProposalTypes[0]?.key ?? 'None';
  const aoiTrustCalibration = aoiAutonomyEvaluation?.trustCalibration ?? null;
  const aoiTrustSuppressedCategories =
    aoiTrustCalibration?.topSuppressedCategories.slice(0, 4) ?? [];
  const aoiTrustNegativeSources = aoiTrustCalibration?.negativeSources.slice(0, 4) ?? [];
  const aoiTrustRecentChanges = aoiTrustCalibration?.recentChanges.slice(0, 5) ?? [];
  const settingsTabs: Array<{ key: SettingsTabKey; label: string }> = [
    { key: 'chat', label: 'Chat' },
    { key: 'models', label: 'Models' },
    { key: 'kira', label: 'Kira' },
    { key: 'image', label: 'Image' },
    { key: 'advanced', label: 'Advanced' },
  ];

  const renderModelRuntimeFields = (
    values: {
      reasoningEffort: LLMReasoningEffort | '';
      reasoningSummary: LLMReasoningSummary | '';
      verbosity: LLMVerbosity | '';
      serviceTier: string;
      parallelToolCalls: ParallelToolCallsOption;
    },
    onChange: (
      patch: Partial<{
        reasoningEffort: LLMReasoningEffort | '';
        reasoningSummary: LLMReasoningSummary | '';
        verbosity: LLMVerbosity | '';
        serviceTier: string;
        parallelToolCalls: ParallelToolCallsOption;
      }>,
    ) => void,
  ) => (
    <div className={styles.runtimeOptionsGrid}>
      <div className={styles.field}>
        <label className={styles.label}>Reasoning effort</label>
        <select
          className={styles.select}
          value={values.reasoningEffort}
          onChange={(e) => onChange({ reasoningEffort: e.target.value as LLMReasoningEffort | '' })}
        >
          {MODEL_REASONING_OPTIONS.map((option) => (
            <option key={option.value || 'default'} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      <div className={styles.field}>
        <label className={styles.label}>Reasoning summary</label>
        <select
          className={styles.select}
          value={values.reasoningSummary}
          onChange={(e) =>
            onChange({ reasoningSummary: e.target.value as LLMReasoningSummary | '' })
          }
        >
          {MODEL_REASONING_SUMMARY_OPTIONS.map((option) => (
            <option key={option.value || 'default'} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      <div className={styles.field}>
        <label className={styles.label}>Verbosity</label>
        <select
          className={styles.select}
          value={values.verbosity}
          onChange={(e) => onChange({ verbosity: e.target.value as LLMVerbosity | '' })}
        >
          {MODEL_VERBOSITY_OPTIONS.map((option) => (
            <option key={option.value || 'default'} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      <div className={styles.field}>
        <label className={styles.label}>Service tier</label>
        <input
          className={styles.fieldInput}
          value={values.serviceTier}
          onChange={(e) => onChange({ serviceTier: e.target.value })}
          placeholder="priority, flex, or custom"
        />
      </div>

      <div className={styles.field}>
        <label className={styles.label}>Parallel tool calls</label>
        <select
          className={styles.select}
          value={values.parallelToolCalls}
          onChange={(e) =>
            onChange({ parallelToolCalls: e.target.value as ParallelToolCallsOption })
          }
        >
          {MODEL_PARALLEL_TOOL_CALL_OPTIONS.map((option) => (
            <option key={option.value || 'default'} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );

  const renderKiraRoleFields = (
    draft: KiraRoleDraft,
    title: string,
    subtitle: string,
    onChange: (patch: Partial<KiraRoleDraft>) => void,
    onProviderChange: (provider: KiraAgentProvider) => void,
    removable?: boolean,
  ) => {
    const isLoginCli = isLoginCliProvider(draft.provider);
    const isCodexAuth = isCodexAuthProvider(draft.provider);
    const isOpenCode = isOpenCodeProvider(draft.provider);
    const roleModelOptions = getProviderModelOptions(draft.provider, runtimeModels);
    const hasPresetRoleModel = roleModelOptions.includes(draft.model);
    const usesInheritedApiKey =
      !draft.apiKey.trim() && canInheritKiraApiKey(draft.provider, provider, apiKey);
    const showInheritedApiKeyMask = usesInheritedApiKey && focusedKiraApiKeyId !== draft.id;
    const apiKeyValue = showInheritedApiKeyMask ? '***' : draft.apiKey;

    return (
      <div className={styles.settingsSectionCard} key={draft.id}>
        <div className={styles.settingsSectionHeader}>
          <div>
            <div className={styles.settingsSectionTitle}>{title}</div>
            <span className={styles.modelHint}>{subtitle}</span>
          </div>
          {removable && (
            <button
              type="button"
              className={styles.iconActionBtn}
              onClick={() => removeKiraWorker(draft.id)}
              disabled={kiraWorkers.length <= 1}
              title="Remove worker"
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>

        <div className={styles.field}>
          <label className={styles.label}>Display name</label>
          <input
            className={styles.fieldInput}
            value={draft.name}
            onChange={(e) => onChange({ name: e.target.value })}
            placeholder={title}
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label}>Provider</label>
          <select
            className={styles.select}
            value={draft.provider}
            onChange={(e) => onProviderChange(e.target.value as KiraAgentProvider)}
          >
            {KIRA_PROVIDER_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        {isCodexAuth ? (
          <>
            <div className={styles.connectionCheckBox}>
              <span className={styles.modelHint}>
                Uses the same Codex account OAuth session managed in Main LLM.
              </span>
            </div>

            <div className={styles.field}>
              <label className={styles.label}>Model</label>
              {roleModelOptions.length > 0 ? (
                <select
                  className={styles.select}
                  value={draft.model}
                  onChange={(e) => onChange({ model: e.target.value })}
                >
                  {!draft.model.trim() ? <option value="">Select a model</option> : null}
                  {draft.model.trim() && !hasPresetRoleModel ? (
                    <option value={draft.model}>{draft.model} (custom)</option>
                  ) : null}
                  {roleModelOptions.map((modelId) => (
                    <option key={modelId} value={modelId}>
                      {formatModelLabel(draft.provider, modelId)}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  className={styles.fieldInput}
                  value={draft.model}
                  onChange={(e) => onChange({ model: e.target.value })}
                  placeholder={getDefaultProviderConfig(draft.provider).model}
                />
              )}
            </div>
          </>
        ) : isLoginCli ? (
          <>
            <div className={styles.field}>
              <label className={styles.label}>Command</label>
              <input
                className={styles.fieldInput}
                value={draft.command}
                onChange={(e) => onChange({ command: e.target.value })}
                placeholder={getDefaultCliCommand(draft.provider)}
              />
              <span className={styles.modelHint}>{getLoginCliHint(draft.provider)}</span>
            </div>

            <div className={styles.field}>
              <label className={styles.label}>Model</label>
              {roleModelOptions.length > 0 ? (
                <select
                  className={styles.select}
                  value={draft.model}
                  onChange={(e) => onChange({ model: e.target.value })}
                >
                  {!draft.model.trim() ? <option value="">Select a model</option> : null}
                  {draft.model.trim() && !hasPresetRoleModel ? (
                    <option value={draft.model}>{draft.model} (custom)</option>
                  ) : null}
                  {roleModelOptions.map((modelId) => (
                    <option key={modelId} value={modelId}>
                      {formatModelLabel(draft.provider, modelId)}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  className={styles.fieldInput}
                  value={draft.model}
                  onChange={(e) => onChange({ model: e.target.value })}
                  placeholder={getDefaultProviderConfig(draft.provider).model}
                />
              )}
              {draft.provider === 'openrouter' ? (
                <span className={styles.modelHint}>{openRouterStatusHint}</span>
              ) : null}
            </div>
          </>
        ) : (
          <>
            <div className={styles.field}>
              <label className={styles.label}>API Key</label>
              <input
                className={styles.fieldInput}
                type="password"
                value={apiKeyValue}
                onFocus={() => {
                  if (usesInheritedApiKey) setFocusedKiraApiKeyId(draft.id);
                }}
                onBlur={() => {
                  setFocusedKiraApiKeyId((current) => (current === draft.id ? null : current));
                }}
                onChange={(e) => onChange({ apiKey: e.target.value })}
                placeholder={
                  usesInheritedApiKey
                    ? 'Inherited from Main LLM'
                    : getProviderApiKeyPlaceholder(
                        draft.provider,
                        'Optional if inherited from environment',
                      )
                }
              />
              {usesInheritedApiKey ? (
                <span className={styles.modelHint}>
                  Inherits the API key from the Main LLM settings.
                </span>
              ) : null}
            </div>

            <div className={styles.field}>
              <label className={styles.label}>Base URL</label>
              <input
                className={styles.fieldInput}
                value={draft.baseUrl}
                onChange={(e) => onChange({ baseUrl: e.target.value })}
              />
            </div>

            <div className={styles.field}>
              <label className={styles.label}>Model</label>
              {roleModelOptions.length > 0 ? (
                <select
                  className={styles.select}
                  value={draft.model}
                  onChange={(e) => onChange({ model: e.target.value })}
                >
                  {!draft.model.trim() ? <option value="">Select a model</option> : null}
                  {draft.model.trim() && !hasPresetRoleModel ? (
                    <option value={draft.model}>{draft.model} (custom)</option>
                  ) : null}
                  {roleModelOptions.map((modelId) => (
                    <option key={modelId} value={modelId}>
                      {formatModelLabel(draft.provider, modelId)}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  className={styles.fieldInput}
                  value={draft.model}
                  onChange={(e) => onChange({ model: e.target.value })}
                  placeholder={isOpenCode ? 'opencode/claude-sonnet-4-6' : 'model-id'}
                />
              )}
              {draft.provider === 'openrouter' ? (
                <span className={styles.modelHint}>{openRouterStatusHint}</span>
              ) : null}
            </div>

            {isOpenCode && (
              <div className={styles.field}>
                <label className={styles.label}>API style</label>
                <select
                  className={styles.select}
                  value={draft.apiStyle}
                  onChange={(e) => onChange({ apiStyle: e.target.value as KiraAgentApiStyle | '' })}
                >
                  {KIRA_API_STYLE_OPTIONS.map((option) => (
                    <option key={option.value || 'auto'} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div className={styles.field}>
              <label className={styles.label}>Custom Headers</label>
              <textarea
                className={styles.fieldInput}
                value={draft.customHeaders}
                onChange={(e) => onChange({ customHeaders: e.target.value })}
                placeholder={'X-Custom-Header: value'}
                rows={2}
                style={{ resize: 'vertical', fontFamily: 'monospace', fontSize: '12px' }}
              />
            </div>
          </>
        )}

        {renderModelRuntimeFields(
          {
            reasoningEffort: draft.reasoningEffort,
            reasoningSummary: draft.reasoningSummary,
            verbosity: draft.verbosity,
            serviceTier: draft.serviceTier,
            parallelToolCalls: draft.parallelToolCalls,
          },
          onChange,
        )}
        <span className={styles.modelHint}>
          Applied to CLI providers and OpenAI Responses-compatible Kira calls. Unsupported model
          routes keep their provider defaults.
        </span>
      </div>
    );
  };

  return (
    <div className={styles.overlay} data-testid="settings-overlay">
      <div className={styles.settingsModal} data-testid="settings-modal">
        <div className={styles.settingsHeader}>
          <div className={styles.settingsHeading}>
            <div className={styles.settingsTitle}>Settings</div>
            <div className={styles.settingsSubtitle}>
              Grouped by task so the window stays shorter and easier to scan.
            </div>
          </div>
          <button className={styles.cancelBtn} onClick={onClose}>
            Close
          </button>
        </div>

        <div className={styles.settingsTabs}>
          {settingsTabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              className={`${styles.settingsTab} ${
                activeTab === tab.key ? styles.settingsTabActive : ''
              }`}
              onClick={() => setActiveTab(tab.key)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className={styles.settingsBody}>
          {activeTab === 'chat' && (
            <div className={styles.settingsSection}>
              <div className={styles.settingsSectionCard}>
                <div className={styles.settingsSectionTitle}>Profile</div>
                <div className={styles.field}>
                  <label className={styles.label}>Preferred name</label>
                  <input
                    className={styles.fieldInput}
                    value={preferredName}
                    onChange={(e) => setPreferredName(e.target.value)}
                    placeholder="e.g. Minji, Alex, Sam"
                  />
                  <span className={styles.modelHint}>
                    Saved and loaded on startup so the assistant can keep calling you by the same
                    name.
                  </span>
                </div>
              </div>

              <div className={styles.settingsSectionCard}>
                <div className={styles.settingsSectionTitle}>Conversation</div>
                <div className={styles.field}>
                  <label className={styles.label}>Reply language</label>
                  <select
                    className={styles.select}
                    value={responseLanguageMode}
                    onChange={(e) =>
                      setResponseLanguageMode(e.target.value as ResponseLanguageMode)
                    }
                  >
                    <option value="match-user">Match current user language</option>
                    <option value="english">Always English</option>
                  </select>
                  <span className={styles.modelHint}>
                    Applies to assistant chat replies, quick acknowledgements, and reminder
                    messages.
                  </span>
                </div>

                <div className={styles.field}>
                  <label className={styles.label}>Read Aoi's chat messages aloud</label>
                  <button
                    type="button"
                    className={ttsEnabled ? styles.saveBtn : styles.cancelBtn}
                    onClick={() => setTtsEnabled((prev) => !prev)}
                  >
                    {ttsEnabled ? 'Enabled' : 'Disabled'}
                  </button>
                  <span className={styles.modelHint}>
                    When enabled, newly added assistant messages are spoken aloud with Google
                    `Despina`.
                  </span>
                </div>

                <div className={styles.field}>
                  <label className={styles.label}>Preload common short replies</label>
                  <button
                    type="button"
                    disabled={!ttsEnabled}
                    className={
                      ttsEnabled && ttsPreloadCommonPhrases ? styles.saveBtn : styles.cancelBtn
                    }
                    onClick={() => setTtsPreloadCommonPhrases((prev) => !prev)}
                  >
                    {ttsPreloadCommonPhrases ? 'Enabled' : 'Disabled'}
                  </button>
                  <span className={styles.modelHint}>
                    Pre-generates the short fixed lines found in the current chat code, like app
                    open acknowledgements and memory confirmations, so they play with less delay.
                  </span>
                </div>

                <div className={styles.promptBudgetCard}>
                  <div className={styles.promptBudgetSection}>
                    <span className={styles.promptBudgetSectionTitle}>Operator voice presence</span>
                    <div className={styles.operatorVoiceToolbar}>
                      <button
                        type="button"
                        className={`${operatorVoicePolicy.enabled ? styles.saveBtn : styles.cancelBtn} ${styles.operatorVoiceButton}`}
                        onClick={() =>
                          setOperatorVoicePolicy((prev) =>
                            normalizeAoiOperatorVoicePolicy({
                              ...prev,
                              enabled: !prev.enabled,
                            }),
                          )
                        }
                        title="Toggle operator voice policy"
                      >
                        {operatorVoicePolicy.enabled ? (
                          <Volume2 size={14} />
                        ) : (
                          <VolumeX size={14} />
                        )}
                        {operatorVoicePolicy.enabled ? 'Enabled' : 'Disabled'}
                      </button>
                      <button
                        type="button"
                        className={`${aoiOperatorVoiceMuted ? styles.saveBtn : styles.cancelBtn} ${styles.operatorVoiceButton}`}
                        onClick={onToggleAoiOperatorVoiceMute}
                        title="Mute operator voice for this session"
                      >
                        {aoiOperatorVoiceMuted ? <VolumeX size={14} /> : <Volume2 size={14} />}
                        {aoiOperatorVoiceMuted ? 'Muted' : 'Mute session'}
                      </button>
                      <button
                        type="button"
                        className={`${aoiOperatorVoicePanelSummary.canReplay ? styles.saveBtn : styles.cancelBtn} ${styles.operatorVoiceButton}`}
                        disabled={!aoiOperatorVoicePanelSummary.canReplay}
                        onClick={onReplayAoiOperatorVoice}
                        title="Replay last operator voice summary"
                      >
                        <RotateCcw size={14} />
                        Replay
                      </button>
                      <button
                        type="button"
                        className={`${styles.cancelBtn} ${styles.operatorVoiceButton}`}
                        onClick={onStopAoiOperatorVoice}
                        title="Stop current operator voice"
                      >
                        <Square size={14} />
                        Stop
                      </button>
                    </div>
                    <span className={styles.modelHint}>
                      Operator voice uses the same TTS switch, then applies mission relevance,
                      category, quiet-window, duplicate, and feedback gates before speaking.
                    </span>
                  </div>

                  <div className={styles.promptBudgetSection}>
                    <span className={styles.promptBudgetSectionTitle}>Voice categories</span>
                    <div className={styles.operatorVoiceCategoryGrid}>
                      {(
                        Object.entries(AOI_OPERATOR_VOICE_CATEGORY_LABELS) as Array<
                          [AoiOperatorVoiceEventCategory, string]
                        >
                      ).map(([category, label]) => {
                        const enabled = operatorVoicePolicy.allowedCategories[category];
                        return (
                          <button
                            key={category}
                            type="button"
                            className={
                              enabled
                                ? styles.operatorVoiceCategoryOn
                                : styles.operatorVoiceCategoryOff
                            }
                            onClick={() => setOperatorVoiceCategoryEnabled(category, !enabled)}
                            title={`Toggle ${label}`}
                          >
                            <span>{label}</span>
                            <strong>{enabled ? 'On' : 'Off'}</strong>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div className={styles.promptBudgetSection}>
                    <span className={styles.promptBudgetSectionTitle}>Last voice decision</span>
                    <p className={styles.modelHint}>
                      {aoiOperatorVoicePanelSummary.statusLabel}:&nbsp;
                      {aoiOperatorVoicePanelSummary.reasonLabel}
                    </p>
                    {aoiLastOperatorVoiceDecision?.summaryId && (
                      <p className={styles.modelHint}>
                        Summary id {aoiLastOperatorVoiceDecision.summaryId}
                      </p>
                    )}
                  </div>
                </div>

                <div className={styles.promptBudgetCard}>
                  <div className={styles.promptBudgetGrid}>
                    <div className={styles.promptBudgetMetric}>
                      <span className={styles.promptBudgetLabel}>Cached lines</span>
                      <strong>{ttsStatusSnapshot.cachedCount}</strong>
                    </div>
                    <div className={styles.promptBudgetMetric}>
                      <span className={styles.promptBudgetLabel}>Pending</span>
                      <strong>{ttsStatusSnapshot.pendingCount}</strong>
                    </div>
                    <div className={styles.promptBudgetMetric}>
                      <span className={styles.promptBudgetLabel}>Prewarm runs</span>
                      <strong>{ttsStatusSnapshot.prewarmRuns}</strong>
                    </div>
                    <div className={styles.promptBudgetMetric}>
                      <span className={styles.promptBudgetLabel}>Last batch</span>
                      <strong>{ttsStatusSnapshot.lastBatchSize}</strong>
                    </div>
                  </div>

                  <div className={styles.promptBudgetSection}>
                    <span className={styles.promptBudgetSectionTitle}>Last warm</span>
                    <p className={styles.modelHint}>{ttsLastWarmLabel}</p>
                  </div>

                  <div className={styles.promptBudgetSection}>
                    <span className={styles.promptBudgetSectionTitle}>Recently warmed lines</span>
                    {ttsStatusSnapshot.recentWarmedLines.length > 0 ? (
                      <div className={styles.promptBudgetLog}>
                        {ttsStatusSnapshot.recentWarmedLines.map((line, index) => (
                          <div key={`${line}-${index}`}>{line}</div>
                        ))}
                      </div>
                    ) : (
                      <p className={styles.modelHint}>
                        Turn on TTS preload and chat a little to build up the warmed cache.
                      </p>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'models' && (
            <div className={styles.settingsSection}>
              <div className={styles.settingsSectionCard}>
                <div className={styles.settingsSectionTitle}>Main LLM</div>
                <div className={styles.field}>
                  <label className={styles.label}>Provider</label>
                  <select
                    className={styles.select}
                    value={provider}
                    onChange={(e) => handleProviderChange(e.target.value as LLMProvider)}
                  >
                    {MODEL_PROVIDER_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>

                {isCodexAuthProvider(provider) ? (
                  <div className={styles.connectionCheckBox}>
                    <span className={styles.modelHint}>{getCodexAuthHint()}</span>
                    <div className={styles.connectionCheckRow}>
                      <button
                        type="button"
                        className={styles.inlineActionBtn}
                        onClick={() => void handleCodexAuthStatusCheck()}
                        disabled={
                          codexAuthStatus.state === 'checking' ||
                          codexAuthStatus.state === 'logging-in'
                        }
                      >
                        {codexAuthStatus.state === 'checking' ? 'Checking...' : 'Check auth'}
                      </button>
                      <button
                        type="button"
                        className={styles.inlineActionBtn}
                        onClick={() => void handleCodexAuthDeviceLogin()}
                        disabled={codexAuthStatus.state === 'logging-in'}
                      >
                        {codexAuthStatus.state === 'logging-in'
                          ? 'Authorizing...'
                          : 'Sign in with browser'}
                      </button>
                      {codexAuthStatus.message ? (
                        <span className={codexAuthClassName}>{codexAuthStatus.message}</span>
                      ) : null}
                    </div>
                    {codexAuthStatus.details.length > 0 ? (
                      <div className={styles.connectionCheckDetails}>
                        {codexAuthStatus.details.map((detail, index) => (
                          <span key={`codex-auth-detail-${index}`}>{detail}</span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : isLoginCliProvider(provider) ? (
                  <>
                    <div className={styles.field}>
                      <label className={styles.label}>Command</label>
                      <input
                        className={styles.fieldInput}
                        value={command}
                        onChange={(e) => setCommand(e.target.value)}
                        placeholder={getDefaultCliCommand(provider)}
                      />
                      <span className={styles.modelHint}>{getLoginCliHint(provider)}</span>
                    </div>

                    {isClaudeCliProvider(provider) ? (
                      <div className={styles.connectionCheckBox}>
                        <div className={styles.connectionCheckRow}>
                          <button
                            type="button"
                            className={styles.inlineActionBtn}
                            onClick={() => void handleClaudeCliConnectionCheck()}
                            disabled={claudeCliCheckStatus.state === 'checking'}
                          >
                            {claudeCliCheckStatus.state === 'checking'
                              ? 'Checking...'
                              : 'Check connection'}
                          </button>
                          {claudeCliCheckStatus.message ? (
                            <span className={claudeCliCheckClassName}>
                              {claudeCliCheckStatus.message}
                            </span>
                          ) : null}
                        </div>
                        {claudeCliCheckStatus.details.length > 0 ? (
                          <div className={styles.connectionCheckDetails}>
                            {claudeCliCheckStatus.details.map((detail) => (
                              <span key={detail}>{detail}</span>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </>
                ) : (
                  <>
                    <div className={styles.field}>
                      <label className={styles.label}>API Key</label>
                      <input
                        className={styles.fieldInput}
                        type="password"
                        value={apiKey}
                        onChange={(e) => setApiKey(e.target.value)}
                        placeholder={getProviderApiKeyPlaceholder(
                          provider,
                          'Optional for local servers',
                        )}
                      />
                    </div>

                    <div className={styles.field}>
                      <label className={styles.label}>Base URL</label>
                      <input
                        className={styles.fieldInput}
                        value={baseUrl}
                        onChange={(e) => setBaseUrl(e.target.value)}
                      />
                    </div>

                    {isOpenCodeProvider(provider) ? (
                      <div className={styles.field}>
                        <label className={styles.label}>API style</label>
                        <select
                          className={styles.select}
                          value={apiStyle}
                          onChange={(e) => setApiStyle(e.target.value as LLMApiStyle | '')}
                        >
                          {KIRA_API_STYLE_OPTIONS.map((option) => (
                            <option key={option.value || 'auto'} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    ) : null}
                  </>
                )}

                <div className={styles.field}>
                  <label className={styles.label}>Model</label>
                  <div className={styles.modelSelectorWrapper}>
                    {showDropdown ? (
                      <>
                        <select
                          className={styles.select}
                          value={model}
                          onChange={(e) => handleModelChange(e.target.value)}
                        >
                          {!model.trim() ? <option value="">Select a model</option> : null}
                          {model.trim() && !isPresetModel ? (
                            <option value={model}>{model} (custom)</option>
                          ) : null}
                          {modelOptions.map((m) => (
                            <option key={m} value={m}>
                              {formatModelLabel(provider, m)}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          onClick={() => setManualModelMode(true)}
                          className={styles.manualToggleBtn}
                          title="Enter custom model name"
                        >
                          <Pencil size={14} />
                        </button>
                        {provider === 'openrouter' ? (
                          <button
                            type="button"
                            onClick={() => void refreshOpenRouterModels()}
                            className={styles.manualToggleBtn}
                            title="Refresh OpenRouter models"
                            disabled={openRouterModelsStatus === 'loading'}
                          >
                            <RotateCcw size={14} />
                          </button>
                        ) : null}
                      </>
                    ) : (
                      <>
                        <input
                          className={styles.fieldInput}
                          value={model}
                          onChange={(e) => setModel(e.target.value)}
                          placeholder="e.g. gpt-4-turbo"
                        />
                        {modelOptions.length > 0 && (
                          <button
                            type="button"
                            onClick={() => setManualModelMode(false)}
                            className={styles.manualToggleBtn}
                            title="Back to model list"
                          >
                            <List size={14} />
                          </button>
                        )}
                        {provider === 'openrouter' ? (
                          <button
                            type="button"
                            onClick={() => void refreshOpenRouterModels()}
                            className={styles.manualToggleBtn}
                            title="Refresh OpenRouter models"
                            disabled={openRouterModelsStatus === 'loading'}
                          >
                            <RotateCcw size={14} />
                          </button>
                        ) : null}
                      </>
                    )}
                  </div>
                  {provider === 'openrouter' ? (
                    <span className={styles.modelHint}>{openRouterStatusHint}</span>
                  ) : null}
                  {isDeepSeekProvider(provider) ? (
                    <span className={styles.modelHint}>
                      Uses the official DeepSeek API endpoint. Legacy deepseek-chat and
                      deepseek-reasoner model names are compatibility aliases until 2026-07-24.
                    </span>
                  ) : null}
                </div>

                {renderModelRuntimeFields(
                  {
                    reasoningEffort,
                    reasoningSummary,
                    verbosity,
                    serviceTier,
                    parallelToolCalls,
                  },
                  (patch) => {
                    if (patch.reasoningEffort !== undefined) {
                      setReasoningEffort(patch.reasoningEffort);
                    }
                    if (patch.reasoningSummary !== undefined) {
                      setReasoningSummary(patch.reasoningSummary);
                    }
                    if (patch.verbosity !== undefined) {
                      setVerbosity(patch.verbosity);
                    }
                    if (patch.serviceTier !== undefined) {
                      setServiceTier(patch.serviceTier);
                    }
                    if (patch.parallelToolCalls !== undefined) {
                      setParallelToolCalls(patch.parallelToolCalls);
                    }
                  },
                )}
                <span className={styles.modelHint}>
                  These options follow the model runtime contract for Responses API and local CLI
                  runs.
                </span>

                {!isLoginCliProvider(provider) && !isCodexAuthProvider(provider) ? (
                  <div className={styles.field}>
                    <label className={styles.label}>
                      Custom Headers (one per line, Key: Value)
                    </label>
                    <textarea
                      className={styles.fieldInput}
                      value={customHeaders}
                      onChange={(e) => setCustomHeaders(e.target.value)}
                      placeholder={'X-Custom-Header: value\nAnother-Header: value'}
                      rows={3}
                      style={{ resize: 'vertical', fontFamily: 'monospace', fontSize: '12px' }}
                    />
                  </div>
                ) : null}
              </div>

              <div className={styles.settingsSectionCard}>
                <div className={styles.settingsSectionTitle}>Dialog Model</div>
                <div className={styles.field}>
                  <label className={styles.label}>
                    Enable cheaper dialog model for simple chat turns
                  </label>
                  <button
                    type="button"
                    className={dialogEnabled ? styles.saveBtn : styles.cancelBtn}
                    onClick={() => setDialogEnabled((prev) => !prev)}
                  >
                    {dialogEnabled ? 'Enabled' : 'Disabled'}
                  </button>
                </div>

                {dialogEnabled && (
                  <>
                    <div className={styles.field}>
                      <label className={styles.label}>Provider</label>
                      <select
                        className={styles.select}
                        value={dialogProvider}
                        onChange={(e) => handleDialogProviderChange(e.target.value as LLMProvider)}
                      >
                        {MODEL_PROVIDER_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </div>

                    {isCodexAuthProvider(dialogProvider) ? (
                      <div className={styles.connectionCheckBox}>
                        <span className={styles.modelHint}>
                          Uses the same Codex account OAuth session managed in Main LLM.
                        </span>
                      </div>
                    ) : isLoginCliProvider(dialogProvider) ? (
                      <div className={styles.field}>
                        <label className={styles.label}>Command</label>
                        <input
                          className={styles.fieldInput}
                          value={dialogCommand}
                          onChange={(e) => setDialogCommand(e.target.value)}
                          placeholder={getDefaultCliCommand(dialogProvider)}
                        />
                        <span className={styles.modelHint}>{getLoginCliHint(dialogProvider)}</span>
                      </div>
                    ) : (
                      <>
                        <div className={styles.field}>
                          <label className={styles.label}>API Key</label>
                          <input
                            className={styles.fieldInput}
                            type="password"
                            value={dialogApiKey}
                            onChange={(e) => setDialogApiKey(e.target.value)}
                            placeholder={getProviderApiKeyPlaceholder(
                              dialogProvider,
                              'Optional — falls back to main config when blank',
                            )}
                          />
                        </div>

                        <div className={styles.field}>
                          <label className={styles.label}>Base URL</label>
                          <input
                            className={styles.fieldInput}
                            value={dialogBaseUrl}
                            onChange={(e) => setDialogBaseUrl(e.target.value)}
                          />
                        </div>

                        {isOpenCodeProvider(dialogProvider) ? (
                          <div className={styles.field}>
                            <label className={styles.label}>API style</label>
                            <select
                              className={styles.select}
                              value={dialogApiStyle}
                              onChange={(e) =>
                                setDialogApiStyle(e.target.value as LLMApiStyle | '')
                              }
                            >
                              {KIRA_API_STYLE_OPTIONS.map((option) => (
                                <option key={option.value || 'auto'} value={option.value}>
                                  {option.label}
                                </option>
                              ))}
                            </select>
                          </div>
                        ) : null}
                      </>
                    )}

                    <div className={styles.field}>
                      <label className={styles.label}>Model</label>
                      <div className={styles.modelSelectorWrapper}>
                        {showDialogDropdown ? (
                          <>
                            <select
                              className={styles.select}
                              value={dialogModel}
                              onChange={(e) => {
                                setDialogModel(e.target.value);
                                setDialogManualModelMode(false);
                              }}
                            >
                              {!dialogModel.trim() ? (
                                <option value="">Select a model</option>
                              ) : null}
                              {dialogModel.trim() && !isPresetDialogModel ? (
                                <option value={dialogModel}>{dialogModel} (custom)</option>
                              ) : null}
                              {dialogModelOptions.map((m) => (
                                <option key={m} value={m}>
                                  {formatModelLabel(dialogProvider, m)}
                                </option>
                              ))}
                            </select>
                            <button
                              type="button"
                              onClick={() => setDialogManualModelMode(true)}
                              className={styles.manualToggleBtn}
                              title="Enter custom model name"
                            >
                              <Pencil size={14} />
                            </button>
                            {dialogProvider === 'openrouter' ? (
                              <button
                                type="button"
                                onClick={() => void refreshOpenRouterModels()}
                                className={styles.manualToggleBtn}
                                title="Refresh OpenRouter models"
                                disabled={openRouterModelsStatus === 'loading'}
                              >
                                <RotateCcw size={14} />
                              </button>
                            ) : null}
                          </>
                        ) : (
                          <>
                            <input
                              className={styles.fieldInput}
                              value={dialogModel}
                              onChange={(e) => setDialogModel(e.target.value)}
                              placeholder="e.g. gpt-5-mini"
                            />
                            {dialogModelOptions.length > 0 && (
                              <button
                                type="button"
                                onClick={() => setDialogManualModelMode(false)}
                                className={styles.manualToggleBtn}
                                title="Back to model list"
                              >
                                <List size={14} />
                              </button>
                            )}
                            {dialogProvider === 'openrouter' ? (
                              <button
                                type="button"
                                onClick={() => void refreshOpenRouterModels()}
                                className={styles.manualToggleBtn}
                                title="Refresh OpenRouter models"
                                disabled={openRouterModelsStatus === 'loading'}
                              >
                                <RotateCcw size={14} />
                              </button>
                            ) : null}
                          </>
                        )}
                      </div>
                      {dialogProvider === 'openrouter' ? (
                        <span className={styles.modelHint}>{openRouterStatusHint}</span>
                      ) : null}
                      <span className={styles.modelHint}>
                        Used only for short, tool-light conversation turns. App actions, search, and
                        richer requests stay on the main model.
                      </span>
                    </div>

                    {renderModelRuntimeFields(
                      {
                        reasoningEffort: dialogReasoningEffort,
                        reasoningSummary: dialogReasoningSummary,
                        verbosity: dialogVerbosity,
                        serviceTier: dialogServiceTier,
                        parallelToolCalls: dialogParallelToolCalls,
                      },
                      (patch) => {
                        if (patch.reasoningEffort !== undefined) {
                          setDialogReasoningEffort(patch.reasoningEffort);
                        }
                        if (patch.reasoningSummary !== undefined) {
                          setDialogReasoningSummary(patch.reasoningSummary);
                        }
                        if (patch.verbosity !== undefined) {
                          setDialogVerbosity(patch.verbosity);
                        }
                        if (patch.serviceTier !== undefined) {
                          setDialogServiceTier(patch.serviceTier);
                        }
                        if (patch.parallelToolCalls !== undefined) {
                          setDialogParallelToolCalls(patch.parallelToolCalls);
                        }
                      },
                    )}

                    {!isLoginCliProvider(dialogProvider) && !isCodexAuthProvider(dialogProvider) ? (
                      <div className={styles.field}>
                        <label className={styles.label}>Custom Headers (optional)</label>
                        <textarea
                          className={styles.fieldInput}
                          value={dialogCustomHeaders}
                          onChange={(e) => setDialogCustomHeaders(e.target.value)}
                          placeholder={'X-Custom-Header: value'}
                          rows={2}
                          style={{ resize: 'vertical', fontFamily: 'monospace', fontSize: '12px' }}
                        />
                      </div>
                    ) : null}
                  </>
                )}
              </div>
            </div>
          )}

          {activeTab === 'kira' && (
            <div className={styles.settingsSection}>
              <div className={styles.settingsSectionCard}>
                <div className={styles.settingsSectionTitle}>Kira Automation</div>
                <div className={styles.field}>
                  <label className={styles.label}>Work root directory</label>
                  <input
                    className={styles.fieldInput}
                    value={kiraWorkRootDirectory}
                    onChange={(e) => setKiraWorkRootDirectory(e.target.value)}
                    placeholder="F:/workspace/project-root"
                  />
                  <span className={styles.modelHint}>
                    Kira lists first-level folders under this directory as local projects.
                  </span>
                </div>

                <div className={styles.field}>
                  <label className={styles.label}>Auto-commit approved attempts</label>
                  <button
                    type="button"
                    className={kiraAutoCommit ? styles.saveBtn : styles.cancelBtn}
                    onClick={() => setKiraAutoCommit((prev) => !prev)}
                  >
                    {kiraAutoCommit ? 'Enabled' : 'Disabled'}
                  </button>
                  <span className={styles.modelHint}>
                    Multi-worker runs still use isolated worktrees. When disabled, the selected
                    attempt is applied to the primary worktree without committing.
                  </span>
                </div>

                <div className={styles.field}>
                  <label className={styles.label}>
                    Default required worker/reviewer instructions
                  </label>
                  <textarea
                    className={styles.fieldInput}
                    value={kiraRequiredInstructions}
                    onChange={(e) => setKiraRequiredInstructions(e.target.value)}
                    placeholder="Coding style, architecture rules, naming conventions, validation expectations..."
                    rows={5}
                    maxLength={12000}
                    style={{ resize: 'vertical' }}
                  />
                  <span className={styles.modelHint}>
                    Applied as binding project defaults unless a project-local .kira settings file
                    overrides them.
                  </span>
                </div>
              </div>

              <div className={styles.settingsSectionHeader}>
                <div>
                  <div className={styles.settingsSectionTitle}>Workers</div>
                  <span className={styles.modelHint}>
                    Register 1 to 3 workers. Each one can use a different provider and model.
                  </span>
                </div>
                <button
                  type="button"
                  className={styles.inlineActionBtn}
                  onClick={addKiraWorker}
                  disabled={kiraWorkers.length >= 3}
                >
                  <Plus size={14} />
                  Add worker
                </button>
              </div>

              {kiraWorkers.map((worker, index) =>
                renderKiraRoleFields(
                  worker,
                  `Worker ${String.fromCharCode(65 + index)}`,
                  index === 0
                    ? 'Default worker used for single-worker mode.'
                    : 'Additional worker used for isolated competing attempts.',
                  (patch) => updateKiraWorker(worker.id, patch),
                  (nextProvider) => handleKiraWorkerProviderChange(worker.id, nextProvider),
                  true,
                ),
              )}

              {renderKiraRoleFields(
                kiraReviewer,
                'Reviewer',
                'Compares worker attempts and selects the best passing solution.',
                updateKiraReviewer,
                handleKiraReviewerProviderChange,
              )}
            </div>
          )}

          {activeTab === 'image' && (
            <div className={styles.settingsSection}>
              <div className={styles.settingsSectionCard}>
                <div className={styles.settingsSectionTitle}>Image Generation</div>
                <div className={styles.field}>
                  <label className={styles.label}>Provider</label>
                  <select
                    className={styles.select}
                    value={igProvider}
                    onChange={(e) => handleIgProviderChange(e.target.value as ImageGenProvider)}
                  >
                    <option value="openai">OpenAI</option>
                    <option value="gemini">Gemini</option>
                  </select>
                </div>

                <div className={styles.field}>
                  <label className={styles.label}>API Key</label>
                  <input
                    className={styles.fieldInput}
                    type="password"
                    value={igApiKey}
                    onChange={(e) => setIgApiKey(e.target.value)}
                    placeholder="API Key..."
                  />
                </div>

                <div className={styles.field}>
                  <label className={styles.label}>Base URL</label>
                  <input
                    className={styles.fieldInput}
                    value={igBaseUrl}
                    onChange={(e) => setIgBaseUrl(e.target.value)}
                  />
                </div>

                <div className={styles.field}>
                  <label className={styles.label}>Model</label>
                  <input
                    className={styles.fieldInput}
                    value={igModel}
                    onChange={(e) => setIgModel(e.target.value)}
                  />
                </div>

                <div className={styles.field}>
                  <label className={styles.label}>Custom Headers</label>
                  <textarea
                    className={styles.fieldInput}
                    value={igCustomHeaders}
                    onChange={(e) => setIgCustomHeaders(e.target.value)}
                    placeholder={'X-Custom-Header: value'}
                    rows={2}
                    style={{ resize: 'vertical', fontFamily: 'monospace', fontSize: '12px' }}
                  />
                </div>
              </div>
            </div>
          )}

          {activeTab === 'advanced' && (
            <div className={styles.settingsSection}>
              <div className={styles.settingsSectionCard} data-testid="aoi-autonomy-panel">
                <div className={styles.settingsSectionHeader}>
                  <div>
                    <div className={styles.settingsSectionTitle}>
                      Aoi Autonomy
                      {aoiAutonomyNotificationBadge?.visible && (
                        <span
                          className={styles.aoiAutonomyBadge}
                          title={aoiAutonomyNotificationBadge.why}
                        >
                          {aoiAutonomyNotificationBadge.label}
                        </span>
                      )}
                    </div>
                    <span className={styles.modelHint}>
                      Checks, proposals, goals, and safety gates.
                    </span>
                  </div>
                  <div className={styles.aoiAutonomyHeaderActions}>
                    <button
                      type="button"
                      className={styles.inlineActionBtn}
                      onClick={() =>
                        onUpdateAoiAutonomyPanelSettings({
                          panelExpanded: !aoiAutonomyPanelSettings.panelExpanded,
                        })
                      }
                      title={
                        aoiAutonomyPanelSettings.panelExpanded
                          ? 'Collapse Aoi autonomy panel'
                          : 'Expand Aoi autonomy panel'
                      }
                    >
                      {aoiAutonomyPanelSettings.panelExpanded ? (
                        <ChevronDown size={14} />
                      ) : (
                        <ChevronRight size={14} />
                      )}
                      {aoiAutonomyPanelSettings.panelExpanded ? 'Collapse' : 'Expand'}
                    </button>
                    <button
                      type="button"
                      className={styles.inlineActionBtn}
                      onClick={() => void onRefreshAoiAutonomy()}
                      disabled={aoiAutonomyLoading}
                      title="Refresh Aoi autonomy state"
                    >
                      <RotateCcw size={14} />
                      Refresh
                    </button>
                    <button
                      type="button"
                      className={styles.inlineActionBtn}
                      onClick={() => void onRunAoiAutonomyCheck()}
                      disabled={
                        aoiAutonomyActionId === 'tick' ||
                        aoiAutonomyLoading ||
                        aoiAutonomyStatus?.activeTick
                      }
                      title="Run a bounded manual proposal check"
                    >
                      Run check
                    </button>
                  </div>
                </div>

                {aoiAutonomyPanelSettings.panelExpanded && (
                  <>
                    {aoiAutonomyError && (
                      <div className={styles.aoiAutonomyError}>{aoiAutonomyError}</div>
                    )}
                    {aoiAutonomyLoading && (
                      <span className={styles.modelHint}>Loading autonomy state...</span>
                    )}

                    <div className={styles.promptBudgetGrid}>
                      <div className={styles.promptBudgetMetric}>
                        <span className={styles.promptBudgetLabel}>Enabled</span>
                        <strong>{aoiAutonomyPolicy?.enabled ? 'On' : 'Off'}</strong>
                      </div>
                      <div className={styles.promptBudgetMetric}>
                        <span className={styles.promptBudgetLabel}>Level</span>
                        <strong>{aoiAutonomyPolicy?.level ?? 'L1'}</strong>
                      </div>
                      <div className={styles.promptBudgetMetric}>
                        <span className={styles.promptBudgetLabel}>Proactive</span>
                        <strong>
                          {aoiAutonomyPolicy?.proactiveSuggestionsEnabled ? 'On' : 'Off'}
                        </strong>
                      </div>
                      <div className={styles.promptBudgetMetric}>
                        <span className={styles.promptBudgetLabel}>Active</span>
                        <strong>{aoiAutonomyProposalCounts.active}</strong>
                      </div>
                      <div className={styles.promptBudgetMetric}>
                        <span className={styles.promptBudgetLabel}>Dismissed / snoozed</span>
                        <strong>
                          {aoiAutonomyProposalCounts.dismissed} /{' '}
                          {aoiAutonomyProposalCounts.snoozed}
                        </strong>
                      </div>
                      <div className={styles.promptBudgetMetric}>
                        <span className={styles.promptBudgetLabel}>Blocked</span>
                        <strong>{aoiAutonomyBlockedCount}</strong>
                      </div>
                      <div className={styles.promptBudgetMetric}>
                        <span className={styles.promptBudgetLabel}>Last check</span>
                        <strong>{aoiAutonomyLastTickLabel}</strong>
                      </div>
                      <div className={styles.promptBudgetMetric}>
                        <span className={styles.promptBudgetLabel}>Next check</span>
                        <strong>{aoiAutonomyNextTickLabel}</strong>
                      </div>
                      <div className={styles.promptBudgetMetric}>
                        <span className={styles.promptBudgetLabel}>Tick</span>
                        <strong>{aoiAutonomyStatus?.activeTick ? 'Running' : 'Idle'}</strong>
                      </div>
                      <div className={styles.promptBudgetMetric}>
                        <span className={styles.promptBudgetLabel}>Wakeups</span>
                        <strong>{aoiAutonomyScheduler?.wakeupCount ?? 0}</strong>
                      </div>
                      <div className={styles.promptBudgetMetric}>
                        <span className={styles.promptBudgetLabel}>Scheduler</span>
                        <strong>{aoiAutonomySchedulerSummary.nextWakeupLabel}</strong>
                      </div>
                      <div className={styles.promptBudgetMetric}>
                        <span className={styles.promptBudgetLabel}>Observed</span>
                        <strong>{aoiAutonomyStatus?.recentObservationCount ?? 0}</strong>
                      </div>
                      <div className={styles.promptBudgetMetric}>
                        <span className={styles.promptBudgetLabel}>Goals</span>
                        <strong>{aoiAutonomyStatus?.activeGoalCount ?? 0}</strong>
                      </div>
                      <div className={styles.promptBudgetMetric}>
                        <span className={styles.promptBudgetLabel}>Current goal</span>
                        <strong>{aoiAutonomyCurrentGoalLabel}</strong>
                      </div>
                      <div className={styles.promptBudgetMetric}>
                        <span className={styles.promptBudgetLabel}>Next goal step</span>
                        <strong>{aoiAutonomyNextGoalStepLabel}</strong>
                      </div>
                      <div className={styles.promptBudgetMetric}>
                        <span className={styles.promptBudgetLabel}>Sources</span>
                        <strong>
                          {enabledAoiEnvironmentSourceCount} /{' '}
                          {aoiAutonomyStatus?.environmentSourceCount ??
                            aoiEnvironmentSourceSummaries.length}
                        </strong>
                      </div>
                      <div className={styles.promptBudgetMetric}>
                        <span className={styles.promptBudgetLabel}>Context</span>
                        <strong>{aoiContextSourceSummaries.length}</strong>
                      </div>
                      <div className={styles.promptBudgetMetric}>
                        <span className={styles.promptBudgetLabel}>Workspace</span>
                        <strong>
                          {aoiWorkspaceSignalSummary.visible ? 'Observed' : 'No signal'}
                        </strong>
                      </div>
                      <div className={styles.promptBudgetMetric}>
                        <span className={styles.promptBudgetLabel}>Validation</span>
                        <strong>{aoiWorkspaceSignalSummary.freshnessLabel}</strong>
                      </div>
                      <div className={styles.promptBudgetMetric}>
                        <span className={styles.promptBudgetLabel}>Private gated</span>
                        <strong>{privateAoiEnvironmentSourceCount}</strong>
                      </div>
                    </div>

                    {aoiOperatorHealthSummary.visible && (
                      <div className={styles.aoiAutonomyProposalSection}>
                        <div className={styles.promptBudgetSectionTitle}>Operator health</div>
                        <div className={styles.aoiAutonomyProposalItem}>
                          <div className={styles.aoiAutonomyProposalMeta}>
                            <span>{aoiOperatorHealthSummary.statusLabel}</span>
                            {aoiOperatorHealthSummary.capabilityLabels.map((label) => (
                              <span key={label}>{label}</span>
                            ))}
                          </div>
                          <div className={styles.aoiAutonomyProposalTitle}>
                            {aoiOperatorHealthSummary.summaryLabel}
                          </div>
                          {(aoiOperatorHealthSummary.issueLabels.length > 0 ||
                            aoiOperatorHealthSummary.recommendationLabels.length > 0 ||
                            aoiOperatorHealthSummary.evidenceRefs.length > 0) && (
                            <div className={styles.aoiAutonomyProposalDetails}>
                              {aoiOperatorHealthSummary.issueLabels.map((label, index) => (
                                <div key={`health-issue-${index}`}>{label}</div>
                              ))}
                              {aoiOperatorHealthSummary.recommendationLabels.map((label, index) => (
                                <div key={`health-recommendation-${index}`}>Next: {label}</div>
                              ))}
                              {aoiOperatorHealthSummary.evidenceRefs.map((ref, index) => (
                                <div key={`health-evidence-${index}`}>Evidence: {ref}</div>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    )}

                    {aoiPlaybookSummary.visible && (
                      <div className={styles.aoiAutonomyProposalSection}>
                        <div className={styles.promptBudgetSectionTitle}>Current playbook</div>
                        <div className={styles.aoiAutonomyProposalItem}>
                          <div className={styles.aoiAutonomyProposalMeta}>
                            <span>{aoiPlaybookSummary.statusLabel}</span>
                            <span>{aoiPlaybookSummary.stepLabels.length} steps shown</span>
                          </div>
                          <div className={styles.aoiAutonomyProposalTitle}>
                            {aoiPlaybookSummary.titleLabel}
                          </div>
                          <div className={styles.aoiAutonomyProposalReason}>
                            {aoiPlaybookSummary.objectiveLabel}
                          </div>
                          <div className={styles.aoiAutonomyProposalDetails}>
                            <div>Next: {aoiPlaybookSummary.nextDecisionLabel}</div>
                            {aoiPlaybookSummary.stepLabels.map((label, index) => (
                              <div key={`playbook-step-${index}`}>{label}</div>
                            ))}
                            {aoiPlaybookSummary.boundaryLabels.map((label, index) => (
                              <div key={`playbook-boundary-${index}`}>Boundary: {label}</div>
                            ))}
                            {aoiPlaybookSummary.blockedPrerequisiteLabels.map((label, index) => (
                              <div key={`playbook-blocked-${index}`}>Blocked: {label}</div>
                            ))}
                            {aoiPlaybookSummary.evidenceRefs.map((ref, index) => (
                              <div key={`playbook-evidence-${index}`}>Evidence: {ref}</div>
                            ))}
                          </div>
                        </div>
                      </div>
                    )}

                    <div className={styles.aoiAutonomyControls}>
                      <div className={styles.promptBudgetMetric}>
                        <span className={styles.promptBudgetLabel}>Autonomy policy</span>
                        <button
                          type="button"
                          className={aoiAutonomyPolicy?.enabled ? styles.saveBtn : styles.cancelBtn}
                          onClick={() =>
                            void onUpdateAoiAutonomyPolicy({
                              enabled: !aoiAutonomyPolicy?.enabled,
                            })
                          }
                          disabled={!aoiAutonomyPolicy || aoiAutonomyActionId === 'policy'}
                        >
                          {aoiAutonomyPolicy?.enabled ? 'Enabled' : 'Disabled'}
                        </button>
                      </div>
                      <div className={styles.field}>
                        <label className={styles.label}>Autonomy level</label>
                        <select
                          className={styles.select}
                          value={aoiAutonomyPolicy?.level ?? 'L1'}
                          onChange={(event) =>
                            void onUpdateAoiAutonomyPolicy({
                              level: event.target.value as AoiAutonomyLevel,
                            })
                          }
                          disabled={!aoiAutonomyPolicy || aoiAutonomyActionId === 'policy'}
                        >
                          {AOI_AUTONOMY_UI_LEVELS.map((level) => (
                            <option key={level} value={level}>
                              {level}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className={styles.promptBudgetMetric}>
                        <span className={styles.promptBudgetLabel}>Inline suggestions</span>
                        <button
                          type="button"
                          className={
                            aoiAutonomyPolicy?.proactiveSuggestionsEnabled
                              ? styles.saveBtn
                              : styles.cancelBtn
                          }
                          onClick={() =>
                            void onUpdateAoiAutonomyPolicy({
                              proactiveSuggestionsEnabled:
                                !aoiAutonomyPolicy?.proactiveSuggestionsEnabled,
                            })
                          }
                          disabled={!aoiAutonomyPolicy || aoiAutonomyActionId === 'policy'}
                        >
                          {aoiAutonomyPolicy?.proactiveSuggestionsEnabled ? 'On' : 'Off'}
                        </button>
                      </div>
                      <div className={styles.promptBudgetMetric}>
                        <span className={styles.promptBudgetLabel}>Quiet mode</span>
                        <button
                          type="button"
                          className={
                            aoiAutonomyPanelSettings.quietMode ? styles.cancelBtn : styles.saveBtn
                          }
                          onClick={() =>
                            onUpdateAoiAutonomyPanelSettings({
                              quietMode: !aoiAutonomyPanelSettings.quietMode,
                            })
                          }
                          title="Pause proactive UI indicators while keeping observations"
                        >
                          {aoiAutonomyPanelSettings.quietMode ? 'Quiet' : 'Normal'}
                        </button>
                      </div>
                      <div className={styles.promptBudgetMetric}>
                        <span className={styles.promptBudgetLabel}>Desktop toast</span>
                        <button
                          type="button"
                          className={
                            aoiAutonomyPanelSettings.notificationsEnabled
                              ? styles.saveBtn
                              : styles.cancelBtn
                          }
                          onClick={() =>
                            onUpdateAoiAutonomyPanelSettings({
                              notificationsEnabled: !aoiAutonomyPanelSettings.notificationsEnabled,
                            })
                          }
                          title="Desktop notifications stay opt-in and high-risk proposals are excluded"
                        >
                          {aoiAutonomyPanelSettings.notificationsEnabled ? 'Opt-in' : 'Off'}
                        </button>
                      </div>
                      <div className={styles.field}>
                        <label className={styles.label}>Max suggestions</label>
                        <select
                          className={styles.select}
                          value={String(aoiAutonomyPanelSettings.maxSuggestionsPerSession)}
                          onChange={(event) =>
                            onUpdateAoiAutonomyPanelSettings({
                              maxSuggestionsPerSession: Number(event.target.value),
                            })
                          }
                        >
                          {[0, 1, 2, 3, 5].map((value) => (
                            <option key={value} value={value}>
                              {value}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>

                    <div className={styles.aoiAutonomyProposalSection}>
                      <div className={styles.promptBudgetSectionTitle}>Operator digest</div>
                      {aoiOperatorDigestSummary.visible ? (
                        <div className={styles.aoiAutonomyProposalList}>
                          <div className={styles.aoiAutonomyProposalItem}>
                            <div className={styles.aoiAutonomyProposalMeta}>
                              <span>{aoiOperatorDigestSummary.summaryLabel}</span>
                              {aoiOperatorDigestSummary.laneLabels.map((label) => (
                                <span key={label}>{label}</span>
                              ))}
                            </div>
                            {aoiOperatorDigestSummary.resumeBriefLabel && (
                              <div className={styles.aoiAutonomyProposalReason}>
                                {aoiOperatorDigestSummary.resumeBriefLabel}
                              </div>
                            )}
                            {aoiOperatorDigestSummary.hiddenLabel && (
                              <div className={styles.aoiAutonomyProposalDetails}>
                                <div>{aoiOperatorDigestSummary.hiddenLabel}</div>
                              </div>
                            )}
                            {aoiOperatorDigestSummary.itemLabels.length > 0 && (
                              <div className={styles.aoiAutonomyProposalDetails}>
                                {aoiOperatorDigestSummary.itemLabels.map((label, index) => (
                                  <div key={`digest-item-${index}`}>{label}</div>
                                ))}
                              </div>
                            )}
                            {aoiOperatorDigestSummary.evidenceRefs.length > 0 && (
                              <div className={styles.aoiAutonomyProposalDetails}>
                                {aoiOperatorDigestSummary.evidenceRefs.map((ref, index) => (
                                  <div key={`digest-evidence-${index}`}>Evidence: {ref}</div>
                                ))}
                              </div>
                            )}
                          </div>
                          {(aoiOperatorDigest?.approvalInbox ?? []).map((item) => {
                            const proposalPending = Boolean(
                              aoiAutonomyActionId?.startsWith(`proposal:${item.proposalId}:`),
                            );
                            const expanded = expandedAoiProposalId === item.proposalId;
                            return (
                              <div
                                className={styles.aoiAutonomyProposalItem}
                                key={`inbox-${item.proposalId}`}
                              >
                                <div className={styles.aoiAutonomyProposalMeta}>
                                  <span>approval inbox</span>
                                  <span>{item.status}</span>
                                  <span>{item.risk} risk</span>
                                  <span>evidence {item.evidenceCount}</span>
                                  <span>requires {item.requiredAutonomyLevel}</span>
                                </div>
                                <div className={styles.aoiAutonomyProposalTitle}>
                                  {sanitizeAoiProposalDisplayText(item.title, 140)}
                                </div>
                                <div className={styles.aoiAutonomyProposalReason}>
                                  {sanitizeAoiProposalDisplayText(item.exactNextAction, 220)}
                                </div>
                                <div className={styles.aoiAutonomyProposalDetails}>
                                  <div>
                                    Boundary: {sanitizeAoiProposalDisplayText(item.boundary, 260)}
                                  </div>
                                  <div>
                                    Available:{' '}
                                    {item.availableActions
                                      .map((action) => action.replace(/_/g, ' '))
                                      .join(' / ')}
                                  </div>
                                  {expanded &&
                                    item.evidenceRefs.map((ref, index) => (
                                      <div key={`inbox-${item.proposalId}-evidence-${index}`}>
                                        Evidence: {sanitizeAoiProposalDisplayText(ref, 220)}
                                      </div>
                                    ))}
                                </div>
                                <div className={styles.aoiAutonomyProposalActions}>
                                  <button
                                    type="button"
                                    className={styles.inlineActionBtn}
                                    onClick={() =>
                                      void onDecideAoiProposal(item.proposalId, 'accept')
                                    }
                                    disabled={proposalPending || item.status !== 'active'}
                                    title="Record approval through the existing proposal path"
                                  >
                                    Approve
                                  </button>
                                  <button
                                    type="button"
                                    className={styles.inlineActionBtn}
                                    onClick={() =>
                                      void onDecideAoiProposal(item.proposalId, 'snooze')
                                    }
                                    disabled={proposalPending || item.status !== 'active'}
                                    title="Snooze this prepared action"
                                  >
                                    Snooze
                                  </button>
                                  <button
                                    type="button"
                                    className={styles.inlineActionBtn}
                                    onClick={() =>
                                      void onDecideAoiProposal(item.proposalId, 'dismiss')
                                    }
                                    disabled={proposalPending || item.status !== 'active'}
                                    title="Dismiss this prepared action"
                                  >
                                    Dismiss
                                  </button>
                                  <button
                                    type="button"
                                    className={styles.inlineActionBtn}
                                    onClick={() =>
                                      setExpandedAoiProposalId((prev) =>
                                        prev === item.proposalId ? null : item.proposalId,
                                      )
                                    }
                                    title="Show inbox evidence"
                                  >
                                    {expanded ? (
                                      <ChevronDown size={14} />
                                    ) : (
                                      <ChevronRight size={14} />
                                    )}
                                    Details
                                  </button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <p className={styles.modelHint}>
                          No meaningful ambient operator updates are available.
                        </p>
                      )}
                    </div>

                    <div className={styles.aoiAutonomyProposalSection}>
                      <div className={styles.promptBudgetSectionTitle}>Context router</div>
                      {aoiContextSourceSummaries.length > 0 ? (
                        <div className={styles.aoiAutonomyProposalList}>
                          {aoiContextSourceSummaries.map((source) => {
                            const wrongEvidenceActionId = `context:${source.id}:wrong_evidence`;
                            const wrongSourceActionId = `context:${source.id}:wrong_source`;
                            const wrongTimingActionId = `context:${source.id}:wrong_timing`;
                            return (
                              <div className={styles.aoiAutonomyProposalItem} key={source.id}>
                                <div className={styles.aoiAutonomyProposalMeta}>
                                  <span>{source.displayNameLabel}</span>
                                  <span>{source.kindLabel}</span>
                                  <span>score {source.scoreLabel}</span>
                                  <span>fresh {source.freshnessLabel}</span>
                                  <span>confidence {source.confidenceLabel}</span>
                                  <span>{source.redactionLabel}</span>
                                </div>
                                <div className={styles.aoiAutonomyProposalTitle}>
                                  {source.label}
                                </div>
                                <div className={styles.aoiAutonomyProposalReason}>
                                  {source.summary}
                                </div>
                                <div className={styles.aoiAutonomyProposalDetails}>
                                  {source.scoreReasons.map((reason, index) => (
                                    <div key={`${source.id}-reason-${index}`}>{reason}</div>
                                  ))}
                                  {source.evidenceRefs.map((ref, index) => (
                                    <div key={`${source.id}-evidence-${index}`}>{ref}</div>
                                  ))}
                                </div>
                                <div className={styles.aoiAutonomyProposalActions}>
                                  <button
                                    type="button"
                                    className={styles.inlineActionBtn}
                                    onClick={() =>
                                      void onRecordAoiContextSourceFeedback(
                                        source.sourceId,
                                        source.id,
                                        'wrong_evidence',
                                        source.evidenceRefs,
                                      )
                                    }
                                    disabled={aoiAutonomyActionId === wrongEvidenceActionId}
                                    title={source.wrongEvidenceTitle}
                                  >
                                    Wrong evidence
                                  </button>
                                  <button
                                    type="button"
                                    className={styles.inlineActionBtn}
                                    onClick={() =>
                                      void onRecordAoiContextSourceFeedback(
                                        source.sourceId,
                                        source.id,
                                        'wrong_source',
                                        source.evidenceRefs,
                                      )
                                    }
                                    disabled={aoiAutonomyActionId === wrongSourceActionId}
                                    title={`Mark ${source.displayNameLabel} as wrong source for future routing.`}
                                  >
                                    Wrong source
                                  </button>
                                  <button
                                    type="button"
                                    className={styles.inlineActionBtn}
                                    onClick={() =>
                                      void onRecordAoiContextSourceFeedback(
                                        source.sourceId,
                                        source.id,
                                        'wrong_timing',
                                        source.evidenceRefs,
                                      )
                                    }
                                    disabled={aoiAutonomyActionId === wrongTimingActionId}
                                    title={source.wrongTimingTitle}
                                  >
                                    Wrong timing
                                  </button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <p className={styles.modelHint}>No context source selected.</p>
                      )}
                    </div>

                    <div className={styles.aoiAutonomyProposalSection}>
                      <div className={styles.promptBudgetSectionTitle}>Workspace signals</div>
                      {aoiWorkspaceSignalSummary.visible ? (
                        <div className={styles.aoiAutonomyProposalItem}>
                          <div className={styles.aoiAutonomyProposalMeta}>
                            <span>{aoiWorkspaceSignalSummary.workspaceLabel}</span>
                            <span>branch {aoiWorkspaceSignalSummary.branchLabel}</span>
                            <span>validation {aoiWorkspaceSignalSummary.freshnessLabel}</span>
                            <span>sources {aoiWorkspaceSignalSummary.sourceLabel}</span>
                            {aoiWorkspaceSignalSummary.warningCount > 0 && (
                              <span>warnings {aoiWorkspaceSignalSummary.warningCount}</span>
                            )}
                          </div>
                          <div className={styles.aoiAutonomyProposalTitle}>
                            {aoiWorkspaceSignalSummary.dirtyLabel}
                          </div>
                          <div className={styles.aoiAutonomyProposalReason}>
                            {aoiWorkspaceSignalSummary.validationLabel}
                          </div>
                          <div className={styles.aoiAutonomyProposalDetails}>
                            <div>{aoiWorkspaceSignalSummary.recommendationLabel}</div>
                            <div>{aoiWorkspaceSignalSummary.recommendationReason}</div>
                            {aoiWorkspaceSignalSummary.changedFileLabels.map((label, index) => (
                              <div key={`workspace-file-${index}`}>{label}</div>
                            ))}
                            {aoiWorkspaceSignalSummary.evidenceRefs.map((ref, index) => (
                              <div key={`workspace-evidence-${index}`}>{ref}</div>
                            ))}
                          </div>
                        </div>
                      ) : (
                        <p className={styles.modelHint}>No workspace signal recorded.</p>
                      )}
                    </div>

                    <div className={styles.aoiAutonomyProposalSection}>
                      <div className={styles.promptBudgetSectionTitle}>Wakeup scheduler</div>
                      {aoiAutonomySchedulerSummary.visible ? (
                        <div className={styles.aoiAutonomyProposalItem}>
                          <div className={styles.aoiAutonomyProposalMeta}>
                            <span>{aoiAutonomySchedulerSummary.lastWakeupLabel}</span>
                            <span>{aoiAutonomySchedulerSummary.nextWakeupLabel}</span>
                            {aoiAutonomySchedulerSummary.budgetLabel && (
                              <span>{aoiAutonomySchedulerSummary.budgetLabel}</span>
                            )}
                          </div>
                          <div className={styles.aoiAutonomyProposalTitle}>
                            {aoiAutonomySchedulerSummary.summaryLabel}
                          </div>
                          {(aoiAutonomySchedulerSummary.skippedSourceLabels.length > 0 ||
                            aoiAutonomySchedulerSummary.warningLabels.length > 0) && (
                            <div className={styles.aoiAutonomyProposalDetails}>
                              {aoiAutonomySchedulerSummary.skippedSourceLabels.map(
                                (label, index) => (
                                  <div key={`scheduler-skip-${index}`}>{label}</div>
                                ),
                              )}
                              {aoiAutonomySchedulerSummary.warningLabels.map((label, index) => (
                                <div key={`scheduler-warning-${index}`}>{label}</div>
                              ))}
                              {aoiAutonomySchedulerSummary.evidenceRefs.map((ref, index) => (
                                <div key={`scheduler-evidence-${index}`}>{ref}</div>
                              ))}
                            </div>
                          )}
                        </div>
                      ) : (
                        <p className={styles.modelHint}>No wakeup scheduler record yet.</p>
                      )}
                    </div>

                    <div className={styles.aoiAutonomyProposalSection}>
                      <div className={styles.promptBudgetSectionTitle}>Environment sources</div>
                      {aoiEnvironmentSourceSummaries.length > 0 ? (
                        <div className={styles.aoiAutonomyProposalList}>
                          {aoiEnvironmentSourceSummaries.map((source) => (
                            <div className={styles.aoiAutonomyProposalItem} key={source.id}>
                              <div className={styles.aoiAutonomyProposalMeta}>
                                <span>{source.enabledLabel}</span>
                                <span>{source.kindLabel}</span>
                                <span>risk {source.riskLabel}</span>
                                <span>scope {source.scopeLabel}</span>
                                <span>{source.privateLabel}</span>
                              </div>
                              <div className={styles.aoiAutonomyProposalTitle}>{source.label}</div>
                              <div className={styles.aoiAutonomyProposalReason}>
                                {source.operationsLabel}
                              </div>
                              <div className={styles.aoiAutonomyProposalDetails}>
                                <div>{source.consentSummary}</div>
                                <div>{source.metadataScopeLabel}</div>
                                <div>{source.willNotReadOrDoLabel}</div>
                                <div>{source.gateReason}</div>
                                <div>{source.quietModeLabel}</div>
                                <div>Last observed: {source.lastObservedLabel}</div>
                                <div>Last reviewed: {source.lastReviewedLabel}</div>
                              </div>
                              <div className={styles.aoiAutonomyProposalActions}>
                                <button
                                  type="button"
                                  className={source.enabled ? styles.saveBtn : styles.cancelBtn}
                                  onClick={() =>
                                    void onUpdateAoiEnvironmentSource(source.id, {
                                      enabled: !source.enabled,
                                      consentReason: !source.enabled
                                        ? 'User enabled metadata-only observation in Aoi Autonomy panel.'
                                        : undefined,
                                      lastReviewedAt: !source.enabled ? Date.now() : undefined,
                                    })
                                  }
                                  disabled={
                                    !source.canToggle ||
                                    aoiAutonomyActionId === `source:${source.id}`
                                  }
                                  title={source.toggleTitle}
                                >
                                  {source.enabled ? 'Enabled' : 'Disabled'}
                                </button>
                                {source.canClear && (
                                  <button
                                    type="button"
                                    className={styles.cancelBtn}
                                    onClick={() =>
                                      void onUpdateAoiEnvironmentSource(source.id, {
                                        enabled: false,
                                        consentReason: undefined,
                                        lastObservedAt: undefined,
                                        lastReviewedAt: undefined,
                                      })
                                    }
                                    disabled={aoiAutonomyActionId === `source:${source.id}`}
                                    title={source.clearTitle}
                                  >
                                    Clear
                                  </button>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className={styles.modelHint}>
                          Environment sources will appear after autonomy state refresh.
                        </p>
                      )}
                    </div>

                    <div className={styles.aoiAutonomyProposalSection}>
                      <div className={styles.promptBudgetSectionTitle}>Current mission</div>
                      {aoiMissionPanelSummary.visible ? (
                        <div className={styles.aoiAutonomyProposalItem}>
                          <div className={styles.aoiAutonomyProposalMeta}>
                            <span>{aoiMissionPanelSummary.statusLabel}</span>
                            {aoiMissionPanelSummary.visibleState && (
                              <span>
                                state {aoiMissionPanelSummary.visibleState.replace(/_/g, ' ')}
                              </span>
                            )}
                            <span>waiting {aoiMissionPanelSummary.waitingOnLabel}</span>
                            <span>evidence {aoiMissionPanelSummary.evidenceCount}</span>
                            {aoiMissionState?.sourceRefs.goalRef && (
                              <span>
                                {sanitizeAoiProposalDisplayText(
                                  aoiMissionState.sourceRefs.goalRef,
                                  80,
                                )}
                              </span>
                            )}
                          </div>
                          <div className={styles.aoiAutonomyProposalTitle}>
                            {aoiMissionPanelSummary.focusSummary}
                          </div>
                          <div className={styles.aoiAutonomyProposalReason}>
                            {aoiMissionPanelSummary.nextActionLabel}
                          </div>
                          <div className={styles.aoiAutonomyProposalDetails}>
                            <div>{aoiMissionPanelSummary.nextActionReason}</div>
                            {aoiMissionState?.sourceRefs.proposalRef && (
                              <div>
                                Proposal:{' '}
                                {sanitizeAoiProposalDisplayText(
                                  aoiMissionState.sourceRefs.proposalRef,
                                  120,
                                )}
                              </div>
                            )}
                            {aoiMissionState?.sourceRefs.kiraWorkRef && (
                              <div>
                                Kira:{' '}
                                {sanitizeAoiProposalDisplayText(
                                  aoiMissionState.sourceRefs.kiraWorkRef,
                                  120,
                                )}
                              </div>
                            )}
                            {aoiMissionState?.sourceRefs.researchRunRef && (
                              <div>
                                Research:{' '}
                                {sanitizeAoiProposalDisplayText(
                                  aoiMissionState.sourceRefs.researchRunRef,
                                  120,
                                )}
                              </div>
                            )}
                            {aoiMissionPanelSummary.evidenceRefs.map((ref, index) => (
                              <div key={`mission-evidence-${index}`}>
                                {sanitizeAoiProposalDisplayText(ref, 220)}
                              </div>
                            ))}
                          </div>
                          <div className={styles.aoiAutonomyProposalActions}>
                            <button
                              type="button"
                              className={styles.inlineActionBtn}
                              onClick={() => void onDecideAoiMission('pause')}
                              disabled={
                                !aoiMissionPanelSummary.canPause ||
                                Boolean(aoiAutonomyActionId?.startsWith('mission:'))
                              }
                              title={aoiMissionPanelSummary.pauseTitle}
                            >
                              {aoiMissionPanelSummary.pauseLabel}
                            </button>
                            <button
                              type="button"
                              className={styles.inlineActionBtn}
                              onClick={() => void onDecideAoiMission('resume')}
                              disabled={
                                !aoiMissionPanelSummary.canResume ||
                                Boolean(aoiAutonomyActionId?.startsWith('mission:'))
                              }
                              title={aoiMissionPanelSummary.resumeTitle}
                            >
                              {aoiMissionPanelSummary.resumeLabel}
                            </button>
                            <button
                              type="button"
                              className={styles.inlineActionBtn}
                              onClick={() => void onDecideAoiMission('clear')}
                              disabled={
                                !aoiMissionPanelSummary.canClear ||
                                Boolean(aoiAutonomyActionId?.startsWith('mission:'))
                              }
                              title="Clear current mission focus"
                            >
                              Clear
                            </button>
                            <button
                              type="button"
                              className={styles.inlineActionBtn}
                              onClick={() => setExpandedAoiMissionEvidence((prev) => !prev)}
                              title={aoiMissionPanelSummary.showEvidenceTitle}
                            >
                              {expandedAoiMissionEvidence ? (
                                <ChevronDown size={14} />
                              ) : (
                                <ChevronRight size={14} />
                              )}
                              {aoiMissionPanelSummary.showEvidenceLabel}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <p className={styles.modelHint}>No active mission focus.</p>
                      )}
                    </div>

                    <div className={styles.aoiAutonomyProposalSection}>
                      <div className={styles.promptBudgetSectionTitle}>Recent feedback</div>
                      <div className={styles.promptBudgetGrid}>
                        <div className={styles.promptBudgetMetric}>
                          <span className={styles.promptBudgetLabel}>Decisions</span>
                          <strong>{aoiAutonomyEvaluation?.metrics.totalDecisions ?? 0}</strong>
                        </div>
                        <div className={styles.promptBudgetMetric}>
                          <span className={styles.promptBudgetLabel}>Acceptance</span>
                          <strong>{aoiAutonomyAcceptanceLabel}</strong>
                        </div>
                        <div className={styles.promptBudgetMetric}>
                          <span className={styles.promptBudgetLabel}>Evidence</span>
                          <strong>{aoiAutonomyEvidenceLabel}</strong>
                        </div>
                        <div className={styles.promptBudgetMetric}>
                          <span className={styles.promptBudgetLabel}>High-risk blocked</span>
                          <strong>
                            {aoiAutonomyEvaluation?.metrics.blockedHighRiskProposalCount ?? 0}
                          </strong>
                        </div>
                        <div className={styles.promptBudgetMetric}>
                          <span className={styles.promptBudgetLabel}>Noisy type</span>
                          <strong>
                            {sanitizeAoiProposalDisplayText(aoiAutonomyNoisyTypeLabel, 42)}
                          </strong>
                        </div>
                      </div>
                    </div>

                    <div className={styles.aoiAutonomyProposalSection}>
                      <div className={styles.promptBudgetSectionTitle}>Trust calibration</div>
                      {aoiTrustCalibration ? (
                        <div className={styles.aoiAutonomyProposalList}>
                          <div className={styles.aoiAutonomyProposalItem}>
                            <div className={styles.aoiAutonomyProposalMeta}>
                              <span>
                                generated{' '}
                                {new Date(aoiTrustCalibration.generatedAt).toLocaleTimeString()}
                              </span>
                              <span>suppressed {aoiTrustSuppressedCategories.length}</span>
                              <span>negative sources {aoiTrustNegativeSources.length}</span>
                              <span>resets {aoiTrustCalibration.resetCategories.length}</span>
                            </div>
                            {aoiTrustSuppressedCategories.length > 0 && (
                              <div className={styles.aoiAutonomyProposalDetails}>
                                {aoiTrustSuppressedCategories.map((item) => {
                                  const resetId = `trust-reset:${item.dimension}:${item.key}`;
                                  return (
                                    <div key={`trust-suppressed-${item.id}`}>
                                      {item.dimension.replace(/_/g, ' ')}:{' '}
                                      {sanitizeAoiProposalDisplayText(item.key, 80)}{' '}
                                      {item.delta.toFixed(2)}{' '}
                                      <button
                                        type="button"
                                        className={styles.inlineActionBtn}
                                        onClick={() =>
                                          void onResetAoiTrustCalibration(item.dimension, item.key)
                                        }
                                        disabled={aoiAutonomyActionId === resetId}
                                        title="Reset this calibration category"
                                      >
                                        Reset
                                      </button>
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                            {aoiTrustNegativeSources.length > 0 && (
                              <div className={styles.aoiAutonomyProposalDetails}>
                                {aoiTrustNegativeSources.map((source) => {
                                  const resetId = `trust-reset:source_kind:${source.sourceKind}`;
                                  return (
                                    <div key={`trust-source-${source.sourceKind}`}>
                                      source {sanitizeAoiProposalDisplayText(source.sourceKind, 80)}
                                      : penalty {source.selectionPenalty.toFixed(2)}{' '}
                                      <button
                                        type="button"
                                        className={styles.inlineActionBtn}
                                        onClick={() =>
                                          void onResetAoiTrustCalibration(
                                            'source_kind',
                                            source.sourceKind,
                                          )
                                        }
                                        disabled={aoiAutonomyActionId === resetId}
                                        title="Reset this source calibration"
                                      >
                                        Reset
                                      </button>
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                            {aoiTrustRecentChanges.length > 0 && (
                              <div className={styles.aoiAutonomyProposalDetails}>
                                {aoiTrustRecentChanges.map((item) => (
                                  <div key={`trust-change-${item.id}`}>
                                    {item.direction}: {item.dimension.replace(/_/g, ' ')}{' '}
                                    {sanitizeAoiProposalDisplayText(item.key, 80)} (
                                    {item.delta.toFixed(2)})
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      ) : (
                        <p className={styles.modelHint}>No trust calibration data yet.</p>
                      )}
                    </div>

                    {aoiAutonomyPendingFeedback && (
                      <div className={styles.aoiAutonomyPendingFeedback}>
                        <div className={styles.aoiAutonomyProposalMeta}>
                          <span>{aoiAutonomyPendingFeedback.action}</span>
                          <span>optional feedback</span>
                        </div>
                        <div className={styles.aoiAutonomyProposalTitle}>
                          {sanitizeAoiProposalDisplayText(aoiAutonomyPendingFeedback.title, 120)}
                        </div>
                        <div className={styles.aoiAutonomyFeedbackActions}>
                          {AOI_PROPOSAL_FEEDBACK_CONTROLS.map((item) => (
                            <button
                              type="button"
                              key={`pending-feedback-${item.category}`}
                              className={styles.inlineActionBtn}
                              onClick={() => void onRecordAoiProposalFeedback(item.category)}
                              disabled={aoiAutonomyActionId !== null}
                              title={item.title}
                            >
                              {item.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    <div className={styles.aoiAutonomyProposalSection}>
                      <div className={styles.promptBudgetSectionTitle}>Active goals</div>
                      {visibleAoiAutonomyGoals.length > 0 ? (
                        <div className={styles.aoiAutonomyProposalList}>
                          {visibleAoiAutonomyGoals.map((goal) => {
                            const nextStep =
                              goal.plan.steps.find((step) => step.status === 'in_progress') ??
                              goal.plan.steps.find((step) => step.status === 'pending') ??
                              null;

                            return (
                              <div className={styles.aoiAutonomyProposalItem} key={goal.id}>
                                <div className={styles.aoiAutonomyProposalMeta}>
                                  <span>{goal.status}</span>
                                  <span>{goal.owner}</span>
                                  <span>{goal.risk} risk</span>
                                  <span>conf {goal.confidence.toFixed(2)}</span>
                                  <span>sources {goal.sourceRefs.length}</span>
                                </div>
                                <div className={styles.aoiAutonomyProposalTitle}>
                                  {sanitizeAoiProposalDisplayText(goal.title, 140)}
                                </div>
                                <div className={styles.aoiAutonomyProposalReason}>
                                  {sanitizeAoiProposalDisplayText(goal.userIntentSummary, 240)}
                                </div>
                                <div className={styles.aoiAutonomyProposalDetails}>
                                  <div>
                                    Next:{' '}
                                    {nextStep
                                      ? sanitizeAoiProposalDisplayText(nextStep.title, 160)
                                      : 'No pending step'}
                                  </div>
                                  {nextStep && (
                                    <div>
                                      Gate: {nextStep.allowedActionKind} at{' '}
                                      {nextStep.requiredAutonomyLevel}
                                    </div>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <p className={styles.modelHint}>
                          No active autonomy goals are being tracked.
                        </p>
                      )}
                    </div>

                    <div className={styles.aoiAutonomyProposalSection}>
                      <div className={styles.promptBudgetSectionTitle}>Other active proposals</div>
                      {visibleAoiAutonomyProposals.length > 0 ? (
                        <div className={styles.aoiAutonomyProposalList}>
                          {visibleAoiAutonomyProposals.map((proposal) => {
                            const primaryActionAllowed = canShowAoiProposalPrimaryAction(proposal);
                            const proposalPending = Boolean(
                              aoiAutonomyActionId?.startsWith(`proposal:${proposal.id}:`),
                            );
                            const expanded = expandedAoiProposalId === proposal.id;
                            const executableAction = canExecuteAoiProposalAtCurrentLevel(
                              proposal,
                              aoiAutonomyPolicy,
                            );
                            const executionMessage = aoiAutonomyExecutionMessages[proposal.id];
                            const kiraHandoffPreviewResult = aoiKiraHandoffPreviews[proposal.id];
                            const kiraHandoffPreview =
                              getAoiKiraHandoffPreview(kiraHandoffPreviewResult);
                            const preparedActionPlan = getAoiPreparedActionPlan(
                              proposal,
                              kiraHandoffPreviewResult,
                            );
                            const actionPlanSummary = buildAoiPreparedActionPlanPanelSummary(
                              preparedActionPlan,
                              expanded,
                            );
                            const approvedCommandSummary = buildAoiApprovedCommandPanelSummary({
                              policy: getAoiApprovedCommandPolicy(
                                proposal,
                                kiraHandoffPreviewResult,
                              ),
                              result: getAoiApprovedCommandResult(kiraHandoffPreviewResult),
                              includeDetails: expanded,
                            });
                            const preferenceSummary = buildAoiPreferenceInfluencePanelSummary({
                              proposal,
                              memories: aoiMemories,
                              projectKey: aoiWorkspaceSnapshot?.workspaceLabel,
                              includeDetails: expanded,
                            });
                            const isKiraHandoff =
                              proposal.acceptAction?.kind === 'create_kira_work';
                            const recoverySummary = buildAoiRecoveryPreviewSummary(
                              proposal,
                              expanded,
                            );
                            const recoveryGoalId = getAoiProposalGoalId(proposal);
                            const inspectorSummary = buildAoiProposalInspectorSummary({
                              proposal,
                              policy: aoiAutonomyPolicy,
                              activeProposals: aoiAutonomyActiveProposals,
                              includeEvidence: expanded,
                            });
                            const actionPresentation = buildAoiProposalActionPresentation(
                              proposal,
                              {
                                hasKiraPreview: Boolean(kiraHandoffPreview),
                              },
                            );
                            const blockedSummary = buildAoiBlockedStateSummary({
                              proposal,
                              reasons: proposal.blockedReason
                                ? [proposal.blockedReason, ...inspectorSummary.policyReasons]
                                : inspectorSummary.policyReasons,
                            });
                            const proactiveExplanation = buildAoiProactiveExplanation({
                              proposal,
                              policy: aoiAutonomyPolicy,
                              activeProposals: aoiAutonomyActiveProposals,
                              includeEvidence: expanded,
                              hasKiraPreview: Boolean(kiraHandoffPreview),
                            });

                            return (
                              <div className={styles.aoiAutonomyProposalItem} key={proposal.id}>
                                <div className={styles.aoiAutonomyProposalMeta}>
                                  <span>{proposal.status}</span>
                                  <span>
                                    state {actionPresentation.visibleState.replace(/_/g, ' ')}
                                  </span>
                                  <span>{proactiveExplanation.confidenceLabel}</span>
                                  <span>{proactiveExplanation.risk} risk</span>
                                  <span>plan {actionPlanSummary.statusLabel}</span>
                                  {approvedCommandSummary.visible && (
                                    <span>command {approvedCommandSummary.statusLabel}</span>
                                  )}
                                  {preferenceSummary.visible && (
                                    <span>preferences {preferenceSummary.statusLabel}</span>
                                  )}
                                  <span>requires {proposal.requiredAutonomyLevel}</span>
                                  <span>evidence {proactiveExplanation.evidenceCount}</span>
                                </div>
                                <div className={styles.aoiAutonomyProposalTitle}>
                                  {sanitizeAoiProposalDisplayText(proposal.title, 140)}
                                </div>
                                <div className={styles.aoiAutonomyProposalReason}>
                                  {proactiveExplanation.oneLineRationale}
                                </div>
                                <div className={styles.aoiAutonomyProposalDetails}>
                                  <div>Why now: {proactiveExplanation.whyNow}</div>
                                  <div>Changed: {proactiveExplanation.whatChanged}</div>
                                  <div>Evidence: {proactiveExplanation.evidenceSummary}</div>
                                  <div>Next: {proactiveExplanation.safeNextAction}</div>
                                  <div>Boundary: {proactiveExplanation.approvalBoundary}</div>
                                </div>
                                {recoverySummary.visible && (
                                  <div className={styles.aoiAutonomyProposalDetails}>
                                    <div>Failure: {recoverySummary.failureKind}</div>
                                    <div>Cause: {recoverySummary.rootCauseSummary}</div>
                                    <div>Action: {recoverySummary.proposedActionLabel}</div>
                                    <div>Safety: {recoverySummary.whyNarrowerOrSafer}</div>
                                    <div>
                                      Retry: {recoverySummary.retryLabel} /{' '}
                                      {recoverySummary.cooldownLabel}
                                    </div>
                                    {recoverySummary.nonGoals.map((item, index) => (
                                      <div key={`${proposal.id}-non-goal-${index}`}>
                                        Non-goal: {item}
                                      </div>
                                    ))}
                                    {recoverySummary.evidenceRefs.map((ref, index) => (
                                      <div key={`${proposal.id}-recovery-evidence-${index}`}>
                                        Evidence: {sanitizeAoiProposalDisplayText(ref, 220)}
                                      </div>
                                    ))}
                                  </div>
                                )}
                                <div className={styles.aoiAutonomyProposalTools}>
                                  {proposal.suggestedTools.length > 0
                                    ? proposal.suggestedTools
                                        .slice(0, 5)
                                        .map((tool) => sanitizeAoiProposalDisplayText(tool, 64))
                                        .join(', ')
                                    : 'No suggested tools'}
                                </div>
                                {proposal.blockedReason && (
                                  <div className={styles.aoiAutonomyBlockedReason}>
                                    Blocked:{' '}
                                    {sanitizeAoiProposalDisplayText(proposal.blockedReason, 220)}
                                  </div>
                                )}
                                {actionPresentation.primaryRole !== 'none' && (
                                  <div className={styles.aoiAutonomyProposalDetails}>
                                    Action boundary:{' '}
                                    {sanitizeAoiProposalDisplayText(
                                      actionPresentation.mutationBoundary,
                                      240,
                                    )}
                                  </div>
                                )}
                                {actionPlanSummary.visible && (
                                  <div className={styles.aoiAutonomyProposalDetails}>
                                    <div>Plan: {actionPlanSummary.objective}</div>
                                    <div>
                                      Plan risk: {actionPlanSummary.riskLabel} /{' '}
                                      {actionPlanSummary.approvalLabel}
                                    </div>
                                    <div>Checkpoint: {actionPlanSummary.checkpointLabel}</div>
                                    <div>Validation: {actionPlanSummary.validationLabel}</div>
                                    <div>Rollback: {actionPlanSummary.rollbackLabel}</div>
                                    {actionPlanSummary.blockers.map((blocker, index) => (
                                      <div key={`${proposal.id}-plan-blocker-${index}`}>
                                        Plan blocked: {blocker}
                                      </div>
                                    ))}
                                    {actionPlanSummary.expectedChanges.map((item, index) => (
                                      <div key={`${proposal.id}-plan-change-${index}`}>
                                        Expected change: {item}
                                      </div>
                                    ))}
                                  </div>
                                )}
                                {approvedCommandSummary.visible && (
                                  <div className={styles.aoiAutonomyProposalDetails}>
                                    <div>Command: {approvedCommandSummary.commandLabel}</div>
                                    <div>Cwd: {approvedCommandSummary.cwdLabel}</div>
                                    <div>Command risk: {approvedCommandSummary.riskLabel}</div>
                                    <div>Command result: {approvedCommandSummary.resultLabel}</div>
                                    {approvedCommandSummary.reasonLabels.map((reason, index) => (
                                      <div key={`${proposal.id}-command-reason-${index}`}>
                                        Command reason: {reason}
                                      </div>
                                    ))}
                                  </div>
                                )}
                                {preferenceSummary.visible && (
                                  <div className={styles.aoiAutonomyProposalDetails}>
                                    {preferenceSummary.preferenceLabels.map((item, index) => (
                                      <div key={`${proposal.id}-preference-${index}`}>
                                        Preference: {item}
                                      </div>
                                    ))}
                                    {preferenceSummary.conflictLabels.map((item, index) => (
                                      <div key={`${proposal.id}-preference-conflict-${index}`}>
                                        Preference conflict: {item}
                                      </div>
                                    ))}
                                    {preferenceSummary.demotionLabels.map((item, index) => (
                                      <div key={`${proposal.id}-preference-demotion-${index}`}>
                                        Preference demotion: {item}
                                      </div>
                                    ))}
                                  </div>
                                )}
                                {proposal.risk === 'high' && (
                                  <div className={styles.aoiAutonomyBlockedReason}>
                                    High risk: execution still requires fresh explicit acceptance.
                                  </div>
                                )}
                                {proposal.acceptAction?.kind === 'start_research' &&
                                  proposal.status === 'accepted' && (
                                    <div className={styles.aoiAutonomyBlockedReason}>
                                      Approval will start a new Aoi web research run.
                                    </div>
                                  )}
                                {proposal.acceptAction?.kind === 'save_memory' &&
                                  proposal.status === 'accepted' && (
                                    <div className={styles.aoiAutonomyBlockedReason}>
                                      Approval will promote memory or create an untrusted skill
                                      draft.
                                    </div>
                                  )}
                                {isKiraHandoff && proposal.status === 'accepted' && (
                                  <div className={styles.aoiAutonomyBlockedReason}>
                                    {kiraHandoffPreview
                                      ? 'Preview is ready. Approval creates one reviewed Kira work item and does not edit files.'
                                      : 'Preview plan first. Preview does not create Kira work items or edit files.'}
                                  </div>
                                )}
                                {actionPresentation.visibleState === 'blocked' && (
                                  <div className={styles.aoiAutonomyProposalDetails}>
                                    {blockedSummary.policyReasons.length > 0 && (
                                      <div>
                                        Policy reason: {blockedSummary.policyReasons.join(' / ')}
                                      </div>
                                    )}
                                    {blockedSummary.missingEvidence.map((item, index) => (
                                      <div key={`${proposal.id}-blocked-missing-${index}`}>
                                        Missing evidence: {item}
                                      </div>
                                    ))}
                                    <div>Safe alternative: {blockedSummary.safeAlternative}</div>
                                  </div>
                                )}
                                {executionMessage && (
                                  <div className={styles.aoiAutonomyExecutionResult}>
                                    {sanitizeAoiProposalDisplayText(executionMessage, 320)}
                                  </div>
                                )}
                                {kiraHandoffPreview && (
                                  <div className={styles.aoiAutonomyProposalDetails}>
                                    <div>
                                      Kira handoff preview:{' '}
                                      {sanitizeAoiProposalDisplayText(
                                        getPreviewText(kiraHandoffPreview, 'title'),
                                        160,
                                      )}
                                    </div>
                                    <div>
                                      Objective:{' '}
                                      {sanitizeAoiProposalDisplayText(
                                        getPreviewText(kiraHandoffPreview, 'objective'),
                                        220,
                                      )}
                                    </div>
                                    <div>
                                      Scope:{' '}
                                      {getPreviewList(kiraHandoffPreview, 'scope')
                                        .map((item) => sanitizeAoiProposalDisplayText(item, 80))
                                        .join(' / ') || 'none'}
                                    </div>
                                    <div>
                                      Likely modules:{' '}
                                      {getPreviewList(kiraHandoffPreview, 'likelyFilesOrModules')
                                        .map((item) => sanitizeAoiProposalDisplayText(item, 80))
                                        .join(' / ') || 'none'}
                                    </div>
                                    <div>
                                      Validation:{' '}
                                      {getPreviewList(kiraHandoffPreview, 'validationCommands')
                                        .slice(0, 3)
                                        .map((item) => sanitizeAoiProposalDisplayText(item, 120))
                                        .join(' / ') || 'none'}
                                    </div>
                                    <div>
                                      Evidence refs:{' '}
                                      {getPreviewList(kiraHandoffPreview, 'evidenceRefs').length}
                                    </div>
                                  </div>
                                )}
                                {expanded && (
                                  <div className={styles.aoiAutonomyProposalDetails}>
                                    <div>Title: {inspectorSummary.title}</div>
                                    {proactiveExplanation.details.map((detail, index) => (
                                      <div key={`${proposal.id}-explanation-${index}`}>
                                        {detail}
                                      </div>
                                    ))}
                                    <div>
                                      Message summary: {proactiveExplanation.messageSummary}
                                    </div>
                                    <div>Reason: {inspectorSummary.reason}</div>
                                    <div>
                                      Confidence: {inspectorSummary.confidence.toFixed(2)} / Risk:{' '}
                                      {inspectorSummary.risk} / Required:{' '}
                                      {inspectorSummary.requiredAutonomyLevel}
                                    </div>
                                    <div>Suggested action: {inspectorSummary.suggestedAction}</div>
                                    {actionPlanSummary.affectedSurfaces.map((surface, index) => (
                                      <div key={`${proposal.id}-plan-surface-${index}`}>
                                        Affected surface: {surface}
                                      </div>
                                    ))}
                                    {actionPlanSummary.validationCommands.map((command, index) => (
                                      <div key={`${proposal.id}-plan-validation-${index}`}>
                                        Validation command: {command}
                                      </div>
                                    ))}
                                    {actionPlanSummary.rollbackInstructions.map(
                                      (instruction, index) => (
                                        <div key={`${proposal.id}-plan-rollback-${index}`}>
                                          Rollback: {instruction}
                                        </div>
                                      ),
                                    )}
                                    {actionPlanSummary.nonGoals.map((item, index) => (
                                      <div key={`${proposal.id}-plan-nongoal-${index}`}>
                                        Non-goal: {item}
                                      </div>
                                    ))}
                                    {approvedCommandSummary.stdoutExcerpt && (
                                      <div>Stdout: {approvedCommandSummary.stdoutExcerpt}</div>
                                    )}
                                    {approvedCommandSummary.stderrExcerpt && (
                                      <div>Stderr: {approvedCommandSummary.stderrExcerpt}</div>
                                    )}
                                    {approvedCommandSummary.outputTruncated && (
                                      <div>Output: truncated</div>
                                    )}
                                    {approvedCommandSummary.evidenceRefs.map((ref, index) => (
                                      <div key={`${proposal.id}-command-evidence-${index}`}>
                                        Command evidence: {ref}
                                      </div>
                                    ))}
                                    {preferenceSummary.sourceRefs.map((ref, index) => (
                                      <div key={`${proposal.id}-preference-evidence-${index}`}>
                                        Preference evidence: {ref}
                                      </div>
                                    ))}
                                    <div>
                                      Policy:{' '}
                                      {inspectorSummary.policyAllowed ? 'allowed' : 'blocked'}{' '}
                                      {inspectorSummary.policyReasons.length > 0
                                        ? inspectorSummary.policyReasons
                                            .map((reason) =>
                                              sanitizeAoiProposalDisplayText(reason, 96),
                                            )
                                            .join(' / ')
                                        : 'no blocking reason'}
                                    </div>
                                    <div>Safe alternative: {inspectorSummary.safeAlternative}</div>
                                    <div>
                                      Trigger:{' '}
                                      {sanitizeAoiProposalDisplayText(proposal.trigger, 220)}
                                    </div>
                                    <div>
                                      Cooldown key:{' '}
                                      {sanitizeAoiProposalDisplayText(proposal.cooldownKey, 160)}
                                    </div>
                                    <div>
                                      Evidence refs: {inspectorSummary.evidenceRefs.length} shown /{' '}
                                      {proposal.evidenceRefs.length} total
                                    </div>
                                    {proactiveExplanation.evidenceRefs.map((ref, index) => (
                                      <div key={`${proposal.id}-evidence-${index}`}>{ref}</div>
                                    ))}
                                    {proposal.riskSignals.slice(0, 5).map((signal, index) => (
                                      <div key={`${proposal.id}-risk-${index}`}>
                                        Risk: {sanitizeAoiProposalDisplayText(signal, 220)}
                                      </div>
                                    ))}
                                  </div>
                                )}
                                <div className={styles.aoiAutonomyProposalActions}>
                                  {primaryActionAllowed && proposal.status === 'active' ? (
                                    <button
                                      type="button"
                                      className={styles.inlineActionBtn}
                                      onClick={() =>
                                        void onDecideAoiProposal(proposal.id, 'accept')
                                      }
                                      disabled={proposalPending}
                                      title={actionPresentation.primaryTitle}
                                    >
                                      {recoverySummary.visible
                                        ? 'Approve exact recovery'
                                        : actionPresentation.primaryLabel}
                                    </button>
                                  ) : executableAction ? (
                                    <button
                                      type="button"
                                      className={styles.inlineActionBtn}
                                      onClick={() =>
                                        isKiraHandoff && !kiraHandoffPreview
                                          ? void onPrepareAoiKiraHandoff(proposal)
                                          : void onExecuteAoiProposal(proposal)
                                      }
                                      disabled={proposalPending}
                                      title={actionPresentation.primaryTitle}
                                    >
                                      {actionPresentation.primaryLabel}
                                    </button>
                                  ) : (
                                    <span className={styles.modelHint}>
                                      {proposal.blockedReason
                                        ? 'Blocked by policy.'
                                        : `No primary action while status is ${proposal.status}.`}
                                    </span>
                                  )}
                                  <button
                                    type="button"
                                    className={styles.inlineActionBtn}
                                    onClick={() => void onDecideAoiProposal(proposal.id, 'snooze')}
                                    disabled={proposalPending || proposal.status !== 'active'}
                                    title={`Pause this proposal family by cooldown key: ${sanitizeAoiProposalDisplayText(
                                      proposal.cooldownKey,
                                      120,
                                    )}`}
                                  >
                                    Pause suggestion family
                                  </button>
                                  <button
                                    type="button"
                                    className={styles.inlineActionBtn}
                                    onClick={() => void onDecideAoiProposal(proposal.id, 'dismiss')}
                                    disabled={proposalPending || proposal.status !== 'active'}
                                    title="Dismiss this suggestion and remember why for future calibration"
                                  >
                                    Dismiss and remember why
                                  </button>
                                  <button
                                    type="button"
                                    className={styles.inlineActionBtn}
                                    onClick={() =>
                                      void onDecideAoiProposal(
                                        proposal.id,
                                        'snooze',
                                        'too_frequent',
                                      )
                                    }
                                    disabled={proposalPending || proposal.status !== 'active'}
                                    title="Stop showing this suggestion type for this session window"
                                  >
                                    Stop showing this type
                                  </button>
                                  {recoverySummary.visible && proposal.status === 'active' && (
                                    <button
                                      type="button"
                                      className={styles.inlineActionBtn}
                                      onClick={() =>
                                        setExpandedAoiProposalId((prev) =>
                                          prev === proposal.id ? prev : proposal.id,
                                        )
                                      }
                                      disabled={proposalPending}
                                      title="Ask Aoi to explain evidence before approval"
                                    >
                                      Explain evidence
                                    </button>
                                  )}
                                  {recoverySummary.visible &&
                                    recoveryGoalId &&
                                    proposal.status === 'active' && (
                                      <button
                                        type="button"
                                        className={styles.inlineActionBtn}
                                        onClick={() => void onPauseAoiGoalForRecovery(proposal)}
                                        disabled={proposalPending}
                                        title="Pause this goal while keeping evidence and source references"
                                      >
                                        Pause this goal
                                      </button>
                                    )}
                                  <button
                                    type="button"
                                    className={styles.inlineActionBtn}
                                    onClick={() =>
                                      setExpandedAoiProposalId((prev) =>
                                        prev === proposal.id ? null : proposal.id,
                                      )
                                    }
                                    title="Show proposal evidence and policy details"
                                  >
                                    {expanded ? (
                                      <ChevronDown size={14} />
                                    ) : (
                                      <ChevronRight size={14} />
                                    )}
                                    Show evidence
                                  </button>
                                </div>
                                {proposal.status === 'active' && (
                                  <div className={styles.aoiAutonomyFeedbackActions}>
                                    {AOI_PROPOSAL_FEEDBACK_CONTROLS.map((item) => (
                                      <button
                                        type="button"
                                        key={`${proposal.id}-${item.category}`}
                                        className={styles.inlineActionBtn}
                                        onClick={() =>
                                          void onDecideAoiProposal(
                                            proposal.id,
                                            item.action,
                                            item.category,
                                          )
                                        }
                                        disabled={proposalPending}
                                        title={item.title}
                                      >
                                        {item.label}
                                      </button>
                                    ))}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <p className={styles.modelHint}>
                          No other active autonomy proposals are available for this session.
                        </p>
                      )}
                    </div>

                    {aoiAutonomyBlockedProposals.length > 0 && (
                      <div className={styles.aoiAutonomyProposalSection}>
                        <div className={styles.promptBudgetSectionTitle}>Blocked in last check</div>
                        <div className={styles.aoiAutonomyProposalList}>
                          {aoiAutonomyBlockedProposals.slice(0, 4).map((proposal) => {
                            const blockedSummary = buildAoiBlockedStateSummary({
                              blockedProposal: proposal,
                            });
                            const blockedExplanation = buildAoiBlockedProactiveExplanation({
                              blockedProposal: proposal,
                              includeEvidence: true,
                            });

                            return (
                              <div
                                className={styles.aoiAutonomyProposalItem}
                                key={proposal.proposalId}
                              >
                                <div className={styles.aoiAutonomyProposalTitle}>
                                  {sanitizeAoiProposalDisplayText(proposal.title, 140)}
                                </div>
                                <div className={styles.aoiAutonomyBlockedReason}>
                                  {blockedExplanation.oneLineRationale}
                                </div>
                                <div className={styles.aoiAutonomyProposalMeta}>
                                  <span>state blocked</span>
                                  <span>{proposal.actionKind ?? 'no action'}</span>
                                  <span>{blockedExplanation.risk} risk</span>
                                  <span>
                                    requires {proposal.requiredAutonomyLevel ?? 'unknown'}
                                  </span>
                                  <span>
                                    approval{' '}
                                    {proposal.requiresUserApproval ? 'required' : 'not required'}
                                  </span>
                                  <span>evidence {proposal.evidenceRefs.length}</span>
                                  <span>No tool execution available</span>
                                </div>
                                <div className={styles.aoiAutonomyProposalDetails}>
                                  <div>Why now: {blockedExplanation.whyNow}</div>
                                  <div>Changed: {blockedExplanation.whatChanged}</div>
                                  <div>Evidence: {blockedExplanation.evidenceSummary}</div>
                                  <div>Next: {blockedExplanation.safeNextAction}</div>
                                  <div>Boundary: {blockedExplanation.approvalBoundary}</div>
                                  {blockedSummary.missingEvidence.map((item, index) => (
                                    <div key={`${proposal.proposalId}-missing-${index}`}>
                                      Missing evidence: {item}
                                    </div>
                                  ))}
                                  {blockedExplanation.evidenceRefs.map((ref, index) => (
                                    <div key={`${proposal.proposalId}-evidence-${index}`}>
                                      Evidence: {ref}
                                    </div>
                                  ))}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>

              <div className={styles.settingsSectionCard} data-testid="aoi-memory-inspector">
                <div className={styles.settingsSectionHeader}>
                  <div>
                    <div className={styles.settingsSectionTitle}>Aoi Memory Inspector</div>
                    <span className={styles.modelHint}>
                      Durable memories selected from Aoi chat turns and manual memory saves.
                    </span>
                  </div>
                  <button
                    type="button"
                    className={styles.inlineActionBtn}
                    onClick={onRefreshAoiMemories}
                    title="Refresh Aoi memories"
                  >
                    <RotateCcw size={14} />
                    Refresh
                  </button>
                </div>

                <div className={styles.promptBudgetGrid}>
                  <div className={styles.promptBudgetMetric}>
                    <span className={styles.promptBudgetLabel}>Active</span>
                    <strong>{aoiMemoryOverview.activeCount}</strong>
                  </div>
                  <div className={styles.promptBudgetMetric}>
                    <span className={styles.promptBudgetLabel}>Prompt eligible</span>
                    <strong>{aoiMemoryOverview.promptEligibleCount}</strong>
                  </div>
                  <div className={styles.promptBudgetMetric}>
                    <span className={styles.promptBudgetLabel}>Permanent</span>
                    <strong>{aoiMemoryOverview.permanentCount}</strong>
                  </div>
                  <div className={styles.promptBudgetMetric}>
                    <span className={styles.promptBudgetLabel}>Archived</span>
                    <strong>{aoiMemoryOverview.archivedCount}</strong>
                  </div>
                  <div className={styles.promptBudgetMetric}>
                    <span className={styles.promptBudgetLabel}>Superseded</span>
                    <strong>{aoiMemoryOverview.supersededCount}</strong>
                  </div>
                </div>

                {visibleAoiMemories.length > 0 ? (
                  <div className={styles.aoiMemoryList}>
                    {visibleAoiMemories.map((memory) => (
                      <div className={styles.aoiMemoryItem} key={memory.id}>
                        <div className={styles.aoiMemoryMain}>
                          <div className={styles.aoiMemoryMeta}>
                            <span>{memory.scope}</span>
                            <span>{memory.type}</span>
                            <span>{memory.status}</span>
                            {memory.permanent ? <span>permanent</span> : null}
                            <span>conf {memory.confidence.toFixed(2)}</span>
                            <span>hits {memory.hits}</span>
                          </div>
                          <div className={styles.aoiMemoryContent}>
                            {sanitizeAoiProposalDisplayText(memory.content, 260)}
                          </div>
                          <div className={styles.aoiMemoryFooter}>
                            <span>{new Date(memory.updatedAt).toLocaleString()}</span>
                            {memory.tags.length > 0 ? (
                              <span>{memory.tags.slice(0, 4).join(', ')}</span>
                            ) : null}
                          </div>
                        </div>
                        <div className={styles.aoiMemoryActions}>
                          <button
                            type="button"
                            className={styles.iconActionBtn}
                            onClick={() =>
                              void handleAoiMemoryAction(memory.id, onSaveAoiPreference)
                            }
                            disabled={
                              memory.permanent ||
                              memory.status === 'archived' ||
                              pendingAoiMemoryActionId === memory.id
                            }
                            title="Save as durable preference"
                          >
                            <Plus size={14} />
                          </button>
                          <button
                            type="button"
                            className={styles.iconActionBtn}
                            onClick={() =>
                              void handleAoiMemoryAction(memory.id, onMarkAoiMemoryTemporary)
                            }
                            disabled={
                              memory.status === 'archived' || pendingAoiMemoryActionId === memory.id
                            }
                            title="Mark temporary for this session"
                          >
                            <RotateCcw size={14} />
                          </button>
                          <button
                            type="button"
                            className={styles.iconActionBtn}
                            onClick={() => void handleAoiMemoryAction(memory.id, onDemoteAoiMemory)}
                            disabled={
                              memory.status !== 'active' || pendingAoiMemoryActionId === memory.id
                            }
                            title="Demote preference"
                          >
                            <Minus size={14} />
                          </button>
                          <button
                            type="button"
                            className={styles.iconActionBtn}
                            onClick={() =>
                              void handleAoiMemoryAction(memory.id, onArchiveAoiMemory)
                            }
                            disabled={
                              memory.status === 'archived' || pendingAoiMemoryActionId === memory.id
                            }
                            title="Archive memory"
                          >
                            <Archive size={14} />
                          </button>
                          <button
                            type="button"
                            className={styles.iconActionBtn}
                            onClick={() => void handleAoiMemoryAction(memory.id, onDeleteAoiMemory)}
                            disabled={pendingAoiMemoryActionId === memory.id}
                            title="Delete memory"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className={styles.modelHint}>
                    No durable Aoi memories have been stored yet. Send a few meaningful chat turns
                    or use save_memory.
                  </p>
                )}
              </div>

              <div className={styles.settingsSectionCard}>
                <div className={styles.settingsSectionHeader}>
                  <div>
                    <div className={styles.settingsSectionTitle}>Tavily Web Search</div>
                    <span className={styles.modelHint}>
                      Enables Aoi's search_web tool for current web information.
                    </span>
                  </div>
                  <span className={styles.modelHint}>
                    {tavilyApiKey.trim() ? 'Configured' : 'Disabled'}
                  </span>
                </div>

                <div className={styles.field}>
                  <label className={styles.label}>API Key</label>
                  <input
                    className={styles.fieldInput}
                    type="password"
                    value={tavilyApiKey}
                    onChange={(e) => setTavilyApiKey(e.target.value)}
                    placeholder="tvly-YOUR_API_KEY"
                    data-testid="tavily-api-key-input"
                  />
                </div>

                <div className={styles.field}>
                  <label className={styles.label}>Search endpoint</label>
                  <input
                    className={styles.fieldInput}
                    value={tavilyBaseUrl}
                    onChange={(e) => setTavilyBaseUrl(e.target.value)}
                    placeholder={DEFAULT_TAVILY_BASE_URL}
                    data-testid="tavily-base-url-input"
                  />
                  <span className={styles.modelHint}>
                    Leave as the default unless you are routing Tavily through a compatible proxy.
                  </span>
                </div>
              </div>

              <div className={styles.settingsSectionCard}>
                <div className={styles.settingsSectionTitle}>PE Analyst / IDA MCP</div>
                <div className={styles.field}>
                  <label className={styles.label}>Mode</label>
                  <select
                    className={styles.select}
                    value={idaPeMode}
                    onChange={(e) => setIdaPeMode(e.target.value as 'prescan-only' | 'mcp-http')}
                  >
                    <option value="prescan-only">Pre-scan only</option>
                    <option value="mcp-http">HTTP MCP backend</option>
                  </select>
                  <span className={styles.modelHint}>
                    `Pre-scan only` uses the built-in PE triage. `HTTP MCP backend` expects an MCP
                    server reachable by URL.
                  </span>
                </div>

                <div className={styles.field}>
                  <label className={styles.label}>Backend URL</label>
                  <input
                    className={styles.fieldInput}
                    value={idaPeBackendUrl}
                    onChange={(e) => setIdaPeBackendUrl(e.target.value)}
                    placeholder="http://127.0.0.1:17300/"
                  />
                  <span className={styles.modelHint}>
                    Supports `ida-headless-mcp` root endpoints and `ida_pro_mcp` plugin endpoints
                    such as `http://127.0.0.1:13337/mcp`.
                  </span>
                </div>
              </div>

              <div className={styles.settingsSectionCard}>
                <div className={styles.settingsSectionTitle}>Prompt Budget Inspector</div>
                <div className={styles.promptBudgetCard}>
                  <div className={styles.promptBudgetGrid}>
                    <div className={styles.promptBudgetMetric}>
                      <span className={styles.promptBudgetLabel}>Recent samples</span>
                      <strong>{promptBudgetEntries.length}</strong>
                    </div>
                    <div className={styles.promptBudgetMetric}>
                      <span className={styles.promptBudgetLabel}>Dialog turns</span>
                      <strong>
                        {promptBudgetOverview.dialogTurnCount} /{' '}
                        {promptBudgetOverview.recentTurnCount}
                      </strong>
                    </div>
                    <div className={styles.promptBudgetMetric}>
                      <span className={styles.promptBudgetLabel}>Main turns</span>
                      <strong>
                        {promptBudgetOverview.mainTurnCount} /{' '}
                        {promptBudgetOverview.recentTurnCount}
                      </strong>
                    </div>
                    <div className={styles.promptBudgetMetric}>
                      <span className={styles.promptBudgetLabel}>Avg tokens</span>
                      <strong>{promptBudgetOverview.averageEstimatedTokens}</strong>
                    </div>
                    <div className={styles.promptBudgetMetric}>
                      <span className={styles.promptBudgetLabel}>Avg system chars</span>
                      <strong>{promptBudgetOverview.averageSystemPromptChars}</strong>
                    </div>
                    <div className={styles.promptBudgetMetric}>
                      <span className={styles.promptBudgetLabel}>Avg history chars</span>
                      <strong>{promptBudgetOverview.averageRecentHistoryChars}</strong>
                    </div>
                    <div className={styles.promptBudgetMetric}>
                      <span className={styles.promptBudgetLabel}>Avg tool schema chars</span>
                      <strong>{promptBudgetOverview.averageToolSchemaChars}</strong>
                    </div>
                  </div>

                  <div className={styles.promptBudgetSection}>
                    <span className={styles.promptBudgetSectionTitle}>Top cost drivers</span>
                    {promptBudgetOverview.topCostDrivers.length > 0 ? (
                      <ul className={styles.promptBudgetList}>
                        {promptBudgetOverview.topCostDrivers.map((driver) => (
                          <li key={driver.label}>
                            <span>{driver.label}</span>
                            <strong>{driver.averageChars} chars</strong>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className={styles.modelHint}>
                        Send a few messages to populate prompt budget data.
                      </p>
                    )}
                  </div>

                  {promptBudgetEntries.length > 0 && (
                    <div className={styles.promptBudgetSection}>
                      <span className={styles.promptBudgetSectionTitle}>
                        Recent request snapshots
                      </span>
                      <div className={styles.promptBudgetLog}>
                        {promptBudgetEntries
                          .slice()
                          .reverse()
                          .map((entry) => (
                            <div
                              key={`${entry.label}-${entry.iteration ?? 'seed'}-${entry.createdAt}`}
                            >
                              <strong>
                                {entry.label}
                                {entry.iteration ? ` #${entry.iteration}` : ''}
                              </strong>
                              <span>
                                {' '}
                                [{entry.modelRoute === 'dialog' ? 'dialogLlm' : 'main'}]
                                {entry.modelId ? ` ${entry.modelId}` : ''}
                              </span>
                              <span>
                                {' '}
                                {entry.snapshot.estimatedTokens} tokens · sys{' '}
                                {entry.snapshot.systemPromptChars} · hist{' '}
                                {entry.snapshot.recentHistoryChars} · tools{' '}
                                {entry.snapshot.toolSchemaChars}
                              </span>
                            </div>
                          ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              <div className={styles.settingsSectionCard} data-testid="aoi-run-ledger">
                <div className={styles.settingsSectionTitle}>Aoi Run Ledger</div>
                <div className={styles.promptBudgetCard}>
                  <div className={styles.promptBudgetGrid}>
                    <div className={styles.promptBudgetMetric}>
                      <span className={styles.promptBudgetLabel}>Runs</span>
                      <strong>{runLedgerSummary.total}</strong>
                    </div>
                    <div className={styles.promptBudgetMetric}>
                      <span className={styles.promptBudgetLabel}>Running</span>
                      <strong>{runLedgerSummary.running}</strong>
                    </div>
                    <div className={styles.promptBudgetMetric}>
                      <span className={styles.promptBudgetLabel}>Completed</span>
                      <strong>{runLedgerSummary.completed}</strong>
                    </div>
                    <div className={styles.promptBudgetMetric}>
                      <span className={styles.promptBudgetLabel}>Failed</span>
                      <strong>{runLedgerSummary.failed}</strong>
                    </div>
                    <div className={styles.promptBudgetMetric}>
                      <span className={styles.promptBudgetLabel}>Tool calls</span>
                      <strong>{runLedgerSummary.totalToolCalls}</strong>
                    </div>
                  </div>

                  {recentRunLedgerEntries.length > 0 ? (
                    <div className={styles.promptBudgetLog}>
                      {recentRunLedgerEntries.map((entry) => (
                        <div key={entry.id}>
                          <strong>
                            {entry.status} · {entry.goal.summary}
                          </strong>
                          <span>
                            {' '}
                            [{entry.modelRoute}
                            {entry.modelId ? ` ${entry.modelId}` : ''}]
                          </span>
                          <span>
                            {' '}
                            iter {entry.metrics.iterations} · tools {entry.metrics.toolCallCount} ·{' '}
                            {new Date(entry.updatedAt).toLocaleTimeString()}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className={styles.modelHint}>
                      Send a message to record Aoi's current goal, model iterations, tool calls, and
                      final delivery status.
                    </p>
                  )}
                </div>
              </div>

              <div className={styles.settingsSectionCard} data-testid="aoi-skills-workshop">
                <div className={styles.settingsSectionTitle}>Aoi Skills Workshop</div>
                <div className={styles.promptBudgetCard}>
                  <div className={styles.promptBudgetGrid}>
                    <div className={styles.promptBudgetMetric}>
                      <span className={styles.promptBudgetLabel}>Skills</span>
                      <strong>{skillsWorkshopSummary.total}</strong>
                    </div>
                    <div className={styles.promptBudgetMetric}>
                      <span className={styles.promptBudgetLabel}>Enabled</span>
                      <strong>{skillsWorkshopSummary.enabled}</strong>
                    </div>
                    <div className={styles.promptBudgetMetric}>
                      <span className={styles.promptBudgetLabel}>Trusted</span>
                      <strong>{skillsWorkshopSummary.trusted}</strong>
                    </div>
                    <div className={styles.promptBudgetMetric}>
                      <span className={styles.promptBudgetLabel}>Built-in</span>
                      <strong>{skillsWorkshopSummary.builtIn}</strong>
                    </div>
                    <div className={styles.promptBudgetMetric}>
                      <span className={styles.promptBudgetLabel}>User</span>
                      <strong>{skillsWorkshopSummary.user}</strong>
                    </div>
                  </div>

                  <div className={styles.promptBudgetSection}>
                    <span className={styles.promptBudgetSectionTitle}>Registered Skills</span>
                    <div className={styles.promptBudgetLog}>
                      {visibleAoiSkills.map((skill) => (
                        <div key={skill.id}>
                          <strong>{skill.name}</strong>
                          <span>
                            {' '}
                            [{skill.source}
                            {skill.triggerTerms.length
                              ? ` · ${skill.triggerTerms.slice(0, 4).join(', ')}`
                              : ''}
                            ]
                          </span>
                          <span> {skill.description}</span>
                          <div>
                            <button
                              type="button"
                              className={skill.enabled ? styles.saveBtn : styles.cancelBtn}
                              onClick={() =>
                                updateAoiSkillDraft(skill.id, { enabled: !skill.enabled })
                              }
                            >
                              {skill.enabled ? 'Enabled' : 'Disabled'}
                            </button>
                            <button
                              type="button"
                              className={skill.trusted ? styles.saveBtn : styles.cancelBtn}
                              onClick={() =>
                                updateAoiSkillDraft(skill.id, { trusted: !skill.trusted })
                              }
                              disabled={skill.source === 'built-in'}
                            >
                              {skill.trusted ? 'Trusted' : 'Untrusted'}
                            </button>
                            {skill.source === 'user' && (
                              <button
                                type="button"
                                className={styles.cancelBtn}
                                onClick={() => deleteAoiSkillDraft(skill.id)}
                              >
                                Delete
                              </button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className={styles.promptBudgetSection}>
                    <span className={styles.promptBudgetSectionTitle}>Add User Skill</span>
                    <div className={styles.field}>
                      <label className={styles.label}>Name</label>
                      <input
                        className={styles.fieldInput}
                        value={newAoiSkillName}
                        onChange={(event) => setNewAoiSkillName(event.target.value)}
                        placeholder="Code Review Guard"
                      />
                    </div>
                    <div className={styles.field}>
                      <label className={styles.label}>Triggers</label>
                      <input
                        className={styles.fieldInput}
                        value={newAoiSkillTriggers}
                        onChange={(event) => setNewAoiSkillTriggers(event.target.value)}
                        placeholder="review, 검토, audit"
                      />
                    </div>
                    <div className={styles.field}>
                      <label className={styles.label}>Instructions</label>
                      <textarea
                        className={styles.fieldInput}
                        value={newAoiSkillBody}
                        onChange={(event) => setNewAoiSkillBody(event.target.value)}
                        rows={4}
                        placeholder="When this skill matches, apply these instructions..."
                      />
                    </div>
                    <button
                      type="button"
                      className={styles.saveBtn}
                      onClick={addAoiSkillDraft}
                      disabled={!newAoiSkillName.trim() || !newAoiSkillBody.trim()}
                    >
                      Add Skill
                    </button>
                  </div>
                </div>
              </div>

              <div className={styles.settingsSectionCard} data-testid="aoi-mcp-plugin-admin">
                <div className={styles.settingsSectionTitle}>MCP / Plugin Admin</div>
                <div className={styles.promptBudgetCard}>
                  <div className={styles.promptBudgetGrid}>
                    <div className={styles.promptBudgetMetric}>
                      <span className={styles.promptBudgetLabel}>Entries</span>
                      <strong>{mcpPluginSummary.total}</strong>
                    </div>
                    <div className={styles.promptBudgetMetric}>
                      <span className={styles.promptBudgetLabel}>Enabled</span>
                      <strong>{mcpPluginSummary.enabled}</strong>
                    </div>
                    <div className={styles.promptBudgetMetric}>
                      <span className={styles.promptBudgetLabel}>Trusted</span>
                      <strong>{mcpPluginSummary.trusted}</strong>
                    </div>
                    <div className={styles.promptBudgetMetric}>
                      <span className={styles.promptBudgetLabel}>Healthy</span>
                      <strong>{mcpPluginSummary.healthy}</strong>
                    </div>
                    <div className={styles.promptBudgetMetric}>
                      <span className={styles.promptBudgetLabel}>Errors</span>
                      <strong>{mcpPluginSummary.errors}</strong>
                    </div>
                  </div>

                  <div className={styles.promptBudgetSection}>
                    <span className={styles.promptBudgetSectionTitle}>Registered Integrations</span>
                    <div className={styles.promptBudgetLog}>
                      {visibleMcpPlugins.map((entry) => (
                        <div key={entry.id}>
                          <strong>{entry.name}</strong>
                          <span>
                            {' '}
                            [{entry.kind} · {entry.healthStatus}]
                          </span>
                          <span> {entry.description}</span>
                          <span> {entry.endpointUrl || 'no endpoint configured'}</span>
                          {entry.healthMessage && <span> · {entry.healthMessage}</span>}
                          <div>
                            <button
                              type="button"
                              className={entry.enabled ? styles.saveBtn : styles.cancelBtn}
                              onClick={() =>
                                updateAoiMcpPluginDraft(entry.id, { enabled: !entry.enabled })
                              }
                            >
                              {entry.enabled ? 'Enabled' : 'Disabled'}
                            </button>
                            <button
                              type="button"
                              className={entry.trusted ? styles.saveBtn : styles.cancelBtn}
                              onClick={() =>
                                updateAoiMcpPluginDraft(entry.id, { trusted: !entry.trusted })
                              }
                              disabled={isAoiMcpPluginTrustLocked(entry)}
                            >
                              {entry.trusted ? 'Trusted' : 'Untrusted'}
                            </button>
                            <button
                              type="button"
                              className={styles.cancelBtn}
                              onClick={() => void checkAoiMcpPluginDraft(entry)}
                            >
                              Check
                            </button>
                            {entry.source === 'user' && (
                              <button
                                type="button"
                                className={styles.cancelBtn}
                                onClick={() => deleteAoiMcpPluginDraft(entry.id)}
                              >
                                Delete
                              </button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className={styles.promptBudgetSection}>
                    <span className={styles.promptBudgetSectionTitle}>Add Integration</span>
                    <div className={styles.field}>
                      <label className={styles.label}>Name</label>
                      <input
                        className={styles.fieldInput}
                        value={newAoiMcpName}
                        onChange={(event) => setNewAoiMcpName(event.target.value)}
                        placeholder="Local MCP Gateway"
                      />
                    </div>
                    <div className={styles.field}>
                      <label className={styles.label}>Kind</label>
                      <select
                        className={styles.select}
                        value={newAoiMcpKind}
                        onChange={(event) =>
                          setNewAoiMcpKind(event.target.value as AoiMcpPluginKind)
                        }
                      >
                        <option value="mcp-server">MCP server</option>
                        <option value="plugin">Plugin</option>
                        <option value="connector">Connector</option>
                      </select>
                    </div>
                    <div className={styles.field}>
                      <label className={styles.label}>Endpoint URL</label>
                      <input
                        className={styles.fieldInput}
                        value={newAoiMcpUrl}
                        onChange={(event) => setNewAoiMcpUrl(event.target.value)}
                        placeholder="http://127.0.0.1:7331/mcp"
                      />
                    </div>
                    <button
                      type="button"
                      className={styles.saveBtn}
                      onClick={addAoiMcpPluginDraft}
                      disabled={!newAoiMcpName.trim() || !newAoiMcpUrl.trim()}
                    >
                      Add Integration
                    </button>
                  </div>
                </div>
              </div>

              <div className={styles.settingsSectionCard} data-testid="tool-inspector">
                <div className={styles.settingsSectionTitle}>Tool Inspector</div>
                <div className={styles.promptBudgetCard}>
                  <div className={styles.promptBudgetSection}>
                    <span className={styles.promptBudgetSectionTitle}>Safety Policy</span>
                    <div className={styles.promptBudgetGrid}>
                      <div className={styles.promptBudgetMetric}>
                        <span className={styles.promptBudgetLabel}>Auto verify fixes</span>
                        <button
                          type="button"
                          className={autoVerifyFixes ? styles.saveBtn : styles.cancelBtn}
                          onClick={() => setAutoVerifyFixes((prev) => !prev)}
                        >
                          {autoVerifyFixes ? 'On' : 'Off'}
                        </button>
                      </div>
                      <div className={styles.promptBudgetMetric}>
                        <span className={styles.promptBudgetLabel}>Workspace commands</span>
                        <button
                          type="button"
                          className={allowWorkspaceCommands ? styles.saveBtn : styles.cancelBtn}
                          onClick={() => setAllowWorkspaceCommands((prev) => !prev)}
                        >
                          {allowWorkspaceCommands ? 'On' : 'Off'}
                        </button>
                      </div>
                      <div className={styles.promptBudgetMetric}>
                        <span className={styles.promptBudgetLabel}>Semantic refactors</span>
                        <button
                          type="button"
                          className={allowSemanticRefactors ? styles.saveBtn : styles.cancelBtn}
                          onClick={() => setAllowSemanticRefactors((prev) => !prev)}
                        >
                          {allowSemanticRefactors ? 'On' : 'Off'}
                        </button>
                      </div>
                      <div className={styles.promptBudgetMetric}>
                        <span className={styles.promptBudgetLabel}>Background watches</span>
                        <button
                          type="button"
                          className={allowBackgroundWatches ? styles.saveBtn : styles.cancelBtn}
                          onClick={() => setAllowBackgroundWatches((prev) => !prev)}
                        >
                          {allowBackgroundWatches ? 'On' : 'Off'}
                        </button>
                      </div>
                      <div className={styles.promptBudgetMetric}>
                        <span className={styles.promptBudgetLabel}>Preview before mutation</span>
                        <button
                          type="button"
                          className={
                            requirePreviewBeforeMutation ? styles.saveBtn : styles.cancelBtn
                          }
                          onClick={() => setRequirePreviewBeforeMutation((prev) => !prev)}
                        >
                          {requirePreviewBeforeMutation ? 'On' : 'Off'}
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className={styles.promptBudgetSection}>
                    <span className={styles.promptBudgetSectionTitle}>Capability Registry</span>
                    <div className={styles.promptBudgetGrid}>
                      <div className={styles.promptBudgetMetric}>
                        <span className={styles.promptBudgetLabel}>Registered</span>
                        <strong>
                          {capabilitySummary.registered} / {capabilitySummary.total}
                        </strong>
                      </div>
                      <div className={styles.promptBudgetMetric}>
                        <span className={styles.promptBudgetLabel}>High risk</span>
                        <strong>{capabilitySummary.byRisk.high}</strong>
                      </div>
                      <div className={styles.promptBudgetMetric}>
                        <span className={styles.promptBudgetLabel}>Write / execute</span>
                        <strong>{capabilitySummary.writeOrExecute}</strong>
                      </div>
                      <div className={styles.promptBudgetMetric}>
                        <span className={styles.promptBudgetLabel}>Network / external</span>
                        <strong>{capabilitySummary.external}</strong>
                      </div>
                      <div className={styles.promptBudgetMetric}>
                        <span className={styles.promptBudgetLabel}>Parallel safe</span>
                        <strong>{capabilitySummary.parallelSafe}</strong>
                      </div>
                      <div className={styles.promptBudgetMetric}>
                        <span className={styles.promptBudgetLabel}>Cacheable</span>
                        <strong>{capabilitySummary.cacheable}</strong>
                      </div>
                    </div>

                    <ul className={styles.promptBudgetList}>
                      {capabilitySummary.bySurface.map((item) => (
                        <li key={item.surface}>
                          <span>{item.surface}</span>
                          <strong>{item.count}</strong>
                        </li>
                      ))}
                    </ul>

                    {capabilityRows.length > 0 ? (
                      <div className={styles.promptBudgetLog}>
                        {capabilityRows.map((row) => (
                          <div key={row.name}>
                            <strong>{row.name}</strong>
                            <span>
                              {' '}
                              [{row.surface} / {row.risk}]
                            </span>
                            <span> {row.description}</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className={styles.modelHint}>
                        Every exposed capability is registered with a risk and surface label.
                      </p>
                    )}
                  </div>

                  <div className={styles.promptBudgetSection}>
                    <span className={styles.promptBudgetSectionTitle}>Recent Tool Activity</span>
                    {recentToolActivity.length > 0 ? (
                      <div className={styles.promptBudgetLog} data-testid="recent-tool-activity">
                        {recentToolActivity.map((item, index) => (
                          <div key={`${item}-${index}`}>{item}</div>
                        ))}
                      </div>
                    ) : (
                      <p className={styles.modelHint}>No tool activity has been recorded yet.</p>
                    )}
                  </div>

                  <div className={styles.promptBudgetSection}>
                    <span className={styles.promptBudgetSectionTitle}>Recent Mutations</span>
                    {recentMutations.length > 0 ? (
                      <ul className={styles.promptBudgetList}>
                        {recentMutations.map((mutation) => (
                          <li key={mutation.id}>
                            <span>{mutation.tool_name}</span>
                            <strong>{mutation.file_path}</strong>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className={styles.modelHint}>
                        No reversible file mutations in this session yet.
                      </p>
                    )}
                  </div>

                  <div className={styles.promptBudgetSection}>
                    <span className={styles.promptBudgetSectionTitle}>
                      Active Background Watches
                    </span>
                    {activeBackgroundWatches.length > 0 ? (
                      <ul className={styles.promptBudgetList}>
                        {activeBackgroundWatches.map((watch) => (
                          <li key={watch.id}>
                            <span>{watch.label}</span>
                            <strong>
                              {watch.scope}:{watch.directory}
                            </strong>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className={styles.modelHint}>No background watches are active.</p>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className={styles.settingsActions}>
          <button className={styles.dangerBtn} onClick={onResetAll}>
            Reset Session Chat
          </button>
          <button className={styles.cancelBtn} onClick={onClose}>
            Cancel
          </button>
          <button
            className={styles.saveBtn}
            onClick={() => {
              const mainIsLoginCli = isLoginCliProvider(provider);
              const mainIsCodexAuth = isCodexAuthProvider(provider);
              const dialogIsLoginCli = isLoginCliProvider(dialogProvider);
              const dialogIsCodexAuth = isCodexAuthProvider(dialogProvider);
              const mainUsesCredentialFields = !mainIsLoginCli && !mainIsCodexAuth;
              const dialogUsesCredentialFields = !dialogIsLoginCli && !dialogIsCodexAuth;
              const mainDefaultCommand = getDefaultCliCommand(provider);
              const dialogDefaultCommand = getDefaultCliCommand(dialogProvider);
              const mainParallelToolCalls = parallelToolCallsOptionToConfig(parallelToolCalls);
              const dialogParallelToolCallsValue =
                parallelToolCallsOptionToConfig(dialogParallelToolCalls);
              const llmCfg: LLMConfig = {
                provider,
                apiKey: mainUsesCredentialFields ? apiKey : '',
                baseUrl: mainUsesCredentialFields ? baseUrl.trim() : '',
                model,
                ...(mainIsLoginCli && command.trim() && command.trim() !== mainDefaultCommand
                  ? { command: command.trim() }
                  : {}),
                ...(mainUsesCredentialFields && apiStyle ? { apiStyle } : {}),
                ...(mainUsesCredentialFields && customHeaders.trim() ? { customHeaders } : {}),
                ...(reasoningEffort ? { reasoningEffort } : {}),
                ...(reasoningSummary ? { reasoningSummary } : {}),
                ...(verbosity ? { verbosity } : {}),
                ...(serviceTier.trim() ? { serviceTier: serviceTier.trim() } : {}),
                ...(mainParallelToolCalls !== undefined
                  ? { parallelToolCalls: mainParallelToolCalls }
                  : {}),
              };
              const igCfg: ImageGenConfig | null = igApiKey.trim()
                ? {
                    provider: igProvider,
                    apiKey: igApiKey,
                    baseUrl: igBaseUrl,
                    model: igModel,
                    ...(igCustomHeaders.trim() ? { customHeaders: igCustomHeaders } : {}),
                  }
                : null;
              const dialogCfg: DialogLlmConfig | null =
                dialogEnabled &&
                dialogModel.trim() &&
                (dialogIsLoginCli || dialogIsCodexAuth || dialogBaseUrl.trim())
                  ? {
                      provider: dialogProvider,
                      model: dialogModel.trim(),
                      baseUrl: dialogUsesCredentialFields ? dialogBaseUrl.trim() : '',
                      ...(dialogIsLoginCli &&
                      dialogCommand.trim() &&
                      dialogCommand.trim() !== dialogDefaultCommand
                        ? { command: dialogCommand.trim() }
                        : {}),
                      ...(dialogUsesCredentialFields && dialogApiKey.trim()
                        ? { apiKey: dialogApiKey.trim() }
                        : {}),
                      ...(dialogUsesCredentialFields && dialogApiStyle
                        ? { apiStyle: dialogApiStyle }
                        : {}),
                      ...(dialogUsesCredentialFields && dialogCustomHeaders.trim()
                        ? { customHeaders: dialogCustomHeaders }
                        : {}),
                      ...(dialogReasoningEffort ? { reasoningEffort: dialogReasoningEffort } : {}),
                      ...(dialogReasoningSummary
                        ? { reasoningSummary: dialogReasoningSummary }
                        : {}),
                      ...(dialogVerbosity ? { verbosity: dialogVerbosity } : {}),
                      ...(dialogServiceTier.trim()
                        ? { serviceTier: dialogServiceTier.trim() }
                        : {}),
                      ...(dialogParallelToolCallsValue !== undefined
                        ? { parallelToolCalls: dialogParallelToolCallsValue }
                        : {}),
                    }
                  : null;
              const nextIdaPeConfig: IdaPeConfig | null = {
                mode: idaPeMode,
                ...(idaPeBackendUrl.trim() ? { backendUrl: idaPeBackendUrl.trim() } : {}),
              };
              const normalizedPreferredName = normalizeUserProfileDisplayName(preferredName);
              const nextUserProfile: UserProfileConfig | null = normalizedPreferredName
                ? { displayName: normalizedPreferredName }
                : null;
              const nextConversationPreferences: ConversationPreferencesConfig = {
                responseLanguageMode: normalizeResponseLanguageMode(responseLanguageMode),
                ttsEnabled,
                ttsPreloadCommonPhrases,
                operatorVoicePolicy: normalizeAoiOperatorVoicePolicy(operatorVoicePolicy),
              };
              const nextKiraProjectDefaults: NonNullable<KiraConfig['projectDefaults']> = {
                ...(kiraConfig?.projectDefaults ?? {}),
                autoCommit: kiraAutoCommit,
              };
              if (kiraRequiredInstructions.trim()) {
                nextKiraProjectDefaults.requiredInstructions = kiraRequiredInstructions.trim();
              } else {
                delete nextKiraProjectDefaults.requiredInstructions;
              }
              const nextKiraConfig: KiraConfig = {
                ...(kiraWorkRootDirectory.trim()
                  ? { workRootDirectory: kiraWorkRootDirectory.trim() }
                  : {}),
                workers: kiraWorkers.slice(0, 3).map(kiraDraftToConfig),
                reviewerLlm: kiraDraftToConfig(kiraReviewer),
                projectDefaults: nextKiraProjectDefaults,
              };
              const nextTavilyConfig: TavilyConfig | null = tavilyApiKey.trim()
                ? {
                    apiKey: tavilyApiKey.trim(),
                    baseUrl: tavilyBaseUrl.trim() || DEFAULT_TAVILY_BASE_URL,
                  }
                : null;
              onSave(
                llmCfg,
                igCfg,
                dialogCfg,
                nextIdaPeConfig,
                nextKiraConfig,
                nextUserProfile,
                nextConversationPreferences,
                {
                  autoVerifyFixes,
                  allowWorkspaceCommands,
                  allowSemanticRefactors,
                  allowBackgroundWatches,
                  requirePreviewBeforeMutation,
                },
                aoiSkillDrafts,
                aoiMcpPluginDrafts,
                nextTavilyConfig,
              );
            }}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
};

export default ChatPanel;
