import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChevronDown,
  ChevronRight,
  FileCode2,
  FilePlus2,
  FolderClosed,
  FolderOpen,
  RefreshCw,
  Save,
  Settings2,
  X,
} from 'lucide-react';
import { initVibeApp, AppLifecycle } from '@gui/vibe-container';
import {
  useAgentActionListener,
  reportLifecycle,
  fetchVibeInfo,
  type CharacterAppAction,
} from '@/lib';
import { loadPersistedConfig, savePersistedConfig } from '@/lib/configPersistence';
import { highlightContentByFilePath, renderHighlightedHtml } from '@/lib/simpleSyntaxHighlight';
import './i18n';
import styles from './index.module.scss';

const APP_ID = 19;
const DEFAULT_WINDOW_STYLE = { width: 1360, height: 820 };

interface WorkspaceEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size: number;
  modifiedAt: number;
}

interface WorkspaceResponse {
  rootPath: string;
  exists: boolean;
}

interface DirectoryResponse {
  path: string;
  entries: WorkspaceEntry[];
}

interface FileResponse {
  path: string;
  content: string;
}

function normalizeEditorContent(content: string): string {
  return content.replace(/\r\n/g, '\n');
}

function countLines(content: string): number {
  return content === '' ? 1 : content.split(/\r?\n/).length;
}

function getFileExtensionLabel(filePath: string | null): string {
  if (!filePath) return 'TXT';
  const fileName = filePath.split('/').pop() || filePath;
  const dotIndex = fileName.lastIndexOf('.');
  if (dotIndex < 0 || dotIndex === fileName.length - 1) return 'TXT';
  return fileName.slice(dotIndex + 1).toUpperCase();
}

function normalizeWorkspacePathInput(value: string): string {
  return value
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/\/{2,}/g, '/');
}

function isRelativeWorkspaceFilePath(filePath: string): boolean {
  if (!filePath || filePath === '.' || filePath.endsWith('/')) return false;
  if (/^(?:[a-zA-Z]:|\/)/.test(filePath)) return false;
  if (/(^|\/)\.\.(?:\/|$)/.test(filePath)) return false;
  if (filePath.split('/').some((segment) => !segment || segment === '.')) return false;
  return true;
}

function getParentPath(filePath: string): string {
  return filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : '';
}

function getAncestorDirectoryPaths(filePath: string): string[] {
  const parentPath = getParentPath(filePath);
  if (!parentPath) return [''];
  const paths = [''];
  let current = '';
  parentPath
    .split('/')
    .filter(Boolean)
    .forEach((segment) => {
      current = current ? `${current}/${segment}` : segment;
      paths.push(current);
    });
  return paths;
}

