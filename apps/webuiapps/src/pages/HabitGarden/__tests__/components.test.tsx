import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import Plant from '../components/Plant';
import WeatherStrip from '../components/WeatherStrip';
import GardenGrid from '../components/GardenGrid';
import CheckInBar from '../components/CheckInBar';
import EmptyGarden from '../components/EmptyGarden';
import HabitDetail from '../components/HabitDetail';
import HabitEditor, { type HabitDraft } from '../components/HabitEditor';
import SettingsPanel from '../components/SettingsPanel';
import { buildHabitView, type GardenWeather, type HabitView } from '../garden';
import { lastDayKeys } from '../dayKey';
import { DEFAULT_HABIT_GARDEN_STATE, HABIT_COLORS, type Habit } from '../types';

// Component coverage for the rules that make this app kind rather than punitive:
// a lapse must not erase progress on screen, a check-in must be reversible, and
// the consent switches must read as switches the user owns.

const TODAY = '2026-08-13';

afterEach(cleanup);

function noop(): void {
  /* intentionally empty */
}

function makeHabit(overrides: Partial<Habit> = {}): Habit {
  return {
    version: 1,
    id: 'habit-1',
    name: '스트레칭',
    cadence: { kind: 'daily' },
    color: HABIT_COLORS[0],
    createdAt: new Date(2026, 0, 1).getTime(),
    updatedAt: new Date(2026, 0, 1).getTime(),
    checkIns: [],
    ...overrides,
  };
}

function makeView(overrides: Partial<Habit> = {}): HabitView {
  return buildHabitView(makeHabit(overrides), TODAY);
}

describe('Plant', () => {
  it('carries stage and vitality as data attributes', () => {
    const { container } = render(
      <Plant stage="bud" vitality="wilting" color="#fff" doneToday={false} />,
    );
    const svg = container.querySelector('svg');

    expect(svg?.getAttribute('data-stage')).toBe('bud');
    expect(svg?.getAttribute('data-vitality')).toBe('wilting');
  });

  it('renders a done marker only when today is done', () => {
    const { container, rerender } = render(
      <Plant stage="leaf" vitality="thriving" color="#fff" doneToday />,
    );
    expect(container.querySelector('svg')?.getAttribute('data-done')).toBe('true');

    rerender(<Plant stage="leaf" vitality="thriving" color="#fff" doneToday={false} />);
    expect(container.querySelector('svg')?.getAttribute('data-done')).toBeNull();
  });

  it('draws a wilting plant faded but still present', () => {
    // Never removed or blanked: a dead plant reads as punishment.
    const { container } = render(
      <Plant stage="bloom" vitality="wilting" color="#fff" doneToday={false} />,
    );
    const svg = container.querySelector('svg') as SVGElement;

    expect(svg).toBeTruthy();
    expect(Number(svg.style.opacity)).toBeLessThan(1);
    expect(Number(svg.style.opacity)).toBeGreaterThan(0);
  });

  it('renders every stage without throwing', () => {
    for (const stage of ['seed', 'sprout', 'leaf', 'bud', 'bloom'] as const) {
      const { container } = render(
        <Plant stage={stage} vitality="ok" color="#fff" doneToday={false} />,
      );
      expect(container.querySelector('svg')).toBeTruthy();
      cleanup();
    }
  });
});

describe('WeatherStrip', () => {
  function weather(overrides: Partial<GardenWeather> = {}): GardenWeather {
    return {
      weather: 'sunny',
      adherenceRate: 0.9,
      sampleDays: 7,
      expected: 7,
      completed: 6,
      ...overrides,
    };
  }

  it('shows the weather word and rate', () => {
    render(<WeatherStrip weather={weather()} onAddHabit={noop} onOpenSettings={noop} />);

    expect(screen.getByText('맑음')).toBeTruthy();
    expect(screen.getByTestId('habit-garden-adherence').textContent).toContain('90%');
  });

  it('says it is too early rather than declaring a verdict on a young garden', () => {
    render(
      <WeatherStrip
        weather={weather({ weather: 'unknown', adherenceRate: null, sampleDays: 2 })}
        onAddHabit={noop}
        onOpenSettings={noop}
      />,
    );

    expect(screen.getByText('아직 지켜보는 중')).toBeTruthy();
    expect(screen.getByTestId('habit-garden-adherence').textContent).toContain('이릅니다');
    expect(screen.queryByText(/0%/)).toBeNull();
  });

  it('renders each weather kind distinctly', () => {
    const labels = (['sunny', 'cloudy', 'rain', 'unknown'] as const).map((kind) => {
      const { container } = render(
        <WeatherStrip
          weather={weather({ weather: kind })}
          onAddHabit={noop}
          onOpenSettings={noop}
        />,
      );
      const text = container.querySelector('header')?.getAttribute('data-weather');
      cleanup();
      return text;
    });

    expect(new Set(labels).size).toBe(4);
  });

  it('wires the add and settings buttons', () => {
    const onAddHabit = vi.fn();
    const onOpenSettings = vi.fn();
    render(
      <WeatherStrip weather={weather()} onAddHabit={onAddHabit} onOpenSettings={onOpenSettings} />,
    );

    fireEvent.click(screen.getByTestId('habit-garden-add'));
    fireEvent.click(screen.getByTestId('habit-garden-settings-open'));

    expect(onAddHabit).toHaveBeenCalled();
    expect(onOpenSettings).toHaveBeenCalled();
  });
});

