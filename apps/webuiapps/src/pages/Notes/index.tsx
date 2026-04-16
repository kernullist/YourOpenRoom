import React, { useCallback, useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useTranslation } from 'react-i18next';
import { initVibeApp, AppLifecycle } from '@gui/vibe-container';
import {
  useFileSystem,
  useAgentActionListener,
  reportAction,
  reportLifecycle,
  createAppFileApi,
  fetchVibeInfo,
  generateId,
  type CharacterAppAction,
} from '@/lib';
import './i18n';
import styles from './index.module.scss';

const APP_ID = 16;
const APP_NAME = 'notes';
const NOTES_DIR = '/notes';
const STATE_FILE = '/state.json';

const notesFileApi = createAppFileApi(APP_NAME);

interface NoteItem {
  id: string;
  title: string;
  content: string;
  tags: string[];
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
}

interface NotesState {
  selectedNoteId: string | null;
  activeTag: string | null;
  searchQuery: string;
  previewMode: boolean;
}

interface NoteFormState {
  id: string | null;
  title: string;
  content: string;
  tagsInput: string;
  pinned: boolean;
}

const DEFAULT_STATE: NotesState = {
  selectedNoteId: null,
  activeTag: null,
  searchQuery: '',
  previewMode: false,
};

const DEFAULT_FORM: NoteFormState = {
  id: null,
  title: '',
  content: '',
  tagsInput: '',
  pinned: false,
};

function getNoteFilePath(noteId: string): string {
  return `${NOTES_DIR}/${noteId}.json`;
}

