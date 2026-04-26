import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  ArrowLeft,
  Loader2,
  LogOut,
  MailPlus,
  PencilLine,
  RefreshCw,
  Reply,
  RotateCcw,
  Save,
  Send,
  Settings,
  Star,
  Trash2,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { initVibeApp, AppLifecycle } from '@gui/vibe-container';
import {
  useFileSystem,
  useAgentActionListener,
  reportAction,
  reportLifecycle,
  createAppFileApi,
  fetchVibeInfo,
  type CharacterAppAction,
} from '@/lib';
import { loadPersistedConfig, savePersistedConfig } from '@/lib/configPersistence';
import './i18n';
import styles from './index.module.scss';
import {
  deleteGmailDraft,
  disconnectGmail,
  getGmailStatus,
  modifyGmailLabels,
  saveGmailDraft,
  sendGmailMessage,
  startGmailOAuth,
  syncGmail,
  trashGmailMessage,
  untrashGmailMessage,
  type GmailStatus,
} from './gmailApi';

const APP_ID = 11;
const APP_NAME = 'email';
const EMAILS_DIR = '/emails';
const STATE_FILE = '/state.json';
const DEFAULT_SYNC_LIMIT = 25;

const emailFileApi = createAppFileApi(APP_NAME);

type FolderType = 'inbox' | 'sent' | 'drafts' | 'trash';

interface EmailAddress {
  name: string;
  address: string;
}

interface EmailAttachment {
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
}

interface Email {
  id: string;
  threadId?: string;
  draftId?: string;
  from: EmailAddress;
  to: EmailAddress[];
  cc: EmailAddress[];
  replyTo?: EmailAddress[];
  subject: string;
  content: string;
  snippet?: string;
  timestamp: number;
  isRead: boolean;
  isStarred: boolean;
  folder: FolderType;
  labelIds?: string[];
  internetMessageId?: string;
  references?: string;
  accountEmail?: string;
  attachments?: EmailAttachment[];
}

interface AppState {
  selectedEmailId: string | null;
  currentFolder: FolderType;
}

interface ComposeState {
  open: boolean;
  mode: 'new' | 'reply' | 'draft';
  to: string;
  cc: string;
  subject: string;
  content: string;
  threadId?: string;
  internetMessageId?: string;
  references?: string;
  draftId?: string;
  saving: boolean;
}

interface SettingsState {
  open: boolean;
  clientId: string;
  clientSecret: string;
  saving: boolean;
}

const DEFAULT_COMPOSE_STATE: ComposeState = {
  open: false,
  mode: 'new',
  to: '',
  cc: '',
  subject: '',
  content: '',
  saving: false,
};

const DEFAULT_SETTINGS_STATE: SettingsState = {
  open: false,
  clientId: '',
  clientSecret: '',
  saving: false,
};

const FOLDER_CONFIG: Array<{ key: FolderType; labelKey: string }> = [
  { key: 'inbox', labelKey: 'inbox' },
  { key: 'sent', labelKey: 'sent' },
  { key: 'drafts', labelKey: 'drafts' },
  { key: 'trash', labelKey: 'trash' },
];

function getEmailFilePath(emailId: string): string {
  return `${EMAILS_DIR}/${emailId}.json`;
}

function normalizeEmail(raw: unknown): Email | null {
  if (!raw) return null;
  const email = typeof raw === 'string' ? (JSON.parse(raw) as Email) : (raw as Email);
  if (!email?.id || !email?.folder) return null;
  return {
    from: { name: '', address: 'unknown@example.com' },
    to: [],
    cc: [],
    subject: '',
    content: '',
    isRead: false,
    isStarred: false,
    timestamp: Date.now(),
    ...email,
  };
}

