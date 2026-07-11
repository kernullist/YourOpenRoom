// P2.1 (transport half): drain the pending proactive-push queue through an out-of-panel
// channel. The decision core (decideAoiProactivePushDelivery) already gates a card and
// produces a display-only queue record; the queue helpers (append/select/markConsumed) are
// pure. What was missing is the CHANNEL that actually emits a queued record to the user
// outside a mounted ChatPanel (web-push / SSE / OS notifier / webhook).
//
// That channel is an EXTERNAL resource that does not exist in this environment, so it is
// modelled as an injected transport with a fail-closed default: the inert transport delivers
// nothing. The delivery pipeline is therefore complete and testable, and becomes live the
// moment a real transport is wired -- without ever delivering (or, worse, marking consumed)
// anything until then.
//
// Safety: a record is marked consumed ONLY when the transport CONFIRMS delivery. An inert
// transport, a declined send, or a thrown transport all leave the record pending, so nothing
// is ever silently dropped; the card survives for a later run once a real channel exists.
import type { AoiProactivePushDeliveryRecord } from './aoiProactivePushDelivery';
import {
  markAoiProactivePushRecordConsumed,
  selectPendingAoiProactivePushRecords,
} from './aoiProactivePushDelivery';

export interface AoiProactivePushSendResult {
  delivered: boolean;
  detail?: string;
}

// The out-of-panel channel. Real implementations (web-push to a service worker, an SSE
// stream, an OS/webhook notifier) are injected; each send resolves to whether the channel
// accepted the record. It must never throw to signal a routine non-delivery -- return
// { delivered: false } -- but a thrown transport is still handled fail-closed.
export interface AoiProactivePushTransport {
  send(record: AoiProactivePushDeliveryRecord): Promise<AoiProactivePushSendResult>;
}

// The fail-closed default: no channel configured, so nothing is delivered and nothing is
// consumed. This is what runs in an environment without a real push endpoint.
export const inertAoiProactivePushTransport: AoiProactivePushTransport = {
  async send() {
    return { delivered: false, detail: 'no_transport_configured' };
  },
};

export interface AoiProactivePushDeliveryOutcome {
  recordId: string;
  delivered: boolean;
  detail?: string;
}

export interface AoiProactivePushDeliveryRunResult {
  // The queue after this run (delivered records marked consumed). The caller persists it.
  queue: AoiProactivePushDeliveryRecord[];
  delivered: string[];
  failed: AoiProactivePushDeliveryOutcome[];
  // False when the inert default ran -- i.e. no real channel is wired in this environment.
  transportConfigured: boolean;
}

const DEFAULT_MAX_PER_RUN = 8;

// Drain the pending push queue through the transport. Pure with respect to the queue (returns
// the next queue rather than mutating in place); the transport is the only side effect and is
// injected. A record is consumed ONLY on a confirmed delivery.
export async function runAoiProactivePushDelivery(params: {
  queue: readonly AoiProactivePushDeliveryRecord[];
  transport?: AoiProactivePushTransport;
  now: number;
  maxPerRun?: number;
}): Promise<AoiProactivePushDeliveryRunResult> {
  const transport = params.transport ?? inertAoiProactivePushTransport;
  const transportConfigured = transport !== inertAoiProactivePushTransport;
  const cap =
    typeof params.maxPerRun === 'number' && params.maxPerRun > 0
      ? params.maxPerRun
      : DEFAULT_MAX_PER_RUN;

  const pending = selectPendingAoiProactivePushRecords(params.queue).slice(0, cap);
  let queue: AoiProactivePushDeliveryRecord[] = [...params.queue];
  const delivered: string[] = [];
  const failed: AoiProactivePushDeliveryOutcome[] = [];

  for (const record of pending) {
    let result: AoiProactivePushSendResult;
    try {
      result = await transport.send(record);
    } catch {
      // A thrown transport is a non-delivery -- leave the record pending for a later run.
      failed.push({ recordId: record.id, delivered: false, detail: 'transport_threw' });
      continue;
    }
    if (result.delivered) {
      queue = markAoiProactivePushRecordConsumed(queue, record.id, params.now);
      delivered.push(record.id);
    } else {
      failed.push({
        recordId: record.id,
        delivered: false,
        detail: result.detail ?? 'not_delivered',
      });
    }
  }

  return { queue, delivered, failed, transportConfigured };
}
