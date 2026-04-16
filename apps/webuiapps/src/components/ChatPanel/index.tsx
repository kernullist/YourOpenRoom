import React, { useState, useRef, useEffect, useCallback, memo } from 'react';
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
} from 'lucide-react';
import { chat, loadConfig, loadConfigSync, saveConfig, type ChatMessage } from '@/lib/llmClient';
import {
  PROVIDER_MODELS,
  getDefaultProviderConfig,
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
  getImageGenToolDefinitions,
  isImageGenTool,
  executeImageGenTool,
} from '@/lib/imageGenTools';
import { loadTavilyConfig, loadTavilyConfigSync, type TavilyConfig } from '@/lib/tavilyClient';
import {
  executeTavilyTool,
  getTavilyToolDefinitions,
  isTavilyTool,
} from '@/lib/tavilyTools';
import { createAppFileApi } from '@/lib/fileApi';
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
  type: 'completed' | 'needs_attention';
}

const calendarReminderFileApi = createAppFileApi('calendar');
const CALENDAR_REMINDER_POLL_INTERVAL_MS = 30_000;
const CALENDAR_REMINDER_GRACE_MS = 60_000;
const KIRA_AUTOMATION_POLL_INTERVAL_MS = 10_000;
const KIRA_APP_ID = 18;
const YOUTUBE_APP_ID = 3;

async function triggerKiraAutomationScan(sessionPath: string): Promise<void> {
  await fetch('/api/kira-automation/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionPath }),
  });
}