function formatEmailTime(timestamp: number): string {
  const now = new Date();
  const date = new Date(timestamp);
  const isToday =
    date.getDate() === now.getDate() &&
    date.getMonth() === now.getMonth() &&
    date.getFullYear() === now.getFullYear();

  if (isToday) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  return date.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatDetailTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString([], {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatSyncTime(timestamp?: number): string {
  if (!timestamp) return '';
  return new Date(timestamp).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function getInitial(name: string): string {
  return (name || '?').charAt(0).toUpperCase();
}

function getEmailPreview(email: Email): string {
  const source = email.snippet || email.content || '';
  const text = source.replace(/\s+/g, ' ').trim();
  return text.length > 96 ? `${text.slice(0, 96)}...` : text;
}

function joinAddresses(addresses: EmailAddress[]): string {
  return addresses
    .map((entry) => (entry.name ? `${entry.name} <${entry.address}>` : entry.address))
    .join(', ');
}

function prefixReplySubject(subject: string): string {
  return /^re:/i.test(subject) ? subject : `Re: ${subject || '(No subject)'}`;
}

function buildQuotedReply(email: Email): string {
  const sender = email.from.name || email.from.address;
  return `\n\nOn ${formatDetailTime(email.timestamp)}, ${sender} wrote:\n${email.content}`
    .split('\n')
    .map((line) => (line ? `> ${line}` : '>'))
    .join('\n');
}

function buildReplyComposeState(email: Email): ComposeState {
  const replyTarget = email.replyTo?.[0] || email.from;
  return {
    open: true,
    mode: 'reply',
    to: joinAddresses([replyTarget]),
    cc: '',
    subject: prefixReplySubject(email.subject),
    content: buildQuotedReply(email),
    threadId: email.threadId,
    internetMessageId: email.internetMessageId,
    references: email.references,
    saving: false,
  };
}

function buildDraftComposeState(email: Email): ComposeState {
  return {
    open: true,
    mode: 'draft',
    to: joinAddresses(email.to),
    cc: joinAddresses(email.cc),
    subject: email.subject,
    content: email.content,
    threadId: email.threadId,
    internetMessageId: email.internetMessageId,
    references: email.references,
    draftId: email.draftId,
    saving: false,
  };
}

interface ToolbarButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  busy?: boolean;
  icon: React.ReactNode;
}

const ToolbarButton: React.FC<ToolbarButtonProps> = ({ busy, icon, children, ...props }) => (
  <button className={styles.toolbarButton} {...props}>
    <span className={styles.toolbarButtonIcon}>
      {busy ? <Loader2 className={styles.spin} size={16} /> : icon}
    </span>
    <span>{children}</span>
  </button>
);

interface EmailItemProps {
  email: Email;
  isSelected: boolean;
  onSelect: (email: Email) => void;
  onToggleStar: (email: Email) => void;
  onDelete: (email: Email) => void;
  onRestore: (email: Email) => void;
}

const EmailItem: React.FC<EmailItemProps> = ({
  email,
  isSelected,
  onSelect,
  onToggleStar,
  onDelete,
  onRestore,
}) => {
  const { t } = useTranslation('email');
  const isTrash = email.folder === 'trash';

  return (
    <div
      className={`${styles.emailItem} ${isSelected ? styles.selected : ''} ${!email.isRead ? styles.unread : ''}`}
      onClick={() => onSelect(email)}
    >
      {!email.isRead ? <div className={styles.unreadDot} /> : <div className={styles.readPlaceholder} />}
      <button
        className={`${styles.emailStarBtn} ${email.isStarred ? styles.starred : ''}`}
        onClick={(event) => {
          event.stopPropagation();
          onToggleStar(email);
        }}
      >
        <Star size={16} fill={email.isStarred ? 'currentColor' : 'none'} />
      </button>
      <div className={styles.emailContent}>
        <div className={styles.emailTopRow}>
          <span className={styles.emailSender}>{email.from.name || email.from.address}</span>
          <span className={styles.emailTime}>{formatEmailTime(email.timestamp)}</span>
        </div>
        <div className={styles.emailBottomRow}>
          <span className={styles.emailSubject}>{email.subject || t('noSubject')}</span>
          {getEmailPreview(email) ? (
            <>
              <span className={styles.emailSeparator}>-</span>
              <span className={styles.emailPreview}>{getEmailPreview(email)}</span>
            </>
          ) : null}
        </div>
      </div>
      <button
        className={styles.emailDeleteBtn}
        title={isTrash ? t('restore') : t('moveToTrash')}
        onClick={(event) => {
          event.stopPropagation();
          if (isTrash) {
            onRestore(email);
            return;
          }
          onDelete(email);
        }}
      >
        {isTrash ? <RotateCcw size={16} /> : <Trash2 size={16} />}
      </button>
    </div>
  );
};

interface EmailDetailProps {
  email: Email;
  onBack: () => void;
  onReply: (email: Email) => void;
  onEditDraft: (email: Email) => void;
  onToggleStar: (email: Email) => void;
  onArchive: (email: Email) => void;
  onDelete: (email: Email) => void;
  onRestore: (email: Email) => void;
}

const EmailDetail: React.FC<EmailDetailProps> = ({
  email,
  onBack,
  onReply,
  onEditDraft,
  onToggleStar,
  onArchive,
  onDelete,
  onRestore,
}) => {
  const { t } = useTranslation('email');
  const primaryAction =
    email.folder === 'drafts'
      ? { label: t('editDraft'), icon: <PencilLine size={16} />, onClick: () => onEditDraft(email) }
      : email.folder === 'trash'
        ? { label: t('restore'), icon: <RotateCcw size={16} />, onClick: () => onRestore(email) }
        : { label: t('reply'), icon: <Reply size={16} />, onClick: () => onReply(email) };

  return (
    <div className={styles.detailView}>
      <div className={styles.detailToolbar}>
        <ToolbarButton icon={<ArrowLeft size={16} />} onClick={onBack}>
          {t('back')}
        </ToolbarButton>
        <ToolbarButton icon={primaryAction.icon} onClick={primaryAction.onClick}>
          {primaryAction.label}
        </ToolbarButton>
        {email.folder === 'inbox' ? (
          <ToolbarButton icon={<Archive size={16} />} onClick={() => onArchive(email)}>
            {t('archive')}
          </ToolbarButton>
        ) : null}
        {email.folder !== 'trash' ? (
          <ToolbarButton icon={<Trash2 size={16} />} onClick={() => onDelete(email)}>
            {email.folder === 'drafts' ? t('deleteDraft') : t('moveToTrash')}
          </ToolbarButton>
        ) : null}
        <button
          className={`${styles.inlineIconButton} ${email.isStarred ? styles.starred : ''}`}
          onClick={() => onToggleStar(email)}
        >
          <Star size={18} fill={email.isStarred ? 'currentColor' : 'none'} />
        </button>
      </div>

      <div className={styles.detailHeader}>
        <h2 className={styles.detailSubject}>{email.subject || t('noSubject')}</h2>
        <div className={styles.detailMeta}>
          <div className={styles.detailAvatar}>{getInitial(email.from.name || email.from.address)}</div>
          <div className={styles.detailSenderInfo}>
            <div className={styles.detailSenderRow}>
              <span className={styles.detailSenderName}>{email.from.name || email.from.address}</span>
              <span className={styles.detailSenderAddress}>&lt;{email.from.address}&gt;</span>
            </div>
            <div className={styles.detailRecipients}>
              {t('to')}: {joinAddresses(email.to) || '-'}
              {email.cc.length > 0 ? ` | ${t('cc')}: ${joinAddresses(email.cc)}` : ''}
            </div>
            {email.accountEmail ? (
              <div className={styles.detailAccount}>{t('syncedAccount', { email: email.accountEmail })}</div>
            ) : null}
          </div>
          <span className={styles.detailTime}>{formatDetailTime(email.timestamp)}</span>
        </div>
      </div>

      <div className={styles.detailBody}>{email.content || email.snippet || t('emptyBody')}</div>

      {email.attachments?.length ? (
        <div className={styles.attachmentStrip}>
          <span className={styles.attachmentLabel}>{t('attachments')}</span>
          {email.attachments.map((attachment) => (
            <span className={styles.attachmentChip} key={attachment.attachmentId}>
              {attachment.filename}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
};

const EmailPage: React.FC = () => {
  const { t } = useTranslation('email');
  const [emails, setEmails] = useState<Email[]>([]);
  const [selectedEmailId, setSelectedEmailId] = useState<string | null>(null);
  const [currentFolder, setCurrentFolder] = useState<FolderType>('inbox');
  const [gmailStatus, setGmailStatus] = useState<GmailStatus>({ configured: false, connected: false });
  const [composeState, setComposeState] = useState<ComposeState>(DEFAULT_COMPOSE_STATE);
  const [settingsState, setSettingsState] = useState<SettingsState>(DEFAULT_SETTINGS_STATE);
  const [isInitialized, setIsInitialized] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  const oauthPopupRef = useRef<Window | null>(null);
  const popupMonitorRef = useRef<number | null>(null);
  const stateTimerRef = useRef<ReturnType<typeof setTimeout>>();

  const {
    saveFile: saveFileToStore,
    initFromCloud,
    syncToCloud,
    getChildrenByPath,
    getByPath,
    removeByPath,
    clear,
  } = useFileSystem({ fileApi: emailFileApi });

  const loadEmailsFromFS = useCallback((): Email[] => {
    return getChildrenByPath(EMAILS_DIR)
      .filter((node) => node.type === 'file')
      .map((node) => {
        try {
          return normalizeEmail(node.content);
        } catch {
          return null;
        }
      })
      .filter((email): email is Email => email !== null)
      .sort((left, right) => right.timestamp - left.timestamp);
  }, [getChildrenByPath]);

  const loadState = useCallback((): AppState | null => {
    return (getByPath(STATE_FILE)?.content as AppState | undefined) ?? null;
  }, [getByPath]);

  const saveState = useCallback(
    async (nextState: AppState) => {
      saveFileToStore(STATE_FILE, nextState);
      await syncToCloud(STATE_FILE, nextState).catch(() => undefined);
    },
    [saveFileToStore, syncToCloud],
  );

  const refreshStatus = useCallback(async () => {
    const nextStatus = await getGmailStatus();
    setGmailStatus(nextStatus);
  }, []);

  const loadSettings = useCallback(async () => {
    const persisted = await loadPersistedConfig();
    setSettingsState((current) => ({
      ...current,
      clientId: persisted?.gmail?.clientId || '',
      clientSecret: persisted?.gmail?.clientSecret || '',
    }));
  }, []);

  const refreshFromCloud = useCallback(
    async (focusId?: string | null, folder?: FolderType | null) => {
      await initFromCloud();
      const nextEmails = loadEmailsFromFS();
      const savedState = loadState() ?? { selectedEmailId: null, currentFolder: 'inbox' as FolderType };
      const nextFolder = folder ?? savedState.currentFolder ?? 'inbox';
      const preferredId = focusId ?? savedState.selectedEmailId ?? null;
      setEmails(nextEmails);
      setCurrentFolder(nextFolder);
      setSelectedEmailId(
        preferredId && nextEmails.some((email) => email.id === preferredId) ? preferredId : null,
      );
    },
    [initFromCloud, loadEmailsFromFS, loadState],
  );

  const upsertLocalEmail = useCallback(
    (email: Email) => {
      saveFileToStore(getEmailFilePath(email.id), email);
    },
    [saveFileToStore],
  );

  const removeLocalEmail = useCallback(
    (emailId: string) => {
      removeByPath(getEmailFilePath(emailId));
    },
    [removeByPath],
  );

  const runSync = useCallback(
    async (focusId?: string | null, folder?: FolderType | null, showBusy = true) => {
      if (!gmailStatus.connected) return;
      if (showBusy) setIsSyncing(true);
      try {
        setErrorText(null);
        await syncGmail(DEFAULT_SYNC_LIMIT);
        await refreshStatus();
        await refreshFromCloud(focusId, folder ?? currentFolder);
      } catch (error) {
        setErrorText(error instanceof Error ? error.message : String(error));
      } finally {
        if (showBusy) setIsSyncing(false);
      }
    },
    [currentFolder, gmailStatus.connected, refreshFromCloud, refreshStatus],
  );

  const selectedEmail = useMemo(
    () => emails.find((email) => email.id === selectedEmailId) || null,
    [emails, selectedEmailId],
  );

  const filteredEmails = useMemo(
    () => emails.filter((email) => email.folder === currentFolder),
    [currentFolder, emails],
  );

  const unreadCount = useMemo(
    () => emails.filter((email) => email.folder === 'inbox' && !email.isRead).length,
    [emails],
  );
  const connectedStatusText = useMemo(() => {
    if (!gmailStatus.connected) {
      return gmailStatus.configured ? t('readyToConnect') : t('configureGmail');
    }
    const parts = [gmailStatus.connectedEmail || t('unknownSender')];
    const syncTime = formatSyncTime(gmailStatus.lastSyncAt);
    if (syncTime) {
      parts.push(`${t('lastSynced')} ${syncTime}`);
    }
    return parts.join(' · ');
  }, [gmailStatus, t]);

  const openCompose = useCallback(() => {
    setComposeState({ ...DEFAULT_COMPOSE_STATE, open: true });
  }, []);

  const handleSelectEmail = useCallback(
    async (email: Email) => {
      setSelectedEmailId(email.id);
      if (!email.isRead && gmailStatus.connected) {
        const nextEmail = { ...email, isRead: true };
        setEmails((previous) => previous.map((item) => (item.id === email.id ? nextEmail : item)));
        upsertLocalEmail(nextEmail);
        try {
          await modifyGmailLabels({
            messageId: email.id,
            removeLabelIds: ['UNREAD'],
          });
        } catch (error) {
          setErrorText(error instanceof Error ? error.message : String(error));
        }
        reportAction(APP_ID, 'READ_EMAIL', { emailId: email.id });
      }
      void saveState({ selectedEmailId: email.id, currentFolder });
    },
    [currentFolder, gmailStatus.connected, saveState, upsertLocalEmail],
  );

  const handleToggleStar = useCallback(
    async (email: Email) => {
      const nextEmail = { ...email, isStarred: !email.isStarred };
      setEmails((previous) => previous.map((item) => (item.id === email.id ? nextEmail : item)));
      upsertLocalEmail(nextEmail);
      try {
        await modifyGmailLabels({
          messageId: email.id,
          addLabelIds: nextEmail.isStarred ? ['STARRED'] : [],
          removeLabelIds: nextEmail.isStarred ? [] : ['STARRED'],
        });
        reportAction(APP_ID, nextEmail.isStarred ? 'STAR_EMAIL' : 'UNSTAR_EMAIL', {
          emailId: email.id,
        });
      } catch (error) {
        setErrorText(error instanceof Error ? error.message : String(error));
      }
    },
    [upsertLocalEmail],
  );

  const handleDeleteEmail = useCallback(
    async (email: Email) => {
      try {
        setErrorText(null);
        if (email.folder === 'drafts' && email.draftId) {
          await deleteGmailDraft(email.draftId, email.id);
          setEmails((previous) => previous.filter((item) => item.id !== email.id));
          removeLocalEmail(email.id);
        } else {
          await trashGmailMessage(email.id);
          const nextEmail = { ...email, folder: 'trash' as FolderType };
          setEmails((previous) => previous.map((item) => (item.id === email.id ? nextEmail : item)));
          upsertLocalEmail(nextEmail);
        }
        if (selectedEmailId === email.id) {
          setSelectedEmailId(null);
        }
        reportAction(APP_ID, 'DELETE_EMAIL', { emailId: email.id });
      } catch (error) {
        setErrorText(error instanceof Error ? error.message : String(error));
      }
    },
    [removeLocalEmail, selectedEmailId, upsertLocalEmail],
  );

  const handleRestoreEmail = useCallback(
    async (email: Email) => {
      try {
        setErrorText(null);
        await untrashGmailMessage(email.id);
        setSelectedEmailId(null);
        await runSync(null, 'inbox', false);
      } catch (error) {
        setErrorText(error instanceof Error ? error.message : String(error));
      }
    },
    [runSync],
  );

  const handleArchiveEmail = useCallback(
    async (email: Email) => {
      try {
        setErrorText(null);
        await modifyGmailLabels({
          messageId: email.id,
          removeLabelIds: ['INBOX'],
        });
        setEmails((previous) => previous.filter((item) => item.id !== email.id));
        removeLocalEmail(email.id);
        setSelectedEmailId(null);
      } catch (error) {
        setErrorText(error instanceof Error ? error.message : String(error));
      }
    },
    [removeLocalEmail],
  );

  const handleReplyToEmail = useCallback((email: Email) => {
    setComposeState(buildReplyComposeState(email));
  }, []);

  const handleEditDraft = useCallback((email: Email) => {
    setComposeState(buildDraftComposeState(email));
  }, []);

  const closeCompose = useCallback(() => {
    setComposeState(DEFAULT_COMPOSE_STATE);
  }, []);

  const handleSaveDraft = useCallback(async () => {
    try {
      setComposeState((previous) => ({ ...previous, saving: true }));
      const result = await saveGmailDraft({
        to: composeState.to,
        cc: composeState.cc,
        subject: composeState.subject,
        content: composeState.content,
        threadId: composeState.threadId,
        internetMessageId: composeState.internetMessageId,
        references: composeState.references,
        draftId: composeState.draftId,
      });
      reportAction(APP_ID, 'SAVE_DRAFT', { messageId: result.messageId, draftId: result.draftId });
      closeCompose();
      setCurrentFolder('drafts');
      await refreshFromCloud(result.messageId, 'drafts');
      await refreshStatus();
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : String(error));
      setComposeState((previous) => ({ ...previous, saving: false }));
    }
  }, [closeCompose, composeState, refreshFromCloud, refreshStatus]);

  const handleSendMessage = useCallback(async () => {
    try {
      setComposeState((previous) => ({ ...previous, saving: true }));
      const result = await sendGmailMessage({
        to: composeState.to,
        cc: composeState.cc,
        subject: composeState.subject,
        content: composeState.content,
        threadId: composeState.threadId,
        internetMessageId: composeState.internetMessageId,
        references: composeState.references,
        draftId: composeState.draftId,
      });
      reportAction(APP_ID, 'SEND_EMAIL', { messageId: result.messageId });
      closeCompose();
      setCurrentFolder('sent');
      await runSync(result.messageId, 'sent', false);
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : String(error));
      setComposeState((previous) => ({ ...previous, saving: false }));
    }
  }, [closeCompose, composeState, runSync]);

  const handleSaveSettings = useCallback(async () => {
    try {
      setSettingsState((previous) => ({ ...previous, saving: true }));
      const persisted = await loadPersistedConfig();
      const previousConfig = persisted?.gmail;
      const nextClientId = settingsState.clientId.trim();
      const nextClientSecret = settingsState.clientSecret.trim();
      const credentialsChanged =
        (previousConfig?.clientId || '') !== nextClientId ||
        (previousConfig?.clientSecret || '') !== nextClientSecret;

      await savePersistedConfig({
        ...(persisted ?? {}),
        gmail: {
          ...(previousConfig ?? {}),
          clientId: nextClientId || undefined,
          clientSecret: nextClientSecret || undefined,
          ...(credentialsChanged
            ? {
                connectedEmail: undefined,
                accessToken: undefined,
                accessTokenExpiresAt: undefined,
                refreshToken: undefined,
                historyId: undefined,
                lastSyncAt: undefined,
                scope: undefined,
              }
            : {}),
        },
      });

      setSettingsState((previous) => ({ ...previous, open: false, saving: false }));
      await refreshStatus();
    } catch (error) {
      setSettingsState((previous) => ({ ...previous, saving: false }));
      setErrorText(error instanceof Error ? error.message : String(error));
    }
  }, [refreshStatus, settingsState.clientId, settingsState.clientSecret]);

  const handleConnectGmail = useCallback(async () => {
    if (!gmailStatus.configured) {
      setSettingsState((previous) => ({ ...previous, open: true }));
      return;
    }

    const popup = window.open('', 'openroom-gmail-oauth', 'width=520,height=720');
    if (!popup) {
      setErrorText(t('popupBlocked'));
      return;
    }

    popup.document.write(`<p style="font-family: sans-serif; padding: 16px;">${t('openingGoogle')}</p>`);
    oauthPopupRef.current = popup;
    setIsConnecting(true);
    setErrorText(null);

    try {
      const { authUrl } = await startGmailOAuth();
      popup.location.href = authUrl;
      if (popupMonitorRef.current) {
        window.clearInterval(popupMonitorRef.current);
      }
      popupMonitorRef.current = window.setInterval(() => {
        if (!oauthPopupRef.current || !oauthPopupRef.current.closed) return;
        if (popupMonitorRef.current) {
          window.clearInterval(popupMonitorRef.current);
          popupMonitorRef.current = null;
        }
        oauthPopupRef.current = null;
        setIsConnecting(false);
      }, 400);
    } catch (error) {
      popup.close();
      oauthPopupRef.current = null;
      setIsConnecting(false);
      setErrorText(error instanceof Error ? error.message : String(error));
    }
  }, [gmailStatus.configured, t]);

  const handleDisconnectGmail = useCallback(async () => {
    try {
      await disconnectGmail();
      clear();
      setEmails([]);
      setSelectedEmailId(null);
      setCurrentFolder('inbox');
      await refreshStatus();
      setSettingsState((previous) => ({ ...previous, open: false }));
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : String(error));
    }
  }, [clear, refreshStatus]);

  useAgentActionListener(
    APP_ID,
    useCallback(
      async (action: CharacterAppAction): Promise<string> => {
        const emailId = action.params?.messageId || action.params?.emailId;

        switch (action.action_type) {
          case 'SYNC_EMAIL': {
            await runSync(action.params?.focusId ?? null, (action.params?.folder as FolderType | undefined) ?? null, false);
            return 'success';
          }
          case 'SEND_EMAIL': {
            const result = await sendGmailMessage({
              to: action.params?.to,
              cc: action.params?.cc,
              subject: action.params?.subject,
              content: action.params?.content,
              threadId: action.params?.threadId,
              internetMessageId: action.params?.internetMessageId,
              references: action.params?.references,
              draftId: action.params?.draftId,
            });
            await runSync(result.messageId, 'sent', false);
            return 'success';
          }
          case 'SAVE_DRAFT': {
            const result = await saveGmailDraft({
              to: action.params?.to,
              cc: action.params?.cc,
              subject: action.params?.subject,
              content: action.params?.content,
              threadId: action.params?.threadId,
              internetMessageId: action.params?.internetMessageId,
              references: action.params?.references,
              draftId: action.params?.draftId,
            });
            await refreshFromCloud(result.messageId, 'drafts');
            return 'success';
          }
          case 'MARK_READ': {
            if (!emailId) return 'error: missing emailId';
            await modifyGmailLabels({ messageId: emailId, removeLabelIds: ['UNREAD'] });
            await refreshFromCloud(emailId, currentFolder);
            return 'success';
          }
          case 'STAR_EMAIL': {
            if (!emailId) return 'error: missing emailId';
            await modifyGmailLabels({ messageId: emailId, addLabelIds: ['STARRED'] });
            await refreshFromCloud(emailId, currentFolder);
            return 'success';
          }
          case 'UNSTAR_EMAIL': {
            if (!emailId) return 'error: missing emailId';
            await modifyGmailLabels({ messageId: emailId, removeLabelIds: ['STARRED'] });
            await refreshFromCloud(emailId, currentFolder);
            return 'success';
          }
          case 'TRASH_EMAIL':
          case 'DELETE_EMAIL': {
            if (!emailId) return 'error: missing emailId';
            await trashGmailMessage(emailId);
            await refreshFromCloud(null, currentFolder);
            return 'success';
          }
          default:
            return `error: unknown action_type ${action.action_type}`;
        }
      },
      [currentFolder, refreshFromCloud, runSync],
    ),
  );

  useEffect(() => {
    const init = async () => {
      try {
        reportLifecycle(AppLifecycle.LOADING);
        const manager = await initVibeApp({
          id: APP_ID,
          url: window.location.href,
          type: 'page',
          name: 'Email',
          windowStyle: { width: 920, height: 720 },
        });

        manager.handshake({
          id: APP_ID,
          url: window.location.href,
          type: 'page',
          name: 'Email',
          windowStyle: { width: 920, height: 720 },
        });

        reportLifecycle(AppLifecycle.DOM_READY);
        await fetchVibeInfo().catch(() => undefined);
        await Promise.all([loadSettings(), refreshStatus()]);
        await refreshFromCloud();
        setIsInitialized(true);
        setIsLoading(false);
        reportLifecycle(AppLifecycle.LOADED);
        manager.ready();
      } catch (error) {
        setIsLoading(false);
        setErrorText(error instanceof Error ? error.message : String(error));
        reportLifecycle(AppLifecycle.ERROR, String(error));
      }
    };

    void init();

    return () => {
      reportLifecycle(AppLifecycle.UNLOADING);
      reportLifecycle(AppLifecycle.DESTROYED);
      if (popupMonitorRef.current) {
        window.clearInterval(popupMonitorRef.current);
      }
    };
  }, [loadSettings, refreshFromCloud, refreshStatus]);

  useEffect(() => {
    const handler = (event: MessageEvent<{ type?: string; success?: boolean }>) => {
      if (event.data?.type !== 'openroom-gmail-oauth') return;
      setIsConnecting(false);
      if (popupMonitorRef.current) {
        window.clearInterval(popupMonitorRef.current);
        popupMonitorRef.current = null;
      }
      oauthPopupRef.current = null;
      if (!event.data.success) {
        setErrorText(t('oauthFailed'));
        return;
      }
      void (async () => {
        await refreshStatus();
        await runSync(null, 'inbox', false);
      })();
    };

    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [refreshStatus, runSync, t]);

  useEffect(() => {
    if (!isInitialized) return;
    if (stateTimerRef.current) {
      clearTimeout(stateTimerRef.current);
    }
    stateTimerRef.current = setTimeout(() => {
      void saveState({ selectedEmailId, currentFolder });
    }, 500);

    return () => {
      if (stateTimerRef.current) clearTimeout(stateTimerRef.current);
    };
  }, [currentFolder, isInitialized, saveState, selectedEmailId]);

  return (
    <div className={styles.email}>
      <div className={styles.topBar}>
        <div className={styles.topBarCopy}>
          <div className={styles.topBarTitle}>{t('appTitle')}</div>
          <div className={styles.topBarStatus}>{connectedStatusText}</div>
        </div>
        <div className={styles.topBarActions}>
          <ToolbarButton icon={<Settings size={16} />} onClick={() => setSettingsState((previous) => ({ ...previous, open: true }))}>
            {t('settings')}
          </ToolbarButton>
          <ToolbarButton
            icon={<RefreshCw size={16} />}
            busy={isSyncing}
            disabled={!gmailStatus.connected || isSyncing}
            onClick={() => void runSync()}
          >
            {t('sync')}
          </ToolbarButton>
          {gmailStatus.connected ? (
            <ToolbarButton icon={<MailPlus size={16} />} onClick={openCompose}>
              {t('compose')}
            </ToolbarButton>
          ) : (
            <ToolbarButton icon={<MailPlus size={16} />} busy={isConnecting} onClick={() => void handleConnectGmail()}>
              {t('connectGmail')}
            </ToolbarButton>
          )}
        </div>
      </div>

      {errorText ? <div className={styles.errorBanner}>{errorText}</div> : null}

      {!gmailStatus.connected && !isLoading ? (
        <div className={styles.centerStage}>
          <div className={styles.emptyCard}>
            <div className={styles.emptyHeadline}>{t(gmailStatus.configured ? 'connectHeadline' : 'setupHeadline')}</div>
            <p>{t(gmailStatus.configured ? 'connectDescription' : 'setupDescription')}</p>
            <div className={styles.emptyActions}>
              <ToolbarButton icon={<Settings size={16} />} onClick={() => setSettingsState((previous) => ({ ...previous, open: true }))}>
                {t('openSettings')}
              </ToolbarButton>
              {gmailStatus.configured ? (
                <ToolbarButton icon={<MailPlus size={16} />} busy={isConnecting} onClick={() => void handleConnectGmail()}>
                  {t('connectGmail')}
                </ToolbarButton>
              ) : null}
            </div>
          </div>
        </div>
      ) : selectedEmail ? (
        <EmailDetail
          email={selectedEmail}
          onBack={() => setSelectedEmailId(null)}
          onReply={handleReplyToEmail}
          onEditDraft={handleEditDraft}
          onToggleStar={(email) => void handleToggleStar(email)}
          onArchive={(email) => void handleArchiveEmail(email)}
          onDelete={(email) => void handleDeleteEmail(email)}
          onRestore={(email) => void handleRestoreEmail(email)}
        />
      ) : (
        <>
          <div className={styles.folderTabs}>
            {FOLDER_CONFIG.map((folder) => (
              <button
                key={folder.key}
                className={`${styles.folderTab} ${currentFolder === folder.key ? styles.active : ''}`}
                onClick={() => setCurrentFolder(folder.key)}
              >
                <span>{t(folder.labelKey)}</span>
                {folder.key === 'inbox' && unreadCount > 0 ? (
                  <span className={styles.folderBadge}>{unreadCount}</span>
                ) : null}
              </button>
            ))}
          </div>

          <div className={styles.emailList}>
            {isLoading ? (
              <div className={styles.emptyState}>
                <Loader2 className={styles.spin} size={24} />
              </div>
            ) : filteredEmails.length === 0 ? (
              <div className={styles.emptyState}>
                <p>{t('empty')}</p>
              </div>
            ) : (
              filteredEmails.map((email) => (
                <EmailItem
                  key={email.id}
                  email={email}
                  isSelected={selectedEmailId === email.id}
                  onSelect={(item) => void handleSelectEmail(item)}
                  onToggleStar={(item) => void handleToggleStar(item)}
                  onDelete={(item) => void handleDeleteEmail(item)}
                  onRestore={(item) => void handleRestoreEmail(item)}
                />
              ))
            )}
          </div>
        </>
      )}

      {composeState.open ? (
        <ComposeModal
          composeState={composeState}
          onChange={(patch) => setComposeState((previous) => ({ ...previous, ...patch }))}
          onClose={closeCompose}
          onSaveDraft={() => void handleSaveDraft()}
          onSend={() => void handleSendMessage()}
        />
      ) : null}

      {settingsState.open ? (
        <SettingsModal
          settingsState={settingsState}
          connected={gmailStatus.connected}
          connectedEmail={gmailStatus.connectedEmail}
          onChange={(patch) => setSettingsState((previous) => ({ ...previous, ...patch }))}
          onClose={() => setSettingsState((previous) => ({ ...previous, open: false }))}
          onSave={() => void handleSaveSettings()}
          onDisconnect={() => void handleDisconnectGmail()}
        />
      ) : null}
    </div>
  );
};

interface ComposeModalProps {
  composeState: ComposeState;
  onChange: (patch: Partial<ComposeState>) => void;
  onClose: () => void;
  onSaveDraft: () => void;
  onSend: () => void;
}

const ComposeModal: React.FC<ComposeModalProps> = ({
  composeState,
  onChange,
  onClose,
  onSaveDraft,
  onSend,
}) => {
  const { t } = useTranslation('email');

  return (
    <div className={styles.modalOverlay}>
      <div className={styles.modalCard}>
        <div className={styles.modalHeader}>
          <div>
            <div className={styles.modalTitle}>
              {composeState.mode === 'reply'
                ? t('reply')
                : composeState.mode === 'draft'
                  ? t('editDraft')
                  : t('compose')}
            </div>
            <div className={styles.modalSubtitle}>{t('composeHint')}</div>
          </div>
          <button className={styles.inlineIconButton} onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <label className={styles.modalField}>
          <span>{t('to')}</span>
          <input
            className={styles.fieldInput}
            value={composeState.to}
            onChange={(event) => onChange({ to: event.target.value })}
            placeholder="name@example.com, another@example.com"
          />
        </label>

        <label className={styles.modalField}>
          <span>{t('cc')}</span>
          <input
            className={styles.fieldInput}
            value={composeState.cc}
            onChange={(event) => onChange({ cc: event.target.value })}
            placeholder={t('optional')}
          />
        </label>

        <label className={styles.modalField}>
          <span>{t('subject')}</span>
          <input
            className={styles.fieldInput}
            value={composeState.subject}
            onChange={(event) => onChange({ subject: event.target.value })}
            placeholder={t('noSubject')}
          />
        </label>

        <label className={styles.modalField}>
          <span>{t('message')}</span>
          <textarea
            className={styles.messageInput}
            value={composeState.content}
            onChange={(event) => onChange({ content: event.target.value })}
          />
        </label>

        <div className={styles.modalActions}>
          <ToolbarButton icon={<Save size={16} />} busy={composeState.saving} onClick={onSaveDraft}>
            {t('saveDraft')}
          </ToolbarButton>
          <ToolbarButton icon={<Send size={16} />} busy={composeState.saving} onClick={onSend}>
            {t('send')}
          </ToolbarButton>
        </div>
      </div>
    </div>
  );
};

interface SettingsModalProps {
  settingsState: SettingsState;
  connected: boolean;
  connectedEmail?: string;
  onChange: (patch: Partial<SettingsState>) => void;
  onClose: () => void;
  onSave: () => void;
  onDisconnect: () => void;
}

const SettingsModal: React.FC<SettingsModalProps> = ({
  settingsState,
  connected,
  connectedEmail,
  onChange,
  onClose,
  onSave,
  onDisconnect,
}) => {
  const { t } = useTranslation('email');

  return (
    <div className={styles.modalOverlay}>
      <div className={styles.modalCard}>
        <div className={styles.modalHeader}>
          <div>
            <div className={styles.modalTitle}>{t('gmailSettings')}</div>
            <div className={styles.modalSubtitle}>{t('gmailSettingsHint')}</div>
          </div>
          <button className={styles.inlineIconButton} onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <label className={styles.modalField}>
          <span>{t('clientId')}</span>
          <input
            className={styles.fieldInput}
            value={settingsState.clientId}
            onChange={(event) => onChange({ clientId: event.target.value })}
            placeholder="Google OAuth client ID"
          />
        </label>

        <label className={styles.modalField}>
          <span>{t('clientSecret')}</span>
          <input
            className={styles.fieldInput}
            value={settingsState.clientSecret}
            onChange={(event) => onChange({ clientSecret: event.target.value })}
            placeholder={t('optional')}
          />
        </label>

        {connected && connectedEmail ? (
          <div className={styles.connectedBadge}>{t('connectedTo', { email: connectedEmail })}</div>
        ) : null}

        <div className={styles.modalActions}>
          <ToolbarButton icon={<Save size={16} />} busy={settingsState.saving} onClick={onSave}>
            {t('saveSettings')}
          </ToolbarButton>
          {connected ? (
            <ToolbarButton icon={<LogOut size={16} />} onClick={onDisconnect}>
              {t('disconnect')}
            </ToolbarButton>
          ) : null}
        </div>
      </div>
    </div>
  );
};

export default EmailPage;
