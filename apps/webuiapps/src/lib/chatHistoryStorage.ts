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

export type ChatHistoryLoadResult =
  | { status: 'ok'; data: ChatHistoryData }
  | { status: 'missing' }
  | { status: 'error'; error: string };

/**
 * Load chat.json and say WHICH kind of "nothing" it was.
 *
 * loadChatHistory returns null for a missing file, a 500, a network error and a
 * half-written (unparseable) file alike, and the caller seeded a fresh prologue
 * for every one of them -- which the 500 ms autosave then wrote over the real
 * transcript. Only `missing` means there is no conversation to protect. The
 * session-data API answers a missing file with exactly `{}`; a 404 from another
 * backend says the same, and nothing exists there to overwrite.
 */
export async function loadChatHistoryResult(sessionPath: string): Promise<ChatHistoryLoadResult> {
  let res: Response;
  try {
    res = await fetch(apiUrl(sessionPath, 'chat.json'));
  } catch (error) {
    return { status: 'error', error: error instanceof Error ? error.message : String(error) };
  }
  if (res.status === 404) {
    return { status: 'missing' };
  }
  if (!res.ok) {
    return { status: 'error', error: `HTTP ${res.status}` };
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch (error) {
    return { status: 'error', error: error instanceof Error ? error.message : String(error) };
  }
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    if ((data as { version?: unknown }).version === 1) {
      return { status: 'ok', data: data as ChatHistoryData };
    }
    if (Object.keys(data).length === 0) {
      return { status: 'missing' };
    }
  }
  return { status: 'error', error: 'chat.json has an unknown format' };
}

export async function loadChatHistory(sessionPath: string): Promise<ChatHistoryData | null> {
  const result = await loadChatHistoryResult(sessionPath);
  return result.status === 'ok' ? result.data : null;
}

/**
 * loadChatHistoryResult, retried on `error` a couple of times: on Windows a read
 * can fail with EBUSY/EPERM while an indexer or sync client holds the file, and
 * a second tab can catch a write half done. Missing and ok are final.
 */
export async function loadChatHistoryWithRetry(
  sessionPath: string,
  attempts = 3,
  delayMs = 400,
): Promise<ChatHistoryLoadResult> {
  let result = await loadChatHistoryResult(sessionPath);
  for (let attempt = 1; attempt < attempts && result.status === 'error'; attempt += 1) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs * attempt));
    result = await loadChatHistoryResult(sessionPath);
  }
  return result;
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
