/**
 * Chat History Persistence
 *
 * Persists chat history per session (character × mod) to
 * ~/.openroom/sessions/{charId}/{modId}/chat.json via dev-server API.
 */

import type { ChatImageAttachment, ChatMessage } from './llmClient';

export interface DisplayMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  imageUrl?: string;
  attachments?: ChatImageAttachment[];
  // Shown in the transcript for the current page lifetime only. Ephemeral
  // messages (provider error notices, cancel notes) are dropped on save so a
  // multi-kilobyte CLI stderr dump can never become durable session history.
  ephemeral?: boolean;
}

export interface ChatHistoryData {
  version: 1;
  savedAt: number;
  messages: DisplayMessage[];
  chatHistory: ChatMessage[];
  suggestedReplies?: string[];
}

/** Build session path segment from character and mod IDs */
export function buildSessionPath(charId: string, modId: string): string {
  return `${charId}/${modId}`;
}

export interface ConversationRestorePlan<T> {
  // True when a user message appeared after the history load started. The
  // caller must keep the live conversation on screen and only prepend
  // restoredPrefix instead of replacing state with the loaded transcript.
  liveConversationStarted: boolean;
  // Loaded messages not already on screen, in saved order, for prepending.
  restoredPrefix: T[];
}

/**
 * Decide how an async history restore may apply on top of the live message
 * state. Guards the race where the user (or an e2e spec) sends a message while
 * loadChatHistory is still in flight: a blind setMessages(loaded) would wipe
 * that live conversation. Baseline ids are the messages that were on screen
 * when the load STARTED, so a session switch (old messages still visible, none
 * newly typed) restores normally while newly typed user messages block the
 * replace and downgrade it to a prepend-merge.
 */
export function planConversationRestore<T extends Pick<DisplayMessage, 'id' | 'role'>>(params: {
  baselineMessageIds: ReadonlySet<string>;
  liveMessages: readonly T[];
  loadedMessages: readonly T[];
}): ConversationRestorePlan<T> {
  const { baselineMessageIds, liveMessages, loadedMessages } = params;
  const liveConversationStarted = liveMessages.some(
    (msg) => msg.role === 'user' && !baselineMessageIds.has(msg.id),
  );
  if (!liveConversationStarted) {
    return { liveConversationStarted: false, restoredPrefix: [] };
  }
  const liveIds = new Set(liveMessages.map((msg) => msg.id));
  return {
    liveConversationStarted: true,
    restoredPrefix: loadedMessages.filter((msg) => !liveIds.has(msg.id)),
  };
}

// A provider failure must stay readable in the transcript without preserving
// the whole stderr/stack dump some providers put in error.message (a codex CLI
// failure once persisted a ~50k-char prompt dump as a chat message).
const MAX_ERROR_NOTICE_CHARS = 600;
const MAX_ERROR_NOTICE_LINES = 4;

export function formatChatErrorNotice(err: unknown): string {
  const raw = (err instanceof Error ? err.message : String(err)).trim() || 'Unknown error';
  const head = raw
    .split('\n')
    .slice(0, MAX_ERROR_NOTICE_LINES)
    .join('\n')
    .slice(0, MAX_ERROR_NOTICE_CHARS)
    .trimEnd();
  if (head.length >= raw.length) {
    return `Error: ${raw}`;
  }
  return `Error: ${head}\n... (${raw.length - head.length} more characters, see console log)`;
}

export function filterPersistableDisplayMessages<T extends Pick<DisplayMessage, 'ephemeral'>>(
  messages: readonly T[],
): T[] {
  return messages.filter((msg) => !msg.ephemeral);
}

const API_PATH = '/api/session-data';

function apiUrl(sessionPath: string, file: string): string {
  return `${API_PATH}?path=${encodeURIComponent(`${sessionPath}/chat/${file}`)}`;
}

export async function loadChatHistory(sessionPath: string): Promise<ChatHistoryData | null> {
  try {
    const res = await fetch(apiUrl(sessionPath, 'chat.json'));
    if (res.ok) {
      const data: ChatHistoryData = await res.json();
      if (data && data.version === 1) {
        return data;
      }
    }
  } catch {
    // API not available
  }
  return null;
}

/** @deprecated kept for backward compat, always returns null now */
export function loadChatHistorySync(_sessionPath: string): ChatHistoryData | null {
  return null;
}

export async function saveChatHistory(
  sessionPath: string,
  messages: DisplayMessage[],
  chatHistory: ChatMessage[],
  suggestedReplies?: string[],
): Promise<void> {
  const persistableMessages = filterPersistableDisplayMessages(messages);
  const data: ChatHistoryData = {
    version: 1,
    savedAt: Date.now(),
    messages: persistableMessages,
    chatHistory,
    suggestedReplies,
  };

  try {
    const url = apiUrl(sessionPath, 'chat.json');
    console.info('[ChatHistory] Saving chat history', {
      sessionPath,
      url,
      messageCount: persistableMessages.length,
      historyCount: chatHistory.length,
    });
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const text = await res.text();
      console.error('[ChatHistory] Failed to save chat history', {
        status: res.status,
        body: text,
      });
    }
  } catch {
    console.error('[ChatHistory] Failed to save chat history due to network/API error');
  }
}

export async function clearChatHistory(sessionPath: string): Promise<void> {
  try {
    await fetch(apiUrl(sessionPath, 'chat.json'), { method: 'DELETE' });
  } catch {
    // Silently ignore
  }
}
