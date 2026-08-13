import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppLifecycle, initVibeApp } from '@gui/vibe-container';
import {
  createAppFileApi,
  reportAction,
  reportLifecycle,
  useAgentActionListener,
  type CharacterAppAction,
} from '@/lib';
import { isDayKey, toDayKey, type DayKey } from './dayKey';
import { buildHabitViews, computeGardenWeather, type HabitView } from './garden';
import {
  createHabitDraft,
  createHabitGardenRepository,
  pickHabitColor,
  setCheckIn,
} from './repository';
import { applyRoomItem, currentRoomItemId, decideWeatherRoom } from './roomWeather';
import {
  DEFAULT_HABIT_GARDEN_STATE,
  HABIT_SUGGESTIONS,
  mergeHabitGardenState,
  type Habit,
  type HabitCadence,
  type HabitGardenState,
} from './types';
import { APP_ID, APP_NAME, APP_STORAGE_NAME } from './actions/constants';
import WeatherStrip from './components/WeatherStrip';
import GardenGrid from './components/GardenGrid';
import CheckInBar from './components/CheckInBar';
import EmptyGarden from './components/EmptyGarden';
import HabitDetail from './components/HabitDetail';
import HabitEditor, { type HabitDraft } from './components/HabitEditor';
import SettingsPanel from './components/SettingsPanel';
import styles from './index.module.scss';

const COMPACT_MAX_WIDTH = 600;
const REGULAR_MAX_WIDTH = 1200;

const WIDTH_PLANT_SIZE = { compact: 64, regular: 88, expanded: 104 } as const;
const WIDTH_HEATMAP_WEEKS = { compact: 6, regular: 8, expanded: 16 } as const;

type WidthBucket = keyof typeof WIDTH_PLANT_SIZE;

function widthBucket(width: number): WidthBucket {
  if (width < COMPACT_MAX_WIDTH) {
    return 'compact';
  }
  if (width < REGULAR_MAX_WIDTH) {
    return 'regular';
  }
  return 'expanded';
}

function emptyDraft(index: number): HabitDraft {
  return {
    id: null,
    name: '',
    cadenceKind: 'daily',
    timesPerWeek: 3,
    color: pickHabitColor(index),
  };
}

function draftCadence(draft: HabitDraft): HabitCadence {
  return draft.cadenceKind === 'weekly'
    ? { kind: 'weekly', timesPerWeek: draft.timesPerWeek }
    : { kind: 'daily' };
}

