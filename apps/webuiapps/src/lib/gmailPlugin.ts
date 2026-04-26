import { createHash, randomBytes } from 'crypto';
import * as fs from 'fs';
import type { IncomingMessage, ServerResponse } from 'http';
import { dirname, join } from 'path';
import type { Plugin } from 'vite';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
const TOKEN_REFRESH_SKEW_MS = 60_000;
const DEFAULT_SYNC_LIMIT = 25;
const MAX_SYNC_LIMIT = 100;

type EmailFolder = 'inbox' | 'sent' | 'drafts' | 'trash';

interface GmailPluginOptions {
  configFile: string;
  sessionsDir: string;
}

interface PersistedConfigShape {
  gmail?: GmailStoredConfig;
  [key: string]: unknown;
}

interface GmailStoredConfig {
  clientId?: string;
  clientSecret?: string;
  connectedEmail?: string;
  accessToken?: string;
  accessTokenExpiresAt?: number;
  refreshToken?: string;
  scope?: string;
  historyId?: string;
  lastSyncAt?: number;
}

interface GmailTokenResponse {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

interface GmailProfileResponse {
  emailAddress?: string;
  historyId?: string;
}

interface GmailListResponse {
  messages?: Array<{ id: string; threadId?: string }>;
}

interface GmailDraftListResponse {
  drafts?: Array<{ id: string; message?: { id?: string; threadId?: string } }>;
}

interface GmailMessageHeader {
  name?: string;
  value?: string;
}

interface GmailMessagePartBody {
  data?: string;
  attachmentId?: string;
  size?: number;
}

interface GmailMessagePart {
  mimeType?: string;
  filename?: string;
  headers?: GmailMessageHeader[];
  body?: GmailMessagePartBody;
  parts?: GmailMessagePart[];
}

interface GmailMessage {
  id: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailMessagePart;
}

interface GmailDraft {
  id: string;
  message: GmailMessage;
}

interface CachedEmailAddress {
  name: string;
  address: string;
}

interface CachedEmailAttachment {
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
}

interface CachedEmailRecord {
  id: string;
  threadId?: string;
  draftId?: string;
  from: CachedEmailAddress;
  to: CachedEmailAddress[];
  cc: CachedEmailAddress[];
  replyTo?: CachedEmailAddress[];
  subject: string;
  content: string;
  snippet?: string;
  timestamp: number;
  isRead: boolean;
  isStarred: boolean;
  folder: EmailFolder;
  labelIds?: string[];
  internetMessageId?: string;
  references?: string;
  accountEmail?: string;
  attachments?: CachedEmailAttachment[];
}

interface PendingAuth {
  codeVerifier: string;
  redirectUri: string;
  createdAt: number;
}

interface GmailStatusPayload {
  configured: boolean;
  connected: boolean;
  connectedEmail?: string;
  lastSyncAt?: number;
  historyId?: string;
}

interface ComposePayload {
  sessionPath: string;
  to?: string;
  cc?: string;
  subject?: string;
  content?: string;
  threadId?: string;
  internetMessageId?: string;
  references?: string;
  draftId?: string;
}

const pendingAuths = new Map<string, PendingAuth>();

function sanitizeSessionPath(sessionPath: string): string {
  return sessionPath.replace(/[^a-zA-Z0-9_\-./]/g, '_').replace(/\.\./g, '');
}

function readPersistedConfig(configFile: string): PersistedConfigShape {
  try {
    if (!fs.existsSync(configFile)) return {};
    const raw = fs.readFileSync(configFile, 'utf-8');
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as PersistedConfigShape) : {};
  } catch {
    return {};
  }
}

function writePersistedConfig(configFile: string, next: PersistedConfigShape): void {
  fs.mkdirSync(dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify(next, null, 2), 'utf-8');
}

function updateGmailConfig(
  configFile: string,
  updater: (current: GmailStoredConfig) => GmailStoredConfig,
): GmailStoredConfig {
  const persisted = readPersistedConfig(configFile);
  const nextGmail = updater((persisted.gmail as GmailStoredConfig | undefined) ?? {});
  writePersistedConfig(configFile, {
    ...persisted,
    gmail: nextGmail,
  });
  return nextGmail;
}

function cleanupPendingAuths(): void {
  const now = Date.now();
  for (const [state, pending] of pendingAuths.entries()) {
    if (now - pending.createdAt > 15 * 60_000) {
      pendingAuths.delete(state);
    }
  }
}

