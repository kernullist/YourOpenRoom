import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useTranslation } from 'react-i18next';
import { initVibeApp, AppLifecycle } from '@gui/vibe-container';
import {
  Bold,
  CheckCircle2,
  Clock3,
  Code2,
  Eye,
  FileText,
  Hash,
  Heading1,
  Italic,
  List,
  ListChecks,
  PencilLine,
  Pin,
  PinOff,
  Plus,
  Save,
  Search,
  Tags,
  Trash2,
} from 'lucide-react';
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

type CollectionFilter = 'all' | 'pinned';
type SortMode = 'updated' | 'created' | 'title';

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

const SORT_OPTIONS: Array<{ mode: SortMode; labelKey: string }> = [
  { mode: 'updated', labelKey: 'sortUpdated' },
  { mode: 'created', labelKey: 'sortCreated' },
  { mode: 'title', labelKey: 'sortTitle' },
];

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

function getLocale(language: string): string {
  return language === 'zh' ? 'zh-CN' : language === 'ko' ? 'ko-KR' : 'en-US';
}

function formatUpdatedAt(timestamp: number, language: string): string {
  return new Intl.DateTimeFormat(getLocale(language), {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(timestamp);
}

function formatFullDate(timestamp: number, language: string): string {
  return new Intl.DateTimeFormat(getLocale(language), {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(timestamp);
}

function stripMarkdown(content: string): string {
  return content
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#>*`~_\-[\]()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildExcerpt(content: string): string {
  const plain = stripMarkdown(content);
  return plain.length > 120 ? `${plain.slice(0, 120)}...` : plain;
}

function getWordCount(content: string): number {
  const plain = stripMarkdown(content);
  if (!plain) return 0;

  const cjkCharacters =
    plain.match(/[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/g) ?? [];
  const latinWords = plain
    .replace(/[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  return cjkCharacters.length + latinWords.length;
}

function getReadingMinutes(wordCount: number): number {
  if (wordCount === 0) return 0;
  return Math.max(1, Math.ceil(wordCount / 220));
}

function sortNotes(notes: NoteItem[], sortMode: SortMode): NoteItem[] {
  return [...notes].sort((a, b) => {
    if (sortMode === 'title') {
      return (a.title || '').localeCompare(b.title || '');
    }
    if (sortMode === 'created') {
      return b.createdAt - a.createdAt;
    }
    return b.updatedAt - a.updatedAt;
  });
}

const NotesPage: React.FC = () => {
  const { t, i18n } = useTranslation('notes');
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [notes, setNotes] = useState<NoteItem[]>([]);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [previewMode, setPreviewMode] = useState(false);
  const [collectionFilter, setCollectionFilter] = useState<CollectionFilter>('all');
  const [sortMode, setSortMode] = useState<SortMode>('updated');
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

  const tagSummaries = useMemo(() => {
    const counts = new Map<string, number>();
    notes.forEach((note) => {
      note.tags.forEach((tag) => counts.set(tag, (counts.get(tag) ?? 0) + 1));
    });

    return Array.from(counts, ([tag, count]) => ({ tag, count })).sort((a, b) =>
      a.tag.localeCompare(b.tag),
    );
  }, [notes]);

  const filteredNotes = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const nextNotes = notes.filter((note) => {
      const matchesCollection = collectionFilter === 'pinned' ? note.pinned : true;
      const matchesTag = activeTag ? note.tags.includes(activeTag) : true;
      const haystack = `${note.title}\n${note.content}\n${note.tags.join(' ')}`.toLowerCase();
      const matchesQuery = query ? haystack.includes(query) : true;
      return matchesCollection && matchesTag && matchesQuery;
    });

    return sortNotes(nextNotes, sortMode);
  }, [activeTag, collectionFilter, notes, searchQuery, sortMode]);

  const pinnedNotes = filteredNotes.filter((note) => note.pinned);
  const regularNotes = filteredNotes.filter((note) => !note.pinned);
  const bodyNotes = collectionFilter === 'pinned' ? pinnedNotes : regularNotes;
  const showPinnedSection = collectionFilter !== 'pinned' && pinnedNotes.length > 0;
  const pinnedCount = notes.filter((note) => note.pinned).length;
  const shouldShowListSection =
    bodyNotes.length > 0 || filteredNotes.length === 0 || collectionFilter === 'pinned';

  const formWordCount = useMemo(() => getWordCount(form.content), [form.content]);
  const formReadingMinutes = getReadingMinutes(formWordCount);
  const parsedFormTags = useMemo(() => parseTagsInput(form.tagsInput), [form.tagsInput]);
  const isDraftStarted = Boolean(
    form.title.trim() || form.content.trim() || form.tagsInput.trim() || form.pinned,
  );
  const isDirty = useMemo(() => {
    if (!selectedNote) return isDraftStarted;

    return (
      selectedNote.title !== form.title.trim() ||
      selectedNote.content !== form.content ||
      selectedNote.pinned !== form.pinned ||
      selectedNote.tags.join('\u0000') !== parsedFormTags.join('\u0000')
    );
  }, [form.content, form.pinned, form.title, isDraftStarted, parsedFormTags, selectedNote]);
  const canSave = Boolean(form.title.trim() || form.content.trim());
  const listTitle = activeTag
    ? `#${activeTag}`
    : collectionFilter === 'pinned'
      ? t('pinnedStrip')
      : t('workspaceTitle');
  const statusLabel =
    !selectedNote && !isDraftStarted ? t('ready') : isDirty ? t('unsaved') : t('saved');

  const resetForm = useCallback(() => {
    setSelectedNoteId(null);
    setPreviewMode(false);
    setErrorText(null);
    setForm(DEFAULT_FORM);
  }, []);

  const handleSelectNote = useCallback((noteId: string) => {
    setSelectedNoteId(noteId);
    setErrorText(null);
    reportAction(APP_ID, 'SELECT_NOTE', { noteId });
  }, []);

  const handleSave = useCallback(async () => {
    const title = form.title.trim();
    const content = form.content;
    if (!title && !content.trim()) {
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
      setForm({
        id: nextNote.id,
        title: nextNote.title,
        content: nextNote.content,
        tagsInput: nextNote.tags.join(', '),
        pinned: nextNote.pinned,
      });
      reportAction(APP_ID, existing ? 'UPDATE_NOTE' : 'CREATE_NOTE', {
        filePath,
        focusId: noteId,
      });
    } catch (error) {
      console.error('[Notes] Save failed:', error);
      setErrorText(error instanceof Error ? error.message : String(error));
    }
  }, [form, notes, saveFile, syncToCloud, t]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void handleSave();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleSave]);

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

  const handleTogglePinned = useCallback(() => {
    setForm((prev) => ({ ...prev, pinned: !prev.pinned }));
  }, []);

  const handleSelectCollection = useCallback((nextFilter: CollectionFilter) => {
    setCollectionFilter(nextFilter);
    setActiveTag(null);
  }, []);

  const handleSelectTag = useCallback((tag: string | null) => {
    setCollectionFilter('all');
    setActiveTag(tag);
  }, []);

  const insertMarkdown = useCallback(
    (prefix: string, suffix = '', fallback?: string) => {
      setPreviewMode(false);
      setForm((prev) => {
        const value = prev.content;
        const textarea = textareaRef.current;
        const start = textarea?.selectionStart ?? value.length;
        const end = textarea?.selectionEnd ?? value.length;
        const selectedText = value.slice(start, end);
        const insertion = selectedText || fallback || t('formatPlaceholder');
        const nextContent = `${value.slice(0, start)}${prefix}${insertion}${suffix}${value.slice(end)}`;
        const selectionStart = start + prefix.length;
        const selectionEnd = selectionStart + insertion.length;

        window.requestAnimationFrame(() => {
          const nextTextarea = textareaRef.current;
          nextTextarea?.focus();
          nextTextarea?.setSelectionRange(selectionStart, selectionEnd);
        });

        return { ...prev, content: nextContent };
      });
    },
    [t],
  );

  const formatActions = [
    {
      label: t('formatHeading'),
      icon: <Heading1 size={16} />,
      action: () => insertMarkdown('# ', '', t('formatHeadingPlaceholder')),
    },
    {
      label: t('formatBold'),
      icon: <Bold size={16} />,
      action: () => insertMarkdown('**', '**', t('formatTextPlaceholder')),
    },
    {
      label: t('formatItalic'),
      icon: <Italic size={16} />,
      action: () => insertMarkdown('*', '*', t('formatTextPlaceholder')),
    },
    {
      label: t('formatBullet'),
      icon: <List size={16} />,
      action: () => insertMarkdown('\n- ', '', t('formatListPlaceholder')),
    },
    {
      label: t('formatTask'),
      icon: <ListChecks size={16} />,
      action: () => insertMarkdown('\n- [ ] ', '', t('formatTaskPlaceholder')),
    },
    {
      label: t('formatCode'),
      icon: <Code2 size={16} />,
      action: () => insertMarkdown('```\n', '\n```', t('formatCodePlaceholder')),
    },
  ];

  const renderNoteRow = (note: NoteItem) => {
    const excerpt = buildExcerpt(note.content);
    const wordCount = getWordCount(note.content);
    const isActive = selectedNoteId === note.id;

    return (
      <button
        key={note.id}
        type="button"
        className={`${styles.noteRow} ${isActive ? styles.noteRowActive : ''}`}
        onClick={() => handleSelectNote(note.id)}
      >
        <span className={styles.noteRowTop}>
          <span className={styles.noteGlyph}>
            {note.pinned ? <Pin size={15} /> : <FileText size={15} />}
          </span>
          <span className={styles.noteUpdated}>
            <Clock3 size={13} />
            {formatUpdatedAt(note.updatedAt, i18n.language)}
          </span>
        </span>
        <strong className={styles.noteRowTitle}>{note.title || t('untitled')}</strong>
        <span className={styles.noteExcerpt}>{excerpt || t('emptyNote')}</span>
        <span className={styles.noteRowFooter}>
          <span className={styles.noteTags}>
            {note.tags.length > 0 ? (
              note.tags.slice(0, 3).map((tag) => <span key={tag}>#{tag}</span>)
            ) : (
              <span>{t('noTags')}</span>
            )}
          </span>
          <span className={styles.wordCount}>{wordCount}</span>
        </span>
      </button>
    );
  };

  if (isLoading) {
    return (
      <div className={styles.notesApp}>
        <div className={styles.loading}>{t('loading')}</div>
      </div>
    );
  }

  return (
    <div className={styles.notesApp}>
      <aside className={styles.navigator}>
        <div className={styles.appHeader}>
          <span className={styles.appMark}>
            <FileText size={18} />
          </span>
          <div>
            <p className={styles.kicker}>{t('kicker')}</p>
            <h1>{t('title')}</h1>
          </div>
          <button
            type="button"
            className={styles.iconButton}
            onClick={resetForm}
            title={t('newNote')}
          >
            <Plus size={18} />
          </button>
        </div>

        <label className={styles.searchBox}>
          <Search size={16} />
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t('searchPlaceholder')}
            aria-label={t('search')}
          />
        </label>

        <div className={styles.navSection}>
          <div className={styles.navHeading}>{t('library')}</div>
          <button
            type="button"
            className={`${styles.navItem} ${collectionFilter === 'all' && !activeTag ? styles.navItemActive : ''}`}
            onClick={() => handleSelectCollection('all')}
          >
            <FileText size={16} />
            <span>{t('allNotes')}</span>
            <strong>{notes.length}</strong>
          </button>
          <button
            type="button"
            className={`${styles.navItem} ${collectionFilter === 'pinned' ? styles.navItemActive : ''}`}
            onClick={() => handleSelectCollection('pinned')}
          >
            <Pin size={16} />
            <span>{t('pinned')}</span>
            <strong>{pinnedCount}</strong>
          </button>
        </div>

        <div className={styles.navSection}>
          <div className={styles.navHeading}>
            <span>{t('tags')}</span>
            {activeTag ? (
              <button type="button" onClick={() => handleSelectTag(null)}>
                {t('reset')}
              </button>
            ) : null}
          </div>
          <div className={styles.tagList}>
            {tagSummaries.length > 0 ? (
              tagSummaries.slice(0, 22).map(({ tag, count }) => (
                <button
                  key={tag}
                  type="button"
                  className={`${styles.tagItem} ${activeTag === tag ? styles.tagItemActive : ''}`}
                  onClick={() => handleSelectTag(tag)}
                >
                  <Hash size={14} />
                  <span>{tag}</span>
                  <strong>{count}</strong>
                </button>
              ))
            ) : (
              <div className={styles.navEmpty}>{t('noTags')}</div>
            )}
          </div>
        </div>

        <button type="button" className={styles.newNoteButton} onClick={resetForm}>
          <Plus size={17} />
          {t('newNote')}
        </button>
      </aside>

      <section className={styles.listPane}>
        <div className={styles.listHeader}>
          <div>
            <p className={styles.kicker}>{t('workspace')}</p>
            <h2>{listTitle}</h2>
          </div>
          <span className={styles.resultCount}>
            {filteredNotes.length} {t('results')}
          </span>
        </div>

        <div className={styles.sortBar} aria-label={t('sortBy')}>
          {SORT_OPTIONS.map((option) => (
            <button
              key={option.mode}
              type="button"
              className={sortMode === option.mode ? styles.sortActive : ''}
              onClick={() => setSortMode(option.mode)}
            >
              {t(option.labelKey)}
            </button>
          ))}
        </div>

        <div className={styles.noteListScroller}>
          {showPinnedSection ? (
            <section className={styles.noteGroup}>
              <div className={styles.groupHeader}>
                <Pin size={15} />
                <h3>{t('pinnedStrip')}</h3>
              </div>
              <div className={styles.noteList}>{pinnedNotes.map(renderNoteRow)}</div>
            </section>
          ) : null}

          {shouldShowListSection ? (
            <section className={styles.noteGroup}>
              <div className={styles.groupHeader}>
                <FileText size={15} />
                <h3>{collectionFilter === 'pinned' ? t('pinnedStrip') : t('recent')}</h3>
              </div>
              <div className={styles.noteList}>
                {bodyNotes.length > 0 ? (
                  bodyNotes.map(renderNoteRow)
                ) : (
                  <div className={styles.emptyState}>
                    <strong>{t('emptyTitle')}</strong>
                    <p>{t('emptyBody')}</p>
                    <button type="button" onClick={resetForm}>
                      <Plus size={16} />
                      {t('newNote')}
                    </button>
                  </div>
                )}
              </div>
            </section>
          ) : null}
        </div>
      </section>

      <section className={styles.editorPane}>
        <div className={styles.editorTopBar}>
          <div className={styles.editorStatus}>
            <span
              className={`${styles.statusDot} ${isDirty ? styles.statusDirty : styles.statusSaved}`}
            />
            <span>{statusLabel}</span>
          </div>
          <div className={styles.editorActions}>
            <button
              type="button"
              className={`${styles.iconButton} ${form.pinned ? styles.iconButtonActive : ''}`}
              onClick={handleTogglePinned}
              title={form.pinned ? t('unpinnedAction') : t('pinAction')}
            >
              {form.pinned ? <PinOff size={17} /> : <Pin size={17} />}
            </button>
            {selectedNote ? (
              <button
                type="button"
                className={`${styles.iconButton} ${styles.dangerButton}`}
                onClick={() => void handleDelete(selectedNote.id)}
                title={t('delete')}
              >
                <Trash2 size={17} />
              </button>
            ) : null}
            <button
              type="button"
              className={styles.saveButton}
              disabled={!canSave}
              onClick={() => void handleSave()}
            >
              <Save size={17} />
              {selectedNote ? t('saveChanges') : t('saveNote')}
            </button>
          </div>
        </div>

        <div className={styles.editorMeta}>
          <span>
            <Clock3 size={14} />
            {selectedNote ? formatFullDate(selectedNote.updatedAt, i18n.language) : t('draft')}
          </span>
          <span>
            <CheckCircle2 size={14} />
            {formWordCount} {t('words')}
          </span>
          <span>
            <FileText size={14} />
            {formReadingMinutes} {t('minutes')}
          </span>
        </div>

        <input
          className={styles.titleInput}
          value={form.title}
          onChange={(e) => setForm((prev) => ({ ...prev, title: e.target.value }))}
          placeholder={t('noteTitlePlaceholder')}
          aria-label={t('noteTitle')}
        />

        <label className={styles.tagEditor}>
          <Tags size={16} />
          <input
            value={form.tagsInput}
            onChange={(e) => setForm((prev) => ({ ...prev, tagsInput: e.target.value }))}
            placeholder={t('tagPlaceholder')}
            aria-label={t('tagInput')}
          />
        </label>

        <div className={styles.modeToolbar}>
          <div className={styles.modeSwitch}>
            <button
              type="button"
              className={!previewMode ? styles.modeActive : ''}
              onClick={() => setPreviewMode(false)}
            >
              <PencilLine size={16} />
              {t('writeMode')}
            </button>
            <button
              type="button"
              className={previewMode ? styles.modeActive : ''}
              onClick={() => setPreviewMode(true)}
            >
              <Eye size={16} />
              {t('previewMode')}
            </button>
          </div>

          {!previewMode ? (
            <div className={styles.formatToolbar} aria-label={t('markdownTools')}>
              {formatActions.map((item) => (
                <button key={item.label} type="button" onClick={item.action} title={item.label}>
                  {item.icon}
                </button>
              ))}
            </div>
          ) : null}
        </div>

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
            <textarea
              ref={textareaRef}
              className={styles.bodyInput}
              value={form.content}
              onChange={(e) => setForm((prev) => ({ ...prev, content: e.target.value }))}
              placeholder={t('bodyPlaceholder')}
              aria-label={t('body')}
            />
          )}
        </div>

        {errorText ? <div className={styles.errorBox}>{errorText}</div> : null}
      </section>
    </div>
  );
};

export default NotesPage;