function HabitGarden(): JSX.Element {
  const [habits, setHabits] = useState<Habit[]>([]);
  const [state, setState] = useState<HabitGardenState>(DEFAULT_HABIT_GARDEN_STATE);
  const [todayKey, setTodayKey] = useState<DayKey>(() => toDayKey());
  const [bucket, setBucket] = useState<WidthBucket>('regular');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editorDraft, setEditorDraft] = useState<HabitDraft | null>(null);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [toast, setToast] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [ready, setReady] = useState(false);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const habitsRef = useRef(habits);
  habitsRef.current = habits;
  const stateRef = useRef(state);
  stateRef.current = state;
  const stateLoadedRef = useRef(false);

  const repo = useMemo(() => createHabitGardenRepository(createAppFileApi(APP_STORAGE_NAME)), []);

  const views = useMemo(() => buildHabitViews(habits, todayKey), [habits, todayKey]);
  const weather = useMemo(() => computeGardenWeather(habits, todayKey), [habits, todayKey]);
  const selectedView = useMemo(
    () => views.find((view) => view.habit.id === state.selectedHabitId) ?? null,
    [views, state.selectedHabitId],
  );

  const loadAll = useCallback(async (): Promise<void> => {
    const [loadedState, loadedHabits] = await Promise.all([repo.loadState(), repo.loadHabits()]);
    setState(loadedState);
    setHabits(loadedHabits);
    stateLoadedRef.current = true;
  }, [repo]);

  const refreshHabits = useCallback(async (): Promise<Habit[]> => {
    const loaded = await repo.refresh();
    setHabits(loaded);
    return loaded;
  }, [repo]);

  useEffect(() => {
    if (!stateLoadedRef.current) {
      return;
    }
    void repo.saveState(state).catch(() => {
      // Losing a view preference is not worth interrupting the user over.
    });
  }, [repo, state]);

  // The day can roll over while the window sits open. Without this the check-in
  // bar would keep writing to yesterday's key past midnight.
  useEffect(() => {
    const timer = window.setInterval(() => {
      const next = toDayKey();
      setTodayKey((current) => (current === next ? current : next));
    }, 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!toast) {
      return undefined;
    }
    const timer = window.setTimeout(() => setToast(null), 3500);
    return () => window.clearTimeout(timer);
  }, [toast]);

  // Width from the element, not the viewport: this renders inside an iframe.
  useEffect(() => {
    const node = rootRef.current;
    if (!node || typeof ResizeObserver === 'undefined') {
      return undefined;
    }
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? node.clientWidth;
      setBucket(widthBucket(width));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // Weather -> room. Runs only on an actual change, which is what keeps a theme
  // the user picked in RoomShop from being reverted on the next render.
  useEffect(() => {
    if (!stateLoadedRef.current) {
      return;
    }
    const decision = decideWeatherRoom({
      enabled: state.reflectWeatherInRoom,
      weather: weather.weather,
      lastAppliedWeather: state.lastAppliedWeather,
      restoreRoomItemId: state.restoreRoomItemId,
    });
    if (decision.applyItemId) {
      applyRoomItem(decision.applyItemId);
    }
    if (decision.nextAppliedWeather !== state.lastAppliedWeather) {
      setState((current) => ({ ...current, lastAppliedWeather: decision.nextAppliedWeather }));
    }
  }, [
    state.reflectWeatherInRoom,
    state.lastAppliedWeather,
    state.restoreRoomItemId,
    weather.weather,
  ]);

  const applyCheckIn = useCallback(
    async (
      habitId: string,
      nextDone: boolean,
      dayKey: DayKey,
      fromAgent = false,
    ): Promise<string> => {
      const habit = habitsRef.current.find((entry) => entry.id === habitId);
      if (!habit) {
        return `error: habit not found ${habitId}`;
      }
      const updated = setCheckIn(habit, dayKey, nextDone, Date.now());
      const previous = habitsRef.current;

      // Optimistic: the plant has to react in the same frame as the click.
      setHabits((current) => current.map((entry) => (entry.id === habitId ? updated : entry)));
      setBusyId(habitId);
      try {
        await repo.saveHabit(updated);
        if (!fromAgent) {
          reportAction(APP_ID, nextDone ? 'CHECK_IN_HABIT' : 'UNDO_HABIT_CHECK_IN', {
            habitId,
            dayKey,
          });
        }
        return 'success';
      } catch (error) {
        // Rolled back rather than left optimistic: a user who believes a day was
        // recorded when it was not will find out via a broken streak later.
        setHabits(previous);
        const message = error instanceof Error ? error.message : String(error);
        setToast({ tone: 'error', text: `기록에 실패했어요: ${message}` });
        return `error: ${message}`;
      } finally {
        setBusyId(null);
      }
    },
    [repo],
  );

  const handleToggleCheckIn = useCallback(
    (habitId: string, nextDone: boolean) => {
      void applyCheckIn(habitId, nextDone, todayKey);
    },
    [applyCheckIn, todayKey],
  );

  const createHabit = useCallback(
    async (name: string, cadence: HabitCadence, fromAgent = false): Promise<string> => {
      const trimmed = name.trim();
      if (!trimmed) {
        return 'error: name is required';
      }
      const habit = createHabitDraft(
        trimmed,
        cadence,
        pickHabitColor(habitsRef.current.length),
        Date.now(),
      );
      setBusyId(habit.id);
      try {
        await repo.saveHabit(habit);
        await refreshHabits();
        if (!fromAgent) {
          reportAction(APP_ID, 'CREATE_HABIT', { habitId: habit.id, name: trimmed });
        }
        return 'success';
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setToast({ tone: 'error', text: `심지 못했어요: ${message}` });
        return `error: ${message}`;
      } finally {
        setBusyId(null);
      }
    },
    [refreshHabits, repo],
  );

  const handleSubmitEditor = useCallback(async (): Promise<void> => {
    const draft = editorDraft;
    if (!draft) {
      return;
    }
    if (!draft.id) {
      const result = await createHabit(draft.name, draftCadence(draft));
      if (result === 'success') {
        setEditorDraft(null);
      }
      return;
    }
    const habit = habitsRef.current.find((entry) => entry.id === draft.id);
    if (!habit) {
      setEditorDraft(null);
      return;
    }
    const updated: Habit = {
      ...habit,
      name: draft.name.trim(),
      cadence: draftCadence(draft),
      color: draft.color,
      updatedAt: Date.now(),
    };
    setBusyId(habit.id);
    try {
      await repo.saveHabit(updated);
      await refreshHabits();
      reportAction(APP_ID, 'UPDATE_HABIT', { habitId: habit.id });
      setEditorDraft(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setToast({ tone: 'error', text: `저장하지 못했어요: ${message}` });
    } finally {
      setBusyId(null);
    }
  }, [createHabit, editorDraft, refreshHabits, repo]);

  const removeHabit = useCallback(
    async (habitId: string, fromAgent = false): Promise<string> => {
      if (!habitsRef.current.some((entry) => entry.id === habitId)) {
        return `error: habit not found ${habitId}`;
      }
      setBusyId(habitId);
      try {
        await repo.deleteHabit(habitId);
        await refreshHabits();
        setState((current) =>
          current.selectedHabitId === habitId ? { ...current, selectedHabitId: null } : current,
        );
        setDeleteArmed(false);
        if (!fromAgent) {
          reportAction(APP_ID, 'DELETE_HABIT', { habitId });
        }
        return 'success';
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setToast({ tone: 'error', text: `삭제하지 못했어요: ${message}` });
        return `error: ${message}`;
      } finally {
        setBusyId(null);
      }
    },
    [refreshHabits, repo],
  );

  const handleSelectHabit = useCallback((habitId: string | null) => {
    setDeleteArmed(false);
    setState((current) => ({
      ...current,
      selectedHabitId: current.selectedHabitId === habitId ? null : habitId,
    }));
  }, []);

  /**
   * Settings changes.
   *
   * Turning weather reflection ON captures the current room item first, so
   * turning it off later can put the desktop back exactly as it was rather than
   * leaving the user to hunt for their old theme in RoomShop.
   */
  const handleSettingsChange = useCallback((patch: Partial<HabitGardenState>) => {
    setState((current) => {
      const next = { ...current, ...patch };
      if (patch.reflectWeatherInRoom === true && !current.reflectWeatherInRoom) {
        next.restoreRoomItemId = currentRoomItemId();
      }
      return next;
    });
  }, []);

  /**
   * Agent-facing surface.
   *
   * Writes ARE allowed here, unlike the operator console: a check-in is the
   * user's own record, and "I stretched this morning" is the most natural way to
   * use this app. What the agent cannot touch is the two consent toggles -- see
   * DELIBERATELY_UNEXPOSED_ACTIONS.
   *
   * Nothing calls reportAction: useAgentActionListener already returns a result
   * through sendResult, so the business functions take `fromAgent` to suppress
   * the duplicate report.
   */
  const handleAgentAction = useCallback(
    async (action: CharacterAppAction): Promise<string> => {
      const params = action.params ?? {};
      const resolveDay = (): DayKey | null => {
        const raw = params.dayKey ?? params.day_key;
        if (!raw) {
          return todayKey;
        }
        return isDayKey(raw) ? raw : null;
      };

      switch (action.action_type) {
        case 'CHECK_IN_HABIT':
        case 'UNDO_HABIT_CHECK_IN': {
          const habitId = params.habitId ?? params.habit_id;
          if (!habitId) {
            return 'error: habitId is required';
          }
          const day = resolveDay();
          if (!day) {
            return 'error: dayKey must be YYYY-MM-DD';
          }
          return applyCheckIn(habitId, action.action_type === 'CHECK_IN_HABIT', day, true);
        }
        case 'CREATE_HABIT': {
          const name = params.name;
          if (!name) {
            return 'error: name is required';
          }
          const times = Number(params.timesPerWeek ?? params.times_per_week ?? 3);
          const cadence: HabitCadence =
            params.cadence === 'weekly'
              ? { kind: 'weekly', timesPerWeek: Number.isFinite(times) ? times : 3 }
              : { kind: 'daily' };
          return createHabit(name, cadence, true);
        }
        case 'UPDATE_HABIT': {
          const habitId = params.habitId ?? params.habit_id;
          const habit = habitsRef.current.find((entry) => entry.id === habitId);
          if (!habit) {
            return `error: habit not found ${String(habitId)}`;
          }
          const times = Number(params.timesPerWeek ?? params.times_per_week ?? 3);
          const updated: Habit = {
            ...habit,
            name: params.name ? params.name.trim().slice(0, 40) : habit.name,
            cadence:
              params.cadence === 'weekly'
                ? { kind: 'weekly', timesPerWeek: Number.isFinite(times) ? times : 3 }
                : params.cadence === 'daily'
                  ? { kind: 'daily' }
                  : habit.cadence,
            updatedAt: Date.now(),
          };
          try {
            await repo.saveHabit(updated);
            await refreshHabits();
            return 'success';
          } catch (error) {
            return `error: ${error instanceof Error ? error.message : String(error)}`;
          }
        }
        case 'DELETE_HABIT': {
          const habitId = params.habitId ?? params.habit_id;
          if (!habitId) {
            return 'error: habitId is required';
          }
          return removeHabit(habitId, true);
        }
        case 'SELECT_HABIT': {
          const habitId = params.habitId ?? params.habit_id;
          if (!habitId || !habitsRef.current.some((entry) => entry.id === habitId)) {
            return `error: habit not found ${String(habitId)}`;
          }
          setDeleteArmed(false);
          setState((current) => ({ ...current, selectedHabitId: habitId, activeTab: 'garden' }));
          return 'success';
        }
        case 'REFRESH_HABIT_GARDEN': {
          const loaded = await refreshHabits();
          const focus = params.habitId ?? params.habit_id;
          if (focus && loaded.some((entry) => entry.id === focus)) {
            setState((current) => ({ ...current, selectedHabitId: focus, activeTab: 'garden' }));
          }
          return 'success';
        }
        case 'SYNC_STATE': {
          const loaded = await repo.loadState();
          setState((current) => mergeHabitGardenState(current, loaded));
          return 'success';
        }
        default:
          return `error: unknown action_type ${action.action_type}`;
      }
    },
    [applyCheckIn, createHabit, refreshHabits, removeHabit, repo, todayKey],
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
          name: APP_NAME,
          windowStyle: { width: 1040, height: 720 },
        });
        reportLifecycle(AppLifecycle.DOM_READY);
        await loadAll();
        reportLifecycle(AppLifecycle.LOADED);
        manager.ready();
        setReady(true);
      } catch (error) {
        reportLifecycle(AppLifecycle.ERROR, String(error));
        setReady(true);
      }
    };

    void init();

    return () => {
      reportLifecycle(AppLifecycle.UNLOADING);
      reportLifecycle(AppLifecycle.DESTROYED);
    };
  }, [loadAll]);

  const showEmpty = ready && habits.length === 0 && !editorDraft;

  return (
    <div className={styles.root} data-width={bucket} ref={rootRef} data-testid="habit-garden">
      <WeatherStrip
        weather={weather}
        onAddHabit={() => setEditorDraft(emptyDraft(habits.length))}
        onOpenSettings={() => setState((current) => ({ ...current, activeTab: 'settings' }))}
      />

      {state.activeTab === 'settings' ? (
        <SettingsPanel
          state={state}
          busy={busyId !== null}
          onChange={handleSettingsChange}
          onBack={() => setState((current) => ({ ...current, activeTab: 'garden' }))}
        />
      ) : (
        <>
          <div className={styles.body}>
            <div className={styles.gardenColumn}>
              {showEmpty ? (
                <EmptyGarden
                  suggestions={HABIT_SUGGESTIONS}
                  busy={busyId !== null}
                  onAdd={(name) => void createHabit(name, { kind: 'daily' })}
                />
              ) : (
                <GardenGrid
                  views={views}
                  selectedId={state.selectedHabitId}
                  plantSize={WIDTH_PLANT_SIZE[bucket]}
                  onSelect={handleSelectHabit}
                />
              )}

              {editorDraft ? (
                <div className={styles.editorWrap}>
                  <HabitEditor
                    draft={editorDraft}
                    busy={busyId !== null}
                    onChange={setEditorDraft}
                    onSubmit={() => void handleSubmitEditor()}
                    onCancel={() => setEditorDraft(null)}
                  />
                </div>
              ) : null}
            </div>

            {selectedView ? (
              <HabitDetail
                view={selectedView as HabitView}
                todayKey={todayKey}
                weeks={WIDTH_HEATMAP_WEEKS[bucket]}
                compact={bucket === 'compact'}
                deleteArmed={deleteArmed}
                busy={busyId !== null}
                onEdit={() =>
                  setEditorDraft({
                    id: selectedView.habit.id,
                    name: selectedView.habit.name,
                    cadenceKind: selectedView.habit.cadence.kind,
                    timesPerWeek:
                      selectedView.habit.cadence.kind === 'weekly'
                        ? selectedView.habit.cadence.timesPerWeek
                        : 3,
                    color: selectedView.habit.color,
                  })
                }
                onArmDelete={() => setDeleteArmed(true)}
                onConfirmDelete={() => void removeHabit(selectedView.habit.id)}
                onCancelDelete={() => setDeleteArmed(false)}
                onClose={() => handleSelectHabit(null)}
              />
            ) : null}
          </div>

          <CheckInBar views={views} busyId={busyId} onToggle={handleToggleCheckIn} />
        </>
      )}

      {toast ? (
        <div className={styles.toast} data-tone={toast.tone} role="status">
          {toast.text}
        </div>
      ) : null}
    </div>
  );
}

export default HabitGarden;
