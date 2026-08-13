import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  AoiAutonomySchedulerState,
  AoiAutonomyStatus,
  AoiProposal,
} from '@/lib/aoiAutonomyTypes';
import type { AoiClosedLoopMetricsReport } from '@/lib/aoiClosedLoopMetrics';
import type { AoiUnifiedOperatorSnapshotSummary } from '@/lib/aoiUnifiedOperatorModel';

import PanelShell, { StatusBadge } from '../components/PanelShell';
import SectionRail from '../components/SectionRail';
import StatusStrip from '../components/StatusStrip';
import RuntimeSection from '../components/RuntimeSection';
import QueueSection from '../components/QueueSection';
import TimelineSection from '../components/TimelineSection';
import FlightSection from '../components/FlightSection';
import MetricsSection from '../components/MetricsSection';
import type { FlightPayload, PanelState, RuntimePayload, TimelinePayload } from '../types';

// Component coverage for the rendering rules that make this console trustworthy.
// The pure helpers are unit tested separately; what matters here is that the
// components actually WIRE those decisions to the DOM -- an honest formatter
// behind a component that renders an error as an empty list helps nobody.

const NOW = 1_700_000_000_000;
const INTERVAL = 10_000;

afterEach(cleanup);

function noop(): void {
  /* intentionally empty */
}

describe('PanelShell', () => {
  const children = (data: string) => <p>{data}</p>;

  function renderShell(state: PanelState<string>, onRetry?: () => void) {
    return render(
      <PanelShell
        title="Panel"
        state={state}
        now={NOW}
        refreshIntervalMs={INTERVAL}
        onRetry={onRetry}
      >
        {children}
      </PanelShell>,
    );
  }

  it('renders the ready payload', () => {
    renderShell({ kind: 'ready', data: 'payload', fetchedAt: NOW });

    expect(screen.getByText('payload')).toBeTruthy();
  });

  it('shows a loading placeholder before the first read', () => {
    renderShell({ kind: 'idle' });
    expect(screen.getByText('불러오는 중…')).toBeTruthy();

    cleanup();
    renderShell({ kind: 'loading' });
    expect(screen.getByText('불러오는 중…')).toBeTruthy();
  });

  it('renders empty and error with different markers so they cannot be confused', () => {
    const { container: emptyContainer } = renderShell({
      kind: 'empty',
      reason: '활성 제안이 없습니다.',
      fetchedAt: NOW,
    });
    const emptyNode = emptyContainer.querySelector('[data-variant="empty"]');
    expect(emptyNode).not.toBeNull();
    expect(emptyContainer.querySelector('[data-variant="error"]')).toBeNull();
    expect(screen.getByText('활성 제안이 없습니다.')).toBeTruthy();

    cleanup();

    const { container: errorContainer } = renderShell({
      kind: 'error',
      message: 'store unreadable',
      code: 'io_error',
      status: 500,
      fetchedAt: NOW,
    });
    expect(errorContainer.querySelector('[data-variant="error"]')).not.toBeNull();
    expect(errorContainer.querySelector('[data-variant="empty"]')).toBeNull();
  });

  it('exposes the HTTP status and server code on an error', () => {
    renderShell({
      kind: 'error',
      message: 'store unreadable',
      code: 'io_error',
      status: 500,
      fetchedAt: NOW,
    });

    expect(screen.getByText('store unreadable')).toBeTruthy();
    expect(screen.getByText(/HTTP 500/)).toBeTruthy();
    expect(screen.getByText(/io_error/)).toBeTruthy();
  });

  it('labels a transport failure distinctly from an HTTP status', () => {
    renderShell({ kind: 'error', message: 'network down', status: 0, fetchedAt: NOW });

    expect(screen.getByText(/전송 실패/)).toBeTruthy();
  });

  it('offers a retry only when a handler is supplied', () => {
    const onRetry = vi.fn();
    renderShell({ kind: 'error', message: 'boom', fetchedAt: NOW }, onRetry);

    fireEvent.click(screen.getByRole('button', { name: /다시 시도/ }));
    expect(onRetry).toHaveBeenCalledTimes(1);

    cleanup();
    renderShell({ kind: 'error', message: 'boom', fetchedAt: NOW });
    expect(screen.queryByRole('button', { name: /다시 시도/ })).toBeNull();
  });

  it('warns about stale data without hiding it', () => {
    renderShell({ kind: 'ready', data: 'payload', fetchedAt: NOW - 60_000 });

    expect(screen.getByText('STALE')).toBeTruthy();
    // The aged data is still on screen -- blanking it would tell the operator
    // less than showing it with a warning does.
    expect(screen.getByText('payload')).toBeTruthy();
  });

  it('does not warn about staleness on a fresh panel', () => {
    renderShell({ kind: 'ready', data: 'payload', fetchedAt: NOW - 1000 });

    expect(screen.queryByText('STALE')).toBeNull();
  });

  it('renders a subtitle and header actions when given', () => {
    render(
      <PanelShell
        title="Panel"
        subtitle="sub"
        state={{ kind: 'ready', data: 'x', fetchedAt: NOW }}
        now={NOW}
        refreshIntervalMs={INTERVAL}
        actions={<button type="button">act</button>}
      >
        {children}
      </PanelShell>,
    );

    expect(screen.getByText('sub')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'act' })).toBeTruthy();
  });
});

