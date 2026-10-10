import { beforeEach, describe, expect, it, vi } from 'vitest';

// The executor talks to the host bridge through these two client calls; the
// tests stand in for the bridge so the coordinate handling can be checked alone.
const client = vi.hoisted(() => ({
  captureAoiHostDesktopWindow: vi.fn(),
  clickAoiHostDesktopPoint: vi.fn(),
}));

vi.mock('./aoiHostBridgeClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./aoiHostBridgeClient')>()),
  captureAoiHostDesktopWindow: client.captureAoiHostDesktopWindow,
  clickAoiHostDesktopPoint: client.clickAoiHostDesktopPoint,
}));

import {
  capturePointToWindowPoint,
  clampDesktopCaptureLongSide,
  DESKTOP_CAPTURE_MAX_LONG_SIDE,
  DESKTOP_CAPTURE_MAX_SHORT_SIDE,
  executeDesktopInputTool,
  forgetDesktopCaptureGeometry,
  getDesktopCaptureGeometry,
  pruneDesktopCaptureImages,
  rememberDesktopCaptureGeometry,
  setDesktopObservationDelays,
} from './aoiDesktopInputTools';

const HWND = '0x1a2b';

// A 1200x800 window pictured at half size.
const halfSizeCapture = {
  snapshotId: 'dis-0a1b2c3d',
  mode: 'plain',
  width: 600,
  height: 400,
  scale: 0.5,
  windowWidth: 1200,
  windowHeight: 800,
  totalElements: 0,
  elements: [],
  dataUrl: 'data:image/png;base64,AAAA',
};

const deliveredUnverified = {
  ok: true,
  effect: 'unverifiable',
  verified: false,
  path: 'background',
  detail: 'click posted',
};

beforeEach(() => {
  // These tests are about where a point lands, not the look after it.
  setDesktopObservationDelays([]);
  forgetDesktopCaptureGeometry();
  client.captureAoiHostDesktopWindow.mockReset();
  client.clickAoiHostDesktopPoint.mockReset();
});

describe('desktop_click_point', () => {
  it('refuses a point before any picture of that window was taken', async () => {
    const result = await executeDesktopInputTool('desktop_click_point', {
      hwnd: HWND,
      x: 10,
      y: 10,
    });
    expect(result).toMatchObject({ status: 'not_performed' });
    expect(JSON.stringify(result)).toContain('desktop_capture');
    expect(client.clickAoiHostDesktopPoint).not.toHaveBeenCalled();
  });

  it('reads the point off the last capture and sends window pixels', async () => {
    // It used to be refused outright for lacking a ref it never takes.
    client.captureAoiHostDesktopWindow.mockResolvedValue(halfSizeCapture);
    client.clickAoiHostDesktopPoint.mockResolvedValue(deliveredUnverified);

    await executeDesktopInputTool('desktop_capture', { hwnd: HWND, mode: 'plain' });
    const result = await executeDesktopInputTool('desktop_click_point', {
      hwnd: HWND,
      x: 100,
      y: 40,
      clicks: 2,
    });

    expect(client.clickAoiHostDesktopPoint).toHaveBeenCalledWith({
      hwnd: HWND,
      x: 200,
      y: 80,
      space: 'window',
      windowWidth: 1200,
      windowHeight: 800,
      clicks: 2,
    });
    expect(result).toMatchObject({ status: 'delivered_unverified' });
  });

  it('refuses a point that is not on the picture', async () => {
    client.captureAoiHostDesktopWindow.mockResolvedValue(halfSizeCapture);
    await executeDesktopInputTool('desktop_capture', { hwnd: HWND });

    const result = await executeDesktopInputTool('desktop_click_point', {
      hwnd: HWND,
      x: 600,
      y: 5,
    });
    expect(result).toMatchObject({ status: 'not_performed' });
    expect(JSON.stringify(result)).toContain('600x400');
    expect(client.clickAoiHostDesktopPoint).not.toHaveBeenCalled();
  });

  it('sends the model back to look when the window was resized since the picture', async () => {
    client.captureAoiHostDesktopWindow.mockResolvedValue(halfSizeCapture);
    client.clickAoiHostDesktopPoint.mockResolvedValue({
      ok: false,
      effect: 'suspected_noop',
      verified: false,
      code: 'window_changed',
      detail: 'the window was resized after it was captured',
    });
    await executeDesktopInputTool('desktop_capture', { hwnd: HWND });

    const result = await executeDesktopInputTool('desktop_click_point', {
      hwnd: HWND,
      x: 10,
      y: 10,
    });
    expect(result).toMatchObject({ status: 'stale' });
    expect((result as { note: string }).note).toContain('Capture it again');
  });

  it('still requires both coordinates', async () => {
    const result = await executeDesktopInputTool('desktop_click_point', { hwnd: HWND, x: 10 });
    expect(result).toMatchObject({ status: 'not_performed' });
  });
});