const SimpleIdePage: React.FC = () => {
  const { t } = useTranslation('openvscode');
  const [workspaceRoot, setWorkspaceRoot] = useState('');
  const [workspaceExists, setWorkspaceExists] = useState(true);
  const [workspaceDraft, setWorkspaceDraft] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [showCreateFile, setShowCreateFile] = useState(false);
  const [newFilePath, setNewFilePath] = useState('');
  const [createFileError, setCreateFileError] = useState<string | null>(null);
  const [tree, setTree] = useState<Record<string, WorkspaceEntry[]>>({});
  const [expandedDirs, setExpandedDirs] = useState<string[]>(['']);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState('');
  const [savedContent, setSavedContent] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isTreeLoading, setIsTreeLoading] = useState(false);
  const [isFileLoading, setIsFileLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isCreatingFile, setIsCreatingFile] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [activeLine, setActiveLine] = useState(1);
  const selectedFileRef = useRef<string | null>(null);
  const isDirtyRef = useRef(false);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const highlightRef = useRef<HTMLPreElement | null>(null);
  const lineNumbersRef = useRef<HTMLDivElement | null>(null);

  const isDirty =
    selectedFile !== null &&
    normalizeEditorContent(fileContent) !== normalizeEditorContent(savedContent);

  useEffect(() => {
    selectedFileRef.current = selectedFile;
    isDirtyRef.current = isDirty;
  }, [isDirty, selectedFile]);

  const fetchWorkspaceInfo = useCallback(async (): Promise<WorkspaceResponse> => {
    const res = await fetch('/api/openvscode/workspace');
    const data = (await res.json()) as WorkspaceResponse & { error?: string };
    if (!res.ok) {
      throw new Error(data.error || `Workspace API error ${res.status}`);
    }
    return data;
  }, []);

  const loadDirectory = useCallback(async (path = ''): Promise<WorkspaceEntry[]> => {
    const res = await fetch(`/api/openvscode/list?path=${encodeURIComponent(path)}`);
    const data = (await res.json()) as DirectoryResponse & { error?: string };
    if (!res.ok) {
      throw new Error(data.error || `Directory API error ${res.status}`);
    }
    setTree((prev) => ({ ...prev, [path]: data.entries }));
    return data.entries;
  }, []);

  const loadFile = useCallback(async (path: string) => {
    setIsFileLoading(true);
    try {
      const res = await fetch(`/api/openvscode/file?path=${encodeURIComponent(path)}`);
      const data = (await res.json()) as FileResponse & { error?: string };
      if (!res.ok) {
        throw new Error(data.error || `File API error ${res.status}`);
      }
      const normalizedContent = normalizeEditorContent(data.content);
      setSelectedFile(data.path);
      setFileContent(normalizedContent);
      setSavedContent(normalizedContent);
      setActiveLine(1);
      setErrorText(null);
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : String(error));
    } finally {
      setIsFileLoading(false);
    }
  }, []);

  const refreshWorkspace = useCallback(async () => {
    setIsTreeLoading(true);
    try {
      const info = await fetchWorkspaceInfo();
      setWorkspaceRoot(info.rootPath);
      setWorkspaceExists(info.exists);
      setWorkspaceDraft((prev) => prev || info.rootPath);
      if (!info.exists) {
        setTree({});
        setSelectedFile(null);
        setFileContent('');
        setSavedContent('');
        setActiveLine(1);
        return;
      }
      const rootEntries = await loadDirectory('');
      if (!selectedFileRef.current) {
        const preferred = rootEntries.find(
          (entry) => entry.type === 'file' && /^(README|package)\./i.test(entry.name),
        );
        if (preferred) {
          await loadFile(preferred.path);
        }
      } else if (!isDirtyRef.current) {
        await loadFile(selectedFileRef.current);
      }
      setErrorText(null);
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : String(error));
    } finally {
      setIsTreeLoading(false);
    }
  }, [fetchWorkspaceInfo, loadDirectory, loadFile]);

  const toggleDirectory = useCallback(
    async (path: string) => {
      const isExpanded = expandedDirs.includes(path);
      if (isExpanded) {
        setExpandedDirs((prev) => prev.filter((item) => item !== path));
        return;
      }
      if (!tree[path]) {
        try {
          await loadDirectory(path);
        } catch (error) {
          setErrorText(error instanceof Error ? error.message : String(error));
          return;
        }
      }
      setExpandedDirs((prev) => [...prev, path]);
    },
    [expandedDirs, loadDirectory, tree],
  );

  const openFile = useCallback(
    async (path: string) => {
      if (isDirty) {
        // eslint-disable-next-line no-alert
        const shouldDiscard = window.confirm(t('editor.discardConfirm'));
        if (!shouldDiscard) return;
      }
      await loadFile(path);
    },
    [isDirty, loadFile, t],
  );

  const saveCurrentFile = useCallback(async () => {
    if (!selectedFile) return;
    setIsSaving(true);
    try {
      const res = await fetch('/api/openvscode/file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: selectedFile, content: normalizeEditorContent(fileContent) }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        throw new Error(data.error || `Save API error ${res.status}`);
      }
      setSavedContent(normalizeEditorContent(fileContent));
      setErrorText(null);
      const parentPath = selectedFile.includes('/')
        ? selectedFile.slice(0, selectedFile.lastIndexOf('/'))
        : '';
      if (tree[parentPath]) {
        await loadDirectory(parentPath);
      }
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSaving(false);
    }
  }, [fileContent, loadDirectory, selectedFile, tree]);

  const createNewFile = useCallback(
    async (requestedPath: string): Promise<{ ok: boolean; error?: string }> => {
      const normalizedPath = normalizeWorkspacePathInput(requestedPath);
      if (!isRelativeWorkspaceFilePath(normalizedPath)) {
        const message = t('errors.invalidFilePath');
        setCreateFileError(message);
        return { ok: false, error: message };
      }

      if (isDirty && selectedFile !== normalizedPath) {
        // eslint-disable-next-line no-alert
        const shouldDiscard = window.confirm(t('editor.discardConfirm'));
        if (!shouldDiscard) return { ok: false, error: 'cancelled' };
      }

      setIsCreatingFile(true);
      setCreateFileError(null);
      try {
        const res = await fetch('/api/openvscode/file', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: normalizedPath, content: '', overwrite: false }),
        });
        const data = (await res.json()) as { error?: string };
        if (!res.ok) {
          throw new Error(data.error || `Create file API error ${res.status}`);
        }

        const ancestorDirectories = getAncestorDirectoryPaths(normalizedPath);
        setExpandedDirs((prev) => Array.from(new Set([...prev, ...ancestorDirectories])));
        for (const directoryPath of ancestorDirectories) {
          await loadDirectory(directoryPath);
        }

        setShowCreateFile(false);
        setNewFilePath('');
        await loadFile(normalizedPath);
        editorRef.current?.focus();
        setErrorText(null);
        setCreateFileError(null);
        return { ok: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setCreateFileError(message);
        return { ok: false, error: message };
      } finally {
        setIsCreatingFile(false);
      }
    },
    [isDirty, loadDirectory, loadFile, selectedFile, t],
  );

  const submitCreateFile = useCallback(
    (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      void createNewFile(newFilePath);
    },
    [createNewFile, newFilePath],
  );

  const saveWorkspacePath = useCallback(async () => {
    setErrorText(null);
    try {
      const nextWorkspace = workspaceDraft.trim();
      const existing = await loadPersistedConfig();
      await savePersistedConfig({
        ...(existing ?? {}),
        openvscode: {
          ...(existing?.openvscode ?? {}),
          workspacePath: nextWorkspace || undefined,
        },
      });
      setWorkspaceRoot(nextWorkspace);
      setWorkspaceDraft(nextWorkspace);
      setTree({});
      setExpandedDirs(['']);
      setSelectedFile(null);
      setFileContent('');
      setSavedContent('');
      setActiveLine(1);
      await refreshWorkspace();
      setShowSettings(false);
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : String(error));
    }
  }, [refreshWorkspace, workspaceDraft]);

  useAgentActionListener(
    APP_ID,
    useCallback(
      async (action: CharacterAppAction): Promise<string> => {
        switch (action.action_type) {
          case 'OPEN_FILE': {
            const path = action.params?.path?.trim();
            if (!path) return 'error: missing path';
            await openFile(path);
            return 'success';
          }
          case 'REFRESH_WORKSPACE': {
            await refreshWorkspace();
            return 'success';
          }
          case 'CREATE_FILE': {
            const path = action.params?.path?.trim();
            if (!path) return 'error: missing path';
            const result = await createNewFile(path);
            return result.ok ? 'success' : `error: ${result.error || 'create failed'}`;
          }
          default:
            return `error: unknown action_type ${action.action_type}`;
        }
      },
      [createNewFile, openFile, refreshWorkspace],
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
          name: "Aoi's IDE",
          windowStyle: DEFAULT_WINDOW_STYLE,
        });

        manager.handshake({
          id: APP_ID,
          url: window.location.href,
          type: 'page',
          name: "Aoi's IDE",
          windowStyle: DEFAULT_WINDOW_STYLE,
        });

        reportLifecycle(AppLifecycle.DOM_READY);
        await fetchVibeInfo().catch(() => undefined);

        const persisted = await loadPersistedConfig();
        const configuredWorkspace = persisted?.openvscode?.workspacePath?.trim() || '';
        setWorkspaceDraft(configuredWorkspace);

        await refreshWorkspace();
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
    };
  }, [refreshWorkspace]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const isSaveKey = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's';
      if (!isSaveKey) return;
      event.preventDefault();
      void saveCurrentFile();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [saveCurrentFile]);

  const renderEntries = useCallback(
    (path: string, depth = 0): React.ReactNode => {
      const entries = tree[path] ?? [];
      return entries.map((entry) => {
        const isDir = entry.type === 'directory';
        const isExpanded = expandedDirs.includes(entry.path);
        return (
          <div key={entry.path}>
            <button
              className={`${styles.treeItem} ${
                !isDir && selectedFile === entry.path ? styles.treeItemActive : ''
              }`}
              style={{ paddingLeft: `${12 + depth * 16}px` }}
              onClick={() => {
                if (isDir) {
                  void toggleDirectory(entry.path);
                } else {
                  void openFile(entry.path);
                }
              }}
            >
              <span className={styles.treeIcon}>
                {isDir ? (
                  isExpanded ? (
                    <>
                      <ChevronDown size={14} />
                      <FolderOpen size={14} />
                    </>
                  ) : (
                    <>
                      <ChevronRight size={14} />
                      <FolderClosed size={14} />
                    </>
                  )
                ) : (
                  <FileCode2 size={14} />
                )}
              </span>
              <span className={styles.treeLabel}>{entry.name}</span>
            </button>
            {isDir && isExpanded ? renderEntries(entry.path, depth + 1) : null}
          </div>
        );
      });
    },
    [expandedDirs, openFile, selectedFile, toggleDirectory, tree],
  );

  const lineCount = useMemo(() => countLines(fileContent), [fileContent]);
  const fileExtensionLabel = useMemo(() => getFileExtensionLabel(selectedFile), [selectedFile]);
  const highlightedLines = useMemo(
    () => highlightContentByFilePath(selectedFile, fileContent),
    [fileContent, selectedFile],
  );

  const syncEditorScroll = useCallback(() => {
    if (!editorRef.current || !highlightRef.current) return;
    highlightRef.current.scrollTop = editorRef.current.scrollTop;
    highlightRef.current.scrollLeft = editorRef.current.scrollLeft;
    if (lineNumbersRef.current) {
      lineNumbersRef.current.scrollTop = editorRef.current.scrollTop;
    }
  }, []);

  const updateActiveLine = useCallback(() => {
    if (!editorRef.current) return;
    const cursor = editorRef.current.selectionStart ?? 0;
    setActiveLine(fileContent.slice(0, cursor).split('\n').length);
  }, [fileContent]);

  if (isLoading) {
    return <div className={styles.loading}>{t('loading')}</div>;
  }

  return (
    <div className={styles.page}>
      <header className={styles.topbar}>
        <div className={styles.titleBlock}>
          <span className={styles.eyebrow}>{t('eyebrow')}</span>
          <strong className={styles.title}>{workspaceRoot || t('title')}</strong>
        </div>
        <div className={styles.actions}>
          <button
            className={`${styles.actionButton} ${showSettings ? styles.actionButtonActive : ''}`}
            onClick={() => setShowSettings((prev) => !prev)}
          >
            <Settings2 size={16} />
            <span>{t('actions.settings')}</span>
          </button>
          <button className={styles.actionButton} onClick={() => void refreshWorkspace()}>
            <RefreshCw size={16} />
            <span>{isTreeLoading ? t('actions.refreshing') : t('actions.refresh')}</span>
          </button>
          <button
            className={`${styles.actionButton} ${styles.primaryAction}`}
            onClick={() => void saveCurrentFile()}
            disabled={!selectedFile || !isDirty || isSaving}
          >
            <Save size={16} />
            <span>{isSaving ? t('actions.saving') : t('actions.save')}</span>
          </button>
        </div>
      </header>

      {(showSettings || !workspaceExists || errorText) && (
        <section className={styles.settingsCard}>
          <div className={styles.settingsHeader}>
            <div>
              <strong>{t('settings.title')}</strong>
              <p>{t('settings.description')}</p>
            </div>
          </div>
          <label className={styles.inputLabel}>
            <span>{t('settings.workspacePath')}</span>
            <input
              className={styles.input}
              value={workspaceDraft}
              onChange={(event) => setWorkspaceDraft(event.target.value)}
              placeholder={t('settings.workspacePlaceholder')}
            />
          </label>
          <div className={styles.settingsActions}>
            <button className={styles.primaryButton} onClick={() => void saveWorkspacePath()}>
              <Save size={16} />
              <span>{t('actions.saveWorkspace')}</span>
            </button>
          </div>
          {!workspaceExists ? (
            <p className={styles.errorText}>{t('errors.workspaceMissing')}</p>
          ) : null}
          {errorText ? <p className={styles.errorText}>{errorText}</p> : null}
        </section>
      )}

      <div className={styles.workspaceShell}>
        <aside className={styles.sidebar}>
          <div className={styles.sidebarHeader}>
            <div className={styles.sidebarHeading}>
              <span>{t('sidebar.files')}</span>
              <span className={styles.sidebarMeta}>
                {workspaceExists ? t('sidebar.ready') : t('sidebar.notReady')}
              </span>
            </div>
            <button
              type="button"
              className={`${styles.iconButton} ${showCreateFile ? styles.iconButtonActive : ''}`}
              onClick={() => {
                setShowCreateFile((prev) => !prev);
                setCreateFileError(null);
                if (showCreateFile) setNewFilePath('');
              }}
              disabled={!workspaceExists}
              title={showCreateFile ? t('actions.cancel') : t('actions.newFile')}
              aria-label={showCreateFile ? t('actions.cancel') : t('actions.newFile')}
            >
              {showCreateFile ? <X size={16} /> : <FilePlus2 size={16} />}
            </button>
          </div>
          {showCreateFile ? (
            <form className={styles.createFileForm} onSubmit={submitCreateFile}>
              <label className={styles.createFileField}>
                <span>{t('createFile.label')}</span>
                <input
                  className={styles.createFileInput}
                  value={newFilePath}
                  onChange={(event) => {
                    setNewFilePath(event.target.value);
                    setCreateFileError(null);
                  }}
                  placeholder={t('createFile.placeholder')}
                  disabled={isCreatingFile}
                  autoFocus
                />
              </label>
              {createFileError ? <p className={styles.createFileError}>{createFileError}</p> : null}
              <div className={styles.createFileActions}>
                <button
                  type="button"
                  className={styles.secondaryButton}
                  onClick={() => {
                    setShowCreateFile(false);
                    setNewFilePath('');
                    setCreateFileError(null);
                  }}
                  disabled={isCreatingFile}
                >
                  {t('actions.cancel')}
                </button>
                <button
                  type="submit"
                  className={`${styles.primaryButton} ${styles.createSubmitButton}`}
                  disabled={isCreatingFile || !newFilePath.trim()}
                >
                  <FilePlus2 size={15} />
                  <span>{isCreatingFile ? t('actions.creating') : t('actions.createFile')}</span>
                </button>
              </div>
            </form>
          ) : null}
          <div className={styles.tree}>{renderEntries('')}</div>
        </aside>

        <main className={styles.editorPane}>
          {selectedFile ? (
            <>
              <div className={styles.editorHeader}>
                <div className={styles.editorMeta}>
                  <div className={styles.filePathRow}>
                    <strong className={styles.filePath}>{selectedFile}</strong>
                    <span className={styles.fileBadge}>{fileExtensionLabel}</span>
                  </div>
                  <span className={styles.fileStats}>
                    {t('editor.stats', {
                      lines: lineCount,
                      chars: fileContent.length,
                    })}
                  </span>
                </div>
                <div className={styles.editorStatus}>
                  <span className={isDirty ? styles.statusDirty : styles.statusSaved}>
                    {isDirty ? t('editor.unsaved') : t('editor.saved')}
                  </span>
                </div>
              </div>
              {isFileLoading ? (
                <div className={styles.emptyState}>{t('editor.loading')}</div>
              ) : (
                <div className={styles.editorBody}>
                  <div ref={lineNumbersRef} className={styles.lineNumbers} aria-hidden="true">
                    {Array.from({ length: lineCount }, (_, index) => (
                      <div
                        key={`${selectedFile ?? 'file'}-line-${index + 1}`}
                        className={`${styles.lineNumber} ${
                          activeLine === index + 1 ? styles.lineNumberActive : ''
                        }`}
                      >
                        {index + 1}
                      </div>
                    ))}
                  </div>
                  <div className={styles.editorStack}>
                    <pre ref={highlightRef} className={styles.editorHighlight} aria-hidden="true">
                      <code>
                        {highlightedLines.map((line, index) => (
                          <div
                            key={`${selectedFile ?? 'file'}-${index}`}
                            className={`${styles.editorLine} ${
                              activeLine === index + 1 ? styles.editorLineActive : ''
                            }`}
                            dangerouslySetInnerHTML={{
                              __html: renderHighlightedHtml(line) || '&nbsp;',
                            }}
                          />
                        ))}
                      </code>
                    </pre>
                    <textarea
                      ref={editorRef}
                      className={styles.editor}
                      value={fileContent}
                      onChange={(event) => {
                        setFileContent(event.target.value);
                        window.requestAnimationFrame(updateActiveLine);
                      }}
                      onClick={updateActiveLine}
                      onKeyUp={updateActiveLine}
                      onSelect={updateActiveLine}
                      onScroll={syncEditorScroll}
                      spellCheck={false}
                      wrap="off"
                    />
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className={styles.emptyState}>
              <h2>{t('empty.title')}</h2>
              <p>{t('empty.description')}</p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
};

export default SimpleIdePage;
