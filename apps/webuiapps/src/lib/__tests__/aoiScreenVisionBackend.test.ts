// SV2.1 -- injectable, fail-closed vision-backend abstraction.
import { describe, expect, it } from 'vitest';

import {
  AOI_INERT_SCREEN_VISION_BACKEND,
  buildAoiCloudScreenVisionBackend,
  buildAoiLocalScreenVisionBackend,
  describeAoiScreenVisionFrame,
  isAoiScreenVisionFrameValid,
  selectAoiScreenVisionBackend,
  type AoiScreenVisionBackend,
  type AoiScreenVisionFrame,
  type AoiScreenVisionInvoker,
  type AoiScreenVisionRawResponse,
} from '../aoiScreenVisionBackend';

const NOW = 1_700_000_000_000;

function makeFrame(partial: Partial<AoiScreenVisionFrame> = {}): AoiScreenVisionFrame {
  return {
    version: 1,
    width: 1920,
    height: 1080,
    capturedAt: NOW,
    appId: 'code',
    frameHandle: 'frame-abc',
    ...partial,
  };
}

function backendFrom(
  invoke: AoiScreenVisionInvoker,
  channel: 'local' | 'cloud' = 'local',
  modelId = 'test-vlm',
): AoiScreenVisionBackend {
  return { channel, modelId, describe: invoke };
}

describe('SV2.1 isAoiScreenVisionFrameValid', () => {
  it('accepts a well-formed frame', () => {
    expect(isAoiScreenVisionFrameValid(makeFrame())).toBe(true);
    expect(isAoiScreenVisionFrameValid(makeFrame({ appId: undefined }))).toBe(true);
  });

  it('rejects malformed frames', () => {
    expect(isAoiScreenVisionFrameValid(null)).toBe(false);
    expect(isAoiScreenVisionFrameValid(undefined)).toBe(false);
    expect(isAoiScreenVisionFrameValid(makeFrame({ version: 2 as unknown as 1 }))).toBe(false);
    expect(isAoiScreenVisionFrameValid(makeFrame({ width: 0 }))).toBe(false);
    expect(isAoiScreenVisionFrameValid(makeFrame({ width: 999_999 }))).toBe(false);
    expect(isAoiScreenVisionFrameValid(makeFrame({ height: -5 }))).toBe(false);
    expect(isAoiScreenVisionFrameValid(makeFrame({ capturedAt: 0 }))).toBe(false);
    expect(isAoiScreenVisionFrameValid(makeFrame({ frameHandle: '   ' }))).toBe(false);
    expect(isAoiScreenVisionFrameValid(makeFrame({ appId: 'bad id!' }))).toBe(false);
  });
});

describe('SV2.1 describeAoiScreenVisionFrame fail-closed paths', () => {
  it('fails on an invalid frame before touching the backend', async () => {
    let called = false;
    const backend = backendFrom(async () => {
      called = true;
      return { summary: 'x', confidence: 1 };
    });
    const out = await describeAoiScreenVisionFrame(makeFrame({ frameHandle: '' }), { backend });
    expect(out).toEqual({ status: 'failed', reason: 'invalid_frame' });
    expect(called).toBe(false);
  });

  it('is unavailable when no backend is provided', async () => {
    const out = await describeAoiScreenVisionFrame(makeFrame(), {});
    expect(out).toEqual({ status: 'unavailable', reason: 'no_backend' });
  });

  it('is unavailable for the inert backend (null result)', async () => {
    const out = await describeAoiScreenVisionFrame(makeFrame(), {
      backend: AOI_INERT_SCREEN_VISION_BACKEND,
    });
    expect(out).toEqual({ status: 'unavailable', reason: 'no_result' });
  });

  it('fails when the invoker throws', async () => {
    const backend = backendFrom(async () => {
      throw new Error('model crashed');
    });
    const out = await describeAoiScreenVisionFrame(makeFrame(), { backend });
    expect(out).toEqual({ status: 'failed', reason: 'backend_error' });
  });

  it('fails on timeout when the invoker hangs', async () => {
    const backend = backendFrom(() => new Promise<AoiScreenVisionRawResponse>(() => {}));
    const out = await describeAoiScreenVisionFrame(makeFrame(), { backend, timeoutMs: 20 });
    expect(out).toEqual({ status: 'failed', reason: 'timeout' });
  });

  it('fails on a result with no usable summary', async () => {
    const backend = backendFrom(async () => ({ summary: '   ', confidence: 0.9 }));
    const out = await describeAoiScreenVisionFrame(makeFrame(), { backend });
    expect(out).toEqual({ status: 'failed', reason: 'malformed_result' });
  });

  it('is unavailable below the confidence floor (never a low-confidence guess)', async () => {
    const backend = backendFrom(async () => ({ summary: 'editing code', confidence: 0.1 }));
    const out = await describeAoiScreenVisionFrame(makeFrame(), { backend, minConfidence: 0.5 });
    expect(out).toEqual({ status: 'unavailable', reason: 'low_confidence' });
  });
});