async function drainKiraAutomationEvents(sessionPath: string): Promise<KiraAutomationEvent[]> {
  const res = await fetch(`/api/kira-automation/events?sessionPath=${encodeURIComponent(sessionPath)}`);
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

function detectPreferredLanguage(latestUserText: string): 'ko' | 'ja' | 'zh' | 'en' {
  if (latestUserText.trim()) return detectReplyLanguage(latestUserText);
  const locale = (navigator.language || 'en').toLowerCase();
  if (locale.startsWith('ko')) return 'ko';
  if (locale.startsWith('ja')) return 'ja';
  if (locale.startsWith('zh')) return 'zh';
  return 'en';
}

function buildMemoryAckMessage(text: string): string {
  const lang = detectReplyLanguage(text);
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

function shouldIncludeAppTools(latestUserMessage: string, history: ChatMessage[] = []): boolean {
  const recentContext = [...history.slice(-4).map((m) => m.content), latestUserMessage]
    .join('\n')
    .trim()
    .toLowerCase();
  if (!recentContext) return false;
  if (recentContext.includes('[user performed action in')) return true;

  return [
    'diary',
    'note',
    'notes',
    'memo',
    '메모',
    'browser',
    'reader',
    'web',
    'url',
    'link',
    'article',
    '브라우저',
    'email',
    'twitter',
    'music',
    'youtube',
    'song',
    'songs',
    'track',
    'artist',
    'play',
    'listen',
    'recommend',
    '추천',
    '노래',
    '음악',
    '듣자',
    '들어보자',
    '틀어줘',
    '재생해줘',
    '재생해',
    '들려줘',
    '재생',
    '틀어',
    '듣고',
    '유튜브',
    'calendar',
    'schedule',
    '일정',
    'album',
    'chess',
    'gomoku',
    'freecell',
    'cybernews',
    'evidencevault',
    'evidence vault',
    'wallpaper',
    'app',
    'window',
    'open app',
    'close app',
  ].some((keyword) => recentContext.includes(keyword));
}

function parseDirectMusicIntent(text: string): { query: string } | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const suffixPatterns = [
    /^(?<query>.+?)\s*(?:듣자|들어보자|틀어줘|재생해줘|재생해|들려줘|틀어|재생하자|재생)$/
      ,
    /^(?<query>.+?)\s*(?:듣고 싶어|듣고싶어|듣고싶다|듣고 싶다)$/,
    /^(?:play|listen to|put on)\s+(?<query>.+)$/i,
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

function buildDirectMusicAck(query: string, userText: string): string {
  const lang = detectReplyLanguage(userText);
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

function isDirectKiraOpenIntent(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;

  const patterns = [
    /\bkira\b.*(?:open|launch|run|start|show)/i,
    /(?:open|launch|run|start|show).*\bkira\b/i,
    /키라.*(?:실행해|열어줘|띄워줘|켜줘|보여줘)/,
    /(?:실행해|열어줘|띄워줘|켜줘|보여줘).*(?:키라|kira)/,
    /kira 실행해/i,
    /키라 띄워줘/,
  ];

  return patterns.some((pattern) => pattern.test(text));
}

function buildKiraOpenAck(userText: string): string {
  const lang = detectReplyLanguage(userText);
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

function hasUsableLLMConfig(config: LLMConfig | null | undefined): config is LLMConfig {
  return !!config?.baseUrl.trim() && !!config.model.trim();
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
  memories: MemoryEntry[] = [],
  hasTavily = false,
): string {
  let prompt = getCharacterPromptContext(character);

  if (modManager) {
    prompt += '\n' + modManager.buildStageReminder();
  }

  prompt += `
You can interact with apps on the user's device using tools.

When the user wants to interact with an app, first identify the target app from the user's intent, then:
1. list_apps — discover available apps
2. file_read("apps/{appName}/meta.yaml") — learn the target app's available actions
3. Decide whether the action is:
   - an operation action (open, search, play, navigate, switch mode, etc.), or
   - a data mutation action (create, update, delete, save)
4. For operation actions:
   - call app_action directly after reading meta.yaml
   - read guide.md only if you need extra state or schema context
5. For data mutation actions:
   - file_read("apps/{appName}/guide.md")
   - file_list/file_read — explore existing data in "apps/{appName}/data/"
   - file_write/file_delete — create/modify/delete data following the JSON schema from guide.md
   - app_action — notify the app to reload or reflect the new state

Rules:
- Always operate on the app the user specified. Do not redirect the operation to a different app or OS action.
- Data mutations MUST go through file_write/file_delete. app_action only notifies the app to reload, it cannot write data.
- Operation actions do NOT require file_write when the app action itself performs the interaction.
- After file_write, ALWAYS call app_action with the corresponding REFRESH action.
- Do NOT skip step 5. If the user asked to save/create/add something, you must file_write the data. file_list alone does not save anything.
- Do NOT skip steps 2-3 before app actions. You MUST read guide.md before ANY file_write. The guide defines the ONLY valid directory structure and file schemas. Writing to paths not defined in guide.md will cause data loss — the app will not see the files.
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

  prompt += `

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
            typeof raw === 'string' ? (JSON.parse(raw) as CalendarReminderEvent) : (raw as CalendarReminderEvent);
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
): Promise<ReminderMessagePayload> {
  const language = detectPreferredLanguage(latestUserText);
  const fallback = buildFallbackReminderMessage(event, language);
  if (!hasUsableLLMConfig(config)) return fallback;

  const languageLabel =
    language === 'ko' ? 'Korean' : language === 'ja' ? 'Japanese' : language === 'zh' ? 'Chinese' : 'English';
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
          <button
            type="button"
            className={styles.messageLink}
            onClick={() => onOpenExternal(url)}
          >
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
          <button
            type="button"
            className={styles.messageLink}
            onClick={() => onOpenExternal(part)}
          >
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
// Stage Indicator Component
// ---------------------------------------------------------------------------

const StageIndicator: React.FC<{ modManager: ModManager | null }> = ({ modManager }) => {
  if (!modManager) return null;

  const total = modManager.stageCount;
  const current = modManager.currentStageIndex;
  const finished = modManager.isFinished;

  return (
    <div className={styles.stageIndicator}>
      <span className={styles.stageText}>
        Stage {finished ? total : current + 1}/{total}
      </span>
      <div className={styles.stageDots}>
        {Array.from({ length: total }, (_, i) => (
          <div
            key={i}
            className={`${styles.stageDot} ${
              i < current || finished
                ? styles.stageDotCompleted
                : i === current
                  ? styles.stageDotCurrent
                  : ''
            }`}
          />
        ))}
      </div>
    </div>
  );
};

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
  const [config, setConfig] = useState<LLMConfig | null>(loadConfigSync);
  const [imageGenConfig, setImageGenConfig] = useState<ImageGenConfig | null>(
    loadImageGenConfigSync,
  );
  const [tavilyConfig, setTavilyConfig] = useState<TavilyConfig | null>(loadTavilyConfigSync);

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

  const sessionPathRef = useRef(sessionPath);
  sessionPathRef.current = sessionPath;

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
  const seedPrologue = useCallback((collection?: ModCollection) => {
    const entry = getActiveModEntry(collection ?? modCollection);
    const prologue = entry.config.prologue;
    if (prologue) {
      const prologueMsg: CharacterDisplayMessage = {
        id: 'prologue',
        role: 'assistant',
        content: prologue,
      };
      setMessages([prologueMsg]);
      setChatHistory([{ role: 'assistant', content: prologue }]);
    } else {
      setMessages([]);
      setChatHistory([]);
    }
    const openingReplies = entry.config.opening_rec_replies;
    setSuggestedReplies(openingReplies?.length ? openingReplies.map((r) => r.reply_text) : []);
    setCurrentEmotion(undefined);
  }, [modCollection]);

  // Reload chat history only when the session path itself changes.
  // Depending on the whole mod collection here can re-run this effect during async
  // config hydration and overwrite newly typed messages with the default prologue.
  useEffect(() => {
    console.info('[ChatPanel] Loading session state', { sessionPath });
    loadChatHistory(sessionPath).then((data) => {
      const loadedMessages = (data?.messages ?? []) as CharacterDisplayMessage[];
      const loadedHistory = data?.chatHistory ?? [];
      const hasSavedConversation = hasPersistedConversation(data);

      if (!hasSavedConversation) {
        console.info('[ChatPanel] No persisted conversation found, seeding prologue');
        // No history — seed prologue
        seedPrologue();
      } else {
        console.info('[ChatPanel] Persisted conversation found, restoring chat history', {
          messageCount: loadedMessages.length,
          historyCount: loadedHistory.length,
        });
        setMessages(loadedMessages);
        setChatHistory(loadedHistory);
        // Restore suggested replies from saved data, or from mod config if only prologue
        if (data?.suggestedReplies?.length) {
          setSuggestedReplies(data.suggestedReplies);
        } else {
          const onlyPrologue = loadedMessages.length === 1 && loadedMessages[0].id === 'prologue';
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
    seedPrologue();
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
    seedPrologue();

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

  const configRef = useRef(config);
  configRef.current = config;
  const imageGenConfigRef = useRef(imageGenConfig);
  imageGenConfigRef.current = imageGenConfig;
  const tavilyConfigRef = useRef(tavilyConfig);
  tavilyConfigRef.current = tavilyConfig;
  const modManagerRef = useRef(modManager);
  modManagerRef.current = modManager;
  const characterRef = useRef(character);
  characterRef.current = character;
  const memoriesRef = useRef(memories);
  memoriesRef.current = memories;

  // User action queue
  const actionQueueRef = useRef<string[]>([]);
  const processingRef = useRef(false);

  const processActionQueue = useCallback(async () => {
    if (processingRef.current) return;
    processingRef.current = true;

    while (actionQueueRef.current.length > 0) {
      const actionMsg = actionQueueRef.current.shift()!;
      const cfg = configRef.current;
      if (!hasUsableLLMConfig(cfg)) break;
      hasUserInteractedRef.current = true;

      const newHistory: ChatMessage[] = [
        ...chatHistoryRef.current,
        { role: 'user', content: actionMsg },
      ];
      setChatHistory(newHistory);
      setLoading(true);
      try {
        await runConversation(newHistory, cfg);
      } catch (err) {
        logger.error('ChatPanel', 'User action error:', err);
      } finally {
        setLoading(false);
      }
    }
    processingRef.current = false;
  }, []);

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
      actionQueueRef.current.push(actionMsg);
      processActionQueue();
    });
    return unsubscribe;
  }, [processActionQueue]);

  useEffect(() => {
    let disposed = false;

    const pollKiraAutomationEvents = async () => {
      if (!sessionPathRef.current) return;
      try {
        const events = await drainKiraAutomationEvents(sessionPathRef.current);
        if (disposed || events.length === 0) return;

        for (const event of events) {
          if (disposed) break;
          addMessage({
            id: `kira-automation-${event.id}`,
            role: 'assistant',
            content: event.message,
          });
          setChatHistory((prev) => [...prev, { role: 'assistant', content: event.message }]);
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
  }, [addMessage, sessionPath]);

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
            [...chatHistoryRef.current].reverse().find((message) => message.role === 'user')?.content ?? '';
          const reminder = await generateCalendarReminderMessage(
            event,
            configRef.current,
            characterRef.current,
            latestUserText,
          );

          addMessage({
            id: `calendar-reminder-${event.id}-${Date.now()}`,
            role: 'assistant',
            content: reminder.content,
            emotion: reminder.emotion,
            suggestedReplies: reminder.replies,
          });
          setSuggestedReplies(reminder.replies);
          setChatHistory((prev) => [...prev, { role: 'assistant', content: reminder.content }]);

          if (reminder.emotion) {
            clearEmotionVideoCache(characterRef.current.id);
            setCurrentEmotion(reminder.emotion);
          }

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
  }, [addMessage]);

  // Send message
  const handleSend = useCallback(
    async (overrideText?: string) => {
      const text = overrideText ?? input.trim();
      if (!text || loading) return;
      if (!hasUsableLLMConfig(config)) {
        console.info('[ChatPanel] Missing usable LLM config, opening settings modal');
        setShowSettings(true);
        return;
      }

      if (!overrideText) setInput('');
      setSuggestedReplies([]);
      hasUserInteractedRef.current = true;
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
          const ack = buildKiraOpenAck(text);
          addMessage({
            id: String(Date.now()),
            role: 'assistant',
            content: ack,
          });
          setChatHistory((prev) => [...prev, { role: 'assistant', content: ack }]);
          return;
        } catch (err) {
          console.error('[ChatPanel] Direct Kira open dispatch failed', err);
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
          const ack = buildDirectMusicAck(directMusicIntent.query, text);
          addMessage({
            id: String(Date.now()),
            role: 'assistant',
            content: ack,
          });
          setChatHistory((prev) => [...prev, { role: 'assistant', content: ack }]);
          return;
        } catch (err) {
          console.error('[ChatPanel] Direct music intent dispatch failed', err);
        }
      }

      setLoading(true);
      try {
        await runConversation(newHistory, config);
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
    [input, loading, config, chatHistory, addMessage],
  );

  // Core conversation loop
  const runConversation = async (history: ChatMessage[], cfg: LLMConfig) => {
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
    const includeAppTools = shouldIncludeAppTools(latestUserMessage, history);

    const tools = [
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
          ]
        : []),
    ];
    console.info('[ChatPanel] Tool selection', {
      latestUserMessage,
      includeAppTools,
      toolNames: tools.map((tool) => tool.function.name),
    });

    const currentMemories = memoriesRef.current;
    const fullMessages: ChatMessage[] = [
      {
        role: 'system',
        content: buildSystemPrompt(char, mm, hasImageGen, currentMemories, hasTavily),
      },
      ...history,
    ];

    let currentMessages = fullMessages;
    let iterations = 0;
    const maxIterations = 10;
    pendingToolCallsRef.current = [];

    while (iterations < maxIterations) {
      iterations++;
      console.info('[ChatPanel] LLM iteration start', {
        iteration: iterations,
        messageCount: currentMessages.length,
        toolCount: tools.length,
      });
      const response = await chat(currentMessages, tools, cfg);
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
          addMessage({
            id: String(Date.now()),
            role: 'assistant',
            content: response.content,
            toolCalls:
              pendingToolCallsRef.current.length > 0 ? [...pendingToolCallsRef.current] : undefined,
          });
          setChatHistory((prev) => [...prev, { role: 'assistant', content: response.content }]);
          pendingToolCallsRef.current = [];
        }
        break;
      }

      // Has tool calls
      const batchHasRespondTool = response.toolCalls.some((tc) => tc.function.name === 'respond_to_user');
      const batchHasMemoryTool = response.toolCalls.some((tc) => isMemoryTool(tc.function.name));
      const assistantMsg: ChatMessage = {
        role: 'assistant',
        content: response.content,
        tool_calls: response.toolCalls,
      };
      currentMessages = [...currentMessages, assistantMsg];

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

          addMessage({
            id: String(Date.now()),
            role: 'assistant',
            content,
            emotion,
            suggestedReplies: replies,
            toolCalls:
              pendingToolCallsRef.current.length > 0 ? [...pendingToolCallsRef.current] : undefined,
          });
          setSuggestedReplies(replies);
          if (emotion) {
            clearEmotionVideoCache(character.id);
            setCurrentEmotion(emotion);
          }
          pendingToolCallsRef.current = [];

          setChatHistory((prev) => [...prev, { role: 'assistant', content }]);
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
          currentMessages = [
            ...currentMessages,
            { role: 'tool', content: result, tool_call_id: tc.id },
          ];
          continue;
        }

        // ---- File tools ----
        if (isFileTool(tc.function.name)) {
          pendingToolCallsRef.current.push(
            `${tc.function.name}(${JSON.stringify(params).slice(0, 60)})`,
          );
          try {
            const result = await executeFileTool(
              tc.function.name,
              params as Record<string, string>,
            );
            console.info('[ChatPanel] File tool result', {
              tool: tc.function.name,
              resultPreview: result.slice(0, 200),
            });
            currentMessages = [
              ...currentMessages,
              { role: 'tool', content: result, tool_call_id: tc.id },
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

        // ---- Tavily web search ----
        if (isTavilyTool(tc.function.name)) {
          pendingToolCallsRef.current.push(
            `search_web(${String(params.query || '').slice(0, 48)})`,
          );
          try {
            const result = await executeTavilyTool(params, tavilyConfigRef.current);
            console.info('[ChatPanel] Tavily tool result', {
              resultPreview: result.slice(0, 200),
            });
            currentMessages = [
              ...currentMessages,
              { role: 'tool', content: result, tool_call_id: tc.id },
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
            currentMessages = [
              ...currentMessages,
              { role: 'tool', content: result, tool_call_id: tc.id },
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
            currentMessages = [
              ...currentMessages,
              { role: 'tool', content: result, tool_call_id: tc.id },
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
            currentMessages = [
              ...currentMessages,
              { role: 'tool', content: result, tool_call_id: tc.id },
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

      // Update chat history
      setChatHistory(currentMessages.slice(1));

      if (!batchHasRespondTool && batchHasMemoryTool) {
        const latestUserMessage = [...history].reverse().find((m) => m.role === 'user')?.content ?? '';
        const fallbackContent = buildMemoryAckMessage(latestUserMessage);
        console.info('[ChatPanel] Using fallback memory acknowledgement', {
          latestUserMessage,
          fallbackContent,
        });
        addMessage({
          id: String(Date.now()),
          role: 'assistant',
          content: fallbackContent,
          toolCalls:
            pendingToolCallsRef.current.length > 0 ? [...pendingToolCallsRef.current] : undefined,
        });
        setSuggestedReplies([]);
        setChatHistory((prev) => [...prev, { role: 'assistant', content: fallbackContent }]);
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
                onClick={() => setShowSettings(true)}
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
          imageGenConfig={imageGenConfig}
          onResetAll={handleResetSessionHistory}
          onSave={(c, igc) => {
            setConfig(c);
            setImageGenConfig(igc);
            saveConfig(c, igc);
            if (igc) saveImageGenConfig(igc);
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

const SettingsModal: React.FC<{
  config: LLMConfig | null;
  imageGenConfig: ImageGenConfig | null;
  onResetAll: () => void;
  onSave: (_config: LLMConfig, _igConfig: ImageGenConfig | null) => void;
  onClose: () => void;
}> = ({ config, imageGenConfig, onResetAll, onSave, onClose }) => {
  // LLM settings
  const [provider, setProvider] = useState<LLMProvider>(config?.provider || 'openrouter');
  const [apiKey, setApiKey] = useState(config?.apiKey || '');
  const [baseUrl, setBaseUrl] = useState(
    config?.baseUrl || getDefaultProviderConfig('openrouter').baseUrl,
  );
  const [model, setModel] = useState(config?.model || getDefaultProviderConfig('openrouter').model);
  const [customHeaders, setCustomHeaders] = useState(config?.customHeaders || '');
  const [manualModelMode, setManualModelMode] = useState(false);

  const isPresetModel = PROVIDER_MODELS[provider]?.includes(model) ?? false;
  const showDropdown = !manualModelMode && isPresetModel;

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

  const handleProviderChange = (p: LLMProvider) => {
    setProvider(p);
    const defaults = getDefaultProviderConfig(p);
    setBaseUrl(defaults.baseUrl);
    setModel(defaults.model);
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

  return (
    <div className={styles.overlay} data-testid="settings-overlay">
      <div className={styles.settingsModal} data-testid="settings-modal">
        <div className={styles.settingsTitle}>LLM Settings</div>

        <div className={styles.field}>
          <label className={styles.label}>Provider</label>
          <select
            className={styles.select}
            value={provider}
            onChange={(e) => handleProviderChange(e.target.value as LLMProvider)}
          >
            <option value="openai">OpenAI</option>
            <option value="anthropic">Anthropic</option>
            <option value="deepseek">DeepSeek</option>
            <option value="llama.cpp">llama.cpp</option>
            <option value="minimax">MiniMax</option>
            <option value="z.ai">Z.ai</option>
            <option value="kimi">Kimi</option>
            <option value="openrouter">OpenRouter</option>
          </select>
        </div>

        <div className={styles.field}>
          <label className={styles.label}>API Key</label>
          <input
            className={styles.fieldInput}
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="Optional for local servers"
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
                  {PROVIDER_MODELS[provider]?.map((m) => (
                    <option key={m} value={m}>
                      {m}
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
              </>
            ) : (
              <>
                <input
                  className={styles.fieldInput}
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="e.g. gpt-4-turbo"
                />
                {isPresetModel && (
                  <button
                    type="button"
                    onClick={() => setManualModelMode(false)}
                    className={styles.manualToggleBtn}
                    title="Back to model list"
                  >
                    <List size={14} />
                  </button>
                )}
              </>
            )}
          </div>
        </div>

        <div className={styles.field}>
          <label className={styles.label}>Custom Headers (one per line, Key: Value)</label>
          <textarea
            className={styles.fieldInput}
            value={customHeaders}
            onChange={(e) => setCustomHeaders(e.target.value)}
            placeholder={'X-Custom-Header: value\nAnother-Header: value'}
            rows={3}
            style={{ resize: 'vertical', fontFamily: 'monospace', fontSize: '12px' }}
          />
        </div>

        <div className={styles.settingsDivider} />
        <div className={styles.settingsTitle}>Image Generation</div>

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
              const llmCfg: LLMConfig = {
                provider,
                apiKey,
                baseUrl,
                model,
                ...(customHeaders.trim() ? { customHeaders } : {}),
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
              onSave(llmCfg, igCfg);
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
