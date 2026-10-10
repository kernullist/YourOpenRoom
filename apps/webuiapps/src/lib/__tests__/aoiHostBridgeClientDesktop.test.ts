import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AoiHostBridgeRequestError,
  AoiHostBridgeTimeoutError,
  actOnAoiHostDesktopElement,
  captureAoiHostDesktopWindow,
  clickAoiHostDesktopPoint,
  listAoiHostDesktopApps,
  listAoiHostDesktopWindows,
  sendAoiHostDesktopWindowInput,
  snapshotAoiHostDesktopWindow,
} from '../aoiHostBridgeClient';

// The desktop calls all go through one route; these pin what each one sends
// and how a reply is read -- the tool layer above only ever sees the views.

function mockFetch(payload: unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => payload });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function sentBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
  return JSON.parse(init.body) as Record<string, unknown>;
}

const actReply = (act: Record<string, unknown>, foregroundAllowed = false) => ({
  ok: true,
  act,
  foregroundAllowed,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('desktop input client', () => {
  it('lists windows and apps, dropping malformed rows', async () => {
    mockFetch({ ok: true, windows: [{ hwnd: '0x1', title: 'Notes', process: 'notes.exe' }, 7] });
    await expect(listAoiHostDesktopWindows()).resolves.toEqual([
      { hwnd: '0x1', title: 'Notes', process: 'notes.exe' },
    ]);

    mockFetch({ ok: true, apps: [{ process: 'notes.exe', windowCount: 2, sampleTitle: 'Notes' }] });
    await expect(listAoiHostDesktopApps()).resolves.toEqual([
      { process: 'notes.exe', windowCount: 2, sampleTitle: 'Notes' },
    ]);
  });

  it('reads a snapshot and treats a malformed entry as one not to touch', async () => {
    const fetchMock = mockFetch({
      ok: true,
      snapshot: {
        snapshotId: 'dis-1',
        totalElements: 5,
        elements: [
          {
            ref: 1,
            role: 'button',
            name: 'OK',
            automationId: 'ok',
            enabled: true,
            sensitive: false,
          },
          { ref: 2, role: 'edit', name: 'Code' },
        ],
      },
    });
    const snapshot = await snapshotAoiHostDesktopWindow('0x1');

    expect(sentBody(fetchMock)).toEqual({ op: 'snapshot', hwnd: '0x1' });
    expect(snapshot.note).toBe('ok');
    // A cut list is never presented as the whole window.
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.elements[1]).toMatchObject({ ref: 2, enabled: false, sensitive: true });
  });

  it('sends a point in window space with the size of the picture it came from', async () => {
    const fetchMock = mockFetch(
      actReply({
        ok: true,
        verdict: { effect: 'unverifiable', verified: false },
        path: ' sendinput ',
        detail: 'clicked',
      }),
    );
    const view = await clickAoiHostDesktopPoint({
      hwnd: '0x1',
      x: 200,
      y: 80,
      space: 'window',
      windowWidth: 1200,
      windowHeight: 800,
      button: 'right',
      clicks: 2,
      delivery: 'foreground',
    });

    expect(sentBody(fetchMock)).toEqual({
      op: 'click',
      hwnd: '0x1',
      x: 200,
      y: 80,
      space: 'window',
      windowWidth: 1200,
      windowHeight: 800,
      button: 'right',
      clicks: 2,
      delivery: 'foreground',
      allowForeground: true,
    });
    expect(view).toMatchObject({ ok: true, effect: 'unverifiable', path: 'sendinput' });
  });

  it('asks for the synthetic rung for a drag, and reads an unknown effect as unproven', async () => {
    const fetchMock = mockFetch(
      actReply(
        {
          ok: false,
          verdict: { effect: 'it-worked', verified: true, code: ' input_blocked ' },
          detail: 'blocked',
        },
        true,
      ),
    );
    const view = await actOnAoiHostDesktopElement({
      op: 'drag',
      hwnd: '0x1',
      ref: 1,
      snapshotId: 'dis-1',
      toRef: 2,
    });

    expect(sentBody(fetchMock)).toMatchObject({ op: 'drag', toRef: 2, allowForeground: true });
    expect(view).toEqual({
      ok: false,
      effect: 'unverifiable',
      verified: true,
      detail: 'blocked',
      foregroundAllowed: true,
      code: 'input_blocked',
    });
  });

  it('defaults an act to invoke, or set_value when a value is given', async () => {
    const fetchMock = mockFetch(actReply({ ok: true, verdict: { effect: 'confirmed' } }));
    await actOnAoiHostDesktopElement({ hwnd: '0x1', ref: 3, snapshotId: 'dis-1', value: 'hi' });
    expect(sentBody(fetchMock)).toEqual({
      op: 'set_value',
      hwnd: '0x1',
      ref: 3,
      snapshotId: 'dis-1',
      value: 'hi',
    });
  });

  it('sends window input, and raising a window always asks for the rung that can', async () => {
    const fetchMock = mockFetch(actReply({ ok: true, verdict: { effect: 'unverifiable' } }));
    await sendAoiHostDesktopWindowInput({ op: 'focus', hwnd: '0x1' });
    expect(sentBody(fetchMock)).toEqual({ op: 'focus', hwnd: '0x1', allowForeground: true });

    const typed = mockFetch(actReply({ ok: true, verdict: { effect: 'unverifiable' } }));
    await sendAoiHostDesktopWindowInput({ op: 'type', hwnd: '0x1', text: '' });
    expect(sentBody(typed)).toEqual({ op: 'type', hwnd: '0x1', text: '' });
  });

  it('passes the capture caps and reads the window size beside the picture', async () => {
    const fetchMock = mockFetch({
      ok: true,
      capture: {
        snapshotId: 'dis-c',
        mode: 'som',
        width: 683,
        height: 384,
        scale: 0.5,
        windowWidth: 1366,
        windowHeight: 768,
        totalElements: 1,
        elements: [{ ref: 1, role: 'button', name: 'OK', sensitive: false, enabled: true }],
        pngBase64: 'AAAA',
      },
    });
    const capture = await captureAoiHostDesktopWindow({
      hwnd: '0x1',
      maxLongSide: 1200,
      maxShortSide: 768,
    });

    expect(sentBody(fetchMock)).toEqual({
      op: 'capture',
      hwnd: '0x1',
      mode: 'som',
      maxLongSide: 1200,
      maxShortSide: 768,
    });
    expect(capture).toMatchObject({
      windowWidth: 1366,
      windowHeight: 768,
      scale: 0.5,
      dataUrl: 'data:image/png;base64,AAAA',
    });

    mockFetch({ ok: true, capture: {} });
    await expect(captureAoiHostDesktopWindow({ hwnd: '0x1' })).resolves.toMatchObject({
      mode: 'plain',
      scale: 1,
      windowWidth: 0,
      dataUrl: '',
    });
  });

  it('turns a bridge that never answers into an outcome-unknown error', async () => {
    vi.useFakeTimers();
    try {
      // A bridge that holds the request open until its deadline aborts it.
      const fetchMock = vi.fn(
        (_url: string, init: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () =>
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
            );
          }),
      );
      vi.stubGlobal('fetch', fetchMock);

      const pending = listAoiHostDesktopWindows().catch((caught: unknown) => caught);
      await vi.advanceTimersByTimeAsync(30_000);
      const error = await pending;

      expect(error).toBeInstanceOf(AoiHostBridgeTimeoutError);
      expect((error as Error).message).toContain('whether the action took effect is unknown');
      expect((error as Error).message).toContain('within 30 s');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not call an abort a timeout unless the deadline fired', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' })),
    );
    const error = await listAoiHostDesktopWindows().catch((caught: unknown) => caught);
    expect(error).not.toBeInstanceOf(AoiHostBridgeTimeoutError);
    expect((error as Error).name).toBe('AbortError');
  });

  it('passes any other transport failure through unchanged', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    await expect(snapshotAoiHostDesktopWindow('0x1')).rejects.toThrow('fetch failed');
  });

  it('keeps a refusal that arrives as the deadline fires a refusal', async () => {
    // The answer lands at the deadline: the route said no, and saying "it may
    // have happened" instead would send the model to ask about an act that
    // never ran.
    vi.useFakeTimers();
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({
          ok: false,
          status: 403,
          json: async () => {
            await vi.advanceTimersByTimeAsync(30_000);
            return { ok: false, error: 'blocked', code: 'capability_disabled' };
          },
        })),
      );
      const error = await listAoiHostDesktopWindows().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AoiHostBridgeRequestError);
      expect(error).not.toBeInstanceOf(AoiHostBridgeTimeoutError);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a refusal from the bridge a refusal, not a timeout', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({ ok: false, error: 'capability_disabled' }),
      }),
    );
    const error = await listAoiHostDesktopWindows().catch((caught: unknown) => caught);
    expect(error).not.toBeInstanceOf(AoiHostBridgeTimeoutError);
    expect((error as Error).message).toContain('capability_disabled');
  });
});