describe('GardenGrid', () => {
  it('renders one plant per habit with its stage', () => {
    const views = [
      makeView({ id: 'a', name: '독서', checkIns: lastDayKeys(TODAY, 8) }),
      makeView({ id: 'b', name: '운동', checkIns: [] }),
    ];
    render(<GardenGrid views={views} selectedId={null} plantSize={64} onSelect={noop} />);

    expect(screen.getByTestId('habit-garden-plant-a').getAttribute('data-stage')).toBe('bud');
    expect(screen.getByTestId('habit-garden-plant-b').getAttribute('data-stage')).toBe('seed');
  });

  it('marks the selected habit and reports a click', () => {
    const onSelect = vi.fn();
    render(
      <GardenGrid
        views={[makeView({ id: 'a' })]}
        selectedId="a"
        plantSize={64}
        onSelect={onSelect}
      />,
    );

    expect(screen.getByTestId('habit-garden-plant-a').getAttribute('data-active')).toBe('true');
    fireEvent.click(screen.getByTestId('habit-garden-plant-a'));
    expect(onSelect).toHaveBeenCalledWith('a');
  });

  it('shows a dash rather than a zero for a habit with no streak', () => {
    render(
      <GardenGrid
        views={[makeView({ id: 'a' })]}
        selectedId={null}
        plantSize={64}
        onSelect={noop}
      />,
    );

    expect(within(screen.getByTestId('habit-garden-plant-a')).getByText('—')).toBeTruthy();
  });
});

describe('CheckInBar', () => {
  it('renders nothing when there are no habits', () => {
    const { container } = render(<CheckInBar views={[]} busyId={null} onToggle={noop} />);

    expect(container.firstChild).toBeNull();
  });

  it('counts what is still left today', () => {
    render(
      <CheckInBar
        views={[makeView({ id: 'a' }), makeView({ id: 'b', checkIns: [TODAY] })]}
        busyId={null}
        onToggle={noop}
      />,
    );

    expect(screen.getByText('오늘 남은 것 1')).toBeTruthy();
  });

  it('celebrates a finished day', () => {
    render(
      <CheckInBar
        views={[makeView({ id: 'a', checkIns: [TODAY] })]}
        busyId={null}
        onToggle={noop}
      />,
    );

    expect(screen.getByText('오늘 다 했어요')).toBeTruthy();
  });

  it('toggles in both directions from a single click', () => {
    const onToggle = vi.fn();
    const { rerender } = render(
      <CheckInBar views={[makeView({ id: 'a' })]} busyId={null} onToggle={onToggle} />,
    );

    fireEvent.click(screen.getByTestId('habit-garden-checkin-a'));
    expect(onToggle).toHaveBeenCalledWith('a', true);

    rerender(
      <CheckInBar
        views={[makeView({ id: 'a', checkIns: [TODAY] })]}
        busyId={null}
        onToggle={onToggle}
      />,
    );
    fireEvent.click(screen.getByTestId('habit-garden-checkin-a'));
    // Undo is what makes a confirmation-free check-in safe rather than reckless.
    expect(onToggle).toHaveBeenLastCalledWith('a', false);
  });

  it('locks only the chip whose write is in flight', () => {
    render(
      <CheckInBar
        views={[makeView({ id: 'a' }), makeView({ id: 'b' })]}
        busyId="a"
        onToggle={noop}
      />,
    );

    expect((screen.getByTestId('habit-garden-checkin-a') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('habit-garden-checkin-b') as HTMLButtonElement).disabled).toBe(
      false,
    );
  });
});

