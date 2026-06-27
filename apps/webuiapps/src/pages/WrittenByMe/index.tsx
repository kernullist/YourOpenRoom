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

const APP_ID = 23;
const FRAME_SRC = '/written-by-me/';
const STATUS_ENDPOINT = '/api/written-by-me/status';

interface WrittenByMeStatus {
  ok: boolean;
  sourceRoot?: string;
  staticBase?: string;
  apiBase?: string;
  aoiMainLlm?: {
    configured?: boolean;
    provider?: string;
    model?: string;
    apiKeyConfigured?: boolean;
  };
}

const WrittenByMe: React.FC = () => {
  const [frameKey, setFrameKey] = useState(0);
  const [frameLoaded, setFrameLoaded] = useState(false);
  const [status, setStatus] = useState<WrittenByMeStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  const refreshStatus = useCallback(async (): Promise<WrittenByMeStatus | null> => {
    try {
      const response = await fetch(`${STATUS_ENDPOINT}?_t=${Date.now()}`);
      if (!response.ok) {
        throw new Error(`status ${response.status}`);
      }
      const nextStatus = (await response.json()) as WrittenByMeStatus;
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
    reportAction(APP_ID, 'REFRESH_WRITTEN_BY_ME', {});
    void refreshStatus();
  }, [refreshStatus]);

  const openExternal = useCallback(() => {
    window.open(FRAME_SRC, '_blank', 'noopener,noreferrer');
    reportAction(APP_ID, 'OPEN_WRITTEN_BY_ME_EXTERNAL', {});
  }, []);

  const handleAgentAction = useCallback(
    async (action: CharacterAppAction): Promise<string> => {
      switch (action.action_type) {
        case 'REFRESH_WRITTEN_BY_ME': {
          reloadFrame();
          return 'success';
        }
        case 'OPEN_WRITTEN_BY_ME_EXTERNAL': {
          openExternal();
          return 'success';
        }
        case 'CHECK_WRITTEN_BY_ME_STATUS': {
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
          name: 'Written By Me',
          windowStyle: { width: 960, height: 640 },
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
  const initializing = !frameLoaded && !status?.ok && !statusError;

  return (
    <main className={styles.writtenByMe} data-testid="written-by-me-page">
      <iframe
        key={frameKey}
        className={styles.frame}
        src={FRAME_SRC}
        title="Written By Me"
        data-testid="written-by-me-frame"
        onLoad={() => setFrameLoaded(true)}
        allow="clipboard-read; clipboard-write"
      />

      {(initializing || unavailable || statusError) && (
        <div className={styles.statusOverlay} data-testid="written-by-me-status">
          <div className={styles.statusPanel}>
            <div className={styles.statusMark} />
            <h1>Written By Me</h1>
            <p>
              {unavailable
                ? `Source not found: ${status?.sourceRoot ?? 'unknown'}`
                : statusError
                  ? `Service check failed: ${statusError}`
                  : 'Starting style analyzer...'}
            </p>
            <div className={styles.statusActions}>
              <button type="button" onClick={reloadFrame} title="Refresh Written By Me">
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

export default WrittenByMe;
