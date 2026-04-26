import { getSessionPath } from '@/lib/sessionPath';

export interface GmailStatus {
  configured: boolean;
  connected: boolean;
  connectedEmail?: string;
  lastSyncAt?: number;
  historyId?: string;
}

export interface GmailComposePayload {
  to?: string;
  cc?: string;
  subject?: string;
  content?: string;
  threadId?: string;
  internetMessageId?: string;
  references?: string;
  draftId?: string;
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    let detail = `Request failed with ${response.status}`;
    try {
      const payload = (await response.json()) as { error?: string };
      if (payload.error) {
        detail = payload.error;
      }
    } catch {
      const text = await response.text().catch(() => '');
      if (text) detail = text;
    }
    throw new Error(detail);
  }
  return (await response.json()) as T;
}

function withSessionPath<T extends Record<string, unknown>>(payload: T): T & { sessionPath: string } {
  const sessionPath = getSessionPath();
  if (!sessionPath) {
    throw new Error('The current chat session is not ready yet.');
  }
  return {
    ...payload,
    sessionPath,
  };
}

export async function getGmailStatus(): Promise<GmailStatus> {
  return requestJson<GmailStatus>('/api/gmail/status');
}

export async function startGmailOAuth(): Promise<{ authUrl: string }> {
  return requestJson<{ authUrl: string }>('/api/gmail/oauth/start', {
    method: 'POST',
  });
}

export async function syncGmail(limit = 25): Promise<{
  ok: true;
  emailCount: number;
  connectedEmail?: string;
  historyId?: string;
  lastSyncAt?: number;
}> {
  return requestJson('/api/gmail/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(withSessionPath({ limit })),
  });
}

export async function disconnectGmail(): Promise<void> {
  await requestJson('/api/gmail/disconnect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(withSessionPath({})),
  });
}

export async function sendGmailMessage(payload: GmailComposePayload): Promise<{ ok: true; messageId: string }> {
  return requestJson('/api/gmail/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(withSessionPath(payload)),
  });
}

export async function saveGmailDraft(payload: GmailComposePayload): Promise<{
  ok: true;
  draftId: string;
  messageId: string;
}> {
  return requestJson('/api/gmail/drafts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(withSessionPath(payload)),
  });
}

export async function modifyGmailLabels(payload: {
  messageId: string;
  addLabelIds?: string[];
  removeLabelIds?: string[];
}): Promise<void> {
  await requestJson('/api/gmail/messages/modify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(withSessionPath(payload)),
  });
}

export async function trashGmailMessage(messageId: string): Promise<void> {
  await requestJson('/api/gmail/messages/trash', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(withSessionPath({ messageId })),
  });
}

export async function untrashGmailMessage(messageId: string): Promise<void> {
  await requestJson('/api/gmail/messages/untrash', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(withSessionPath({ messageId })),
  });
}

export async function deleteGmailDraft(draftId: string, messageId: string): Promise<void> {
  await requestJson('/api/gmail/drafts/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(withSessionPath({ draftId, messageId })),
  });
}
