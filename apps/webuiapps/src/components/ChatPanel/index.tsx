import React, { useState, useRef, useEffect, useCallback, useMemo, memo } from 'react';
import {
  Settings,
  Trash2,
  RotateCcw,
  Minus,
  Maximize2,
  ChevronDown,
  ChevronRight,
  Pencil,
  List,
  PanelLeft,
  PanelRight,
  Plus,
} from 'lucide-react';
import {
  chat,
  loadConfig,
  loadConfigSync,
  resolveLlmOverride,
  saveConfig,
  type ChatMessage,
} from '@/lib/llmClient';
import {
  PROVIDER_MODELS,
  getDefaultProviderConfig,
  getModelInfo,
  getProviderDisplayName,
  type LLMApiStyle,
  type LLMConfig,
  type LLMProvider,
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
} from '@/lib/appRegistry';
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
import { logger } from '@/lib/logger';
import {
  condenseConversationHistory,
  shouldEnableAppTools,
  shouldUseDialogModel,
  summarizeToolResultForModel,
} from '@/lib/chatTokenControl';
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
import { loadTavilyConfig, loadTavilyConfigSync, type TavilyConfig } from '@/lib/tavilyClient';
import { executeTavilyTool, getTavilyToolDefinitions, isTavilyTool } from '@/lib/tavilyTools';
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
import { executeIdeTool, getIdeToolDefinitions, isIdeTool } from '@/lib/ideTools';
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

const MAX_PROMPT_BUDGET_ENTRIES = 10;

type ChatDockSide = 'left' | 'right';

const CHAT_DOCK_SIDE_KEY = 'openroom-chat-dock-side';
const CHAT_DOCK_SIDE_EVENT = 'openroom-chat-dock-side-changed';

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
  type: 'started' | 'resumed' | 'completed' | 'needs_attention';
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
  return Array.isArray(data.events) ? data.events : [];
}