describe('StatusBadge', () => {
  it('carries its tone as a data attribute so styling cannot drift from meaning', () => {
    const { container } = render(<StatusBadge tone="danger" label="NOT RUNNING" pulse />);

    expect(container.querySelector('[data-tone="danger"]')).not.toBeNull();
    expect(container.querySelector('[data-pulse="true"]')).not.toBeNull();
  });
});

describe('SectionRail', () => {
  it('marks the active section and switches on click', () => {
    const onSelect = vi.fn();
    render(<SectionRail activeView="queue" pendingProposalCount={null} onSelect={onSelect} />);

    expect(screen.getByTestId('mission-control-rail-queue').getAttribute('data-active')).toBe(
      'true',
    );
    expect(
      screen.getByTestId('mission-control-rail-runtime').getAttribute('data-active'),
    ).toBeNull();

    fireEvent.click(screen.getByTestId('mission-control-rail-timeline'));
    expect(onSelect).toHaveBeenCalledWith('timeline');
  });

  it('shows a pending badge only for a known non-zero count', () => {
    const { rerender } = render(
      <SectionRail activeView="runtime" pendingProposalCount={3} onSelect={noop} />,
    );
    expect(within(screen.getByTestId('mission-control-rail-queue')).getByText('3')).toBeTruthy();

    // A known zero and an unknown count both render no badge: a confident "0"
    // before the queue has been read would be a claim we cannot support.
    rerender(<SectionRail activeView="runtime" pendingProposalCount={0} onSelect={noop} />);
    expect(within(screen.getByTestId('mission-control-rail-queue')).queryByText('0')).toBeNull();

    rerender(<SectionRail activeView="runtime" pendingProposalCount={null} onSelect={noop} />);
    expect(screen.getByTestId('mission-control-rail-queue').textContent).toBe('Queue');
  });
});

