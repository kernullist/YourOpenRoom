import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { initVibeApp, AppLifecycle } from '@gui/vibe-container';
import {
  AlertCircle,
  Bell,
  CalendarClock,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Circle,
  Clock3,
  Plus,
  RotateCcw,
  Save,
  Search,
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

const APP_ID = 15;
const APP_NAME = 'calendar';
const EVENTS_DIR = '/events';
const STATE_FILE = '/state.json';
const DEFAULT_REMINDER_MINUTES = 15;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const calendarFileApi = createAppFileApi(APP_NAME);

type ReminderOption = 0 | 5 | 10 | 15 | 30 | 60 | 120 | 1440;
type EventStatus = 'past' | 'soon' | 'upcoming' | 'completed';

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
  selectedDateKey?: string;
}

interface EventFormState {
  id: string | null;
  title: string;
  notes: string;
  startAt: string;
  remindBeforeMinutes: ReminderOption;
}

const REMINDER_OPTIONS: ReminderOption[] = [0, 5, 10, 15, 30, 60, 120, 1440];
const TIME_PRESETS = [
  { key: 'morning', hour: 9 },
  { key: 'afternoon', hour: 13 },
  { key: 'evening', hour: 18 },
] as const;

function getEventFilePath(eventId: string): string {
  return `${EVENTS_DIR}/${eventId}.json`;
}

function getLocale(language: string): string {
  return language.startsWith('zh') ? 'zh-CN' : 'en-US';
}

function startOfDay(date: Date): Date {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * ONE_DAY_MS);
}

function formatDateTimeInputValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day}T${hour}:${minute}`;
}

function getDateKey(value: string | Date): string {
  const parsed = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(parsed.getTime())) return formatDateTimeInputValue(new Date()).slice(0, 10);
  return formatDateTimeInputValue(parsed).slice(0, 10);
}

function isDateKey(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return !Number.isNaN(new Date(`${value}T00:00:00`).getTime());
}

function parseDateKey(dateKey: string): Date {
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function getStartOfWeek(date: Date): Date {
  const day = date.getDay();
  const offset = (day + 6) % 7;
  return addDays(startOfDay(date), -offset);
}

function toDateInputValue(value: string): string {
  if (!value) return '';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '';
  return formatDateTimeInputValue(parsed);
}

function getDefaultStartAtForDate(dateKey: string): string {
  const selectedDate = parseDateKey(dateKey);
  const today = startOfDay(new Date());

  if (selectedDate.getTime() === today.getTime()) {
    const nextHour = new Date();
    nextHour.setMinutes(0, 0, 0);
    nextHour.setHours(nextHour.getHours() + 1);
    return formatDateTimeInputValue(nextHour);
  }

  selectedDate.setHours(9, 0, 0, 0);
  return formatDateTimeInputValue(selectedDate);
}

function moveStartAtToDate(dateKey: string, currentStartAt: string): string {
  const selectedDate = parseDateKey(dateKey);
  const currentDate = currentStartAt ? new Date(currentStartAt) : null;

  if (!currentDate || Number.isNaN(currentDate.getTime())) {
    return getDefaultStartAtForDate(dateKey);
  }

  selectedDate.setHours(
    currentDate.getHours(),
    currentDate.getMinutes(),
    currentDate.getSeconds(),
    currentDate.getMilliseconds(),
  );
  return formatDateTimeInputValue(selectedDate);
}

function createEmptyForm(dateKey: string): EventFormState {
  return {
    id: null,
    title: '',
    notes: '',
    startAt: getDefaultStartAtForDate(dateKey),
    remindBeforeMinutes: DEFAULT_REMINDER_MINUTES,
  };
}

function parseEventContent(raw: unknown): CalendarEvent | null {
  if (!raw) return null;
  const parsed =
    typeof raw === 'string' ? (JSON.parse(raw) as CalendarEvent) : (raw as CalendarEvent);
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
  return new Intl.DateTimeFormat(getLocale(language), {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(parsed);
}

function formatFullDate(dateKey: string, language: string): string {
  return new Intl.DateTimeFormat(getLocale(language), {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(parseDateKey(dateKey));
}

function formatWeekTitle(dateKey: string, language: string): string {
  const start = parseDateKey(dateKey);
  const end = addDays(start, 6);
  const locale = getLocale(language);
  const month = new Intl.DateTimeFormat(locale, { month: 'short' }).format(start);
  const endMonth = new Intl.DateTimeFormat(locale, { month: 'short' }).format(end);
  return `${month} ${start.getDate()} - ${endMonth} ${end.getDate()}`;
}

function getRelativeStatus(event: CalendarEvent): EventStatus {
  if (event.completed) return 'completed';
  const diff = new Date(event.startAt).getTime() - Date.now();
  if (diff < 0) return 'past';
  if (diff <= 60 * 60 * 1000) return 'soon';
  return 'upcoming';
}

function includesSearch(event: CalendarEvent, query: string): boolean {
  if (!query) return true;
  const haystack = `${event.title} ${event.notes}`.toLowerCase();
  return haystack.includes(query);
}

const CalendarPage: React.FC = () => {
  const { t, i18n } = useTranslation('calendar');
  const todayKey = getDateKey(new Date());
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [selectedDateKey, setSelectedDateKey] = useState(todayKey);
  const [visibleWeekStartKey, setVisibleWeekStartKey] = useState(
    getDateKey(getStartOfWeek(new Date())),
  );
  const [searchQuery, setSearchQuery] = useState('');
  const [form, setForm] = useState<EventFormState>(() => createEmptyForm(todayKey));
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
      const preferredEvent = nextEvents.find((event) => event.id === preferredId);
      const preferredDateKey = preferredEvent
        ? getDateKey(preferredEvent.startAt)
        : isDateKey(state.selectedDateKey)
          ? state.selectedDateKey
          : getDateKey(new Date());

      setSelectedEventId(preferredId);
      setSelectedDateKey(preferredDateKey);
      setVisibleWeekStartKey(getDateKey(getStartOfWeek(parseDateKey(preferredDateKey))));
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
        await fetchVibeInfo().catch((error) =>
          console.warn('[Calendar] fetchVibeInfo failed', error),
        );
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
    void saveAppState({ selectedEventId, selectedDateKey });
  }, [isInitialized, saveAppState, selectedDateKey, selectedEventId]);

  const selectedEvent = useMemo(
    () => events.find((event) => event.id === selectedEventId) ?? null,
    [events, selectedEventId],
  );

  useEffect(() => {
    if (selectedEvent) {
      const eventDateKey = getDateKey(selectedEvent.startAt);
      setSelectedDateKey(eventDateKey);
      setVisibleWeekStartKey(getDateKey(getStartOfWeek(parseDateKey(eventDateKey))));
      setForm({
        id: selectedEvent.id,
        title: selectedEvent.title,
        notes: selectedEvent.notes,
        startAt: toDateInputValue(selectedEvent.startAt),
        remindBeforeMinutes: selectedEvent.remindBeforeMinutes,
      });
      return;
    }
    setForm((prev) => (prev.id ? createEmptyForm(selectedDateKey) : prev));
  }, [selectedEvent]);

  const eventCountsByDate = useMemo(() => {
    const counts = new Map<string, number>();
    events
      .filter((event) => !event.completed)
      .forEach((event) => {
        const dateKey = getDateKey(event.startAt);
        counts.set(dateKey, (counts.get(dateKey) ?? 0) + 1);
      });
    return counts;
  }, [events]);

  const weekDays = useMemo(() => {
    const start = parseDateKey(visibleWeekStartKey);
    return Array.from({ length: 7 }, (_, index) => addDays(start, index));
  }, [visibleWeekStartKey]);

  const searchText = searchQuery.trim().toLowerCase();
  const filteredEvents = useMemo(
    () => events.filter((event) => includesSearch(event, searchText)),
    [events, searchText],
  );

  const groupedEvents = useMemo(() => {
    const active = filteredEvents.filter((event) => !event.completed);
    const selectedDay = active.filter((event) => getDateKey(event.startAt) === selectedDateKey);
    const selectedIds = new Set(selectedDay.map((event) => event.id));
    const attention = active.filter((event) => {
      if (selectedIds.has(event.id)) return false;
      const status = getRelativeStatus(event);
      return status === 'past' || status === 'soon';
    });
    const attentionIds = new Set(attention.map((event) => event.id));
    const later = active.filter(
      (event) => !selectedIds.has(event.id) && !attentionIds.has(event.id),
    );
    const completed = filteredEvents.filter((event) => event.completed).reverse();

    return { selectedDay, attention, later, completed };
  }, [filteredEvents, selectedDateKey]);

  const stats = useMemo(() => {
    const active = events.filter((event) => !event.completed);
    const now = Date.now();
    return {
      today: active.filter((event) => getDateKey(event.startAt) === todayKey).length,
      overdue: active.filter((event) => new Date(event.startAt).getTime() < now).length,
      soon: active.filter((event) => {
        const diff = new Date(event.startAt).getTime() - now;
        return diff >= 0 && diff <= 60 * 60 * 1000;
      }).length,
    };
  }, [events, todayKey]);

  const formatReminder = useCallback(
    (minutes: ReminderOption): string => {
      if (minutes === 0) return t('atTime');
      if (minutes === 60) return t('oneHourBefore');
      if (minutes === 120) return t('twoHoursBefore');
      if (minutes === 1440) return t('oneDayBefore');
      return t('beforeMinutes', { count: minutes });
    },
    [t],
  );

  const createDraftForDate = useCallback(
    (dateKey = selectedDateKey) => {
      setSelectedEventId(null);
      setSelectedDateKey(dateKey);
      setVisibleWeekStartKey(getDateKey(getStartOfWeek(parseDateKey(dateKey))));
      setForm(createEmptyForm(dateKey));
      setErrorText(null);
    },
    [selectedDateKey],
  );

  const handleSelectDate = useCallback((dateKey: string) => {
    setSelectedDateKey(dateKey);
    setVisibleWeekStartKey(getDateKey(getStartOfWeek(parseDateKey(dateKey))));
    setForm((prev) => ({ ...prev, startAt: moveStartAtToDate(dateKey, prev.startAt) }));
  }, []);

  const handleGoToday = useCallback(() => {
    handleSelectDate(todayKey);
  }, [handleSelectDate, todayKey]);

  const handleSelectEvent = useCallback((event: CalendarEvent) => {
    setSelectedEventId(event.id);
    setSelectedDateKey(getDateKey(event.startAt));
    reportAction(APP_ID, 'SELECT_EVENT', { eventId: event.id });
  }, []);

  const applyQuickDate = useCallback((daysFromToday: number) => {
    const dateKey = getDateKey(addDays(startOfDay(new Date()), daysFromToday));
    setSelectedDateKey(dateKey);
    setVisibleWeekStartKey(getDateKey(getStartOfWeek(parseDateKey(dateKey))));
    setForm((prev) => ({ ...prev, startAt: moveStartAtToDate(dateKey, prev.startAt) }));
  }, []);

  const applyTimePreset = useCallback((hour: number) => {
    setForm((prev) => {
      const baseDate = prev.startAt ? new Date(prev.startAt) : new Date();
      if (Number.isNaN(baseDate.getTime())) return prev;
      baseDate.setHours(hour, 0, 0, 0);
      return { ...prev, startAt: formatDateTimeInputValue(baseDate) };
    });
  }, []);

  const handleStartAtChange = useCallback((value: string) => {
    setForm((prev) => ({ ...prev, startAt: value }));
    if (value) {
      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime())) {
        const dateKey = getDateKey(parsed);
        setSelectedDateKey(dateKey);
        setVisibleWeekStartKey(getDateKey(getStartOfWeek(parseDateKey(dateKey))));
      }
    }
  }, []);

  const resetForm = useCallback(() => {
    createDraftForDate();
  }, [createDraftForDate]);

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
      setSelectedDateKey(getDateKey(nextEvent.startAt));
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
    const status = getRelativeStatus(event);
    const isSelected = selectedEventId === event.id;

    return (
      <article
        key={event.id}
        className={`${styles.eventCard} ${isSelected ? styles.eventCardActive : ''} ${
          event.completed ? styles.eventCardCompleted : ''
        }`}
        role="button"
        tabIndex={0}
        onClick={() => handleSelectEvent(event)}
        onKeyDown={(eventKey) => {
          if (eventKey.key === 'Enter' || eventKey.key === ' ') {
            eventKey.preventDefault();
            handleSelectEvent(event);
          }
        }}
      >
        <div className={`${styles.eventAccent} ${styles[`accent${status}`]}`} />
        <div className={styles.eventCardTop}>
          <span className={`${styles.statusBadge} ${styles[`status${status}`]}`}>{t(status)}</span>
          <span className={styles.eventTime}>{formatEventTime(event.startAt, i18n.language)}</span>
        </div>
        <strong className={styles.eventTitle}>{event.title}</strong>
        {event.notes ? <p className={styles.eventNotes}>{event.notes}</p> : null}
        <div className={styles.eventCardBottom}>
          <span className={styles.reminderMeta}>
            <Bell size={13} />
            {formatReminder(event.remindBeforeMinutes)}
          </span>
          <button
            type="button"
            className={styles.completeButton}
            onClick={(clickEvent) => {
              clickEvent.stopPropagation();
              void handleToggleCompleted(event);
            }}
            title={event.completed ? t('reopen') : t('markDone')}
            aria-label={event.completed ? t('reopen') : t('markDone')}
          >
            {event.completed ? <CheckCircle2 size={17} /> : <Circle size={17} />}
          </button>
        </div>
      </article>
    );
  };

  const renderSection = (
    title: string,
    count: number,
    items: CalendarEvent[],
    emptyText: string,
  ) => (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <h2>{title}</h2>
        <span>{count}</span>
      </div>
      <div className={styles.eventList}>
        {items.length > 0 ? (
          items.map(renderEventCard)
        ) : (
          <div className={styles.empty}>{emptyText}</div>
        )}
      </div>
    </section>
  );

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
          <button className={styles.newButton} onClick={() => createDraftForDate()} type="button">
            <Plus size={17} />
            <span>{t('new')}</span>
          </button>
        </div>

        <div className={styles.statGrid}>
          <div className={styles.statTile}>
            <span>{t('statsToday')}</span>
            <strong>{stats.today}</strong>
          </div>
          <div className={styles.statTile}>
            <span>{t('statsSoon')}</span>
            <strong>{stats.soon}</strong>
          </div>
          <div className={`${styles.statTile} ${stats.overdue > 0 ? styles.statAlert : ''}`}>
            <span>{t('statsOverdue')}</span>
            <strong>{stats.overdue}</strong>
          </div>
        </div>

        <div className={styles.weekPanel}>
          <div className={styles.weekToolbar}>
            <button
              className={styles.iconButton}
              type="button"
              onClick={() =>
                setVisibleWeekStartKey((prev) => getDateKey(addDays(parseDateKey(prev), -7)))
              }
              title={t('previousWeek')}
            >
              <ChevronLeft size={16} />
            </button>
            <strong>{formatWeekTitle(visibleWeekStartKey, i18n.language)}</strong>
            <button
              className={styles.iconButton}
              type="button"
              onClick={() =>
                setVisibleWeekStartKey((prev) => getDateKey(addDays(parseDateKey(prev), 7)))
              }
              title={t('nextWeek')}
            >
              <ChevronRight size={16} />
            </button>
            <button className={styles.todayButton} type="button" onClick={handleGoToday}>
              <CalendarDays size={15} />
              <span>{t('today')}</span>
            </button>
          </div>

          <div className={styles.weekStrip}>
            {weekDays.map((day) => {
              const dateKey = getDateKey(day);
              const isActive = selectedDateKey === dateKey;
              const isToday = todayKey === dateKey;
              const count = eventCountsByDate.get(dateKey) ?? 0;
              return (
                <button
                  key={dateKey}
                  type="button"
                  className={`${styles.dayButton} ${isActive ? styles.dayButtonActive : ''} ${
                    isToday ? styles.dayButtonToday : ''
                  }`}
                  onClick={() => handleSelectDate(dateKey)}
                >
                  <span>
                    {new Intl.DateTimeFormat(getLocale(i18n.language), { weekday: 'short' }).format(
                      day,
                    )}
                  </span>
                  <strong>{day.getDate()}</strong>
                  <em>{count}</em>
                </button>
              );
            })}
          </div>
        </div>

        <label className={styles.searchBox}>
          <Search size={16} />
          <input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder={t('searchPlaceholder')}
          />
        </label>

        {renderSection(
          formatFullDate(selectedDateKey, i18n.language),
          groupedEvents.selectedDay.length,
          groupedEvents.selectedDay,
          searchText ? t('noMatches') : t('emptySelectedDay'),
        )}
        {renderSection(
          t('attention'),
          groupedEvents.attention.length,
          groupedEvents.attention,
          t('allClear'),
        )}
        {renderSection(t('later'), groupedEvents.later.length, groupedEvents.later, t('empty'))}
        {renderSection(
          t('completed'),
          groupedEvents.completed.length,
          groupedEvents.completed,
          t('noCompleted'),
        )}
      </aside>

      <main className={styles.editor}>
        <div className={styles.editorCard}>
          <div className={styles.editorHeader}>
            <div className={styles.editorTitleGroup}>
              <span className={styles.editorIcon}>
                <CalendarClock size={22} />
              </span>
              <div>
                <p className={styles.eyebrow}>{selectedEvent ? t('editing') : t('creating')}</p>
                <h2>{selectedEvent ? selectedEvent.title : t('editorTitle')}</h2>
              </div>
            </div>
            {selectedEvent ? (
              <div className={styles.headerActions}>
                <button
                  className={styles.secondaryButton}
                  type="button"
                  onClick={() => void handleToggleCompleted(selectedEvent)}
                >
                  {selectedEvent.completed ? <Circle size={16} /> : <CheckCircle2 size={16} />}
                  <span>{selectedEvent.completed ? t('reopen') : t('markDone')}</span>
                </button>
                <button
                  className={styles.deleteButton}
                  type="button"
                  onClick={() => void handleDelete(selectedEvent.id)}
                >
                  <Trash2 size={16} />
                  <span>{t('delete')}</span>
                </button>
              </div>
            ) : null}
          </div>

          <div className={styles.dateBanner}>
            <div>
              <span>{t('scheduleFor')}</span>
              <strong>{formatFullDate(selectedDateKey, i18n.language)}</strong>
            </div>
            <button className={styles.ghostButton} type="button" onClick={handleGoToday}>
              <CalendarDays size={15} />
              <span>{t('today')}</span>
            </button>
          </div>

          <label className={styles.field}>
            <span>{t('eventTitle')}</span>
            <input
              value={form.title}
              onChange={(event) => setForm((prev) => ({ ...prev, title: event.target.value }))}
              placeholder={t('titlePlaceholder')}
            />
          </label>

          <div className={styles.quickRow}>
            <span>{t('quickDates')}</span>
            <button type="button" onClick={() => applyQuickDate(0)}>
              {t('today')}
            </button>
            <button type="button" onClick={() => applyQuickDate(1)}>
              {t('tomorrow')}
            </button>
            <button type="button" onClick={() => applyQuickDate(7)}>
              {t('nextWeek')}
            </button>
          </div>

          <div className={styles.formGrid}>
            <label className={styles.field}>
              <span>{t('dateTime')}</span>
              <input
                type="datetime-local"
                value={form.startAt}
                onChange={(event) => handleStartAtChange(event.target.value)}
              />
            </label>

            <div className={styles.field}>
              <span>{t('pickTime')}</span>
              <div className={styles.timePresetRow}>
                {TIME_PRESETS.map((preset) => (
                  <button
                    key={preset.key}
                    type="button"
                    onClick={() => applyTimePreset(preset.hour)}
                  >
                    <Clock3 size={14} />
                    <span>{t(preset.key)}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className={styles.field}>
            <span>{t('reminder')}</span>
            <div className={styles.reminderGrid}>
              {REMINDER_OPTIONS.map((option) => (
                <button
                  key={option}
                  type="button"
                  className={form.remindBeforeMinutes === option ? styles.reminderActive : ''}
                  onClick={() =>
                    setForm((prev) => ({
                      ...prev,
                      remindBeforeMinutes: option,
                    }))
                  }
                >
                  {formatReminder(option)}
                </button>
              ))}
            </div>
          </div>

          <label className={styles.field}>
            <span>{t('notes')}</span>
            <textarea
              value={form.notes}
              onChange={(event) => setForm((prev) => ({ ...prev, notes: event.target.value }))}
              placeholder={t('notesPlaceholder')}
              rows={7}
            />
          </label>

          {errorText ? (
            <div className={styles.errorBox}>
              <AlertCircle size={16} />
              <span>{errorText}</span>
            </div>
          ) : null}

          <div className={styles.actions}>
            <button
              className={styles.primaryButton}
              type="button"
              onClick={() => void handleSave()}
            >
              <Save size={16} />
              <span>{selectedEvent ? t('update') : t('save')}</span>
            </button>
            <button className={styles.secondaryButton} type="button" onClick={resetForm}>
              <RotateCcw size={16} />
              <span>{t('clear')}</span>
            </button>
          </div>
        </div>
      </main>
    </div>
  );
};

export default CalendarPage;