describe('EmptyGarden', () => {
  it('offers suggestions without any statistics', () => {
    render(<EmptyGarden suggestions={['물 마시기', '독서']} busy={false} onAdd={noop} />);

    expect(screen.getByText('아직 심은 것이 없어요.')).toBeTruthy();
    expect(screen.getByText('물 마시기')).toBeTruthy();
    // A 0% scoreboard is a discouraging way to open a habit app.
    expect(screen.queryByText(/0%/)).toBeNull();
  });

  it('adds a suggestion on click but never on its own', () => {
    const onAdd = vi.fn();
    render(<EmptyGarden suggestions={['독서']} busy={false} onAdd={onAdd} />);

    expect(onAdd).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('독서'));
    expect(onAdd).toHaveBeenCalledWith('독서');
  });

  it('disables suggestions while a write is in flight', () => {
    render(<EmptyGarden suggestions={['독서']} busy onAdd={noop} />);

    expect((screen.getByText('독서') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('HabitDetail', () => {
  function renderDetail(overrides: Partial<Parameters<typeof HabitDetail>[0]> = {}) {
    const props = {
      view: makeView({ checkIns: lastDayKeys(TODAY, 5) }),
      todayKey: TODAY,
      weeks: 8,
      compact: false,
      deleteArmed: false,
      busy: false,
      onEdit: noop,
      onArmDelete: noop,
      onConfirmDelete: noop,
      onCancelDelete: noop,
      onClose: noop,
      ...overrides,
    };
    return render(<HabitDetail {...props} />);
  }

  it('shows current and best streaks and a heatmap', () => {
    renderDetail();

    expect(screen.getByText('현재')).toBeTruthy();
    expect(screen.getByText('최장')).toBeTruthy();
    expect(screen.getByTestId('habit-garden-heatmap')).toBeTruthy();
  });

  it('describes a weekly cadence in words', () => {
    renderDetail({
      view: makeView({ cadence: { kind: 'weekly', timesPerWeek: 3 } }),
    });

    expect(screen.getByText('주 3회')).toBeTruthy();
  });

  it('keeps the accumulated best streak visible after a lapse', () => {
    // The point of separating stage from vitality, shown on screen: a bad week
    // must not erase the record.
    renderDetail({ view: makeView({ checkIns: lastDayKeys('2026-08-10', 12) }) });

    const stats = screen.getByText('최장').parentElement as HTMLElement;
    expect(within(stats).getByText('12')).toBeTruthy();
  });

  it('requires arming before the destructive confirm appears', () => {
    const onArmDelete = vi.fn();
    const { rerender } = renderDetail({ onArmDelete });

    expect(screen.queryByTestId('habit-garden-delete-confirm')).toBeNull();
    fireEvent.click(screen.getByTestId('habit-garden-delete'));
    expect(onArmDelete).toHaveBeenCalled();

    rerender(
      <HabitDetail
        view={makeView()}
        todayKey={TODAY}
        weeks={8}
        compact={false}
        deleteArmed
        busy={false}
        onEdit={noop}
        onArmDelete={noop}
        onConfirmDelete={noop}
        onCancelDelete={noop}
        onClose={noop}
      />,
    );
    expect(screen.getByTestId('habit-garden-delete-confirm')).toBeTruthy();
  });

  it('wires edit, confirm, cancel and close', () => {
    const onEdit = vi.fn();
    const onConfirmDelete = vi.fn();
    const onCancelDelete = vi.fn();
    const onClose = vi.fn();
    renderDetail({ deleteArmed: true, onEdit, onConfirmDelete, onCancelDelete, onClose });

    fireEvent.click(screen.getByText('편집'));
    fireEvent.click(screen.getByTestId('habit-garden-delete-confirm-yes'));
    fireEvent.click(screen.getByText('취소'));
    fireEvent.click(screen.getByLabelText('닫기'));

    expect(onEdit).toHaveBeenCalled();
    expect(onConfirmDelete).toHaveBeenCalled();
    expect(onCancelDelete).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('shows a dash instead of a fabricated rate when there is nothing to divide', () => {
    renderDetail({ weeks: 0 });

    expect(screen.getByText('—')).toBeTruthy();
  });
});

describe('HabitEditor', () => {
  const baseDraft: HabitDraft = {
    id: null,
    name: '',
    cadenceKind: 'daily',
    timesPerWeek: 3,
    color: HABIT_COLORS[0],
  };

  it('blocks submission until a name is entered', () => {
    const onSubmit = vi.fn();
    const { rerender } = render(
      <HabitEditor
        draft={baseDraft}
        busy={false}
        onChange={noop}
        onSubmit={onSubmit}
        onCancel={noop}
      />,
    );

    expect((screen.getByTestId('habit-garden-editor-submit') as HTMLButtonElement).disabled).toBe(
      true,
    );

    rerender(
      <HabitEditor
        draft={{ ...baseDraft, name: '독서' }}
        busy={false}
        onChange={noop}
        onSubmit={onSubmit}
        onCancel={noop}
      />,
    );
    fireEvent.click(screen.getByTestId('habit-garden-editor-submit'));
    expect(onSubmit).toHaveBeenCalled();
  });

  it('rejects a whitespace-only name', () => {
    render(
      <HabitEditor
        draft={{ ...baseDraft, name: '   ' }}
        busy={false}
        onChange={noop}
        onSubmit={noop}
        onCancel={noop}
      />,
    );

    expect((screen.getByTestId('habit-garden-editor-submit') as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('reports name, cadence and colour changes', () => {
    const onChange = vi.fn();
    render(
      <HabitEditor
        draft={baseDraft}
        busy={false}
        onChange={onChange}
        onSubmit={noop}
        onCancel={noop}
      />,
    );

    fireEvent.change(screen.getByTestId('habit-garden-editor-name'), {
      target: { value: '명상' },
    });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ name: '명상' }));

    fireEvent.click(screen.getByTestId('habit-garden-editor-weekly'));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ cadenceKind: 'weekly' }));

    fireEvent.click(screen.getByLabelText(`색 ${HABIT_COLORS[2]}`));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ color: HABIT_COLORS[2] }));
  });

  it('offers a per-week count only for a weekly cadence', () => {
    const { rerender } = render(
      <HabitEditor
        draft={baseDraft}
        busy={false}
        onChange={noop}
        onSubmit={noop}
        onCancel={noop}
      />,
    );
    expect(screen.queryByLabelText('주당 횟수')).toBeNull();

    rerender(
      <HabitEditor
        draft={{ ...baseDraft, cadenceKind: 'weekly' }}
        busy={false}
        onChange={noop}
        onSubmit={noop}
        onCancel={noop}
      />,
    );
    expect(screen.getByLabelText('주당 횟수')).toBeTruthy();
  });

  it('labels the button by whether it is creating or editing', () => {
    const { rerender } = render(
      <HabitEditor
        draft={{ ...baseDraft, name: 'x' }}
        busy={false}
        onChange={noop}
        onSubmit={noop}
        onCancel={noop}
      />,
    );
    expect(screen.getByTestId('habit-garden-editor-submit').textContent).toBe('심기');

    rerender(
      <HabitEditor
        draft={{ ...baseDraft, id: 'a', name: 'x' }}
        busy={false}
        onChange={noop}
        onSubmit={noop}
        onCancel={noop}
      />,
    );
    expect(screen.getByTestId('habit-garden-editor-submit').textContent).toBe('저장');
  });

  it('cancels without submitting', () => {
    const onCancel = vi.fn();
    const onSubmit = vi.fn();
    render(
      <HabitEditor
        draft={{ ...baseDraft, name: 'x' }}
        busy={false}
        onChange={noop}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />,
    );

    fireEvent.click(screen.getByText('취소'));
    expect(onCancel).toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('SettingsPanel', () => {
  it('shows both switches with room reflection off by default', () => {
    render(
      <SettingsPanel
        state={DEFAULT_HABIT_GARDEN_STATE}
        busy={false}
        onChange={noop}
        onBack={noop}
      />,
    );

    expect((screen.getByTestId('habit-garden-toggle-room') as HTMLInputElement).checked).toBe(
      false,
    );
    expect((screen.getByTestId('habit-garden-toggle-aoi') as HTMLInputElement).checked).toBe(true);
  });

  it('reports each toggle change independently', () => {
    const onChange = vi.fn();
    render(
      <SettingsPanel
        state={DEFAULT_HABIT_GARDEN_STATE}
        busy={false}
        onChange={onChange}
        onBack={noop}
      />,
    );

    fireEvent.click(screen.getByTestId('habit-garden-toggle-room'));
    expect(onChange).toHaveBeenLastCalledWith({ reflectWeatherInRoom: true });

    fireEvent.click(screen.getByTestId('habit-garden-toggle-aoi'));
    expect(onChange).toHaveBeenLastCalledWith({ shareMomentumWithAoi: false });
  });

  it('states that the agent cannot flip either switch', () => {
    render(
      <SettingsPanel
        state={DEFAULT_HABIT_GARDEN_STATE}
        busy={false}
        onChange={noop}
        onBack={noop}
      />,
    );

    expect(screen.getByText(/Agent가 켜거나 끌 수 없습니다/)).toBeTruthy();
  });

  it('explains that only a three-value direction is shared', () => {
    render(
      <SettingsPanel
        state={DEFAULT_HABIT_GARDEN_STATE}
        busy={false}
        onChange={noop}
        onBack={noop}
      />,
    );

    expect(screen.getByText(/growing \/ steady \/ slipping/)).toBeTruthy();
  });

  it('returns to the garden', () => {
    const onBack = vi.fn();
    render(
      <SettingsPanel
        state={DEFAULT_HABIT_GARDEN_STATE}
        busy={false}
        onChange={noop}
        onBack={onBack}
      />,
    );

    fireEvent.click(screen.getByLabelText('정원으로'));
    expect(onBack).toHaveBeenCalled();
  });
});