describe('StatusStrip', () => {
  function runtimeState(
    status: 'running' | 'not_running' | 'unreachable' | 'probe_failed',
    snapshot: RuntimePayload['runtime']['snapshot'] = null,
  ): PanelState<RuntimePayload> {
    return {
      kind: 'ready',
      data: { runtime: { status, port: 7333, snapshot } },
      fetchedAt: NOW,
    };
  }

  const SNAPSHOT = {
    status: 'ok' as const,
    uptimeMs: 3 * 3_600_000,
    loopRunning: true,
    cognitionActive: true,
    cyclesCompleted: 412,
    lastCycle: null,
    errorsTotal: 0,
    lastError: null,
  };

  function renderStrip(
    runtime: PanelState<RuntimePayload>,
    sessions: PanelState<Array<{ sessionPath: string; updatedAt: number }>> = {
      kind: 'ready',
      data: [{ sessionPath: 'aoi/space_adventure', updatedAt: NOW - 1000 }],
      fetchedAt: NOW,
    },
    overrides: Partial<Parameters<typeof StatusStrip>[0]> = {},
  ) {
    const props = {
      runtime,
      sessions,
      activeSessionPath: 'aoi/space_adventure',
      autoRefresh: true,
      refreshIntervalMs: INTERVAL,
      refreshing: false,
      now: NOW,
      onSelectSession: noop,
      onToggleAutoRefresh: noop,
      onChangeInterval: noop,
      onManualRefresh: noop,
      ...overrides,
    };
    return render(<StatusStrip {...props} />);
  }

  it('reports a live loop with its uptime and cycle count', () => {
    renderStrip(runtimeState('running', SNAPSHOT));

    expect(screen.getByText('RUNNING')).toBeTruthy();
    expect(screen.getByText('412')).toBeTruthy();
    expect(screen.getByText(/Thinking/)).toBeTruthy();
  });

  it('says the loop is not running when the daemon is confirmed down', () => {
    renderStrip(runtimeState('not_running'));

    expect(screen.getByText('NOT RUNNING')).toBeTruthy();
    expect(screen.getByText(/Start-App\.ps1 -Aoi/)).toBeTruthy();
  });

  it('never presents an unknown runtime as healthy', () => {
    renderStrip(runtimeState('unreachable'));

    expect(screen.getByText('UNREACHABLE')).toBeTruthy();
    expect(screen.queryByText('RUNNING')).toBeNull();
  });

  it('surfaces a probe error instead of a soothing default', () => {
    renderStrip({ kind: 'error', message: '데몬 상태 프로브 실패', fetchedAt: NOW });

    expect(screen.getByText('PROBE FAILED')).toBeTruthy();
    expect(screen.getByText('데몬 상태 프로브 실패')).toBeTruthy();
  });

  it('opens the session picker and reports a selection', () => {
    const onSelectSession = vi.fn();
    renderStrip(
      runtimeState('running', SNAPSHOT),
      {
        kind: 'ready',
        data: [
          { sessionPath: 'aoi/space_adventure', updatedAt: NOW - 1000 },
          { sessionPath: 'aoi/other', updatedAt: NOW - 5000 },
        ],
        fetchedAt: NOW,
      },
      { onSelectSession },
    );

    fireEvent.click(screen.getByTitle('aoi/space_adventure'));
    fireEvent.click(screen.getByText('aoi/other'));

    expect(onSelectSession).toHaveBeenCalledWith('aoi/other');
    // The menu closes after a pick.
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('explains an empty session list inside the picker', () => {
    renderStrip(runtimeState('running', SNAPSHOT), {
      kind: 'empty',
      reason: 'none',
      fetchedAt: NOW,
    });

    fireEvent.click(screen.getByTitle('aoi/space_adventure'));
    expect(screen.getByText('자율 스토어가 초기화된 세션이 없습니다.')).toBeTruthy();
  });

  it('shows the session-list error rather than pretending there are none', () => {
    renderStrip(runtimeState('running', SNAPSHOT), {
      kind: 'error',
      message: '세션 목록을 읽지 못했습니다.',
      fetchedAt: NOW,
    });

    fireEvent.click(screen.getByTitle('aoi/space_adventure'));
    expect(screen.getByText('세션 목록을 읽지 못했습니다.')).toBeTruthy();
  });

  it('drives the refresh controls', () => {
    const onToggleAutoRefresh = vi.fn();
    const onManualRefresh = vi.fn();
    const onChangeInterval = vi.fn();
    renderStrip(runtimeState('running', SNAPSHOT), undefined, {
      onToggleAutoRefresh,
      onManualRefresh,
      onChangeInterval,
    });

    fireEvent.click(screen.getByRole('button', { name: '자동 갱신 일시정지' }));
    expect(onToggleAutoRefresh).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '지금 갱신' }));
    expect(onManualRefresh).toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('갱신 주기'), { target: { value: '30000' } });
    expect(onChangeInterval).toHaveBeenCalledWith(30000);
  });

  it('renders a resume affordance while auto refresh is paused', () => {
    renderStrip(runtimeState('running', SNAPSHOT), undefined, { autoRefresh: false });

    expect(screen.getByRole('button', { name: '자동 갱신 재개' })).toBeTruthy();
  });

  it('falls back to a no-session label when nothing is selected', () => {
    renderStrip(runtimeState('running', SNAPSHOT), undefined, { activeSessionPath: null });

    expect(screen.getByText('세션 없음')).toBeTruthy();
  });
});