describe('desktop_capture', () => {
  it('keeps the picture inside every provider resize threshold', async () => {
    client.captureAoiHostDesktopWindow.mockResolvedValue(halfSizeCapture);
    await executeDesktopInputTool('desktop_capture', { hwnd: HWND, max_long_side: 4096 });
    expect(client.captureAoiHostDesktopWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        maxLongSide: DESKTOP_CAPTURE_MAX_LONG_SIDE,
        maxShortSide: DESKTOP_CAPTURE_MAX_SHORT_SIDE,
      }),
    );
  });

  it('does not say a window has no controls when the plain picture was asked for', async () => {
    client.captureAoiHostDesktopWindow.mockResolvedValue({
      ...halfSizeCapture,
      totalElements: 1,
      elements: [
        { ref: 1, role: 'button', name: 'OK', automationId: 'ok', enabled: true, sensitive: false },
      ],
    });
    const result = (await executeDesktopInputTool('desktop_capture', {
      hwnd: HWND,
      mode: 'plain',
    })) as { note: string };
    expect(result.note).toContain('as asked');
    expect(result.note).not.toContain('does not describe its controls');
    expect(result.note).toContain('0-599 across');
  });

  it('does not remember a picture the model never received', async () => {
    client.captureAoiHostDesktopWindow.mockResolvedValue(halfSizeCapture);
    await executeDesktopInputTool('desktop_capture', { hwnd: HWND, canSeeImages: false });
    expect(getDesktopCaptureGeometry(HWND)).toBeNull();
  });
});

describe('capture geometry', () => {
  const geometry = {
    scale: 0.5,
    imageWidth: 600,
    imageHeight: 400,
    windowWidth: 1200,
    windowHeight: 800,
  };

  it('maps a picture point back to window pixels and refuses one off the picture', () => {
    expect(capturePointToWindowPoint(geometry, 0, 0)).toEqual({ x: 0, y: 0 });
    expect(capturePointToWindowPoint(geometry, 599.9, 399.9)).toEqual({ x: 1199, y: 799 });
    expect(capturePointToWindowPoint(geometry, -1, 5)).toBeNull();
    expect(capturePointToWindowPoint(geometry, 5, 400)).toBeNull();
    expect(capturePointToWindowPoint(geometry, Number.NaN, 5)).toBeNull();
  });

  it('derives the window size from the scale for a helper that does not report it', () => {
    rememberDesktopCaptureGeometry(HWND, {
      width: 600,
      height: 400,
      scale: 0.5,
      windowWidth: 0,
      windowHeight: 0,
    });
    expect(getDesktopCaptureGeometry(HWND)).toEqual(geometry);
    // A capture with no picture size is not something a point can be read off.
    rememberDesktopCaptureGeometry('0x2', {
      width: 0,
      height: 0,
      scale: 1,
      windowWidth: 0,
      windowHeight: 0,
    });
    expect(getDesktopCaptureGeometry('0x2')).toBeNull();
  });

  it('clamps the requested long side into the safe range', () => {
    expect(clampDesktopCaptureLongSide(4096)).toBe(DESKTOP_CAPTURE_MAX_LONG_SIDE);
    expect(clampDesktopCaptureLongSide(50)).toBe(200);
    expect(clampDesktopCaptureLongSide(1000.4)).toBe(1000);
    expect(clampDesktopCaptureLongSide(Number.NaN)).toBe(1200);
  });
});

describe('pruneDesktopCaptureImages', () => {
  interface TestMessage {
    role: string;
    content: string;
    attachments?: { id: string }[];
  }

  function picture(id: string): TestMessage {
    return {
      role: 'user',
      content: 'Screenshot from desktop_capture:',
      attachments: [{ id: `desktop-capture-${id}` }],
    };
  }

  it('keeps the newest pictures and swaps older ones for a sentence', () => {
    const messages: TestMessage[] = [
      picture('a'),
      { role: 'tool', content: 'result' },
      picture('b'),
      picture('c'),
      picture('d'),
    ];
    const pruned = pruneDesktopCaptureImages(messages, 3, 0);

    expect(pruned).toHaveLength(messages.length);
    expect(pruned[0].attachments).toBeUndefined();
    expect(pruned[0].content).toContain('removed to save space');
    expect(pruned.slice(2).map((message) => message.attachments?.[0].id)).toEqual([
      'desktop-capture-b',
      'desktop-capture-c',
      'desktop-capture-d',
    ]);
    // The input list is not mutated.
    expect(messages[0].attachments).toHaveLength(1);
  });

  it('waits for slack to build up so the prompt cache is not rewritten on every capture', () => {
    const four = [picture('a'), picture('b'), picture('c'), picture('d')];
    // keep 3 + slack 3: a fourth picture changes nothing yet.
    expect(pruneDesktopCaptureImages(four)).toBe(four);
    const seven = [...four, picture('e'), picture('f'), picture('g')];
    const pruned = pruneDesktopCaptureImages(seven);
    expect(
      pruned.filter((message) => message.attachments).map((m) => m.attachments?.[0].id),
    ).toEqual(['desktop-capture-e', 'desktop-capture-f', 'desktop-capture-g']);
  });

  it('leaves attachments that are not desktop pictures alone', () => {
    const mixed = {
      role: 'user',
      content: 'Two pictures',
      attachments: [{ id: 'desktop-capture-old' }, { id: 'user-upload-1' }],
    };
    const [pruned] = pruneDesktopCaptureImages([mixed, picture('new')], 1, 0);
    expect(pruned.attachments).toEqual([{ id: 'user-upload-1' }]);
  });
});

describe('terminal windows', () => {
  it('points a refused terminal input at the approved spawn route', async () => {
    const { describeDesktopActVerdict } = await import('./aoiDesktopInputTools');
    const result = describeDesktopActVerdict({
      ok: false,
      effect: 'suspected_noop',
      verified: false,
      code: 'terminal_input_refused',
      detail: 'that window is a terminal',
    });
    expect(result.status).toBe('not_performed');
    expect(result.note).toContain('host_process_spawn_preview');
    expect(result.note).toContain('Nothing was typed');
  });
});
