import React, { useRef, useCallback, lazy, memo, Suspense } from 'react';
import { Maximize2, Minimize2, Minus, X } from 'lucide-react';
import {
  type WindowState,
  closeWindow,
  focusWindow,
  getMaximizedWindowBounds,
  minimizeWindow,
  moveWindow,
  resizeWindow,
  toggleMaximizeWindow,
} from '@/lib/windowManager';
import { getSourceDirToAppId } from '@/lib/appRegistry';
import { reportUserOsAction } from '@/lib/vibeContainerMock';
import styles from './index.module.scss';

/** Auto-discover all App pages via import.meta.glob, build appId to lazy component mapping */
const pageModules = import.meta.glob('../../pages/*/index.tsx') as Record<
  string,
  () => Promise<{ default: React.ComponentType }>
>;
const dirToAppId = getSourceDirToAppId();
const APP_COMPONENTS: Record<number, React.LazyExoticComponent<React.ComponentType>> = {};
for (const [path, loader] of Object.entries(pageModules)) {
  const dirMatch = path.match(/\/pages\/([^/]+)\//);
  if (!dirMatch) continue;
  const appId = dirToAppId[dirMatch[1]];
  if (appId) APP_COMPONENTS[appId] = lazy(loader);
}

interface Props {
  win: WindowState;
}

const WindowContent = memo(({ appId }: { appId: number }) => {
  const AppComp = APP_COMPONENTS[appId];
  if (!AppComp) return null;

  return (
    <Suspense fallback={<div className={styles.loading}>Loading...</div>}>
      <AppComp />
    </Suspense>
  );
});

WindowContent.displayName = 'WindowContent';

const AppWindow: React.FC<Props> = ({ win }) => {
  const dragRef = useRef<{ startX: number; startY: number; winX: number; winY: number } | null>(
    null,
  );
  const resizeRef = useRef<{ startX: number; startY: number; winW: number; winH: number } | null>(
    null,
  );
  const dragFrameRef = useRef<number | null>(null);
  const pendingMoveRef = useRef<{ x: number; y: number } | null>(null);
  const resizeFrameRef = useRef<number | null>(null);
  const pendingResizeRef = useRef<{ width: number; height: number } | null>(null);

  const handleResizeMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (win.maximized) return;
      e.stopPropagation();
      e.preventDefault();
      focusWindow(win.appId);
      resizeRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        winW: win.width,
        winH: win.height,
      };

      const handleMouseMove = (ev: MouseEvent) => {
        if (!resizeRef.current) return;
        const dx = ev.clientX - resizeRef.current.startX;
        const dy = ev.clientY - resizeRef.current.startY;
        pendingResizeRef.current = {
          width: resizeRef.current.winW + dx,
          height: resizeRef.current.winH + dy,
        };

        if (resizeFrameRef.current !== null) return;
        resizeFrameRef.current = requestAnimationFrame(() => {
          resizeFrameRef.current = null;
          const pendingResize = pendingResizeRef.current;
          if (pendingResize) resizeWindow(win.appId, pendingResize.width, pendingResize.height);
        });
      };

      const handleMouseUp = () => {
        if (resizeFrameRef.current !== null) {
          cancelAnimationFrame(resizeFrameRef.current);
          resizeFrameRef.current = null;
        }
        const pendingResize = pendingResizeRef.current;
        if (pendingResize) resizeWindow(win.appId, pendingResize.width, pendingResize.height);
        pendingResizeRef.current = null;
        resizeRef.current = null;
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };

      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    },
    [win.appId, win.width, win.height, win.maximized],
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (win.maximized) {
        focusWindow(win.appId);
        return;
      }

      focusWindow(win.appId);
      dragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        winX: win.x,
        winY: win.y,
      };

      const handleMouseMove = (ev: MouseEvent) => {
        if (!dragRef.current) return;
        const dx = ev.clientX - dragRef.current.startX;
        const dy = ev.clientY - dragRef.current.startY;
        pendingMoveRef.current = {
          x: dragRef.current.winX + dx,
          y: dragRef.current.winY + dy,
        };

        if (dragFrameRef.current !== null) return;
        dragFrameRef.current = requestAnimationFrame(() => {
          dragFrameRef.current = null;
          const pendingMove = pendingMoveRef.current;
          if (pendingMove) moveWindow(win.appId, pendingMove.x, pendingMove.y);
        });
      };

      const handleMouseUp = () => {
        if (dragFrameRef.current !== null) {
          cancelAnimationFrame(dragFrameRef.current);
          dragFrameRef.current = null;
        }
        const pendingMove = pendingMoveRef.current;
        if (pendingMove) moveWindow(win.appId, pendingMove.x, pendingMove.y);
        pendingMoveRef.current = null;
        dragRef.current = null;
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };

      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    },
    [win.appId, win.x, win.y, win.maximized],
  );

  return (
    <div
      className={`${styles.window} ${win.minimized ? styles.minimized : ''} ${
        win.maximized ? styles.maximized : ''
      }`}
      data-testid={`app-window-${win.appId}`}
      data-window-maximized={win.maximized ? 'true' : 'false'}
      data-window-minimized={win.minimized ? 'true' : 'false'}
      style={{
        transform: `translate3d(${win.x}px, ${win.y}px, 0)`,
        width: win.width,
        height: win.height,
        zIndex: win.zIndex,
      }}
      onMouseDown={() => focusWindow(win.appId)}
    >
      <div className={styles.titleBar} onMouseDown={handleMouseDown}>
        <span className={styles.title}>{win.title}</span>
        <div className={styles.actions}>
          <button
            className={styles.actionBtn}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => minimizeWindow(win.appId)}
            title="Minimize"
            data-testid={`window-minimize-${win.appId}`}
          >
            <Minus size={12} />
          </button>
          <button
            className={styles.actionBtn}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => toggleMaximizeWindow(win.appId, getMaximizedWindowBounds())}
            title={win.maximized ? 'Restore' : 'Maximize'}
            data-testid={`window-maximize-${win.appId}`}
          >
            {win.maximized ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
          </button>
          <button
            className={`${styles.actionBtn} ${styles.closeBtn}`}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => {
              closeWindow(win.appId);
              reportUserOsAction('CLOSE_APP', { app_id: String(win.appId) });
            }}
            title="Close"
            data-testid={`window-close-${win.appId}`}
          >
            <X size={12} />
          </button>
        </div>
      </div>
      <div className={styles.content}>
        <div className={styles.contentInner}>
          <WindowContent appId={win.appId} />
        </div>
      </div>
      <div className={styles.resizeHandle} onMouseDown={handleResizeMouseDown} />
    </div>
  );
};

export default AppWindow;