describe('RuntimeSection', () => {
  const STATUS: AoiAutonomyStatus = {
    version: 1,
    sessionPath: 'aoi/space_adventure',
    policy: {
      version: 1,
      enabled: true,
      allowNetwork: false,
      previewMode: true,
      level: 'L2',
      proactiveSuggestionsEnabled: true,
      confidenceFloor: 0.5,
      maxActiveProposals: 5,
      maxProposalsPerTick: 2,
      maxProposalsPerDay: 10,
      defaultCooldownMs: 1000,
    } as AoiAutonomyStatus['policy'],
    activeProposalCount: 2,
    archivedProposalCount: 1,
    acceptedProposalCount: 0,
    snoozedProposalCount: 0,
    blockedProposalCount: 1,
    observationCount: 12,
    reflectionCount: 3,
    decisionCount: 4,
    lastTickAt: NOW - 30_000,
    activeTick: false,
    recentObservationCount: 2,
    proposalsCreatedInLastTick: 1,
    activeGoalCount: 1,
    currentGoalTitle: 'Ship the operator console',
    updatedAt: NOW,
  };

  const SNAPSHOT_SUMMARY = {
    version: 1,
    id: 'snap-1',
    sessionPath: 'aoi/space_adventure',
    generatedAt: NOW - 5000,
    topInterestLabels: [],
    readiness: 'amber',
    interruption: 'low',
    blindSpotCount: 2,
    actionAuthority: 'display_only',
    executeAllowed: false,
    summary: 'Two sources are stale.',
    evidenceRefs: [],
    cannotKnow: ['desktop activity is disabled'],
    mutationCount: 0,
  } as AoiUnifiedOperatorSnapshotSummary;

  function renderRuntime(overrides: Partial<Parameters<typeof RuntimeSection>[0]> = {}) {
    const props = {
      runtime: {
        kind: 'ready',
        data: {
          runtime: {
            status: 'running' as const,
            port: 7333,
            snapshot: {
              status: 'ok' as const,
              uptimeMs: 1000,
              loopRunning: true,
              cognitionActive: true,
              cyclesCompleted: 7,
              lastCycle: null,
              errorsTotal: 0,
              lastError: null,
            },
          },
        },
        fetchedAt: NOW,
      } as PanelState<RuntimePayload>,
      status: { kind: 'ready', data: STATUS, fetchedAt: NOW } as PanelState<AoiAutonomyStatus>,
      snapshot: {
        kind: 'ready',
        data: SNAPSHOT_SUMMARY,
        fetchedAt: NOW,
      } as PanelState<AoiUnifiedOperatorSnapshotSummary>,
      scheduler: {
        kind: 'empty',
        reason: '스케줄러 상태가 아직 기록되지 않았습니다.',
        fetchedAt: NOW,
      } as PanelState<AoiAutonomySchedulerState>,
      now: NOW,
      refreshIntervalMs: INTERVAL,
      tickBusy: false,
      canTick: true,
      onManualTick: noop,
      onRetry: noop,
      ...overrides,
    };
    return render(<RuntimeSection {...props} />);
  }

  it('renders daemon, policy and snapshot detail', () => {
    renderRuntime();

    expect(screen.getByText('running')).toBeTruthy();
    expect(screen.getByText('active')).toBeTruthy();
    expect(screen.getByText('L2')).toBeTruthy();
    expect(screen.getByText('on (제안만)')).toBeTruthy();
    expect(screen.getByText('Ship the operator console')).toBeTruthy();
    expect(screen.getByText('Two sources are stale.')).toBeTruthy();
    // The model's own list of what it cannot see is surfaced, not buried.
    expect(screen.getByText('desktop activity is disabled')).toBeTruthy();
  });

  it('raises the dead-daemon banner only when the daemon is confirmed down', () => {
    renderRuntime({
      runtime: {
        kind: 'ready',
        data: { runtime: { status: 'not_running', port: 7333, snapshot: null } },
        fetchedAt: NOW,
      } as PanelState<RuntimePayload>,
    });

    const banner = screen.getByTestId('mission-control-daemon-dead');
    expect(banner.textContent).toContain('Start-App.ps1 -Aoi');
  });

  it('does not raise the banner when the runtime is merely unknown', () => {
    // 'unreachable' is not evidence the daemon is dead, so it must not produce
    // an instruction to go restart it.
    renderRuntime({
      runtime: {
        kind: 'ready',
        data: { runtime: { status: 'unreachable', port: 7333, snapshot: null } },
        fetchedAt: NOW,
      } as PanelState<RuntimePayload>,
    });

    expect(screen.queryByTestId('mission-control-daemon-dead')).toBeNull();
    expect(screen.getByText(/스냅샷을 검증하지 못했습니다/)).toBeTruthy();
  });

  it('reports a daemon error count and its last error', () => {
    renderRuntime({
      runtime: {
        kind: 'ready',
        data: {
          runtime: {
            status: 'running',
            port: 7333,
            snapshot: {
              status: 'ok',
              uptimeMs: 1000,
              loopRunning: false,
              cognitionActive: false,
              cyclesCompleted: 2,
              lastCycle: null,
              errorsTotal: 3,
              lastError: { at: NOW - 1000, message: 'tick exploded' },
            },
          },
        },
        fetchedAt: NOW,
      } as PanelState<RuntimePayload>,
    });

    expect(screen.getByText('stopped')).toBeTruthy();
    expect(screen.getByText(/tick exploded/)).toBeTruthy();
  });

  it('runs a manual tick on click', () => {
    const onManualTick = vi.fn();
    renderRuntime({ onManualTick });

    fireEvent.click(screen.getByTestId('mission-control-manual-tick'));
    expect(onManualTick).toHaveBeenCalledTimes(1);
  });

  it('disables the tick control with no session or while one is running', () => {
    renderRuntime({ canTick: false });
    expect((screen.getByTestId('mission-control-manual-tick') as HTMLButtonElement).disabled).toBe(
      true,
    );

    cleanup();

    renderRuntime({ tickBusy: true });
    expect((screen.getByTestId('mission-control-manual-tick') as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});

describe('QueueSection', () => {
  const PROPOSAL: AoiProposal = {
    version: 1,
    id: 'proposal-1',
    sessionPath: 'aoi/space_adventure',
    status: 'active',
    title: 'Re-read the kernel report',
    body: 'A previous run likely answers this.',
    reason: 'Topic matches a completed research memory.',
    trigger: 'research_followup',
    createdAt: NOW - 60_000,
    updatedAt: NOW - 60_000,
    cooldownKey: 'research:kernel',
    confidence: 0.82,
    risk: 'low',
    requiredAutonomyLevel: 'L2',
    requiresUserApproval: true,
    suggestedTools: ['read_research_artifact'],
    evidenceRefs: ['memory:aoi-memory-001'],
    memoryIds: [],
    artifactRefs: [],
    riskSignals: ['touches the workspace'],
  };

  function renderQueue(overrides: Partial<Parameters<typeof QueueSection>[0]> = {}) {
    const props = {
      proposals: {
        kind: 'ready',
        data: [PROPOSAL],
        fetchedAt: NOW,
      } as PanelState<AoiProposal[]>,
      selectedProposal: null,
      selectedProposalId: null,
      busyProposalId: null,
      now: NOW,
      refreshIntervalMs: INTERVAL,
      compact: false,
      onSelect: noop,
      onDecide: noop,
      onRetry: noop,
      ...overrides,
    };
    return render(<QueueSection {...props} />);
  }

  it('lists proposals with risk and level', () => {
    renderQueue();

    expect(screen.getByText('Re-read the kernel report')).toBeTruthy();
    expect(screen.getByText('low')).toBeTruthy();
    expect(screen.getByText('L2')).toBeTruthy();
  });

  it('selects a row, and clicking the selected row clears the selection', () => {
    const onSelect = vi.fn();
    const { rerender } = renderQueue({ onSelect });

    const list = () => screen.getByTestId('mission-control-proposal-list');
    fireEvent.click(within(list()).getByText('Re-read the kernel report'));
    expect(onSelect).toHaveBeenCalledWith('proposal-1');

    rerender(
      <QueueSection
        proposals={{ kind: 'ready', data: [PROPOSAL], fetchedAt: NOW }}
        selectedProposal={PROPOSAL}
        selectedProposalId="proposal-1"
        busyProposalId={null}
        now={NOW}
        refreshIntervalMs={INTERVAL}
        compact={false}
        onSelect={onSelect}
        onDecide={noop}
        onRetry={noop}
      />,
    );
    // Scoped to the list: the inspector now shows the same title, so an unscoped
    // query would be ambiguous.
    fireEvent.click(within(list()).getByText('Re-read the kernel report'));
    expect(onSelect).toHaveBeenLastCalledWith(null);
  });

  it('renders the inspector with the decision controls', () => {
    const onDecide = vi.fn();
    renderQueue({ selectedProposal: PROPOSAL, selectedProposalId: 'proposal-1', onDecide });

    const inspector = screen.getByTestId('mission-control-proposal-inspector');
    expect(within(inspector).getByText('Topic matches a completed research memory.')).toBeTruthy();
    expect(within(inspector).getByText('APPROVAL REQUIRED')).toBeTruthy();
    expect(within(inspector).getByText('touches the workspace')).toBeTruthy();
    expect(within(inspector).getByText('read_research_artifact')).toBeTruthy();

    fireEvent.click(screen.getByTestId('mission-control-proposal-accept'));
    expect(onDecide).toHaveBeenCalledWith('proposal-1', 'accept');

    fireEvent.click(within(inspector).getByRole('button', { name: /거절/ }));
    expect(onDecide).toHaveBeenLastCalledWith('proposal-1', 'dismiss');

    fireEvent.click(within(inspector).getByRole('button', { name: /보류/ }));
    expect(onDecide).toHaveBeenLastCalledWith('proposal-1', 'snooze');
  });

  it('locks the decision controls while a decision is in flight', () => {
    renderQueue({
      selectedProposal: PROPOSAL,
      selectedProposalId: 'proposal-1',
      busyProposalId: 'proposal-1',
    });

    expect(
      (screen.getByTestId('mission-control-proposal-accept') as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('shows a blocked reason when the proposal carries one', () => {
    renderQueue({
      selectedProposal: { ...PROPOSAL, blockedReason: 'requires L5' },
      selectedProposalId: 'proposal-1',
    });

    expect(screen.getByText('requires L5')).toBeTruthy();
  });

  it('closes the inspector from its header', () => {
    const onSelect = vi.fn();
    renderQueue({ selectedProposal: PROPOSAL, selectedProposalId: 'proposal-1', onSelect });

    fireEvent.click(screen.getByRole('button', { name: '닫기' }));
    expect(onSelect).toHaveBeenCalledWith(null);
  });
});

describe('TimelineSection', () => {
  const EVENTS: TimelinePayload['events'] = [
    {
      version: 1,
      id: 'event-1',
      sessionPath: 'aoi/space_adventure',
      kind: 'proposal_created',
      visibility: 'operator_visible',
      createdAt: NOW - 10_000,
      title: 'Proposal created',
      summary: 'Created a research follow-up',
      redactionState: 'none',
      evidenceRefs: [],
      relatedRefs: [],
      risk: 'low',
    },
    {
      version: 1,
      id: 'event-2',
      sessionPath: 'aoi/space_adventure',
      kind: 'proposal_failed',
      visibility: 'operator_visible',
      createdAt: NOW - 5000,
      title: 'Proposal failed',
      summary: 'Execution failed',
      redactionState: 'none',
      evidenceRefs: [],
      relatedRefs: [],
    },
  ];

  function renderTimeline(overrides: Partial<Parameters<typeof TimelineSection>[0]> = {}) {
    const props = {
      timeline: {
        kind: 'ready',
        data: { events: EVENTS },
        fetchedAt: NOW,
      } as PanelState<TimelinePayload>,
      kindFilter: null,
      now: NOW,
      refreshIntervalMs: INTERVAL,
      onChangeFilter: noop,
      onRetry: noop,
      ...overrides,
    };
    return render(<TimelineSection {...props} />);
  }

  it('lists events and offers a filter built from the kinds present', () => {
    renderTimeline();

    expect(screen.getByText('Created a research follow-up')).toBeTruthy();
    expect(screen.getByText('Execution failed')).toBeTruthy();
    expect(screen.getByText('전체 (2종)')).toBeTruthy();
  });

  it('filters to a single kind', () => {
    renderTimeline({ kindFilter: 'proposal_failed' });

    expect(screen.getByText('Execution failed')).toBeTruthy();
    expect(screen.queryByText('Created a research follow-up')).toBeNull();
  });

  it('distinguishes an empty filter result from an empty store', () => {
    renderTimeline({ kindFilter: 'wakeup_recorded' });

    expect(screen.getByText(/필터 결과가 비어/)).toBeTruthy();
  });

  it('reports a filter change', () => {
    const onChangeFilter = vi.fn();
    renderTimeline({ onChangeFilter });

    fireEvent.change(screen.getByLabelText('이벤트 종류 필터'), {
      target: { value: 'proposal_failed' },
    });
    expect(onChangeFilter).toHaveBeenCalledWith('proposal_failed');

    fireEvent.change(screen.getByLabelText('이벤트 종류 필터'), { target: { value: '' } });
    expect(onChangeFilter).toHaveBeenLastCalledWith(null);
  });

  it('expands a row to the raw payload and collapses it again', () => {
    const { container } = renderTimeline();

    fireEvent.click(screen.getByText('Created a research follow-up'));
    expect(container.querySelector('pre')?.textContent).toContain('proposal_created');

    fireEvent.click(screen.getByText('Created a research follow-up'));
    expect(container.querySelector('pre')).toBeNull();
  });
});

describe('FlightSection', () => {
  const RECORD: FlightPayload['records'][number] = {
    version: 1,
    id: 'flight-1',
    sessionPath: 'aoi/space_adventure',
    createdAt: NOW - 20_000,
    signalClass: 'user_message',
    decisionLane: 'direct_chat',
    sourceStates: [
      {
        sourceId: 'src-1',
        label: 'workspace',
        kind: 'workspace',
        state: 'available',
        freshness: 'stale',
        cannotKnow: [],
        evidenceRefs: [],
      },
    ],
    evidenceRefs: [],
    whySpeak: ['user asked directly'],
    whyQuiet: [],
    preparedActionRefs: [],
    approvalState: { status: 'approved', required: true },
    outcomeRefs: [],
    hardFailCounters: {
      privateLeakCount: 0,
      unauthorizedMutationCount: 0,
      staleCurrentClaimCount: 2,
      approvalBypassCount: 0,
    },
    redaction: {
      replacementCount: 4,
      localPathCount: 1,
      urlCount: 0,
      emailCount: 0,
      privateBodyCount: 3,
      secretCount: 0,
    },
    mutationCount: 0,
    actionAuthority: 'display_only',
  };

  const SUMMARY = {
    version: 1,
    sessionPath: 'aoi/space_adventure',
    generatedAt: NOW,
    totalRecordCount: 1,
    laneCounts: {
      direct_chat: 1,
      hidden: 0,
      dashboard: 0,
      digest: 0,
      approval_request: 0,
      blocked: 0,
    },
    hardFailCounters: RECORD.hardFailCounters,
    latestBlindSpotLabels: ['desktop activity'],
    latestSourceFreshnessGapLabels: [],
    recentRecords: [],
    evidenceRefs: [],
    replayDraftCount: 2,
    mutationCount: 0,
    actionAuthority: 'display_only',
  } as FlightPayload['summary'];

  function renderFlight(payload: FlightPayload) {
    return render(
      <FlightSection
        flight={{ kind: 'ready', data: payload, fetchedAt: NOW }}
        now={NOW}
        refreshIntervalMs={INTERVAL}
        onRetry={noop}
      />,
    );
  }

  it('renders the summary tiles and blind spots', () => {
    renderFlight({ records: [RECORD], summary: SUMMARY });

    expect(screen.getByText('replay drafts')).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
    expect(screen.getByText('desktop activity')).toBeTruthy();
  });

  it('flags hard failures on the collapsed row', () => {
    renderFlight({ records: [RECORD], summary: SUMMARY });

    expect(screen.getByText('hard-fail 1')).toBeTruthy();
    expect(screen.getByText('approved')).toBeTruthy();
  });

  it('expands a record to its reasoning, sources and counters', () => {
    const { container } = renderFlight({ records: [RECORD], summary: SUMMARY });

    fireEvent.click(screen.getByText('user_message'));

    expect(screen.getByText('user asked directly')).toBeTruthy();
    expect(screen.getByText('workspace')).toBeTruthy();
    expect(screen.getByText('stale')).toBeTruthy();
    expect(screen.getByText('4 replacement(s)')).toBeTruthy();

    // The counter label and value are separate text nodes, so match on the
    // rendered list item rather than on a single node's text.
    const counterText = Array.from(container.querySelectorAll('li')).map((li) => li.textContent);
    expect(counterText).toContain('stale current claim count: 2');
    // Zero counters are omitted -- only real failures are shown.
    expect(counterText.some((text) => text?.includes('private leak count'))).toBe(false);
  });

  it('explains a summary with no individual records', () => {
    renderFlight({ records: [], summary: SUMMARY });

    expect(screen.getByText(/개별 레코드가 아직 없습니다/)).toBeTruthy();
  });
});

describe('MetricsSection', () => {
  function report(overrides: Partial<AoiClosedLoopMetricsReport> = {}): AoiClosedLoopMetricsReport {
    return {
      version: 1,
      sessionPath: 'aoi/space_adventure',
      generatedAt: NOW,
      windowMs: 30 * 24 * 3_600_000,
      minSample: 3,
      overall: {
        capability: 'general',
        sampleSize: 10,
        accepted: 8,
        dismissed: 2,
        corrections: 1,
        executions: 5,
        proposalPrecision: 0.8,
        interruptionPrecision: null,
        actionSuccessRate: 0.6,
        memoryRecallQuality: null,
        recallMiss: 0,
        evidenceRefs: [],
      },
      capabilities: [
        {
          capability: 'start_research',
          sampleSize: 2,
          accepted: 1,
          dismissed: 1,
          corrections: 0,
          executions: 0,
          proposalPrecision: null,
          interruptionPrecision: null,
          actionSuccessRate: null,
          memoryRecallQuality: null,
          recallMiss: 0,
          evidenceRefs: [],
        },
      ],
      evidenceRefs: [],
      ...overrides,
    };
  }

  it('renders available ratios as percentages', () => {
    render(
      <MetricsSection
        metrics={{ kind: 'ready', data: report(), fetchedAt: NOW }}
        now={NOW}
        refreshIntervalMs={INTERVAL}
        onRetry={noop}
      />,
    );

    expect(screen.getByText('80.0%')).toBeTruthy();
    expect(screen.getByText('60.0%')).toBeTruthy();
  });

  it('renders an unavailable ratio as insufficient sample, never as zero percent', () => {
    const { container } = render(
      <MetricsSection
        metrics={{ kind: 'ready', data: report(), fetchedAt: NOW }}
        now={NOW}
        refreshIntervalMs={INTERVAL}
        onRetry={noop}
      />,
    );

    expect(screen.getAllByText(/표본 부족/).length).toBeGreaterThan(0);
    expect(screen.queryByText('0.0%')).toBeNull();
    // Marked in the DOM as well, so the styling can make absence look different
    // from a low score rather than merely dimmer.
    expect(container.querySelectorAll('[data-unavailable="true"]').length).toBeGreaterThan(0);
  });

  it('renders the per-capability table with its own sample gating', () => {
    render(
      <MetricsSection
        metrics={{ kind: 'ready', data: report(), fetchedAt: NOW }}
        now={NOW}
        refreshIntervalMs={INTERVAL}
        onRetry={noop}
      />,
    );

    const row = screen.getByRole('row', { name: /start_research/ });
    expect(within(row).getByText('표본 부족 (2/3)')).toBeTruthy();
  });

  it('states the aggregation window and minimum sample', () => {
    render(
      <MetricsSection
        metrics={{ kind: 'ready', data: report(), fetchedAt: NOW }}
        now={NOW}
        refreshIntervalMs={INTERVAL}
        onRetry={noop}
      />,
    );

    expect(screen.getByText(/최소 표본 3건/)).toBeTruthy();
  });
});
