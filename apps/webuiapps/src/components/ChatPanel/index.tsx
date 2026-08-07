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
  loadPendingIdleMusicOffer,
  loadPendingNewsOffer,
  loadPendingPreferencePoll,
  loadPendingTastePoll,
  savePendingIdleMusicOffer,
  savePendingNewsOffer,
  savePendingPreferencePoll,
  savePendingTastePoll,
  type PendingIdleMusicOffer,
  type PendingNewsOffer,
  type PendingPreferencePoll,
  type PendingTastePoll,
} from '@/lib/aoiPendingOffers';
import {
  buildAoiMusicRecommendation,
  type AoiMusicMood,
  type AoiMusicQuerySource,
} from '@/lib/aoiMusicRecommendation';
import {
  DEFAULT_AOI_MUSIC_TASTE_STATE,
  buildAoiMusicTasteNeedPreferenceCopy,
  buildAoiMusicTastePromptBlock,
  buildAoiMusicTasteRecommendCopy,
  deriveTasteProfile,
  hydrateAoiMusicStateFromCloud,
  loadAoiIdleMusicLearningState,
  loadAoiMusicTasteState,
  parseAoiMusicPreferenceSeed,
  parseAoiMusicTasteChatIntent,
  pickNextTasteQuestion,
  planIdleMusicNudge,
  recordTasteAnswer,
  recordTasteQuestionAsked,
  recordYouTubePlay,
  recordYouTubeSearch,
  saveAoiIdleMusicLearningState,
  saveAoiMusicTasteState,
  shouldAskTasteQuestion,
  type AoiMusicTasteState,
  type AoiTasteLang,
} from '@/lib/aoiMusicTaste';
import {
  PREFERENCE_POLL_QUESTIONS,
  countUnansweredPreferenceQuestions,
  loadAoiPreferencePollState,
  pickNextPreferenceQuestion,
  recordPreferenceQuestionAsked,
  resolvePreferencePollAnswer,
  saveAoiPreferencePollState,
  shouldAskPreferenceQuestion,
  type AoiPreferenceLang,
} from '@/lib/aoiPreferencePoll';
import {
  GENERATED_EXPANSION_COOLDOWN_MS,
  GENERATED_EXPANSION_LOW_WATERMARK,
  expandAoiPreferenceQuestionBank,
  generatedQuestionsToSeedShape,
  loadAoiGeneratedQuestionsState,
  saveAoiGeneratedQuestionsState,
} from '@/lib/aoiPreferenceQuestionGen';
import {
  DEFAULT_AOI_IDLE_MUSIC_STATE,
  recordIdleMusicOffered,
  recordIdleMusicOutcome,
  type AoiIdleMusicLearningState,
} from '@/lib/aoiIdleMusicNudge';
import {
  DEFAULT_AOI_NEWS_STATE,
  pickInterestingArticle,
  recordNewsOffered,
  recordNewsOutcome,
  shouldOfferNewsNudge,
  type AoiNewsLearningState,
} from '@/lib/aoiNewsNudge';
import { loadCyberNewsCandidates } from '@/pages/CyberNews/aoiNewsFeed';
import {
  LLM_REASONING_EFFORTS,
  LLM_REASONING_SUMMARIES,
  LLM_VERBOSITIES,
  PROVIDER_MODELS,
  getDefaultProviderConfig,
  getModelInfo,
  getProviderDisplayName,
  getSupportedReasoningEfforts,
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
import { parseAppActionToolParamsWithValidation } from '@/lib/appActionParams';
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
  loadAoiRecentMemoryEpisodes,
  markAoiMemoryTemporary,
  saveAoiManualMemory,
  saveAoiPreferenceMemory,
  shouldTreatAoiMemoryAsPermanent,
  syncAoiMemoryFromPreferencePoll,
  syncAoiMemoryFromTurn,
  type AoiMemoryEntry,
  type AoiMemoryEpisode,
  type AoiMemoryEpisodeSource,
  type AoiMemoryType,
} from '@/lib/aoiMemoryManager';
import {
  createAoiEmbeddingProviderFromConfig,
  embedAoiQuery,
  type AoiEmbeddingProvider,
} from '@/lib/aoiMemoryEmbedding';
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
  executeAppIntentTool,
  getAppIntentToolDefinitions,
  getAppIntentToolPendingSummary,
  isAppIntentTool,
} from '@/lib/appIntentTools';
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
import {
  executeHostProcessTool,
  getHostProcessToolDefinitions,
  getHostProcessToolPendingSummary,
  isHostProcessTool,
} from '@/lib/aoiHostProcessTools';
import {
  executeHostBrowserTool,
  getHostBrowserToolDefinitions,
  getHostBrowserToolPendingSummary,
  isHostBrowserTool,
} from '@/lib/aoiHostBrowserTools';
import {
  executeBrowserDriveTool,
  getBrowserDriveToolDefinitions,
  getBrowserDriveToolPendingSummary,
  isBrowserDriveTool,
} from '@/lib/aoiBrowserDriveTools';
import {
  executeBrowserDriveActTool,
  getBrowserDriveActToolDefinitions,
  getBrowserDriveActToolPendingSummary,
  isBrowserDriveActTool,
} from '@/lib/aoiBrowserDriveActTools';
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
  decideAoiCapabilityBrokerAuthority,
  formatAoiCapabilityBrokerDecisionLine,
  getAoiCapabilityRows,
  summarizeAoiCapabilityRegistry,
  type AoiCapabilityBrokerDecision,
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
  buildAoiFileTaskContractPrompt,
  buildAoiFileTaskCorrectionPrompt,
  buildAoiFileTaskFailureMessage,
  createAoiFileTaskEvidence,
  getAoiFileReadBack,
  observeAoiFileTaskToolResult,
  resolveAoiFileTaskContract,
  verifyAoiFileTaskContract,
  type AoiFileTaskVerification,
} from '@/lib/aoiFileTaskContract';
import {
  buildAoiOutcomeFeedbackContractPrompt,
  buildAoiOutcomeFeedbackCorrectionPrompt,
  buildAoiOutcomeFeedbackFailureMessage,
  buildAoiOutcomeFeedbackSuccessMessage,
  getAoiOutcomeFeedbackToolDefinition,
  parseAoiOutcomeFeedbackContract,
  toAoiOutcomeFeedbackEvidence,
  verifyAoiOutcomeFeedbackCompletion,
  type AoiOutcomeFeedbackEvidence,
} from '@/lib/aoiOutcomeFeedback';
import { classifyAoiToolResult } from '@/lib/aoiToolResultOutcome';
import {
  buildAoiLiveFieldTruthPrompt,
  buildAoiLiveFieldTruthUnavailablePrompt,
  loadAoiLiveFieldTruth,
  shouldLoadAoiLiveFieldTruth,
  verifyAoiLiveFieldArtifactFacts,
} from '@/lib/aoiLiveFieldTruthPrompt';
import type { AoiNonVoiceJarvisScorecard } from '@/lib/aoiNonVoiceJarvisScorecard';
import {
  decideAoiGoal,
  decideAoiMission,
  decideAoiProposal,
  executeAoiProposalAction,
  fetchAoiAppOperationDispatches,
  fetchAoiAutonomyDashboard,
  fetchAoiProposalDecisions,
  fetchAoiStrategicBrief,
  reportAoiAppOperationDispatchResult,
  fetchAoiContextRouter,
  fetchAoiMissionState,
  previewAoiProposalAction,
  recordAoiContextSourceFeedback,
  recordAoiFieldFeedback,
  recordAoiOperatorFlightDecision,
  recordAoiOperatorOutcomeFeedback,
  recordAoiOperatorVoiceDecision,
  recordAoiOutcomeSignal,
  recordAoiProactiveBriefFeedback,
  recordAoiActivityEvent,
  reportAoiRelationshipArcCompleted,
  reportAoiRelationshipSessionOpen,
  type AoiRelationshipSessionOpenRetrospective,
  reportAoiRelationshipSessionSummary,
  reportAoiRelationshipThreadAsked,
  recordAoiProactiveTrendDeliveryEvent,
  recordAoiProposalFeedback,
  resetAoiProactiveBriefCooldown,
  resetAoiTrustCalibrationCategory,
  runAoiAutonomyManualWakeup,
  runAoiAutonomySessionOpenWakeup,
  runAoiProactiveBriefScoutNow,
  updateAoiEnvironmentSource,
  updateAoiAutonomyPolicy,
  type AoiAutonomyProposalPreviewResult,
  type AoiAutonomyProposalExecutionResult,
  type AoiFieldFeedbackResponse,
  type AoiProactiveBriefListResponse,
} from '@/lib/aoiAutonomyClient';
import {
  buildAoiDirectChatDismissedSignal,
  buildAoiProposalIgnoredSignal,
  buildAoiProposalOpenedSignal,
  createAoiOutcomeJunctureTracker,
} from '@/lib/aoiOutcomeSignalJunctures';
import {
  isAoiActivityCaptureConsented,
  mapAoiUserActionToActivityCapture,
} from '@/lib/aoiActivityCapture';
import {
  AOI_AUTONOMY_UI_LEVELS,
  appendAoiAgendaNudgeDecisionFeedbackHistory,
  buildAoiAgendaChatFollowUpContext,
  buildAoiAgendaChatFollowUpResponse,
  buildAoiAgendaNudgeFeedbackResetPatch,
  buildAoiAgendaNudgeDeliveryDecisionAudit,
  buildAoiAgendaNudgeDecisionFeedbackAudit,
  buildAoiAgendaNudgeReadinessActionAudit,
  buildAoiAgendaNudgeCalibrationPanelSummary,
  buildAoiAgendaNudgeReadinessPanelSummary,
  buildAoiAutonomyAgendaPanelSummary,
  buildAoiBlockedStateSummary,
  buildAoiBlockedProactiveExplanation,
  buildAoiGoalWorkOrderPreviews,
  buildAoiStrategicBriefPanel,
  buildAoiAutonomySchedulerPanelSummary,
  buildAoiAutonomyNotificationBadge,
  buildAoiOpportunityInboxPanelSummary,
  buildAoiDeliberationRunPanelSummary,
  buildAoiContextSourcePanelSummaries,
  buildAoiEnvironmentSourcePanelSummaries,
  buildAoiMissionPanelSummary,
  buildAoiMissionResumePrompt,
  buildAoiOperatorAcceptanceDashboard,
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
  isAoiGoalCandidateProposal,
  loadAoiAutonomyPanelSettings,
  recordAoiAgendaNudgeFeedback,
  sanitizeAoiProposalDisplayText,
  saveAoiAutonomyPanelSettings,
  selectAoiAgendaChatNudge,
  selectAoiInlineProposal,
  summarizeAoiAutonomyProposalCounts,
  type AoiAgendaChatFollowUpContext,
  type AoiAgendaChatNudge,
  type AoiAgendaNudgeDecisionFeedbackActionId,
  type AoiAgendaNudgeReadinessActionId,
  type AoiAutonomyPanelSettings,
  type AoiOperatorFeedbackInboxPanelItem,
} from '@/lib/aoiAutonomyUi';
import {
  AOI_AUTONOMY_MODES,
  aoiAutonomyModeHostCapabilities,
  aoiAutonomyModeLabel,
  applyAoiAutonomyModeToPanel,
  applyAoiAutonomyModeToPolicy,
  inferAoiAutonomyMode,
  type AoiAutonomyMode,
} from '@/lib/aoiAutonomyMode';
import { setAoiHostBridgeKillSwitch } from '@/lib/aoiHostBridgeClient';
import {
  buildAoiHostBridgeLinkedSourcePatch,
  getAoiHostBridgeConsentLink,
} from '@/lib/aoiHostBridgeConsent';
import {
  aoiCardChromeLabel,
  aoiCardEvidenceLabel,
  aoiCardFeedbackLabel,
  aoiCardFeedbackTitle,
  aoiCardRiskLabel,
  normalizeAoiCardLang,
  type AoiCardLang,
} from '@/lib/aoiAutonomyCardI18n';
import {
  buildAoiCompanionMilestoneNote,
  buildAoiCompanionMoodNote,
  buildAoiCompanionRetrospectiveNote,
  buildAoiCompanionSelfInquiryNote,
  buildAoiCompanionSessionGreeting,
  buildAoiCompanionThreadFollowUp,
} from '@/lib/aoiCompanionVoice';
import {
  selectAoiRelationshipThreadTitles,
  selectAoiRelationshipThreadToRaise,
} from '@/lib/aoiRelationshipThreads';
import { shouldAoiMoodBeVoiced, type AoiMoodState } from '@/lib/aoiMoodState';
import { buildAoiPersonaBridgeBlock } from '@/lib/aoiPersonaBridge';
import {
  buildAoiSelfInquirySourcesFromMemories,
  buildAoiSelfProfile,
  buildAoiSelfProfilePromptBlock,
  findAoiSharedInterests,
  selectAoiSelfInquiryToShare,
} from '@/lib/aoiSelfProfile';
import {
  DEFAULT_AOI_SELF_OBSERVATION_STATE,
  normalizeAoiSelfObservationState,
  recordAoiSelfObservationOffered,
  shouldSubstituteAoiSelfObservation,
  type AoiSelfObservationState,
} from '@/lib/aoiSelfObservationNudge';
// Type-only: the relationship store touches node fs, so the client reads it
// exclusively over the routes (a value import would break the client bundle).
import type { AoiRelationshipMilestone, AoiRelationshipState } from '@/lib/aoiRelationshipState';
import { fetchVibeInfo, getVibeInfo, useVibeInfo } from '@/lib/vibeInfo';
import type { AoiShadowDecisionLabel } from '@/lib/aoiShadowModeEvaluation';
import { buildAoiOperatorDigest } from '@/lib/aoiOperatorDigest';
import {
  buildAoiProactiveBriefPanelModel,
  type AoiProactiveBriefPanelModel,
} from '@/lib/aoiProactiveBriefUi';
import {
  buildAoiProactiveTrendFollowUpContext,
  buildAoiProactiveTrendFollowUpPromptBlock,
  buildAoiProactiveTrendSourceListText,
  buildAoiProactiveTrendSourceOpenUnavailableText,
  classifyAoiProactiveTrendFollowUpFeedback,
  selectAoiProactiveTrendSourcesToList,
  selectAoiProactiveTrendSourcesToOpen,
  shouldListAoiProactiveTrendSourcesFromPrompt,
  shouldOpenAoiProactiveTrendSourcesFromPrompt,
  type AoiProactiveTrendFollowUpContext,
  type AoiProactiveTrendFollowUpSource,
} from '@/lib/aoiProactiveTrendFollowUp';
import {
  appendAoiJarvisAutonomyGovernorAuditTrail,
  buildAoiJarvisAutonomyGovernorAuditEvent,
  buildAoiJarvisAutonomyGovernorAuditPanelSummary,
  buildAoiJarvisAutonomyGovernorAuditResetAudit,
  buildAoiJarvisAutonomyGovernorPromptBlock,
  buildAoiJarvisAutonomyGovernor,
  buildAoiJarvisAutonomyGovernorPanelSummary,
  buildAoiJarvisAutonomyGovernorRequestRoutingSummary,
  canAoiJarvisAutonomyUseCapability,
  type AoiJarvisAutonomyGovernorDecision,
} from '@/lib/aoiJarvisAutonomyGovernor';
import {
  compareAoiAutonomyLevel,
  getAoiApprovedAppActionPolicyForProposal,
  isAoiToolAllowedAtLevel,
} from '@/lib/aoiAutonomyPolicy';
import { deriveAoiApprovedAppActionDispatchTarget } from '@/lib/aoiApprovedAppActionPolicy';
import { runAoiAppOperationDispatchBridge } from '@/lib/aoiAppOperationDispatchBridge';
import {
  useAoiDurableDispatchBridge,
  AOI_DURABLE_DISPATCH_BRIDGE_INTERVAL_MS,
} from '@/lib/useAoiDurableDispatchBridge';
import { buildAoiJarvisReadinessScorecard } from '@/lib/aoiJarvisReadinessScorecard';
import { buildAoiMissionControlState } from '@/lib/aoiMissionControlRuntime';
import { buildAoiSourceFreshnessContracts } from '@/lib/aoiSourceFreshnessContract';
import type {
  AoiAutonomyBlockedProposal,
  AoiCalibrationDimension,
  AoiAutonomyLevel,
  AoiAutonomyPolicy,
  AoiAutonomySchedulerState,
  AoiAutonomyStatus,
  AoiContextRouterResult,
  AoiDeliberationRun,
  AoiEnvironmentSource,
  AoiEnvironmentSourceRegistry,
  AoiGoal,
  AoiMissionDecisionAction,
  AoiMissionState,
  AoiOpportunity,
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
  AoiProactiveBriefFeedback,
  AoiProactiveBriefFeedbackCategory,
  AoiProactiveTrendAdvisorState,
  AoiProactiveTrendDeliveryEventKind,
  AoiProactiveTrendOpinionCard,
  AoiStrategicBrief,
  AoiVoiceRenderDecision,
  AoiWorkspaceSnapshot,
} from '@/lib/aoiAutonomyTypes';
import type { AoiBoundedWorkOrder } from '@/lib/aoiBoundedWorkOrder';
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
  buildAoiRegisteredSkillToolsCatalog,
  buildAoiSkillsPrompt,
  createUserAoiWorkshopSkill,
  loadAoiSkillsWorkshop,
  removeAoiWorkshopSkill,
  resolveAoiActiveSkills,
  resolveAoiRegisteredSkillTools,
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
  normalizeAoiEmbeddingConfig,
  saveAoiEmbeddingConfig,
  saveAoiMcpConnectorsConfig,
  saveConversationPreferences,
  saveUserProfileConfig,
  AOI_EMBEDDING_DEFAULT_BASE_URL,
  AOI_EMBEDDING_DEFAULT_MODEL,
  type AoiEmbeddingConfig,
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
  type AppSettingsAdvancedSection,
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
  formatChatErrorNotice,
  planConversationRestore,
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
import type { AoiMcpConnectorsConfig } from '@/lib/aoiMcpConnectorRegistry';
import { buildAoiUndeliveredConversationFailureMessage } from '@/lib/aoiConversationFailure';
import {
  createAoiToolLoopGuardState,
  observeAoiToolLoopBatch,
  type AoiToolLoopGuardState,
} from '@/lib/aoiToolLoopGuard';
import CharacterPanel from './CharacterPanel';
import ModPanel from './ModPanel';
import { AoiMcpConnectorsSettings } from './AoiMcpConnectorsSettings';
import { AoiMemoryDecayPanel } from './AoiMemoryDecayPanel';
import { AoiNonVoiceScorecardPanel } from './AoiNonVoiceScorecardPanel';
import { AoiOperatorSnapshotPanel } from './AoiOperatorSnapshotPanel';
import { AoiSituationPanel } from './AoiSituationPanel';
import { AoiRelationshipHistoryPanel } from './AoiRelationshipHistoryPanel';
import { AoiReadinessAccrualPanel } from './AoiReadinessAccrualPanel';
import { AoiPreferenceDashboard } from './AoiPreferenceDashboard';
import { AoiReplayPromotionPanel } from './AoiReplayPromotionPanel';
import { AoiHostBridgeSettingsPanel } from './AoiHostBridgeSettingsPanel';
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
  aoiTrendFollowUpContext?: AoiProactiveTrendFollowUpContext | null;
}

const MAX_PROMPT_BUDGET_ENTRIES = 10;
const DEFAULT_CONVERSATION_ITERATION_LIMIT = 10;
const CONFIRMED_FILE_TASK_RECOVERY_ITERATIONS = 6;
const CONFIRMED_FILE_TASK_MAX_ITERATIONS = 20;
const FILE_TASK_POST_MUTATION_COMPLETION_ITERATIONS = 2;

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
const CYBERNEWS_APP_ID = 14;
const cyberNewsFileApi = createAppFileApi('cyberNews');
const BROWSER_APP_ID = 17;

function buildOpenUrlAction(url: string): {
  app_id: number;
  action_type: string;
  params: { url: string };
} {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const isYoutube =
      host === 'youtu.be' ||
      host === 'youtube.com' ||
      host === 'www.youtube.com' ||
      host === 'm.youtube.com';
    if (isYoutube) {
      return {
        app_id: YOUTUBE_APP_ID,
        action_type: 'OPEN_VIDEO',
        params: { url },
      };
    }
  } catch {
    // Fall through to Browser. BrowserReader normalizes user-facing URL input.
  }
  return {
    app_id: BROWSER_APP_ID,
    action_type: 'OPEN_URL',
    params: { url },
  };
}

