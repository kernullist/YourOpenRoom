import React, {
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react';
import {
  MessageCircle,
  Twitter,
  Music,
  BookOpen,
  Image,
  Circle,
  LayoutGrid,
  Mail,
  FileText,
  Globe,
  Crown,
  Shield,
  Newspaper,
  CalendarDays,
  Radio,
  KanbanSquare,
  Code2,
  Video,
  VideoOff,
  Plus,
  X,
  Upload,
  FileImage,
  FileArchive,
  type LucideIcon,
} from 'lucide-react';
import ChatPanel from '../ChatPanel';
import AppWindow from '../AppWindow';
import {
  claimZIndex,
  getMaximizedWindowBounds,
  getWindows,
  openWindow,
  subscribe,
  updateMaximizedWindows,
} from '@/lib/windowManager';
import { getDesktopApps } from '@/lib/appRegistry';
import { dispatchAgentAction, reportUserOsAction, onOSEvent } from '@/lib/vibeContainerMock';
import { setReportUserActions, extractCard } from '@/lib';
import type { ExtractResult, Manifest } from '@/lib';
import { buildModPrompt } from './modPrompt';
import { chat, loadConfig } from '@/lib/llmClient';
import {
  generateModId,
  addMod,
  setActiveMod,
  saveModCollection,
  loadModCollectionSync,
  DEFAULT_MOD_COLLECTION,
} from '@/lib/modManager';
import type { ModConfig } from '@/lib/modManager';
import { seedMetaFiles } from '@/lib/seedMeta';
import { logger } from '@/lib/logger';
import { OPEN_APP_SETTINGS_EVENT } from '@/lib/settingsEvents';
import styles from './index.module.scss';

function useWindows() {
  return useSyncExternalStore(subscribe, getWindows);
}

/** Lucide icon name to component mapping */
const ICON_MAP: Record<string, LucideIcon> = {
  Twitter,
  Music,
  BookOpen,
  Image,
  Circle,
  LayoutGrid,
  Mail,
  FileText,
  Globe,
  Crown,
  Shield,
  Newspaper,
  CalendarDays,
  Radio,
  KanbanSquare,
  Code2,
  FileArchive,
  MessageCircle,
};

const DESKTOP_APPS = getDesktopApps().map((app) => ({
  ...app,
  IconComp: ICON_MAP[app.icon] || Circle,
}));

const VIDEO_WALLPAPER =
  'https://cdn.openroom.ai/public-cdn-s3-us-west-2/talkie-op-img/1609284623_1772622757413_1.mp4';

const STATIC_WALLPAPER =
  'https://cdn.openroom.ai/public-cdn-s3-us-west-2/talkie-op-img/image/437110625_1772619481913_Aoi_default_Commander_Room.jpg';

const CHAT_DOCK_SIDE_KEY = 'openroom-chat-dock-side';
const CHAT_DOCK_SIDE_EVENT = 'openroom-chat-dock-side-changed';
const DESKTOP_ICON_ORDER_KEY = 'openroom-desktop-icon-order-v1';
const KIRA_AUTOMATION_NOTICE_EVENT = 'openroom-kira-automation-notice';
const KIRA_APP_ID = 18;
const KIRA_NOTICE_TIMEOUT_MS = 12_000;

interface KiraAutomationEvent {
  id: string;
  workId: string;
  title: string;
  projectName: string;
  message: string;
  createdAt: number;
  type: 'started' | 'resumed' | 'completed' | 'needs_attention';
}

interface KiraAutomationNotice extends KiraAutomationEvent {
  localId: string;
}

function isVideoUrl(url: string): boolean {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    return /\.(mp4|webm|mov|ogg)$/.test(pathname);
  } catch {
    return false;
  }
}

