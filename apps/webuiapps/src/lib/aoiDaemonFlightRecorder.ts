import type { AoiAutonomyBackgroundCycleResult } from './aoiAutonomyBackgroundRunner';
import {
  recordAoiOperatorFlightRecord,
  type AoiOperatorFlightRecordInput,
} from './aoiOperatorFlightRecorder';

// P2.4: the daemon runs Aoi's real 24/7 background sweeps, but until now those
// self-initiated wakeups left no trace in the operator flight recorder -- the
// recorder only ever saw foreground, browser-driven decisions. An operator auditing
// "what did Aoi actually do while I was away" therefore saw nothing for the headless
// path. This module is the missing daemon-side producer: it maps each background
// cycle into flight records so the headless activity is visible in the exact same
// surface as foreground decisions.
//
// Records are emitted only for sessions that actually FIRED a wakeup (sessionsRun)
// or ERRORED -- quiet cooldown cycles (considered-but-not-run) produce nothing, so a
// mostly-idle loop does not flood the recorder with empty ticks. Every emitted record
// is display_only with no action authority (the recorder enforces that on write);
// this is pure audit, never a control surface.

// A background wakeup that fired but surfaced nothing to the operator is honestly a
// 'hidden' lane decision originating from the 'proactive_scheduler' signal; a cycle
// error for a real session is a 'blocked' lane decision.
const DAEMON_CYCLE_SIGNAL_CLASS = 'proactive_scheduler';

// Map one completed background cycle to the flight-record inputs it should leave
// behind. Pure (no I/O) so the mapping contract is unit-testable in isolation.
export function buildAoiDaemonCycleFlightRecordInputs(
  result: AoiAutonomyBackgroundCycleResult,
): AoiOperatorFlightRecordInput[] {
  const createdAt = result.startedAt;
  const inputs: AoiOperatorFlightRecordInput[] = [];

  for (const sessionPath of result.sessionsRun) {
    inputs.push({
      sessionPath,
      createdAt,
      signalClass: DAEMON_CYCLE_SIGNAL_CLASS,
      decisionLane: 'hidden',
      whyQuiet: ['daemon background cycle fired a self-initiated wakeup'],
      mutationCount: 0,
    });
  }

  for (const failure of result.errors) {
    // The sweep uses '*' as a sentinel sessionPath for a whole-sweep failure (e.g.
    // listSessions threw); that is not a real session, so skip it -- the recorder
    // would reject it anyway (invalid sessionPath -> normalize returns null).
    if (!failure.sessionPath || failure.sessionPath === '*') {
      continue;
    }
    inputs.push({
      sessionPath: failure.sessionPath,
      createdAt,
      signalClass: DAEMON_CYCLE_SIGNAL_CLASS,
      decisionLane: 'blocked',
      whyQuiet: [`daemon background cycle error: ${failure.error}`],
      mutationCount: 0,
    });
  }

  return inputs;
}

// Persist the flight records for one cycle. Best-effort per record: a single failed
// write is swallowed so a recorder problem can never stall or crash the background
// loop. The writer is injectable so tests can assert the mapping without touching
// disk. Returns the count actually written.
export function recordAoiDaemonCycleFlightRecords(
  sessionsDir: string,
  result: AoiAutonomyBackgroundCycleResult,
  now?: number,
  record: typeof recordAoiOperatorFlightRecord = recordAoiOperatorFlightRecord,
): number {
  const inputs = buildAoiDaemonCycleFlightRecordInputs(result);
  let recorded = 0;
  for (const input of inputs) {
    try {
      record(sessionsDir, input, now);
      recorded += 1;
    } catch {
      // Best-effort audit: a flight-record write must never break the loop.
    }
  }
  return recorded;
}
