// P2.1: the session-level proactive-push pipeline, tying the pieces into one daemon-callable
// step: load the persisted queue -> decide + append each direct_chat candidate (fail-closed per
// the gate) -> drain through the configured transport -> persist the resulting queue.
//
// Every stage is already gated + tested in isolation; this only orchestrates + persists. Off by
// default in practice: with pushOptIn false NOTHING is appended, and with no real transport the
// inert default delivers nothing (records stay pending, capped). So a daemon that calls this each
// wakeup accumulates a bounded pending queue that goes live the moment a webhook URL is configured
// and the operator opts in.
import {
  appendAoiProactivePushRecord,
  decideAoiProactivePushDelivery,
  type AoiProactivePushCandidate,
} from './aoiProactivePushDelivery';
import { loadAoiProactivePushQueue, saveAoiProactivePushQueue } from './aoiAutonomyStore';
import {
  runAoiProactivePushDelivery,
  type AoiProactivePushDeliveryRunResult,
  type AoiProactivePushTransport,
} from './aoiProactivePushTransport';

export interface AoiProactivePushSessionResult extends AoiProactivePushDeliveryRunResult {
  // Ids of candidates the decision gate accepted onto the queue this run.
  appended: string[];
  // Ids of candidates the gate rejected (with the block reasons) -- for observability.
  rejected: { candidateId: string; reasons: string[] }[];
}

export async function runAoiProactivePushForSession(params: {
  sessionsDir: string;
  sessionPath: string;
  candidates: readonly AoiProactivePushCandidate[];
  pushOptIn: boolean;
  budgetAllowed: boolean;
  transport?: AoiProactivePushTransport;
  now: number;
  maxPerRun?: number;
}): Promise<AoiProactivePushSessionResult> {
  let queue = loadAoiProactivePushQueue(params.sessionsDir, params.sessionPath);
  const appended: string[] = [];
  const rejected: { candidateId: string; reasons: string[] }[] = [];

  for (const candidate of params.candidates ?? []) {
    const decision = decideAoiProactivePushDelivery({
      candidate,
      pushOptIn: params.pushOptIn,
      budgetAllowed: params.budgetAllowed,
      now: params.now,
    });
    if (decision.eligible && decision.record) {
      queue = appendAoiProactivePushRecord(queue, decision.record);
      appended.push(decision.record.id);
    } else {
      rejected.push({ candidateId: candidate.id, reasons: decision.blockReasons });
    }
  }

  const runResult = await runAoiProactivePushDelivery({
    queue,
    transport: params.transport,
    now: params.now,
    maxPerRun: params.maxPerRun,
  });
  saveAoiProactivePushQueue(params.sessionsDir, params.sessionPath, runResult.queue);

  return { ...runResult, appended, rejected };
}