function normalizeDesktopIconOrder(value: unknown): number[] {
  const availableIds = new Set(DESKTOP_APPS.map((app) => app.appId));
  const nextOrder: number[] = [];

  if (Array.isArray(value)) {
    for (const rawId of value) {
      const appId = Number(rawId);
      if (availableIds.has(appId) && !nextOrder.includes(appId)) {
        nextOrder.push(appId);
      }
    }
  }

  for (const app of DESKTOP_APPS) {
    if (!nextOrder.includes(app.appId)) {
      nextOrder.push(app.appId);
    }
  }

  return nextOrder;
}

function loadDesktopIconOrder(): number[] {
  try {
    return normalizeDesktopIconOrder(
      JSON.parse(localStorage.getItem(DESKTOP_ICON_ORDER_KEY) ?? '[]'),
    );
  } catch {
    return normalizeDesktopIconOrder([]);
  }
}

function saveDesktopIconOrder(order: number[]): void {
  try {
    localStorage.setItem(DESKTOP_ICON_ORDER_KEY, JSON.stringify(normalizeDesktopIconOrder(order)));
  } catch {
    // ignore persistence failures
  }
}

function orderDesktopApps(order: number[]): typeof DESKTOP_APPS {
  const appById = new Map(DESKTOP_APPS.map((app) => [app.appId, app]));
  return normalizeDesktopIconOrder(order)
    .map((appId) => appById.get(appId))
    .filter((app): app is (typeof DESKTOP_APPS)[number] => Boolean(app));
}

function moveDesktopIcon(order: number[], draggedAppId: number, targetAppId: number): number[] {
  if (draggedAppId === targetAppId) return order;

  const nextOrder = normalizeDesktopIconOrder(order).filter((appId) => appId !== draggedAppId);
  const targetIndex = nextOrder.indexOf(targetAppId);
  if (targetIndex < 0) return order;

  nextOrder.splice(targetIndex, 0, draggedAppId);
  return nextOrder;
}

