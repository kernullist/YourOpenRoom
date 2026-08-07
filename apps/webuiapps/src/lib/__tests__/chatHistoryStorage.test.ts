import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatHistoryData, DisplayMessage } from '../chatHistoryStorage';
import type { ChatMessage } from '../llmClient';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const SESSION_PATH = 'char-1/mod-1';

function expectedUrl(file: string): string {
  return `/api/session-data?path=${encodeURIComponent(`${SESSION_PATH}/chat/${file}`)}`;
}

const sampleMessages: DisplayMessage[] = [
  { id: '1', role: 'user', content: 'Hello' },
  { id: '2', role: 'assistant', content: 'Hi there!' },
];

const sampleChatHistory: ChatMessage[] = [
  { role: 'user', content: 'Hello' },
  { role: 'assistant', content: 'Hi there!' },
];

function makeSavedData(msgs = sampleMessages, history = sampleChatHistory): ChatHistoryData {
  return { version: 1, savedAt: Date.now(), messages: msgs, chatHistory: history };
}

describe('chatHistoryStorage', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.resetModules();
  });

  describe('loadChatHistorySync', () => {
    it('returns null', async () => {
      const { loadChatHistorySync } = await import('../chatHistoryStorage');
      expect(loadChatHistorySync(SESSION_PATH)).toBeNull();
    });
  });

  describe('loadChatHistory', () => {
    it('loads from API', async () => {
      const data = makeSavedData();
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(data),
      });
      const { loadChatHistory } = await import('../chatHistoryStorage');

      const result = await loadChatHistory(SESSION_PATH);

      expect(fetchMock).toHaveBeenCalledWith(expectedUrl('chat.json'));
      expect(result).not.toBeNull();
      expect(result!.messages).toEqual(sampleMessages);
    });

    it('returns null when API returns non-ok', async () => {
      fetchMock.mockResolvedValueOnce({ ok: false, status: 404 });
      const { loadChatHistory } = await import('../chatHistoryStorage');

      const result = await loadChatHistory(SESSION_PATH);

      expect(result).toBeNull();
    });

    it('returns null when fetch throws', async () => {
      fetchMock.mockRejectedValueOnce(new Error('network error'));
      const { loadChatHistory } = await import('../chatHistoryStorage');

      const result = await loadChatHistory(SESSION_PATH);

      expect(result).toBeNull();
    });

    it('returns null when API is empty', async () => {
      fetchMock.mockResolvedValueOnce({ ok: false, status: 404 });
      const { loadChatHistory } = await import('../chatHistoryStorage');

      const result = await loadChatHistory(SESSION_PATH);
      expect(result).toBeNull();
    });
  });

  describe('saveChatHistory', () => {
    it('POSTs to API with expected payload', async () => {
      fetchMock.mockResolvedValueOnce({ ok: true });
      const { saveChatHistory } = await import('../chatHistoryStorage');

      await saveChatHistory(SESSION_PATH, sampleMessages, sampleChatHistory);

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, options] = fetchMock.mock.calls[0];
      expect(url).toBe(expectedUrl('chat.json'));
      expect(options.method).toBe('POST');
      const body = JSON.parse(options.body);
      expect(body.version).toBe(1);
      expect(body.messages).toEqual(sampleMessages);
      expect(body.chatHistory).toEqual(sampleChatHistory);
    });

    it('does not throw when fetch fails', async () => {
      fetchMock.mockRejectedValueOnce(new Error('network error'));
      const { saveChatHistory } = await import('../chatHistoryStorage');

      await expect(
        saveChatHistory(SESSION_PATH, sampleMessages, sampleChatHistory),
      ).resolves.toBeUndefined();
    });

    it('drops ephemeral messages so error notices never become durable history', async () => {
      fetchMock.mockResolvedValueOnce({ ok: true });
      const { saveChatHistory } = await import('../chatHistoryStorage');

      const withEphemeral: DisplayMessage[] = [
        ...sampleMessages,
        { id: '3', role: 'assistant', content: 'Error: provider exploded', ephemeral: true },
      ];
      await saveChatHistory(SESSION_PATH, withEphemeral, sampleChatHistory);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.messages).toEqual(sampleMessages);
    });
  });

  describe('formatChatErrorNotice', () => {
    it('keeps a short error intact', async () => {
      const { formatChatErrorNotice } = await import('../chatHistoryStorage');

      expect(formatChatErrorNotice(new Error('LLM API error 401: bad key'))).toBe(
        'Error: LLM API error 401: bad key',
      );
    });

    it('truncates a multi-kilobyte CLI dump to a readable notice', async () => {
      const { formatChatErrorNotice } = await import('../chatHistoryStorage');

      const dump = ['boom', ...Array.from({ length: 400 }, (_, i) => `stack line ${i}`)].join('\n');
      const notice = formatChatErrorNotice(new Error(dump));

      expect(notice.startsWith('Error: boom')).toBe(true);
      expect(notice).toContain('more characters, see console log');
      expect(notice.length).toBeLessThan(800);
    });

    it('handles non-Error and empty values', async () => {
      const { formatChatErrorNotice } = await import('../chatHistoryStorage');

      expect(formatChatErrorNotice('plain failure')).toBe('Error: plain failure');
      expect(formatChatErrorNotice('')).toBe('Error: Unknown error');
    });
  });

  describe('filterPersistableDisplayMessages', () => {
    it('removes only ephemeral entries', async () => {
      const { filterPersistableDisplayMessages } = await import('../chatHistoryStorage');

      const messages: DisplayMessage[] = [
        { id: '1', role: 'user', content: 'hi' },
        { id: '2', role: 'assistant', content: 'cancelled note', ephemeral: true },
        { id: '3', role: 'assistant', content: 'kept reply', ephemeral: false },
      ];

      expect(filterPersistableDisplayMessages(messages).map((msg) => msg.id)).toEqual(['1', '3']);
    });
  });

  describe('clearChatHistory', () => {
    it('sends DELETE to API', async () => {
      fetchMock.mockResolvedValueOnce({ ok: true });
      const { clearChatHistory } = await import('../chatHistoryStorage');

      await clearChatHistory(SESSION_PATH);

      expect(fetchMock).toHaveBeenCalledWith(expectedUrl('chat.json'), { method: 'DELETE' });
    });

    it('does not throw when DELETE fetch fails', async () => {
      fetchMock.mockRejectedValueOnce(new Error('network error'));
      const { clearChatHistory } = await import('../chatHistoryStorage');

      await expect(clearChatHistory(SESSION_PATH)).resolves.toBeUndefined();
    });
  });

  describe('planConversationRestore', () => {
    const loaded: DisplayMessage[] = [
      { id: 'old-1', role: 'assistant', content: 'prologue' },
      { id: 'old-2', role: 'user', content: 'earlier question' },
      { id: 'old-3', role: 'assistant', content: 'earlier answer' },
    ];

    it('allows a normal restore when nothing was typed during the load', async () => {
      const { planConversationRestore } = await import('../chatHistoryStorage');

      const plan = planConversationRestore({
        baselineMessageIds: new Set<string>(),
        liveMessages: [],
        loadedMessages: loaded,
      });

      expect(plan.liveConversationStarted).toBe(false);
      expect(plan.restoredPrefix).toEqual([]);
    });

    it('allows a restore when only baseline messages are on screen (session switch)', async () => {
      const { planConversationRestore } = await import('../chatHistoryStorage');

      // Previous session's user messages are still visible while the new
      // session's transcript loads; they are all in the baseline snapshot.
      const previousSession: DisplayMessage[] = [
        { id: 'prev-user', role: 'user', content: 'from old session' },
        { id: 'prev-reply', role: 'assistant', content: 'old reply' },
      ];
      const plan = planConversationRestore({
        baselineMessageIds: new Set(previousSession.map((msg) => msg.id)),
        liveMessages: previousSession,
        loadedMessages: loaded,
      });

      expect(plan.liveConversationStarted).toBe(false);
    });

    it('blocks the replace when a user message arrived during the load', async () => {
      const { planConversationRestore } = await import('../chatHistoryStorage');

      const live: DisplayMessage[] = [
        { id: 'live-user', role: 'user', content: 'typed while loading' },
        { id: 'live-reply', role: 'assistant', content: 'streamed answer' },
      ];
      const plan = planConversationRestore({
        baselineMessageIds: new Set<string>(),
        liveMessages: live,
        loadedMessages: loaded,
      });

      expect(plan.liveConversationStarted).toBe(true);
      expect(plan.restoredPrefix).toEqual(loaded);
    });

    it('ignores non-user messages that arrived during the load', async () => {
      const { planConversationRestore } = await import('../chatHistoryStorage');

      // A nudge or tool line appearing on its own must not block the restore.
      const live: DisplayMessage[] = [
        { id: 'nudge-1', role: 'assistant', content: 'want some music?' },
        { id: 'tool-1', role: 'tool', content: 'ran diagnostics' },
      ];
      const plan = planConversationRestore({
        baselineMessageIds: new Set<string>(),
        liveMessages: live,
        loadedMessages: loaded,
      });

      expect(plan.liveConversationStarted).toBe(false);
    });

    it('excludes messages already on screen from the restored prefix', async () => {
      const { planConversationRestore } = await import('../chatHistoryStorage');

      const live: DisplayMessage[] = [
        { id: 'old-1', role: 'assistant', content: 'prologue' },
        { id: 'live-user', role: 'user', content: 'typed while loading' },
      ];
      const plan = planConversationRestore({
        baselineMessageIds: new Set(['old-1']),
        liveMessages: live,
        loadedMessages: loaded,
      });

      expect(plan.liveConversationStarted).toBe(true);
      expect(plan.restoredPrefix.map((msg) => msg.id)).toEqual(['old-2', 'old-3']);
    });

    it('returns an empty prefix when the loaded transcript is empty', async () => {
      const { planConversationRestore } = await import('../chatHistoryStorage');

      const plan = planConversationRestore({
        baselineMessageIds: new Set<string>(),
        liveMessages: [{ id: 'live-user', role: 'user', content: 'hi' }],
        loadedMessages: [],
      });

      expect(plan.liveConversationStarted).toBe(true);
      expect(plan.restoredPrefix).toEqual([]);
    });
  });
});
