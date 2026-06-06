import React, { useCallback, useEffect, useState } from 'react';
import { AppLifecycle, initVibeApp } from '@gui/vibe-container';
import { ExternalLink, RefreshCw } from 'lucide-react';
import {
  reportAction,
  reportLifecycle,
  useAgentActionListener,
  type CharacterAppAction,
} from '@/lib';
import styles from './index.module.scss';

const APP_ID = 22;
const FRAME_SRC = '/dewdrop-canvas/';
const STATUS_ENDPOINT = '/api/dewdrop-canvas/status';

interface DewdropStatus {
  ok: boolean;
  sourceRoot?: string;
  staticBase?: string;
  apiBase?: string;
  dataDirectory?: string;
}

const DewdropCanvas: React.FC = () => {
  const [frameKey, setFrameKey] = useState(0);
  const [frameLoaded, setFrameLoaded] = useState(false);
  const [status, setStatus] = useState<DewdropStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  const refreshStatus = useCallback(async (): Promise<DewdropStatus | null> => {
    try {
      const response = await fetch(`${STATUS_ENDPOINT}?_t=${Date.now()}`);
      if (!response.ok) {
        throw new Error(`status ${response.status}`);
      }
      const nextStatus = (await response.json()) as DewdropStatus;
      setStatus(nextStatus);
      setStatusError(null);
      return nextStatus;
    } catch (error) {
      setStatus(null);
      setStatusError(error instanceof Error ? error.message : String(error));
      return null;
    }
  }, []);

  const reloadFrame = useCallback(() => {
    setFrameLoaded(false);
    setFrameKey((value) => value + 1);
    reportAction(APP_ID, 'REFRESH_DEWDROP_CANVAS', {});
    void refreshStatus();
  }, [refreshStatus]);

  const openExternal = useCallback(() => {
    window.open(FRAME_SRC, '_blank', 'noopener,noreferrer');
    reportAction(APP_ID, 'OPEN_DEWDROP_CANVAS_EXTERNAL', {});
  }, []);

  const handleAgentAction = useCallback(
    async (action: CharacterAppAction): Promise<string> => {
      switch (action.action_type) {
        case 'REFRESH_DEWDROP_CANVAS': {
          reloadFrame();
          return 'success';
        }
        case 'OPEN_DEWDROP_CANVAS_EXTERNAL': {
          openExternal();
          return 'success';
        }
        case 'CHECK_DEWDROP_CANVAS_STATUS': {
          const nextStatus = await refreshStatus();
          return JSON.stringify(nextStatus ?? { ok: false, error: statusError });
        }
        default:
          return `error: unknown action_type ${action.action_type}`;
      }
    },
    [openExternal, refreshStatus, reloadFrame, statusError],
  );

  useAgentActionListener(APP_ID, handleAgentAction);

  useEffect(() => {
    const init = async () => {
      try {
        reportLifecycle(AppLifecycle.LOADING);
        const manager = await initVibeApp({
          id: APP_ID,
          url: window.location.href,
          type: 'page',
          name: 'Dewdrop Canvas',
        });
        reportLifecycle(AppLifecycle.DOM_READY);
        await refreshStatus();
        reportLifecycle(AppLifecycle.LOADED);
        manager.ready();
      } catch (error) {
        reportLifecycle(AppLifecycle.ERROR, String(error));
      }
    };

    void init();

    return () => {
      reportLifecycle(AppLifecycle.UNLOADING);
      reportLifecycle(AppLifecycle.DESTROYED);
    };
  }, [refreshStatus]);

  const unavailable = Boolean(status && !status.ok);

  return (
    <main className={styles.dewdropCanvas} data-testid="dewdrop-canvas-page">
      <iframe
        key={frameKey}
        className={styles.frame}
        src={FRAME_SRC}
        title="Dewdrop Canvas"
        data-testid="dewdrop-canvas-frame"
        onLoad={() => setFrameLoaded(true)}
        allow="clipboard-read; clipboard-write"
      />

      {(!frameLoaded || unavailable || statusError) && (
        <div className={styles.statusOverlay} data-testid="dewdrop-canvas-status">
          <div className={styles.statusPanel}>
            <div className={styles.statusMark} />
            <h1>Dewdrop Canvas</h1>
            <p>
              {unavailable
                ? `Source not found: ${status?.sourceRoot ?? 'unknown'}`
                : statusError
                  ? `Service check failed: ${statusError}`
                  : 'Starting local canvas...'}
            </p>
            <div className={styles.statusActions}>
              <button type="button" onClick={reloadFrame} title="Refresh Dewdrop Canvas">
                <RefreshCw size={16} />
              </button>
              <button type="button" onClick={openExternal} title="Open in browser tab">
                <ExternalLink size={16} />
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
};

export default DewdropCanvas;
