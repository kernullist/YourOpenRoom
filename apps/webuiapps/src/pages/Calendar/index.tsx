import React, { useCallback, useEffect, useMemo, useState } from 'react';
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

const APP_ID = 15;
const APP_NAME = 'calendar';
const EVENTS_DIR = '/events';
const STATE_FILE = '/state.json';
const DEFAULT_REMINDER_MINUTES = 15;

const calendarFileApi = createAppFileApi(APP_NAME);

type ReminderOption = 0 | 5 | 10 | 15 | 30 | 60 | 120 | 1440;

interface CalendarEvent {
  id: string;
  title: string;
  notes: string;
  startAt: string;
  remindBeforeMinutes: ReminderOption;
  completed: boolean;
  createdAt: number;
  updatedAt: number;
  lastReminderSentAt?: number;
}

interface AppState {
  selectedEventId: string | null;
}

interface EventFormState {
  id: string | null;
  title: string;
  notes: string;
  startAt: string;
  remindBeforeMinutes: ReminderOption;
}

const DEFAULT_FORM: EventFormState = {
  id: null,
  title: '',
  notes: '',
  startAt: '',
  remindBeforeMinutes: DEFAULT_REMINDER_MINUTES,
};

const REMINDER_OPTIONS: ReminderOption[] = [0, 5, 10, 15, 30, 60, 120, 1440];

function getEventFilePath(eventId: string): string {
  return `${EVENTS_DIR}/${eventId}.json`;
}

function parseEventContent(raw: unknown): CalendarEvent | null {
  if (!raw) return null;
  const parsed = typeof raw === 'string' ? (JSON.parse(raw) as CalendarEvent) : (raw as CalendarEvent);
  if (!parsed?.id || !parsed?.title || !parsed?.startAt) return null;
  return {
    notes: '',
    remindBeforeMinutes: DEFAULT_REMINDER_MINUTES,
    completed: false,
    ...parsed,
  };
}

function formatEventTime(dateTime: string, language: string): string {
  const parsed = new Date(dateTime);
  if (Number.isNaN(parsed.getTime())) return dateTime;
  const locale = language === 'zh' ? 'zh-CN' : 'en-US';
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(parsed);
}

