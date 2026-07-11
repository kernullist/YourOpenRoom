import { describe, expect, it, vi } from 'vitest';

import type { AoiProactivePushDeliveryRecord } from '../aoiProactivePushDelivery';
import {
  createAoiWebhookPushTransport,
  inertAoiProactivePushTransport,
  runAoiProactivePushDelivery,
  type AoiProactivePushTransport,
} from '../aoiProactivePushTransport';

const NOW = 1_800_000_000_000;

function makeRecord(
  partial: Partial<AoiProactivePushDeliveryRecord> = {},
): AoiProactivePushDeliveryRecord {
  return {
    version: 1,
    id: 'push-1',
    sessionPath: 'aoi/default',
    title: 'A trend you care about moved',
    deepLink: 'openroom://aoi/aoi/default?card=c1',
    createdAt: NOW - 1000,
    actionAuthority: 'display_only',
    mutationCount: 0,
    ...partial,
  };
}

const deliveringTransport: AoiProactivePushTransport = {
  async send() {
    return { delivered: true };
  },
};

describe('runAoiProactivePushDelivery (P2.1 transport)', () => {
  it('is inert by default: delivers nothing and consumes nothing (fail closed)', async () => {
    const queue = [makeRecord({ id: 'a' }), makeRecord({ id: 'b' })];
    const result = await runAoiProactivePushDelivery({ queue, now: NOW });
    expect(result.transportConfigured).toBe(false);
    expect(result.delivered).toEqual([]);
    expect(result.failed.map((f) => f.recordId)).toEqual(['a', 'b']);
    expect(result.failed[0].detail).toBe('no_transport_configured');
    // Nothing marked consumed -> both survive for a later run.
    expect(result.queue.every((r) => r.consumedAt === undefined)).toBe(true);
  });

  it('marks a record consumed only when the transport confirms delivery', async () => {
    const queue = [makeRecord({ id: 'a' })];
    const result = await runAoiProactivePushDelivery({
      queue,
      transport: deliveringTransport,
      now: NOW,
    });
    expect(result.transportConfigured).toBe(true);
    expect(result.delivered).toEqual(['a']);
    expect(result.queue.find((r) => r.id === 'a')?.consumedAt).toBe(NOW);
  });

  it('leaves a record pending when the transport declines the send', async () => {
    const transport: AoiProactivePushTransport = {
      async send() {
        return { delivered: false, detail: 'endpoint_gone' };
      },
    };
    const queue = [makeRecord({ id: 'a' })];
    const result = await runAoiProactivePushDelivery({ queue, transport, now: NOW });
    expect(result.delivered).toEqual([]);
    expect(result.failed).toEqual([{ recordId: 'a', delivered: false, detail: 'endpoint_gone' }]);
    expect(result.queue.find((r) => r.id === 'a')?.consumedAt).toBeUndefined();
  });

  it('handles a thrown transport fail-closed (record stays pending)', async () => {
    const transport: AoiProactivePushTransport = {
      async send() {
        throw new Error('network down');
      },
    };
    const queue = [makeRecord({ id: 'a' })];
    const result = await runAoiProactivePushDelivery({ queue, transport, now: NOW });
    expect(result.delivered).toEqual([]);
    expect(result.failed).toEqual([{ recordId: 'a', delivered: false, detail: 'transport_threw' }]);
    expect(result.queue.find((r) => r.id === 'a')?.consumedAt).toBeUndefined();
  });

  it('skips already-consumed records', async () => {
    const send = vi.fn(async () => ({ delivered: true }));
    const queue = [makeRecord({ id: 'done', consumedAt: NOW - 500 }), makeRecord({ id: 'fresh' })];
    const result = await runAoiProactivePushDelivery({ queue, transport: { send }, now: NOW });
    expect(send).toHaveBeenCalledTimes(1);
    expect(result.delivered).toEqual(['fresh']);
  });

  it('caps the number of sends per run', async () => {
    const send = vi.fn(async () => ({ delivered: true }));
    const queue = [makeRecord({ id: 'a' }), makeRecord({ id: 'b' }), makeRecord({ id: 'c' })];
    const result = await runAoiProactivePushDelivery({
      queue,
      transport: { send },
      now: NOW,
      maxPerRun: 2,
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(result.delivered).toEqual(['a', 'b']);
    // The third is untouched (still pending) for the next run.
    expect(result.queue.find((r) => r.id === 'c')?.consumedAt).toBeUndefined();
  });

  it('partitions a mixed batch (some delivered, some declined)', async () => {
    const transport: AoiProactivePushTransport = {
      async send(record) {
        return record.id === 'ok' ? { delivered: true } : { delivered: false, detail: 'nope' };
      },
    };
    const queue = [makeRecord({ id: 'ok' }), makeRecord({ id: 'bad' })];
    const result = await runAoiProactivePushDelivery({ queue, transport, now: NOW });
    expect(result.delivered).toEqual(['ok']);
    expect(result.failed).toEqual([{ recordId: 'bad', delivered: false, detail: 'nope' }]);
  });

  it('defaults the detail to not_delivered when a declining transport gives none', async () => {
    const transport: AoiProactivePushTransport = {
      async send() {
        return { delivered: false };
      },
    };
    const result = await runAoiProactivePushDelivery({
      queue: [makeRecord({ id: 'a' })],
      transport,
      now: NOW,
    });
    expect(result.failed).toEqual([{ recordId: 'a', delivered: false, detail: 'not_delivered' }]);
  });

  it('the exported inert transport reports the fail-closed detail', async () => {
    const result = await inertAoiProactivePushTransport.send(makeRecord());
    expect(result).toEqual({ delivered: false, detail: 'no_transport_configured' });
  });
});

describe('createAoiWebhookPushTransport (P2.1 real channel)', () => {
  it('returns the inert transport when no URL is configured (off by default)', async () => {
    const transport = createAoiWebhookPushTransport({ webhookUrl: '   ' });
    expect(transport).toBe(inertAoiProactivePushTransport);
    expect(await transport.send(makeRecord())).toEqual({
      delivered: false,
      detail: 'no_transport_configured',
    });
  });

  it('POSTs only the display-only fields and reports delivered on a 2xx', async () => {
    const fetchImpl = vi.fn(
      async (
        _url: string,
        _init: { method: string; headers: Record<string, string>; body: string },
      ) => ({
        ok: true,
        status: 200,
      }),
    );
    const transport = createAoiWebhookPushTransport({
      webhookUrl: 'https://hooks.example/aoi',
      fetchImpl,
    });
    const result = await transport.send(makeRecord({ id: 'p-9' }));
    expect(result).toEqual({ delivered: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://hooks.example/aoi');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(body).toEqual({
      id: 'p-9',
      title: 'A trend you care about moved',
      deepLink: 'openroom://aoi/aoi/default?card=c1',
      createdAt: NOW - 1000,
    });
  });

  it('treats a non-2xx response as a non-delivery (record stays pending)', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 503 }));
    const transport = createAoiWebhookPushTransport({
      webhookUrl: 'https://hooks.example/aoi',
      fetchImpl,
    });
    expect(await transport.send(makeRecord())).toEqual({
      delivered: false,
      detail: 'webhook_status_503',
    });
  });

  it('treats a thrown request as a non-delivery (never throws)', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    });
    const transport = createAoiWebhookPushTransport({
      webhookUrl: 'https://hooks.example/aoi',
      fetchImpl,
    });
    expect(await transport.send(makeRecord())).toEqual({
      delivered: false,
      detail: 'webhook_request_failed',
    });
  });

  it('drains a queue through the webhook transport end-to-end', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200 }));
    const transport = createAoiWebhookPushTransport({
      webhookUrl: 'https://hooks.example/aoi',
      fetchImpl,
    });
    const queue = [makeRecord({ id: 'a' }), makeRecord({ id: 'b' })];
    const result = await runAoiProactivePushDelivery({ queue, transport, now: NOW });
    expect(result.transportConfigured).toBe(true);
    expect(result.delivered).toEqual(['a', 'b']);
    expect(result.queue.every((r) => r.consumedAt === NOW)).toBe(true);
  });
});