function createCodeChallenge(codeVerifier: string): string {
  return createHash('sha256')
    .update(codeVerifier)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function sendHtml(res: ServerResponse, statusCode: number, html: string): void {
  res.writeHead(statusCode, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function createPopupCallbackHtml(success: boolean, message: string): string {
  const safeMessage = escapeHtml(message);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>OpenRoom Gmail</title>
    <style>
      body {
        margin: 0;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #0d1117;
        color: #e6edf3;
        display: grid;
        place-items: center;
        min-height: 100vh;
      }
      .card {
        width: min(420px, calc(100vw - 32px));
        border: 1px solid #30363d;
        border-radius: 16px;
        padding: 28px 24px;
        background: #161b22;
        text-align: center;
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.35);
      }
      h1 {
        margin: 0 0 12px;
        font-size: 20px;
      }
      p {
        margin: 0;
        color: #8b949e;
        line-height: 1.6;
      }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>${success ? 'Gmail connected' : 'Gmail connection failed'}</h1>
      <p>${safeMessage}</p>
    </div>
    <script>
      const payload = ${JSON.stringify({
        type: 'openroom-gmail-oauth',
        success,
      })};
      if (window.opener) {
        window.opener.postMessage(payload, '*');
      }
      setTimeout(() => window.close(), 200);
    </script>
  </body>
</html>`;
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf-8') || '{}';
        resolve(JSON.parse(raw) as T);
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function buildLoopbackRedirectUri(req: IncomingMessage): string {
  const hostHeader = req.headers.host || '127.0.0.1:3000';
  const port = hostHeader.split(':')[1] || '3000';
  return `http://127.0.0.1:${port}/api/gmail/oauth/callback`;
}

function encodeBase64Url(value: string): string {
  return Buffer.from(value, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  return Buffer.from(`${normalized}${padding}`, 'base64').toString('utf-8');
}

function splitAddressHeader(raw: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inQuotes = false;
  let angleDepth = 0;

  for (const char of raw) {
    if (char === '"') {
      inQuotes = !inQuotes;
      current += char;
      continue;
    }
    if (!inQuotes && char === '<') {
      angleDepth += 1;
      current += char;
      continue;
    }
    if (!inQuotes && char === '>') {
      angleDepth = Math.max(0, angleDepth - 1);
      current += char;
      continue;
    }
    if (!inQuotes && angleDepth === 0 && char === ',') {
      if (current.trim()) parts.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }

  if (current.trim()) parts.push(current.trim());
  return parts;
}

function parseAddressHeader(raw?: string): CachedEmailAddress[] {
  if (!raw) return [];
  return splitAddressHeader(raw)
    .map((part) => {
      const angleMatch = part.match(/^(.*)<([^>]+)>$/);
      if (angleMatch) {
        const name = angleMatch[1].replace(/^"|"$/g, '').trim();
        return {
          name,
          address: angleMatch[2].trim(),
        };
      }
      const bare = part.replace(/^"|"$/g, '').trim();
      return {
        name: '',
        address: bare,
      };
    })
    .filter((entry) => entry.address);
}

function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeBodyText(value: string): string {
  return value.replace(/\r\n/g, '\n').trim();
}

function extractMessageBody(
  part: GmailMessagePart | undefined,
): { plainText: string; attachments: CachedEmailAttachment[] } {
  let plainText = '';
  let htmlText = '';
  const attachments: CachedEmailAttachment[] = [];

  const visit = (node: GmailMessagePart | undefined) => {
    if (!node) return;

    if (node.filename && node.body?.attachmentId) {
      attachments.push({
        attachmentId: node.body.attachmentId,
        filename: node.filename,
        mimeType: node.mimeType || 'application/octet-stream',
        size: node.body.size || 0,
      });
    }

    if (node.body?.data) {
      const decoded = decodeBase64Url(node.body.data);
      if (node.mimeType === 'text/plain' && !plainText) {
        plainText = decoded;
      }
      if (node.mimeType === 'text/html' && !htmlText) {
        htmlText = decoded;
      }
    }

    for (const child of node.parts || []) {
      visit(child);
    }
  };

  visit(part);

  return {
    plainText: normalizeBodyText(plainText || htmlToText(htmlText)),
    attachments,
  };
}

function getHeader(headers: GmailMessageHeader[] | undefined, name: string): string {
  const lower = name.toLowerCase();
  return headers?.find((header) => header.name?.toLowerCase() === lower)?.value?.trim() || '';
}

function determineFolder(labelIds: string[] | undefined): EmailFolder | null {
  if (labelIds?.includes('TRASH')) return 'trash';
  if (labelIds?.includes('DRAFT')) return 'drafts';
  if (labelIds?.includes('SENT')) return 'sent';
  if (labelIds?.includes('INBOX')) return 'inbox';
  return null;
}

function createAddressFallback(addresses: CachedEmailAddress[]): CachedEmailAddress {
  return (
    addresses[0] || {
      name: '',
      address: 'unknown@example.com',
    }
  );
}

function buildCachedEmailRecord(
  message: GmailMessage,
  options: { draftId?: string; accountEmail?: string },
): CachedEmailRecord | null {
  const folder = options.draftId ? 'drafts' : determineFolder(message.labelIds);
  if (!folder) return null;

  const headers = message.payload?.headers || [];
  const from = parseAddressHeader(getHeader(headers, 'From'));
  const to = parseAddressHeader(getHeader(headers, 'To'));
  const cc = parseAddressHeader(getHeader(headers, 'Cc'));
  const replyTo = parseAddressHeader(getHeader(headers, 'Reply-To'));
  const subject = getHeader(headers, 'Subject');
  const references = getHeader(headers, 'References');
  const internetMessageId = getHeader(headers, 'Message-ID');
  const { plainText, attachments } = extractMessageBody(message.payload);
  const timestamp = Number(message.internalDate || Date.now());

  return {
    id: message.id,
    threadId: message.threadId,
    draftId: options.draftId,
    from: createAddressFallback(from),
    to,
    cc,
    replyTo,
    subject,
    content: plainText || message.snippet || '',
    snippet: message.snippet || plainText.slice(0, 140),
    timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
    isRead: !(message.labelIds || []).includes('UNREAD'),
    isStarred: (message.labelIds || []).includes('STARRED'),
    folder,
    labelIds: message.labelIds || [],
    internetMessageId: internetMessageId || undefined,
    references: references || undefined,
    accountEmail: options.accountEmail,
    attachments: attachments.length > 0 ? attachments : undefined,
  };
}

function getEmailDataPaths(sessionsDir: string, sessionPath: string) {
  const safeSessionPath = sanitizeSessionPath(sessionPath);
  const dataDir = join(sessionsDir, safeSessionPath, 'apps', 'email', 'data');
  return {
    dataDir,
    emailsDir: join(dataDir, 'emails'),
    stateFile: join(dataDir, 'state.json'),
  };
}

function loadEmailState(stateFile: string): { selectedEmailId: string | null; currentFolder: EmailFolder } {
  try {
    if (!fs.existsSync(stateFile)) {
      return { selectedEmailId: null, currentFolder: 'inbox' };
    }
    const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf-8')) as {
      selectedEmailId?: string | null;
      currentFolder?: EmailFolder;
    };
    return {
      selectedEmailId: parsed.selectedEmailId ?? null,
      currentFolder: parsed.currentFolder || 'inbox',
    };
  } catch {
    return { selectedEmailId: null, currentFolder: 'inbox' };
  }
}

function loadExistingCachedEmails(
  sessionsDir: string,
  sessionPath: string,
  excludeEmailId?: string,
): CachedEmailRecord[] {
  const { emailsDir } = getEmailDataPaths(sessionsDir, sessionPath);
  if (!fs.existsSync(emailsDir)) return [];
  return fs
    .readdirSync(emailsDir)
    .filter((fileName) => fileName.endsWith('.json'))
    .map((fileName) => {
      try {
        return JSON.parse(fs.readFileSync(join(emailsDir, fileName), 'utf-8')) as CachedEmailRecord;
      } catch {
        return null;
      }
    })
    .filter((email): email is CachedEmailRecord => email !== null && email.id !== excludeEmailId);
}

function writeEmailCache(
  sessionsDir: string,
  sessionPath: string,
  emails: CachedEmailRecord[],
): void {
  const { emailsDir, stateFile } = getEmailDataPaths(sessionsDir, sessionPath);
  fs.mkdirSync(emailsDir, { recursive: true });

  const nextIds = new Set(emails.map((email) => email.id));
  if (fs.existsSync(emailsDir)) {
    for (const fileName of fs.readdirSync(emailsDir)) {
      if (!fileName.endsWith('.json')) continue;
      const emailId = fileName.replace(/\.json$/i, '');
      if (!nextIds.has(emailId)) {
        fs.rmSync(join(emailsDir, fileName), { force: true });
      }
    }
  }

  for (const email of emails) {
    fs.writeFileSync(join(emailsDir, `${email.id}.json`), JSON.stringify(email, null, 2), 'utf-8');
  }

  const nextState = loadEmailState(stateFile);
  if (nextState.selectedEmailId && !nextIds.has(nextState.selectedEmailId)) {
    nextState.selectedEmailId = null;
  }
  fs.mkdirSync(dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(nextState, null, 2), 'utf-8');
}

function removeCachedEmail(sessionsDir: string, sessionPath: string, emailId: string): void {
  const { emailsDir, stateFile } = getEmailDataPaths(sessionsDir, sessionPath);
  const filePath = join(emailsDir, `${emailId}.json`);
  if (fs.existsSync(filePath)) {
    fs.rmSync(filePath, { force: true });
  }
  const currentState = loadEmailState(stateFile);
  if (currentState.selectedEmailId === emailId) {
    currentState.selectedEmailId = null;
    fs.writeFileSync(stateFile, JSON.stringify(currentState, null, 2), 'utf-8');
  }
}

function clearEmailCache(sessionsDir: string, sessionPath: string): void {
  const { dataDir } = getEmailDataPaths(sessionsDir, sessionPath);
  if (fs.existsSync(dataDir)) {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

async function mapInBatches<T, R>(
  items: T[],
  mapper: (item: T, index: number) => Promise<R>,
  batchSize = 6,
): Promise<R[]> {
  const results: R[] = [];
  for (let start = 0; start < items.length; start += batchSize) {
    const batch = items.slice(start, start + batchSize);
    const chunkResults = await Promise.all(batch.map((item, index) => mapper(item, start + index)));
    results.push(...chunkResults);
  }
  return results;
}

async function ensureAccessToken(configFile: string): Promise<GmailStoredConfig> {
  const persisted = readPersistedConfig(configFile);
  const gmail = (persisted.gmail as GmailStoredConfig | undefined) ?? {};
  if (!gmail.clientId) {
    throw new Error('Missing Gmail client ID. Open Email settings and add your Google OAuth client.');
  }
  if (!gmail.refreshToken) {
    throw new Error('Gmail is not connected yet.');
  }

  if (
    gmail.accessToken &&
    gmail.accessTokenExpiresAt &&
    gmail.accessTokenExpiresAt > Date.now() + TOKEN_REFRESH_SKEW_MS
  ) {
    return gmail;
  }

  const body = new URLSearchParams({
    client_id: gmail.clientId,
    grant_type: 'refresh_token',
    refresh_token: gmail.refreshToken,
  });
  if (gmail.clientSecret) {
    body.set('client_secret', gmail.clientSecret);
  }

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to refresh Gmail token: ${errorText}`);
  }

  const token = (await response.json()) as GmailTokenResponse;
  return updateGmailConfig(configFile, (current) => ({
    ...current,
    accessToken: token.access_token,
    accessTokenExpiresAt: Date.now() + (token.expires_in || 3600) * 1000,
    refreshToken: token.refresh_token || current.refreshToken,
    scope: token.scope || current.scope,
  }));
}

async function gmailJson<T>(
  configFile: string,
  url: string,
  init: RequestInit = {},
): Promise<T> {
  const gmail = await ensureAccessToken(configFile);
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${gmail.accessToken}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || `Gmail request failed with ${response.status}`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const raw = await response.text();
  if (!raw) {
    return undefined as T;
  }
  return JSON.parse(raw) as T;
}

async function fetchGmailProfile(configFile: string): Promise<GmailProfileResponse> {
  const profile = await gmailJson<GmailProfileResponse>(configFile, `${GMAIL_API_BASE}/profile`);
  updateGmailConfig(configFile, (current) => ({
    ...current,
    connectedEmail: profile.emailAddress || current.connectedEmail,
    historyId: profile.historyId || current.historyId,
  }));
  return profile;
}

async function listMessageIds(
  configFile: string,
  labelId: string,
  maxResults: number,
): Promise<string[]> {
  const url = new URL(`${GMAIL_API_BASE}/messages`);
  url.searchParams.set('labelIds', labelId);
  url.searchParams.set('maxResults', String(maxResults));
  url.searchParams.set('includeSpamTrash', 'true');
  const response = await gmailJson<GmailListResponse>(configFile, url.toString());
  return Array.from(new Set((response.messages || []).map((message) => message.id)));
}

async function listDraftIds(configFile: string, maxResults: number): Promise<string[]> {
  const url = new URL(`${GMAIL_API_BASE}/drafts`);
  url.searchParams.set('maxResults', String(maxResults));
  const response = await gmailJson<GmailDraftListResponse>(configFile, url.toString());
  return Array.from(new Set((response.drafts || []).map((draft) => draft.id)));
}

async function getMessage(configFile: string, messageId: string): Promise<GmailMessage> {
  const url = new URL(`${GMAIL_API_BASE}/messages/${encodeURIComponent(messageId)}`);
  url.searchParams.set('format', 'full');
  return gmailJson<GmailMessage>(configFile, url.toString());
}

async function getDraft(configFile: string, draftId: string): Promise<GmailDraft> {
  const url = new URL(`${GMAIL_API_BASE}/drafts/${encodeURIComponent(draftId)}`);
  url.searchParams.set('format', 'full');
  return gmailJson<GmailDraft>(configFile, url.toString());
}

async function syncMailboxToSession(
  configFile: string,
  sessionsDir: string,
  sessionPath: string,
  maxResults: number,
): Promise<{ emailCount: number; connectedEmail?: string }> {
  const gmail = await ensureAccessToken(configFile);
  const profile = await fetchGmailProfile(configFile);
  const connectedEmail = profile.emailAddress || gmail.connectedEmail;
  const limit = Math.max(1, Math.min(maxResults || DEFAULT_SYNC_LIMIT, MAX_SYNC_LIMIT));

  const [inboxIds, sentIds, trashIds, draftIds] = await Promise.all([
    listMessageIds(configFile, 'INBOX', limit),
    listMessageIds(configFile, 'SENT', limit),
    listMessageIds(configFile, 'TRASH', limit),
    listDraftIds(configFile, limit),
  ]);

  const messageIds = Array.from(new Set([...inboxIds, ...sentIds, ...trashIds]));
  const messages = await mapInBatches(messageIds, (messageId) => getMessage(configFile, messageId));
  const drafts = await mapInBatches(draftIds, (draftId) => getDraft(configFile, draftId));

  const cacheRecords = [
    ...messages
      .map((message) => buildCachedEmailRecord(message, { accountEmail: connectedEmail }))
      .filter((message): message is CachedEmailRecord => message !== null),
    ...drafts
      .map((draft) =>
        buildCachedEmailRecord(draft.message, {
          draftId: draft.id,
          accountEmail: connectedEmail,
        }),
      )
      .filter((message): message is CachedEmailRecord => message !== null),
  ].sort((left, right) => right.timestamp - left.timestamp);

  writeEmailCache(sessionsDir, sessionPath, cacheRecords);
  updateGmailConfig(configFile, (current) => ({
    ...current,
    connectedEmail,
    historyId: profile.historyId || current.historyId,
    lastSyncAt: Date.now(),
  }));

  return {
    emailCount: cacheRecords.length,
    connectedEmail,
  };
}

function buildRawEmail(payload: {
  to?: string;
  cc?: string;
  subject?: string;
  content?: string;
  internetMessageId?: string;
  references?: string;
}): string {
  const lines = [
    payload.to ? `To: ${payload.to}` : '',
    payload.cc ? `Cc: ${payload.cc}` : '',
    `Subject: ${payload.subject || ''}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    payload.internetMessageId ? `In-Reply-To: ${payload.internetMessageId}` : '',
    payload.references
      ? `References: ${payload.internetMessageId ? `${payload.references} ${payload.internetMessageId}`.trim() : payload.references}`
      : payload.internetMessageId
        ? `References: ${payload.internetMessageId}`
        : '',
    '',
    payload.content || '',
  ].filter(Boolean);

  return encodeBase64Url(lines.join('\r\n'));
}

async function createDraft(configFile: string, payload: ComposePayload): Promise<GmailDraft> {
  const raw = buildRawEmail(payload);
  const body = payload.draftId
    ? {
        id: payload.draftId,
        message: {
          raw,
          ...(payload.threadId ? { threadId: payload.threadId } : {}),
        },
      }
    : {
        message: {
          raw,
          ...(payload.threadId ? { threadId: payload.threadId } : {}),
        },
      };

  if (payload.draftId) {
    return gmailJson<GmailDraft>(
      configFile,
      `${GMAIL_API_BASE}/drafts/${encodeURIComponent(payload.draftId)}`,
      {
        method: 'PUT',
        body: JSON.stringify(body),
      },
    );
  }

  return gmailJson<GmailDraft>(configFile, `${GMAIL_API_BASE}/drafts`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

async function sendDraft(configFile: string, draftId: string): Promise<GmailMessage> {
  return gmailJson<GmailMessage>(configFile, `${GMAIL_API_BASE}/drafts/send`, {
    method: 'POST',
    body: JSON.stringify({ id: draftId }),
  });
}

async function sendMessage(configFile: string, payload: ComposePayload): Promise<GmailMessage> {
  if (payload.draftId) {
    await createDraft(configFile, payload);
    return sendDraft(configFile, payload.draftId);
  }

  const raw = buildRawEmail(payload);
  return gmailJson<GmailMessage>(configFile, `${GMAIL_API_BASE}/messages/send`, {
    method: 'POST',
    body: JSON.stringify({
      raw,
      ...(payload.threadId ? { threadId: payload.threadId } : {}),
    }),
  });
}

async function upsertMessageIntoSession(
  configFile: string,
  sessionsDir: string,
  sessionPath: string,
  messageId: string,
): Promise<CachedEmailRecord | null> {
  const message = await getMessage(configFile, messageId);
  const gmail = readPersistedConfig(configFile).gmail as GmailStoredConfig | undefined;
  const record = buildCachedEmailRecord(message, {
    accountEmail: gmail?.connectedEmail,
  });
  if (!record) {
    removeCachedEmail(sessionsDir, sessionPath, messageId);
    return null;
  }
  writeEmailCache(sessionsDir, sessionPath, [
    record,
    ...loadExistingCachedEmails(sessionsDir, sessionPath, messageId),
  ]);
  return record;
}

async function updateMessageLabels(
  configFile: string,
  sessionsDir: string,
  sessionPath: string,
  messageId: string,
  payload: { addLabelIds?: string[]; removeLabelIds?: string[] },
): Promise<CachedEmailRecord | null> {
  await gmailJson<GmailMessage>(configFile, `${GMAIL_API_BASE}/messages/${encodeURIComponent(messageId)}/modify`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return upsertMessageIntoSession(configFile, sessionsDir, sessionPath, messageId);
}

async function trashMessage(
  configFile: string,
  sessionsDir: string,
  sessionPath: string,
  messageId: string,
): Promise<CachedEmailRecord | null> {
  await gmailJson<GmailMessage>(configFile, `${GMAIL_API_BASE}/messages/${encodeURIComponent(messageId)}/trash`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  return upsertMessageIntoSession(configFile, sessionsDir, sessionPath, messageId);
}

async function untrashMessage(
  configFile: string,
  sessionsDir: string,
  sessionPath: string,
  messageId: string,
): Promise<CachedEmailRecord | null> {
  await gmailJson<GmailMessage>(configFile, `${GMAIL_API_BASE}/messages/${encodeURIComponent(messageId)}/untrash`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  return upsertMessageIntoSession(configFile, sessionsDir, sessionPath, messageId);
}

async function deleteDraft(
  configFile: string,
  sessionsDir: string,
  sessionPath: string,
  draftId: string,
  messageId: string,
): Promise<void> {
  await gmailJson<undefined>(configFile, `${GMAIL_API_BASE}/drafts/${encodeURIComponent(draftId)}`, {
    method: 'DELETE',
  });
  removeCachedEmail(sessionsDir, sessionPath, messageId);
}

function buildStatusPayload(configFile: string): GmailStatusPayload {
  const gmail = (readPersistedConfig(configFile).gmail as GmailStoredConfig | undefined) ?? {};
  return {
    configured: Boolean(gmail.clientId),
    connected: Boolean(gmail.clientId && gmail.refreshToken),
    connectedEmail: gmail.connectedEmail,
    lastSyncAt: gmail.lastSyncAt,
    historyId: gmail.historyId,
  };
}

export function gmailPlugin(options: GmailPluginOptions): Plugin {
  return {
    name: 'gmail-plugin',
    configureServer(server) {
      server.middlewares.use('/api/gmail/status', (_req, res) => {
        sendJson(res, 200, buildStatusPayload(options.configFile));
      });

      server.middlewares.use('/api/gmail/oauth/start', async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'Method not allowed' });
          return;
        }

        cleanupPendingAuths();
        const gmail = (readPersistedConfig(options.configFile).gmail as GmailStoredConfig | undefined) ?? {};
        if (!gmail.clientId) {
          sendJson(res, 400, { error: 'Missing Gmail client ID. Save it in Email settings first.' });
          return;
        }

        const state = randomBytes(16).toString('hex');
        const codeVerifier = randomBytes(48).toString('base64url');
        const redirectUri = buildLoopbackRedirectUri(req);
        pendingAuths.set(state, {
          codeVerifier,
          redirectUri,
          createdAt: Date.now(),
        });

        const authUrl = new URL(GOOGLE_AUTH_URL);
        authUrl.searchParams.set('client_id', gmail.clientId);
        authUrl.searchParams.set('redirect_uri', redirectUri);
        authUrl.searchParams.set('response_type', 'code');
        authUrl.searchParams.set('scope', GMAIL_SCOPE);
        authUrl.searchParams.set('access_type', 'offline');
        authUrl.searchParams.set('prompt', 'consent');
        authUrl.searchParams.set('state', state);
        authUrl.searchParams.set('code_challenge', createCodeChallenge(codeVerifier));
        authUrl.searchParams.set('code_challenge_method', 'S256');

        sendJson(res, 200, { authUrl: authUrl.toString() });
      });

      server.middlewares.use('/api/gmail/oauth/callback', async (req, res) => {
        const url = new URL(req.url || '', 'http://127.0.0.1');
        const state = url.searchParams.get('state') || '';
        const code = url.searchParams.get('code') || '';
        const error = url.searchParams.get('error') || '';

        if (error) {
          sendHtml(res, 400, createPopupCallbackHtml(false, error));
          return;
        }

        const pending = pendingAuths.get(state);
        pendingAuths.delete(state);
        if (!pending || !code) {
          sendHtml(res, 400, createPopupCallbackHtml(false, 'Missing or expired Gmail auth state.'));
          return;
        }

        try {
          const gmail = (readPersistedConfig(options.configFile).gmail as GmailStoredConfig | undefined) ?? {};
          if (!gmail.clientId) {
            throw new Error('Missing Gmail client ID.');
          }

          const body = new URLSearchParams({
            client_id: gmail.clientId,
            code,
            code_verifier: pending.codeVerifier,
            grant_type: 'authorization_code',
            redirect_uri: pending.redirectUri,
          });
          if (gmail.clientSecret) {
            body.set('client_secret', gmail.clientSecret);
          }

          const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body,
          });

          if (!tokenResponse.ok) {
            throw new Error(await tokenResponse.text());
          }

          const token = (await tokenResponse.json()) as GmailTokenResponse;
          updateGmailConfig(options.configFile, (current) => ({
            ...current,
            accessToken: token.access_token,
            accessTokenExpiresAt: Date.now() + (token.expires_in || 3600) * 1000,
            refreshToken: token.refresh_token || current.refreshToken,
            scope: token.scope || current.scope,
          }));

          const profile = await fetchGmailProfile(options.configFile);
          updateGmailConfig(options.configFile, (current) => ({
            ...current,
            connectedEmail: profile.emailAddress || current.connectedEmail,
            historyId: profile.historyId || current.historyId,
          }));

          sendHtml(res, 200, createPopupCallbackHtml(true, 'You can close this window now.'));
        } catch (authError) {
          sendHtml(
            res,
            500,
            createPopupCallbackHtml(
              false,
              authError instanceof Error ? authError.message : String(authError),
            ),
          );
        }
      });

      server.middlewares.use('/api/gmail/disconnect', async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'Method not allowed' });
          return;
        }
        let sessionPath = '';
        try {
          const body = await readJsonBody<{ sessionPath?: string }>(req);
          sessionPath = body.sessionPath || '';
        } catch {
          sessionPath = '';
        }
        updateGmailConfig(options.configFile, (current) => ({
          ...current,
          connectedEmail: undefined,
          accessToken: undefined,
          accessTokenExpiresAt: undefined,
          refreshToken: undefined,
          scope: undefined,
          historyId: undefined,
          lastSyncAt: undefined,
        }));
        if (sessionPath) {
          clearEmailCache(options.sessionsDir, sessionPath);
        }
        sendJson(res, 200, { ok: true });
      });

      server.middlewares.use('/api/gmail/sync', async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'Method not allowed' });
          return;
        }

        try {
          const body = await readJsonBody<{ sessionPath?: string; limit?: number }>(req);
          if (!body.sessionPath) {
            sendJson(res, 400, { error: 'Missing sessionPath' });
            return;
          }
          const result = await syncMailboxToSession(
            options.configFile,
            options.sessionsDir,
            body.sessionPath,
            body.limit || DEFAULT_SYNC_LIMIT,
          );
          sendJson(res, 200, {
            ok: true,
            ...result,
            historyId: buildStatusPayload(options.configFile).historyId,
            lastSyncAt: buildStatusPayload(options.configFile).lastSyncAt,
          });
        } catch (syncError) {
          sendJson(res, 500, {
            error: syncError instanceof Error ? syncError.message : String(syncError),
          });
        }
      });

      server.middlewares.use('/api/gmail/send', async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'Method not allowed' });
          return;
        }

        try {
          const body = await readJsonBody<ComposePayload>(req);
          if (!body.sessionPath) {
            sendJson(res, 400, { error: 'Missing sessionPath' });
            return;
          }
          const message = await sendMessage(options.configFile, body);
          await upsertMessageIntoSession(options.configFile, options.sessionsDir, body.sessionPath, message.id);
          sendJson(res, 200, { ok: true, messageId: message.id });
        } catch (sendError) {
          sendJson(res, 500, {
            error: sendError instanceof Error ? sendError.message : String(sendError),
          });
        }
      });

      server.middlewares.use('/api/gmail/drafts', async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'Method not allowed' });
          return;
        }

        try {
          const body = await readJsonBody<ComposePayload>(req);
          if (!body.sessionPath) {
            sendJson(res, 400, { error: 'Missing sessionPath' });
            return;
          }
          const draft = await createDraft(options.configFile, body);
          const fullDraft = await getDraft(options.configFile, draft.id);
          const gmail = (readPersistedConfig(options.configFile).gmail as GmailStoredConfig | undefined) ?? {};
          const record = buildCachedEmailRecord(fullDraft.message, {
            draftId: draft.id,
            accountEmail: gmail.connectedEmail,
          });
          if (record) {
            writeEmailCache(options.sessionsDir, body.sessionPath, [
              record,
              ...loadExistingCachedEmails(options.sessionsDir, body.sessionPath, record.id),
            ]);
          }
          sendJson(res, 200, {
            ok: true,
            draftId: draft.id,
            messageId: draft.message.id,
          });
        } catch (draftError) {
          sendJson(res, 500, {
            error: draftError instanceof Error ? draftError.message : String(draftError),
          });
        }
      });

      server.middlewares.use('/api/gmail/messages/modify', async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'Method not allowed' });
          return;
        }

        try {
          const body = await readJsonBody<{
            sessionPath?: string;
            messageId?: string;
            addLabelIds?: string[];
            removeLabelIds?: string[];
          }>(req);
          if (!body.sessionPath || !body.messageId) {
            sendJson(res, 400, { error: 'Missing sessionPath or messageId' });
            return;
          }
          const record = await updateMessageLabels(
            options.configFile,
            options.sessionsDir,
            body.sessionPath,
            body.messageId,
            {
              addLabelIds: body.addLabelIds || [],
              removeLabelIds: body.removeLabelIds || [],
            },
          );
          sendJson(res, 200, { ok: true, email: record });
        } catch (modifyError) {
          sendJson(res, 500, {
            error: modifyError instanceof Error ? modifyError.message : String(modifyError),
          });
        }
      });

      server.middlewares.use('/api/gmail/messages/trash', async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'Method not allowed' });
          return;
        }

        try {
          const body = await readJsonBody<{ sessionPath?: string; messageId?: string }>(req);
          if (!body.sessionPath || !body.messageId) {
            sendJson(res, 400, { error: 'Missing sessionPath or messageId' });
            return;
          }
          const record = await trashMessage(
            options.configFile,
            options.sessionsDir,
            body.sessionPath,
            body.messageId,
          );
          sendJson(res, 200, { ok: true, email: record });
        } catch (trashError) {
          sendJson(res, 500, {
            error: trashError instanceof Error ? trashError.message : String(trashError),
          });
        }
      });

      server.middlewares.use('/api/gmail/messages/untrash', async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'Method not allowed' });
          return;
        }

        try {
          const body = await readJsonBody<{ sessionPath?: string; messageId?: string }>(req);
          if (!body.sessionPath || !body.messageId) {
            sendJson(res, 400, { error: 'Missing sessionPath or messageId' });
            return;
          }
          const record = await untrashMessage(
            options.configFile,
            options.sessionsDir,
            body.sessionPath,
            body.messageId,
          );
          sendJson(res, 200, { ok: true, email: record });
        } catch (untrashError) {
          sendJson(res, 500, {
            error: untrashError instanceof Error ? untrashError.message : String(untrashError),
          });
        }
      });

      server.middlewares.use('/api/gmail/drafts/delete', async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'Method not allowed' });
          return;
        }

        try {
          const body = await readJsonBody<{
            sessionPath?: string;
            draftId?: string;
            messageId?: string;
          }>(req);
          if (!body.sessionPath || !body.draftId || !body.messageId) {
            sendJson(res, 400, { error: 'Missing sessionPath, draftId, or messageId' });
            return;
          }
          await deleteDraft(
            options.configFile,
            options.sessionsDir,
            body.sessionPath,
            body.draftId,
            body.messageId,
          );
          sendJson(res, 200, { ok: true });
        } catch (draftDeleteError) {
          sendJson(res, 500, {
            error: draftDeleteError instanceof Error ? draftDeleteError.message : String(draftDeleteError),
          });
        }
      });
    },
  };
}