function parseTagsInput(raw: string): string[] {
  return Array.from(
    new Set(
      raw
        .split(',')
        .map((tag) => tag.replace(/^#/, '').trim())
        .filter(Boolean),
    ),
  );
}

function normalizeNote(raw: unknown): NoteItem | null {
  if (!raw) return null;
  const parsed = typeof raw === 'string' ? (JSON.parse(raw) as NoteItem) : (raw as NoteItem);
  if (!parsed?.id) return null;
  return {
    title: '',
    content: '',
    tags: [],
    pinned: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...parsed,
  };
}

function formatUpdatedAt(timestamp: number, language: string): string {
  const locale = language === 'zh' ? 'zh-CN' : language === 'ko' ? 'ko-KR' : 'en-US';
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(timestamp);
}

function buildExcerpt(content: string): string {
  const plain = content.replace(/[#>*`~_\-\[\]\(\)]/g, ' ').replace(/\s+/g, ' ').trim();
  return plain.length > 120 ? `${plain.slice(0, 120)}...` : plain;
}

const NotesPage: React.FC = () => {
  const { t, i18n } = useTranslation('notes');
  const [notes, setNotes] = useState<NoteItem[]>([]);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [previewMode, setPreviewMode] = useState(false);
  const [form, setForm] = useState<NoteFormState>(DEFAULT_FORM);
  const [isLoading, setIsLoading] = useState(true);
  const [isInitialized, setIsInitialized] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  const { saveFile, syncToCloud, deleteFromCloud, initFromCloud, getChildrenByPath, getByPath } =
    useFileSystem({ fileApi: notesFileApi });

  const loadNotesFromFS = useCallback((): NoteItem[] => {
    return getChildrenByPath(NOTES_DIR)
      .filter((node) => node.type === 'file')
      .map((node) => {
        try {
          return normalizeNote(node.content);
        } catch (error) {
          console.warn('[Notes] Failed to parse note', node.path, error);
          return null;
        }
      })
      .filter((note): note is NoteItem => note !== null)
      .sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        return b.updatedAt - a.updatedAt;
      });
  }, [getChildrenByPath]);

  const saveViewState = useCallback(
    async (nextState: NotesState) => {
      saveFile(STATE_FILE, nextState);
      await syncToCloud(STATE_FILE, nextState);
    },
    [saveFile, syncToCloud],
  );

  const refreshFromCloud = useCallback(
    async (focusId?: string | null) => {
      await initFromCloud();
      const nextNotes = loadNotesFromFS();
      const stateNode = getByPath(STATE_FILE);
      const persisted = (stateNode?.content as NotesState | undefined) ?? DEFAULT_STATE;

      setNotes(nextNotes);
      setSelectedNoteId(focusId ?? persisted.selectedNoteId ?? nextNotes[0]?.id ?? null);
      setActiveTag(persisted.activeTag ?? null);
      setSearchQuery(persisted.searchQuery ?? '');
      setPreviewMode(Boolean(persisted.previewMode));
    },
    [getByPath, initFromCloud, loadNotesFromFS],
  );

  const handleAgentAction = useCallback(
    async (action: CharacterAppAction): Promise<string> => {
      switch (action.action_type) {
        case 'CREATE_NOTE':
        case 'UPDATE_NOTE':
        case 'DELETE_NOTE':
        case 'REFRESH_NOTES': {
          await refreshFromCloud(action.params?.focusId ?? action.params?.noteId ?? null);
          return 'success';
        }
        default:
          return `error: unknown action_type ${action.action_type}`;
      }
    },
    [refreshFromCloud],
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
          name: 'Notes',
          windowStyle: { width: 1080, height: 680 },
        });

        manager.handshake({
          id: APP_ID,
          url: window.location.href,
          type: 'page',
          name: 'Notes',
          windowStyle: { width: 1080, height: 680 },
        });

        reportLifecycle(AppLifecycle.DOM_READY);
        await fetchVibeInfo().catch((error) => console.warn('[Notes] fetchVibeInfo failed', error));
        await refreshFromCloud();
        setIsInitialized(true);
        setIsLoading(false);
        reportLifecycle(AppLifecycle.LOADED);
        manager.ready();
      } catch (error) {
        console.error('[Notes] Init error:', error);
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
  }, [refreshFromCloud]);

  useEffect(() => {
    if (!isInitialized) return;
    void saveViewState({ selectedNoteId, activeTag, searchQuery, previewMode });
  }, [activeTag, isInitialized, previewMode, saveViewState, searchQuery, selectedNoteId]);

  const selectedNote = useMemo(
    () => notes.find((note) => note.id === selectedNoteId) ?? null,
    [notes, selectedNoteId],
  );

  useEffect(() => {
    if (!selectedNote) {
      setForm(DEFAULT_FORM);
      return;
    }
    setForm({
      id: selectedNote.id,
      title: selectedNote.title,
      content: selectedNote.content,
      tagsInput: selectedNote.tags.join(', '),
      pinned: selectedNote.pinned,
    });
  }, [selectedNote]);

  const allTags = useMemo(
    () =>
      Array.from(new Set(notes.flatMap((note) => note.tags)))
        .sort((a, b) => a.localeCompare(b))
        .slice(0, 18),
    [notes],
  );

  const filteredNotes = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return notes.filter((note) => {
      const matchesTag = activeTag ? note.tags.includes(activeTag) : true;
      const haystack = `${note.title}\n${note.content}\n${note.tags.join(' ')}`.toLowerCase();
      const matchesQuery = query ? haystack.includes(query) : true;
      return matchesTag && matchesQuery;
    });
  }, [activeTag, notes, searchQuery]);

  const pinnedNotes = filteredNotes.filter((note) => note.pinned);
  const regularNotes = filteredNotes.filter((note) => !note.pinned);

  const resetForm = useCallback(() => {
    setSelectedNoteId(null);
    setPreviewMode(false);
    setForm(DEFAULT_FORM);
  }, []);

  const handleSelectNote = useCallback(
    (noteId: string) => {
      setSelectedNoteId(noteId);
      reportAction(APP_ID, 'SELECT_NOTE', { noteId });
    },
    [],
  );

  const handleSave = useCallback(async () => {
    const title = form.title.trim();
    const content = form.content.trim();
    if (!title && !content) {
      setErrorText(t('validation'));
      return;
    }

    const now = Date.now();
    const noteId = form.id ?? generateId();
    const existing = notes.find((note) => note.id === noteId);
    const nextNote: NoteItem = {
      id: noteId,
      title: title || t('untitled'),
      content,
      tags: parseTagsInput(form.tagsInput),
      pinned: form.pinned,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    try {
      setErrorText(null);
      const filePath = getNoteFilePath(noteId);
      saveFile(filePath, nextNote);
      await syncToCloud(filePath, nextNote);
      const nextNotes = [...notes.filter((note) => note.id !== noteId), nextNote].sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        return b.updatedAt - a.updatedAt;
      });
      setNotes(nextNotes);
      setSelectedNoteId(noteId);
      reportAction(APP_ID, existing ? 'UPDATE_NOTE' : 'CREATE_NOTE', {
        filePath,
        focusId: noteId,
      });
    } catch (error) {
      console.error('[Notes] Save failed:', error);
      setErrorText(error instanceof Error ? error.message : String(error));
    }
  }, [form, notes, saveFile, syncToCloud, t]);

  const handleDelete = useCallback(
    async (noteId: string) => {
      try {
        await deleteFromCloud(getNoteFilePath(noteId));
        const nextNotes = notes.filter((note) => note.id !== noteId);
        setNotes(nextNotes);
        if (selectedNoteId === noteId) {
          setSelectedNoteId(nextNotes[0]?.id ?? null);
        }
        reportAction(APP_ID, 'DELETE_NOTE', { noteId });
      } catch (error) {
        console.error('[Notes] Delete failed:', error);
        setErrorText(error instanceof Error ? error.message : String(error));
      }
    },
    [deleteFromCloud, notes, selectedNoteId],
  );

  const handleTogglePinned = useCallback(async () => {
    if (!selectedNote && !form.id) {
      setForm((prev) => ({ ...prev, pinned: !prev.pinned }));
      return;
    }

    if (!selectedNote) return;
    const nextNote: NoteItem = {
      ...selectedNote,
      pinned: !selectedNote.pinned,
      updatedAt: Date.now(),
    };
    try {
      const filePath = getNoteFilePath(nextNote.id);
      saveFile(filePath, nextNote);
      await syncToCloud(filePath, nextNote);
      setNotes((prev) =>
        prev
          .map((note) => (note.id === nextNote.id ? nextNote : note))
          .sort((a, b) => {
            if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
            return b.updatedAt - a.updatedAt;
          }),
      );
      setForm((prev) => ({ ...prev, pinned: nextNote.pinned }));
      reportAction(APP_ID, nextNote.pinned ? 'PIN_NOTE' : 'UNPIN_NOTE', { noteId: nextNote.id });
    } catch (error) {
      console.error('[Notes] Pin toggle failed:', error);
      setErrorText(error instanceof Error ? error.message : String(error));
    }
  }, [form.id, saveFile, selectedNote, syncToCloud]);

  const renderNoteCard = (note: NoteItem) => (
    <button
      key={note.id}
      className={`${styles.noteCard} ${selectedNoteId === note.id ? styles.noteCardActive : ''}`}
      onClick={() => handleSelectNote(note.id)}
    >
      <div className={styles.noteCardHeader}>
        <div className={styles.noteMetaGroup}>
          {note.pinned ? <span className={styles.pillAccent}>{t('pinned')}</span> : null}
          <span className={styles.noteUpdated}>{formatUpdatedAt(note.updatedAt, i18n.language)}</span>
        </div>
        <strong className={styles.noteCardTitle}>{note.title || t('untitled')}</strong>
      </div>
      <p className={styles.noteExcerpt}>{buildExcerpt(note.content) || t('emptyNote')}</p>
      <div className={styles.noteTags}>
        {note.tags.length > 0 ? note.tags.slice(0, 3).map((tag) => <span key={tag}>#{tag}</span>) : <span>{t('noTags')}</span>}
      </div>
    </button>
  );

  if (isLoading) {
    return (
      <div className={styles.notesApp}>
        <div className={styles.loading}>{t('loading')}</div>
      </div>
    );
  }

  return (
    <div className={styles.notesApp}>
      <aside className={styles.sidebar}>
        <div className={styles.brandBlock}>
          <p className={styles.kicker}>{t('kicker')}</p>
          <h1>{t('title')}</h1>
          <p className={styles.brandCopy}>{t('subtitle')}</p>
        </div>

        <div className={styles.statGrid}>
          <div className={styles.statCard}>
            <span>{t('allNotes')}</span>
            <strong>{notes.length}</strong>
          </div>
          <div className={styles.statCard}>
            <span>{t('pinned')}</span>
            <strong>{notes.filter((note) => note.pinned).length}</strong>
          </div>
        </div>

        <label className={styles.searchBox}>
          <span>{t('search')}</span>
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t('searchPlaceholder')}
          />
        </label>

        <div className={styles.filterBlock}>
          <div className={styles.filterHeader}>
            <h2>{t('tags')}</h2>
            <button onClick={() => setActiveTag(null)}>{t('reset')}</button>
          </div>
          <div className={styles.tagCloud}>
            <button
              className={!activeTag ? styles.tagActive : ''}
              onClick={() => setActiveTag(null)}
            >
              {t('allTags')}
            </button>
            {allTags.map((tag) => (
              <button
                key={tag}
                className={activeTag === tag ? styles.tagActive : ''}
                onClick={() => setActiveTag(tag)}
              >
                #{tag}
              </button>
            ))}
          </div>
        </div>

        <button className={styles.createButton} onClick={resetForm}>
          {t('newNote')}
        </button>
      </aside>

      <section className={styles.canvas}>
        <div className={styles.canvasHeader}>
          <div>
            <p className={styles.kicker}>{t('workspace')}</p>
            <h2>{activeTag ? `#${activeTag}` : t('workspaceTitle')}</h2>
          </div>
          <span className={styles.resultCount}>
            {filteredNotes.length} {t('results')}
          </span>
        </div>

        {pinnedNotes.length > 0 ? (
          <div className={styles.pinRail}>
            <div className={styles.railHeader}>
              <h3>{t('pinnedStrip')}</h3>
            </div>
            <div className={styles.pinScroller}>{pinnedNotes.map(renderNoteCard)}</div>
          </div>
        ) : null}

        <div className={styles.listSection}>
          <div className={styles.railHeader}>
            <h3>{t('recent')}</h3>
          </div>
          <div className={styles.noteGrid}>
            {regularNotes.length > 0 ? (
              regularNotes.map(renderNoteCard)
            ) : (
              <div className={styles.emptyState}>
                <strong>{t('emptyTitle')}</strong>
                <p>{t('emptyBody')}</p>
              </div>
            )}
          </div>
        </div>
      </section>

      <section className={styles.editorPanel}>
        <div className={styles.editorCard}>
          <div className={styles.editorHeader}>
            <div>
              <p className={styles.kicker}>{selectedNote ? t('editing') : t('draft')}</p>
              <h2>{selectedNote ? selectedNote.title || t('untitled') : t('editorTitle')}</h2>
            </div>
            <div className={styles.editorActions}>
              <button onClick={() => setPreviewMode((prev) => !prev)}>
                {previewMode ? t('writeMode') : t('previewMode')}
              </button>
              <button onClick={() => void handleTogglePinned()}>
                {form.pinned ? t('unpinnedAction') : t('pinAction')}
              </button>
              {selectedNote ? (
                <button onClick={() => void handleDelete(selectedNote.id)}>{t('delete')}</button>
              ) : null}
            </div>
          </div>

          <label className={styles.field}>
            <span>{t('noteTitle')}</span>
            <input
              value={form.title}
              onChange={(e) => setForm((prev) => ({ ...prev, title: e.target.value }))}
              placeholder={t('noteTitlePlaceholder')}
            />
          </label>

          <label className={styles.field}>
            <span>{t('tagInput')}</span>
            <input
              value={form.tagsInput}
              onChange={(e) => setForm((prev) => ({ ...prev, tagsInput: e.target.value }))}
              placeholder={t('tagPlaceholder')}
            />
          </label>

          <div className={styles.editorSurface}>
            {previewMode ? (
              <div className={styles.previewPane}>
                {form.content.trim() ? (
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{form.content}</ReactMarkdown>
                ) : (
                  <div className={styles.previewEmpty}>{t('previewEmpty')}</div>
                )}
              </div>
            ) : (
              <label className={styles.fieldGrow}>
                <span>{t('body')}</span>
                <textarea
                  value={form.content}
                  onChange={(e) => setForm((prev) => ({ ...prev, content: e.target.value }))}
                  placeholder={t('bodyPlaceholder')}
                />
              </label>
            )}
          </div>

          {errorText ? <div className={styles.errorBox}>{errorText}</div> : null}

          <div className={styles.bottomBar}>
            <span>{t('syncHint')}</span>
            <button className={styles.saveButton} onClick={() => void handleSave()}>
              {selectedNote ? t('saveChanges') : t('saveNote')}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
};

export default NotesPage;