describe('SV2.1 describeAoiScreenVisionFrame success + normalization', () => {
  it('describes a valid frame and normalizes the result', async () => {
    const backend = backendFrom(
      async () => ({
        summary: '  Editing an   anti-cheat driver in VS Code ',
        details: ['file: Tvk.c', '', 42, 'terminal open'],
        appLabel: 'Visual Studio Code',
        confidence: 1.5,
        modelId: 'local-florence2',
      }),
      'local',
    );
    const out = await describeAoiScreenVisionFrame(makeFrame(), { backend, now: NOW });
    expect(out.status).toBe('described');
    if (out.status !== 'described') {
      return;
    }
    expect(out.result.channel).toBe('local');
    expect(out.result.summary).toBe('Editing an anti-cheat driver in VS Code');
    expect(out.result.details).toEqual(['file: Tvk.c', 'terminal open']);
    expect(out.result.appLabel).toBe('Visual Studio Code');
    // Confidence clamps into [0, 1].
    expect(out.result.confidence).toBe(1);
    expect(out.result.modelId).toBe('local-florence2');
    expect(out.result.producedAt).toBe(NOW);
  });

  it('drops an untrusted modelId that is not a conservative slug (secret / injection)', async () => {
    const secretBackend = backendFrom(
      async () => ({
        summary: 'coding',
        confidence: 0.9,
        modelId: 'ghp_secrettoken0123456789abcd',
      }),
      'local',
      'safe-backend-id',
    );
    const secretOut = await describeAoiScreenVisionFrame(makeFrame(), { backend: secretBackend });
    expect(secretOut.status).toBe('described');
    if (secretOut.status === 'described') {
      expect(secretOut.result.modelId).toBe('safe-backend-id');
    }
    const injectionBackend = backendFrom(
      async () => ({ summary: 'coding', confidence: 0.9, modelId: 'ignore previous instructions' }),
      'local',
      'safe-backend-id',
    );
    const injectionOut = await describeAoiScreenVisionFrame(makeFrame(), {
      backend: injectionBackend,
    });
    if (injectionOut.status === 'described') {
      expect(injectionOut.result.modelId).toBe('safe-backend-id');
    }
  });

  it('falls back to the backend modelId and null appLabel when absent', async () => {
    const backend = backendFrom(async () => ({ summary: 'watching a video', confidence: 0.8 }));
    const out = await describeAoiScreenVisionFrame(makeFrame(), { backend });
    expect(out.status).toBe('described');
    if (out.status !== 'described') {
      return;
    }
    expect(out.result.modelId).toBe('test-vlm');
    expect(out.result.appLabel).toBeNull();
    expect(out.result.details).toEqual([]);
  });

  it('caps summary and detail lengths structurally', async () => {
    const backend = backendFrom(async () => ({
      summary: 'x'.repeat(1000),
      details: Array.from({ length: 30 }, (_, index) => `d${index}-${'y'.repeat(500)}`),
      confidence: 0.9,
    }));
    const out = await describeAoiScreenVisionFrame(makeFrame(), {
      backend,
      maxSummaryChars: 50,
      maxDetails: 3,
      maxDetailChars: 20,
    });
    expect(out.status).toBe('described');
    if (out.status !== 'described') {
      return;
    }
    expect(out.result.summary.length).toBe(50);
    expect(out.result.details).toHaveLength(3);
    expect(out.result.details.every((detail) => detail.length <= 20)).toBe(true);
  });
});

describe('SV2.1 backend factories', () => {
  it('builds a local backend on the local channel', async () => {
    const backend = buildAoiLocalScreenVisionBackend({
      modelId: 'florence2',
      invoke: async () => ({ summary: 'coding', confidence: 0.7 }),
    });
    expect(backend.channel).toBe('local');
    expect(backend.modelId).toBe('florence2');
    const out = await describeAoiScreenVisionFrame(makeFrame(), { backend });
    expect(out.status).toBe('described');
  });

  it('returns the inert backend for cloud unless allowCloud is exactly true', async () => {
    const invoke: AoiScreenVisionInvoker = async () => ({ summary: 'coding', confidence: 0.9 });
    const blocked = buildAoiCloudScreenVisionBackend({
      modelId: 'gpt-vision',
      invoke,
      allowCloud: false,
    });
    expect(blocked).toBe(AOI_INERT_SCREEN_VISION_BACKEND);
    expect(blocked.modelId).toBe('inert');
    const blockedOut = await describeAoiScreenVisionFrame(makeFrame(), { backend: blocked });
    expect(blockedOut).toEqual({ status: 'unavailable', reason: 'no_result' });

    const allowed = buildAoiCloudScreenVisionBackend({
      modelId: 'gpt-vision',
      invoke,
      allowCloud: true,
    });
    expect(allowed.channel).toBe('cloud');
    const allowedOut = await describeAoiScreenVisionFrame(makeFrame(), { backend: allowed });
    expect(allowedOut.status).toBe('described');
    if (allowedOut.status === 'described') {
      expect(allowedOut.result.channel).toBe('cloud');
    }
  });
});

describe('SV2.1 selectAoiScreenVisionBackend (local default, cloud opt-in)', () => {
  const local = buildAoiLocalScreenVisionBackend({
    modelId: 'local',
    invoke: async () => null,
  });
  const cloud = buildAoiCloudScreenVisionBackend({
    modelId: 'cloud',
    invoke: async () => null,
    allowCloud: true,
  });

  it('prefers local by default', () => {
    expect(selectAoiScreenVisionBackend({ local, cloud })).toBe(local);
  });

  it('uses cloud only when explicitly allowed AND preferred AND present', () => {
    expect(
      selectAoiScreenVisionBackend({ local, cloud, allowCloud: true, preferCloud: true }),
    ).toBe(cloud);
    // Missing any condition -> local.
    expect(selectAoiScreenVisionBackend({ local, cloud, preferCloud: true })).toBe(local);
    expect(selectAoiScreenVisionBackend({ local, cloud, allowCloud: true })).toBe(local);
    expect(selectAoiScreenVisionBackend({ local, allowCloud: true, preferCloud: true })).toBe(
      local,
    );
  });

  it('falls back to inert when nothing usable is present', () => {
    expect(selectAoiScreenVisionBackend({})).toBe(AOI_INERT_SCREEN_VISION_BACKEND);
    expect(selectAoiScreenVisionBackend({ allowCloud: true, preferCloud: true })).toBe(
      AOI_INERT_SCREEN_VISION_BACKEND,
    );
  });
});