function hasPersistedConversation(data: ChatHistoryData | null): boolean {
  const messages = data?.messages ?? [];
  const history = data?.chatHistory ?? [];
  return messages.length > 0 || history.length > 0;
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

function parseDirectMusicIntent(text: string): { query: string } | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const suffixPatterns = [
    /^(?<query>.+?)\s*(?:듣자|들어보자|틀어줘|재생해줘|재생해|들려줘|틀어|재생하자|재생)$/,
    /^(?<query>.+?)\s*(?:듣고 싶어|듣고싶어|듣고싶다|듣고 싶다)$/,
    /^(?:play|listen to|put on)\s+(?<query>.+)$/i,
    /^(?:let'?s|lets)\s+listen(?:\s+to)?\s+(?<query>.+)$/i,
    /^(?:we should|can we|could we)\s+listen(?:\s+to)?\s+(?<query>.+)$/i,
  ];

  for (const pattern of suffixPatterns) {
    const match = trimmed.match(pattern);
    const query = match?.groups?.query?.trim();
    if (query) {
      return { query };
    }
  }

  const prefixPatterns = [
    /^(?:틀어줘|재생해줘|재생해|들려줘|틀어)\s+(?<query>.+)$/,
    /^(?:play|listen to|put on)\s+(?<query>.+)$/i,
    /^(?:let'?s|lets)\s+listen(?:\s+to)?\s+(?<query>.+)$/i,
    /^(?:we should|can we|could we)\s+listen(?:\s+to)?\s+(?<query>.+)$/i,
  ];

  for (const pattern of prefixPatterns) {
    const match = trimmed.match(pattern);
    const query = match?.groups?.query?.trim();
    if (query) {
      return { query };
    }
  }

  return null;
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
  if (config?.provider === 'codex-cli') {
    return !!config.model.trim();
  }
  return !!config?.baseUrl.trim() && !!config.model.trim();
}

function selectConversationModel(
  history: ChatMessage[],
  primaryConfig: LLMConfig | null | undefined,
  dialogConfig: DialogLlmConfig | null | undefined,
): { config: LLMConfig | null; useDialogModel: boolean } {
  const latestUserMessage = [...history].reverse().find((m) => m.role === 'user')?.content ?? '';
  const resolvedDialogConfig = resolveLlmOverride(primaryConfig ?? null, dialogConfig);
  const useDialogModel =
    hasUsableLLMConfig(resolvedDialogConfig) && shouldUseDialogModel(latestUserMessage, history);

  if (useDialogModel) {
    return { config: resolvedDialogConfig, useDialogModel: true };
  }

  return { config: primaryConfig ?? null, useDialogModel: false };
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

  prompt += `
You can interact with apps on the user's device using tools.

When the user wants to interact with an app, first identify the target app from the user's intent, then:
1. list_apps — discover available apps
2. file_read("apps/{appName}/meta.yaml") — learn the target app's available actions
2a. get_app_schema — if available, use the machine-readable schema for the target app's data files.
3. If you do not know the exact file path yet, use workspace_search to find candidate paths before file_read.
3a. If the user is asking about the real IDE workspace or source code, use ide_search instead.
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
- Data mutations MUST go through file_patch/file_write/file_delete. app_action only notifies the app to reload, it cannot write data.
- Operation actions do NOT require file_write when the app action itself performs the interaction.
- After file_patch/file_write, ALWAYS call app_action with the corresponding REFRESH action.
- Do NOT skip step 6. If the user asked to save/create/add something, you must persist the data with file_patch/file_write/file_delete. file_list alone does not save anything.
- Do NOT skip step 2 before app actions, and do NOT skip step 6 before ANY file_patch or file_write. The guide defines the ONLY valid directory structure and file schemas. Writing to paths not defined in guide.md will cause data loss — the app will not see the files.
- Prefer get_app_schema over guessing field names whenever it is available for the target app.
- Use workspace_search before file_read/file_patch/file_write whenever the exact file path is unknown.
- workspace_search is for app storage under apps/{appName}/data. ide_search is for the real OpenVSCode workspace on disk.
- workspace_search is read-only. Never treat it as a write or refresh action.
- Prefer file_patch over file_write when you only need a small exact text replacement in an existing file.
- Use preview_changes before risky file mutations when you want to inspect the exact impact first.
- If a mutation went wrong, use undo_last_action to revert the latest reversible file change in this session.
- Use read_url when the user gives you a specific URL and wants the page contents or a clean article-style extract.
- Use get_app_state when you need to know which app window is open, focused, or what an app state.json currently contains.
- Use run_command only for safe, read-only workspace verification in Aoi's IDE context, such as git status/diff or pnpm/npm test/lint/build.
- Use structured_diagnostics when the user wants lint/typecheck/test failures in structured form instead of raw command output.
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

IMPORTANT: You MUST use the respond_to_user tool to send all messages to the user. Do NOT output plain text responses. Include your emotion and 3 suggested replies.${hasImageGen ? '\n\nYou can use generate_image to create images from text prompts. The generated image will be displayed in chat.' : ''}`;

  if (hasTavily) {
    prompt += `

Web search rule:
- When the user asks you to search, look up, verify, compare current information, find recent news, or answer a fact that may have changed, use search_web first.
- Base current-information answers on search_web results instead of guessing.
- When helpful, mention the source site names or URLs naturally in your reply.`;
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

  prompt += `

Tool rule:
- If you call save_memory, you must also call respond_to_user in the same assistant turn.
- Never call save_memory by itself and stop there.`;

  prompt += buildMemoryPrompt(memories);

  return prompt;
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
            notes: '',
            remindBeforeMinutes: 15,
            completed: false,
            ...parsed,
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
  const tokenRegex = /(\[[^\]]+\]\((https?:\/\/[^\s)]+)\)|https?:\/\/[^\s)]+|\([^)]+\))/g;
  const parts = content.split(tokenRegex);

  return parts.map((part, i) => {
    if (!part) return null;

    const markdownLinkMatch = part.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/);
    if (markdownLinkMatch) {
      const [, label, url] = markdownLinkMatch;
      return (
        <span key={i} className={styles.messageLinkGroup}>
          <button type="button" className={styles.messageLink} onClick={() => onOpenExternal(url)}>
            {label}
          </button>
          <button
            type="button"
            className={styles.messageLinkInlineAction}
            onClick={() => onOpenLink(url)}
          >
            In-app
          </button>
        </span>
      );
    }

    if (/^https?:\/\/[^\s)]+$/.test(part)) {
      return (
        <span key={i} className={styles.messageLinkGroup}>
          <button type="button" className={styles.messageLink} onClick={() => onOpenExternal(part)}>
            {part}
          </button>
          <button
            type="button"
            className={styles.messageLinkInlineAction}
            onClick={() => onOpenLink(part)}
          >
            In-app
          </button>
        </span>
      );
    }

    if (/^\([^)]+\)$/.test(part)) {
      return (
        <span key={i} className={styles.emotion}>
          {part}
        </span>
      );
    }

    return <React.Fragment key={i}>{part}</React.Fragment>;
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
  const [loading, setLoading] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<AppSettingsTabKey>('chat');
  const [config, setConfig] = useState<LLMConfig | null>(loadConfigSync);
  const [dialogLlmConfig, setDialogLlmConfig] = useState<DialogLlmConfig | null>(null);
  const [idaPeConfig, setIdaPeConfig] = useState<IdaPeConfig | null>(null);
  const [kiraConfig, setKiraConfig] = useState<KiraConfig | null>(null);
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

  useEffect(() => {
    try {
      localStorage.setItem(CHAT_DOCK_SIDE_KEY, dockSide);
      window.dispatchEvent(new CustomEvent(CHAT_DOCK_SIDE_EVENT, { detail: { side: dockSide } }));
    } catch {
      // ignore persistence failures
    }
  }, [dockSide]);

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
  const [promptBudgetEntries, setPromptBudgetEntries] = useState<PromptBudgetEntry[]>([]);

  // Pending tool calls for current response (grouped per assistant turn)
  const pendingToolCallsRef = useRef<string[]>([]);
  const hasUserInteractedRef = useRef(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const chatHistoryRef = useRef(chatHistory);
  chatHistoryRef.current = chatHistory;
  const suggestedRepliesRef = useRef(suggestedReplies);
  suggestedRepliesRef.current = suggestedReplies;

  // Debounced save
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
  }, [sessionPath]);

  // Load configs from file (async override).
  // Empty deps [] is intentional: configs (character collection, mod collection,
  // chat config, image-gen config) are loaded inside the effect and written to
  // state — they are not external dependencies that should trigger re-runs.
  useEffect(() => {
    loadConfig().then((fileConfig) => {
      if (fileConfig) setConfig(fileConfig);
    });
    loadPersistedConfig().then((persisted) => {
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
    setCurrentEmotion(undefined);

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
  const toolCacheRef = useRef(createToolResultCache());

  const clearToolCache = useCallback(() => {
    toolCacheRef.current.clear();
  }, []);

  useEffect(() => {
    clearToolCache();
  }, [clearToolCache, sessionPath]);

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
      setLoading(true);
      try {
        await runConversation(newHistory, cfg, dialogConfig);
      } catch (err) {
        logger.error('ChatPanel', 'User action error:', err);
      } finally {
        setLoading(false);
      }
    }
    processingRef.current = false;
  }, [refreshConversationConfigs]);

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

      if (
        app.appName === 'kira' &&
        ['CREATE_WORK', 'UPDATE_WORK', 'REFRESH_KIRA'].includes(action.action_type)
      ) {
        void triggerKiraAutomationScan(sessionPathRef.current).catch((error) => {
          logger.error('ChatPanel', 'Kira automation scan trigger failed:', error);
        });
      }

      const actionMsg = `[User performed action in ${app.displayName} (appName: ${app.appName})] action_type: ${action.action_type}, params: ${JSON.stringify(action.params || {})}`;
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
      const text = overrideText ?? input.trim();
      if (!text || loading) return;
      const { mainConfig: liveMainConfig, dialogConfig: liveDialogConfig } =
        await refreshConversationConfigs();
      const selectedConversationModel = selectConversationModel(
        [...chatHistory, { role: 'user', content: text }],
        liveMainConfig,
        liveDialogConfig,
      );

      if (!hasUsableLLMConfig(selectedConversationModel.config)) {
        console.info('[ChatPanel] Missing usable LLM config, opening settings modal');
        setSettingsInitialTab('models');
        setShowSettings(true);
        return;
      }

      if (!overrideText) setInput('');
      setSuggestedReplies([]);
      hasUserInteractedRef.current = true;
      stopAoiTtsPlayback();
      console.info('[ChatPanel] Sending user message', {
        text,
        provider: config.provider,
        model: config.model,
        baseUrl: config.baseUrl,
      });

      const userDisplay: CharacterDisplayMessage = {
        id: String(Date.now()),
        role: 'user',
        content: text,
      };
      addMessage(userDisplay);

      const newHistory: ChatMessage[] = [...chatHistory, { role: 'user', content: text }];
      setChatHistory(newHistory);

      const inferredMemory = extractNameMemory(text);
      if (inferredMemory) {
        try {
          const saved = await saveMemory(sessionPathRef.current, inferredMemory, 'fact');
          console.info('[ChatPanel] Auto-saved name memory', saved);
          loadMemories(sessionPathRef.current).then(setMemories);
        } catch (err) {
          console.error('[ChatPanel] Failed to auto-save name memory', err);
        }
      }

      if (isDirectKiraOpenIntent(text)) {
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
          return;
        } catch (err) {
          console.error('[ChatPanel] Direct Kira open dispatch failed', err);
        }
      }

      if (isDirectIdeOpenIntent(text)) {
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
          return;
        } catch (err) {
          console.error('[ChatPanel] Direct IDE open dispatch failed', err);
        }
      }

      if (isDirectPeAnalystOpenIntent(text)) {
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
          return;
        } catch (err) {
          console.error('[ChatPanel] Direct PE Analyst open dispatch failed', err);
        }
      }

      if (isDirectYouTubeOpenIntent(text)) {
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
          return;
        } catch (err) {
          console.error('[ChatPanel] Direct YouTube open dispatch failed', err);
        }
      }

      if (isDirectPlaylistPlaybackIntent(text)) {
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
          return;
        } catch (err) {
          console.error('[ChatPanel] Direct playlist playback dispatch failed', err);
        }
      }

      const directMusicIntent = parseDirectMusicIntent(text);
      if (directMusicIntent) {
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
          return;
        } catch (err) {
          console.error('[ChatPanel] Direct music intent dispatch failed', err);
        }
      }

      setLoading(true);
      try {
        await runConversation(newHistory, selectedConversationModel.config, liveDialogConfig);
      } catch (err) {
        console.error('[ChatPanel] runConversation failed', err);
        logger.error('ChatPanel', 'Error:', err);
        addMessage({
          id: String(Date.now()),
          role: 'assistant',
          content: `Error: ${err instanceof Error ? err.message : String(err)}`,
        });
      } finally {
        setLoading(false);
      }
    },
    [
      input,
      loading,
      config,
      chatHistory,
      addMessage,
      emitAssistantMessage,
      refreshConversationConfigs,
    ],
  );

  // Core conversation loop
  const runConversation = async (
    history: ChatMessage[],
    cfg: LLMConfig,
    dialogCfg?: DialogLlmConfig | null,
  ) => {
    console.info('[ChatPanel] runConversation start', {
      historyLength: history.length,
      provider: cfg.provider,
      model: cfg.model,
    });
    await seedMetaFiles();
    await loadActionsFromMeta();
    const hasImageGen = !!imageGenConfigRef.current?.apiKey;
    const hasTavily = !!tavilyConfigRef.current?.apiKey;
    const mm = modManagerRef.current;
    const char = characterRef.current;
    const latestUserMessage = [...history].reverse().find((m) => m.role === 'user')?.content ?? '';
    const { config: activeCfg, useDialogModel } = selectConversationModel(history, cfg, dialogCfg);
    if (!hasUsableLLMConfig(activeCfg)) {
      throw new Error('No usable LLM config was found for this conversation turn.');
    }
    const includeAppTools = !useDialogModel && shouldEnableAppTools(latestUserMessage, history);
    const condensedHistory = condenseConversationHistory(history);

    const tools = useDialogModel
      ? [getRespondToUserToolDef(), getFinishTargetToolDef()]
      : [
          getRespondToUserToolDef(),
          getFinishTargetToolDef(),
          ...getMemoryToolDefinitions(),
          ...(hasTavily ? getTavilyToolDefinitions() : []),
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
        ];
    console.info('[ChatPanel] Tool selection', {
      latestUserMessage,
      useDialogModel,
      activeModel: activeCfg.model,
      includeAppTools,
      toolNames: tools.map((tool) => tool.function.name),
    });

    const currentMemories = memoriesRef.current;
    const systemPrompt = buildSystemPrompt(
      char,
      mm,
      hasImageGen,
      userProfileRef.current,
      conversationPreferencesRef.current,
      currentMemories,
      hasTavily,
    );
    const fullMessages: ChatMessage[] = [
      {
        role: 'system',
        content: systemPrompt,
      },
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
          modelRoute: useDialogModel ? 'dialog' : 'main',
          modelId: activeCfg.model,
          snapshot: seedBudgetSnapshot,
          createdAt: Date.now(),
        },
      ].slice(-MAX_PROMPT_BUDGET_ENTRIES),
    );

    let currentMessages = fullMessages;
    let iterations = 0;
    const maxIterations = 10;
    pendingToolCallsRef.current = [];
    let latestDiagnosticsParams: Record<string, unknown> | null = null;
    let latestDiagnosticsHadIssues = false;
    let fileMutatedSinceDiagnostics = false;

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
      iterations++;
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
            modelRoute: useDialogModel ? 'dialog' : 'main',
            modelId: activeCfg.model,
            snapshot: iterationBudgetSnapshot,
            createdAt: Date.now(),
          },
        ].slice(-MAX_PROMPT_BUDGET_ENTRIES),
      );
      const response = await chat(currentMessages, tools, activeCfg);
      console.info('[ChatPanel] LLM iteration response', {
        iteration: iterations,
        contentPreview: response.content.slice(0, 200),
        toolCallCount: response.toolCalls.length,
        toolNames: response.toolCalls.map((tc) => tc.function.name),
      });

      if (response.toolCalls.length === 0) {
        // No tool calls — fallback plain text (shouldn't happen with respond_to_user requirement)
        if (response.content) {
          console.info('[ChatPanel] Assistant plain-text fallback response', {
            contentPreview: response.content.slice(0, 200),
          });
          emitAssistantMessage({
            id: String(Date.now()),
            role: 'assistant',
            content: response.content,
            toolCalls:
              pendingToolCallsRef.current.length > 0 ? [...pendingToolCallsRef.current] : undefined,
          });
          pendingToolCallsRef.current = [];
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
        const parallelResults = await Promise.allSettled(
          response.toolCalls.map(async (tc) => {
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
              const result = await runCachedTool(tc.function.name, params, () =>
                executeIdeTool(params),
              );
              return {
                toolCallId: tc.id,
                pendingSummary: `ide_search(${String(params.query || '').slice(0, 48)})`,
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

          const content = expr.content ?? '';
          const emotion = expr.emotion;
          const replies = interaction.suggested_replies ?? [];
          console.info('[ChatPanel] respond_to_user received', {
            contentPreview: content.slice(0, 200),
            emotion,
            replies,
          });

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
          pendingToolCallsRef.current = [];
          currentMessages = [
            ...currentMessages,
            { role: 'tool', content: 'Message delivered.', tool_call_id: tc.id },
          ];
          shouldStopAfterToolBatch = true;
          continue;
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
          pendingToolCallsRef.current.push(
            `ide_search(${String(params.query || '').slice(0, 48)})`,
          );
          try {
            const result = await runCachedTool(tc.function.name, params, () =>
              executeIdeTool(params),
            );
            console.info('[ChatPanel] IDE tool result', {
              resultPreview: result.slice(0, 200),
            });
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
            // Refresh memories for next turn's SP
            loadMemories(sessionPathRef.current).then(setMemories);
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
          const strParams = params as Record<string, string>;
          const resolved = resolveAppAction(strParams.app_name, strParams.action_type);
          if (typeof resolved === 'string') {
            console.error('[ChatPanel] app_action resolve failed', resolved);
            currentMessages = [
              ...currentMessages,
              { role: 'tool', content: resolved, tool_call_id: tc.id },
            ];
            continue;
          }

          pendingToolCallsRef.current.push(`${strParams.app_name}/${strParams.action_type}`);

          let actionParams: Record<string, string> = {};
          if (strParams.params) {
            try {
              actionParams = JSON.parse(strParams.params);
            } catch {
              // empty
            }
          }

          try {
            const result = await dispatchAgentAction({
              app_id: resolved.appId,
              action_type: resolved.actionType,
              params: actionParams,
            });
            console.info('[ChatPanel] app_action result', {
              appName: strParams.app_name,
              actionType: resolved.actionType,
              result,
            });
            clearToolCache();
            const summarizedResult = summarizeToolResultForModel(tc.function.name, result);
            currentMessages = [
              ...currentMessages,
              { role: 'tool', content: summarizedResult, tool_call_id: tc.id },
            ];
          } catch (err) {
            console.error('[ChatPanel] app_action failed', {
              appName: strParams.app_name,
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
        setSuggestedReplies([]);
        pendingToolCallsRef.current = [];
        break;
      }

      if (shouldStopAfterToolBatch) {
        console.info('[ChatPanel] Stopping conversation loop after respond_to_user');
        break;
      }
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

  if (!visible) return null;

  return (
    <>
      <div
        className={`${styles.panel} ${compact ? styles.compact : ''} ${
          dockSide === 'left' ? styles.dockLeft : styles.dockRight
        }`}
        data-testid="chat-panel"
        style={zIndex !== null && zIndex !== undefined ? { zIndex } : undefined}
        onMouseDown={onFocus}
      >
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
        <div className={styles.chatSide}>
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
                  {msg.imageUrl && (
                    <img src={msg.imageUrl} alt="Generated" className={styles.messageImage} />
                  )}
                </div>
                {msg.toolCalls && msg.toolCalls.length > 0 && (
                  <ActionsTaken calls={msg.toolCalls} />
                )}
              </React.Fragment>
            ))}
            {loading && <div className={styles.loading}>Thinking...</div>}
            <div ref={messagesEndRef} />
          </div>

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

          <div className={styles.inputArea}>
            <textarea
              className={styles.input}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type a message..."
              rows={1}
              disabled={loading}
              data-testid="chat-input"
            />
            <button
              className={styles.sendBtn}
              onClick={() => handleSend()}
              disabled={loading || !input.trim()}
              data-testid="send-btn"
            >
              Send
            </button>
          </div>
        </div>
      </div>

      {showSettings && (
        <SettingsModal
          config={config}
          dialogConfig={dialogLlmConfig}
          idaPeConfig={idaPeConfig}
          kiraConfig={kiraConfig}
          userProfile={userProfile}
          conversationPreferences={conversationPreferences}
          ttsStatusSnapshot={ttsStatusSnapshot}
          imageGenConfig={imageGenConfig}
          promptBudgetEntries={promptBudgetEntries}
          recentToolActivity={recentToolActivity}
          toolSafetyPolicy={toolSafetyPolicy}
          initialTab={settingsInitialTab}
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
          ) => {
            setConfig(c);
            setDialogLlmConfig(dcfg);
            setIdaPeConfig(nextIdaPeConfig);
            setKiraConfig(nextKiraConfig);
            setUserProfile(nextUserProfile);
            setConversationPreferences(nextConversationPreferences);
            setImageGenConfig(igc);
            setToolSafetyPolicy(nextToolSafetyPolicy);
            userProfileRef.current = nextUserProfile;
            conversationPreferencesRef.current = nextConversationPreferences;
            saveConfig(
              c,
              igc,
              dcfg,
              nextIdaPeConfig,
              nextUserProfile,
              nextConversationPreferences,
              nextKiraConfig,
            );
            if (igc) saveImageGenConfig(igc);
            saveUserProfileConfig(nextUserProfile);
            saveConversationPreferences(nextConversationPreferences);
            saveToolSafetyPolicy(nextToolSafetyPolicy);
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
}

interface RuntimeModelOption {
  id: string;
  name: string;
}

type RuntimeModelStatus = 'idle' | 'loading' | 'loaded' | 'error';

const MODEL_PROVIDER_OPTIONS: Array<{ value: LLMProvider; label: string }> = [
  'openai',
  'anthropic',
  'deepseek',
  'llama.cpp',
  'minimax',
  'z.ai',
  'kimi',
  'openrouter',
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

function canInheritKiraApiKey(
  roleProvider: KiraAgentProvider,
  mainProvider: LLMProvider,
  mainApiKey: string,
): boolean {
  return (
    roleProvider !== 'codex-cli' && roleProvider === mainProvider && Boolean(mainApiKey.trim())
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

function isOpenCodeProvider(provider: LLMProvider): boolean {
  return provider === 'opencode' || provider === 'opencode-go';
}

function getDefaultKiraRoleConfig(
  provider: KiraAgentProvider,
  _mainConfig: LLMConfig | null,
): KiraRoleLlmConfig {
  if (provider === 'codex-cli') {
    return {
      provider,
      command: 'codex',
      model: 'gpt-5.3-codex',
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
  const base: KiraRoleLlmConfig = {
    provider: draft.provider,
    ...(draft.name.trim() ? { name: draft.name.trim() } : {}),
    ...(draft.model.trim() ? { model: draft.model.trim() } : {}),
  };

  if (draft.provider === 'codex-cli') {
    return {
      ...base,
      ...(draft.command.trim() && draft.command.trim() !== 'codex'
        ? { command: draft.command.trim() }
        : {}),
    };
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
  promptBudgetEntries: PromptBudgetEntry[];
  recentToolActivity: string[];
  toolSafetyPolicy: ToolSafetyPolicy;
  initialTab?: AppSettingsTabKey;
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
  promptBudgetEntries,
  recentToolActivity,
  toolSafetyPolicy,
  initialTab = 'chat',
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
  const [command, setCommand] = useState(config?.command || 'codex');
  const [apiStyle, setApiStyle] = useState<LLMApiStyle | ''>(config?.apiStyle || '');
  const [customHeaders, setCustomHeaders] = useState(config?.customHeaders || '');
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
  const [openRouterModels, setOpenRouterModels] = useState<RuntimeModelOption[]>([]);
  const [openRouterModelsStatus, setOpenRouterModelsStatus] = useState<RuntimeModelStatus>('idle');
  const [openRouterModelsError, setOpenRouterModelsError] = useState('');

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

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
  const [dialogEnabled, setDialogEnabled] = useState(
    Boolean(dialogConfig?.model?.trim() && dialogConfig?.baseUrl?.trim()),
  );
  const [dialogProvider, setDialogProvider] = useState<LLMProvider>(
    dialogConfig?.provider || config?.provider || 'openrouter',
  );
  const [dialogApiKey, setDialogApiKey] = useState(dialogConfig?.apiKey || '');
  const [dialogBaseUrl, setDialogBaseUrl] = useState(
    dialogConfig?.baseUrl || config?.baseUrl || getDefaultProviderConfig('openrouter').baseUrl,
  );
  const [dialogModel, setDialogModel] = useState(dialogConfig?.model || '');
  const [dialogCommand, setDialogCommand] = useState(dialogConfig?.command || 'codex');
  const [dialogApiStyle, setDialogApiStyle] = useState<LLMApiStyle | ''>(
    dialogConfig?.apiStyle || '',
  );
  const [dialogCustomHeaders, setDialogCustomHeaders] = useState(dialogConfig?.customHeaders || '');
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
  const recentMutations = useMemo(() => listRecentMutations().slice(0, 8), []);
  const activeBackgroundWatches = useMemo(() => listBackgroundWatches().slice(0, 8), []);
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
    if (usesOpenRouterModels && openRouterModelsStatus === 'idle') {
      void refreshOpenRouterModels();
    }
  }, [openRouterModelsStatus, refreshOpenRouterModels, usesOpenRouterModels]);

  const handleProviderChange = (p: LLMProvider) => {
    setProvider(p);
    const defaults = getDefaultProviderConfig(p);
    setBaseUrl(defaults.baseUrl);
    setModel(defaults.model);
    setCommand(defaults.command || 'codex');
    setApiStyle(defaults.apiStyle || '');
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
    setDialogCommand(defaults.command || 'codex');
    setDialogApiStyle(defaults.apiStyle || '');
    setDialogModel(defaults.model);
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
  const settingsTabs: Array<{ key: SettingsTabKey; label: string }> = [
    { key: 'chat', label: 'Chat' },
    { key: 'models', label: 'Models' },
    { key: 'kira', label: 'Kira' },
    { key: 'image', label: 'Image' },
    { key: 'advanced', label: 'Advanced' },
  ];

  const renderKiraRoleFields = (
    draft: KiraRoleDraft,
    title: string,
    subtitle: string,
    onChange: (patch: Partial<KiraRoleDraft>) => void,
    onProviderChange: (provider: KiraAgentProvider) => void,
    removable?: boolean,
  ) => {
    const isCodexCli = isCodexCliProvider(draft.provider);
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

        {isCodexCli ? (
          <>
            <div className={styles.field}>
              <label className={styles.label}>Command</label>
              <input
                className={styles.fieldInput}
                value={draft.command}
                onChange={(e) => onChange({ command: e.target.value })}
                placeholder="codex"
              />
              <span className={styles.modelHint}>
                Uses your local Codex CLI session. Run `codex login` before using this provider.
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
                  placeholder="gpt-5.3-codex"
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
                    : isOpenCode
                      ? 'Optional if OPENCODE_API_KEY is set'
                      : 'Optional if inherited from environment'
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

                {isCodexCliProvider(provider) ? (
                  <div className={styles.field}>
                    <label className={styles.label}>Command</label>
                    <input
                      className={styles.fieldInput}
                      value={command}
                      onChange={(e) => setCommand(e.target.value)}
                      placeholder="codex"
                    />
                    <span className={styles.modelHint}>
                      Uses your local Codex CLI login. Tool calls are not available through this
                      chat provider.
                    </span>
                  </div>
                ) : (
                  <>
                    <div className={styles.field}>
                      <label className={styles.label}>API Key</label>
                      <input
                        className={styles.fieldInput}
                        type="password"
                        value={apiKey}
                        onChange={(e) => setApiKey(e.target.value)}
                        placeholder={
                          isOpenCodeProvider(provider)
                            ? 'OpenCode API key'
                            : 'Optional for local servers'
                        }
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
                </div>

                {!isCodexCliProvider(provider) ? (
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

                    {isCodexCliProvider(dialogProvider) ? (
                      <div className={styles.field}>
                        <label className={styles.label}>Command</label>
                        <input
                          className={styles.fieldInput}
                          value={dialogCommand}
                          onChange={(e) => setDialogCommand(e.target.value)}
                          placeholder="codex"
                        />
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
                            placeholder={
                              isOpenCodeProvider(dialogProvider)
                                ? 'OpenCode API key'
                                : 'Optional — falls back to main config when blank'
                            }
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

                    {!isCodexCliProvider(dialogProvider) ? (
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
              const mainIsCodexCli = isCodexCliProvider(provider);
              const dialogIsCodexCli = isCodexCliProvider(dialogProvider);
              const llmCfg: LLMConfig = {
                provider,
                apiKey: mainIsCodexCli ? '' : apiKey,
                baseUrl: mainIsCodexCli ? '' : baseUrl.trim(),
                model,
                ...(mainIsCodexCli && command.trim() && command.trim() !== 'codex'
                  ? { command: command.trim() }
                  : {}),
                ...(!mainIsCodexCli && apiStyle ? { apiStyle } : {}),
                ...(!mainIsCodexCli && customHeaders.trim() ? { customHeaders } : {}),
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
                dialogEnabled && dialogModel.trim() && (dialogIsCodexCli || dialogBaseUrl.trim())
                  ? {
                      provider: dialogProvider,
                      model: dialogModel.trim(),
                      baseUrl: dialogIsCodexCli ? '' : dialogBaseUrl.trim(),
                      ...(dialogIsCodexCli &&
                      dialogCommand.trim() &&
                      dialogCommand.trim() !== 'codex'
                        ? { command: dialogCommand.trim() }
                        : {}),
                      ...(!dialogIsCodexCli && dialogApiKey.trim()
                        ? { apiKey: dialogApiKey.trim() }
                        : {}),
                      ...(!dialogIsCodexCli && dialogApiStyle ? { apiStyle: dialogApiStyle } : {}),
                      ...(!dialogIsCodexCli && dialogCustomHeaders.trim()
                        ? { customHeaders: dialogCustomHeaders }
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
              };
              const nextKiraConfig: KiraConfig = {
                ...(kiraWorkRootDirectory.trim()
                  ? { workRootDirectory: kiraWorkRootDirectory.trim() }
                  : {}),
                workers: kiraWorkers.slice(0, 3).map(kiraDraftToConfig),
                reviewerLlm: kiraDraftToConfig(kiraReviewer),
                projectDefaults: {
                  autoCommit: kiraAutoCommit,
                },
              };
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