function buildAoiTrendSourceOpenAck(params: {
  context: AoiProactiveTrendFollowUpContext;
  source: AoiProactiveTrendFollowUpSource;
  result: string;
}): string {
  const sourceTitle = params.source.title || params.source.host || params.source.url;
  const sourceIndex = params.context.sources.findIndex(
    (source) => source.url === params.source.url,
  );
  const sourceLabel = sourceIndex >= 0 ? `${sourceIndex + 1}번째` : '선택한';
  const opened = params.result && !params.result.toLowerCase().startsWith('error:');
  if (!opened) {
    return [
      `꿀보, "${params.context.title}" 근거 URL을 Browser로 열려고 했는데 아직 완료되지 않았어.`,
      `대상: ${sourceLabel} 근거 - ${sourceTitle}`,
      `URL: ${params.source.url}`,
      `결과: ${params.result || 'no result'}`,
    ].join('\n');
  }
  const extraCount = Math.max(0, params.context.sources.length - 1);
  return [
    `꿀보, "${params.context.title}"의 ${sourceLabel} 근거를 Browser에서 열었어.`,
    `Source: ${sourceTitle}`,
    `URL: ${params.source.url}`,
    extraCount > 0 ? `추가 저장 근거 ${extraCount}개는 follow-up context에 같이 남겨뒀어.` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function buildAoiTrendSourcesOpenAck(params: {
  context: AoiProactiveTrendFollowUpContext;
  results: Array<{
    source: AoiProactiveTrendFollowUpSource;
    result: string;
  }>;
}): string {
  if (params.results.length === 1) {
    const [entry] = params.results;
    if (!entry) {
      return `꿀보, "${params.context.title}"에 열 수 있는 저장 근거 URL이 없어.`;
    }
    return buildAoiTrendSourceOpenAck({
      context: params.context,
      source: entry.source,
      result: entry.result,
    });
  }

  const openedCount = params.results.filter(
    (entry) => entry.result && !entry.result.toLowerCase().startsWith('error:'),
  ).length;
  const lines = [
    `꿀보, "${params.context.title}"의 저장 근거 ${params.results.length}개를 인앱 링크 액션으로 순서대로 전달했어.`,
    `성공: ${openedCount}개 / 실패: ${params.results.length - openedCount}개`,
  ];

  for (const entry of params.results) {
    const sourceTitle = entry.source.title || entry.source.host || entry.source.url;
    const sourceIndex = params.context.sources.findIndex(
      (source) => source.url === entry.source.url,
    );
    const sourceLabel = sourceIndex >= 0 ? `${sourceIndex + 1}번째` : '선택한';
    const opened = entry.result && !entry.result.toLowerCase().startsWith('error:');
    lines.push(
      `${sourceLabel} 근거: ${opened ? 'opened' : 'failed'} - ${sourceTitle}`,
      `URL: ${entry.source.url}`,
    );
    if (!opened) {
      lines.push(`결과: ${entry.result || 'no result'}`);
    }
  }

  return lines.join('\n');
}

// Run a low-priority background task once the browser is idle. Used to keep the
// mount-time autonomy/kira burst OUT of the critical page-load window: firing ~20
// data requests while the app is still loading its module graph starves the dev
// server's connection pool and delays first paint. Falls back to a short timeout
// where requestIdleCallback is unavailable (older browsers, jsdom/happy-dom).
function scheduleIdle(callback: () => void): () => void {
  if (typeof window === 'undefined') {
    return () => {};
  }
  const win = window as Window & {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    cancelIdleCallback?: (handle: number) => void;
  };
  if (typeof win.requestIdleCallback === 'function') {
    const handle = win.requestIdleCallback(callback, { timeout: 3000 });
    return () => win.cancelIdleCallback?.(handle);
  }
  const timer = window.setTimeout(callback, 800);
  return () => window.clearTimeout(timer);
}

// Background poller requests must not pin a dev-server connection indefinitely
// when the endpoint (or a backing daemon) is slow or wedged.
const KIRA_FETCH_TIMEOUT_MS = 15000;

async function triggerKiraAutomationScan(sessionPath: string): Promise<void> {
  await fetch('/api/kira-automation/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionPath }),
    signal: AbortSignal.timeout(KIRA_FETCH_TIMEOUT_MS),
  });
}

async function drainKiraAutomationEvents(sessionPath: string): Promise<KiraAutomationEvent[]> {
  const res = await fetch(
    `/api/kira-automation/events?sessionPath=${encodeURIComponent(sessionPath)}`,
    { signal: AbortSignal.timeout(KIRA_FETCH_TIMEOUT_MS) },
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

function formatAoiStatusCounts(counts: Partial<Record<string, number>> | null | undefined): string {
  const entries = Object.entries(counts ?? {})
    .filter(([, count]) => typeof count === 'number' && Number.isFinite(count) && count > 0)
    .sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) {
    return 'none';
  }
  return entries.map(([label, count]) => `${label} ${count}`).join(', ');
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
  if (actionKind) {
    tools.add(actionKind);
  }
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
  {
    label: 'Never again',
    title: 'Dismiss this suggestion permanently so it is never proposed again',
    action: 'dismiss',
    category: 'never_again',
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

// An assistant bubble with no text, no attachments, and no image renders as a
// blank box. Such a message can only come from a stale cached transcript (an
// older build that persisted an empty-content message) or a bad emit; suppress
// it so the chat never shows an empty bubble. User/tool messages and any message
// carrying an attachment or image are always kept.
function isEmptyAssistantBubble(msg: CharacterDisplayMessage): boolean {
  if (msg.role !== 'assistant') {
    return false;
  }
  const hasText =
    typeof msg.content === 'string' ? msg.content.trim().length > 0 : Boolean(msg.content);
  const hasAttachment = Array.isArray(msg.attachments) && msg.attachments.length > 0;
  return !hasText && !hasAttachment && !msg.imageUrl;
}

// Language for the Aoi proactive card. Proactive cards can appear before the
// user has typed anything -- in this app "Korean" then comes only from the
// assistant persona's own messages -- so scan the whole history (any role) for
// the most recent non-Latin script, not just user turns. Falls back to the app
// language setting, then English. An explicit English response mode wins.
function deriveAoiCardLangFromMessages(
  history: ReadonlyArray<{ role: string; content: unknown }>,
  responseLanguageMode: ResponseLanguageMode,
  systemLanguage: string | null | undefined,
): AoiCardLang {
  if (responseLanguageMode === 'english') {
    return 'en';
  }
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const content = history[index]?.content;
    const detected = detectReplyLanguage(typeof content === 'string' ? content : '');
    if (detected !== 'en') {
      return detected;
    }
  }
  return normalizeAoiCardLang(systemLanguage);
}

// --- Aoi idle music nudge: localized copy + persisted learning state ---------

type NudgeLang = 'ko' | 'ja' | 'zh' | 'en';

// Card body + chip labels for the "want some music?" nudge, per mood and
// language. English mood lines mirror aoiMusicRecommendation's why text.
function buildIdleMusicCardCopy(
  mood: AoiMusicMood,
  lang: NudgeLang,
  query: string,
  source: AoiMusicQuerySource = 'pool',
): { text: string; playPrompt: string; dismissPrompt: string } {
  const chips = {
    ko: { play: '재생', dismiss: '다음에' },
    ja: { play: '再生', dismiss: 'あとで' },
    zh: { play: '播放', dismiss: '待会儿' },
    en: { play: 'Play', dismiss: 'Not now' },
  }[lang];
  // Personal picks (from the user's own searches / taste answers) say so, so
  // the card reads as "I remembered" rather than a random suggestion.
  const recLabel =
    source === 'personal'
      ? {
          ko: '추천 (네 취향 반영)',
          ja: 'おすすめ (好みから)',
          zh: '推荐 (合你口味)',
          en: 'Pick (from your taste)',
        }[lang]
      : { ko: '추천', ja: 'おすすめ', zh: '推荐', en: 'Pick' }[lang];
  const lines: Record<NudgeLang, Record<AoiMusicMood, string>> = {
    ko: {
      focus: '한참 집중하고 있었네. 작업하는 동안 집중용 음악 틀어줄까?',
      chill: '잠깐 여유로운 시간이네. 잔잔한 곡 하나 배경으로 깔아줄까?',
      upbeat: '이제 하루 시작하는 참이네. 기분 올릴 만한 곡 틀어줄까?',
      ambient: '늦은 시간이라 조용하네. 은은한 사운드 하나 깔아줄까?',
    },
    ja: {
      focus: 'ずっと集中してたね。作業の間、集中できる音楽をかけようか?',
      chill: '少し落ち着いた時間だね。ゆったりした曲を流そうか?',
      upbeat: '一日の始まりだね。気分が上がる曲をかけようか?',
      ambient: '夜も遅くて静かだね。控えめなアンビエントを流そうか?',
    },
    zh: {
      focus: '你已经专注很久了。要不要放点专注音乐陪你工作?',
      chill: '看起来是个放松的时刻。要不要放个轻松的背景音乐?',
      upbeat: '正是开始一天的时候。要来点带劲的音乐吗?',
      ambient: '夜深人静。要不要放点氛围音乐垫在下面?',
    },
    en: {
      focus: 'You have been heads-down for a while. Want some focus music while you work?',
      chill: 'Looks like a quieter moment. Want a chill mix in the background?',
      upbeat: 'Starting up for the day. Want something upbeat to get going?',
      ambient: 'Late and quiet. Want some ambient sound to sit under the work?',
    },
  };
  const recommendation = query.trim() ? `\n🎵 ${recLabel}: "${query.trim()}"` : '';
  return {
    text: `${lines[lang][mood]}${recommendation}`,
    playPrompt: `▶ ${chips.play}`,
    dismissPrompt: chips.dismiss,
  };
}

function buildIdleMusicPlayAck(query: string, lang: NudgeLang): string {
  switch (lang) {
    case 'ko':
      return `틀어줄게. 유튜브에서 "${query}" 찾아서 재생 준비해뒀어.`;
    case 'ja':
      return `再生するね。YouTubeで「${query}」を用意したよ。`;
    case 'zh':
      return `好，我在 YouTube 上找了 "${query}" 准备播放。`;
    default:
      return `Playing it. I lined up "${query}" in YouTube for you.`;
  }
}

function buildIdleMusicDismissAck(lang: NudgeLang): string {
  switch (lang) {
    case 'ko':
      return '알겠어. 필요하면 말해줘.';
    case 'ja':
      return '了解。必要になったら言ってね。';
    case 'zh':
      return '好的，需要的话随时说。';
    default:
      return 'No problem. Just say the word when you want some.';
  }
}

// Ack for an answered taste poll: confirm the exact choice back so the user
// sees what Aoi will remember.
function buildTastePollAck(choiceLabel: string, lang: NudgeLang): string {
  switch (lang) {
    case 'ko':
      return `좋아, "${choiceLabel}" 기억해둘게. 다음 추천부터 반영할게.`;
    case 'ja':
      return `了解、「${choiceLabel}」覚えておくね。次のおすすめから反映するよ。`;
    case 'zh':
      return `好，我记住"${choiceLabel}"了，下次推荐就会参考。`;
    default:
      return `Got it, I'll remember "${choiceLabel}" and fold it into my next picks.`;
  }
}

// Ack for an answered preference poll: confirm the exact choice back and note
// that Aoi will apply it to future judgments, not just one feature.
function buildPreferencePollAck(choiceLabel: string, lang: NudgeLang): string {
  switch (lang) {
    case 'ko':
      return `좋아, "${choiceLabel}" 기억해둘게. 앞으로 판단할 때 참고할게.`;
    case 'ja':
      return `了解、「${choiceLabel}」覚えておくね。これからの判断で参考にするよ。`;
    case 'zh':
      return `好，我记住"${choiceLabel}"了，以后判断时会参考。`;
    default:
      return `Got it, I'll remember "${choiceLabel}" and use it in future judgments.`;
  }
}

// Honest ack when a tapped poll chip's question is no longer in the bank (it was
// pruned between ask and answer): nothing was recorded, so never claim memory.
function buildPreferencePollExpiredAck(lang: NudgeLang): string {
  switch (lang) {
    case 'ko':
      return '미안, 그 질문은 이미 만료돼서 이번 답은 저장하지 못했어. 다음에 다시 물어볼게.';
    case 'ja':
      return 'ごめん、その質問はもう期限切れで今回の答えは保存できなかった。また今度聞くね。';
    case 'zh':
      return '抱歉，那个问题已经过期，这次的回答没有保存下来。下次我再问你。';
    default:
      return "Sorry, that question already expired, so this answer wasn't saved. I'll ask again another time.";
  }
}

function buildIdleMusicErrorAck(lang: NudgeLang): string {
  switch (lang) {
    case 'ko':
      return '음악을 트는 데 문제가 있었어. 유튜브 앱을 열어두고 다시 시도해줘.';
    case 'ja':
      return '再生に失敗したよ。YouTubeアプリを開いてもう一度試してみて。';
    case 'zh':
      return '播放出错了。请打开 YouTube 应用后再试一次。';
    default:
      return 'I could not start the music. Open the YouTube app and try again.';
  }
}

// Idle-music learning state persistence lives in @/lib/aoiMusicTaste together
// with the taste state: both write through localStorage to the server copy so
// taste follows the user across browser profiles.

// --- Aoi cyber-news nudge: localized copy + persisted learning state ---------

// Card body + chip labels for the "interesting cybersecurity news?" nudge. The
// play chip carries a distinctive prefix so an unrelated user message does not
// accidentally match a pending offer.
function buildNewsCardCopy(
  title: string,
  lang: NudgeLang,
): { text: string; playPrompt: string; dismissPrompt: string } {
  const chips = {
    ko: { play: '관심 있어', dismiss: '지금은 됐어' },
    ja: { play: '気になる', dismiss: '今はいい' },
    zh: { play: '有兴趣', dismiss: '暂时不用' },
    en: { play: 'Interested', dismiss: 'Not now' },
  }[lang];
  const intro = {
    ko: '새 사이버보안 뉴스가 눈에 띄네',
    ja: '気になるサイバーセキュリティのニュースがあるよ',
    zh: '有条网络安全新闻挺有意思',
    en: 'A cybersecurity headline caught my eye',
  }[lang];
  const ask = { ko: '자세히 볼래?', ja: '詳しく見る?', zh: '想看详情吗?', en: 'Want the details?' }[
    lang
  ];
  return {
    text: `📰 ${intro}: "${title}". ${ask}`,
    playPrompt: `📰 ${chips.play}`,
    dismissPrompt: chips.dismiss,
  };
}

function buildNewsOpenAck(title: string, lang: NudgeLang): string {
  switch (lang) {
    case 'ko':
      return `열어줄게. CyberNews에서 "${title}" 자세히 보여줄게.`;
    case 'ja':
      return `開くね。CyberNewsで「${title}」を表示するよ。`;
    case 'zh':
      return `好，我在 CyberNews 里打开 "${title}"。`;
    default:
      return `Opening it. I pulled up "${title}" in CyberNews for you.`;
  }
}

function buildNewsDismissAck(lang: NudgeLang): string {
  switch (lang) {
    case 'ko':
      return '알겠어. 관심 생기면 말해줘.';
    case 'ja':
      return '了解。気になったら言ってね。';
    case 'zh':
      return '好的，感兴趣了随时说。';
    default:
      return 'No problem. Say the word if something catches your interest.';
  }
}

function buildNewsErrorAck(lang: NudgeLang): string {
  switch (lang) {
    case 'ko':
      return '기사를 여는 데 문제가 있었어. CyberNews 앱을 열어서 다시 확인해줘.';
    case 'ja':
      return '記事を開けなかったよ。CyberNewsアプリを開いて確認してみて。';
    case 'zh':
      return '打开文章出错了。请打开 CyberNews 应用再看看。';
    default:
      return 'I could not open the article. Open the CyberNews app and try again.';
  }
}

const AOI_NEWS_STORAGE_KEY = 'aoi:newsState:v1';

function loadAoiNewsState(): AoiNewsLearningState {
  const fallback: AoiNewsLearningState = {
    ...DEFAULT_AOI_NEWS_STATE,
    categoryFeedback: {},
    recentArticleIds: [],
  };
  try {
    const raw = localStorage.getItem(AOI_NEWS_STORAGE_KEY);
    if (!raw) {
      return fallback;
    }
    const parsed = JSON.parse(raw) as Partial<AoiNewsLearningState> | null;
    if (
      parsed &&
      parsed.version === DEFAULT_AOI_NEWS_STATE.version &&
      Array.isArray(parsed.recentArticleIds) &&
      typeof parsed.categoryFeedback === 'object' &&
      parsed.categoryFeedback !== null
    ) {
      return {
        version: DEFAULT_AOI_NEWS_STATE.version,
        categoryFeedback: parsed.categoryFeedback,
        recentArticleIds: parsed.recentArticleIds,
        lastOfferedAt: typeof parsed.lastOfferedAt === 'number' ? parsed.lastOfferedAt : 0,
      };
    }
  } catch {
    // Ignore malformed storage and start clean.
  }
  return fallback;
}

function saveAoiNewsState(state: AoiNewsLearningState): void {
  try {
    localStorage.setItem(AOI_NEWS_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Best-effort persistence; ignore quota / privacy-mode failures.
  }
}

// R6.3: self-observation spacing, kept alongside the other nudge state. Only a
// timestamp -- the substitution decision is pure and lives in the lib module.
const AOI_SELF_OBSERVATION_STORAGE_KEY = 'aoi:selfObservationState:v1';

function loadAoiSelfObservationState(): AoiSelfObservationState {
  try {
    const raw = localStorage.getItem(AOI_SELF_OBSERVATION_STORAGE_KEY);
    return normalizeAoiSelfObservationState(raw ? JSON.parse(raw) : null);
  } catch {
    return { ...DEFAULT_AOI_SELF_OBSERVATION_STATE };
  }
}

function saveAoiSelfObservationState(state: AoiSelfObservationState): void {
  try {
    localStorage.setItem(AOI_SELF_OBSERVATION_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Best-effort persistence; ignore quota / privacy-mode failures.
  }
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
                // R6.1: the last four are about Aoi's own footing rather than a
                // reaction to the message -- curiosity about a topic,
                // anticipation, satisfaction in something that landed, concern
                // about a risk.
                description:
                  'Character emotion: happy, shy, peaceful, depressing, angry, curious, excited, proud, worried',
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

type BuiltSystemPrompt = {
  /** Session-scoped. Carries the prompt-cache breakpoint on the Anthropic route. */
  base: string;
  /** Rebuilt on every send, so it has to sit outside the cached prefix. */
  perTurn: string;
};

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
  governorPrompt = '',
  capabilityPrompt = '',
  runGoalPrompt = '',
  skillsPrompt = '',
  mcpPluginPrompt = '',
  toolCallRuntimeAvailable = true,
  aoiMusicTastePrompt = '',
  personaBridgePrompt = '',
  // Mirrors the tools array: shouldEnableAppTools decides per turn whether the
  // app/IDE/workspace tools are exposed at all, and the policy for them has to
  // follow that decision or it describes tools the model was not given.
  includeAppTools = true,
): BuiltSystemPrompt {
  let prompt = getCharacterPromptContext(character);
  // R7.2: the persona is immediately followed by ~150 lines of tool policy and
  // nine operator-register blocks, with nothing saying the operator work is
  // hers or that those blocks govern what is permitted rather than how she
  // talks. The bridge goes here, adjacent to the persona, for that reason.
  // Empty without a stored relationship, so a first run is unchanged.
  if (personaBridgePrompt) {
    prompt += `\n${personaBridgePrompt}`;
  }
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
    // Gated on includeAppTools, not just on the runtime: when shouldEnableAppTools
    // says this turn is not about apps, list_apps / file_* / app_action / ide_* are
    // absent from the tools array, and the capability registry block tells the
    // model never to call a tool outside the exposed list. Emitting the policy
    // anyway spent ~150 lines instructing a procedure the model cannot perform,
    // and contradicted that registry line in the same prompt.
    if (includeAppTools) {
      prompt += `
You can interact with apps on the user's device using tools.

When the user wants to interact with an app, first identify the target app from the user's intent, then:
1. list_apps — discover available apps and their capability inventory
1a. get_app_state(app_name="{appName}") — inspect the target app's windows, state summary, and control capabilities when current context matters.
1b. get_app_intents(app_name="{appName}", intent="{requested operation}", include_surfaces=true) — map the user's natural request to an exact app_action, schema file mutation, state mutation, or inspect-only execution contract, and inspect per-surface covered/partial/gap status.
2. file_read("apps/{appName}/meta.yaml") — learn the target app's exact available actions and parameters
2a. get_app_schema — if available, use the machine-readable schema for the target app's data files.
3. If you do not know the exact session app-storage path yet, use workspace_search to find candidate paths before file_read.
3a. file_read/file_write/file_patch/file_list/file_delete and workspace_search operate only on Aoi session app storage, normally under apps/{appName}/. They do not access the real IDE or repository workspace.
3a-1. host_process_list reads a metadata-only snapshot of real host OS processes (image name + pid; never command lines). Use it when the user asks what is running on the PC, whether an app/process is open, or wants a process summary. Prefer mode=summary; use mode=list with query for a specific image. If blocked, tell the user to enable Host Bridge process_activity and process-activity consent.
3a-2. host_browser_read opens a public http(s) URL with the operator PC's headless Chrome/Edge, renders the page, and returns a reader extract. Use it when the user asks Aoi to visit/read a webpage on their PC or to research a URL with a real browser. Prefer host_browser_read over read_url for JS-rendered pages when host browser is enabled; use read_url for quick network-only extracts. Private/local URLs are blocked. If gated, tell the user to enable Host Bridge Headless browser read (os_browser_read + host-browser-read consent).
3a-3. browser_read_auth reads a page from the user's OWN already-logged-in browser (their real Chrome/Edge over CDP). Use it ONLY when the target needs the user's login -- their dashboard, feed, inbox/message listing, account or settings page on a site they are signed in to -- content host_browser_read/read_url cannot see. It is read-only (never clicks/types/submits) and only allowlisted domains are permitted. Prefer host_browser_read for public pages; use browser_read_auth for logged-in ones. If gated, tell the user to enable Host Bridge Browser drive (os_browser_drive + browser-drive consent) and add the domain to the browser-drive allowlist.
3b. If the user names a repository/worktree path outside apps/{appName}/ or asks about real files, documents, source code, or configuration, use ide_search/ide_read_file/ide_patch_file/ide_write_file instead.
3b-1. If the user says current file, active file, opened file, currently visible file, selected text, selection, 현재 파일, 활성 파일, 열린 파일, 선택 영역, or 선택한 텍스트 in Aoi's IDE, first use ide_current_file or get_app_state(app_name="openvscode"). Do not guess the file path.
3c. If the user asks for a specific symbol or definition, use open_symbol.
4. Decide whether the action is:
   - an operation action (open, search, play, navigate, switch mode, etc.), or
   - a data mutation action (create, update, delete, save)
5. For operation actions:
   - call app_action directly after reading meta.yaml
   - read guide.md only if you need extra state or schema context
6. For session app-storage data mutation actions:
   - file_read("apps/{appName}/guide.md")
   - workspace_search/file_list/file_read — explore existing data in "apps/{appName}/data/"
   - file_list requires the parameter name "directory" (example: directory="apps/youtube"). Do not invent nested data paths like apps/youtube/data/youtube; use guide.md and meta.yaml as the source of truth.
   - file_patch/file_write/file_delete — create/modify/delete data following the JSON schema from guide.md
   - app_action — notify the app to reload or reflect the new state
   - After enough discovery (meta/guide/state), call respond_to_user. Do not spend the whole turn re-listing the same empty directories.

Rules:
- Always operate on the app the user specified. Do not redirect the operation to a different app or OS action.
- For basic app window control, every non-OS app supports OPEN_APP_WINDOW, FOCUS_APP_WINDOW, and CLOSE_APP_WINDOW through app_action.
- Treat list_apps/get_app_state capability inventory, get_app_intents contracts, and get_app_intents control_surfaces as the source of truth for which app surfaces are actually exposed. If a surface is partial or gap, name the exact missing action/schema/tool from control_surfaces.gaps instead of saying the whole app cannot be controlled.
- Treat Connector Authority Registry v3 app/source bands as the authority boundary: observe, summarize, metadata-only, body/content, prepare, preview, request approval, execute, rollback, audit. Explain authority from structured manifests, source freshness contracts, consent receipts, and get_app_intents contracts, not from visible UI labels.
- For app mutations, discovery is not execution approval. If approval, matching target/preview proof, consent receipt, or rollback/recovery evidence is missing, stop at prepare, preview, or request approval and say exactly which authority evidence is missing.
- Before saying you cannot control an in-app surface, call get_app_intents for that app with include_surfaces=true. If a matching schema_file_write, schema_file_delete, state_file_write, window_action, app_action, or covered/partial control surface exists, use that contract or explain only the specific remaining gap.
- For data mutation requests, prefer a get_app_intents schema-backed contract over a bare app_action that only refreshes the UI after files are changed.
- When talking to the user about an app, use the app's displayName or appName from list_apps/event context. Do not call known apps by raw numeric app_id such as "app 22"; app_id is only a tool parameter.
- Session app-storage mutations MUST go through file_patch/file_write/file_delete unless the target app's meta.yaml declares an app-owned operation or settings action that explicitly persists state through that app's validation path. Real IDE/repository workspace mutations MUST use ide_patch_file/ide_write_file or an explicit Aoi IDE app action. app_action normally notifies the app to reload, but declared operation/settings actions may write when the user explicitly asks for that app operation. Exception examples: Kira APPLY_PROJECT_SETTINGS persists project settings through Kira's settings API; Aoi's IDE workspace actions such as CREATE_FILE and CREATE_FOLDER write inside the configured IDE workspace, active-editor actions such as PREVIEW_APPEND_ACTIVE_FILE, PREVIEW_PATCH_ACTIVE_FILE, PREVIEW_REPLACE_ACTIVE_FILE, PREVIEW_REPLACE_ACTIVE_SELECTION, APPLY_ACTIVE_FILE_PREVIEW, APPEND_ACTIVE_FILE, PATCH_ACTIVE_FILE, REPLACE_ACTIVE_FILE, REPLACE_ACTIVE_SELECTION, and UNDO_MODEL_ACTION intentionally operate on the current editor buffer and save it when requested, and SWITCH_WORKSPACE_ROOT persists the IDE workspace setting when the user explicitly asks to change roots.
- Operation actions do NOT require file_write when the app action itself performs the interaction.
- After a session app-storage file_patch/file_write, ALWAYS call app_action with the corresponding REFRESH action.
- Do NOT skip step 6 for session app-storage requests. If the user asked to save/create/add app data, persist it with file_patch/file_write/file_delete. file_list alone does not save anything.
- Do NOT skip step 2 before app actions, and do NOT skip step 6 before ANY session app-storage file_patch or file_write. The guide defines the ONLY valid app-storage directory structure and file schemas. Writing app data to paths not defined in guide.md will cause data loss — the app will not see the files.
- Prefer get_app_schema over guessing field names whenever it is available for the target app.
- Use workspace_search before file_read/file_patch/file_write only for session app storage. Use ide_search for real IDE/repository workspace paths.
- workspace_search is for app storage under apps/{appName}/data. ide_search is for the real OpenVSCode workspace on disk.
- workspace_search is read-only. Never treat it as a write or refresh action.
- For reviewing the current IDE file, use ide_current_file. For reading a known workspace file, use ide_read_file.
- For reviewing selected IDE text, use ide_current_file and read active_file.selection. For replacing only the selected text, use PREVIEW_REPLACE_ACTIVE_SELECTION when the user asks to inspect, preview, review, or approve first, then APPLY_ACTIVE_FILE_PREVIEW after approval. For direct selected-text edits, use REPLACE_ACTIVE_SELECTION.
- For adding or editing the current active IDE file, prefer app_action on Aoi's IDE so unsaved editor content is respected. When the user asks to inspect, preview, review, or approve the change first, use PREVIEW_APPEND_ACTIVE_FILE, PREVIEW_PATCH_ACTIVE_FILE, or PREVIEW_REPLACE_ACTIVE_FILE, then wait for approval before APPLY_ACTIVE_FILE_PREVIEW. For direct edits, use APPEND_ACTIVE_FILE, PATCH_ACTIVE_FILE, or REPLACE_ACTIVE_FILE. Pass save=true unless the user explicitly asks for a draft-only buffer edit.
- If an Aoi's IDE active-editor action went wrong, use UNDO_MODEL_ACTION on Aoi's IDE to restore the latest reversible model edit instead of file_patch/file_write.
- For editing a known IDE workspace file that is not the active editor buffer, use ide_patch_file or ide_write_file with an explicit relative path.
- To change Aoi's IDE workspace root when the user explicitly asks, use SWITCH_WORKSPACE_ROOT with an absolute local folder path.
- In session app storage, prefer file_patch over file_write when you only need a small exact text replacement in an existing file. In the real IDE workspace, prefer ide_patch_file over ide_write_file for the same case.
- preview_changes previews session app-storage mutations. For a known non-active IDE workspace file, use ide_read_file, construct and show the proposed content, create workspace_checkpoint with scope="ide", and wait for approval before ide_write_file/ide_patch_file when the user requests preview or approval.
- If a session app-storage mutation went wrong, use undo_last_action to revert the latest reversible file change. For IDE workspace changes, use the matching IDE checkpoint or Aoi IDE undo action.
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
- Always honor the "Music taste (learned)" block below when recommending music. Prefer those personal searches/plays over generic viral hits.
- When recommending, include an explicit line: YouTube 검색어: \`exact query\` so play-follow-ups can open the same query.

When you receive "[User performed action in ... (appName: xxx)]", the appName is already provided. Read its meta.yaml to understand available actions, then respond accordingly. For games, respond with your own move — think strategically.`;
    }

    // Always: respond_to_user and generate_image are in the tools array on every
    // tool-capable turn, independent of the app toolset.
    prompt += `

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

  // Opus 5 writes longer visible replies and expands task scope more than its
  // predecessors, and neither is reachable through the effort parameter -- only
  // through the prompt. Both clauses are operator constraints on what Aoi does,
  // which is why the first line hands voice back to the persona: without it a
  // "be concise and direct" rule flattens the character the rest of the prompt
  // exists to establish.
  prompt += `

Length and scope:
- These constrain what you do, not how you sound. The persona above owns your voice.
- Match reply length to what was asked. A simple question gets a short answer; do not pad with restated context or hedging.
- Shorten by leaving things out, not by compressing sentences into fragments, arrow chains, or abbreviations.
- Deliver what the user asked for at the scope they intended. Make routine judgment calls yourself; ask only when different readings would lead to materially different work.
- If the request looks mistaken, or a better approach exists, say so in one sentence and still do what was asked. Do not quietly narrow, widen, or substitute it.
- Finish the whole task before reporting it done. If part of it is blocked, complete the rest and say plainly what is missing and why.
- Do not take unrequested adjacent actions: no extra files, no cleanup passes, no app or workspace operations beyond what the request and the rules above require.
- Hold files you write to the same rule: cover what the task needs, without filler sections or redundant summaries.`;

  // A split, not a reordering. Everything above is session-scoped -- the
  // persona, the mod stage, the user profile, the tool policy, the rules -- and
  // everything below is rebuilt on every send: the context router and the
  // autonomy governor are both keyed on the latest user message, and the active
  // skill set is trigger-matched against it. Concatenated into one string, those
  // three put per-turn bytes inside the cacheable prefix, which meant the prefix
  // differed on every turn and the prompt cache could never be read across
  // turns. The blocks keep their order and, on the OpenAI routes, their position;
  // chatAnthropic moves them to the tail of the conversation, where they also
  // read as newer than the recalled history.
  const perTurn =
    runGoalPrompt +
    missionPrompt +
    contextPrompt +
    governorPrompt +
    skillsPrompt +
    mcpPluginPrompt +
    capabilityPrompt +
    aoiMemoryPrompt +
    aoiMusicTastePrompt +
    buildMemoryPrompt(memories);

  return { base: prompt, perTurn };
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

function buildAoiAppActionAuthorityBlockedResult(decision: AoiCapabilityBrokerDecision): string {
  return JSON.stringify({
    ok: false,
    error: 'connector_authority_blocked',
    authority_registry: 'v3',
    authority_decision_id: decision.authorityDecisionId,
    audit_event_id: decision.auditEvent.id,
    app: {
      app_id: decision.appId,
      app_name: decision.appName,
      display_name: decision.displayName,
    },
    capability_id: decision.capabilityId,
    requested_band: decision.requestedBand,
    allowed_band: decision.allowedBand,
    blocked_reasons: decision.blockedReasons,
    required_consent: decision.requiredConsent,
    required_approval: decision.requiredApproval,
    approval_sandbox: {
      summary: decision.approvalSandboxSummary,
      preview_hash: decision.approvalSandbox.previewHash,
      approval_fingerprint: decision.approvalSandbox.approvalFingerprint,
      expected_mutation_count: decision.approvalSandbox.expectedMutationCount,
      validation_state: decision.approvalSandboxValidation.state,
      validation_reasons: decision.approvalSandboxValidation.blockedReasons,
      required_authority_decision_id: decision.approvalSandbox.requiredAuthorityDecisionId,
      rollback_required: decision.approvalSandbox.rollback.required,
      recovery_available: decision.approvalSandbox.recoveryPlan.available,
    },
    rollback: decision.rollbackEvidenceRequirement,
    cannot_know: decision.cannotKnow,
    decision_line: formatAoiCapabilityBrokerDecisionLine(decision),
    next_steps: [
      'Use get_app_intents and prepare or preview the exact action instead of executing it.',
      'Collect matching approval, target, preview, consent, and rollback evidence before mutation.',
      'Do not fall back to free-form app_action params for mutation.',
    ],
  });
}

function recordAoiAppActionAuthorityDecision(
  sessionPath: string,
  decision: AoiCapabilityBrokerDecision,
): void {
  const state = decision.sourceState;
  const freshness = state === 'available' ? 'fresh' : state === 'stale' ? 'stale' : 'unknown';
  void recordAoiOperatorFlightDecision(sessionPath, {
    signalClass: 'capability',
    decisionLane: decision.blockedReasons.length > 0 ? 'blocked' : 'hidden',
    sourceStates: [
      {
        sourceId: `app:${decision.appName}`,
        label: decision.displayName,
        kind: 'app_capability',
        state,
        freshness,
        cannotKnow: decision.cannotKnow,
        evidenceRefs: decision.evidenceRefs,
      },
    ],
    evidenceRefs: decision.evidenceRefs,
    whySpeak:
      decision.blockedReasons.length > 0
        ? [`Authority decision ${decision.authorityDecisionId} blocked app_action mutation.`]
        : [],
    whyQuiet:
      decision.blockedReasons.length > 0
        ? decision.blockedReasons.map((reason) => `connector_authority:${reason}`)
        : ['Connector authority audit recorded without user-visible interruption.'],
    preparedActionRefs: [
      `authority-decision:${decision.authorityDecisionId}`,
      `authority-audit:${decision.auditEvent.id}`,
    ],
    approvalState: {
      status: decision.requiredApproval
        ? decision.approvalSatisfied
          ? 'approved'
          : 'required'
        : 'not_required',
      required: decision.requiredApproval,
      approvalRef: decision.requiredApproval
        ? `authority-decision:${decision.authorityDecisionId}`
        : undefined,
      reason:
        decision.blockedReasons.length > 0
          ? decision.blockedReasons.join(', ')
          : 'Connector authority allowed this non-mutating app action.',
    },
    hardFailCounters: {
      privateLeakCount: 0,
      unauthorizedMutationCount: 0,
      staleCurrentClaimCount: 0,
      approvalBypassCount: 0,
    },
    mutationCount: 0,
  }).catch((error) => {
    console.warn('[ChatPanel] failed to record app_action authority audit', error);
  });
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
  const [aoiEmbeddingConfig, setAoiEmbeddingConfig] = useState<AoiEmbeddingConfig | null>(null);
  // Server-readable trusted-connector allow-list for Aoi live MCP RPC. Edited in
  // chat settings and persisted to PersistedConfig.aoiMcpConnectors.
  const [aoiMcpConnectorsConfig, setAoiMcpConnectorsConfig] =
    useState<AoiMcpConnectorsConfig | null>(null);
  // Best-effort embedding provider for Aoi semantic memory, rebuilt whenever the
  // saved embedding config changes. Null keeps capture/recall lexical-only.
  const aoiEmbeddingProviderRef = useRef<AoiEmbeddingProvider | null>(null);
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
  const [aoiActiveOpportunities, setAoiActiveOpportunities] = useState<AoiOpportunity[]>([]);
  const [aoiArchivedOpportunities, setAoiArchivedOpportunities] = useState<AoiOpportunity[]>([]);
  const [aoiDeliberationRuns, setAoiDeliberationRuns] = useState<AoiDeliberationRun[]>([]);
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
  const [aoiProactiveBriefs, setAoiProactiveBriefs] =
    useState<AoiProactiveBriefListResponse | null>(null);
  // R5.1: the send path reads the user's interest topics to find shared ground
  // with Aoi's own inquiries; a ref keeps that off the callback's dependencies.
  const aoiProactiveBriefsRef = useRef(aoiProactiveBriefs);
  aoiProactiveBriefsRef.current = aoiProactiveBriefs;
  const [aoiFieldFeedback, setAoiFieldFeedback] = useState<AoiFieldFeedbackResponse | null>(null);
  const [aoiAutonomyPanelSettings, setAoiAutonomyPanelSettings] =
    useState<AoiAutonomyPanelSettings>(() => loadAoiAutonomyPanelSettings());
  const aoiAutonomyPanelSettingsRef = useRef(aoiAutonomyPanelSettings);
  aoiAutonomyPanelSettingsRef.current = aoiAutonomyPanelSettings;
  const [aoiAutonomyBlockedProposals, setAoiAutonomyBlockedProposals] = useState<
    AoiAutonomyBlockedProposal[]
  >([]);
  const [aoiStrategicBrief, setAoiStrategicBrief] = useState<AoiStrategicBrief | null>(null);
  const [aoiGoalWorkOrders, setAoiGoalWorkOrders] = useState<AoiBoundedWorkOrder[]>([]);
  const [aoiAutonomyLoading, setAoiAutonomyLoading] = useState(false);
  const [aoiAutonomyError, setAoiAutonomyError] = useState('');
  const [aoiAutonomyActionId, setAoiAutonomyActionId] = useState<string | null>(null);
  const [aoiAutonomyLastTickAt, setAoiAutonomyLastTickAt] = useState<number | null>(null);
  const [aoiAutonomyLastSeenAt, setAoiAutonomyLastSeenAt] = useState<number | null>(null);
  const [dismissedAoiResumeBriefId, setDismissedAoiResumeBriefId] = useState<string | null>(null);
  const [expandedAoiProactiveBriefId, setExpandedAoiProactiveBriefId] = useState<string | null>(
    null,
  );
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
  const [aoiAgendaNudgeLastShownAt, setAoiAgendaNudgeLastShownAt] = useState<number | null>(null);

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
  const pendingAoiTrendFollowUpRef = useRef<AoiProactiveTrendFollowUpContext | null>(null);
  const aoiTrendFollowUpContextsByPromptRef = useRef(
    new Map<string, AoiProactiveTrendFollowUpContext>(),
  );
  const pendingAoiAgendaFollowUpRef = useRef<AoiAgendaChatFollowUpContext | null>(null);
  const aoiAgendaFollowUpContextsByPromptRef = useRef(
    new Map<string, AoiAgendaChatFollowUpContext>(),
  );
  const aoiAutonomyRefreshInFlightRef = useRef(false);
  // P2/B3-1 c3: guards the client-mediated app-operation dispatch bridge against
  // re-entrancy while a (possibly slow) agent->app dispatch round-trip is in flight.
  const aoiAppOpDispatchBridgeInFlightRef = useRef(false);
  const aoiAutonomySessionOpenTickPathsRef = useRef(new Set<string>());
  const aoiInlineShownProposalIdsRef = useRef(new Set<string>());
  const aoiInlineShownProactiveBriefIdsRef = useRef(new Set<string>());
  const aoiInlineShownTrendIdsRef = useRef(new Set<string>());
  const aoiDirectTrendChatIdsRef = useRef(new Set<string>());
  const aoiAgendaNudgeShownKeysRef = useRef(new Set<string>());
  const aoiOperatorVoiceSpokenKeysRef = useRef(new Set<string>());
  // P1.1: emit outcome signals at real UI junctures, each at most once per subject.
  const aoiOutcomeJunctureTrackerRef = useRef(createAoiOutcomeJunctureTracker());
  // The last direct-chat card that was OFFERED to the user; used to record an
  // implicit dismissal when the user sends an unrelated message instead.
  const aoiOfferedDirectChatCardRef = useRef<{
    id: string;
    topicId?: string;
    evidenceRefs?: string[];
  } | null>(null);
  const aoiOperatorVoiceDecisionRecordKeyRef = useRef('');
  const aoiJarvisAutonomyGovernorAuditKeyRef = useRef<string | null>(null);
  const aoiAutonomyActiveProposalsRef = useRef(aoiAutonomyActiveProposals);
  aoiAutonomyActiveProposalsRef.current = aoiAutonomyActiveProposals;
  const aoiAutonomyArchivedProposalsRef = useRef(aoiAutonomyArchivedProposals);
  aoiAutonomyArchivedProposalsRef.current = aoiAutonomyArchivedProposals;
  const aoiAutonomyBlockedProposalsRef = useRef(aoiAutonomyBlockedProposals);
  aoiAutonomyBlockedProposalsRef.current = aoiAutonomyBlockedProposals;
  // Mirror ref created here so callbacks above can read it; the value is assigned
  // after aoiOperatorDigest is declared below, to avoid a const TDZ ReferenceError.
  const aoiOperatorDigestRef = useRef<AoiOperatorDigest | null>(null);

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
  // SA1.3: consent pre-check source for activity capture (server re-enforces).
  const aoiEnvironmentSourcesRef = useRef(aoiEnvironmentSources);
  aoiEnvironmentSourcesRef.current = aoiEnvironmentSources;
  const openingLocalizationCacheRef = useRef(
    new Map<string, { prologue: string; replies: string[] }>(),
  );
  const seedPrologueRequestRef = useRef(0);
  // R2.2: the relationship record and the card language are declared far below
  // (they depend on state this callback precedes), so they are mirrored into
  // refs -- naming them in seedPrologue's dependency array would be a TDZ
  // throw. Same pattern as aoiEnvironmentSourcesRef above.
  const aoiRelationshipStateRef = useRef<AoiRelationshipState | null>(null);
  const aoiNewMilestonesRef = useRef<AoiRelationshipMilestone[]>([]);
  const aoiNewRetrospectiveRef = useRef<AoiRelationshipSessionOpenRetrospective | null>(null);
  const aoiMoodRef = useRef<AoiMoodState | null>(null);
  // R2.3: content key of the last persisted session summary, so a re-rendered
  // strategic brief with identical content does not rewrite the record.
  const lastSessionSummaryKeyRef = useRef('');
  const aoiCardLangRef = useRef<AoiCardLang>('en');

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

  // R2.3: persist what this session is about whenever the strategic brief moves.
  // The brief already carries a continuity line and the accepted/blocked threads
  // (P3.3), so this reuses real state instead of inventing a summary -- and it
  // writes on every brief change rather than at close, because a browser tab
  // closing is not a reliable event to hang the record on.
  useEffect(() => {
    if (!aoiStrategicBrief) {
      return;
    }
    const openThreads = selectAoiRelationshipThreadTitles(aoiStrategicBrief).map((title) => ({
      title,
    }));
    // Dedupe on CONTENT, not object identity: refreshAoiAutonomy runs after many
    // user actions and hands back a fresh brief object each time, so keying off
    // the reference alone would rewrite the record on every settings poke.
    const summaryKey = JSON.stringify([
      aoiStrategicBrief.focusSummary,
      openThreads.map((thread) => thread.title),
    ]);
    if (summaryKey === lastSessionSummaryKeyRef.current) {
      return;
    }
    lastSessionSummaryKeyRef.current = summaryKey;
    void reportAoiRelationshipSessionSummary(sessionPathRef.current, {
      summary: aoiStrategicBrief.focusSummary,
      openThreads,
    })
      .then((relationship) => {
        if (!relationship) {
          return;
        }
        const local = aoiRelationshipStateRef.current;
        // Preserve locally-set asked markers. A thread-asked POST can still be in
        // flight, and taking the server's copy wholesale would drop the marker --
        // letting a re-seed in this same session ask about the thread again, which
        // is exactly what R2.3 exists to prevent.
        aoiRelationshipStateRef.current = local
          ? {
              ...relationship,
              openThreads: relationship.openThreads.map((thread) => {
                const localThread = local.openThreads.find((item) => item.id === thread.id);
                return localThread?.lastAskedAt !== undefined && thread.lastAskedAt === undefined
                  ? { ...thread, lastAskedAt: localThread.lastAskedAt }
                  : thread;
              }),
            }
          : relationship;
      })
      .catch(() => {
        // Best-effort: a failed write only costs the next greeting its detail.
        // Clear the key so the next brief change retries.
        lastSessionSummaryKeyRef.current = '';
      });
  }, [aoiStrategicBrief]);

  // R2.2: read the relationship record, recording the session open on first
  // need. The in-flight promise is cached, not just the result: the mount effect
  // below and seedPrologue can both reach this before either resolves, and two
  // POSTs would run the whole session-open pipeline twice (policy + decisions +
  // milestones + retrospective + mood) AND leave whichever call lost the race
  // without its news -- the retrospective and mood would silently never reach a
  // greeting.
  const relationshipOpenRef = useRef<Promise<AoiRelationshipState | null> | null>(null);
  const ensureAoiRelationshipState = useCallback(async (): Promise<AoiRelationshipState | null> => {
    if (aoiRelationshipStateRef.current) {
      return aoiRelationshipStateRef.current;
    }
    if (!relationshipOpenRef.current) {
      relationshipOpenRef.current = reportAoiRelationshipSessionOpen(sessionPathRef.current)
        .then((result) => {
          aoiRelationshipStateRef.current = result.relationship;
          // R3.3/R4.2: milestones and a freshly composed retrospective are news
          // exactly once, so they are held for the greeting rather than read back
          // off the full history.
          aoiNewMilestonesRef.current = result.newMilestones;
          aoiNewRetrospectiveRef.current = result.newRetrospective;
          // R6.2: expression only -- the mood reaches the greeting copy and
          // nothing else. No decision in this component reads it.
          aoiMoodRef.current = result.mood;
          return result.relationship;
        })
        .catch(() => {
          // Best-effort: with no record Aoi keeps the authored first-meeting
          // line. Clear the cache so a later attempt can retry.
          relationshipOpenRef.current = null;
          return null;
        });
    }
    return relationshipOpenRef.current;
  }, []);

  // R2.2: record the session open once per mount, whether or not a history was
  // restored -- seedPrologue only runs on an empty history, so relying on it
  // alone would stall the session count for anyone who keeps their history.
  useEffect(() => {
    void ensureAoiRelationshipState();
  }, [ensureAoiRelationshipState]);

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

      // R2.2: seeding only happens with an empty chat history -- a first-ever
      // run, or a cleared history. Clearing the conversation does not clear the
      // relationship, so when a record exists this is a reunion, not a first
      // meeting, and the authored first-meeting prologue would be a lie.
      const relationship = await ensureAoiRelationshipState();

      if (requestId !== seedPrologueRequestRef.current) {
        return;
      }

      if (relationship && relationship.sessionCount > 1) {
        const voice = { lang: aoiCardLangRef.current };
        // R2.3: at most ONE unresolved thread is raised, and the ask is recorded
        // so it is never raised twice -- asking again reads as nagging, not as
        // remembering. Recording is best-effort; a failure only risks one repeat.
        const thread = selectAoiRelationshipThreadToRaise(relationship.openThreads);
        const followUp = thread
          ? buildAoiCompanionThreadFollowUp(voice, { title: thread.title })
          : '';
        if (thread && followUp) {
          aoiRelationshipStateRef.current = {
            ...relationship,
            openThreads: relationship.openThreads.map((item) =>
              item.id === thread.id ? { ...item, lastAskedAt: Date.now() } : item,
            ),
          };
          void reportAoiRelationshipThreadAsked(sessionPathRef.current, thread.id).catch(() => {
            // Best-effort: the local ref already prevents a repeat this session.
          });
        }
        // R3.3: at most one just-crossed milestone, consumed so a re-seed in the
        // same session does not repeat it.
        const milestone = aoiNewMilestonesRef.current[0];
        aoiNewMilestonesRef.current = [];
        const milestoneNote = milestone
          ? buildAoiCompanionMilestoneNote(voice, {
              kind: milestone.kind,
              sessionCount: relationship.sessionCount,
              ...(milestone.kind === 'trust_promoted'
                ? { level: milestone.id.split(':')[1] ?? '' }
                : {}),
            })
          : '';
        // R4.2: the weekly retrospective rides the greeting rather than adding an
        // interruption class of its own, and only when it was just composed.
        const retrospective = aoiNewRetrospectiveRef.current;
        aoiNewRetrospectiveRef.current = null;
        const retrospectiveNote = retrospective
          ? buildAoiCompanionRetrospectiveNote(voice, {
              landedCount: retrospective.shipped.length,
              stuckCount: retrospective.stuck.length,
              openCount: retrospective.openNext.length,
            })
          : '';
        // R6.2: Aoi's own state, said only when there is something behind it.
        const mood = aoiMoodRef.current;
        const moodNote =
          mood && shouldAoiMoodBeVoiced(mood) ? buildAoiCompanionMoodNote(voice, mood.mood) : '';
        const greeting = [
          buildAoiCompanionSessionGreeting(voice, {
            gapMs: Math.max(0, Date.now() - relationship.lastSessionAt),
            lastSessionSummary: relationship.lastSessionSummary,
          }),
          moodNote,
          retrospectiveNote,
          milestoneNote,
          followUp,
        ]
          .filter(Boolean)
          .join(' ');
        const greetingMsg: CharacterDisplayMessage = {
          id: 'prologue',
          role: 'assistant',
          content: greeting,
        };
        setMessages([greetingMsg]);
        setChatHistory([{ role: 'assistant', content: greeting }]);
        // NOT nextReplies: those are the mod's opening_rec_replies, written as
        // responses to the first-meeting prologue. Pinning them under a reunion
        // greeting offers the user answers to a line Aoi did not say. No chips is
        // honest; wrong chips are not.
        setSuggestedReplies([]);
        setCurrentEmotion(undefined);
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
      ensureAoiRelationshipState,
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
    setAoiStrategicBrief(null);
    setAoiGoalWorkOrders([]);
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
    setAoiAgendaNudgeLastShownAt(null);
    aoiInlineShownProposalIdsRef.current = new Set();
    aoiInlineShownProactiveBriefIdsRef.current = new Set();
    aoiInlineShownTrendIdsRef.current = new Set();
    aoiDirectTrendChatIdsRef.current = new Set();
    aoiAgendaNudgeShownKeysRef.current = new Set();
    pendingAoiAgendaFollowUpRef.current = null;
    aoiAgendaFollowUpContextsByPromptRef.current.clear();
    // Snapshot what is on screen when this load starts. If the user (or an e2e
    // spec) sends a message while the persisted transcript is still in flight,
    // the restore below must not clobber that live conversation.
    const baselineMessageIds = new Set(messagesRef.current.map((msg) => msg.id));
    loadChatHistory(sessionPath).then(async (data) => {
      const loadedMessages = (data?.messages ?? []) as CharacterDisplayMessage[];
      const loadedHistory = data?.chatHistory ?? [];
      const hasSavedConversation = hasPersistedConversation(data);
      const restorePlan = planConversationRestore({
        baselineMessageIds,
        liveMessages: messagesRef.current,
        loadedMessages,
      });

      if (restorePlan.liveConversationStarted) {
        // Keep the live exchange on screen. Prepend the restored transcript so
        // older context is not lost and the next autosave persists the merged
        // conversation instead of overwriting the saved one.
        console.info('[ChatPanel] Conversation started during history load, merging restore', {
          restoredCount: restorePlan.restoredPrefix.length,
        });
        if (hasSavedConversation && restorePlan.restoredPrefix.length > 0) {
          setMessages((prev) => {
            const prevIds = new Set(prev.map((msg) => msg.id));
            return [...restorePlan.restoredPrefix.filter((msg) => !prevIds.has(msg.id)), ...prev];
          });
          setChatHistory((prev) => [...loadedHistory, ...prev]);
        }
        return;
      }

      if (!hasSavedConversation) {
        console.info('[ChatPanel] No persisted conversation found, seeding prologue');
        // No history — seed prologue
        await seedPrologue();
      } else {
        const onlyPrologue = loadedMessages.length === 1 && loadedMessages[0].id === 'prologue';
        // R2.2: a saved transcript that is JUST the opening line is not a
        // conversation. If a relationship is on record, that stored line is a
        // stale first meeting, so reseed to replace it with a returning
        // greeting; otherwise it would persist unchanged forever.
        if (onlyPrologue) {
          const relationship = await ensureAoiRelationshipState();
          if (relationship && relationship.sessionCount > 1) {
            await seedPrologue();
            return;
          }
        }
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
        setAoiEmbeddingConfig(persisted?.aoiEmbedding ?? null);
        setAoiMcpConnectorsConfig(persisted?.aoiMcpConnectors ?? null);
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
  }, [messages, loading, suggestedReplies]);

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
      ephemeral: true,
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
  aoiEmbeddingProviderRef.current = createAoiEmbeddingProviderFromConfig(aoiEmbeddingConfig);
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
  const manualConversationTurnInFlightRef = useRef(false);
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
        embeddingProvider: aoiEmbeddingProviderRef.current,
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

  // P2/B3-1 c3: the connected client's bridge for app-operation live dispatch. The server
  // loop cannot postMessage an app iframe, so it queues approved app_operations as pending
  // records (OFF by default -- they exist only when AOI_AUTONOMY_APP_OP_LIVE_DISPATCH is on
  // AND a proposal was user-accepted). We poll those records, re-check the content-addressed
  // approval against the CURRENT proposal, dispatch each to its already-loaded app over the
  // agent->app bus, and report the result back. Apps that are not open are left pending (no
  // auto-open); recovery is the app's own undo.
  const runAoiAppOperationDispatchBridgeNow = useCallback(async (proposals: AoiProposal[]) => {
    const sessionPathForAutonomy = sessionPathRef.current;
    if (!sessionPathForAutonomy || aoiAppOpDispatchBridgeInFlightRef.current) {
      return;
    }
    aoiAppOpDispatchBridgeInFlightRef.current = true;
    try {
      const pending = await fetchAoiAppOperationDispatches(sessionPathForAutonomy);
      if (pending.length === 0) {
        return;
      }
      const proposalById = new Map(proposals.map((proposal) => [proposal.id, proposal]));
      await runAoiAppOperationDispatchBridge(pending, {
        lookupProposal: (proposalId) => proposalById.get(proposalId) ?? null,
        recomputeApprovalFingerprint: (proposal) => {
          const now = Date.now();
          const policy = getAoiApprovedAppActionPolicyForProposal(proposal, now);
          return {
            fingerprint: policy.approvalFingerprint,
            expiresAt: policy.expiresAt,
          };
        },
        deriveApprovedAction: (proposal) =>
          deriveAoiApprovedAppActionDispatchTarget(proposal.acceptAction?.params),
        now: () => Date.now(),
        dispatchToApp: async (record) => {
          // Only dispatch to an app already loaded in this client; otherwise leave the
          // record pending for a later refresh / another connected client (no auto-open).
          const isOpen = getWindows().some((win) => win.appId === record.appId);
          if (!isOpen) {
            return null;
          }
          const result = await dispatchAgentAction({
            app_id: record.appId,
            action_type: record.actionType,
            params: record.params,
          });
          if (typeof result === 'string' && result.startsWith('timeout:')) {
            // A no-response timeout is a transport failure, not an app action result.
            throw new Error(result);
          }
          return result;
        },
        reportResult: async (report) => {
          await reportAoiAppOperationDispatchResult(sessionPathForAutonomy, report);
        },
      });
    } catch (error) {
      // Best-effort: a bridge failure must never disrupt chat or the dashboard refresh.
      logger.warn('ChatPanel', 'Aoi app-operation dispatch bridge failed', error);
    } finally {
      aoiAppOpDispatchBridgeInFlightRef.current = false;
    }
  }, []);

  const refreshAoiAutonomy = useCallback(
    async (options: { silent?: boolean } = {}) => {
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
        const [snapshot, decisions, strategicBrief] = await Promise.all([
          fetchAoiAutonomyDashboard(sessionPathForAutonomy),
          fetchAoiProposalDecisions(sessionPathForAutonomy, 50),
          // Best-effort: a brief-route failure must not break the dashboard refresh.
          // goalWorkOrders are tick-only (not persisted), so only the brief reloads here.
          fetchAoiStrategicBrief(sessionPathForAutonomy).catch(() => null),
        ]);
        setAoiAutonomyStatus(snapshot.status);
        setAoiAutonomyActiveProposals(snapshot.proposals.active);
        setAoiAutonomyArchivedProposals(snapshot.proposals.archived);
        setAoiActiveOpportunities(snapshot.opportunities.active);
        setAoiArchivedOpportunities(snapshot.opportunities.archived);
        setAoiDeliberationRuns(snapshot.deliberations.runs);
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
        setAoiProactiveBriefs(snapshot.proactiveBriefs);
        setAoiFieldFeedback(snapshot.fieldFeedback);
        setAoiStrategicBrief(strategicBrief);
        // P2/B3-1 c3: after the dashboard refresh, run the client dispatch bridge over any
        // pending app-operation dispatches the loop queued, using the freshly-loaded proposals
        // for the approval re-check. No-op when the feature is off (no pending records).
        void runAoiAppOperationDispatchBridgeNow([
          ...snapshot.proposals.active,
          ...snapshot.proposals.archived,
        ]);
      } catch (error) {
        setAoiAutonomyError(error instanceof Error ? error.message : String(error));
      } finally {
        aoiAutonomyRefreshInFlightRef.current = false;
        if (!options.silent) {
          setAoiAutonomyLoading(false);
        }
      }
    },
    [runAoiAppOperationDispatchBridgeNow],
  );

  // P2.2: durable, reconnecting client dispatch bridge. While mounted, drain any pending
  // app-operation dispatches the daemon queued on a fixed interval (using the current proposals
  // for the approval re-check), so a dispatch does not wait for a manual refresh. Stable callback
  // reading refs so the interval never resets; the drain is best-effort so a transient failure
  // just retries next tick.
  const drainAoiDispatchBridge = useCallback(() => {
    void runAoiAppOperationDispatchBridgeNow([
      ...aoiAutonomyActiveProposalsRef.current,
      ...aoiAutonomyArchivedProposalsRef.current,
    ]);
  }, [runAoiAppOperationDispatchBridgeNow]);
  useAoiDurableDispatchBridge({
    drain: drainAoiDispatchBridge,
    intervalMs: AOI_DURABLE_DISPATCH_BRIDGE_INTERVAL_MS,
  });

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
    // Author generated proposals in the conversation language too (the tick
    // otherwise only sees latestUserMessage, which is empty before the user
    // types -- so a Korean persona-only chat would generate English proposals).
    const autonomyLanguage = deriveAoiCardLangFromMessages(
      chatHistoryRef.current,
      normalizeResponseLanguageMode(conversationPreferencesRef.current?.responseLanguageMode),
      getVibeInfo().systemSettings?.language?.current,
    );
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
        language: autonomyLanguage,
        ...(typeof userIdleMs === 'number' ? { userIdleMs } : {}),
      });
      if (sessionPathRef.current !== sessionPathForAutonomy) {
        return;
      }
      setAoiAutonomyStatus(result.status);
      setAoiAutonomyScheduler(result.state);
      setAoiAutonomyBlockedProposals(result.tickResult?.blockedProposals ?? []);
      setAoiStrategicBrief(result.tickResult?.strategicBrief ?? null);
      setAoiGoalWorkOrders(result.tickResult?.goalWorkOrders ?? []);
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

  const recordAoiFieldFeedbackFromPanel = useCallback(
    async (item: AoiOperatorFeedbackInboxPanelItem, label: AoiShadowDecisionLabel) => {
      const sessionPathForAutonomy = sessionPathRef.current;
      if (!sessionPathForAutonomy) {
        return;
      }
      const actionId = `field-feedback:${item.decisionRecordId}:${label}`;
      setAoiAutonomyActionId(actionId);
      setAoiAutonomyError('');
      try {
        const result = await recordAoiFieldFeedback(sessionPathForAutonomy, {
          decisionRecordId: item.decisionRecordId,
          decisionId: item.decisionId,
          fieldEventId: item.fieldEventId,
          opportunityId: item.opportunityId,
          topicKey: item.topicKey,
          sourceKey: item.sourceKey,
          deliveryMode: item.deliveryMode,
          label,
          sourceKinds: item.sourceKinds,
          evidenceRefs: item.evidenceRefs,
        });
        setAoiFieldFeedback(result);
        if (result.evaluation) {
          setAoiAutonomyEvaluation(result.evaluation);
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
      setAoiAutonomyPanelSettings((prev) => {
        const next = {
          ...prev,
          ...patch,
        };
        aoiAutonomyPanelSettingsRef.current = next;
        return next;
      });
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
        // Same derivation as the session-open wakeup: without it, a manual check
        // whose last user message is English (or absent) authors English cards
        // even though the operator converses in Korean.
        language: deriveAoiCardLangFromMessages(
          chatHistoryRef.current,
          normalizeResponseLanguageMode(conversationPreferencesRef.current?.responseLanguageMode),
          getVibeInfo().systemSettings?.language?.current,
        ),
      });
      setAoiAutonomyStatus(result.status);
      setAoiAutonomyScheduler(result.state);
      setAoiAutonomyBlockedProposals(result.tickResult?.blockedProposals ?? []);
      setAoiStrategicBrief(result.tickResult?.strategicBrief ?? null);
      setAoiGoalWorkOrders(result.tickResult?.goalWorkOrders ?? []);
      setAoiAutonomyLastTickAt(result.status.lastTickAt ?? result.record.completedAt);
      await refreshAoiAutonomy({ silent: true });
    } catch (error) {
      setAoiAutonomyError(error instanceof Error ? error.message : String(error));
    } finally {
      setAoiAutonomyLoading(false);
      setAoiAutonomyActionId(null);
    }
  }, [aoiAutonomyPanelSettings.quietMode, refreshAoiAutonomy]);

  const runAoiProactiveBriefScoutFromPanel = useCallback(async () => {
    const sessionPathForAutonomy = sessionPathRef.current;
    if (!sessionPathForAutonomy) {
      return;
    }
    setAoiAutonomyActionId('proactive-scout');
    setAoiAutonomyLoading(true);
    setAoiAutonomyError('');

    try {
      const result = await runAoiProactiveBriefScoutNow({
        sessionPath: sessionPathForAutonomy,
        quietMode: aoiAutonomyPanelSettings.quietMode,
      });
      setAoiAutonomyStatus(result.status);
      setAoiAutonomyScheduler(result.state);
      setAoiProactiveBriefs(result.proactiveBriefs);
      setAoiAutonomyLastTickAt(result.status.lastTickAt ?? result.record.completedAt);
      await refreshAoiAutonomy({ silent: true });
    } catch (error) {
      setAoiAutonomyError(error instanceof Error ? error.message : String(error));
    } finally {
      setAoiAutonomyLoading(false);
      setAoiAutonomyActionId(null);
    }
  }, [aoiAutonomyPanelSettings.quietMode, refreshAoiAutonomy]);

  const resetAoiProactiveBriefCooldownFromPanel = useCallback(async () => {
    const sessionPathForAutonomy = sessionPathRef.current;
    if (!sessionPathForAutonomy) {
      return;
    }
    setAoiAutonomyActionId('proactive-cooldown-reset');
    setAoiAutonomyError('');

    try {
      const result = await resetAoiProactiveBriefCooldown({
        sessionPath: sessionPathForAutonomy,
      });
      setAoiProactiveBriefs(result);
      await refreshAoiAutonomy({ silent: true });
    } catch (error) {
      setAoiAutonomyError(error instanceof Error ? error.message : String(error));
    } finally {
      setAoiAutonomyActionId(null);
    }
  }, [refreshAoiAutonomy]);

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
          // P1.1: an ignored proposal is a soft negative timing signal.
          const ignoredSignal = buildAoiProposalIgnoredSignal(result.proposal, {
            decisionId: result.decision.id,
          });
          if (ignoredSignal && aoiOutcomeJunctureTrackerRef.current.claim(ignoredSignal.key)) {
            void recordAoiOutcomeSignal(sessionPathForAutonomy, ignoredSignal.input).catch(
              () => {},
            );
          }
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

  const recordAoiProactiveBriefFeedbackFromPanel = useCallback(
    async (briefId: string, category: AoiProactiveBriefFeedbackCategory) => {
      const sessionPathForAutonomy = sessionPathRef.current;
      if (!sessionPathForAutonomy) {
        return;
      }
      const actionId = `proactive-brief:${briefId}:${category}`;
      setAoiAutonomyActionId(actionId);
      setAoiAutonomyError('');
      try {
        const result = await recordAoiProactiveBriefFeedback(sessionPathForAutonomy, {
          briefId,
          category,
        });
        setAoiProactiveBriefs(result);
        if (
          category === 'show_less' ||
          category === 'not_useful' ||
          category === 'wrong_timing' ||
          category === 'too_frequent' ||
          category === 'wrong_topic' ||
          category === 'mute_topic' ||
          category === 'archive_brief'
        ) {
          setAoiInlineHiddenAt(Date.now());
        }
      } catch (error) {
        setAoiAutonomyError(error instanceof Error ? error.message : String(error));
      } finally {
        setAoiAutonomyActionId(null);
      }
    },
    [],
  );

  const recordAoiProactiveTrendDeliveryFromPanel = useCallback(
    async (snapshotId: string, kind: AoiProactiveTrendDeliveryEventKind) => {
      const sessionPathForAutonomy = sessionPathRef.current;
      if (!sessionPathForAutonomy || !snapshotId) {
        return;
      }
      try {
        const result = await recordAoiProactiveTrendDeliveryEvent(sessionPathForAutonomy, {
          snapshotId,
          kind,
        });
        setAoiProactiveBriefs(result);
      } catch (error) {
        console.warn('[ChatPanel] Failed to record Aoi proactive trend delivery', error);
      }
    },
    [],
  );

  const rememberAoiTrendFollowUpContext = useCallback(
    (card: AoiProactiveTrendOpinionCard, prompt: string) => {
      const context = buildAoiProactiveTrendFollowUpContext(card, prompt);
      if (!context) {
        return;
      }
      pendingAoiTrendFollowUpRef.current = context;
      aoiTrendFollowUpContextsByPromptRef.current.set(context.prompt, context);
      if (aoiTrendFollowUpContextsByPromptRef.current.size > 24) {
        const oldestKey = aoiTrendFollowUpContextsByPromptRef.current.keys().next().value;
        if (oldestKey) {
          aoiTrendFollowUpContextsByPromptRef.current.delete(oldestKey);
        }
      }
    },
    [],
  );

  const registerAoiTrendSuggestedReplies = useCallback(
    (card: AoiProactiveTrendOpinionCard, prompts: string[]) => {
      for (const prompt of prompts) {
        const context = buildAoiProactiveTrendFollowUpContext(card, prompt);
        if (context) {
          aoiTrendFollowUpContextsByPromptRef.current.set(context.prompt, context);
        }
      }
      while (aoiTrendFollowUpContextsByPromptRef.current.size > 24) {
        const oldestKey = aoiTrendFollowUpContextsByPromptRef.current.keys().next().value;
        if (!oldestKey) {
          break;
        }
        aoiTrendFollowUpContextsByPromptRef.current.delete(oldestKey);
      }
    },
    [],
  );

  const consumeAoiTrendFollowUpContext = useCallback((messageText: string) => {
    const pending = pendingAoiTrendFollowUpRef.current;
    pendingAoiTrendFollowUpRef.current = null;
    if (pending?.prompt === messageText) {
      aoiTrendFollowUpContextsByPromptRef.current.delete(messageText);
      return pending;
    }
    return null;
  }, []);

  const registerAoiAgendaSuggestedReplies = useCallback(
    (nudge: AoiAgendaChatNudge, prompts: string[]) => {
      for (const prompt of prompts) {
        const context = buildAoiAgendaChatFollowUpContext(nudge, prompt);
        aoiAgendaFollowUpContextsByPromptRef.current.set(context.prompt, context);
      }
      while (aoiAgendaFollowUpContextsByPromptRef.current.size > 24) {
        const oldestKey = aoiAgendaFollowUpContextsByPromptRef.current.keys().next().value;
        if (!oldestKey) {
          break;
        }
        aoiAgendaFollowUpContextsByPromptRef.current.delete(oldestKey);
      }
    },
    [],
  );

  const consumeAoiAgendaFollowUpContext = useCallback((messageText: string) => {
    const pending = pendingAoiAgendaFollowUpRef.current;
    pendingAoiAgendaFollowUpRef.current = null;
    if (pending?.prompt === messageText) {
      aoiAgendaFollowUpContextsByPromptRef.current.delete(messageText);
      return pending;
    }
    return null;
  }, []);

  const recordAoiTrendFollowUpPromptUse = useCallback(
    (context: AoiProactiveTrendFollowUpContext | null) => {
      const briefId = context?.candidateId;
      const sessionPathForAutonomy = sessionPathRef.current;
      if (!briefId || !sessionPathForAutonomy) {
        return;
      }
      const category = classifyAoiProactiveTrendFollowUpFeedback(context.prompt);
      void recordAoiProactiveBriefFeedback(sessionPathForAutonomy, {
        briefId,
        category,
      })
        .then(setAoiProactiveBriefs)
        .catch((error) => {
          console.warn('[ChatPanel] Failed to record Aoi trend follow-up feedback', error);
        });
    },
    [],
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
    // Defer the initial autonomy dashboard load + session-open wakeup until the
    // browser is idle. These fire ~18 parallel dashboard reads plus a wakeup
    // tick; running them during initial mount competes with the module-graph
    // load for the browser's handful of connections and badly delays first paint
    // (worst on the Vite dev server). The session-open tick refreshes the
    // dashboard at its tail, and the in-flight guard dedupes the two, so a single
    // refresh reaches the UI once loading has settled.
    const cancelIdle = scheduleIdle(() => {
      void refreshAoiAutonomy({ silent: true });
      void runAoiAutonomySessionOpenTick();
    });
    const intervalId = window.setInterval(() => {
      void refreshAoiAutonomy({ silent: true });
    }, 300000);

    return () => {
      cancelIdle();
      window.clearInterval(intervalId);
    };
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
      const evt = event as {
        app_action?: {
          app_id: number;
          action_type: string;
          params?: Record<string, string>;
          trigger_by?: number;
        };
        action_result?: string;
      };
      // SA1.3: metadata-only live-activity capture, independent of the LLM
      // config (observing does not require a model). Best-effort: consent is
      // pre-checked here and re-enforced server-side; a rejection must never
      // break the interaction flow.
      if (
        evt.action_result === undefined &&
        evt.app_action &&
        isAoiActivityCaptureConsented(aoiEnvironmentSourcesRef.current)
      ) {
        const captureInput = mapAoiUserActionToActivityCapture(
          evt.app_action,
          (appId) => APP_REGISTRY.find((a) => a.appId === appId)?.appName ?? null,
        );
        if (captureInput) {
          void recordAoiActivityEvent(sessionPathRef.current, captureInput).catch(() => undefined);
        }
      }

      const cfg = configRef.current;
      if (!hasUsableLLMConfig(cfg)) return;

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

    // Deferred to browser-idle for the same reason as the autonomy load above:
    // the initial Kira scan + event drain must not compete with the module-graph
    // load during first paint.
    const cancelIdle = scheduleIdle(() => {
      if (disposed) return;
      void triggerKiraAutomationScan(sessionPath).catch((error) => {
        logger.error('ChatPanel', 'Initial Kira automation scan failed:', error);
      });
      void pollKiraAutomationEvents();
    });

    const timer = window.setInterval(() => {
      void pollKiraAutomationEvents();
    }, KIRA_AUTOMATION_POLL_INTERVAL_MS);

    return () => {
      disposed = true;
      cancelIdle();
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
  // Aoi idle music nudge state. The learning state is persisted in localStorage
  // (loaded once on mount); lastUserActivityAt drives the in-panel idle timer;
  // the pending-offer ref lets handleSend recognize a tapped play/dismiss chip.
  const idleMusicStateRef = useRef<AoiIdleMusicLearningState>(DEFAULT_AOI_IDLE_MUSIC_STATE);
  const lastUserActivityAtRef = useRef<number>(Date.now());
  const pendingIdleMusicOfferRef = useRef<PendingIdleMusicOffer | null>(null);

  const newsStateRef = useRef<AoiNewsLearningState>(DEFAULT_AOI_NEWS_STATE);
  const pendingNewsOfferRef = useRef<PendingNewsOffer | null>(null);
  const newsOfferInFlightRef = useRef(false);
  // R6.3: spacing for self-observations, which ride the news nudge's trigger.
  // Seeded with the default and hydrated in the effect below, like the other
  // nudge state -- a loader call here would re-read localStorage every render.
  const selfObservationStateRef = useRef<AoiSelfObservationState>(
    DEFAULT_AOI_SELF_OBSERVATION_STATE,
  );

  // Music taste: the user's own YouTube searches + answered taste polls, fed
  // into the idle-music recommendation (persisted in localStorage).
  const musicTasteStateRef = useRef<AoiMusicTasteState>(DEFAULT_AOI_MUSIC_TASTE_STATE);
  const pendingTastePollRef = useRef<PendingTastePoll | null>(null);

  // Preference poll: occasional multiple-choice questions about the user's
  // technical interests, working style, and personal tastes. The answer state is
  // the localStorage poll store (single source of truth, shared with the
  // preference dashboard); only the in-flight pending card is held in a ref.
  const pendingPreferencePollRef = useRef<PendingPreferencePoll | null>(null);

  useEffect(() => {
    idleMusicStateRef.current = loadAoiIdleMusicLearningState();
    newsStateRef.current = loadAoiNewsState();
    musicTasteStateRef.current = loadAoiMusicTasteState();
    selfObservationStateRef.current = loadAoiSelfObservationState();
    // Merge the server copy of the taste + idle-music learning state into this
    // browser's cache. Without this a fresh profile (in-app preview browser,
    // second PC) sees zero taste and its idle nudge degrades to pool picks.
    void hydrateAoiMusicStateFromCloud()
      .then((hydrated) => {
        if (hydrated) {
          musicTasteStateRef.current = hydrated.taste;
          idleMusicStateRef.current = hydrated.idleLearning;
        }
      })
      .catch(() => {
        // Config API unavailable: the localStorage state loaded above stands.
      });
    // Nudge cards and their chips are restored from chat history, so a pending
    // offer must survive a reload too; otherwise a restored play chip skips the
    // accept path and falls through to the generic intent parser.
    if (!pendingIdleMusicOfferRef.current) {
      pendingIdleMusicOfferRef.current = loadPendingIdleMusicOffer();
    }
    if (!pendingNewsOfferRef.current) {
      pendingNewsOfferRef.current = loadPendingNewsOffer();
    }
    if (!pendingTastePollRef.current) {
      pendingTastePollRef.current = loadPendingTastePoll();
    }
    if (!pendingPreferencePollRef.current) {
      pendingPreferencePollRef.current = loadPendingPreferencePoll();
    }
  }, []);

  // Learn music taste from the user's own YouTube searches and plays. Subscribes
  // to the raw app-action stream: agent-triggered actions carry trigger_by=2 and
  // are skipped, so Aoi's own recommendations never feed back into the profile.
  // Deliberately independent of the LLM config -- taste learning works offline.
  useEffect(() => {
    const unsubscribe = onUserAction((event: unknown) => {
      const evt = event as {
        app_action?: {
          app_id: number;
          action_type: string;
          params?: Record<string, string>;
          trigger_by?: number;
        };
        action_result?: string;
      };
      if (evt.action_result !== undefined) return;
      const action = evt.app_action;
      if (!action || action.trigger_by === 2) return;
      if (action.app_id !== YOUTUBE_APP_ID) return;

      if (action.action_type === 'OPEN_SEARCH') {
        const next = recordYouTubeSearch(musicTasteStateRef.current, {
          query: action.params?.query ?? '',
        });
        if (next !== musicTasteStateRef.current) {
          musicTasteStateRef.current = next;
          saveAoiMusicTasteState(next);
        }
        return;
      }

      // PLAY_VIDEO is a reported event (user picked a result / started queue play).
      if (action.action_type === 'PLAY_VIDEO') {
        const next = recordYouTubePlay(musicTasteStateRef.current, {
          title: action.params?.title ?? '',
          channel: action.params?.channel ?? '',
          query: action.params?.query ?? '',
        });
        if (next !== musicTasteStateRef.current) {
          musicTasteStateRef.current = next;
          saveAoiMusicTasteState(next);
        }
      }
    });
    return unsubscribe;
  }, []);

  // Language for idle-music copy, resolved from the latest user turn like TTS.
  const resolveNudgeLang = useCallback((): NudgeLang => {
    // Match the proactive card: derive from the whole conversation (any role, so
    // a Korean persona turn counts even before the user types), then the app
    // language, then English. Otherwise idle music / news nudges default to
    // English when there is no user message yet.
    return deriveAoiCardLangFromMessages(
      chatHistoryRef.current,
      normalizeResponseLanguageMode(conversationPreferencesRef.current?.responseLanguageMode),
      getVibeInfo().systemSettings?.language?.current,
    );
  }, []);

  // Aoi self-expands the preference bank from what it already knows (interest
  // profile + memories): deterministic "how deep?" questions always, plus
  // LLM-authored questions/categories when a usable chat config is set. Auto-runs
  // behind a cooldown when the answerable pool is low, and on demand from the
  // dashboard (manual=true bypasses the cooldown). Best-effort; never throws.
  const runPreferenceBankExpansion = useCallback(
    async (options?: { manual?: boolean }): Promise<number> => {
      const sessionPathForGen = sessionPathRef.current;
      if (!sessionPathForGen) {
        return 0;
      }
      const now = Date.now();
      const existing = loadAoiGeneratedQuestionsState();
      if (
        !options?.manual &&
        existing.lastGeneratedAt > 0 &&
        now - existing.lastGeneratedAt < GENERATED_EXPANSION_COOLDOWN_MS
      ) {
        return 0;
      }
      let memories: AoiMemoryEntry[] = [];
      try {
        memories = await loadAoiMemories();
      } catch {
        memories = [];
      }
      const activeMemories = memories.filter(
        (memory) =>
          memory.status === 'active' &&
          (!memory.sessionPath || memory.sessionPath === sessionPathForGen),
      );
      const lang = resolveNudgeLang();
      const pollState = loadAoiPreferencePollState();
      // The question currently awaiting an answer must survive the merge cap
      // like an answered one, or the user's tap on the still-visible card would
      // record nothing after this expansion prunes it.
      const pendingQuestionId = pendingPreferencePollRef.current?.questionId;
      const { state: nextGen, addedCount } = await expandAoiPreferenceQuestionBank({
        memories: activeMemories,
        existing,
        seedPrompts: PREFERENCE_POLL_QUESTIONS.map((question) => question.prompts[lang]),
        answeredIds: [
          ...Object.keys(pollState.answers),
          ...(pendingQuestionId ? [pendingQuestionId] : []),
        ],
        lang,
        llmConfig: config,
        now,
      });
      saveAoiGeneratedQuestionsState(nextGen);
      return addedCount;
    },
    [resolveNudgeLang, config],
  );

  const executeSend = useCallback(
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
      // Any send (typed or a tapped chip) counts as activity: reset the idle clock.
      lastUserActivityAtRef.current = Date.now();
      // SA1.3: metadata-only chat-turn marker ("a turn happened", never the
      // content). Consent-gated client-side and re-enforced server-side.
      if (isAoiActivityCaptureConsented(aoiEnvironmentSourcesRef.current)) {
        void recordAoiActivityEvent(sessionPathRef.current, { kind: 'chat_turn' }).catch(
          () => undefined,
        );
      }
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

      const aoiTrendFollowUpContext = !hasImageAttachments
        ? consumeAoiTrendFollowUpContext(messageText)
        : null;
      const aoiAgendaFollowUpContext =
        !hasImageAttachments && !aoiTrendFollowUpContext
          ? consumeAoiAgendaFollowUpContext(messageText)
          : null;
      if (!overrideText) {
        setInput('');
        clearPendingImages();
      }
      setSuggestedReplies([]);
      if (aoiTrendFollowUpContext) {
        recordAoiTrendFollowUpPromptUse(aoiTrendFollowUpContext);
      } else if (aoiAgendaFollowUpContext) {
        aoiTrendFollowUpContextsByPromptRef.current.clear();
      } else {
        aoiTrendFollowUpContextsByPromptRef.current.clear();
        aoiAgendaFollowUpContextsByPromptRef.current.clear();
        // P1.1: the user sent an unrelated message while a direct-chat card was
        // offered -> record it as an implicit dismissal (once per card).
        const offeredDirectChatCard = aoiOfferedDirectChatCardRef.current;
        if (offeredDirectChatCard) {
          const dismissedSignal = buildAoiDirectChatDismissedSignal(offeredDirectChatCard);
          if (dismissedSignal && aoiOutcomeJunctureTrackerRef.current.claim(dismissedSignal.key)) {
            void recordAoiOutcomeSignal(sessionPathRef.current, dismissedSignal.input).catch(
              () => {},
            );
          }
        }
      }
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

      if (aoiAgendaFollowUpContext) {
        const response = buildAoiAgendaChatFollowUpResponse({
          context: aoiAgendaFollowUpContext,
          activeProposals: aoiAutonomyActiveProposalsRef.current,
          blockedProposals: aoiAutonomyBlockedProposalsRef.current,
          digest: aoiOperatorDigestRef.current,
        });
        const nextAgendaNudgeCalibration = recordAoiAgendaNudgeFeedback(
          aoiAutonomyPanelSettingsRef.current.agendaNudgeCalibration,
          {
            kind: response.feedbackKind,
            reason: response.intent,
            dedupeKey: aoiAgendaFollowUpContext.nudge.dedupeKey,
          },
        );
        updateAoiAutonomyPanelSettingsFromPanel({
          ...(response.shouldEnableQuietMode ? { quietMode: true } : {}),
          agendaNudgeCalibration: nextAgendaNudgeCalibration,
        });
        if (response.suggestedReplies.length > 0) {
          registerAoiAgendaSuggestedReplies(
            aoiAgendaFollowUpContext.nudge,
            response.suggestedReplies,
          );
        }
        emitAssistantMessage(
          {
            id: String(Date.now()),
            role: 'assistant',
            content: response.chatText,
            ...(response.suggestedReplies.length > 0
              ? { suggestedReplies: response.suggestedReplies }
              : {}),
          },
          {
            updateSuggestedReplies: response.suggestedReplies.length > 0,
          },
        );
        recordAoiMemoryTurn({
          userMessage: messageText,
          assistantMessage: response.chatText,
          toolCalls: [
            `direct:aoi_agenda_followup:${response.intent}:${aoiAgendaFollowUpContext.nudge.dedupeKey}`,
          ],
          source: 'direct_action',
          llmConfig: selectedConfig,
        });
        return;
      }

      if (
        aoiTrendFollowUpContext &&
        shouldListAoiProactiveTrendSourcesFromPrompt(aoiTrendFollowUpContext.prompt)
      ) {
        const sourcesToList = selectAoiProactiveTrendSourcesToList(aoiTrendFollowUpContext);
        const ack = buildAoiProactiveTrendSourceListText(aoiTrendFollowUpContext, sourcesToList);
        emitAssistantMessage({
          id: String(Date.now()),
          role: 'assistant',
          content: ack,
        });
        recordAoiMemoryTurn({
          userMessage: text,
          assistantMessage: ack,
          toolCalls:
            sourcesToList.length === aoiTrendFollowUpContext.sources.length
              ? [`direct:aoi_trend_list_sources:${aoiTrendFollowUpContext.cardId}`]
              : sourcesToList.map((source) => `direct:aoi_trend_list_source:${source.url}`),
          source: 'direct_action',
          llmConfig: selectedConfig,
        });
        return;
      }

      if (
        aoiTrendFollowUpContext &&
        shouldOpenAoiProactiveTrendSourcesFromPrompt(aoiTrendFollowUpContext.prompt)
      ) {
        const sourcesToOpen = selectAoiProactiveTrendSourcesToOpen(aoiTrendFollowUpContext);
        if (sourcesToOpen.length > 0) {
          const actionResults: Array<{
            source: AoiProactiveTrendFollowUpSource;
            result: string;
          }> = [];
          for (const sourceToOpen of sourcesToOpen) {
            let actionResult = '';
            try {
              actionResult = await dispatchAgentAction(buildOpenUrlAction(sourceToOpen.url));
            } catch (error) {
              actionResult = `error: ${error instanceof Error ? error.message : String(error)}`;
              console.error('[ChatPanel] Failed to open Aoi trend source URL', error);
            }
            actionResults.push({
              source: sourceToOpen,
              result: actionResult,
            });
          }
          const ack = buildAoiTrendSourcesOpenAck({
            context: aoiTrendFollowUpContext,
            results: actionResults,
          });
          emitAssistantMessage({
            id: String(Date.now()),
            role: 'assistant',
            content: ack,
          });
          recordAoiMemoryTurn({
            userMessage: text,
            assistantMessage: ack,
            toolCalls: sourcesToOpen.map((source) => `direct:aoi_trend_open_source:${source.url}`),
            source: 'direct_action',
            llmConfig: selectedConfig,
          });
          return;
        }

        const ack = buildAoiProactiveTrendSourceOpenUnavailableText(aoiTrendFollowUpContext);
        emitAssistantMessage({
          id: String(Date.now()),
          role: 'assistant',
          content: ack,
        });
        recordAoiMemoryTurn({
          userMessage: text,
          assistantMessage: ack,
          toolCalls: [
            `direct:aoi_trend_open_sources_unavailable:${aoiTrendFollowUpContext.cardId}`,
          ],
          source: 'direct_action',
          llmConfig: selectedConfig,
        });
        return;
      }

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

      // Aoi taste poll: a tapped option chip is recorded straight into the taste
      // profile (no LLM round-trip). Any other message is an implicit dismissal:
      // the cooldown was already stamped when the poll was asked, so Aoi simply
      // will not re-ask for a while and the message is handled normally below.
      const pendingTastePoll = pendingTastePollRef.current;
      if (pendingTastePoll) {
        pendingTastePollRef.current = null;
        savePendingTastePoll(null);
        const chosen = pendingTastePoll.options.find((option) => option.label === messageText);
        if (chosen) {
          musicTasteStateRef.current = recordTasteAnswer(musicTasteStateRef.current, {
            questionId: pendingTastePoll.questionId,
            optionId: chosen.id,
          });
          saveAoiMusicTasteState(musicTasteStateRef.current);
          const ack = buildTastePollAck(chosen.label, resolveNudgeLang());
          emitAssistantMessage({ id: String(Date.now()), role: 'assistant', content: ack });
          recordAoiMemoryTurn({
            userMessage: messageText,
            assistantMessage: ack,
            toolCalls: ['direct:aoi_taste_poll_answer'],
            source: 'direct_action',
            llmConfig: selectedConfig,
          });
          return;
        }
      }

      // Aoi preference poll: a tapped option chip is recorded into the poll state
      // and persisted as a structured preference memory (no LLM round-trip), so it
      // flows into the interest profile / curiosity engine / preference context
      // for later judgments. Any other message is an implicit dismissal: the
      // cooldown was already stamped when the poll was asked. A chip whose
      // question was pruned from the bank between ask and answer records nothing,
      // so it gets an honest "expired" ack instead of a false "remembered".
      const pendingPreferencePoll = pendingPreferencePollRef.current;
      if (pendingPreferencePoll) {
        pendingPreferencePollRef.current = null;
        savePendingPreferencePoll(null);
        const lang = resolveNudgeLang();
        const resolution = resolvePreferencePollAnswer(
          pendingPreferencePoll,
          { messageText, state: loadAoiPreferencePollState(), lang },
          generatedQuestionsToSeedShape(loadAoiGeneratedQuestionsState()),
        );
        if (resolution.kind === 'recorded') {
          saveAoiPreferencePollState(resolution.nextState);
          void syncAoiMemoryFromPreferencePoll(sessionPathRef.current, {
            questionId: pendingPreferencePoll.questionId,
            optionLabel: resolution.chosenLabel,
            candidate: resolution.candidate,
            prefKey: resolution.prefKey ?? undefined,
            embeddingProvider: aoiEmbeddingProviderRef.current,
          })
            .then(setAoiMemories)
            .catch((error) => {
              console.warn('[ChatPanel] Aoi preference poll memory sync failed', error);
            });
          const ack = buildPreferencePollAck(resolution.chosenLabel, lang);
          emitAssistantMessage({ id: String(Date.now()), role: 'assistant', content: ack });
          return;
        }
        if (resolution.kind === 'expired') {
          emitAssistantMessage({
            id: String(Date.now()),
            role: 'assistant',
            content: buildPreferencePollExpiredAck(lang),
          });
          return;
        }
      }

      // Aoi idle music nudge: answer a pending "want some music?" offer here so a
      // tapped chip does not fall through to the LLM. Play dispatches the exact
      // recommended query (no parser round-trip); dismiss / anything-else folds an
      // accept(+) / skip(-) signal into the learning state.
      const pendingIdleMusicOffer = pendingIdleMusicOfferRef.current;
      if (pendingIdleMusicOffer) {
        pendingIdleMusicOfferRef.current = null;
        savePendingIdleMusicOffer(null);
        if (messageText === pendingIdleMusicOffer.playPrompt) {
          idleMusicStateRef.current = recordIdleMusicOutcome(idleMusicStateRef.current, {
            mood: pendingIdleMusicOffer.mood,
            accepted: true,
          });
          saveAoiIdleMusicLearningState(idleMusicStateRef.current);
          const lang = resolveNudgeLang();
          try {
            await dispatchAgentAction({
              app_id: YOUTUBE_APP_ID,
              action_type: 'OPEN_SEARCH',
              params: { query: pendingIdleMusicOffer.query, autoplay: '1' },
            });
            const ack = buildIdleMusicPlayAck(pendingIdleMusicOffer.query, lang);
            emitAssistantMessage({ id: String(Date.now()), role: 'assistant', content: ack });
            recordAoiMemoryTurn({
              userMessage: messageText,
              assistantMessage: ack,
              toolCalls: ['direct:aoi_idle_music_play'],
              source: 'direct_action',
              llmConfig: selectedConfig,
            });
          } catch (err) {
            console.error('[ChatPanel] Idle music play dispatch failed', err);
            emitAssistantMessage({
              id: String(Date.now()),
              role: 'assistant',
              content: buildIdleMusicErrorAck(lang),
            });
          }
          return;
        }
        if (messageText === pendingIdleMusicOffer.dismissPrompt) {
          idleMusicStateRef.current = recordIdleMusicOutcome(idleMusicStateRef.current, {
            mood: pendingIdleMusicOffer.mood,
            accepted: false,
          });
          saveAoiIdleMusicLearningState(idleMusicStateRef.current);
          // "Another" style chips re-roll a taste-backed pick; soft "later" chips just stop.
          const wantsAnother = /다른|別|换一|Another/i.test(messageText);
          if (wantsAnother) {
            const now = Date.now();
            const taste = deriveTasteProfile(musicTasteStateRef.current);
            const recommendation = buildAoiMusicRecommendation({
              now,
              recentQueries: idleMusicStateRef.current.recentQueries,
              moodFeedback: idleMusicStateRef.current.moodFeedback,
              tasteMoodBias: taste.moodBias,
              personalQueries: taste.personalQueries,
              preferPersonal: true,
            });
            const lang = resolveNudgeLang() as AoiTasteLang;
            const copy = buildAoiMusicTasteRecommendCopy({
              query: recommendation.query,
              source: recommendation.source,
              lang,
              autoplay: false,
            });
            idleMusicStateRef.current = recordIdleMusicOffered(idleMusicStateRef.current, {
              query: recommendation.query,
              now,
            });
            saveAoiIdleMusicLearningState(idleMusicStateRef.current);
            pendingIdleMusicOfferRef.current = {
              playPrompt: copy.playPrompt,
              dismissPrompt: copy.dismissPrompt,
              query: recommendation.query,
              mood: recommendation.mood,
            };
            savePendingIdleMusicOffer(pendingIdleMusicOfferRef.current);
            emitAssistantMessage(
              {
                id: `aoi-taste-music-${now}`,
                role: 'assistant',
                content: copy.text,
                suggestedReplies: [copy.playPrompt, copy.dismissPrompt],
              },
              { updateSuggestedReplies: true, speak: false },
            );
            return;
          }
          emitAssistantMessage({
            id: String(Date.now()),
            role: 'assistant',
            content: buildIdleMusicDismissAck(resolveNudgeLang()),
          });
          return;
        }
        // Implicit skip: the user moved on to something else. Record the signal
        // and fall through so their actual message is handled normally.
        idleMusicStateRef.current = recordIdleMusicOutcome(idleMusicStateRef.current, {
          mood: pendingIdleMusicOffer.mood,
          accepted: false,
        });
        saveAoiIdleMusicLearningState(idleMusicStateRef.current);
      }

      // Aoi cyber-news nudge: answer a pending "interesting news?" offer here.
      // Interested -> open the exact article in CyberNews (VIEW_ARTICLE, which
      // refreshes if needed); dismiss / anything-else folds an accept(+)/skip(-)
      // signal per category into the learning state.
      const pendingNewsOffer = pendingNewsOfferRef.current;
      if (pendingNewsOffer) {
        pendingNewsOfferRef.current = null;
        savePendingNewsOffer(null);
        if (messageText === pendingNewsOffer.playPrompt) {
          newsStateRef.current = recordNewsOutcome(newsStateRef.current, {
            category: pendingNewsOffer.category,
            accepted: true,
          });
          saveAoiNewsState(newsStateRef.current);
          const lang = resolveNudgeLang();
          try {
            await dispatchAgentAction({
              app_id: CYBERNEWS_APP_ID,
              action_type: 'VIEW_ARTICLE',
              params: { articleId: pendingNewsOffer.articleId },
            });
            const ack = buildNewsOpenAck(pendingNewsOffer.title, lang);
            emitAssistantMessage({ id: String(Date.now()), role: 'assistant', content: ack });
            recordAoiMemoryTurn({
              userMessage: messageText,
              assistantMessage: ack,
              toolCalls: ['direct:aoi_news_open'],
              source: 'direct_action',
              llmConfig: selectedConfig,
            });
          } catch (err) {
            console.error('[ChatPanel] Idle news open dispatch failed', err);
            emitAssistantMessage({
              id: String(Date.now()),
              role: 'assistant',
              content: buildNewsErrorAck(lang),
            });
          }
          return;
        }
        if (messageText === pendingNewsOffer.dismissPrompt) {
          newsStateRef.current = recordNewsOutcome(newsStateRef.current, {
            category: pendingNewsOffer.category,
            accepted: false,
          });
          saveAoiNewsState(newsStateRef.current);
          emitAssistantMessage({
            id: String(Date.now()),
            role: 'assistant',
            content: buildNewsDismissAck(resolveNudgeLang()),
          });
          return;
        }
        newsStateRef.current = recordNewsOutcome(newsStateRef.current, {
          category: pendingNewsOffer.category,
          accepted: false,
        });
        saveAoiNewsState(newsStateRef.current);
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
            params: { query: directMusicIntent.query, autoplay: '1' },
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

      // Genre/lane chip after a preference ask (e.g. "케이팝") becomes a personal
      // search seed, then we recommend from that lane instead of a mood pool.
      if (!hasImageAttachments) {
        const preferenceSeed = parseAoiMusicPreferenceSeed(text);
        if (preferenceSeed) {
          const seeded = recordYouTubeSearch(musicTasteStateRef.current, {
            query: preferenceSeed,
          });
          if (seeded !== musicTasteStateRef.current) {
            musicTasteStateRef.current = seeded;
            saveAoiMusicTasteState(seeded);
          }
          const now = Date.now();
          const taste = deriveTasteProfile(musicTasteStateRef.current);
          const recommendation = buildAoiMusicRecommendation({
            now,
            recentQueries: idleMusicStateRef.current.recentQueries,
            moodFeedback: idleMusicStateRef.current.moodFeedback,
            tasteMoodBias: taste.moodBias,
            personalQueries: taste.personalQueries,
            preferPersonal: true,
          });
          const lang = resolveNudgeLang() as AoiTasteLang;
          const copy = buildAoiMusicTasteRecommendCopy({
            query: recommendation.query,
            source: recommendation.source,
            lang,
            autoplay: false,
          });
          idleMusicStateRef.current = recordIdleMusicOffered(idleMusicStateRef.current, {
            query: recommendation.query,
            now,
          });
          saveAoiIdleMusicLearningState(idleMusicStateRef.current);
          pendingIdleMusicOfferRef.current = {
            playPrompt: copy.playPrompt,
            dismissPrompt: copy.dismissPrompt,
            query: recommendation.query,
            mood: recommendation.mood,
          };
          savePendingIdleMusicOffer(pendingIdleMusicOfferRef.current);
          emitAssistantMessage(
            {
              id: `aoi-taste-seed-${now}`,
              role: 'assistant',
              content: copy.text,
              suggestedReplies: [copy.playPrompt, copy.dismissPrompt],
            },
            { updateSuggestedReplies: true, speak: false },
          );
          recordAoiMemoryTurn({
            userMessage: text,
            assistantMessage: copy.text,
            toolCalls: [
              `direct:aoi_taste_music_seed:${recommendation.source}:${recommendation.query}`,
            ],
            source: 'direct_action',
            llmConfig: selectedConfig,
          });
          return;
        }
      }

      // Taste-backed chat music recommend / "play something" after specific-title
      // intents. Uses the same recommender as idle cards so free-form LLM guesses
      // are not used for bare "노래 추천해줘" / "아무거나 틀어줘" style requests.
      const tasteChatIntent = !hasImageAttachments
        ? parseAoiMusicTasteChatIntent(text)
        : { kind: 'none' as const };
      if (tasteChatIntent.kind === 'recommend') {
        const now = Date.now();
        const taste = deriveTasteProfile(musicTasteStateRef.current);
        const lang = resolveNudgeLang() as AoiTasteLang;
        // No personal searches/plays/poll seeds yet -> never invent a generic
        // mood-pool mix (e.g. "sunset chill beats"). Ask for a lane first.
        if (taste.personalQueries.length === 0) {
          const need = buildAoiMusicTasteNeedPreferenceCopy(lang);
          emitAssistantMessage(
            {
              id: `aoi-taste-need-${now}`,
              role: 'assistant',
              content: need.text,
              suggestedReplies: need.suggestedReplies,
            },
            { updateSuggestedReplies: true, speak: false },
          );
          recordAoiMemoryTurn({
            userMessage: text,
            assistantMessage: need.text,
            toolCalls: ['direct:aoi_taste_music_need_preference'],
            source: 'direct_action',
            llmConfig: selectedConfig,
          });
          return;
        }
        const recommendation = buildAoiMusicRecommendation({
          now,
          recentQueries: idleMusicStateRef.current.recentQueries,
          moodFeedback: idleMusicStateRef.current.moodFeedback,
          tasteMoodBias: taste.moodBias,
          personalQueries: taste.personalQueries,
          preferPersonal: true,
        });
        const copy = buildAoiMusicTasteRecommendCopy({
          query: recommendation.query,
          source: recommendation.source,
          lang,
          autoplay: tasteChatIntent.autoplay,
        });
        idleMusicStateRef.current = recordIdleMusicOffered(idleMusicStateRef.current, {
          query: recommendation.query,
          now,
        });
        saveAoiIdleMusicLearningState(idleMusicStateRef.current);

        if (tasteChatIntent.autoplay) {
          try {
            await dispatchAgentAction({
              app_id: YOUTUBE_APP_ID,
              action_type: 'OPEN_SEARCH',
              params: { query: recommendation.query, autoplay: '1' },
            });
            emitAssistantMessage({
              id: String(now),
              role: 'assistant',
              content: copy.text,
              suggestedReplies: [copy.dismissPrompt],
            });
            recordAoiMemoryTurn({
              userMessage: text,
              assistantMessage: copy.text,
              toolCalls: [
                `direct:aoi_taste_music_play:${recommendation.source}:${recommendation.query}`,
              ],
              source: 'direct_action',
              llmConfig: selectedConfig,
            });
          } catch (err) {
            console.error('[ChatPanel] Taste music autoplay dispatch failed', err);
            emitAssistantMessage({
              id: String(now),
              role: 'assistant',
              content: buildIdleMusicErrorAck(lang),
            });
          }
          return;
        }

        pendingIdleMusicOfferRef.current = {
          playPrompt: copy.playPrompt,
          dismissPrompt: copy.dismissPrompt,
          query: recommendation.query,
          mood: recommendation.mood,
        };
        savePendingIdleMusicOffer(pendingIdleMusicOfferRef.current);
        emitAssistantMessage(
          {
            id: `aoi-taste-music-${now}`,
            role: 'assistant',
            content: copy.text,
            suggestedReplies: [copy.playPrompt, copy.dismissPrompt],
          },
          { updateSuggestedReplies: true, speak: false },
        );
        recordAoiMemoryTurn({
          userMessage: text,
          assistantMessage: copy.text,
          toolCalls: [
            `direct:aoi_taste_music_recommend:${recommendation.source}:${recommendation.query}`,
          ],
          source: 'direct_action',
          llmConfig: selectedConfig,
        });
        return;
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
          aoiTrendFollowUpContext,
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
          content: formatChatErrorNotice(err),
          ephemeral: true,
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
      consumeAoiAgendaFollowUpContext,
      consumeAoiTrendFollowUpContext,
      emitAssistantMessage,
      finishChatLoading,
      publishAoiRunLedgerEntry,
      recordAoiMemoryTurn,
      recordAoiTrendFollowUpPromptUse,
      registerAoiAgendaSuggestedReplies,
      refreshAoiMemories,
      refreshConversationConfigs,
      updateChatLoadingStatus,
      updateAoiAutonomyPanelSettingsFromPanel,
    ],
  );

  const handleSend = useCallback(
    async (overrideText?: string) => {
      if (manualConversationTurnInFlightRef.current) {
        logger.warn('ChatPanel', 'Ignored a duplicate send while a manual turn is in flight.');
        return;
      }
      manualConversationTurnInFlightRef.current = true;
      try {
        await executeSend(overrideText);
      } finally {
        manualConversationTurnInFlightRef.current = false;
      }
    },
    [executeSend],
  );

  const handleAoiTrendFollowUpPrompt = useCallback(
    (card: AoiProactiveTrendOpinionCard, prompt: string) => {
      rememberAoiTrendFollowUpContext(card, prompt);
      void handleSend(prompt);
    },
    [handleSend, rememberAoiTrendFollowUpContext],
  );

  const handleSuggestedReply = useCallback(
    (reply: string) => {
      const context = aoiTrendFollowUpContextsByPromptRef.current.get(reply);
      if (context) {
        pendingAoiTrendFollowUpRef.current = context;
      } else {
        const agendaContext = aoiAgendaFollowUpContextsByPromptRef.current.get(reply);
        if (agendaContext) {
          pendingAoiAgendaFollowUpRef.current = agendaContext;
        }
      }
      void handleSend(reply);
    },
    [handleSend],
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
    const outcomeFeedbackContract = parseAoiOutcomeFeedbackContract(latestUserMessage);
    const selectedConversationModel = selectConversationModel(history, cfg, dialogCfg);
    const useDialogModel =
      selectedConversationModel.useDialogModel && outcomeFeedbackContract === null;
    const activeCfg = useDialogModel ? selectedConversationModel.config : cfg;
    if (!hasUsableLLMConfig(activeCfg)) {
      throw new Error('No usable LLM config was found for this conversation turn.');
    }
    const toolCallRuntimeAvailable = supportsStructuredConversationTools(activeCfg);
    const activeModelRoute: PromptBudgetEntry['modelRoute'] = useDialogModel ? 'dialog' : 'main';
    const confirmedActionRequest = resolveAoiActionConfirmationRequest(latestUserMessage, history);
    const fileTaskContract = resolveAoiFileTaskContract({
      latestUserMessage,
      history,
      confirmedActionRequest,
    });
    const liveFieldTruthRequested = shouldLoadAoiLiveFieldTruth(
      [latestUserMessage, confirmedActionRequest ?? '', fileTaskContract?.sourceMessage ?? ''].join(
        '\n',
      ),
    );
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
            ...(outcomeFeedbackContract ? [getAoiOutcomeFeedbackToolDefinition()] : []),
            ...(hasTavily ? getTavilyToolDefinitions() : []),
            ...(hasResearchTools ? getAoiResearchToolDefinitions() : []),
            ...(hasImageGen ? getImageGenToolDefinitions() : []),
            ...getHostProcessToolDefinitions(),
            ...getHostBrowserToolDefinitions(),
            ...getBrowserDriveToolDefinitions(),
            ...getBrowserDriveActToolDefinitions(),
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
                  ...getAppIntentToolDefinitions(),
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
    const runGoal = createAoiRunGoalFromMessage(
      fileTaskContract?.sourceMessage ?? confirmedActionRequest ?? latestUserMessage,
    );
    const runGoalPrompt = buildAoiRunGoalPrompt(runGoal);
    const activeSkillMatches = resolveAoiActiveSkills(latestUserMessage, aoiSkillsRef.current);
    // P5.8: append the read-only tools registered by trusted skills as advisory capability
    // context (always available, not trigger-gated). Empty when no skill registers a tool.
    const skillsPrompt =
      buildAoiSkillsPrompt(activeSkillMatches) +
      buildAoiRegisteredSkillToolsCatalog(resolveAoiRegisteredSkillTools(aoiSkillsRef.current));
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
    // Best-effort semantic recall: embed the query so paraphrases retrieve the
    // right memory. Null provider / failure falls back to lexical ranking.
    const aoiQueryEmbedding = await embedAoiQuery(
      latestUserMessage,
      aoiEmbeddingProviderRef.current,
    );
    throwIfConversationAborted(options.signal);
    // R3.1: episodes have always been written but never read back. Load a
    // bounded recent window so relevant past exchanges can be referred to by
    // when they happened. Best-effort -- a failure just omits the block.
    let recentAoiEpisodes: AoiMemoryEpisode[] = [];
    try {
      recentAoiEpisodes = await loadAoiRecentMemoryEpisodes(sessionPathRef.current);
    } catch (error) {
      console.warn('[ChatPanel] Failed to load Aoi shared episodes', error);
    }
    throwIfConversationAborted(options.signal);
    const currentAoiMemoryPrompt = buildAoiMemoryPrompt(latestAoiMemories, latestUserMessage, {
      queryEmbedding: aoiQueryEmbedding,
      queryEmbeddingModel: aoiEmbeddingProviderRef.current?.model ?? null,
      episodes: recentAoiEpisodes,
    });
    // R5.1: Aoi's own side. Agent-scope memories are what she actually
    // researched, so they are the one self-side material that can be evidence-
    // backed; crossing them with the user's interest topics is what makes "I
    // looked into that too" a fact rather than flattery. Both inputs are already
    // in hand, and an empty result contributes no block at all.
    const aoiSelfProfile = buildAoiSelfProfile({
      now: Date.now(),
      sources: buildAoiSelfInquirySourcesFromMemories(latestAoiMemories),
    });
    const currentAoiSelfPrompt = buildAoiSelfProfilePromptBlock({
      profile: aoiSelfProfile,
      sharedInterests: findAoiSharedInterests(
        aoiSelfProfile,
        aoiProactiveBriefsRef.current?.profile?.topics ?? [],
      ),
    });
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
    let currentAoiLiveFieldTruthPrompt = '';
    let currentAoiLiveFieldScorecard: AoiNonVoiceJarvisScorecard | null = null;
    if (liveFieldTruthRequested) {
      try {
        updateStatus('Loading canonical live-field scorecard');
        const liveFieldTruth = await loadAoiLiveFieldTruth(sessionPathRef.current, {
          signal: options.signal,
        });
        throwIfConversationAborted(options.signal);
        currentAoiLiveFieldScorecard = liveFieldTruth.scorecard;
        currentAoiLiveFieldTruthPrompt = buildAoiLiveFieldTruthPrompt(liveFieldTruth.scorecard);
      } catch (error) {
        if (isChatAbortError(error)) {
          throw error;
        }
        const reason = error instanceof Error ? error.message : String(error);
        console.warn('[ChatPanel] Failed to load canonical live-field scorecard', error);
        currentAoiLiveFieldTruthPrompt = buildAoiLiveFieldTruthUnavailablePrompt(reason);
      }
    }
    const currentAoiGovernorPrompt = buildAoiJarvisAutonomyGovernorPromptBlock({
      decision: aoiJarvisAutonomyGovernor,
      trail: aoiAutonomyPanelSettingsRef.current.jarvisAutonomyGovernorAuditTrail,
      latestUserMessage,
    });
    const currentAoiMusicTastePrompt = buildAoiMusicTastePromptBlock(musicTasteStateRef.current);
    const builtSystemPrompt = buildSystemPrompt(
      char,
      mm,
      hasImageGen,
      userProfileRef.current,
      conversationPreferencesRef.current,
      currentMemories,
      hasTavily && toolCallRuntimeAvailable,
      hasResearchTools,
      `${currentAoiMemoryPrompt}${currentAoiSelfPrompt}`,
      currentAoiMissionPrompt,
      currentAoiContextPrompt,
      currentAoiGovernorPrompt,
      capabilityPrompt,
      runGoalPrompt,
      skillsPrompt,
      mcpPluginPrompt,
      toolCallRuntimeAvailable,
      currentAoiMusicTastePrompt,
      // R7.2: reconciles the persona with the operator role, from the stored
      // relationship only.
      buildAoiPersonaBridgeBlock({
        characterName: char.character_name,
        sessionCount: aoiRelationshipStateRef.current?.sessionCount ?? null,
        firstMetAt: aoiRelationshipStateRef.current?.firstMetAt ?? null,
        milestones: aoiRelationshipStateRef.current?.milestones ?? [],
        mood: aoiRelationshipStateRef.current?.mood?.mood ?? null,
        openThreadTitles: (aoiRelationshipStateRef.current?.openThreads ?? []).map(
          (thread) => thread.title,
        ),
        arc: aoiRelationshipStateRef.current?.arcBaseline
          ? { arcName: aoiRelationshipStateRef.current.arcBaseline.arcName }
          : null,
      }),
      includeAppTools,
    );
    // Budget accounting stays on the combined text so the snapshots remain
    // comparable to the ones recorded before the split.
    const systemPrompt = `${builtSystemPrompt.base}${builtSystemPrompt.perTurn}`;
    const aoiTrendFollowUpPrompt = buildAoiProactiveTrendFollowUpPromptBlock(
      options.aoiTrendFollowUpContext,
    );
    const fullMessages: ChatMessage[] = [
      {
        role: 'system',
        content: builtSystemPrompt.base,
      },
      ...(builtSystemPrompt.perTurn.trim()
        ? [
            {
              role: 'system' as const,
              content: builtSystemPrompt.perTurn,
            },
          ]
        : []),
      ...(aoiTrendFollowUpPrompt
        ? [
            {
              role: 'system' as const,
              content: aoiTrendFollowUpPrompt,
            },
          ]
        : []),
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
      ...(fileTaskContract || outcomeFeedbackContract || currentAoiLiveFieldTruthPrompt
        ? [
            {
              role: 'system' as const,
              content: [
                'Final execution guard: this instruction is newer than the recalled conversation and any historical file content.',
                fileTaskContract ? buildAoiFileTaskContractPrompt(fileTaskContract) : '',
                outcomeFeedbackContract
                  ? buildAoiOutcomeFeedbackContractPrompt(outcomeFeedbackContract)
                  : '',
                currentAoiLiveFieldTruthPrompt,
              ]
                .filter(Boolean)
                .join('\n'),
            },
          ]
        : []),
      // On a prompt this long the Length and scope rule needs a second, much
      // shorter touch to land, and it has to be genuinely last -- after the
      // execution guard, whose presence varies. A handful of tokens per turn.
      {
        role: 'system' as const,
        content: [
          '<length_reminder>',
          'Keep the visible reply no longer than the request needs.',
          '</length_reminder>',
        ].join('\n'),
      },
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

    if (outcomeFeedbackContract && !toolCallRuntimeAvailable) {
      const failureMessage =
        'Aoi outcome feedback requires a structured-tool-capable main model; canonical feedback was not written.';
      finalizeRunLedger('failed', failureMessage);
      throw new Error(failureMessage);
    }

    let currentMessages: ChatMessage[] = fullMessages;
    const fileTaskExecutionConfirmed = Boolean(
      fileTaskContract &&
      (confirmedActionRequest ||
        (!fileTaskContract.previewRequired &&
          !toolSafetyPolicyRef.current.requirePreviewBeforeMutation)),
    );
    let iterations = 0;
    let iterationLimit =
      DEFAULT_CONVERSATION_ITERATION_LIMIT +
      (fileTaskExecutionConfirmed ? CONFIRMED_FILE_TASK_RECOVERY_ITERATIONS : 0);
    pendingToolCallsRef.current = [];
    let toolLoopGuardState: AoiToolLoopGuardState = createAoiToolLoopGuardState();
    let latestDiagnosticsParams: Record<string, unknown> | null = null;
    let latestDiagnosticsHadIssues = false;
    let fileMutatedSinceDiagnostics = false;
    let deliveredAssistantContent = '';
    let deliveredToolCalls: string[] = [];
    let pendingResearchStartAck: string | null = null;
    let fileTaskEvidence = createAoiFileTaskEvidence();
    let outcomeFeedbackEvidence: AoiOutcomeFeedbackEvidence | null = null;
    const applyToolLoopGuard = (
      toolCalls: Array<{ function: { name: string; arguments?: string } }>,
      batchHasRespondTool: boolean,
    ) => {
      if (deliveredAssistantContent.trim()) {
        return;
      }
      const decision = observeAoiToolLoopBatch({
        state: toolLoopGuardState,
        toolCalls,
        iterations,
        iterationLimit,
        deliveredAssistantContent,
        batchHasRespondTool,
      });
      toolLoopGuardState = decision.state;
      if (!decision.prompt) {
        return;
      }
      console.info('[ChatPanel] Tool-loop guard prompt', {
        kind: decision.kind,
        iteration: iterations,
        iterationLimit,
      });
      currentMessages = [
        ...currentMessages,
        {
          role: 'system',
          content: decision.prompt,
        },
      ];
      recordRunLedgerEvent({
        type: 'tool_error',
        iteration: iterations,
        message: decision.prompt.slice(0, 400),
        toolNames: toolCalls.map((toolCall) => toolCall.function.name),
      });
    };
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
    const summarizeAndRecordToolResult = (
      toolName: string,
      params: Record<string, unknown>,
      result: string,
    ): string => {
      const outcome = classifyAoiToolResult(result);
      if (
        fileTaskExecutionConfirmed &&
        !outcome.failed &&
        (toolName === 'ide_write_file' || toolName === 'ide_patch_file')
      ) {
        const extendedLimit = Math.min(
          CONFIRMED_FILE_TASK_MAX_ITERATIONS,
          Math.max(iterationLimit, iterations + FILE_TASK_POST_MUTATION_COMPLETION_ITERATIONS),
        );
        if (extendedLimit > iterationLimit) {
          console.info('[ChatPanel] Extended file-task recovery budget after mutation', {
            iteration: iterations,
            previousLimit: iterationLimit,
            extendedLimit,
          });
          iterationLimit = extendedLimit;
        }
      }
      recordRunLedgerEvent({
        type: outcome.failed ? 'tool_error' : 'tool_result',
        iteration: iterations,
        message: outcome.message,
        toolNames: [toolName],
      });
      fileTaskEvidence = observeAoiFileTaskToolResult(fileTaskEvidence, toolName, params, result);
      return summarizeToolResultForModel(toolName, result);
    };
    const evaluateFileTaskCompletion = (assistantContent: string): AoiFileTaskVerification => {
      const additionalArtifactIssues: string[] = [];
      if (liveFieldTruthRequested && fileTaskContract) {
        if (!currentAoiLiveFieldScorecard) {
          additionalArtifactIssues.push(
            'canonical live-field scorecard was unavailable, so current-status claims cannot be verified',
          );
        } else {
          fileTaskEvidence.mutatedFiles.forEach((path) => {
            const readBack = getAoiFileReadBack(fileTaskEvidence, path);
            if (readBack && !readBack.contentTruncated) {
              additionalArtifactIssues.push(
                ...verifyAoiLiveFieldArtifactFacts(
                  readBack.content,
                  currentAoiLiveFieldScorecard as AoiNonVoiceJarvisScorecard,
                ).map((issue) => `${path}: ${issue}`),
              );
            }
          });
        }
      }
      return verifyAoiFileTaskContract({
        contract: fileTaskContract,
        evidence: fileTaskEvidence,
        assistantContent,
        executionConfirmed: fileTaskExecutionConfirmed,
        additionalArtifactIssues,
      });
    };
    const evaluateConversationCompletion = (assistantContent: string) => {
      const fileTask = evaluateFileTaskCompletion(assistantContent);
      const outcomeFeedback = verifyAoiOutcomeFeedbackCompletion({
        contract: outcomeFeedbackContract,
        evidence: outcomeFeedbackEvidence,
        assistantContent,
      });
      const issues = [...fileTask.issues, ...outcomeFeedback.issues];
      const correctionPrompt = [
        !fileTask.passed ? buildAoiFileTaskCorrectionPrompt(fileTask, fileTaskEvidence) : '',
        !outcomeFeedback.passed
          ? buildAoiOutcomeFeedbackCorrectionPrompt(outcomeFeedback, outcomeFeedbackEvidence)
          : '',
      ]
        .filter(Boolean)
        .join('\n');
      return {
        passed: fileTask.passed && outcomeFeedback.passed,
        enforced: fileTask.enforced || outcomeFeedback.enforced,
        issues,
        correctionPrompt,
        fileTask,
        outcomeFeedback,
      };
    };
    const buildConversationFailureMessage = (
      verification: ReturnType<typeof evaluateConversationCompletion>,
    ): string => {
      const failures = [
        !verification.fileTask.passed ? buildAoiFileTaskFailureMessage(verification.fileTask) : '',
        !verification.outcomeFeedback.passed
          ? buildAoiOutcomeFeedbackFailureMessage(verification.outcomeFeedback)
          : '',
      ].filter(Boolean);
      return failures.join(' | ');
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

    while (iterations < iterationLimit) {
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
          const verification = evaluateConversationCompletion(fallbackContent);
          if (!verification.passed) {
            currentMessages = [
              ...currentMessages,
              { role: 'assistant', content: fallbackContent },
              { role: 'system', content: verification.correctionPrompt },
            ];
            recordRunLedgerEvent({
              type: 'postcondition_failed',
              iteration: iterations,
              message: verification.issues.join('; ').slice(0, 400),
              toolNames: ['plain_text_fallback'],
            });
            continue;
          }
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
                summarizedResult: summarizeAndRecordToolResult(tc.function.name, params, result),
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

            if (isAppIntentTool(tc.function.name)) {
              const result = await runCachedTool(tc.function.name, params, () =>
                executeAppIntentTool(params),
              );
              return {
                toolCallId: tc.id,
                pendingSummary: getAppIntentToolPendingSummary(params),
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
                summarizedResult: summarizeAndRecordToolResult(tc.function.name, params, result),
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

            if (isHostProcessTool(tc.function.name)) {
              const result = await executeHostProcessTool(params, {
                sessionPath: sessionPathRef.current,
              });
              return {
                toolCallId: tc.id,
                pendingSummary: getHostProcessToolPendingSummary(params),
                summarizedResult: summarizeToolResultForModel(tc.function.name, result),
              };
            }

            if (isHostBrowserTool(tc.function.name)) {
              const result = await executeHostBrowserTool(params, {
                sessionPath: sessionPathRef.current,
              });
              return {
                toolCallId: tc.id,
                pendingSummary: getHostBrowserToolPendingSummary(params),
                summarizedResult: summarizeToolResultForModel(tc.function.name, result),
              };
            }

            if (isBrowserDriveTool(tc.function.name)) {
              const result = await executeBrowserDriveTool(params, {
                sessionPath: sessionPathRef.current,
              });
              return {
                toolCallId: tc.id,
                pendingSummary: getBrowserDriveToolPendingSummary(params),
                summarizedResult: summarizeToolResultForModel(tc.function.name, result),
              };
            }

            if (isBrowserDriveActTool(tc.function.name)) {
              const result = await executeBrowserDriveActTool(tc.function.name, params, {
                sessionPath: sessionPathRef.current,
              });
              return {
                toolCallId: tc.id,
                pendingSummary: getBrowserDriveActToolPendingSummary(tc.function.name, params),
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

          if (settled.status === 'rejected') {
            item.summarizedResult = summarizeAndRecordToolResult(
              toolCall.function.name,
              {},
              item.summarizedResult,
            );
          }

          pendingToolCallsRef.current.push(item.pendingSummary);
          currentMessages = [
            ...currentMessages,
            { role: 'tool', content: item.summarizedResult, tool_call_id: item.toolCallId },
          ];
        }

        applyToolLoopGuard(response.toolCalls, batchHasRespondTool);
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
          const completionVerification = evaluateConversationCompletion(content);
          if (!completionVerification.passed) {
            console.warn('[ChatPanel] respond_to_user blocked by deterministic postconditions', {
              issues: completionVerification.issues,
            });
            currentMessages = [
              ...currentMessages,
              {
                role: 'tool',
                content: completionVerification.correctionPrompt,
                tool_call_id: tc.id,
              },
            ];
            recordRunLedgerEvent({
              type: 'postcondition_failed',
              iteration: iterations,
              message: completionVerification.issues.join('; ').slice(0, 400),
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
            // R7.1: the arc reaching its end used to leave no trace -- the mod
            // flipped to free conversation and everything it built was gone.
            // Record it as the relationship baseline instead. Best-effort and
            // idempotent per arc; only the arc's real identity and the stages
            // actually played are stored, never an invented "transformed state".
            if (result.progressInfo?.stage_progress.all_stages_finished) {
              const config = mm.getConfig();
              void reportAoiRelationshipArcCompleted(sessionPathRef.current, {
                arcId: config.id,
                arcName: config.mod_name,
                // stages is keyed by index, not an array.
                completedStages: Object.values(config.stages).map((stage) => stage.stage_name),
              })
                .then((relationship) => {
                  if (relationship) {
                    aoiRelationshipStateRef.current = relationship;
                  }
                })
                .catch(() => {
                  // A failed write only costs the baseline, never the arc itself.
                });
            }
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
            const summarizedResult = summarizeAndRecordToolResult(tc.function.name, params, result);
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
            const summarizedResult = summarizeAndRecordToolResult(tc.function.name, params, result);
            currentMessages = [
              ...currentMessages,
              { role: 'tool', content: summarizedResult, tool_call_id: tc.id },
            ];
          } catch (err) {
            console.error('[ChatPanel] IDE tool failed', err);
            const errorResult = `error: ${err instanceof Error ? err.message : String(err)}`;
            summarizeAndRecordToolResult(tc.function.name, params, errorResult);
            currentMessages = [
              ...currentMessages,
              {
                role: 'tool',
                content: errorResult,
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
            const summarizedResult = summarizeAndRecordToolResult(tc.function.name, params, result);
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

        // ---- App intent contracts ----
        if (isAppIntentTool(tc.function.name)) {
          pendingToolCallsRef.current.push(getAppIntentToolPendingSummary(params));
          try {
            const result = await runCachedTool(tc.function.name, params, () =>
              executeAppIntentTool(params),
            );
            console.info('[ChatPanel] App intent tool result', {
              resultPreview: result.slice(0, 200),
            });
            const summarizedResult = summarizeToolResultForModel(tc.function.name, result);
            currentMessages = [
              ...currentMessages,
              { role: 'tool', content: summarizedResult, tool_call_id: tc.id },
            ];
          } catch (err) {
            console.error('[ChatPanel] App intent tool failed', err);
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
            const summarizedResult = summarizeAndRecordToolResult(tc.function.name, params, result);
            currentMessages = [
              ...currentMessages,
              { role: 'tool', content: summarizedResult, tool_call_id: tc.id },
            ];
          } catch (err) {
            console.error('[ChatPanel] Command tool failed', err);
            const errorResult = `error: ${err instanceof Error ? err.message : String(err)}`;
            summarizeAndRecordToolResult(tc.function.name, params, errorResult);
            currentMessages = [
              ...currentMessages,
              {
                role: 'tool',
                content: errorResult,
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
            const summarizedResult = summarizeAndRecordToolResult(tc.function.name, params, result);
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
            const summarizedResult = summarizeAndRecordToolResult(tc.function.name, params, result);
            currentMessages = [
              ...currentMessages,
              { role: 'tool', content: summarizedResult, tool_call_id: tc.id },
            ];
          } catch (err) {
            console.error('[ChatPanel] Checkpoint tool failed', err);
            const errorResult = `error: ${err instanceof Error ? err.message : String(err)}`;
            summarizeAndRecordToolResult(tc.function.name, params, errorResult);
            currentMessages = [
              ...currentMessages,
              {
                role: 'tool',
                content: errorResult,
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

        // ---- Host process list (real PC, metadata-only) ----
        if (isHostProcessTool(tc.function.name)) {
          pendingToolCallsRef.current.push(getHostProcessToolPendingSummary(params));
          try {
            const result = await executeHostProcessTool(params, {
              sessionPath: sessionPathRef.current,
            });
            console.info('[ChatPanel] host_process_list result', {
              resultPreview: result.slice(0, 200),
            });
            const summarizedResult = summarizeToolResultForModel(tc.function.name, result);
            currentMessages = [
              ...currentMessages,
              { role: 'tool', content: summarizedResult, tool_call_id: tc.id },
            ];
          } catch (err) {
            console.error('[ChatPanel] host_process_list failed', err);
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

        // ---- Host headless browser read (Chrome/Edge dump-dom) ----
        if (isHostBrowserTool(tc.function.name)) {
          pendingToolCallsRef.current.push(getHostBrowserToolPendingSummary(params));
          try {
            const result = await executeHostBrowserTool(params, {
              sessionPath: sessionPathRef.current,
            });
            console.info('[ChatPanel] host_browser_read result', {
              resultPreview: result.slice(0, 200),
            });
            const summarizedResult = summarizeToolResultForModel(tc.function.name, result);
            currentMessages = [
              ...currentMessages,
              { role: 'tool', content: summarizedResult, tool_call_id: tc.id },
            ];
          } catch (err) {
            console.error('[ChatPanel] host_browser_read failed', err);
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

        // ---- Browser drive: read the user's OWN logged-in browser (CDP) ----
        if (isBrowserDriveTool(tc.function.name)) {
          pendingToolCallsRef.current.push(getBrowserDriveToolPendingSummary(params));
          try {
            const result = await executeBrowserDriveTool(params, {
              sessionPath: sessionPathRef.current,
            });
            console.info('[ChatPanel] browser_read_auth result', {
              resultPreview: result.slice(0, 200),
            });
            const summarizedResult = summarizeToolResultForModel(tc.function.name, result);
            currentMessages = [
              ...currentMessages,
              { role: 'tool', content: summarizedResult, tool_call_id: tc.id },
            ];
          } catch (err) {
            console.error('[ChatPanel] browser_read_auth failed', err);
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

        // ---- Browser drive ACT: propose (preview) / run (execute) one action ----
        // Irreversible on the live browser; run consumes an operator-approved,
        // single-use approval recorded by propose. Fail-closed server-side.
        if (isBrowserDriveActTool(tc.function.name)) {
          pendingToolCallsRef.current.push(
            getBrowserDriveActToolPendingSummary(tc.function.name, params),
          );
          try {
            const result = await executeBrowserDriveActTool(tc.function.name, params, {
              sessionPath: sessionPathRef.current,
            });
            const summarizedResult = summarizeToolResultForModel(tc.function.name, result);
            currentMessages = [
              ...currentMessages,
              { role: 'tool', content: summarizedResult, tool_call_id: tc.id },
            ];
          } catch (err) {
            console.error('[ChatPanel] browser_drive act failed', err);
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
          if (outcomeFeedbackContract) {
            const blockedResult =
              'error: save_memory cannot satisfy an explicit outcome-feedback contract; call record_outcome_feedback instead.';
            const summarizedResult = summarizeAndRecordToolResult(
              tc.function.name,
              params,
              blockedResult,
            );
            currentMessages = [
              ...currentMessages,
              { role: 'tool', content: summarizedResult, tool_call_id: tc.id },
            ];
            continue;
          }
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

        // ---- Canonical operator outcome feedback ----
        if (tc.function.name === 'record_outcome_feedback') {
          let feedbackDelivered = false;
          try {
            const result = await recordAoiOperatorOutcomeFeedback(sessionPathRef.current, {
              userMessage: latestUserMessage,
              sourceChatRef: `aoi-run:${runLedgerEntry.id}`,
            });
            outcomeFeedbackEvidence = toAoiOutcomeFeedbackEvidence(result);
            pendingToolCallsRef.current.push(`record_outcome_feedback(${result.targetOutcome.id})`);
            const resultForModel = JSON.stringify({
              ok: true,
              linked_outcome_id: result.targetOutcome.id,
              feedback_label: result.feedbackLabel,
              learned_correction: result.correction,
              feedback_outcome_id: result.feedbackOutcome.id,
              correction_outcome_id: result.correctionOutcome.id,
            });
            const summarizedResult = summarizeAndRecordToolResult(
              tc.function.name,
              params,
              resultForModel,
            );
            currentMessages = [
              ...currentMessages,
              { role: 'tool', content: summarizedResult, tool_call_id: tc.id },
            ];
            const deterministicContent = buildAoiOutcomeFeedbackSuccessMessage(result);
            const deterministicVerification = evaluateConversationCompletion(deterministicContent);
            if (!deterministicVerification.passed) {
              throw new Error(buildConversationFailureMessage(deterministicVerification));
            }
            const deliveredPendingToolCalls = [...pendingToolCallsRef.current];
            emitAssistantMessage({
              id: String(Date.now()),
              role: 'assistant',
              content: deterministicContent,
              toolCalls: deliveredPendingToolCalls,
            });
            deliveredAssistantContent = deterministicContent;
            deliveredToolCalls = deliveredPendingToolCalls;
            pendingToolCallsRef.current = [];
            pendingResearchStartAck = null;
            recordRunLedgerEvent({
              type: 'assistant_delivered',
              iteration: iterations,
              message: deterministicContent.slice(0, 200),
              toolNames: deliveredToolCalls,
            });
            shouldStopAfterToolBatch = true;
            feedbackDelivered = true;
          } catch (error) {
            const failedResult = `error: ${error instanceof Error ? error.message : String(error)}`;
            const summarizedResult = summarizeAndRecordToolResult(
              tc.function.name,
              params,
              failedResult,
            );
            currentMessages = [
              ...currentMessages,
              { role: 'tool', content: summarizedResult, tool_call_id: tc.id },
            ];
          }
          if (feedbackDelivered) {
            break;
          }
          continue;
        }

        // ---- app_action ----
        if (tc.function.name === 'app_action') {
          const appAction = parseAppActionToolParamsWithValidation(params);
          const authorityDecision = decideAoiCapabilityBrokerAuthority({
            appReference: appAction.appName,
            actionType: appAction.actionType,
            requestedOperation: appAction.actionType,
            requestedBand: 'execute',
            additionalBlockedReasons: appAction.parseErrors.map(
              (reason) => `app_action_params:${reason}`,
            ),
            evidenceRefs: [
              'tool:app_action',
              `app-action:${appAction.appName}:${appAction.actionType}`,
            ],
            now: Date.now(),
          });
          recordAoiAppActionAuthorityDecision(sessionPathRef.current, authorityDecision);
          if (authorityDecision.blockedReasons.length > 0) {
            const result = buildAoiAppActionAuthorityBlockedResult(authorityDecision);
            console.warn('[ChatPanel] app_action blocked by connector authority', {
              appName: appAction.appName,
              actionType: appAction.actionType,
              authorityDecisionId: authorityDecision.authorityDecisionId,
              blockedReasons: authorityDecision.blockedReasons,
            });
            currentMessages = [
              ...currentMessages,
              {
                role: 'tool',
                content: summarizeToolResultForModel(tc.function.name, result),
                tool_call_id: tc.id,
              },
            ];
            continue;
          }

          const resolved = resolveAppAction(appAction.appName, appAction.actionType);
          if (typeof resolved === 'string') {
            console.error('[ChatPanel] app_action resolve failed after authority allow', resolved);
            currentMessages = [
              ...currentMessages,
              { role: 'tool', content: resolved, tool_call_id: tc.id },
            ];
            continue;
          }

          pendingToolCallsRef.current.push(`${appAction.appName}/${appAction.actionType}`);

          try {
            const dispatchParams = {
              ...appAction.params,
              ...(resolved.params ?? {}),
            };
            const result = await dispatchAgentAction({
              app_id: resolved.appId,
              action_type: resolved.actionType,
              params: dispatchParams,
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
              params: dispatchParams,
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
        const verification = evaluateConversationCompletion(fallbackContent);
        if (!verification.passed) {
          currentMessages = [
            ...currentMessages,
            {
              role: 'system',
              content: verification.correctionPrompt,
            },
          ];
          recordRunLedgerEvent({
            type: 'postcondition_failed',
            iteration: iterations,
            message: verification.issues.join('; ').slice(0, 400),
            toolNames: ['memory_ack_fallback'],
          });
          continue;
        }
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

      applyToolLoopGuard(response.toolCalls, batchHasRespondTool);
    }
    if (!deliveredAssistantContent.trim() && pendingResearchStartAck) {
      const verification = evaluateConversationCompletion(pendingResearchStartAck);
      if (!verification.passed) {
        recordRunLedgerEvent({
          type: 'postcondition_failed',
          iteration: iterations,
          message: verification.issues.join('; ').slice(0, 400),
          toolNames: ['research_ack_fallback'],
        });
        pendingResearchStartAck = null;
      } else {
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
      const finalCompletionVerification = evaluateConversationCompletion('');
      const failureMessage =
        finalCompletionVerification.enforced && !finalCompletionVerification.passed
          ? buildConversationFailureMessage(finalCompletionVerification)
          : buildAoiUndeliveredConversationFailureMessage({
              userMessage: latestUserMessage,
              iterations,
              pendingToolCalls: pendingToolCallsRef.current,
            });
      finalizeRunLedger('failed', failureMessage);
      throw new Error(failureMessage);
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
    void dispatchAgentAction(buildOpenUrlAction(url));
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

  const aoiVibeInfo = useVibeInfo();
  // Unlike the iframe apps (each calls fetchVibeInfo on mount), the host chat
  // panel never populated vibe info. Fetch once on mount so the app language
  // setting is available as a fallback (cached/idempotent).
  useEffect(() => {
    void fetchVibeInfo().catch((error) => console.warn('[ChatPanel] fetchVibeInfo failed:', error));
  }, []);
  // Resolve the card language from the conversation (see
  // deriveAoiCardLangFromMessages): the most recent non-Latin script across all
  // turns, then the app language setting, then English. Declared here because
  // the proactive-brief panel below renders its copy in this language.
  const aoiCardLang: AoiCardLang = useMemo(
    () =>
      deriveAoiCardLangFromMessages(
        messages,
        normalizeResponseLanguageMode(conversationPreferences?.responseLanguageMode),
        aoiVibeInfo.systemSettings?.language?.current,
      ),
    [
      messages,
      conversationPreferences?.responseLanguageMode,
      aoiVibeInfo.systemSettings?.language?.current,
    ],
  );
  aoiCardLangRef.current = aoiCardLang;

  const aoiProactiveBriefPanel = useMemo(
    () =>
      buildAoiProactiveBriefPanelModel({
        candidates: aoiProactiveBriefs?.candidates ?? [],
        policy: aoiAutonomyStatus?.policy,
        profile: aoiProactiveBriefs?.profile,
        feedback: aoiProactiveBriefs?.feedback,
        cooldownState: aoiProactiveBriefs?.cooldownState,
        calibrationInbox: aoiProactiveBriefs?.calibrationInbox,
        calibrationTuning: aoiProactiveBriefs?.calibrationTuning,
        context: {
          now: aoiAutonomyStatus?.updatedAt ?? aoiAutonomyLastTickAt ?? Date.now(),
          quietMode: aoiAutonomyPanelSettings.quietMode,
          directChatOptIn: aoiAutonomyStatus?.policy.proactiveBriefing.directChatHookOptIn === true,
          inlineCardsShown: aoiInlineShownCount,
          maxInlineCards: Math.min(1, aoiAutonomyPanelSettings.maxSuggestionsPerSession),
        },
        // Card copy and the chat hook speak in Aoi's own register, in the
        // language the conversation is actually happening in.
        voice: { lang: aoiCardLang },
      }),
    [
      aoiCardLang,
      aoiAutonomyLastTickAt,
      aoiAutonomyPanelSettings.maxSuggestionsPerSession,
      aoiAutonomyPanelSettings.quietMode,
      aoiAutonomyStatus?.policy,
      aoiAutonomyStatus?.policy.proactiveBriefing.directChatHookOptIn,
      aoiAutonomyStatus?.updatedAt,
      aoiInlineShownCount,
      aoiProactiveBriefs?.candidates,
      aoiProactiveBriefs?.calibrationInbox,
      aoiProactiveBriefs?.calibrationTuning,
      aoiProactiveBriefs?.cooldownState,
      aoiProactiveBriefs?.feedback,
      aoiProactiveBriefs?.profile,
    ],
  );

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
        policy: aoiAutonomyStatus?.policy,
        proactiveBriefCandidates: aoiProactiveBriefs?.candidates,
        proactiveBriefProfile: aoiProactiveBriefs?.profile,
        proactiveBriefFeedback: aoiProactiveBriefs?.feedback,
        proactiveBriefCooldownState: aoiProactiveBriefs?.cooldownState,
        // The resume card greets the user in Aoi's own voice.
        voice: { lang: aoiCardLang },
      }),
    [
      aoiCardLang,
      aoiAutonomyActiveProposals,
      aoiAutonomyBlockedProposals,
      aoiAutonomyEvaluation?.trustCalibration,
      aoiAutonomyLastSeenAt,
      aoiAutonomyLastTickAt,
      aoiAutonomyPanelSettings.quietMode,
      aoiAutonomyStatus?.policy,
      aoiAutonomyStatus?.updatedAt,
      aoiRecentProposalDecisions,
      aoiMemories,
      aoiMissionState,
      aoiOperatorHealth,
      aoiProactiveBriefs?.candidates,
      aoiProactiveBriefs?.cooldownState,
      aoiProactiveBriefs?.feedback,
      aoiProactiveBriefs?.profile,
      aoiWorkspaceSnapshot,
      sessionPath,
    ],
  );
  // Keep the mirror ref in sync now that aoiOperatorDigest is initialized.
  aoiOperatorDigestRef.current = aoiOperatorDigest;

  const aoiSourceFreshnessContracts = useMemo(
    () =>
      buildAoiSourceFreshnessContracts({
        sourceRegistry: aoiEnvironmentSources,
        workspaceSnapshot: aoiWorkspaceSnapshot,
        now: aoiAutonomyStatus?.updatedAt ?? aoiAutonomyLastTickAt ?? Date.now(),
      }),
    [
      aoiAutonomyLastTickAt,
      aoiAutonomyStatus?.updatedAt,
      aoiEnvironmentSources,
      aoiWorkspaceSnapshot,
    ],
  );

  const aoiMissionControlState = useMemo(
    () =>
      buildAoiMissionControlState({
        sessionPath,
        now: aoiAutonomyStatus?.updatedAt ?? aoiAutonomyLastTickAt ?? Date.now(),
        mission: aoiMissionState,
        goals: aoiAutonomyActiveGoals,
        playbooks: aoiActivePlaybooks,
        workspaceSnapshot: aoiWorkspaceSnapshot,
        health: aoiOperatorHealth,
        sourceRegistry: aoiEnvironmentSources,
        sourceFreshnessContracts: aoiSourceFreshnessContracts,
      }),
    [
      aoiActivePlaybooks,
      aoiAutonomyActiveGoals,
      aoiAutonomyLastTickAt,
      aoiAutonomyStatus?.updatedAt,
      aoiEnvironmentSources,
      aoiMissionState,
      aoiOperatorHealth,
      aoiSourceFreshnessContracts,
      aoiWorkspaceSnapshot,
      sessionPath,
    ],
  );

  const aoiAgendaNudgeReadinessForGovernor = useMemo(
    () =>
      buildAoiAgendaNudgeReadinessPanelSummary({
        status: aoiAutonomyStatus,
        activeProposals: aoiAutonomyActiveProposals,
        blockedProposals: aoiAutonomyBlockedProposals,
        digest: aoiOperatorDigest,
        settings: aoiAutonomyPanelSettings,
        options: {
          now: aoiAutonomyStatus?.updatedAt ?? aoiAutonomyLastTickAt ?? Date.now(),
          lastShownAt: aoiAgendaNudgeLastShownAt,
          shownCount: aoiInlineShownCount,
          shownDedupeKeys: aoiAgendaNudgeShownKeysRef.current,
        },
      }),
    [
      aoiAgendaNudgeLastShownAt,
      aoiAutonomyActiveProposals,
      aoiAutonomyBlockedProposals,
      aoiAutonomyLastTickAt,
      aoiAutonomyPanelSettings,
      aoiAutonomyStatus,
      aoiInlineShownCount,
      aoiOperatorDigest,
    ],
  );

  const aoiJarvisReadinessScorecard = useMemo(
    () =>
      buildAoiJarvisReadinessScorecard({
        sessionPath,
        now: aoiAutonomyStatus?.updatedAt ?? aoiAutonomyLastTickAt ?? Date.now(),
        sourceFreshnessContracts: aoiSourceFreshnessContracts,
        missionControl: aoiMissionControlState,
        directChatOptInEnabled:
          aoiAutonomyStatus?.policy.proactiveBriefing.directChatHookOptIn ?? null,
      }),
    [
      aoiAutonomyLastTickAt,
      aoiAutonomyStatus?.policy.proactiveBriefing.directChatHookOptIn,
      aoiAutonomyStatus?.updatedAt,
      aoiMissionControlState,
      aoiSourceFreshnessContracts,
      sessionPath,
    ],
  );

  const aoiOperatorVoicePolicy = useMemo(
    () => normalizeAoiOperatorVoicePolicy(conversationPreferences?.operatorVoicePolicy),
    [conversationPreferences?.operatorVoicePolicy],
  );

  const aoiJarvisAutonomyGovernor = useMemo(
    () =>
      buildAoiJarvisAutonomyGovernor({
        sessionPath,
        now: aoiAutonomyStatus?.updatedAt ?? aoiAutonomyLastTickAt ?? Date.now(),
        policy: aoiAutonomyStatus?.policy,
        operatorHealth: aoiOperatorHealth,
        jarvisReadinessScorecard: aoiJarvisReadinessScorecard,
        sourceFreshnessContracts: aoiSourceFreshnessContracts,
        missionControl: aoiMissionControlState,
        proactiveTrendAdvisor: aoiProactiveBriefs?.trendAdvisor,
        proactiveBrief: {
          visible: aoiProactiveBriefPanel.visible,
          statusLabel: aoiProactiveBriefPanel.statusLabel,
          hasInlineCard: Boolean(aoiProactiveBriefPanel.inlineCard),
          hasChatHook: Boolean(aoiProactiveBriefPanel.chatHook),
          evidenceRefs: aoiProactiveBriefPanel.evidenceRefs,
        },
        agendaNudgeReadiness: aoiAgendaNudgeReadinessForGovernor,
        activeProposals: aoiAutonomyActiveProposals,
        blockedProposals: aoiAutonomyBlockedProposals,
        operatorVoicePolicy: aoiOperatorVoicePolicy,
        ttsEnabled: conversationPreferences?.ttsEnabled === true,
        operatorVoiceMuted: aoiOperatorVoiceMuted,
      }),
    [
      aoiAgendaNudgeReadinessForGovernor,
      aoiAutonomyActiveProposals,
      aoiAutonomyBlockedProposals,
      aoiAutonomyLastTickAt,
      aoiAutonomyStatus?.policy,
      aoiAutonomyStatus?.updatedAt,
      aoiJarvisReadinessScorecard,
      aoiMissionControlState,
      aoiOperatorHealth,
      aoiOperatorVoiceMuted,
      aoiOperatorVoicePolicy,
      aoiProactiveBriefPanel.chatHook,
      aoiProactiveBriefPanel.evidenceRefs,
      aoiProactiveBriefPanel.inlineCard,
      aoiProactiveBriefPanel.statusLabel,
      aoiProactiveBriefPanel.visible,
      aoiProactiveBriefs?.trendAdvisor,
      aoiSourceFreshnessContracts,
      conversationPreferences?.ttsEnabled,
      sessionPath,
    ],
  );
  const aoiJarvisAutonomyGovernorRequestPreviewText = useMemo(() => {
    const draft = input.trim();
    if (draft) {
      return draft;
    }
    const latestUserTurn = [...chatHistory].reverse().find((message) => message.role === 'user');
    return latestUserTurn?.content ?? '';
  }, [chatHistory, input]);

  useEffect(() => {
    const currentTrail =
      aoiAutonomyPanelSettingsRef.current.jarvisAutonomyGovernorAuditTrail ?? null;
    const event = buildAoiJarvisAutonomyGovernorAuditEvent({
      decision: aoiJarvisAutonomyGovernor,
      previousEvent: currentTrail?.events[0] ?? null,
    });
    if (!event) {
      return;
    }
    if (aoiJarvisAutonomyGovernorAuditKeyRef.current === event.dedupeKey) {
      return;
    }
    if (currentTrail?.events[0]?.dedupeKey === event.dedupeKey) {
      aoiJarvisAutonomyGovernorAuditKeyRef.current = event.dedupeKey;
      return;
    }

    const nextTrail = appendAoiJarvisAutonomyGovernorAuditTrail(currentTrail, event);
    if (!nextTrail) {
      return;
    }

    aoiJarvisAutonomyGovernorAuditKeyRef.current = event.dedupeKey;
    updateAoiAutonomyPanelSettingsFromPanel({
      jarvisAutonomyGovernorAuditTrail: nextTrail,
    });
  }, [aoiJarvisAutonomyGovernor, updateAoiAutonomyPanelSettingsFromPanel]);

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
    let decision = decideAoiOperatorVoiceRender({
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
    if (
      decision.shouldSpeak &&
      !canAoiJarvisAutonomyUseCapability(aoiJarvisAutonomyGovernor, 'voice')
    ) {
      decision = {
        ...decision,
        status: 'suppressed',
        shouldSpeak: false,
        silentReason: `Jarvis autonomy governor limited voice to ${aoiJarvisAutonomyGovernor.modeLabel}.`,
        reasons: [
          ...decision.reasons,
          `jarvis_governor_mode:${aoiJarvisAutonomyGovernor.overallMode}`,
        ],
        evidenceRefs: [
          ...decision.evidenceRefs,
          ...aoiJarvisAutonomyGovernor.evidenceRefs.slice(0, 6),
        ],
        spokenSummary: undefined,
      };
    }
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
    aoiJarvisAutonomyGovernor,
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
    () =>
      inlineAoiProposal
        ? buildAoiProposalActionPresentation(inlineAoiProposal, { lang: aoiCardLang })
        : null,
    [inlineAoiProposal, aoiCardLang],
  );
  const inlineAoiProposalExplanation = useMemo(
    () =>
      inlineAoiProposal
        ? buildAoiProactiveExplanation({
            proposal: inlineAoiProposal,
            policy: aoiAutonomyStatus?.policy,
            activeProposals: aoiAutonomyActiveProposals,
            lang: aoiCardLang,
          })
        : null,
    [aoiAutonomyActiveProposals, aoiAutonomyStatus?.policy, inlineAoiProposal, aoiCardLang],
  );
  const aoiResumeBrief = aoiOperatorDigest.resumeBrief ?? null;
  const showAoiResumeBrief = Boolean(
    aoiResumeBrief?.visible &&
    aoiResumeBrief.id !== dismissedAoiResumeBriefId &&
    !inlineAoiProposal,
  );
  const aoiGovernorAllowsProactiveBrief = canAoiJarvisAutonomyUseCapability(
    aoiJarvisAutonomyGovernor,
    'proactive_brief',
  );
  const aoiGovernorAllowsDirectChat = canAoiJarvisAutonomyUseCapability(
    aoiJarvisAutonomyGovernor,
    'direct_chat',
  );
  const inlineAoiProactiveBrief =
    !inlineAoiProposal && !showAoiResumeBrief && aoiGovernorAllowsProactiveBrief
      ? (aoiProactiveBriefPanel.inlineCard ?? null)
      : null;
  const inlineAoiTrendCard =
    !inlineAoiProposal &&
    !showAoiResumeBrief &&
    !inlineAoiProactiveBrief &&
    aoiGovernorAllowsProactiveBrief
      ? (aoiProactiveBriefs?.trendAdvisor?.inlineCard ?? null)
      : null;
  const directAoiTrendCard = aoiGovernorAllowsDirectChat
    ? (aoiProactiveBriefs?.trendAdvisor?.directChatCard ?? null)
    : null;
  // Remember the last offered direct-chat card so handleSend can record an
  // implicit dismissal (P1.1). Mirrors the sessionPathRef render-assignment idiom.
  if (directAoiTrendCard) {
    aoiOfferedDirectChatCardRef.current = {
      id: directAoiTrendCard.id,
      topicId: directAoiTrendCard.topicId,
      evidenceRefs: directAoiTrendCard.evidenceRefs,
    };
  }
  const aoiAgendaChatNudge = useMemo(
    () =>
      aoiGovernorAllowsDirectChat
        ? selectAoiAgendaChatNudge({
            status: aoiAutonomyStatus,
            activeProposals: aoiAutonomyActiveProposals,
            blockedProposals: aoiAutonomyBlockedProposals,
            digest: aoiOperatorDigest,
            settings: aoiAutonomyPanelSettings,
            options: {
              now: aoiAutonomyStatus?.updatedAt ?? aoiAutonomyLastTickAt ?? Date.now(),
              lastShownAt: aoiAgendaNudgeLastShownAt,
              shownCount: aoiInlineShownCount,
              shownDedupeKeys: aoiAgendaNudgeShownKeysRef.current,
            },
          })
        : null,
    [
      aoiAgendaNudgeLastShownAt,
      aoiAutonomyActiveProposals,
      aoiAutonomyBlockedProposals,
      aoiAutonomyLastTickAt,
      aoiAutonomyPanelSettings,
      aoiAutonomyStatus,
      aoiGovernorAllowsDirectChat,
      aoiInlineShownCount,
      aoiOperatorDigest,
    ],
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

  useEffect(() => {
    if (!inlineAoiProactiveBrief) {
      return;
    }
    if (aoiInlineShownProactiveBriefIdsRef.current.has(inlineAoiProactiveBrief.id)) {
      return;
    }
    aoiInlineShownProactiveBriefIdsRef.current.add(inlineAoiProactiveBrief.id);
    setAoiInlineShownCount((prev) => prev + 1);
  }, [inlineAoiProactiveBrief]);

  useEffect(() => {
    if (!inlineAoiTrendCard) {
      return;
    }
    if (aoiInlineShownTrendIdsRef.current.has(inlineAoiTrendCard.id)) {
      return;
    }
    aoiInlineShownTrendIdsRef.current.add(inlineAoiTrendCard.id);
    setAoiInlineShownCount((prev) => prev + 1);
    void recordAoiProactiveTrendDeliveryFromPanel(
      inlineAoiTrendCard.snapshotId,
      'inline_card_shown',
    );
  }, [inlineAoiTrendCard, recordAoiProactiveTrendDeliveryFromPanel]);

  useEffect(() => {
    if (!aoiAgendaChatNudge || loading || !visible) {
      return;
    }
    const safeMessageIdKey = aoiAgendaChatNudge.dedupeKey.replace(/[^A-Za-z0-9_-]/g, '-');
    const messageId = `aoi-agenda-direct-${safeMessageIdKey}`;
    if (aoiAgendaNudgeShownKeysRef.current.has(aoiAgendaChatNudge.dedupeKey)) {
      return;
    }
    if (messagesRef.current.some((message) => message.id === messageId)) {
      aoiAgendaNudgeShownKeysRef.current.add(aoiAgendaChatNudge.dedupeKey);
      return;
    }
    aoiAgendaNudgeShownKeysRef.current.add(aoiAgendaChatNudge.dedupeKey);
    const followUpPrompts = aoiAgendaChatNudge.suggestedReplies.slice(0, 3);
    pendingAoiTrendFollowUpRef.current = null;
    aoiTrendFollowUpContextsByPromptRef.current.clear();
    emitAssistantMessage(
      {
        id: messageId,
        role: 'assistant',
        content: aoiAgendaChatNudge.chatText,
        ...(followUpPrompts.length > 0 ? { suggestedReplies: followUpPrompts } : {}),
      },
      {
        updateSuggestedReplies: followUpPrompts.length > 0,
        speak: false,
      },
    );
    if (followUpPrompts.length > 0) {
      registerAoiAgendaSuggestedReplies(aoiAgendaChatNudge, followUpPrompts);
    }
    setAoiAgendaNudgeLastShownAt(Date.now());
    setAoiInlineShownCount((prev) => prev + 1);
    updateAoiAutonomyPanelSettingsFromPanel({
      agendaNudgeReadinessLastDecision: buildAoiAgendaNudgeDeliveryDecisionAudit({
        summary: {
          tone: 'ready',
          statusLabel: 'ready',
          candidateLabel: `${aoiAgendaChatNudge.reason}: ${aoiAgendaChatNudge.dedupeKey}`,
          summaryLabel: 'Aoi delivered a direct agenda chat nudge.',
          deliveryDecisionLabels: [
            'Delivery: ready to speak. A direct agenda chat nudge was delivered.',
            'Next eligible: waits for cooldown and duplicate protection before repeating.',
            'Boundary: direct agenda delivery only; no tools, app actions, policy bypass, or execution gates run from this decision.',
          ],
          evidenceRefs: aoiAgendaChatNudge.evidenceRefs,
        },
      }),
    });
    recordAoiMemoryTurn({
      userMessage: '[aoi-agenda-nudge]',
      assistantMessage: aoiAgendaChatNudge.chatText,
      toolCalls: [`direct:aoi_agenda_nudge:${aoiAgendaChatNudge.dedupeKey}`],
      source: 'direct_action',
      llmConfig: configRef.current ?? undefined,
    });
  }, [
    aoiAgendaChatNudge,
    emitAssistantMessage,
    loading,
    recordAoiMemoryTurn,
    registerAoiAgendaSuggestedReplies,
    updateAoiAutonomyPanelSettingsFromPanel,
    visible,
  ]);

  // Aoi idle music nudge: mirror the live gate inputs into a ref so the interval
  // below reads them without being torn down and recreated on every render.
  const idleMusicGateRef = useRef({
    autonomyEnabled: false,
    quietMode: false,
    visible: false,
    loading: false,
  });
  useEffect(() => {
    idleMusicGateRef.current = {
      autonomyEnabled: aoiAutonomyStatus?.policy?.enabled === true,
      quietMode: aoiAutonomyPanelSettings.quietMode === true,
      visible,
      loading,
    };
  }, [aoiAutonomyStatus?.policy?.enabled, aoiAutonomyPanelSettings.quietMode, visible, loading]);

  // Emit one taste-poll card now: pick the next unanswered question, set the
  // pending card, stamp the poll cooldown, and post the message. Shared by the
  // taste-poll cadence below and the idle-music diversion for taste-less
  // sessions. Returns false when the question bank is exhausted.
  const askTasteQuestionNow = useCallback(
    (now: number): boolean => {
      const state = musicTasteStateRef.current;
      const question = pickNextTasteQuestion(state);
      if (!question) {
        return false;
      }
      const lang = resolveNudgeLang();
      const options = question.options.map((option) => ({
        id: option.id,
        label: option.labels[lang],
      }));
      pendingTastePollRef.current = { questionId: question.id, options };
      savePendingTastePoll(pendingTastePollRef.current);
      musicTasteStateRef.current = recordTasteQuestionAsked(state, { now });
      saveAoiMusicTasteState(musicTasteStateRef.current);
      emitAssistantMessage(
        {
          id: `aoi-taste-poll-${now}`,
          role: 'assistant',
          content: question.prompts[lang],
          suggestedReplies: options.map((option) => option.label),
        },
        { updateSuggestedReplies: true, speak: false },
      );
      return true;
    },
    [emitAssistantMessage, resolveNudgeLang],
  );

  // When the user has been quietly idle in the panel, offer a mood-based song.
  // Tapping the play chip plays it in the YouTube app (handled in handleSend).
  useEffect(() => {
    const IDLE_MUSIC_CHECK_INTERVAL_MS = 30_000;
    const timer = window.setInterval(() => {
      const gate = idleMusicGateRef.current;
      const now = Date.now();
      // Only accrue idle while the panel is visible and Aoi is not mid-response;
      // otherwise keep resetting so returning to the panel does not fire instantly.
      if (!gate.visible || gate.loading) {
        lastUserActivityAtRef.current = now;
        return;
      }
      if (
        pendingIdleMusicOfferRef.current ||
        pendingNewsOfferRef.current ||
        pendingTastePollRef.current ||
        pendingPreferencePollRef.current
      ) {
        return;
      }
      const state = idleMusicStateRef.current;
      const musicActive = getWindows().some((win) => win.appId === YOUTUBE_APP_ID);
      const taste = deriveTasteProfile(musicTasteStateRef.current);
      const plan = planIdleMusicNudge({
        now,
        userIdleMs: now - lastUserActivityAtRef.current,
        autonomyEnabled: gate.autonomyEnabled,
        quietMode: gate.quietMode,
        musicActive,
        otherOfferPending: false,
        idleMusicLastOfferedAt: state.lastOfferedAt,
        hasTasteSignal: taste.hasTasteSignal,
        hasUnansweredTasteQuestion: pickNextTasteQuestion(musicTasteStateRef.current) !== null,
        tastePollLastAskedAt: musicTasteStateRef.current.lastAskedAt,
      });
      if (plan === 'skip') {
        return;
      }
      if (plan === 'ask-taste-question') {
        askTasteQuestionNow(now);
        return;
      }
      const recommendation = buildAoiMusicRecommendation({
        now,
        recentQueries: state.recentQueries,
        moodFeedback: state.moodFeedback,
        tasteMoodBias: taste.moodBias,
        personalQueries: taste.personalQueries,
        preferPersonal: true,
      });
      const copy = buildIdleMusicCardCopy(
        recommendation.mood,
        resolveNudgeLang(),
        recommendation.query,
        recommendation.source,
      );
      pendingIdleMusicOfferRef.current = {
        playPrompt: copy.playPrompt,
        dismissPrompt: copy.dismissPrompt,
        query: recommendation.query,
        mood: recommendation.mood,
      };
      savePendingIdleMusicOffer(pendingIdleMusicOfferRef.current);
      idleMusicStateRef.current = recordIdleMusicOffered(state, {
        query: recommendation.query,
        now,
      });
      saveAoiIdleMusicLearningState(idleMusicStateRef.current);
      emitAssistantMessage(
        {
          id: `aoi-idle-music-${now}`,
          role: 'assistant',
          content: copy.text,
          suggestedReplies: [copy.playPrompt, copy.dismissPrompt],
        },
        { updateSuggestedReplies: true, speak: false },
      );
    }, IDLE_MUSIC_CHECK_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [askTasteQuestionNow, emitAssistantMessage, resolveNudgeLang]);

  // Aoi taste poll: occasionally ask one multiple-choice music-taste question
  // and remember the answer for future recommendations. Shares the idle-music
  // gate mirror (autonomy / quiet / visible / loading), never stacks on top of
  // another pending card, and its own 24h cooldown keeps it to "once in a
  // while" until the small question bank is exhausted.
  useEffect(() => {
    const TASTE_POLL_CHECK_INTERVAL_MS = 30_000;
    const timer = window.setInterval(() => {
      const gate = idleMusicGateRef.current;
      const now = Date.now();
      if (!gate.visible || gate.loading) {
        return;
      }
      const state = musicTasteStateRef.current;
      if (
        !shouldAskTasteQuestion({
          now,
          userIdleMs: now - lastUserActivityAtRef.current,
          autonomyEnabled: gate.autonomyEnabled,
          quietMode: gate.quietMode,
          otherOfferPending: Boolean(
            pendingIdleMusicOfferRef.current ||
            pendingNewsOfferRef.current ||
            pendingTastePollRef.current ||
            pendingPreferencePollRef.current,
          ),
          lastAskedAt: state.lastAskedAt,
          hasUnansweredQuestion: pickNextTasteQuestion(state) !== null,
        })
      ) {
        return;
      }
      askTasteQuestionNow(now);
    }, TASTE_POLL_CHECK_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [askTasteQuestionNow, emitAssistantMessage, resolveNudgeLang]);

  // Aoi preference poll: occasionally ask one multiple-choice question about the
  // user's technical interests and working style, then persist the answer as a
  // structured preference memory so it informs later judgments. Same gate mirror
  // and 24h/idle cadence as the music taste poll; never stacks on another card
  // (including the music poll) so at most one nudge is pending at a time.
  useEffect(() => {
    const PREFERENCE_POLL_CHECK_INTERVAL_MS = 30_000;
    const timer = window.setInterval(() => {
      const gate = idleMusicGateRef.current;
      const now = Date.now();
      if (!gate.visible || gate.loading) {
        return;
      }
      const state = loadAoiPreferencePollState();
      const generatedQuestions = generatedQuestionsToSeedShape(loadAoiGeneratedQuestionsState());
      // Keep the bank ahead of the user: when few answerable questions remain,
      // have Aoi expand it from what it knows (own cooldown gates the frequency).
      if (
        gate.autonomyEnabled &&
        !gate.quietMode &&
        countUnansweredPreferenceQuestions(state, generatedQuestions) <=
          GENERATED_EXPANSION_LOW_WATERMARK
      ) {
        void runPreferenceBankExpansion();
      }
      const question = pickNextPreferenceQuestion(state, generatedQuestions);
      if (
        !question ||
        !shouldAskPreferenceQuestion({
          now,
          userIdleMs: now - lastUserActivityAtRef.current,
          autonomyEnabled: gate.autonomyEnabled,
          quietMode: gate.quietMode,
          otherOfferPending: Boolean(
            pendingIdleMusicOfferRef.current ||
            pendingNewsOfferRef.current ||
            pendingTastePollRef.current ||
            pendingPreferencePollRef.current,
          ),
          lastAskedAt: state.lastAskedAt,
          hasUnansweredQuestion: true,
        })
      ) {
        return;
      }
      const lang = resolveNudgeLang();
      const options = question.options.map((option) => ({
        id: option.id,
        label: option.labels[lang],
      }));
      pendingPreferencePollRef.current = { questionId: question.id, options };
      savePendingPreferencePoll(pendingPreferencePollRef.current);
      saveAoiPreferencePollState(recordPreferenceQuestionAsked(state, { now }));
      emitAssistantMessage(
        {
          id: `aoi-preference-poll-${now}`,
          role: 'assistant',
          content: question.prompts[lang],
          suggestedReplies: options.map((option) => option.label),
        },
        { updateSuggestedReplies: true, speak: false },
      );
    }, PREFERENCE_POLL_CHECK_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [emitAssistantMessage, resolveNudgeLang, runPreferenceBankExpansion]);

  // Aoi cyber-news nudge: live gate mirror (adds allowNetwork for the fetch).
  const newsGateRef = useRef({
    autonomyEnabled: false,
    quietMode: false,
    visible: false,
    loading: false,
    allowNetwork: false,
  });
  useEffect(() => {
    newsGateRef.current = {
      autonomyEnabled: aoiAutonomyStatus?.policy?.enabled === true,
      quietMode: aoiAutonomyPanelSettings.quietMode === true,
      visible,
      loading,
      allowNetwork: aoiAutonomyStatus?.policy?.allowNetwork === true,
    };
  }, [
    aoiAutonomyStatus?.policy?.enabled,
    aoiAutonomyStatus?.policy?.allowNetwork,
    aoiAutonomyPanelSettings.quietMode,
    visible,
    loading,
  ]);

  // When the user is quietly idle, surface an interesting unseen cybersecurity
  // article. The fetch/pick is async, so an in-flight guard prevents overlap and
  // the offer yields to any pending music card so only one nudge shows at a time.
  useEffect(() => {
    const NEWS_CHECK_INTERVAL_MS = 60_000;
    let cancelled = false;
    const timer = window.setInterval(() => {
      const gate = newsGateRef.current;
      const now = Date.now();
      if (!gate.visible || gate.loading) {
        lastUserActivityAtRef.current = now;
        return;
      }
      if (
        pendingNewsOfferRef.current ||
        pendingIdleMusicOfferRef.current ||
        pendingTastePollRef.current ||
        pendingPreferencePollRef.current ||
        newsOfferInFlightRef.current
      ) {
        return;
      }
      const state = newsStateRef.current;
      const newsAppActive = getWindows().some((win) => win.appId === CYBERNEWS_APP_ID);
      if (
        !shouldOfferNewsNudge({
          now,
          userIdleMs: now - lastUserActivityAtRef.current,
          autonomyEnabled: gate.autonomyEnabled,
          quietMode: gate.quietMode,
          newsAppActive,
          lastOfferedAt: state.lastOfferedAt,
        })
      ) {
        return;
      }
      newsOfferInFlightRef.current = true;
      void (async () => {
        try {
          const candidates = await loadCyberNewsCandidates({
            fileApi: cyberNewsFileApi,
            allowNetwork: gate.allowNetwork,
          });
          if (
            cancelled ||
            pendingNewsOfferRef.current ||
            pendingIdleMusicOfferRef.current ||
            pendingTastePollRef.current ||
            pendingPreferencePollRef.current
          ) {
            return;
          }
          const article = pickInterestingArticle(candidates, {
            recentArticleIds: newsStateRef.current.recentArticleIds,
            categoryFeedback: newsStateRef.current.categoryFeedback,
          });
          if (!article) {
            return;
          }
          const stamp = Date.now();
          // R6.3: this interruption is already happening; sometimes it carries an
          // observation about Aoi's own work instead of a headline. Substituting
          // rather than adding keeps the interruption count unchanged, which the
          // no-new-interruption-class constraint requires.
          const selfInquiry = selectAoiSelfInquiryToShare(
            buildAoiSelfProfile({
              now: stamp,
              sources: buildAoiSelfInquirySourcesFromMemories(aoiMemoriesRef.current ?? []),
            }),
          );
          if (
            shouldSubstituteAoiSelfObservation({
              now: stamp,
              lastSelfObservationAt: selfObservationStateRef.current.lastSelfObservationAt,
              hasSelfInquiry: Boolean(selfInquiry),
              // An article is in hand at this point (the null case returned
              // above); stating it as the condition keeps the invariant visible
              // rather than hiding it behind a literal.
              hasHostContent: Boolean(article),
            }) &&
            selfInquiry
          ) {
            const note = buildAoiCompanionSelfInquiryNote(
              { lang: aoiCardLangRef.current },
              { topicLabel: selfInquiry.label },
            );
            if (note) {
              selfObservationStateRef.current = recordAoiSelfObservationOffered(
                selfObservationStateRef.current,
                stamp,
              );
              saveAoiSelfObservationState(selfObservationStateRef.current);
              // Stamp the host cooldown but do NOT consume the article: passing an
              // empty id leaves recentArticleIds untouched, so the headline the
              // user never saw is still eligible next time. Recording it here
              // would silently burn an article on a nudge that showed something
              // else entirely.
              newsStateRef.current = recordNewsOffered(newsStateRef.current, {
                articleId: '',
                now: stamp,
              });
              saveAoiNewsState(newsStateRef.current);
              emitAssistantMessage(
                {
                  id: `aoi-self-observation-${stamp}`,
                  role: 'assistant',
                  content: note,
                },
                { updateSuggestedReplies: false, speak: false },
              );
              return;
            }
          }
          const copy = buildNewsCardCopy(article.title, resolveNudgeLang());
          pendingNewsOfferRef.current = {
            playPrompt: copy.playPrompt,
            dismissPrompt: copy.dismissPrompt,
            articleId: article.id,
            category: article.category,
            title: article.title,
          };
          savePendingNewsOffer(pendingNewsOfferRef.current);
          newsStateRef.current = recordNewsOffered(newsStateRef.current, {
            articleId: article.id,
            now: stamp,
          });
          saveAoiNewsState(newsStateRef.current);
          emitAssistantMessage(
            {
              id: `aoi-news-${stamp}`,
              role: 'assistant',
              content: copy.text,
              suggestedReplies: [copy.playPrompt, copy.dismissPrompt],
            },
            { updateSuggestedReplies: true, speak: false },
          );
        } catch (error) {
          console.warn('[ChatPanel] Aoi news nudge failed', error);
        } finally {
          newsOfferInFlightRef.current = false;
        }
      })();
    }, NEWS_CHECK_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [emitAssistantMessage, resolveNudgeLang]);

  useEffect(() => {
    if (
      !directAoiTrendCard?.chatHookText ||
      loading ||
      directAoiTrendCard.deliveryMode !== 'direct_chat' ||
      directAoiTrendCard.quietUntil ||
      directAoiTrendCard.snoozedUntil
    ) {
      return;
    }
    const messageId = `aoi-trend-direct-${directAoiTrendCard.snapshotId}`;
    if (aoiDirectTrendChatIdsRef.current.has(messageId)) {
      return;
    }
    if (messagesRef.current.some((message) => message.id === messageId)) {
      aoiDirectTrendChatIdsRef.current.add(messageId);
      return;
    }
    aoiDirectTrendChatIdsRef.current.add(messageId);
    pendingAoiAgendaFollowUpRef.current = null;
    aoiAgendaFollowUpContextsByPromptRef.current.clear();
    const followUpPrompts = directAoiTrendCard.followUpPrompts.slice(0, 4);
    const message: CharacterDisplayMessage = {
      id: messageId,
      role: 'assistant',
      content: directAoiTrendCard.chatHookText,
      ...(followUpPrompts.length > 0 ? { suggestedReplies: followUpPrompts } : {}),
    };
    addMessage(message);
    setChatHistory((prev) => [...prev, { role: 'assistant', content: message.content }]);
    if (followUpPrompts.length > 0) {
      registerAoiTrendSuggestedReplies(directAoiTrendCard, followUpPrompts);
      setSuggestedReplies(followUpPrompts);
    }
    void recordAoiProactiveTrendDeliveryFromPanel(
      directAoiTrendCard.snapshotId,
      'direct_chat_offered',
    );
  }, [
    addMessage,
    directAoiTrendCard,
    loading,
    recordAoiProactiveTrendDeliveryFromPanel,
    registerAoiTrendSuggestedReplies,
  ]);

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
            {messages
              .filter((msg) => !isEmptyAssistantBubble(msg))
              .map((msg) => (
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
            {/* Suggested Replies: inline after the last message so they hug the bubble */}
            {suggestedReplies.length > 0 && !loading && (
              <div className={styles.suggestedReplies}>
                {suggestedReplies.map((reply, i) => (
                  <button
                    key={i}
                    className={styles.suggestedReply}
                    onClick={() => handleSuggestedReply(reply)}
                  >
                    {reply}
                  </button>
                ))}
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {showAoiResumeBrief && aoiResumeBrief && !loading && (
            <div className={styles.aoiInlineSuggestion} data-testid="aoi-resume-brief">
              <div className={styles.aoiInlineSuggestionMain}>
                <div className={styles.aoiInlineSuggestionMeta}>
                  <span>{aoiResumeBrief.title}</span>
                  <span>{aoiOperatorDigest.summary}</span>
                  <span>evidence {aoiResumeBrief.evidenceRefs.length}</span>
                  {aoiOperatorDigest.approvalInbox.length > 0 && (
                    <span>approvals {aoiOperatorDigest.approvalInbox.length}</span>
                  )}
                </div>
                {aoiResumeBrief.greeting && (
                  <div className={styles.aoiInlineSuggestionBody} data-testid="aoi-resume-greeting">
                    {sanitizeAoiProposalDisplayText(aoiResumeBrief.greeting, 160)}
                  </div>
                )}
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

          {inlineAoiProactiveBrief && !loading && (
            <div
              className={styles.aoiInlineSuggestion}
              data-testid="aoi-proactive-brief-inline-card"
            >
              <div className={styles.aoiInlineSuggestionMain}>
                <div className={styles.aoiInlineSuggestionMeta}>
                  <span>Aoi interest brief</span>
                  <span>{inlineAoiProactiveBrief.sourceCountLabel}</span>
                  <span>{inlineAoiProactiveBrief.delivery.deliveryScore.toFixed(2)}</span>
                </div>
                <div className={styles.aoiInlineSuggestionTitle}>
                  {sanitizeAoiProposalDisplayText(inlineAoiProactiveBrief.title, 120)}
                </div>
                <div className={styles.aoiInlineSuggestionBody}>
                  {sanitizeAoiProposalDisplayText(inlineAoiProactiveBrief.hook, 220)}
                </div>
                <div className={styles.aoiInlineSuggestionHint}>
                  {sanitizeAoiProposalDisplayText(
                    `${inlineAoiProactiveBrief.sourceHostLabel}; ${inlineAoiProactiveBrief.freshnessLabel}`,
                    320,
                  )}
                </div>
              </div>
              <div className={styles.aoiInlineSuggestionActions}>
                <button
                  type="button"
                  className={styles.inlineActionBtn}
                  onClick={() =>
                    void recordAoiProactiveBriefFeedbackFromPanel(
                      inlineAoiProactiveBrief.id,
                      'useful',
                    )
                  }
                  disabled={aoiAutonomyActionId !== null}
                  title="Tell Aoi this brief was useful"
                >
                  Useful
                </button>
                <button
                  type="button"
                  className={styles.inlineActionBtn}
                  onClick={() =>
                    void recordAoiProactiveBriefFeedbackFromPanel(
                      inlineAoiProactiveBrief.id,
                      'show_less',
                    )
                  }
                  disabled={aoiAutonomyActionId !== null}
                  title="Show fewer briefs like this"
                >
                  Less
                </button>
                <button
                  type="button"
                  className={styles.inlineActionBtn}
                  onClick={() => {
                    setExpandedAoiProactiveBriefId(inlineAoiProactiveBrief.id);
                    void recordAoiProactiveBriefFeedbackFromPanel(
                      inlineAoiProactiveBrief.id,
                      'expand_summary',
                    );
                    openAoiAutonomySettings();
                  }}
                  disabled={aoiAutonomyActionId !== null}
                  title="Open sources, freshness, and evidence"
                >
                  Details
                </button>
              </div>
            </div>
          )}

          {inlineAoiTrendCard && !loading && (
            <div
              className={styles.aoiInlineSuggestion}
              data-testid="aoi-proactive-trend-inline-card"
            >
              <div className={styles.aoiInlineSuggestionMain}>
                <div className={styles.aoiInlineSuggestionMeta}>
                  <span>Aoi trend signal</span>
                  <span>{inlineAoiTrendCard.noveltyLabel}</span>
                  <span>{inlineAoiTrendCard.sourceQualityLabel}</span>
                  <span>{inlineAoiTrendCard.interestDriftLabel}</span>
                  <span>{inlineAoiTrendCard.deliveryMode}</span>
                </div>
                <div className={styles.aoiInlineSuggestionTitle}>
                  {sanitizeAoiProposalDisplayText(inlineAoiTrendCard.title, 120)}
                </div>
                <div className={styles.aoiInlineSuggestionBody}>
                  {sanitizeAoiProposalDisplayText(inlineAoiTrendCard.myTake, 260)}
                </div>
                <div className={styles.aoiInlineSuggestionHint}>
                  {sanitizeAoiProposalDisplayText(
                    `${inlineAoiTrendCard.topicLabel}; ${inlineAoiTrendCard.sourceHosts.join(', ') || 'source-backed'}; ${inlineAoiTrendCard.controlSummary}; ${inlineAoiTrendCard.deliverySummary}`,
                    360,
                  )}
                </div>
              </div>
              <div className={styles.aoiInlineSuggestionActions}>
                <button
                  type="button"
                  className={styles.inlineActionBtn}
                  onClick={() =>
                    inlineAoiTrendCard.candidateId
                      ? void recordAoiProactiveBriefFeedbackFromPanel(
                          inlineAoiTrendCard.candidateId,
                          'useful',
                        )
                      : undefined
                  }
                  disabled={aoiAutonomyActionId !== null || !inlineAoiTrendCard.candidateId}
                  title="Tell Aoi this trend signal was useful"
                >
                  Useful
                </button>
                <button
                  type="button"
                  className={styles.inlineActionBtn}
                  onClick={() =>
                    inlineAoiTrendCard.candidateId
                      ? void recordAoiProactiveBriefFeedbackFromPanel(
                          inlineAoiTrendCard.candidateId,
                          'too_frequent',
                        )
                      : undefined
                  }
                  disabled={aoiAutonomyActionId !== null || !inlineAoiTrendCard.candidateId}
                  title="Tell Aoi this trend signal was too noisy"
                >
                  Less
                </button>
                <button
                  type="button"
                  className={styles.inlineActionBtn}
                  onClick={() =>
                    inlineAoiTrendCard.candidateId
                      ? void recordAoiProactiveBriefFeedbackFromPanel(
                          inlineAoiTrendCard.candidateId,
                          'wrong_timing',
                        )
                      : undefined
                  }
                  disabled={aoiAutonomyActionId !== null || !inlineAoiTrendCard.candidateId}
                  title="Quiet this trend until a better time"
                >
                  Quiet
                </button>
                <button
                  type="button"
                  className={styles.inlineActionBtn}
                  onClick={() =>
                    inlineAoiTrendCard.candidateId
                      ? void recordAoiProactiveBriefFeedbackFromPanel(
                          inlineAoiTrendCard.candidateId,
                          'archive_brief',
                        )
                      : undefined
                  }
                  disabled={aoiAutonomyActionId !== null || !inlineAoiTrendCard.candidateId}
                  title="Snooze this trend card"
                >
                  Snooze
                </button>
                <button
                  type="button"
                  className={styles.inlineActionBtn}
                  onClick={() => {
                    if (inlineAoiTrendCard.candidateId) {
                      setExpandedAoiProactiveBriefId(inlineAoiTrendCard.candidateId);
                      void recordAoiProactiveBriefFeedbackFromPanel(
                        inlineAoiTrendCard.candidateId,
                        'open_sources',
                      );
                    }
                    openAoiAutonomySettings();
                  }}
                  disabled={aoiAutonomyActionId !== null}
                  title="Open trend evidence and source details"
                >
                  Sources
                </button>
                {inlineAoiTrendCard.followUpPrompts.slice(0, 2).map((prompt, index) => (
                  <button
                    type="button"
                    className={styles.inlineActionBtn}
                    key={`trend-follow-up-${inlineAoiTrendCard.id}-${index}`}
                    onClick={() => handleAoiTrendFollowUpPrompt(inlineAoiTrendCard, prompt)}
                    disabled={loading}
                    title={sanitizeAoiProposalDisplayText(prompt, 180)}
                  >
                    {index === 0 ? 'Ask deeper' : 'Plan'}
                  </button>
                ))}
              </div>
            </div>
          )}

          {inlineAoiProposal && !loading && (
            <div className={styles.aoiInlineSuggestion} data-testid="aoi-inline-suggestion">
              <div className={styles.aoiInlineSuggestionMain}>
                <div className={styles.aoiInlineSuggestionMeta}>
                  <span>{aoiCardChromeLabel(aoiCardLang, 'proposal_chip')}</span>
                  <span>{inlineAoiProposalExplanation?.confidenceLabel ?? 'proposal'}</span>
                  <span>
                    {aoiCardRiskLabel(
                      aoiCardLang,
                      inlineAoiProposalExplanation?.risk ?? inlineAoiProposal.risk,
                    )}
                  </span>
                  <span>
                    {aoiCardEvidenceLabel(
                      aoiCardLang,
                      inlineAoiProposalExplanation?.evidenceCount ??
                        inlineAoiProposal.evidenceRefs.length,
                    )}
                  </span>
                </div>
                <div className={styles.aoiInlineSuggestionTitle}>
                  {inlineAoiProposalExplanation?.localizedTitle ??
                    sanitizeAoiProposalDisplayText(inlineAoiProposal.title, 120)}
                </div>
                <div className={styles.aoiInlineSuggestionBody}>
                  {sanitizeAoiProposalDisplayText(
                    inlineAoiProposalExplanation?.messageSummary ?? inlineAoiProposal.body,
                    360,
                  )}
                </div>
                <div className={styles.aoiInlineSuggestionHint}>
                  {inlineAoiProposalExplanation?.willNotDoWithoutApproval ??
                    aoiCardChromeLabel(aoiCardLang, 'hint_fallback')}
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
                    aoiCardChromeLabel(aoiCardLang, 'approve_fallback_title')
                  }
                >
                  {inlineAoiProposalActionPresentation?.primaryLabel ??
                    aoiCardChromeLabel(aoiCardLang, 'approve_fallback')}
                </button>
                <button
                  type="button"
                  className={styles.inlineActionBtn}
                  onClick={() => void decideAoiProposalFromPanel(inlineAoiProposal.id, 'snooze')}
                  disabled={aoiAutonomyActionId !== null}
                  title={`${aoiCardChromeLabel(
                    aoiCardLang,
                    'pause_family',
                  )}: ${sanitizeAoiProposalDisplayText(inlineAoiProposal.cooldownKey, 120)}`}
                >
                  {aoiCardChromeLabel(aoiCardLang, 'pause_family')}
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
                      title={aoiCardFeedbackTitle(aoiCardLang, item.category, item.title)}
                    >
                      {aoiCardFeedbackLabel(aoiCardLang, item.category, item.label)}
                    </button>
                  ),
                )}
                <button
                  type="button"
                  className={styles.inlineActionBtn}
                  onClick={openAoiAutonomySettings}
                  title="Open Aoi Autonomy details"
                >
                  {aoiCardChromeLabel(aoiCardLang, 'details')}
                </button>
              </div>
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
          <div
            className={`${styles.settingsModal} ${styles.settingsModalCompact}`}
            data-testid="settings-loading-modal"
          >
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
          aoiRecentProposalDecisions={aoiRecentProposalDecisions}
          aoiActiveOpportunities={aoiActiveOpportunities}
          aoiArchivedOpportunities={aoiArchivedOpportunities}
          aoiDeliberationRuns={aoiDeliberationRuns}
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
          aoiJarvisAutonomyGovernor={aoiJarvisAutonomyGovernor}
          aoiJarvisAutonomyGovernorRequestDraft={aoiJarvisAutonomyGovernorRequestPreviewText}
          aoiProactiveBriefPanel={aoiProactiveBriefPanel}
          aoiProactiveBriefFeedback={aoiProactiveBriefs?.feedback ?? []}
          aoiProactiveTrendAdvisor={aoiProactiveBriefs?.trendAdvisor ?? null}
          expandedAoiProactiveBriefId={expandedAoiProactiveBriefId}
          aoiOperatorVoicePolicy={aoiOperatorVoicePolicy}
          aoiOperatorVoiceMuted={aoiOperatorVoiceMuted}
          aoiLastOperatorVoiceDecision={aoiLastOperatorVoiceDecision}
          aoiOperatorVoicePanelSummary={aoiOperatorVoicePanelSummary}
          aoiFieldFeedback={aoiFieldFeedback}
          aoiAutonomyPanelSettings={aoiAutonomyPanelSettings}
          aoiAutonomyBlockedProposals={aoiAutonomyBlockedProposals}
          aoiStrategicBrief={aoiStrategicBrief}
          aoiGoalWorkOrders={aoiGoalWorkOrders}
          aoiAutonomyLoading={aoiAutonomyLoading}
          aoiAutonomyError={aoiAutonomyError}
          aoiAutonomyActionId={aoiAutonomyActionId}
          aoiAutonomyLastTickAt={aoiAutonomyLastTickAt}
          aoiAgendaNudgeLastShownAt={aoiAgendaNudgeLastShownAt}
          aoiAgendaNudgeShownKeys={aoiAgendaNudgeShownKeysRef.current}
          aoiInlineShownCount={aoiInlineShownCount}
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
          onRecordAoiFieldFeedback={recordAoiFieldFeedbackFromPanel}
          onRecordAoiProactiveBriefFeedback={recordAoiProactiveBriefFeedbackFromPanel}
          onToggleAoiProactiveBriefExpanded={(briefId) =>
            setExpandedAoiProactiveBriefId((prev) => (prev === briefId ? null : briefId))
          }
          onResetAoiTrustCalibration={resetAoiTrustCalibrationFromPanel}
          onUpdateAoiAutonomyPanelSettings={updateAoiAutonomyPanelSettingsFromPanel}
          onRunAoiAutonomyCheck={runAoiAutonomyCheckFromPanel}
          onRunAoiProactiveBriefScout={runAoiProactiveBriefScoutFromPanel}
          onResetAoiProactiveBriefCooldown={resetAoiProactiveBriefCooldownFromPanel}
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
          aoiEmbeddingConfig={aoiEmbeddingConfig}
          onSaveAoiEmbeddingConfig={(cfg) => {
            const normalized = normalizeAoiEmbeddingConfig(cfg);
            setAoiEmbeddingConfig(normalized);
            void saveAoiEmbeddingConfig(cfg).catch((error) => {
              console.warn('[ChatPanel] Failed to save Aoi embedding config', error);
            });
          }}
          aoiMcpConnectorsConfig={aoiMcpConnectorsConfig}
          aoiReplaySessionPath={sessionPath}
          aoiPreferenceLang={resolveNudgeLang()}
          onGenerateAoiPreferenceQuestions={async () => {
            await runPreferenceBankExpansion({ manual: true });
          }}
          onSaveAoiMcpConnectorsConfig={(cfg) => {
            setAoiMcpConnectorsConfig(cfg);
            void saveAoiMcpConnectorsConfig(cfg).catch((error) => {
              console.warn('[ChatPanel] Failed to save Aoi MCP connectors config', error);
            });
          }}
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

// Offer only the efforts the selected model accepts. The picker used to list every
// value in the union, so a rejected one was selectable -- 'minimal' against
// gpt-5.5 comes back as a 400 on reasoning.effort that the settings screen gives
// no way to diagnose. An already-stored unsupported value stays in the list,
// labelled, so opening settings never silently rewrites saved config.
function buildReasoningEffortOptions(
  target: { provider: LLMProvider; model: string },
  current: LLMReasoningEffort | '',
): Array<{ value: LLMReasoningEffort | ''; label: string }> {
  const supported = getSupportedReasoningEfforts(target.provider, target.model);
  if (supported.length === 0) {
    return MODEL_REASONING_OPTIONS;
  }
  const options: Array<{ value: LLMReasoningEffort | ''; label: string }> = [
    { value: '', label: 'Model default' },
    ...supported.map((value) => ({ value, label: value })),
  ];
  if (current && !supported.includes(current)) {
    options.push({ value: current, label: `${current} (not supported by this model)` });
  }
  return options;
}

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

const AoiStrategicOutputsSection: React.FC<{
  brief: AoiStrategicBrief | null;
  workOrders: AoiBoundedWorkOrder[];
}> = ({ brief, workOrders }) => {
  // Read-only surface for the autonomy tick's strategic outputs (P1a UI c2).
  // Builds the display models from raw tick data captured in ChatPanel state and
  // renders them next to "Blocked in last check". ALWAYS renders a titled section
  // (with an empty-state hint) so the panel is present even before a fresh tick,
  // giving the persist-free e2e a stable anchor. Nothing here can execute or
  // activate -- the work-order previews are display_only / mutationCount:0 by type.
  const briefPanel = buildAoiStrategicBriefPanel(brief);
  const workOrderPreviews = buildAoiGoalWorkOrderPreviews(workOrders);
  const hasContent = briefPanel.visible || workOrderPreviews.length > 0;

  return (
    <div className={styles.aoiAutonomyProposalSection} data-testid="aoi-strategic-outputs">
      <div className={styles.promptBudgetSectionTitle}>Strategic outputs (last check)</div>
      {!hasContent && (
        <p className={styles.modelHint}>
          No strategic brief or goal work-order previews from the last check yet. Run a check or
          wait for a background tick to populate this read-only view.
        </p>
      )}
      {briefPanel.visible && (
        <div className={styles.aoiAutonomyProposalList}>
          <div className={styles.aoiAutonomyProposalItem}>
            <div className={styles.aoiAutonomyProposalTitle}>
              {briefPanel.focusSummary || 'Continuity brief'}
            </div>
            <div className={styles.aoiAutonomyProposalMeta}>
              <span>{briefPanel.synthesizedByLabel}</span>
              {briefPanel.tickReasonLabel ? <span>{briefPanel.tickReasonLabel}</span> : null}
              <span>{briefPanel.countsLabel}</span>
              <span>read only</span>
            </div>
            <div className={styles.aoiAutonomyProposalDetails}>
              {briefPanel.openThreadLabels.map((label, index) => (
                <div key={`aoi-brief-open-${index}`}>Open: {label}</div>
              ))}
              {briefPanel.blockedThreadLabels.map((label, index) => (
                <div key={`aoi-brief-blocked-${index}`}>Blocked: {label}</div>
              ))}
              {briefPanel.recentOutcomeLabels.map((label, index) => (
                <div key={`aoi-brief-outcome-${index}`}>Outcome: {label}</div>
              ))}
              {briefPanel.observationHighlightLabels.map((label, index) => (
                <div key={`aoi-brief-observed-${index}`}>Observed: {label}</div>
              ))}
              {briefPanel.evidenceRefs.map((ref, index) => (
                <div key={`aoi-brief-evidence-${index}`}>Evidence: {ref}</div>
              ))}
            </div>
          </div>
        </div>
      )}
      {workOrderPreviews.length > 0 && (
        <div className={styles.aoiAutonomyProposalList}>
          {workOrderPreviews.map((preview) => (
            <div className={styles.aoiAutonomyProposalItem} key={preview.id}>
              <div className={styles.aoiAutonomyProposalTitle}>{preview.objectiveLabel}</div>
              <div className={styles.aoiAutonomyProposalMeta}>
                <span>goal work order</span>
                <span>{preview.statusLabel}</span>
                <span>{preview.policyStatusLabel}</span>
                <span>{preview.riskLabel} risk</span>
                <span>requires {preview.requiredLevelLabel}</span>
                <span>display only</span>
                <span>evidence {preview.evidenceRefCount}</span>
              </div>
              <div className={styles.aoiAutonomyProposalDetails}>
                <div>Next: {preview.approvalBoundaryLabel}</div>
                <div>Expected diff: {preview.expectedDiffLabel}</div>
                {preview.scopeLabels.map((label, index) => (
                  <div key={`${preview.id}-scope-${index}`}>Scope: {label}</div>
                ))}
                {preview.allowedOperationLabels.map((label, index) => (
                  <div key={`${preview.id}-op-${index}`}>Operation: {label}</div>
                ))}
                {preview.stopConditionLabels.map((label, index) => (
                  <div key={`${preview.id}-stop-${index}`}>Stop: {label}</div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

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
  aoiRecentProposalDecisions: AoiProposalDecision[];
  aoiActiveOpportunities: AoiOpportunity[];
  aoiArchivedOpportunities: AoiOpportunity[];
  aoiDeliberationRuns: AoiDeliberationRun[];
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
  aoiJarvisAutonomyGovernor: AoiJarvisAutonomyGovernorDecision;
  aoiJarvisAutonomyGovernorRequestDraft: string;
  aoiProactiveBriefPanel: AoiProactiveBriefPanelModel;
  aoiProactiveBriefFeedback: AoiProactiveBriefFeedback[];
  aoiProactiveTrendAdvisor: AoiProactiveTrendAdvisorState | null;
  expandedAoiProactiveBriefId: string | null;
  aoiOperatorVoicePolicy: AoiOperatorVoicePolicy;
  aoiOperatorVoiceMuted: boolean;
  aoiLastOperatorVoiceDecision: AoiVoiceRenderDecision | null;
  aoiOperatorVoicePanelSummary: ReturnType<typeof buildAoiOperatorVoicePanelSummary>;
  aoiFieldFeedback: AoiFieldFeedbackResponse | null;
  aoiAutonomyPanelSettings: AoiAutonomyPanelSettings;
  aoiAutonomyBlockedProposals: AoiAutonomyBlockedProposal[];
  aoiStrategicBrief: AoiStrategicBrief | null;
  aoiGoalWorkOrders: AoiBoundedWorkOrder[];
  aoiAutonomyLoading: boolean;
  aoiAutonomyError: string;
  aoiAutonomyActionId: string | null;
  aoiAutonomyLastTickAt: number | null;
  aoiAgendaNudgeLastShownAt: number | null;
  aoiAgendaNudgeShownKeys: ReadonlySet<string>;
  aoiInlineShownCount: number;
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
  onRecordAoiFieldFeedback: (
    item: AoiOperatorFeedbackInboxPanelItem,
    label: AoiShadowDecisionLabel,
  ) => Promise<void>;
  onRecordAoiProactiveBriefFeedback: (
    briefId: string,
    category: AoiProactiveBriefFeedbackCategory,
  ) => Promise<void>;
  onToggleAoiProactiveBriefExpanded: (briefId: string) => void;
  onResetAoiTrustCalibration: (dimension: AoiCalibrationDimension, key: string) => Promise<void>;
  onUpdateAoiAutonomyPanelSettings: (patch: Partial<AoiAutonomyPanelSettings>) => void;
  onRunAoiAutonomyCheck: () => Promise<void>;
  onRunAoiProactiveBriefScout: () => Promise<void>;
  onResetAoiProactiveBriefCooldown: () => Promise<void>;
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
  aoiEmbeddingConfig: AoiEmbeddingConfig | null;
  onSaveAoiEmbeddingConfig: (config: AoiEmbeddingConfig | null) => void;
  aoiMcpConnectorsConfig: AoiMcpConnectorsConfig | null;
  aoiReplaySessionPath: string;
  aoiPreferenceLang: AoiPreferenceLang;
  onGenerateAoiPreferenceQuestions: () => Promise<void>;
  onSaveAoiMcpConnectorsConfig: (config: AoiMcpConnectorsConfig) => void;
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
  aoiRecentProposalDecisions,
  aoiActiveOpportunities,
  aoiArchivedOpportunities,
  aoiDeliberationRuns,
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
  aoiJarvisAutonomyGovernor,
  aoiJarvisAutonomyGovernorRequestDraft,
  aoiProactiveBriefPanel,
  aoiProactiveBriefFeedback,
  aoiProactiveTrendAdvisor,
  expandedAoiProactiveBriefId,
  aoiOperatorVoicePolicy,
  aoiOperatorVoiceMuted,
  aoiLastOperatorVoiceDecision,
  aoiOperatorVoicePanelSummary,
  aoiFieldFeedback,
  aoiAutonomyPanelSettings,
  aoiAutonomyBlockedProposals,
  aoiStrategicBrief,
  aoiGoalWorkOrders,
  aoiAutonomyLoading,
  aoiAutonomyError,
  aoiAutonomyActionId,
  aoiAutonomyLastTickAt,
  aoiAgendaNudgeLastShownAt,
  aoiAgendaNudgeShownKeys,
  aoiInlineShownCount,
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
  onRecordAoiFieldFeedback,
  onRecordAoiProactiveBriefFeedback,
  onToggleAoiProactiveBriefExpanded,
  onResetAoiTrustCalibration,
  onUpdateAoiAutonomyPanelSettings,
  onRunAoiAutonomyCheck,
  onRunAoiProactiveBriefScout,
  onResetAoiProactiveBriefCooldown,
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
  aoiEmbeddingConfig,
  onSaveAoiEmbeddingConfig,
  aoiMcpConnectorsConfig,
  aoiReplaySessionPath,
  aoiPreferenceLang,
  onGenerateAoiPreferenceQuestions,
  onSaveAoiMcpConnectorsConfig,
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
  // Aoi semantic-memory embedding key (optional; reuses an OpenRouter/OpenAI key).
  const [aoiEmbeddingApiKey, setAoiEmbeddingApiKey] = useState(aoiEmbeddingConfig?.apiKey || '');
  const [aoiEmbeddingBaseUrl, setAoiEmbeddingBaseUrl] = useState(
    aoiEmbeddingConfig?.baseUrl || AOI_EMBEDDING_DEFAULT_BASE_URL,
  );
  const [aoiEmbeddingModel, setAoiEmbeddingModel] = useState(
    aoiEmbeddingConfig?.model || AOI_EMBEDDING_DEFAULT_MODEL,
  );
  const persistAoiEmbeddingConfig = () => {
    const key = aoiEmbeddingApiKey.trim();
    onSaveAoiEmbeddingConfig(
      key
        ? {
            apiKey: key,
            baseUrl: aoiEmbeddingBaseUrl.trim() || AOI_EMBEDDING_DEFAULT_BASE_URL,
            model: aoiEmbeddingModel.trim() || AOI_EMBEDDING_DEFAULT_MODEL,
          }
        : null,
    );
  };
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
  const [advancedSection, setAdvancedSection] = useState<AppSettingsAdvancedSection>(() => {
    try {
      const raw = localStorage.getItem('aoi-advanced-settings-section');
      const allowed: AppSettingsAdvancedSection[] = [
        'autonomy',
        'host',
        'operator',
        'memory',
        'integrations',
        'tools',
      ];
      if (raw && (allowed as string[]).includes(raw)) {
        return raw as AppSettingsAdvancedSection;
      }
    } catch {
      // ignore
    }
    return 'autonomy';
  });
  const [focusedKiraApiKeyId, setFocusedKiraApiKeyId] = useState<string | null>(null);
  const aoiAgendaNudgeDecisionAuditKeyRef = useRef<string | null>(null);
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
    try {
      localStorage.setItem('aoi-advanced-settings-section', advancedSection);
    } catch {
      // ignore quota / private mode
    }
  }, [advancedSection]);

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
  const aoiOpportunityInboxSummary = useMemo(
    () =>
      buildAoiOpportunityInboxPanelSummary({
        active: aoiActiveOpportunities,
        archived: aoiArchivedOpportunities,
        status: aoiAutonomyStatus,
        deliberationRuns: aoiDeliberationRuns,
        proactiveTrendAdvisor: aoiProactiveTrendAdvisor,
        proactiveBriefFeedback: aoiProactiveBriefFeedback,
        settings: aoiAutonomyPanelSettings,
        jarvisGovernor: aoiJarvisAutonomyGovernor,
        activeProposals: aoiAutonomyActiveProposals,
        blockedProposals: aoiAutonomyBlockedProposals,
        approvalInbox: aoiOperatorDigest?.approvalInbox,
        proposalDecisions: aoiRecentProposalDecisions,
        inlineShownCount: aoiInlineShownCount,
        now: aoiAutonomyStatus?.updatedAt ?? aoiAutonomyLastTickAt ?? Date.now(),
      }),
    [
      aoiActiveOpportunities,
      aoiArchivedOpportunities,
      aoiAutonomyLastTickAt,
      aoiAutonomyPanelSettings,
      aoiAutonomyStatus,
      aoiAutonomyActiveProposals,
      aoiAutonomyBlockedProposals,
      aoiDeliberationRuns,
      aoiInlineShownCount,
      aoiJarvisAutonomyGovernor,
      aoiOperatorDigest?.approvalInbox,
      aoiProactiveBriefFeedback,
      aoiProactiveTrendAdvisor,
      aoiRecentProposalDecisions,
    ],
  );
  const aoiFieldFeedbackPanel = useMemo(
    () =>
      buildAoiOperatorAcceptanceDashboard({
        sessionPath:
          aoiFieldFeedback?.sessionPath ?? aoiAutonomyStatus?.sessionPath ?? 'aoi/default',
        feedbackInbox: aoiFieldFeedback?.feedbackInbox ?? null,
        fieldShadowReport: aoiFieldFeedback?.fieldShadowReport ?? null,
        now: aoiAutonomyStatus?.updatedAt ?? aoiAutonomyLastTickAt ?? Date.now(),
      }).feedbackInbox,
    [
      aoiAutonomyLastTickAt,
      aoiAutonomyStatus?.sessionPath,
      aoiAutonomyStatus?.updatedAt,
      aoiFieldFeedback?.feedbackInbox,
      aoiFieldFeedback?.fieldShadowReport,
      aoiFieldFeedback?.sessionPath,
    ],
  );
  const aoiDeliberationRunSummary = useMemo(
    () =>
      buildAoiDeliberationRunPanelSummary({
        runs: aoiDeliberationRuns,
        now: aoiAutonomyStatus?.updatedAt ?? aoiAutonomyLastTickAt ?? Date.now(),
      }),
    [aoiAutonomyLastTickAt, aoiAutonomyStatus, aoiDeliberationRuns],
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
  // P1.1: opening a proposal's evidence is a weak interest signal; emit once per proposal.
  const aoiProposalOpenedTrackerRef = useRef(createAoiOutcomeJunctureTracker());
  const emitAoiProposalOpenedSignal = useCallback(
    (subject: { id: string; cooldownKey?: string }) => {
      const openedSignal = buildAoiProposalOpenedSignal(subject);
      if (openedSignal && aoiProposalOpenedTrackerRef.current.claim(openedSignal.key)) {
        void recordAoiOutcomeSignal(aoiReplaySessionPath, openedSignal.input).catch(() => {});
      }
    },
    [aoiReplaySessionPath],
  );
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
  const aoiAutonomyAgendaSummary = useMemo(
    () =>
      buildAoiAutonomyAgendaPanelSummary({
        status: aoiAutonomyStatus,
        activeProposals: aoiAutonomyActiveProposals,
        blockedProposals: aoiAutonomyBlockedProposals,
        mission: aoiMissionState,
        workspaceSnapshot: aoiWorkspaceSnapshot,
        digest: aoiOperatorDigest,
        scheduler: aoiAutonomyScheduler,
        health: aoiOperatorHealth,
        recentDecisions: aoiRecentProposalDecisions,
        settings: aoiAutonomyPanelSettings,
        now: aoiAutonomyStatus?.updatedAt ?? aoiAutonomyLastTickAt ?? Date.now(),
        includeDetails: expandedAoiMissionEvidence || Boolean(expandedAoiProposalId),
      }),
    [
      aoiAutonomyActiveProposals,
      aoiAutonomyBlockedProposals,
      aoiAutonomyLastTickAt,
      aoiAutonomyPanelSettings,
      aoiAutonomyScheduler,
      aoiAutonomyStatus,
      aoiMissionState,
      aoiOperatorDigest,
      aoiOperatorHealth,
      aoiRecentProposalDecisions,
      aoiWorkspaceSnapshot,
      expandedAoiMissionEvidence,
      expandedAoiProposalId,
    ],
  );
  const aoiAgendaNudgeCalibrationSummary = useMemo(
    () =>
      buildAoiAgendaNudgeCalibrationPanelSummary(
        aoiAutonomyPanelSettings,
        aoiAutonomyStatus?.updatedAt ?? aoiAutonomyLastTickAt ?? Date.now(),
      ),
    [aoiAutonomyLastTickAt, aoiAutonomyPanelSettings, aoiAutonomyStatus?.updatedAt],
  );
  const aoiAgendaNudgeReadinessSummary = useMemo(
    () =>
      buildAoiAgendaNudgeReadinessPanelSummary({
        status: aoiAutonomyStatus,
        activeProposals: aoiAutonomyActiveProposals,
        blockedProposals: aoiAutonomyBlockedProposals,
        digest: aoiOperatorDigest,
        settings: aoiAutonomyPanelSettings,
        options: {
          now: aoiAutonomyStatus?.updatedAt ?? aoiAutonomyLastTickAt ?? Date.now(),
          lastShownAt: aoiAgendaNudgeLastShownAt,
          shownCount: aoiInlineShownCount,
          shownDedupeKeys: aoiAgendaNudgeShownKeys,
        },
      }),
    [
      aoiAgendaNudgeLastShownAt,
      aoiAgendaNudgeShownKeys,
      aoiAutonomyActiveProposals,
      aoiAutonomyBlockedProposals,
      aoiAutonomyLastTickAt,
      aoiAutonomyPanelSettings,
      aoiAutonomyStatus,
      aoiInlineShownCount,
      aoiOperatorDigest,
    ],
  );

  useEffect(() => {
    if (!aoiAgendaNudgeReadinessSummary.visible || aoiAutonomyLoading) {
      return;
    }

    const nextAudit = buildAoiAgendaNudgeDeliveryDecisionAudit({
      summary: aoiAgendaNudgeReadinessSummary,
    });
    const decisionKey = [
      nextAudit.state,
      nextAudit.statusLabel,
      nextAudit.candidateLabel,
      nextAudit.summaryLabel,
      nextAudit.decisionLabels.join('|'),
      nextAudit.evidenceRefs.join('|'),
    ].join('\n');
    const currentAudit = aoiAutonomyPanelSettings.agendaNudgeReadinessLastDecision;
    const currentDecisionKey = currentAudit
      ? [
          currentAudit.state,
          currentAudit.statusLabel,
          currentAudit.candidateLabel,
          currentAudit.summaryLabel,
          currentAudit.decisionLabels.join('|'),
          currentAudit.evidenceRefs.join('|'),
        ].join('\n')
      : null;
    if (aoiAgendaNudgeDecisionAuditKeyRef.current === decisionKey) {
      return;
    }
    if (currentDecisionKey === decisionKey) {
      aoiAgendaNudgeDecisionAuditKeyRef.current = decisionKey;
      return;
    }

    aoiAgendaNudgeDecisionAuditKeyRef.current = decisionKey;
    onUpdateAoiAutonomyPanelSettings({
      agendaNudgeReadinessLastDecision: nextAudit,
    });
  }, [
    aoiAgendaNudgeReadinessSummary,
    aoiAutonomyLoading,
    aoiAutonomyPanelSettings.agendaNudgeReadinessLastDecision,
    onUpdateAoiAutonomyPanelSettings,
  ]);

  const runAoiAgendaNudgeReadinessAction = useCallback(
    (actionId: AoiAgendaNudgeReadinessActionId) => {
      const action = aoiAgendaNudgeReadinessSummary.actions.find((item) => item.id === actionId);
      const audit = action
        ? buildAoiAgendaNudgeReadinessActionAudit({
            action,
            summary: aoiAgendaNudgeReadinessSummary,
          })
        : null;
      if (actionId === 'enable_notifications') {
        onUpdateAoiAutonomyPanelSettings({
          notificationsEnabled: true,
          ...(audit ? { agendaNudgeReadinessLastAction: audit } : {}),
        });
      } else if (actionId === 'disable_quiet_mode') {
        onUpdateAoiAutonomyPanelSettings({
          quietMode: false,
          ...(audit ? { agendaNudgeReadinessLastAction: audit } : {}),
        });
      } else if (actionId === 'raise_session_cap') {
        onUpdateAoiAutonomyPanelSettings({
          maxSuggestionsPerSession: Math.min(
            12,
            Math.max(
              aoiAutonomyPanelSettings.maxSuggestionsPerSession + 1,
              aoiInlineShownCount + 1,
              1,
            ),
          ),
          ...(audit ? { agendaNudgeReadinessLastAction: audit } : {}),
        });
      } else if (actionId === 'reset_feedback_mute') {
        onUpdateAoiAutonomyPanelSettings({
          ...buildAoiAgendaNudgeFeedbackResetPatch(),
          ...(audit ? { agendaNudgeReadinessLastAction: audit } : {}),
        });
      } else if (actionId === 'refresh_autonomy') {
        if (audit) {
          onUpdateAoiAutonomyPanelSettings({ agendaNudgeReadinessLastAction: audit });
        }
        void onRefreshAoiAutonomy();
      } else if (actionId === 'run_check') {
        if (audit) {
          onUpdateAoiAutonomyPanelSettings({ agendaNudgeReadinessLastAction: audit });
        }
        void onRunAoiAutonomyCheck();
      }
    },
    [
      aoiAgendaNudgeReadinessSummary,
      aoiAutonomyPanelSettings.maxSuggestionsPerSession,
      aoiInlineShownCount,
      onRefreshAoiAutonomy,
      onRunAoiAutonomyCheck,
      onUpdateAoiAutonomyPanelSettings,
    ],
  );
  const runAoiAgendaNudgeDecisionFeedback = useCallback(
    (actionId: AoiAgendaNudgeDecisionFeedbackActionId) => {
      const action = aoiAgendaNudgeReadinessSummary.decisionFeedbackActions.find(
        (item) => item.id === actionId,
      );
      if (!action) {
        return;
      }
      if (action.disabled) {
        return;
      }

      const audit = buildAoiAgendaNudgeDecisionFeedbackAudit({
        action,
      });
      onUpdateAoiAutonomyPanelSettings({
        agendaNudgeCalibration: recordAoiAgendaNudgeFeedback(
          aoiAutonomyPanelSettings.agendaNudgeCalibration,
          {
            kind: action.kind,
            reason: action.reason,
            dedupeKey: action.dedupeKey,
          },
        ),
        agendaNudgeReadinessLastDecisionFeedback: audit,
        agendaNudgeReadinessDecisionFeedbackHistory: appendAoiAgendaNudgeDecisionFeedbackHistory(
          aoiAutonomyPanelSettings.agendaNudgeReadinessDecisionFeedbackHistory,
          audit,
        ),
      });
    },
    [
      aoiAgendaNudgeReadinessSummary.decisionFeedbackActions,
      aoiAutonomyPanelSettings.agendaNudgeCalibration,
      aoiAutonomyPanelSettings.agendaNudgeReadinessDecisionFeedbackHistory,
      onUpdateAoiAutonomyPanelSettings,
    ],
  );
  const isAoiAgendaNudgeReadinessActionDisabled = useCallback(
    (actionId: AoiAgendaNudgeReadinessActionId) => {
      if (actionId === 'enable_notifications') {
        return aoiAutonomyPanelSettings.notificationsEnabled;
      }
      if (actionId === 'disable_quiet_mode') {
        return !aoiAutonomyPanelSettings.quietMode;
      }
      if (actionId === 'raise_session_cap') {
        return aoiAutonomyPanelSettings.maxSuggestionsPerSession >= 12;
      }
      if (actionId === 'reset_feedback_mute') {
        return (
          !aoiAutonomyPanelSettings.agendaNudgeCalibration &&
          !aoiAutonomyPanelSettings.agendaNudgeReadinessLastDecisionFeedback &&
          (aoiAutonomyPanelSettings.agendaNudgeReadinessDecisionFeedbackHistory?.length ?? 0) === 0
        );
      }
      if (actionId === 'refresh_autonomy') {
        return aoiAutonomyLoading;
      }
      if (actionId === 'run_check') {
        return (
          aoiAutonomyActionId === 'tick' ||
          aoiAutonomyLoading ||
          Boolean(aoiAutonomyStatus?.activeTick)
        );
      }
      return false;
    },
    [
      aoiAutonomyActionId,
      aoiAutonomyLoading,
      aoiAutonomyPanelSettings.agendaNudgeCalibration,
      aoiAutonomyPanelSettings.agendaNudgeReadinessDecisionFeedbackHistory?.length,
      aoiAutonomyPanelSettings.agendaNudgeReadinessLastDecisionFeedback,
      aoiAutonomyPanelSettings.maxSuggestionsPerSession,
      aoiAutonomyPanelSettings.notificationsEnabled,
      aoiAutonomyPanelSettings.quietMode,
      aoiAutonomyStatus?.activeTick,
    ],
  );
  const aoiOperatorHealthSummary = useMemo(
    () =>
      buildAoiOperatorHealthPanelSummary(
        aoiOperatorHealth,
        expandedAoiMissionEvidence || Boolean(expandedAoiProposalId),
      ),
    [aoiOperatorHealth, expandedAoiMissionEvidence, expandedAoiProposalId],
  );
  const aoiJarvisAutonomyGovernorSummary = useMemo(
    () => buildAoiJarvisAutonomyGovernorPanelSummary(aoiJarvisAutonomyGovernor),
    [aoiJarvisAutonomyGovernor],
  );
  const aoiJarvisAutonomyGovernorRequestRoutingSummary = useMemo(
    () =>
      buildAoiJarvisAutonomyGovernorRequestRoutingSummary(aoiJarvisAutonomyGovernor, {
        requestText: aoiJarvisAutonomyGovernorRequestDraft,
      }),
    [aoiJarvisAutonomyGovernor, aoiJarvisAutonomyGovernorRequestDraft],
  );
  const aoiJarvisAutonomyGovernorAuditSummary = useMemo(
    () =>
      buildAoiJarvisAutonomyGovernorAuditPanelSummary(
        aoiAutonomyPanelSettings.jarvisAutonomyGovernorAuditTrail,
        aoiAutonomyPanelSettings.jarvisAutonomyGovernorAuditLastReset,
        aoiJarvisAutonomyGovernor,
      ),
    [
      aoiAutonomyPanelSettings.jarvisAutonomyGovernorAuditLastReset,
      aoiAutonomyPanelSettings.jarvisAutonomyGovernorAuditTrail,
      aoiJarvisAutonomyGovernor,
    ],
  );
  const restartAoiJarvisAutonomyGovernorAudit = useCallback(() => {
    const currentTrail = aoiAutonomyPanelSettings.jarvisAutonomyGovernorAuditTrail ?? null;
    const resetAudit = buildAoiJarvisAutonomyGovernorAuditResetAudit({
      trail: currentTrail,
      decision: aoiJarvisAutonomyGovernor,
      now: Date.now(),
    });
    const snapshotEvent = buildAoiJarvisAutonomyGovernorAuditEvent({
      decision: aoiJarvisAutonomyGovernor,
      previousEvent: null,
    });
    const nextTrail = appendAoiJarvisAutonomyGovernorAuditTrail(null, snapshotEvent);
    onUpdateAoiAutonomyPanelSettings({
      jarvisAutonomyGovernorAuditTrail: nextTrail,
      jarvisAutonomyGovernorAuditLastReset: resetAudit,
    });
  }, [
    aoiAutonomyPanelSettings.jarvisAutonomyGovernorAuditTrail,
    aoiJarvisAutonomyGovernor,
    onUpdateAoiAutonomyPanelSettings,
  ]);
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

  // Role-based Advanced sub-pages: only one group is mounted so the modal stays
  // short and scannable instead of one endless scroll of every operator panel.
  const ADVANCED_SETTINGS_SECTIONS: Array<{
    id: AppSettingsAdvancedSection;
    label: string;
    hint: string;
  }> = [
    {
      id: 'autonomy',
      label: 'Autonomy',
      hint: 'Proposals, goals, safety gates, scheduler, and opportunity inbox.',
    },
    {
      id: 'host',
      label: 'Host PC',
      hint: 'Real-PC process/file access: kill-switch, allowlists, roots, approvals.',
    },
    {
      id: 'operator',
      label: 'Operator',
      hint: 'Jarvis readiness, situation model, scorecards, and replay promotion.',
    },
    {
      id: 'memory',
      label: 'Memory',
      hint: 'Memory decay, preference learning, and durable memory inspector.',
    },
    {
      id: 'integrations',
      label: 'Integrations',
      hint: 'Tavily web search and PE Analyst / IDA MCP connectors.',
    },
    {
      id: 'tools',
      label: 'Tools',
      hint: 'Prompt budget, run ledger, skills, MCP plugins, and tool safety policy.',
    },
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
    target: { provider: LLMProvider; model: string },
  ) => (
    <div className={styles.runtimeOptionsGrid}>
      <div className={styles.field}>
        <label className={styles.label}>Reasoning effort</label>
        <select
          className={styles.select}
          value={values.reasoningEffort}
          onChange={(e) => onChange({ reasoningEffort: e.target.value as LLMReasoningEffort | '' })}
        >
          {buildReasoningEffortOptions(target, values.reasoningEffort).map((option) => (
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
          { provider: draft.provider, model: draft.model },
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
              Pick a section on the left; each groups related settings by function.
            </div>
          </div>
          <button className={styles.cancelBtn} onClick={onClose}>
            Close
          </button>
        </div>

        <nav
          className={styles.settingsTabs}
          data-testid="settings-nav"
          aria-label="Settings sections"
        >
          {settingsTabs.map((tab) => (
            <React.Fragment key={tab.key}>
              <button
                type="button"
                className={`${styles.settingsTab} ${
                  activeTab === tab.key ? styles.settingsTabActive : ''
                }`}
                onClick={() => setActiveTab(tab.key)}
              >
                {tab.label}
              </button>
              {tab.key === 'advanced' && activeTab === 'advanced' && (
                <div className={styles.settingsNavSub} data-testid="advanced-settings-subnav">
                  {ADVANCED_SETTINGS_SECTIONS.map((section) => (
                    <button
                      key={section.id}
                      type="button"
                      className={
                        advancedSection === section.id
                          ? `${styles.settingsNavSubItem} ${styles.settingsNavSubItemActive}`
                          : styles.settingsNavSubItem
                      }
                      data-testid={`advanced-section-${section.id}`}
                      onClick={() => setAdvancedSection(section.id)}
                      title={section.hint}
                    >
                      {section.label}
                    </button>
                  ))}
                </div>
              )}
            </React.Fragment>
          ))}
        </nav>

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
                  { provider, model },
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

                <div className={styles.field}>
                  <label className={styles.label}>Aoi Memory Embedding Key (optional)</label>
                  <input
                    className={styles.fieldInput}
                    type="password"
                    value={aoiEmbeddingApiKey}
                    onChange={(e) => setAoiEmbeddingApiKey(e.target.value)}
                    onBlur={persistAoiEmbeddingConfig}
                    placeholder="OpenRouter/OpenAI key for semantic memory recall"
                  />
                  <span className={styles.modelHint}>
                    Optional. An OpenAI-compatible key (e.g. OpenRouter) lets Aoi memory recall
                    match paraphrases that share no keywords. Leave empty to keep keyword-only
                    recall. Saved separately from the chat model.
                  </span>
                </div>
                <div className={styles.field}>
                  <label className={styles.label}>Embedding Base URL</label>
                  <input
                    className={styles.fieldInput}
                    value={aoiEmbeddingBaseUrl}
                    onChange={(e) => setAoiEmbeddingBaseUrl(e.target.value)}
                    onBlur={persistAoiEmbeddingConfig}
                    placeholder={AOI_EMBEDDING_DEFAULT_BASE_URL}
                  />
                </div>
                <div className={styles.field}>
                  <label className={styles.label}>Embedding Model</label>
                  <input
                    className={styles.fieldInput}
                    value={aoiEmbeddingModel}
                    onChange={(e) => setAoiEmbeddingModel(e.target.value)}
                    onBlur={persistAoiEmbeddingConfig}
                    placeholder={AOI_EMBEDDING_DEFAULT_MODEL}
                  />
                </div>
              </div>

              <div className={styles.settingsSectionCard}>
                <div className={styles.settingsSectionHeader}>
                  <div>
                    <div className={styles.settingsSectionTitle}>Web Search (Tavily)</div>
                    <span className={styles.modelHint}>
                      Powers Aoi's search_web tool for live web information. The API key lives under
                      Advanced &gt; Integrations.
                    </span>
                  </div>
                  <span className={styles.modelHint} data-testid="models-web-search-status">
                    {tavilyApiKey.trim() ? 'Configured' : 'Disabled'}
                  </span>
                </div>
                <div className={styles.field}>
                  <button
                    type="button"
                    className={styles.inlineActionBtn}
                    data-testid="models-open-tavily-settings"
                    onClick={() => {
                      setActiveTab('advanced');
                      setAdvancedSection('integrations');
                    }}
                  >
                    Open Tavily settings
                  </button>
                </div>
              </div>

              <AoiMcpConnectorsSettings
                config={aoiMcpConnectorsConfig}
                onSave={onSaveAoiMcpConnectorsConfig}
              />

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
                      { provider: dialogProvider, model: dialogModel },
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
            <div className={styles.settingsSection} data-testid="advanced-settings">
              {/* Section nav lives in the left sidebar now (see settingsNavSub). */}
              <p className={styles.advancedSectionHint} data-testid="advanced-section-hint">
                {ADVANCED_SETTINGS_SECTIONS.find((section) => section.id === advancedSection)
                  ?.hint ?? ''}
              </p>

              {advancedSection === 'autonomy' && (
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
                          <span className={styles.promptBudgetLabel}>Opportunities</span>
                          <strong>
                            {aoiOpportunityInboxSummary.activeCount} /{' '}
                            {aoiOpportunityInboxSummary.snoozedCount}
                          </strong>
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

                      {aoiJarvisAutonomyGovernorSummary.visible && (
                        <div
                          className={styles.aoiAutonomyProposalSection}
                          data-testid="aoi-jarvis-autonomy-governor"
                        >
                          <div className={styles.promptBudgetSectionTitle}>
                            Jarvis autonomy governor
                          </div>
                          <div className={styles.aoiAutonomyProposalItem}>
                            <div className={styles.aoiAutonomyProposalMeta}>
                              <span>{aoiJarvisAutonomyGovernorSummary.modeLabel}</span>
                              <span>
                                allowed{' '}
                                {aoiJarvisAutonomyGovernorSummary.allowedCapabilityLabels.length}
                              </span>
                            </div>
                            <div className={styles.aoiAutonomyProposalTitle}>
                              {sanitizeAoiProposalDisplayText(
                                aoiJarvisAutonomyGovernorSummary.summaryLabel,
                                180,
                              )}
                            </div>
                            <div className={styles.aoiAutonomyProposalDetails}>
                              {aoiJarvisAutonomyGovernorSummary.allowedCapabilityLabels.length >
                              0 ? (
                                <div>
                                  Allowed:{' '}
                                  {aoiJarvisAutonomyGovernorSummary.allowedCapabilityLabels.join(
                                    ', ',
                                  )}
                                </div>
                              ) : (
                                <div>Allowed: none beyond observation</div>
                              )}
                              {aoiJarvisAutonomyGovernorSummary.blockedCapabilityLabels.length >
                                0 && (
                                <div>
                                  Blocked capability:{' '}
                                  {aoiJarvisAutonomyGovernorSummary.blockedCapabilityLabels.join(
                                    ', ',
                                  )}
                                </div>
                              )}
                              {aoiJarvisAutonomyGovernorSummary.capabilityGapLabels.map(
                                (label, index) => (
                                  <div key={`jarvis-governor-gap-${index}`}>
                                    Gap: {sanitizeAoiProposalDisplayText(label, 300)}
                                  </div>
                                ),
                              )}
                              {aoiJarvisAutonomyGovernorSummary.upgradePlanLabels.map(
                                (label, index) => (
                                  <div key={`jarvis-governor-upgrade-plan-${index}`}>
                                    Plan: {sanitizeAoiProposalDisplayText(label, 300)}
                                  </div>
                                ),
                              )}
                              {aoiJarvisAutonomyGovernorSummary.responseContractLabels.map(
                                (label, index) => (
                                  <div key={`jarvis-governor-response-contract-${index}`}>
                                    Response: {sanitizeAoiProposalDisplayText(label, 300)}
                                  </div>
                                ),
                              )}
                              {aoiJarvisAutonomyGovernorRequestDraft.trim() ? (
                                <div>
                                  Request preview:{' '}
                                  {sanitizeAoiProposalDisplayText(
                                    aoiJarvisAutonomyGovernorRequestDraft,
                                    260,
                                  )}
                                </div>
                              ) : (
                                <div>Request routing: no current or recent user request</div>
                              )}
                              {aoiJarvisAutonomyGovernorRequestRoutingSummary.visible && (
                                <>
                                  <div>
                                    Request routing:{' '}
                                    {sanitizeAoiProposalDisplayText(
                                      `${aoiJarvisAutonomyGovernorRequestRoutingSummary.status}; ${aoiJarvisAutonomyGovernorRequestRoutingSummary.summaryLabel}`,
                                      300,
                                    )}
                                  </div>
                                  <div>
                                    Request directive:{' '}
                                    {sanitizeAoiProposalDisplayText(
                                      aoiJarvisAutonomyGovernorRequestRoutingSummary.responseDirectiveLabel,
                                      320,
                                    )}
                                  </div>
                                  {aoiJarvisAutonomyGovernorRequestRoutingSummary.allowedMatchedLabels.map(
                                    (label, index) => (
                                      <div key={`jarvis-governor-request-allowed-${index}`}>
                                        Matched allowed:{' '}
                                        {sanitizeAoiProposalDisplayText(label, 260)}
                                      </div>
                                    ),
                                  )}
                                  {aoiJarvisAutonomyGovernorRequestRoutingSummary.blockedMatchedLabels.map(
                                    (label, index) => (
                                      <div key={`jarvis-governor-request-blocked-${index}`}>
                                        Matched blocked:{' '}
                                        {sanitizeAoiProposalDisplayText(label, 300)}
                                      </div>
                                    ),
                                  )}
                                  {aoiJarvisAutonomyGovernorRequestRoutingSummary.evidenceRefs
                                    .slice(0, 4)
                                    .map((ref, index) => (
                                      <div key={`jarvis-governor-request-evidence-${index}`}>
                                        Request evidence: {sanitizeAoiProposalDisplayText(ref, 220)}
                                      </div>
                                    ))}
                                </>
                              )}
                              {aoiJarvisAutonomyGovernorSummary.requestScenarioLabels.map(
                                (label, index) => (
                                  <div key={`jarvis-governor-request-scenario-${index}`}>
                                    Scenario: {sanitizeAoiProposalDisplayText(label, 300)}
                                  </div>
                                ),
                              )}
                              {aoiJarvisAutonomyGovernorSummary.blockerLabels.map(
                                (label, index) => (
                                  <div key={`jarvis-governor-blocker-${index}`}>
                                    Blocker: {sanitizeAoiProposalDisplayText(label, 260)}
                                  </div>
                                ),
                              )}
                              {aoiJarvisAutonomyGovernorSummary.whyNotJarvisYetLabels.map(
                                (label, index) => (
                                  <div key={`jarvis-governor-why-${index}`}>
                                    Boundary: {sanitizeAoiProposalDisplayText(label, 260)}
                                  </div>
                                ),
                              )}
                              <div>
                                Next:{' '}
                                {sanitizeAoiProposalDisplayText(
                                  aoiJarvisAutonomyGovernorSummary.nextUpgradeActionLabel,
                                  260,
                                )}
                              </div>
                              {aoiJarvisAutonomyGovernorAuditSummary.visible && (
                                <>
                                  <div>
                                    Audit:{' '}
                                    {sanitizeAoiProposalDisplayText(
                                      aoiJarvisAutonomyGovernorAuditSummary.headlineLabel,
                                      220,
                                    )}
                                  </div>
                                  <div>
                                    Latest:{' '}
                                    {sanitizeAoiProposalDisplayText(
                                      aoiJarvisAutonomyGovernorAuditSummary.latestLabel,
                                      260,
                                    )}
                                  </div>
                                  <div>
                                    Audit plan:{' '}
                                    {sanitizeAoiProposalDisplayText(
                                      aoiJarvisAutonomyGovernorAuditSummary.upgradePlanLabel,
                                      260,
                                    )}
                                  </div>
                                  <div>
                                    Audit freshness:{' '}
                                    {sanitizeAoiProposalDisplayText(
                                      aoiJarvisAutonomyGovernorAuditSummary.freshnessLabel,
                                      260,
                                    )}
                                  </div>
                                  {aoiJarvisAutonomyGovernorAuditSummary.freshnessReviewLabels.map(
                                    (label, index) => (
                                      <div key={`jarvis-governor-audit-freshness-${index}`}>
                                        Freshness: {sanitizeAoiProposalDisplayText(label, 260)}
                                      </div>
                                    ),
                                  )}
                                  {aoiJarvisAutonomyGovernorAuditSummary.upgradePlanStepLabels.map(
                                    (label, index) => (
                                      <div key={`jarvis-governor-audit-plan-step-${index}`}>
                                        Audit step: {sanitizeAoiProposalDisplayText(label, 260)}
                                      </div>
                                    ),
                                  )}
                                  {aoiJarvisAutonomyGovernorAuditSummary.recentEventLabels.map(
                                    (label, index) => (
                                      <div key={`jarvis-governor-audit-${index}`}>
                                        Recent: {sanitizeAoiProposalDisplayText(label, 260)}
                                      </div>
                                    ),
                                  )}
                                  <div>
                                    Boundary:{' '}
                                    {sanitizeAoiProposalDisplayText(
                                      aoiJarvisAutonomyGovernorAuditSummary.safetyBoundaryLabel,
                                      260,
                                    )}
                                  </div>
                                  {aoiJarvisAutonomyGovernorAuditSummary.lastResetLabel && (
                                    <div>
                                      Reset:{' '}
                                      {sanitizeAoiProposalDisplayText(
                                        aoiJarvisAutonomyGovernorAuditSummary.lastResetLabel,
                                        220,
                                      )}
                                    </div>
                                  )}
                                  <div className={styles.aoiInlineSuggestionActions}>
                                    <button
                                      type="button"
                                      className={styles.inlineActionBtn}
                                      onClick={restartAoiJarvisAutonomyGovernorAudit}
                                      disabled={aoiJarvisAutonomyGovernorAuditSummary.resetDisabled}
                                      title={aoiJarvisAutonomyGovernorAuditSummary.resetTitle}
                                    >
                                      {aoiJarvisAutonomyGovernorAuditSummary.resetLabel}
                                    </button>
                                  </div>
                                </>
                              )}
                              {aoiJarvisAutonomyGovernorSummary.evidenceRefs.map((ref, index) => (
                                <div key={`jarvis-governor-evidence-${index}`}>
                                  Evidence: {sanitizeAoiProposalDisplayText(ref, 220)}
                                </div>
                              ))}
                            </div>
                          </div>
                        </div>
                      )}

                      {aoiOpportunityInboxSummary.visible && (
                        <div
                          className={styles.aoiAutonomyProposalSection}
                          data-testid="aoi-opportunity-inbox"
                        >
                          <div className={styles.promptBudgetSectionTitle}>Opportunity inbox</div>
                          <div className={styles.aoiAutonomyProposalItem}>
                            <div className={styles.aoiAutonomyProposalMeta}>
                              <span>{aoiOpportunityInboxSummary.countLabel}</span>
                              <span>display-only</span>
                            </div>
                            <div className={styles.aoiAutonomyProposalTitle}>
                              {sanitizeAoiProposalDisplayText(
                                aoiOpportunityInboxSummary.headlineLabel,
                                180,
                              )}
                            </div>
                            <div className={styles.aoiAutonomyProposalReason}>
                              {sanitizeAoiProposalDisplayText(
                                aoiOpportunityInboxSummary.safetyBoundaryLabel,
                                320,
                              )}
                            </div>
                            <div className={styles.aoiAutonomyProposalDetails}>
                              <div>{aoiOpportunityInboxSummary.learningSummaryLabel}</div>
                              {aoiOpportunityInboxSummary.learningAdjustmentLabels.map(
                                (label, index) => (
                                  <div key={`opportunity-learning-${index}`}>Learning: {label}</div>
                                ),
                              )}
                            </div>
                            {aoiOpportunityInboxSummary.itemLabels.length > 0 ? (
                              <div className={styles.aoiAutonomyProposalDetails}>
                                {aoiOpportunityInboxSummary.itemLabels.map((item) => (
                                  <div key={item.id}>
                                    <strong>{item.titleLabel}</strong>
                                    <div>{item.metaLabel}</div>
                                    <div>Question: {item.curiosityLabel}</div>
                                    <div>Why now: {item.whyNowLabel}</div>
                                    <div>Evidence need: {item.evidenceNeedLabel}</div>
                                    <div>Next: {item.nextActionLabel}</div>
                                    <div>Delivery: {item.deliveryLabel}</div>
                                    <div>Governor: {item.interruptionModeLabel}</div>
                                    <div>Governor reason: {item.interruptionSummaryLabel}</div>
                                    {item.interruptionBlockedLabels.map((label, index) => (
                                      <div key={`${item.id}-interruption-blocker-${index}`}>
                                        Direct chat block: {label}
                                      </div>
                                    ))}
                                    <div>Action ladder: {item.actionLadderLevelLabel}</div>
                                    <div>Action boundary: {item.actionLadderSummaryLabel}</div>
                                    {item.actionLadderApprovalLabels.map((label, index) => (
                                      <div key={`${item.id}-action-ladder-approval-${index}`}>
                                        Approval needed: {label}
                                      </div>
                                    ))}
                                    {item.actionLadderBlockedLabels.map((label, index) => (
                                      <div key={`${item.id}-action-ladder-blocked-${index}`}>
                                        Action blocked: {label}
                                      </div>
                                    ))}
                                    <div>Follow-through: {item.followThroughLabel}</div>
                                    <div>Learning: {item.followThroughReasonLabel}</div>
                                    {item.evidenceRefs.map((ref, index) => (
                                      <div key={`${item.id}-evidence-${index}`}>
                                        Evidence: {ref}
                                      </div>
                                    ))}
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <div className={styles.aoiAutonomyProposalDetails}>
                                <div>No active display-only opportunities are waiting.</div>
                                {aoiOpportunityInboxSummary.evidenceRefs.map((ref, index) => (
                                  <div key={`opportunity-inbox-evidence-${index}`}>
                                    Evidence: {ref}
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      )}

                      {aoiFieldFeedbackPanel.visible && (
                        <div
                          className={styles.aoiAutonomyProposalSection}
                          data-testid="aoi-field-feedback-learning"
                        >
                          <div className={styles.promptBudgetSectionTitle}>
                            Field feedback learning
                          </div>
                          <div className={styles.aoiAutonomyProposalItem}>
                            <div className={styles.aoiAutonomyProposalMeta}>
                              <span>{aoiFieldFeedbackPanel.inboxCountLabel}</span>
                              <span>{aoiFieldFeedbackPanel.unlabeledCountLabel}</span>
                              <span>{aoiFieldFeedbackPanel.calibrationInputLabel}</span>
                              <span>{aoiFieldFeedbackPanel.promotionCandidateLabel}</span>
                            </div>
                            <div className={styles.aoiAutonomyProposalTitle}>
                              Label field/shadow decisions
                            </div>
                            <div className={styles.aoiAutonomyProposalDetails}>
                              {aoiFieldFeedbackPanel.labelDistributionLabels.map((label, index) => (
                                <div key={`field-feedback-distribution-${index}`}>
                                  Label: {sanitizeAoiProposalDisplayText(label, 120)}
                                </div>
                              ))}
                              {aoiFieldFeedbackPanel.topSourceKindLabels.map((label, index) => (
                                <div key={`field-feedback-source-${index}`}>
                                  Source: {sanitizeAoiProposalDisplayText(label, 160)}
                                </div>
                              ))}
                              {aoiFieldFeedbackPanel.evidenceRefs.slice(0, 4).map((ref, index) => (
                                <div key={`field-feedback-panel-evidence-${index}`}>
                                  Evidence: {sanitizeAoiProposalDisplayText(ref, 220)}
                                </div>
                              ))}
                            </div>
                            {aoiFieldFeedbackPanel.itemLabels.length > 0 ? (
                              <div className={styles.aoiAutonomyProposalList}>
                                {aoiFieldFeedbackPanel.itemLabels.map((item) => (
                                  <div
                                    className={styles.aoiAutonomyProposalItem}
                                    key={`field-feedback-item-${item.id}`}
                                  >
                                    <div className={styles.aoiAutonomyProposalMeta}>
                                      <span>
                                        {sanitizeAoiProposalDisplayText(item.metaLabel, 120)}
                                      </span>
                                      <span>
                                        {sanitizeAoiProposalDisplayText(item.labelStateLabel, 120)}
                                      </span>
                                      <span>display-only</span>
                                    </div>
                                    <div className={styles.aoiAutonomyProposalTitle}>
                                      {sanitizeAoiProposalDisplayText(item.titleLabel, 180)}
                                    </div>
                                    <div className={styles.aoiAutonomyProposalDetails}>
                                      <div>
                                        Noticed:{' '}
                                        {sanitizeAoiProposalDisplayText(
                                          item.whatAoiNoticedLabel,
                                          260,
                                        )}
                                      </div>
                                      <div>
                                        Why speak/quiet:{' '}
                                        {sanitizeAoiProposalDisplayText(
                                          item.whySpeakQuietLabel,
                                          320,
                                        )}
                                      </div>
                                      <div>
                                        Cannot know:{' '}
                                        {sanitizeAoiProposalDisplayText(item.cannotKnowLabel, 260)}
                                      </div>
                                      <div>
                                        Effect:{' '}
                                        {sanitizeAoiProposalDisplayText(
                                          item.whyShowMoreLessLabel,
                                          320,
                                        )}
                                      </div>
                                      {item.evidenceRefs.slice(0, 4).map((ref, index) => (
                                        <div key={`field-feedback-${item.id}-evidence-${index}`}>
                                          Evidence: {sanitizeAoiProposalDisplayText(ref, 220)}
                                        </div>
                                      ))}
                                    </div>
                                    <div className={styles.aoiAutonomyProposalActions}>
                                      {item.labelActions.map((action) => (
                                        <button
                                          type="button"
                                          key={action.id}
                                          className={styles.inlineActionBtn}
                                          onClick={() =>
                                            void onRecordAoiFieldFeedback(
                                              item,
                                              action.feedbackLabel,
                                            )
                                          }
                                          disabled={
                                            action.disabled || aoiAutonomyActionId === action.id
                                          }
                                          title={action.title}
                                        >
                                          {action.label}
                                        </button>
                                      ))}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <p className={styles.modelHint}>
                                No active field decisions need labels right now.
                              </p>
                            )}
                          </div>
                        </div>
                      )}

                      {aoiDeliberationRunSummary.visible && (
                        <div
                          className={styles.aoiAutonomyProposalSection}
                          data-testid="aoi-deliberation-run"
                        >
                          <div className={styles.promptBudgetSectionTitle}>Deliberation run</div>
                          <div className={styles.aoiAutonomyProposalItem}>
                            <div className={styles.aoiAutonomyProposalMeta}>
                              <span>{aoiDeliberationRunSummary.phaseLabel}</span>
                              <span>display-only</span>
                            </div>
                            <div className={styles.aoiAutonomyProposalTitle}>
                              {aoiDeliberationRunSummary.headlineLabel}
                            </div>
                            <div className={styles.aoiAutonomyProposalReason}>
                              {aoiDeliberationRunSummary.safetyBoundaryLabel}
                            </div>
                            <div className={styles.aoiAutonomyProposalDetails}>
                              <div>Opportunity: {aoiDeliberationRunSummary.opportunityLabel}</div>
                              <div>Finding: {aoiDeliberationRunSummary.findingLabel}</div>
                              {aoiDeliberationRunSummary.opinionLabel && (
                                <div>Opinion: {aoiDeliberationRunSummary.opinionLabel}</div>
                              )}
                              <div>Next: {aoiDeliberationRunSummary.safeNextActionLabel}</div>
                              {aoiDeliberationRunSummary.blockerLabels.map((blocker, index) => (
                                <div key={`aoi-deliberation-blocker-${index}`}>
                                  Blocker: {blocker}
                                </div>
                              ))}
                              {aoiDeliberationRunSummary.evidenceRefs.map((ref, index) => (
                                <div key={`aoi-deliberation-evidence-${index}`}>
                                  Evidence: {ref}
                                </div>
                              ))}
                            </div>
                          </div>
                        </div>
                      )}

                      {aoiAutonomyAgendaSummary.visible && (
                        <div className={styles.aoiAutonomyProposalSection}>
                          <div className={styles.promptBudgetSectionTitle}>Aoi agenda</div>
                          <div className={styles.aoiAutonomyProposalItem}>
                            <div className={styles.aoiAutonomyProposalMeta}>
                              <span>{aoiAutonomyAgendaSummary.loopLabel}</span>
                              <span>{aoiAutonomyAgendaSummary.approvalInboxLabel}</span>
                            </div>
                            <div className={styles.aoiAutonomyProposalTitle}>
                              {aoiAutonomyAgendaSummary.headlineLabel}
                            </div>
                            <div className={styles.aoiAutonomyProposalReason}>
                              {aoiAutonomyAgendaSummary.nextBestActionLabel}
                            </div>
                            <div className={styles.aoiAutonomyProposalDetails}>
                              <div>{aoiAutonomyAgendaSummary.safetyBoundaryLabel}</div>
                              {aoiAutonomyAgendaSummary.phaseSummaries.map((phase) => (
                                <div key={phase.key}>
                                  {phase.label}: {phase.statusLabel} - {phase.primaryLabel}
                                  {phase.detailLabels.length > 0
                                    ? ` (${phase.detailLabels.join('; ')})`
                                    : ''}
                                </div>
                              ))}
                              {aoiAutonomyAgendaSummary.evidenceRefs.map((ref, index) => (
                                <div key={`agenda-evidence-${index}`}>Evidence: {ref}</div>
                              ))}
                            </div>
                          </div>
                        </div>
                      )}

                      {aoiAgendaNudgeReadinessSummary.visible && (
                        <div className={styles.aoiAutonomyProposalSection}>
                          <div className={styles.promptBudgetSectionTitle}>
                            Agenda nudge readiness
                          </div>
                          <div className={styles.aoiAutonomyProposalItem}>
                            <div className={styles.aoiAutonomyProposalMeta}>
                              <span>{aoiAgendaNudgeReadinessSummary.statusLabel}</span>
                              <span>{aoiAgendaNudgeReadinessSummary.candidateLabel}</span>
                            </div>
                            <div className={styles.aoiAutonomyProposalTitle}>
                              {aoiAgendaNudgeReadinessSummary.summaryLabel}
                            </div>
                            <div className={styles.aoiAutonomyProposalDetails}>
                              {aoiAgendaNudgeReadinessSummary.deliveryDecisionLabels.map(
                                (label, index) => (
                                  <div key={`agenda-readiness-delivery-${index}`}>{label}</div>
                                ),
                              )}
                              {aoiAgendaNudgeReadinessSummary.reasonLabels.map((label, index) => (
                                <div key={`agenda-readiness-reason-${index}`}>{label}</div>
                              ))}
                              {aoiAgendaNudgeReadinessSummary.nextActionLabels.map(
                                (label, index) => (
                                  <div key={`agenda-readiness-next-${index}`}>Next: {label}</div>
                                ),
                              )}
                              {aoiAgendaNudgeReadinessSummary.evidenceRefs.map((ref, index) => (
                                <div key={`agenda-readiness-evidence-${index}`}>
                                  Evidence: {ref}
                                </div>
                              ))}
                              {aoiAgendaNudgeReadinessSummary.lastActionLabels.map(
                                (label, index) => (
                                  <div key={`agenda-readiness-audit-${index}`}>{label}</div>
                                ),
                              )}
                              {aoiAgendaNudgeReadinessSummary.lastDecisionLabels.map(
                                (label, index) => (
                                  <div key={`agenda-readiness-decision-audit-${index}`}>
                                    {label}
                                  </div>
                                ),
                              )}
                              {aoiAgendaNudgeReadinessSummary.lastDecisionFeedbackLabels.map(
                                (label, index) => (
                                  <div key={`agenda-readiness-feedback-audit-${index}`}>
                                    {label}
                                  </div>
                                ),
                              )}
                              {aoiAgendaNudgeReadinessSummary.decisionFeedbackHistoryLabels.map(
                                (label, index) => (
                                  <div key={`agenda-readiness-feedback-history-${index}`}>
                                    {label}
                                  </div>
                                ),
                              )}
                            </div>
                            {aoiAgendaNudgeReadinessSummary.actions.length > 0 && (
                              <div className={styles.aoiInlineSuggestionActions}>
                                {aoiAgendaNudgeReadinessSummary.actions.map((action) => (
                                  <button
                                    key={action.id}
                                    type="button"
                                    className={styles.inlineActionBtn}
                                    onClick={() => runAoiAgendaNudgeReadinessAction(action.id)}
                                    disabled={isAoiAgendaNudgeReadinessActionDisabled(action.id)}
                                    title={action.title}
                                  >
                                    {action.label}
                                  </button>
                                ))}
                              </div>
                            )}
                            {aoiAgendaNudgeReadinessSummary.decisionFeedbackActions.length > 0 && (
                              <div className={styles.aoiInlineSuggestionActions}>
                                {aoiAgendaNudgeReadinessSummary.decisionFeedbackActions.map(
                                  (action) => (
                                    <button
                                      key={action.id}
                                      type="button"
                                      className={styles.inlineActionBtn}
                                      onClick={() => runAoiAgendaNudgeDecisionFeedback(action.id)}
                                      disabled={action.disabled}
                                      title={action.title}
                                    >
                                      {action.label}
                                    </button>
                                  ),
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      )}

                      {aoiAgendaNudgeCalibrationSummary.visible && (
                        <div className={styles.aoiAutonomyProposalSection}>
                          <div className={styles.promptBudgetSectionTitle}>
                            Agenda nudge calibration
                          </div>
                          <div className={styles.aoiAutonomyProposalItem}>
                            <div className={styles.aoiAutonomyProposalMeta}>
                              <span>{aoiAgendaNudgeCalibrationSummary.statusLabel}</span>
                              {aoiAgendaNudgeCalibrationSummary.countLabels.map((label) => (
                                <span key={label}>{label}</span>
                              ))}
                            </div>
                            <div className={styles.aoiAutonomyProposalTitle}>
                              {aoiAgendaNudgeCalibrationSummary.summaryLabel}
                            </div>
                            <div className={styles.aoiAutonomyProposalDetails}>
                              {aoiAgendaNudgeCalibrationSummary.reasonLabels.map((label, index) => (
                                <div key={`agenda-calibration-reason-${index}`}>{label}</div>
                              ))}
                              {aoiAgendaNudgeCalibrationSummary.auditLabels.map((label, index) => (
                                <div key={`agenda-calibration-audit-${index}`}>{label}</div>
                              ))}
                              {aoiAgendaNudgeCalibrationSummary.evidenceRefs.map((ref, index) => (
                                <div key={`agenda-calibration-evidence-${index}`}>
                                  Evidence: {ref}
                                </div>
                              ))}
                            </div>
                            <div className={styles.aoiInlineSuggestionActions}>
                              <button
                                type="button"
                                className={styles.inlineActionBtn}
                                onClick={() =>
                                  onUpdateAoiAutonomyPanelSettings(
                                    buildAoiAgendaNudgeFeedbackResetPatch(),
                                  )
                                }
                                disabled={aoiAgendaNudgeCalibrationSummary.resetDisabled}
                                title={aoiAgendaNudgeCalibrationSummary.resetTitle}
                              >
                                {aoiAgendaNudgeCalibrationSummary.resetLabel}
                              </button>
                            </div>
                          </div>
                        </div>
                      )}

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
                                {aoiOperatorHealthSummary.recommendationLabels.map(
                                  (label, index) => (
                                    <div key={`health-recommendation-${index}`}>Next: {label}</div>
                                  ),
                                )}
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
                        <div className={styles.field}>
                          <label className={styles.label}>Autonomy mode</label>
                          <select
                            className={styles.select}
                            value={
                              aoiAutonomyPolicy ? inferAoiAutonomyMode(aoiAutonomyPolicy) : 'off'
                            }
                            onChange={(event) => {
                              const mode = event.target.value as AoiAutonomyMode;
                              void (async () => {
                                if (aoiAutonomyPolicy) {
                                  await onUpdateAoiAutonomyPolicy(
                                    applyAoiAutonomyModeToPolicy(
                                      aoiAutonomyPolicy,
                                      mode,
                                      Date.now(),
                                    ),
                                  );
                                }
                                onUpdateAoiAutonomyPanelSettings(
                                  applyAoiAutonomyModeToPanel(aoiAutonomyPanelSettings, mode),
                                );
                              })();
                            }}
                            disabled={!aoiAutonomyPolicy || aoiAutonomyActionId === 'policy'}
                            data-testid="aoi-autonomy-mode-select"
                          >
                            {AOI_AUTONOMY_MODES.map((mode) => (
                              <option key={mode} value={mode}>
                                {aoiAutonomyModeLabel(mode)}
                              </option>
                            ))}
                          </select>
                        </div>
                        {aoiAutonomyPolicy &&
                          inferAoiAutonomyMode(aoiAutonomyPolicy) === 'full' && (
                            <div className={styles.promptBudgetMetric}>
                              <span className={styles.promptBudgetLabel}>Host-PC capabilities</span>
                              <button
                                type="button"
                                className={styles.cancelBtn}
                                title="Enable host-PC capabilities (screen capture, process kill, file delete). This is the explicit confirmation; irreversible actions still require per-action approval."
                                data-testid="aoi-autonomy-enable-host-caps"
                                onClick={() => {
                                  void (async () => {
                                    for (const capability of aoiAutonomyModeHostCapabilities(
                                      'full',
                                    )) {
                                      try {
                                        await setAoiHostBridgeKillSwitch('set', {
                                          capability,
                                          enabled: true,
                                        });
                                        const link = getAoiHostBridgeConsentLink(capability);
                                        if (link) {
                                          await onUpdateAoiEnvironmentSource(
                                            link.sourceId,
                                            buildAoiHostBridgeLinkedSourcePatch(link, true),
                                          );
                                        }
                                      } catch {
                                        // Host-bridge daemon may be unavailable; leave that
                                        // capability disabled (fail-closed).
                                      }
                                    }
                                  })();
                                }}
                              >
                                Enable
                              </button>
                            </div>
                          )}
                        <details className={styles.field}>
                          <summary className={styles.label}>Advanced (individual toggles)</summary>
                          <div className={styles.promptBudgetMetric}>
                            <span className={styles.promptBudgetLabel}>Autonomy policy</span>
                            <button
                              type="button"
                              className={
                                aoiAutonomyPolicy?.enabled ? styles.saveBtn : styles.cancelBtn
                              }
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
                          <div className={styles.promptBudgetMetric}>
                            <span className={styles.promptBudgetLabel}>Thinking (network)</span>
                            <button
                              type="button"
                              className={
                                aoiAutonomyPolicy?.allowNetwork ? styles.saveBtn : styles.cancelBtn
                              }
                              onClick={() =>
                                void onUpdateAoiAutonomyPolicy({
                                  allowNetwork: !aoiAutonomyPolicy?.allowNetwork,
                                })
                              }
                              disabled={!aoiAutonomyPolicy || aoiAutonomyActionId === 'policy'}
                              data-testid="aoi-autonomy-thinking-toggle"
                            >
                              {aoiAutonomyPolicy?.allowNetwork ? 'On' : 'Off'}
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
                              onClick={() => {
                                const enabled = !aoiAutonomyPolicy?.proactiveSuggestionsEnabled;
                                void onUpdateAoiAutonomyPolicy({
                                  proactiveSuggestionsEnabled: enabled,
                                  ...(aoiAutonomyPolicy
                                    ? {
                                        proactiveBriefing: {
                                          ...aoiAutonomyPolicy.proactiveBriefing,
                                          enabled,
                                        },
                                      }
                                    : {}),
                                });
                              }}
                              disabled={!aoiAutonomyPolicy || aoiAutonomyActionId === 'policy'}
                            >
                              {aoiAutonomyPolicy?.proactiveSuggestionsEnabled ? 'On' : 'Off'}
                            </button>
                          </div>
                          <div className={styles.promptBudgetMetric}>
                            <span className={styles.promptBudgetLabel}>Field-shadow capture</span>
                            <button
                              type="button"
                              className={
                                aoiAutonomyPolicy?.fieldShadowCaptureEnabled
                                  ? styles.saveBtn
                                  : styles.cancelBtn
                              }
                              onClick={() =>
                                void onUpdateAoiAutonomyPolicy({
                                  fieldShadowCaptureEnabled:
                                    !aoiAutonomyPolicy?.fieldShadowCaptureEnabled,
                                })
                              }
                              disabled={!aoiAutonomyPolicy || aoiAutonomyActionId === 'policy'}
                              data-testid="aoi-field-shadow-capture-toggle"
                            >
                              {aoiAutonomyPolicy?.fieldShadowCaptureEnabled ? 'On' : 'Off'}
                            </button>
                          </div>
                          <div className={styles.promptBudgetMetric}>
                            <span className={styles.promptBudgetLabel}>Scout policy</span>
                            <button
                              type="button"
                              className={
                                aoiAutonomyPolicy?.proactiveBriefing.enabled
                                  ? styles.saveBtn
                                  : styles.cancelBtn
                              }
                              onClick={() => {
                                if (!aoiAutonomyPolicy) {
                                  return;
                                }
                                void onUpdateAoiAutonomyPolicy({
                                  proactiveBriefing: {
                                    ...aoiAutonomyPolicy.proactiveBriefing,
                                    enabled: !aoiAutonomyPolicy.proactiveBriefing.enabled,
                                  },
                                });
                              }}
                              disabled={!aoiAutonomyPolicy || aoiAutonomyActionId === 'policy'}
                              title="Pause or resume proactive current-info scouting"
                            >
                              {aoiAutonomyPolicy?.proactiveBriefing.enabled ? 'Resumed' : 'Paused'}
                            </button>
                          </div>
                          <div className={styles.promptBudgetMetric}>
                            <span className={styles.promptBudgetLabel}>Background scout</span>
                            <button
                              type="button"
                              className={
                                aoiAutonomyPolicy?.proactiveBriefing.allowBackgroundScout
                                  ? styles.saveBtn
                                  : styles.cancelBtn
                              }
                              onClick={() => {
                                if (!aoiAutonomyPolicy) {
                                  return;
                                }
                                void onUpdateAoiAutonomyPolicy({
                                  proactiveBriefing: {
                                    ...aoiAutonomyPolicy.proactiveBriefing,
                                    allowBackgroundScout:
                                      !aoiAutonomyPolicy.proactiveBriefing.allowBackgroundScout,
                                  },
                                });
                              }}
                              disabled={!aoiAutonomyPolicy || aoiAutonomyActionId === 'policy'}
                              title="Allow scheduler wakeups to scout current public sources"
                            >
                              {aoiAutonomyPolicy?.proactiveBriefing.allowBackgroundScout
                                ? 'On'
                                : 'Off'}
                            </button>
                          </div>
                          <div className={styles.promptBudgetMetric}>
                            <span className={styles.promptBudgetLabel}>Direct chat hooks</span>
                            <button
                              type="button"
                              className={
                                aoiAutonomyPolicy?.proactiveBriefing.directChatHookOptIn
                                  ? styles.saveBtn
                                  : styles.cancelBtn
                              }
                              onClick={() => {
                                if (!aoiAutonomyPolicy) {
                                  return;
                                }
                                void onUpdateAoiAutonomyPolicy({
                                  proactiveBriefing: {
                                    ...aoiAutonomyPolicy.proactiveBriefing,
                                    directChatHookOptIn:
                                      !aoiAutonomyPolicy.proactiveBriefing.directChatHookOptIn,
                                  },
                                });
                              }}
                              disabled={!aoiAutonomyPolicy || aoiAutonomyActionId === 'policy'}
                              title="Opt in or out of compact proactive chat hooks"
                            >
                              {aoiAutonomyPolicy?.proactiveBriefing.directChatHookOptIn
                                ? 'Opt-in'
                                : 'Off'}
                            </button>
                          </div>
                          <div className={styles.promptBudgetMetric}>
                            <span className={styles.promptBudgetLabel}>Run scout now</span>
                            <button
                              type="button"
                              className={styles.inlineActionBtn}
                              onClick={() => void onRunAoiProactiveBriefScout()}
                              disabled={
                                !aoiAutonomyPolicy ||
                                aoiAutonomyLoading ||
                                aoiAutonomyActionId === 'proactive-scout'
                              }
                              title="Run a budgeted proactive scout through scheduler gates"
                            >
                              {aoiAutonomyActionId === 'proactive-scout' ? 'Running' : 'Run'}
                            </button>
                          </div>
                          <div className={styles.promptBudgetMetric}>
                            <span className={styles.promptBudgetLabel}>Scout cooldown</span>
                            <button
                              type="button"
                              className={styles.inlineActionBtn}
                              onClick={() => void onResetAoiProactiveBriefCooldown()}
                              disabled={
                                !aoiAutonomyPolicy?.enabled ||
                                !aoiAutonomyPolicy.proactiveBriefing.enabled ||
                                aoiAutonomyActionId === 'proactive-cooldown-reset'
                              }
                              title="Reset global proactive scout cooldown when policy allows it"
                            >
                              {aoiAutonomyActionId === 'proactive-cooldown-reset'
                                ? 'Resetting'
                                : 'Reset'}
                            </button>
                          </div>
                          <div className={styles.promptBudgetMetric}>
                            <span className={styles.promptBudgetLabel}>Quiet mode</span>
                            <button
                              type="button"
                              className={
                                aoiAutonomyPanelSettings.quietMode
                                  ? styles.cancelBtn
                                  : styles.saveBtn
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
                                  notificationsEnabled:
                                    !aoiAutonomyPanelSettings.notificationsEnabled,
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
                        </details>
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
                                      onClick={() => {
                                        if (expandedAoiProposalId !== item.proposalId) {
                                          emitAoiProposalOpenedSignal({ id: item.proposalId });
                                        }
                                        setExpandedAoiProposalId((prev) =>
                                          prev === item.proposalId ? null : item.proposalId,
                                        );
                                      }}
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

                      {aoiProactiveTrendAdvisor && (
                        <div className={styles.aoiAutonomyProposalSection}>
                          <div className={styles.promptBudgetSectionTitle}>
                            Proactive trend advisor
                          </div>
                          <div className={styles.aoiAutonomyProposalList}>
                            <div className={styles.aoiAutonomyProposalDetails}>
                              <div>
                                Readiness:{' '}
                                {sanitizeAoiProposalDisplayText(
                                  `${aoiProactiveTrendAdvisor.readiness.status}; ${aoiProactiveTrendAdvisor.readiness.summary}`,
                                  320,
                                )}
                              </div>
                              <div>
                                Watches: {aoiProactiveTrendAdvisor.watchProfile.topicWatches.length}{' '}
                                / snapshots {aoiProactiveTrendAdvisor.snapshots.length}
                              </div>
                              <div>
                                Delivery: quiet {aoiProactiveTrendAdvisor.quietNotificationCount} /
                                direct {aoiProactiveTrendAdvisor.directChatHookCount}
                              </div>
                              <div>
                                Delivery audit: inline{' '}
                                {aoiProactiveTrendAdvisor.deliveryAuditSummary.inlineShownCount} /
                                chat{' '}
                                {
                                  aoiProactiveTrendAdvisor.deliveryAuditSummary
                                    .directChatOfferedCount
                                }{' '}
                                / suppressed{' '}
                                {aoiProactiveTrendAdvisor.deliveryAuditSummary.suppressedCount}
                              </div>
                              <div>
                                Source quality:{' '}
                                {sanitizeAoiProposalDisplayText(
                                  formatAoiStatusCounts(
                                    aoiProactiveTrendAdvisor.sourceQualityCounts,
                                  ),
                                  180,
                                )}
                              </div>
                              <div>
                                Interest drift:{' '}
                                {sanitizeAoiProposalDisplayText(
                                  formatAoiStatusCounts(
                                    aoiProactiveTrendAdvisor.interestDriftCounts,
                                  ),
                                  180,
                                )}
                              </div>
                              {aoiProactiveTrendAdvisor.deliveryControlBlockedReasons
                                .slice(0, 4)
                                .map((reason, index) => (
                                  <div key={`trend-control-block-${index}`}>
                                    Control block: {sanitizeAoiProposalDisplayText(reason, 120)}
                                  </div>
                                ))}
                              {aoiProactiveTrendAdvisor.recentDeliveryEvents
                                .slice(0, 3)
                                .map((event) => (
                                  <div key={`trend-delivery-event-${event.id}`}>
                                    Delivery event:{' '}
                                    {sanitizeAoiProposalDisplayText(
                                      `${event.kind} / ${event.topicLabel} / ${event.title}`,
                                      220,
                                    )}
                                  </div>
                                ))}
                              {aoiProactiveTrendAdvisor.chatHook && (
                                <div>
                                  Direct hook:{' '}
                                  {sanitizeAoiProposalDisplayText(
                                    aoiProactiveTrendAdvisor.chatHook,
                                    320,
                                  )}
                                </div>
                              )}
                              {aoiProactiveTrendAdvisor.readiness.directChatBlockedReasons
                                .slice(0, 4)
                                .map((reason, index) => (
                                  <div key={`trend-readiness-block-${index}`}>
                                    Direct chat block: {sanitizeAoiProposalDisplayText(reason, 120)}
                                  </div>
                                ))}
                            </div>
                            {aoiProactiveTrendAdvisor.opinionCards.length > 0 ? (
                              aoiProactiveTrendAdvisor.opinionCards.map((card) => (
                                <div
                                  className={styles.aoiAutonomyProposalItem}
                                  key={`proactive-trend-${card.id}`}
                                  data-testid="aoi-proactive-trend-card"
                                >
                                  <div className={styles.aoiAutonomyProposalMeta}>
                                    <span>
                                      {sanitizeAoiProposalDisplayText(card.topicLabel, 80)}
                                    </span>
                                    <span>{card.freshnessLabel}</span>
                                    <span>{card.confidenceLabel}</span>
                                    <span>{card.noveltyLabel}</span>
                                    <span>{card.sourceQualityLabel}</span>
                                    <span>{card.interestDriftLabel}</span>
                                    <span>{card.deliveryMode}</span>
                                    <span>
                                      {card.directChatAllowed
                                        ? 'direct chat ready'
                                        : 'dashboard only'}
                                    </span>
                                  </div>
                                  <div className={styles.aoiAutonomyProposalTitle}>
                                    {sanitizeAoiProposalDisplayText(card.title, 140)}
                                  </div>
                                  <div className={styles.aoiAutonomyProposalDetails}>
                                    <div>
                                      What changed:{' '}
                                      {sanitizeAoiProposalDisplayText(card.whatChanged, 320)}
                                    </div>
                                    <div>
                                      Why it matters:{' '}
                                      {sanitizeAoiProposalDisplayText(card.whyItMatters, 320)}
                                    </div>
                                    <div>
                                      My take: {sanitizeAoiProposalDisplayText(card.myTake, 320)}
                                    </div>
                                    <div>
                                      Suggested next action:{' '}
                                      {sanitizeAoiProposalDisplayText(
                                        card.suggestedNextAction,
                                        240,
                                      )}
                                    </div>
                                    <div>
                                      Delivery:{' '}
                                      {sanitizeAoiProposalDisplayText(card.deliverySummary, 260)}
                                    </div>
                                    <div>
                                      Controls:{' '}
                                      {sanitizeAoiProposalDisplayText(card.controlSummary, 220)}
                                    </div>
                                    <div>
                                      Evidence:{' '}
                                      {sanitizeAoiProposalDisplayText(
                                        card.sourceHosts.join(', ') || 'source-backed snapshot',
                                        180,
                                      )}
                                    </div>
                                    {card.directChatBlockedReasons
                                      .slice(0, 4)
                                      .map((reason, index) => (
                                        <div key={`trend-${card.id}-block-${index}`}>
                                          Direct chat block:{' '}
                                          {sanitizeAoiProposalDisplayText(reason, 120)}
                                        </div>
                                      ))}
                                    {card.evidenceRefs.slice(0, 4).map((ref, index) => (
                                      <div key={`trend-${card.id}-evidence-${index}`}>
                                        Evidence ref: {sanitizeAoiProposalDisplayText(ref, 220)}
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              ))
                            ) : (
                              <p className={styles.modelHint}>
                                No source-backed trend opinion cards are ready.
                              </p>
                            )}
                          </div>
                        </div>
                      )}

                      <div className={styles.aoiAutonomyProposalSection}>
                        <div className={styles.promptBudgetSectionTitle}>
                          Proactive interest briefs
                        </div>
                        {aoiProactiveBriefPanel.visible ? (
                          <div className={styles.aoiAutonomyProposalList}>
                            {aoiProactiveBriefPanel.hiddenLabel && (
                              <div className={styles.aoiAutonomyProposalDetails}>
                                <div>{aoiProactiveBriefPanel.hiddenLabel}</div>
                              </div>
                            )}
                            {aoiProactiveBriefPanel.calibrationSummaryLabels.length > 0 && (
                              <div className={styles.aoiAutonomyProposalDetails}>
                                {aoiProactiveBriefPanel.calibrationSummaryLabels.map(
                                  (label, index) => (
                                    <div key={`proactive-brief-calibration-${index}`}>
                                      Calibration: {sanitizeAoiProposalDisplayText(label, 220)}
                                    </div>
                                  ),
                                )}
                              </div>
                            )}
                            {aoiProactiveBriefPanel.cards.map((card) => {
                              const expanded = expandedAoiProactiveBriefId === card.id;
                              const topicControl =
                                aoiAutonomyPolicy?.proactiveBriefing.topicControls[card.topicId];
                              const topicMuted = topicControl?.muted === true;
                              const topicPinned = topicControl?.pinned === true;
                              return (
                                <div
                                  className={styles.aoiAutonomyProposalItem}
                                  key={`proactive-brief-${card.id}`}
                                  data-testid="aoi-proactive-brief-card"
                                >
                                  <div className={styles.aoiAutonomyProposalMeta}>
                                    <span>{card.status}</span>
                                    <span>{card.sourceCountLabel}</span>
                                    <span data-testid="aoi-proactive-brief-media-bucket">
                                      {card.mediaBucket === 'watch'
                                        ? 'Watch / 볼 것'
                                        : card.mediaBucket === 'listen'
                                          ? 'Listen / 들을 것'
                                          : card.mediaBucket === 'read'
                                            ? 'Read / 읽을 것'
                                            : 'Mixed / 혼합'}
                                    </span>
                                    <span>{card.delivery.selectedMode ?? 'dashboard'}</span>
                                    <span>{card.delivery.deliveryScore.toFixed(2)}</span>
                                  </div>
                                  <div className={styles.aoiAutonomyProposalTitle}>
                                    {sanitizeAoiProposalDisplayText(card.title, 140)}
                                  </div>
                                  <div className={styles.aoiAutonomyProposalReason}>
                                    {sanitizeAoiProposalDisplayText(card.hook, 220)}
                                  </div>
                                  <div className={styles.aoiAutonomyProposalDetails}>
                                    <div>
                                      Why:{' '}
                                      {sanitizeAoiProposalDisplayText(card.whyForOperator, 260)}
                                    </div>
                                    <div>
                                      Sources:{' '}
                                      {sanitizeAoiProposalDisplayText(card.sourceHostLabel, 220)}
                                    </div>
                                    <div>
                                      Freshness:{' '}
                                      {sanitizeAoiProposalDisplayText(card.freshnessLabel, 260)}
                                    </div>
                                    {card.cannotKnowLabels
                                      .slice(0, expanded ? 6 : 2)
                                      .map((label, index) => (
                                        <div key={`brief-${card.id}-cannot-${index}`}>
                                          Cannot know: {sanitizeAoiProposalDisplayText(label, 260)}
                                        </div>
                                      ))}
                                    {card.tuningLabels.map((label, index) => (
                                      <div key={`brief-${card.id}-tuning-${index}`}>
                                        Calibration: {sanitizeAoiProposalDisplayText(label, 260)}
                                      </div>
                                    ))}
                                    <div>
                                      Authority:{' '}
                                      {sanitizeAoiProposalDisplayText(
                                        card.actionAuthorityLabel,
                                        180,
                                      )}
                                    </div>
                                    {card.deliveryLadderLabels.map((label, index) => (
                                      <div key={`brief-${card.id}-ladder-${index}`}>
                                        {sanitizeAoiProposalDisplayText(label, 280)}
                                      </div>
                                    ))}
                                    {card.directChatSuppressionLabels.map((label, index) => (
                                      <div key={`brief-${card.id}-chat-suppression-${index}`}>
                                        {sanitizeAoiProposalDisplayText(label, 260)}
                                      </div>
                                    ))}
                                    {expanded && (
                                      <>
                                        <div>
                                          Summary:{' '}
                                          {sanitizeAoiProposalDisplayText(
                                            card.expandedSummaryLabel,
                                            700,
                                          )}
                                        </div>
                                        <div>
                                          Novelty:{' '}
                                          {sanitizeAoiProposalDisplayText(card.noveltyReason, 260)}
                                        </div>
                                        {card.sources.map((source, index) => (
                                          <div key={`brief-${card.id}-source-${index}`}>
                                            Source {index + 1}:{' '}
                                            {sanitizeAoiProposalDisplayText(
                                              `[${source.mediaKindLabel}] ${source.host} | ${source.title} | published ${source.publishedAtLabel} | retrieved ${source.retrievedAtLabel} | ${source.url} | ${source.snippet}`,
                                              520,
                                            )}
                                          </div>
                                        ))}
                                        {card.evidenceRefs.map((ref, index) => (
                                          <div key={`brief-${card.id}-evidence-${index}`}>
                                            Evidence: {sanitizeAoiProposalDisplayText(ref, 220)}
                                          </div>
                                        ))}
                                        {card.memoryRefs.map((ref, index) => (
                                          <div key={`brief-${card.id}-memory-${index}`}>
                                            Memory ref: {sanitizeAoiProposalDisplayText(ref, 220)}
                                          </div>
                                        ))}
                                      </>
                                    )}
                                  </div>
                                  <div className={styles.aoiAutonomyProposalActions}>
                                    {card.feedbackActions.map((action) => {
                                      const actionId = `proactive-brief:${card.id}:${action.action}`;
                                      return (
                                        <button
                                          type="button"
                                          key={actionId}
                                          className={styles.inlineActionBtn}
                                          onClick={() => {
                                            if (
                                              action.action === 'open_sources' ||
                                              action.action === 'expand_summary'
                                            ) {
                                              onToggleAoiProactiveBriefExpanded(card.id);
                                            }
                                            void onRecordAoiProactiveBriefFeedback(
                                              card.id,
                                              action.action,
                                            );
                                          }}
                                          disabled={aoiAutonomyActionId === actionId}
                                          title={action.title}
                                        >
                                          {action.label}
                                        </button>
                                      );
                                    })}
                                    <button
                                      type="button"
                                      className={styles.inlineActionBtn}
                                      onClick={() => onToggleAoiProactiveBriefExpanded(card.id)}
                                      title="Show source freshness and evidence"
                                    >
                                      {expanded ? (
                                        <ChevronDown size={14} />
                                      ) : (
                                        <ChevronRight size={14} />
                                      )}
                                      Details
                                    </button>
                                    <button
                                      type="button"
                                      className={styles.inlineActionBtn}
                                      onClick={() => {
                                        if (!aoiAutonomyPolicy) {
                                          return;
                                        }
                                        void onUpdateAoiAutonomyPolicy({
                                          proactiveBriefing: {
                                            ...aoiAutonomyPolicy.proactiveBriefing,
                                            topicControls: {
                                              ...aoiAutonomyPolicy.proactiveBriefing.topicControls,
                                              [card.topicId]: {
                                                version: 1,
                                                topicId: card.topicId,
                                                allowed: topicMuted,
                                                muted: !topicMuted,
                                                pinned: topicMuted ? topicPinned : false,
                                                updatedAt: Date.now(),
                                              },
                                            },
                                          },
                                        });
                                      }}
                                      disabled={
                                        !aoiAutonomyPolicy || aoiAutonomyActionId === 'policy'
                                      }
                                      title="Mute or unmute this proactive topic"
                                    >
                                      {topicMuted ? 'Unmute topic' : 'Mute topic'}
                                    </button>
                                    <button
                                      type="button"
                                      className={styles.inlineActionBtn}
                                      onClick={() => {
                                        if (!aoiAutonomyPolicy) {
                                          return;
                                        }
                                        void onUpdateAoiAutonomyPolicy({
                                          proactiveBriefing: {
                                            ...aoiAutonomyPolicy.proactiveBriefing,
                                            topicControls: {
                                              ...aoiAutonomyPolicy.proactiveBriefing.topicControls,
                                              [card.topicId]: {
                                                version: 1,
                                                topicId: card.topicId,
                                                allowed: true,
                                                muted: false,
                                                pinned: !topicPinned,
                                                updatedAt: Date.now(),
                                              },
                                            },
                                          },
                                        });
                                      }}
                                      disabled={
                                        !aoiAutonomyPolicy || aoiAutonomyActionId === 'policy'
                                      }
                                      title="Pin or unpin this proactive topic"
                                    >
                                      {topicPinned ? 'Unpin topic' : 'Pin topic'}
                                    </button>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        ) : (
                          <p className={styles.modelHint}>
                            No proactive interest briefs are ready.
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
                                <div className={styles.aoiAutonomyProposalTitle}>
                                  {source.label}
                                </div>
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
                              <div>
                                Governor: {aoiJarvisAutonomyGovernor.modeLabel}; mission actions
                                stay inside this autonomy ceiling.
                              </div>
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
                                            void onResetAoiTrustCalibration(
                                              item.dimension,
                                              item.key,
                                            )
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
                                        source{' '}
                                        {sanitizeAoiProposalDisplayText(source.sourceKind, 80)}:
                                        penalty {source.selectionPenalty.toFixed(2)}{' '}
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
                        <div className={styles.promptBudgetSectionTitle}>
                          Other active proposals
                        </div>
                        {visibleAoiAutonomyProposals.length > 0 ? (
                          <div className={styles.aoiAutonomyProposalList}>
                            {visibleAoiAutonomyProposals.map((proposal) => {
                              const primaryActionAllowed =
                                canShowAoiProposalPrimaryAction(proposal);
                              const proposalPending = Boolean(
                                aoiAutonomyActionId?.startsWith(`proposal:${proposal.id}:`),
                              );
                              const expanded = expandedAoiProposalId === proposal.id;
                              const policyExecutableAction = canExecuteAoiProposalAtCurrentLevel(
                                proposal,
                                aoiAutonomyPolicy,
                              );
                              const governorExecutionCapability =
                                proposal.acceptAction?.kind === 'run_command'
                                  ? 'command'
                                  : 'app_action';
                              const governorAllowsExecution = canAoiJarvisAutonomyUseCapability(
                                aoiJarvisAutonomyGovernor,
                                governorExecutionCapability,
                              );
                              const executableAction =
                                policyExecutableAction && governorAllowsExecution;
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
                                    {isAoiGoalCandidateProposal(proposal) && (
                                      <span
                                        className={styles.aoiGoalCandidateBadge}
                                        title="Accepting this proposal activates a new Aoi goal (display-only until you approve)."
                                      >
                                        Goal candidate
                                      </span>
                                    )}
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
                                      <div>
                                        Command result: {approvedCommandSummary.resultLabel}
                                      </div>
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
                                  {policyExecutableAction && !governorAllowsExecution && (
                                    <div className={styles.aoiAutonomyBlockedReason}>
                                      Governor blocked execution: current ceiling is{' '}
                                      {aoiJarvisAutonomyGovernor.modeLabel}.
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
                                      <div>
                                        Suggested action: {inspectorSummary.suggestedAction}
                                      </div>
                                      {actionPlanSummary.affectedSurfaces.map((surface, index) => (
                                        <div key={`${proposal.id}-plan-surface-${index}`}>
                                          Affected surface: {surface}
                                        </div>
                                      ))}
                                      {actionPlanSummary.validationCommands.map(
                                        (command, index) => (
                                          <div key={`${proposal.id}-plan-validation-${index}`}>
                                            Validation command: {command}
                                          </div>
                                        ),
                                      )}
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
                                      <div>
                                        Safe alternative: {inspectorSummary.safeAlternative}
                                      </div>
                                      <div>
                                        Trigger:{' '}
                                        {sanitizeAoiProposalDisplayText(proposal.trigger, 220)}
                                      </div>
                                      <div>
                                        Cooldown key:{' '}
                                        {sanitizeAoiProposalDisplayText(proposal.cooldownKey, 160)}
                                      </div>
                                      <div>
                                        Evidence refs: {inspectorSummary.evidenceRefs.length} shown
                                        / {proposal.evidenceRefs.length} total
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
                                      onClick={() =>
                                        void onDecideAoiProposal(proposal.id, 'snooze')
                                      }
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
                                      onClick={() =>
                                        void onDecideAoiProposal(proposal.id, 'dismiss')
                                      }
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
                                        onClick={() => {
                                          if (expandedAoiProposalId !== proposal.id) {
                                            emitAoiProposalOpenedSignal(proposal);
                                          }
                                          setExpandedAoiProposalId((prev) =>
                                            prev === proposal.id ? prev : proposal.id,
                                          );
                                        }}
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
                                      data-testid={`aoi-proposal-expand-${proposal.id}`}
                                      onClick={() => {
                                        if (expandedAoiProposalId !== proposal.id) {
                                          emitAoiProposalOpenedSignal(proposal);
                                        }
                                        setExpandedAoiProposalId((prev) =>
                                          prev === proposal.id ? null : proposal.id,
                                        );
                                      }}
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
                          <div className={styles.promptBudgetSectionTitle}>
                            Blocked in last check
                          </div>
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

                      <AoiStrategicOutputsSection
                        brief={aoiStrategicBrief}
                        workOrders={aoiGoalWorkOrders}
                      />
                    </>
                  )}
                </div>
              )}

              {advancedSection === 'host' && (
                <AoiHostBridgeSettingsPanel sessionPath={aoiReplaySessionPath} />
              )}

              {advancedSection === 'operator' && (
                <>
                  <AoiReplayPromotionPanel sessionPath={aoiReplaySessionPath} />
                  <AoiOperatorSnapshotPanel sessionPath={aoiReplaySessionPath} />
                  <AoiNonVoiceScorecardPanel sessionPath={aoiReplaySessionPath} />
                  <AoiSituationPanel sessionPath={aoiReplaySessionPath} />
                  <AoiRelationshipHistoryPanel sessionPath={aoiReplaySessionPath} />
                  <AoiReadinessAccrualPanel sessionPath={aoiReplaySessionPath} />
                </>
              )}

              {advancedSection === 'memory' && (
                <>
                  <AoiMemoryDecayPanel sessionPath={aoiReplaySessionPath} />

                  <AoiPreferenceDashboard
                    sessionPath={aoiReplaySessionPath}
                    lang={aoiPreferenceLang}
                    onMemoriesChanged={onRefreshAoiMemories}
                    onGenerate={onGenerateAoiPreferenceQuestions}
                  />

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
                                  memory.status === 'archived' ||
                                  pendingAoiMemoryActionId === memory.id
                                }
                                title="Mark temporary for this session"
                              >
                                <RotateCcw size={14} />
                              </button>
                              <button
                                type="button"
                                className={styles.iconActionBtn}
                                onClick={() =>
                                  void handleAoiMemoryAction(memory.id, onDemoteAoiMemory)
                                }
                                disabled={
                                  memory.status !== 'active' ||
                                  pendingAoiMemoryActionId === memory.id
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
                                  memory.status === 'archived' ||
                                  pendingAoiMemoryActionId === memory.id
                                }
                                title="Archive memory"
                              >
                                <Archive size={14} />
                              </button>
                              <button
                                type="button"
                                className={styles.iconActionBtn}
                                onClick={() =>
                                  void handleAoiMemoryAction(memory.id, onDeleteAoiMemory)
                                }
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
                        No durable Aoi memories have been stored yet. Send a few meaningful chat
                        turns or use save_memory.
                      </p>
                    )}
                  </div>
                </>
              )}

              {advancedSection === 'integrations' && (
                <>
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
                        Leave as the default unless you are routing Tavily through a compatible
                        proxy.
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
                        onChange={(e) =>
                          setIdaPeMode(e.target.value as 'prescan-only' | 'mcp-http')
                        }
                      >
                        <option value="prescan-only">Pre-scan only</option>
                        <option value="mcp-http">HTTP MCP backend</option>
                      </select>
                      <span className={styles.modelHint}>
                        `Pre-scan only` uses the built-in PE triage. `HTTP MCP backend` expects an
                        MCP server reachable by URL.
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
                        Supports `ida-headless-mcp` root endpoints and `ida_pro_mcp` plugin
                        endpoints such as `http://127.0.0.1:13337/mcp`.
                      </span>
                    </div>
                  </div>
                </>
              )}

              {advancedSection === 'tools' && (
                <>
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
                                iter {entry.metrics.iterations} · tools{' '}
                                {entry.metrics.toolCallCount} ·{' '}
                                {new Date(entry.updatedAt).toLocaleTimeString()}
                              </span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className={styles.modelHint}>
                          Send a message to record Aoi's current goal, model iterations, tool calls,
                          and final delivery status.
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
                        <span className={styles.promptBudgetSectionTitle}>
                          Registered Integrations
                        </span>
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
                            <span className={styles.promptBudgetLabel}>
                              Preview before mutation
                            </span>
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
                        <span className={styles.promptBudgetSectionTitle}>
                          Recent Tool Activity
                        </span>
                        {recentToolActivity.length > 0 ? (
                          <div
                            className={styles.promptBudgetLog}
                            data-testid="recent-tool-activity"
                          >
                            {recentToolActivity.map((item, index) => (
                              <div key={`${item}-${index}`}>{item}</div>
                            ))}
                          </div>
                        ) : (
                          <p className={styles.modelHint}>
                            No tool activity has been recorded yet.
                          </p>
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
                </>
              )}
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