const Shell: React.FC = () => {
  const [chatOpen, setChatOpen] = useState(true);
  const [chatDockSide, setChatDockSide] = useState<'left' | 'right'>(() => {
    try {
      return localStorage.getItem(CHAT_DOCK_SIDE_KEY) === 'left' ? 'left' : 'right';
    } catch {
      return 'right';
    }
  });
  const [reportEnabled, setReportEnabled] = useState(true);
  const [liveWallpaper, setLiveWallpaper] = useState(true);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [extractResult, setExtractResult] = useState<ExtractResult | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [modGenerating, setModGenerating] = useState(false);
  const [kiraNotices, setKiraNotices] = useState<KiraAutomationNotice[]>([]);
  const [kiraUnreadCount, setKiraUnreadCount] = useState(0);
  const [desktopIconOrder, setDesktopIconOrder] = useState(loadDesktopIconOrder);
  const [draggingAppId, setDraggingAppId] = useState<number | null>(null);
  const [dragOverAppId, setDragOverAppId] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const kiraNoticeTimersRef = useRef<Map<string, number>>(new Map());
  const draggedAppIdRef = useRef<number | null>(null);
  const desktopIconOrderRef = useRef<number[]>(desktopIconOrder);
  const dragStartIconOrderRef = useRef<number[] | null>(null);
  const dragCommittedRef = useRef(false);
  const orderedDesktopApps = useMemo(() => orderDesktopApps(desktopIconOrder), [desktopIconOrder]);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setUploadedFile(file);
      setExtractResult(null);
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, []);

  const handleRemoveFile = useCallback(() => {
    setUploadedFile(null);
    setExtractResult(null);
  }, []);

  useEffect(() => {
    desktopIconOrderRef.current = desktopIconOrder;
  }, [desktopIconOrder]);

  const handleDesktopIconDragStart = useCallback(
    (event: React.DragEvent<HTMLButtonElement>, appId: number) => {
      draggedAppIdRef.current = appId;
      dragStartIconOrderRef.current = desktopIconOrderRef.current;
      dragCommittedRef.current = false;
      setDraggingAppId(appId);
      setDragOverAppId(appId);
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', String(appId));
    },
    [],
  );

  const handleDesktopIconDragEnter = useCallback(
    (event: React.DragEvent<HTMLButtonElement>, targetAppId: number) => {
      event.preventDefault();
      const draggedAppId = draggedAppIdRef.current;
      if (!draggedAppId) return;

      setDragOverAppId(targetAppId);
      setDesktopIconOrder((previousOrder) =>
        moveDesktopIcon(previousOrder, draggedAppId, targetAppId),
      );
    },
    [],
  );

  const handleDesktopIconDragOver = useCallback((event: React.DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const resetDesktopIconDrag = useCallback(() => {
    draggedAppIdRef.current = null;
    setDraggingAppId(null);
    setDragOverAppId(null);
  }, []);

  const handleDesktopIconDragEnd = useCallback(() => {
    if (!dragCommittedRef.current && dragStartIconOrderRef.current) {
      setDesktopIconOrder(dragStartIconOrderRef.current);
    }
    dragStartIconOrderRef.current = null;
    dragCommittedRef.current = false;
    resetDesktopIconDrag();
  }, [resetDesktopIconDrag]);

  const handleDesktopIconDrop = useCallback(
    (event: React.DragEvent<HTMLButtonElement>, targetAppId: number) => {
      event.preventDefault();
      event.stopPropagation();

      const draggedAppId =
        draggedAppIdRef.current || Number(event.dataTransfer.getData('text/plain'));
      if (draggedAppId) {
        dragCommittedRef.current = true;
        setDesktopIconOrder((previousOrder) => {
          const nextOrder = moveDesktopIcon(previousOrder, draggedAppId, targetAppId);
          saveDesktopIconOrder(nextOrder);
          return nextOrder;
        });
      }
      resetDesktopIconDrag();
    },
    [resetDesktopIconDrag],
  );

  const handleDesktopGridDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      const draggedAppId =
        draggedAppIdRef.current || Number(event.dataTransfer.getData('text/plain'));

      if (draggedAppId) {
        dragCommittedRef.current = true;
        setDesktopIconOrder((previousOrder) => {
          const nextOrder = [
            ...normalizeDesktopIconOrder(previousOrder).filter((appId) => appId !== draggedAppId),
            draggedAppId,
          ];
          saveDesktopIconOrder(nextOrder);
          return nextOrder;
        });
      }
      resetDesktopIconDrag();
    },
    [resetDesktopIconDrag],
  );

  const dismissKiraNotice = useCallback((localId: string) => {
    const timer = kiraNoticeTimersRef.current.get(localId);
    if (timer) {
      window.clearTimeout(timer);
      kiraNoticeTimersRef.current.delete(localId);
    }
    setKiraNotices((prev) => prev.filter((notice) => notice.localId !== localId));
  }, []);

  const handleOpenKiraNotice = useCallback(
    async (notice: KiraAutomationNotice) => {
      setKiraUnreadCount(0);
      dismissKiraNotice(notice.localId);
      try {
        await dispatchAgentAction({
          app_id: KIRA_APP_ID,
          action_type: 'OPEN_APP',
          params: { app_id: String(KIRA_APP_ID) },
        });
        if (notice.workId) {
          await dispatchAgentAction({
            app_id: KIRA_APP_ID,
            action_type: 'REFRESH_KIRA',
            params: { focusId: notice.workId, focusType: 'work' },
          });
        }
      } catch (error) {
        logger.error('Shell', 'Failed to open Kira from notification:', error);
      }
    },
    [dismissKiraNotice],
  );

  const generateMod = useCallback(async (character: Manifest['character']): Promise<string> => {
    const llmConfig = await loadConfig();
    if (!llmConfig) {
      throw new Error(
        'No LLM configuration found. Please open Settings (gear icon) and configure your LLM API key first.',
      );
    }

    const prompt = buildModPrompt([], JSON.stringify({ character, apps: [] }));
    logger.info('Shell', 'Mod generation prompt built, length:', prompt.length);

    setModGenerating(true);
    try {
      const response = await chat([{ role: 'user', content: prompt }], [], llmConfig);
      logger.info('Shell', 'Mod generation LLM response length:', response.content.length);

      let jsonStr = response.content.trim();
      const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (fenceMatch) jsonStr = fenceMatch[1].trim();

      let modJson: Record<string, unknown>;
      try {
        modJson = JSON.parse(jsonStr);
      } catch {
        throw new Error('LLM returned invalid JSON. Try again or use a different model.');
      }

      const modId = generateModId();
      const modConfig: ModConfig = {
        id: modId,
        mod_name: (modJson.name as string) || (modJson.identifier as string) || 'Generated Mod',
        mod_name_en: (modJson.name as string) || (modJson.identifier as string) || 'Generated Mod',
        mod_description: (modJson.description as string) || '',
        display_desc: (modJson.display_desc as string) || '',
        prologue: (modJson.prologue as string) || '',
        opening_rec_replies: Array.isArray(modJson.opening_rec_replies)
          ? (modJson.opening_rec_replies as string[]).map((r) => ({ reply_text: r }))
          : [],
        stage_count: Array.isArray(modJson.stages) ? modJson.stages.length : 0,
        stages: Array.isArray(modJson.stages)
          ? Object.fromEntries(
              (
                modJson.stages as Array<{
                  name: string;
                  description: string;
                  targets: Array<{ id: number; description: string }>;
                }>
              ).map((s, i) => [
                i,
                {
                  stage_index: i,
                  stage_name: s.name || `Stage ${i + 1}`,
                  stage_description: s.description || '',
                  stage_targets: Object.fromEntries(
                    (s.targets || []).map((t) => [t.id, t.description]),
                  ),
                },
              ]),
            )
          : {},
      };

      const collection = loadModCollectionSync() ?? DEFAULT_MOD_COLLECTION;
      const updated = setActiveMod(addMod(collection, modConfig), modId);
      await saveModCollection(updated);
      logger.info('Shell', 'Mod saved successfully:', modId, modConfig.mod_name);
      return modId;
    } catch (err) {
      logger.error('Shell', 'Mod generation failed:', err);
      throw err;
    } finally {
      setModGenerating(false);
    }
  }, []);

  const [modGenError, setModGenError] = useState<string | null>(null);

  const handleUploadSubmit = useCallback(async () => {
    if (!uploadedFile) return;
    setExtracting(true);
    setExtractResult(null);
    setModGenError(null);
    try {
      const result = await extractCard(uploadedFile);
      setExtractResult(result);
      if (result.status === 'success') {
        logger.info('Shell', 'Card extracted:', result.manifest);
        setUploadedFile(null);
        setUploadOpen(false);
        setExtractResult(null);
        // extracting will be cleared in finally; generateMod shows its own modGenerating overlay
        const modId = await generateMod(result.manifest.character);
        window.dispatchEvent(new CustomEvent('open-mod-editor', { detail: { modId } }));
      }
    } catch (err) {
      logger.error('Shell', 'Upload submit error:', err);
      setModGenError(err instanceof Error ? err.message : String(err));
    } finally {
      setExtracting(false);
    }
  }, [uploadedFile, generateMod]);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [wallpaper, setWallpaper] = useState(VIDEO_WALLPAPER);
  const [chatZIndex, setChatZIndex] = useState(() => claimZIndex());
  const windows = useWindows();

  const bgWallpaper = isVideoUrl(wallpaper) ? STATIC_WALLPAPER : wallpaper;
  const showVideo = liveWallpaper && isVideoUrl(wallpaper);

  useEffect(() => {
    const syncMaximizedWindows = () => {
      updateMaximizedWindows(getMaximizedWindowBounds());
    };

    const frame = window.requestAnimationFrame(syncMaximizedWindows);
    window.addEventListener('resize', syncMaximizedWindows);

    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', syncMaximizedWindows);
    };
  }, [chatOpen, chatDockSide, showVideo]);

  useEffect(() => {
    const handleOpenSettings = () => {
      setChatOpen(true);
      setChatZIndex(claimZIndex());
    };
    window.addEventListener(OPEN_APP_SETTINGS_EVENT, handleOpenSettings);
    return () => window.removeEventListener(OPEN_APP_SETTINGS_EVENT, handleOpenSettings);
  }, []);

  const handleToggleReport = useCallback(() => {
    setReportEnabled((prev) => {
      const next = !prev;
      setReportUserActions(next);
      return next;
    });
  }, []);

  useEffect(() => {
    seedMetaFiles();
  }, []);

  // Pause user action reporting while upload or mod generation is in progress
  useEffect(() => {
    const shouldListen = !uploadOpen && !modGenerating;
    setReportUserActions(shouldListen);
    setReportEnabled(shouldListen);
  }, [uploadOpen, modGenerating]);

  // Listen for OS events (e.g. wallpaper changes from agent)
  useEffect(() => {
    return onOSEvent((event) => {
      if (event.type === 'SET_WALLPAPER' && typeof event.wallpaper_url === 'string') {
        setWallpaper(event.wallpaper_url);
      }
    });
  }, []);

  useEffect(() => {
    const syncDockSide = () => {
      try {
        setChatDockSide(localStorage.getItem(CHAT_DOCK_SIDE_KEY) === 'left' ? 'left' : 'right');
      } catch {
        setChatDockSide('right');
      }
    };

    const handleDockEvent = (event: Event) => {
      const side = (event as CustomEvent<{ side?: 'left' | 'right' }>).detail?.side;
      setChatDockSide(side === 'left' ? 'left' : 'right');
    };

    syncDockSide();
    window.addEventListener(CHAT_DOCK_SIDE_EVENT, handleDockEvent);
    window.addEventListener('storage', syncDockSide);
    return () => {
      window.removeEventListener(CHAT_DOCK_SIDE_EVENT, handleDockEvent);
      window.removeEventListener('storage', syncDockSide);
    };
  }, []);

  useEffect(() => {
    const handleKiraNotice = (event: Event) => {
      const detail = (event as CustomEvent<KiraAutomationEvent>).detail;
      if (!detail?.id) return;

      const notice: KiraAutomationNotice = {
        ...detail,
        localId: `${detail.id}-${Date.now()}`,
      };
      setKiraNotices((prev) => [notice, ...prev].slice(0, 4));
      setKiraUnreadCount((prev) => prev + 1);

      const timer = window.setTimeout(() => {
        setKiraNotices((prev) => prev.filter((item) => item.localId !== notice.localId));
        kiraNoticeTimersRef.current.delete(notice.localId);
      }, KIRA_NOTICE_TIMEOUT_MS);
      kiraNoticeTimersRef.current.set(notice.localId, timer);
    };

    window.addEventListener(KIRA_AUTOMATION_NOTICE_EVENT, handleKiraNotice);
    return () => {
      window.removeEventListener(KIRA_AUTOMATION_NOTICE_EVENT, handleKiraNotice);
      kiraNoticeTimersRef.current.forEach((timer) => window.clearTimeout(timer));
      kiraNoticeTimersRef.current.clear();
    };
  }, []);

  return (
    <div
      className={styles.shell}
      data-testid="shell"
      style={{
        backgroundImage: `url(${bgWallpaper})`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
      }}
    >
      {showVideo && (
        <div className={styles.liveWallpaperLayer} data-testid="video-pip">
          <video
            className={styles.liveWallpaperVideo}
            src={wallpaper}
            autoPlay
            loop
            muted
            playsInline
          />
          <div className={styles.liveWallpaperVignette} />
          <div className={styles.liveWallpaperGlow} />
        </div>
      )}
      {/* Desktop with app icons */}
      <div
        className={`${styles.desktop} ${showVideo ? styles.desktopLive : ''} ${
          chatOpen && chatDockSide === 'left'
            ? showVideo
              ? styles.desktopChatLeftCompact
              : styles.desktopChatLeft
            : ''
        }`}
        data-testid="desktop"
      >
        <div
          className={`${styles.iconGrid} ${draggingAppId ? styles.iconGridDragging : ''}`}
          onDragOver={handleDesktopIconDragOver}
          onDrop={handleDesktopGridDrop}
        >
          {orderedDesktopApps.map((app) => (
            <button
              key={app.appId}
              className={`${styles.appIcon} ${
                draggingAppId === app.appId ? styles.appIconDragging : ''
              } ${dragOverAppId === app.appId ? styles.appIconDropTarget : ''}`}
              data-testid={`app-icon-${app.appId}`}
              draggable
              aria-grabbed={draggingAppId === app.appId}
              onDragStart={(event) => handleDesktopIconDragStart(event, app.appId)}
              onDragEnter={(event) => handleDesktopIconDragEnter(event, app.appId)}
              onDragOver={handleDesktopIconDragOver}
              onDrop={(event) => handleDesktopIconDrop(event, app.appId)}
              onDragEnd={handleDesktopIconDragEnd}
              onDoubleClick={() => {
                openWindow(app.appId);
                reportUserOsAction('OPEN_APP', { app_id: String(app.appId) });
              }}
              title={`Drag to rearrange. Double-click to open ${app.displayName}`}
            >
              <div
                className={styles.iconCircle}
                style={{ background: `${app.color}22`, borderColor: `${app.color}44` }}
              >
                <app.IconComp size={24} color={app.color} />
              </div>
              <span className={styles.iconLabel}>{app.displayName}</span>
            </button>
          ))}
        </div>
      </div>

      {/* App windows */}
      {windows.map((win) => (
        <AppWindow key={win.appId} win={win} />
      ))}

      {/* Chat Panel — always mounted to preserve chat history */}
      <ChatPanel
        onClose={() => setChatOpen(false)}
        visible={chatOpen}
        zIndex={chatZIndex}
        onFocus={() => setChatZIndex(claimZIndex())}
        compact={showVideo}
      />

      {/* Upload Modal */}
      {uploadOpen && (
        <div className={styles.uploadOverlay} onClick={() => setUploadOpen(false)}>
          <div className={styles.uploadModal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.uploadHeader}>
              <span>Upload File</span>
              <button className={styles.uploadClose} onClick={() => setUploadOpen(false)}>
                <X size={16} />
              </button>
            </div>
            {uploadedFile ? (
              <div className={styles.uploadedFileCenter}>
                {uploadedFile.name.endsWith('.zip') ? (
                  <FileArchive size={36} />
                ) : (
                  <FileImage size={36} />
                )}
                <span className={styles.uploadFileName}>{uploadedFile.name}</span>
                <button
                  className={styles.uploadRemoveBtn}
                  onClick={handleRemoveFile}
                  title="Remove"
                >
                  <X size={14} />
                </button>
              </div>
            ) : (
              <div className={styles.uploadDropZone} onClick={() => fileInputRef.current?.click()}>
                <Upload size={32} />
                <p>Click to select a file</p>
                <p className={styles.uploadHint}>PNG image or ZIP archive</p>
              </div>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept=".png,.zip"
              onChange={handleFileChange}
              style={{ display: 'none' }}
            />
            {extractResult?.status === 'error' && (
              <p className={styles.uploadError}>{extractResult.message}</p>
            )}
            <button
              className={`${styles.uploadSubmitBtn} ${uploadedFile ? styles.active : ''}`}
              disabled={!uploadedFile || extracting}
              onClick={handleUploadSubmit}
            >
              {extracting ? 'Parsing...' : 'Confirm'}
            </button>
          </div>
        </div>
      )}

      {/* Mod generating overlay */}
      {modGenerating && (
        <div className={styles.uploadOverlay}>
          <div className={styles.analyzingCard}>
            <div className={styles.analyzingSpinner} />
            <span>Generating mod...</span>
          </div>
        </div>
      )}

      {/* Mod generation error toast */}
      {modGenError && !modGenerating && (
        <div className={styles.uploadOverlay} onClick={() => setModGenError(null)}>
          <div className={styles.uploadModal} onClick={(e) => e.stopPropagation()}>
            <p className={styles.uploadError}>{modGenError}</p>
            <button
              className={`${styles.uploadSubmitBtn} ${styles.active}`}
              onClick={() => setModGenError(null)}
            >
              OK
            </button>
          </div>
        </div>
      )}

      {kiraNotices.length > 0 && (
        <div
          className={`${styles.kiraToastStack} ${
            chatDockSide === 'left' ? styles.dockRight : styles.dockLeft
          }`}
        >
          {kiraNotices.map((notice) => (
            <div
              key={notice.localId}
              className={`${styles.kiraToast} ${
                notice.type === 'needs_attention' ? styles.kiraToastAlert : styles.kiraToastInfo
              }`}
              onClick={() => void handleOpenKiraNotice(notice)}
              role="button"
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  void handleOpenKiraNotice(notice);
                }
              }}
            >
              <div className={styles.kiraToastMeta}>
                <span className={styles.kiraToastApp}>Kira</span>
                <span className={styles.kiraToastType}>
                  {notice.type === 'needs_attention'
                    ? 'Needs attention'
                    : notice.type === 'completed'
                      ? 'Completed'
                      : 'In progress'}
                </span>
              </div>
              <strong className={styles.kiraToastTitle}>{notice.title}</strong>
              <p className={styles.kiraToastMessage}>{notice.message}</p>
              {notice.projectName && (
                <span className={styles.kiraToastProject}>{notice.projectName}</span>
              )}
              <button
                className={styles.kiraToastClose}
                onClick={(event) => {
                  event.stopPropagation();
                  dismissKiraNotice(notice.localId);
                }}
                title="Dismiss"
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Floating add button */}
      <button
        className={`${styles.addBtn} ${
          chatDockSide === 'left' ? styles.dockRight : styles.dockLeft
        }`}
        onClick={() => setUploadOpen(true)}
        title="Upload files"
        data-testid="upload-toggle"
      >
        <Plus size={20} />
      </button>

      <div
        className={`${styles.bottomBar} ${
          chatDockSide === 'left' ? styles.dockRight : styles.dockLeft
        }`}
      >
        <button
          className={`${styles.barBtn} ${liveWallpaper ? styles.liveOn : styles.liveOff}`}
          onClick={() => setLiveWallpaper((prev) => !prev)}
          title={liveWallpaper ? 'Live wallpaper: ON' : 'Live wallpaper: OFF'}
          data-testid="wallpaper-toggle"
        >
          {liveWallpaper ? <Video size={16} /> : <VideoOff size={16} />}
        </button>

        <button
          className={`${styles.barBtn} ${reportEnabled ? styles.reportOn : styles.reportOff}`}
          onClick={handleToggleReport}
          title={reportEnabled ? 'User action reporting: ON' : 'User action reporting: OFF'}
          data-testid="report-toggle"
        >
          <Radio size={16} />
        </button>

        <button
          className={`${styles.barBtn} ${styles.chatBtn}`}
          onClick={() => {
            setChatOpen((prev) => {
              const next = !prev;
              if (next) {
                setKiraUnreadCount(0);
              }
              return next;
            });
          }}
          title="Toggle Chat"
          data-testid="chat-toggle"
        >
          <MessageCircle size={18} />
          {kiraUnreadCount > 0 && (
            <span className={styles.kiraUnreadBadge}>
              {kiraUnreadCount > 9 ? '9+' : kiraUnreadCount}
            </span>
          )}
        </button>
      </div>
    </div>
  );
};

export default Shell;