function toDateInputValue(value: string): string {
  if (!value) return '';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '';
  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, '0');
  const day = String(parsed.getDate()).padStart(2, '0');
  const hour = String(parsed.getHours()).padStart(2, '0');
  const minute = String(parsed.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day}T${hour}:${minute}`;
}

function getRelativeStatus(startAt: string): 'past' | 'soon' | 'upcoming' {
  const diff = new Date(startAt).getTime() - Date.now();
  if (diff < 0) return 'past';
  if (diff <= 60 * 60 * 1000) return 'soon';
  return 'upcoming';
}

const CalendarPage: React.FC = () => {
  const { t, i18n } = useTranslation('calendar');
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [form, setForm] = useState<EventFormState>(DEFAULT_FORM);
  const [isLoading, setIsLoading] = useState(true);
  const [isInitialized, setIsInitialized] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  const { saveFile, syncToCloud, deleteFromCloud, initFromCloud, getChildrenByPath, getByPath } =
    useFileSystem({ fileApi: calendarFileApi });

  const loadEventsFromFS = useCallback((): CalendarEvent[] => {
    return getChildrenByPath(EVENTS_DIR)
      .filter((node) => node.type === 'file')
      .map((node) => {
        try {
          return parseEventContent(node.content);
        } catch (error) {
          console.warn('[Calendar] Failed to parse event', node.path, error);
          return null;
        }
      })
      .filter((event): event is CalendarEvent => event !== null)
      .sort((a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime());
  }, [getChildrenByPath]);

  const saveAppState = useCallback(
    async (nextState: AppState) => {
      saveFile(STATE_FILE, nextState);
      await syncToCloud(STATE_FILE, nextState);
    },
    [saveFile, syncToCloud],
  );

  const refreshFromCloud = useCallback(
    async (focusId?: string | null) => {
      await initFromCloud();
      const nextEvents = loadEventsFromFS();
      setEvents(nextEvents);

      const stateNode = getByPath(STATE_FILE);
      const state = (stateNode?.content as AppState | undefined) ?? { selectedEventId: null };
      const preferredId = focusId ?? state.selectedEventId ?? nextEvents[0]?.id ?? null;
      setSelectedEventId(preferredId);
    },
    [getByPath, initFromCloud, loadEventsFromFS],
  );

  const handleAgentAction = useCallback(
    async (action: CharacterAppAction): Promise<string> => {
      switch (action.action_type) {
        case 'CREATE_EVENT':
        case 'UPDATE_EVENT':
        case 'DELETE_EVENT':
        case 'REFRESH_EVENTS': {
          const focusId = action.params?.focusId ?? action.params?.eventId ?? null;
          await refreshFromCloud(focusId);
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
          name: 'Calendar',
          windowStyle: { width: 860, height: 620 },
        });

        manager.handshake({
          id: APP_ID,
          url: window.location.href,
          type: 'page',
          name: 'Calendar',
          windowStyle: { width: 860, height: 620 },
        });

        reportLifecycle(AppLifecycle.DOM_READY);
        await fetchVibeInfo().catch((error) => console.warn('[Calendar] fetchVibeInfo failed', error));
        await refreshFromCloud();
        setIsInitialized(true);
        setIsLoading(false);
        reportLifecycle(AppLifecycle.LOADED);
        manager.ready();
      } catch (error) {
        console.error('[Calendar] Init error:', error);
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
    void saveAppState({ selectedEventId });
  }, [isInitialized, saveAppState, selectedEventId]);

  const selectedEvent = useMemo(
    () => events.find((event) => event.id === selectedEventId) ?? null,
    [events, selectedEventId],
  );

  useEffect(() => {
    if (selectedEvent) {
      setForm({
        id: selectedEvent.id,
        title: selectedEvent.title,
        notes: selectedEvent.notes,
        startAt: toDateInputValue(selectedEvent.startAt),
        remindBeforeMinutes: selectedEvent.remindBeforeMinutes,
      });
      return;
    }
    setForm(DEFAULT_FORM);
  }, [selectedEvent]);

  const groupedEvents = useMemo(
    () => ({
      upcoming: events.filter((event) => !event.completed && new Date(event.startAt).getTime() >= Date.now()),
      completed: events.filter((event) => event.completed),
    }),
    [events],
  );

  const resetForm = useCallback(() => {
    setSelectedEventId(null);
    setForm(DEFAULT_FORM);
  }, []);

  const handleSave = useCallback(async () => {
    if (!form.title.trim() || !form.startAt) {
      setErrorText(t('validation'));
      return;
    }

    const now = Date.now();
    const eventId = form.id ?? generateId();
    const existing = events.find((event) => event.id === eventId);
    const nextEvent: CalendarEvent = {
      id: eventId,
      title: form.title.trim(),
      notes: form.notes.trim(),
      startAt: new Date(form.startAt).toISOString(),
      remindBeforeMinutes: form.remindBeforeMinutes,
      completed: existing?.completed ?? false,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      lastReminderSentAt:
        existing && existing.startAt === new Date(form.startAt).toISOString()
          ? existing.lastReminderSentAt
          : undefined,
    };

    try {
      setErrorText(null);
      const filePath = getEventFilePath(eventId);
      saveFile(filePath, nextEvent);
      await syncToCloud(filePath, nextEvent);
      const nextEvents = [...events.filter((event) => event.id !== eventId), nextEvent].sort(
        (a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime(),
      );
      setEvents(nextEvents);
      setSelectedEventId(eventId);
      reportAction(APP_ID, existing ? 'UPDATE_EVENT' : 'CREATE_EVENT', {
        filePath,
        focusId: eventId,
      });
    } catch (error) {
      console.error('[Calendar] Save failed:', error);
      setErrorText(error instanceof Error ? error.message : String(error));
    }
  }, [events, form, saveFile, syncToCloud, t]);

  const handleDelete = useCallback(
    async (eventId: string) => {
      try {
        const filePath = getEventFilePath(eventId);
        await deleteFromCloud(filePath);
        const nextEvents = events.filter((event) => event.id !== eventId);
        setEvents(nextEvents);
        if (selectedEventId === eventId) {
          setSelectedEventId(nextEvents[0]?.id ?? null);
        }
        reportAction(APP_ID, 'DELETE_EVENT', { eventId });
      } catch (error) {
        console.error('[Calendar] Delete failed:', error);
        setErrorText(error instanceof Error ? error.message : String(error));
      }
    },
    [deleteFromCloud, events, selectedEventId],
  );

  const handleToggleCompleted = useCallback(
    async (event: CalendarEvent) => {
      const nextEvent = {
        ...event,
        completed: !event.completed,
        updatedAt: Date.now(),
      };
      try {
        const filePath = getEventFilePath(event.id);
        saveFile(filePath, nextEvent);
        await syncToCloud(filePath, nextEvent);
        setEvents((prev) =>
          prev
            .map((item) => (item.id === event.id ? nextEvent : item))
            .sort((a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime()),
        );
        reportAction(APP_ID, nextEvent.completed ? 'COMPLETE_EVENT' : 'REOPEN_EVENT', {
          eventId: event.id,
        });
      } catch (error) {
        console.error('[Calendar] Toggle complete failed:', error);
        setErrorText(error instanceof Error ? error.message : String(error));
      }
    },
    [saveFile, syncToCloud],
  );

  const renderEventCard = (event: CalendarEvent) => {
    const status = getRelativeStatus(event.startAt);
    return (
      <button
        key={event.id}
        className={`${styles.eventCard} ${selectedEventId === event.id ? styles.eventCardActive : ''}`}
        onClick={() => {
          setSelectedEventId(event.id);
          reportAction(APP_ID, 'SELECT_EVENT', { eventId: event.id });
        }}
      >
        <div className={styles.eventCardTop}>
          <span className={`${styles.statusBadge} ${styles[`status${status}`]}`}>{t(status)}</span>
          <span className={styles.eventTime}>{formatEventTime(event.startAt, i18n.language)}</span>
        </div>
        <strong className={styles.eventTitle}>{event.title}</strong>
        {event.notes ? <p className={styles.eventNotes}>{event.notes}</p> : null}
        <div className={styles.eventCardBottom}>
          <span className={styles.reminderMeta}>
            {event.remindBeforeMinutes === 0
              ? t('atTime')
              : t('beforeMinutes', { count: event.remindBeforeMinutes })}
          </span>
          <label className={styles.checkRow}>
            <input
              type="checkbox"
              checked={event.completed}
              onChange={(e) => {
                e.stopPropagation();
                void handleToggleCompleted(event);
              }}
            />
            <span>{t('done')}</span>
          </label>
        </div>
      </button>
    );
  };

  if (isLoading) {
    return (
      <div className={styles.calendar}>
        <div className={styles.loading}>{t('loading')}</div>
      </div>
    );
  }

  return (
    <div className={styles.calendar}>
      <aside className={styles.sidebar}>
        <div className={styles.sidebarHeader}>
          <div>
            <p className={styles.eyebrow}>{t('eyebrow')}</p>
            <h1 className={styles.heading}>{t('title')}</h1>
          </div>
          <button className={styles.newButton} onClick={resetForm}>
            {t('new')}
          </button>
        </div>

        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <h2>{t('upcoming')}</h2>
            <span>{groupedEvents.upcoming.length}</span>
          </div>
          <div className={styles.eventList}>
            {groupedEvents.upcoming.length > 0 ? (
              groupedEvents.upcoming.map(renderEventCard)
            ) : (
              <div className={styles.empty}>{t('empty')}</div>
            )}
          </div>
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <h2>{t('completed')}</h2>
            <span>{groupedEvents.completed.length}</span>
          </div>
          <div className={styles.eventList}>
            {groupedEvents.completed.length > 0 ? (
              groupedEvents.completed.map(renderEventCard)
            ) : (
              <div className={styles.empty}>{t('noCompleted')}</div>
            )}
          </div>
        </section>
      </aside>

      <main className={styles.editor}>
        <div className={styles.editorCard}>
          <div className={styles.editorHeader}>
            <div>
              <p className={styles.eyebrow}>{selectedEvent ? t('editing') : t('creating')}</p>
              <h2>{selectedEvent ? selectedEvent.title : t('editorTitle')}</h2>
            </div>
            {selectedEvent ? (
              <button className={styles.deleteButton} onClick={() => void handleDelete(selectedEvent.id)}>
                {t('delete')}
              </button>
            ) : null}
          </div>

          <label className={styles.field}>
            <span>{t('eventTitle')}</span>
            <input
              value={form.title}
              onChange={(e) => setForm((prev) => ({ ...prev, title: e.target.value }))}
              placeholder={t('titlePlaceholder')}
            />
          </label>

          <div className={styles.row}>
            <label className={styles.field}>
              <span>{t('dateTime')}</span>
              <input
                type="datetime-local"
                value={form.startAt}
                onChange={(e) => setForm((prev) => ({ ...prev, startAt: e.target.value }))}
              />
            </label>

            <label className={styles.field}>
              <span>{t('reminder')}</span>
              <select
                value={form.remindBeforeMinutes}
                onChange={(e) =>
                  setForm((prev) => ({
                    ...prev,
                    remindBeforeMinutes: Number(e.target.value) as ReminderOption,
                  }))
                }
              >
                {REMINDER_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {option === 0 ? t('atTime') : t('beforeMinutes', { count: option })}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className={styles.field}>
            <span>{t('notes')}</span>
            <textarea
              value={form.notes}
              onChange={(e) => setForm((prev) => ({ ...prev, notes: e.target.value }))}
              placeholder={t('notesPlaceholder')}
              rows={8}
            />
          </label>

          {errorText ? <div className={styles.errorBox}>{errorText}</div> : null}

          <div className={styles.actions}>
            <button className={styles.primaryButton} onClick={() => void handleSave()}>
              {selectedEvent ? t('update') : t('save')}
            </button>
            <button className={styles.secondaryButton} onClick={resetForm}>
              {t('clear')}
            </button>
          </div>
        </div>
      </main>
    </div>
  );
};

export default CalendarPage;
