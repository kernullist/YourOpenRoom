// @vitest-environment node
import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { Readable } from 'stream';
import type { IncomingMessage, ServerResponse } from 'http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Capture what the route hands the scheduler instead of running a real wakeup.
const { wakeupCalls } = vi.hoisted(() => ({
  wakeupCalls: [] as Array<{
    budget?: { allowNetwork?: boolean; llmDailyTokenBudget?: number };
    llmConfig?: unknown;
  }>,
}));

vi.mock('../aoiAutonomyScheduler', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../aoiAutonomyScheduler')>();
  return {
    ...actual,
    runAoiAutonomyWakeup: vi.fn(async (input: (typeof wakeupCalls)[number]) => {
      wakeupCalls.push(input);
      return { ok: true };
    }),
  };
});

import { handleAoiAutonomyRequest } from '../aoiAutonomyPlugin';
import { saveAoiAutonomyPolicy } from '../aoiAutonomyStore';

const SESSION_PATH = 'aoi/default';
const LLM_CONFIG = { provider: 'openai', baseUrl: 'https://llm.example.com', model: 'm' };
const CEILING_ENV = 'AOI_AUTONOMY_BACKGROUND_ALLOW_NETWORK';

let root = '';
let savedCeiling: string | undefined;

beforeEach(() => {
  root = fs.mkdtempSync(join(os.tmpdir(), 'aoi-wakeup-route-'));
  wakeupCalls.length = 0;
  savedCeiling = process.env[CEILING_ENV];
  delete process.env[CEILING_ENV];
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  if (savedCeiling === undefined) delete process.env[CEILING_ENV];
  else process.env[CEILING_ENV] = savedCeiling;
});

async function postWakeup(body: Record<string, unknown>): Promise<number> {
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    method: 'POST',
    headers: {},
  }) as unknown as IncomingMessage;
  let status = 0;
  const res = {
    writeHead: (code: number) => {
      status = code;
    },
    end: () => undefined,
  } as unknown as ServerResponse;
  const handled = await handleAoiAutonomyRequest(
    req,
    res,
    new URL('http://127.0.0.1/api/aoi-autonomy/wakeup'),
    root,
    join(root, 'config.json'),
    root,
  );
  expect(handled).toBe(true);
  return status;
}

const wakeupBody = {
  sessionPath: SESSION_PATH,
  reason: 'manual_refresh',
  budget: { allowNetwork: true },
  llmConfig: LLM_CONFIG,
};

describe('POST /api/aoi-autonomy/wakeup network gate', () => {
  it('drops the network grant and the llmConfig when the session policy forbids network', async () => {
    saveAoiAutonomyPolicy(root, SESSION_PATH, { allowNetwork: false });

    expect(await postWakeup(wakeupBody)).toBe(200);

    // The client asked for network; the policy wins, and the reflection must not
    // receive a baseUrl to send memories to.
    expect(wakeupCalls).toHaveLength(1);
    expect(wakeupCalls[0].budget?.allowNetwork).toBe(false);
    expect(wakeupCalls[0].llmConfig).toBeUndefined();
  });

  it('drops both when the deployment ceiling is off, whatever the policy says', async () => {
    saveAoiAutonomyPolicy(root, SESSION_PATH, { allowNetwork: true });
    process.env[CEILING_ENV] = '0';

    expect(await postWakeup(wakeupBody)).toBe(200);

    expect(wakeupCalls[0].budget?.allowNetwork).toBe(false);
    expect(wakeupCalls[0].llmConfig).toBeUndefined();
  });

  it('passes the llmConfig through only when request, policy and ceiling all allow network', async () => {
    saveAoiAutonomyPolicy(root, SESSION_PATH, { allowNetwork: true });

    expect(await postWakeup(wakeupBody)).toBe(200);
    expect(wakeupCalls[0].budget?.allowNetwork).toBe(true);
    expect(wakeupCalls[0].llmConfig).toEqual(LLM_CONFIG);

    // An array is not a config object.
    expect(await postWakeup({ ...wakeupBody, llmConfig: [LLM_CONFIG] })).toBe(200);
    expect(wakeupCalls[1].llmConfig).toBeUndefined();
  });

  it('caps the daily token budget at the one the server runs with', async () => {
    saveAoiAutonomyPolicy(root, SESSION_PATH, { allowNetwork: true });
    const raised = { ...wakeupBody, budget: { allowNetwork: true, llmDailyTokenBudget: 1e12 } };

    expect(await postWakeup(raised)).toBe(200);
    expect(wakeupCalls[0].budget?.llmDailyTokenBudget).toBe(200_000);

    const saved = process.env.AOI_AUTONOMY_LLM_DAILY_TOKEN_BUDGET;
    process.env.AOI_AUTONOMY_LLM_DAILY_TOKEN_BUDGET = '50000';
    try {
      expect(await postWakeup(raised)).toBe(200);
      expect(wakeupCalls[1].budget?.llmDailyTokenBudget).toBe(50_000);
    } finally {
      if (saved === undefined) delete process.env.AOI_AUTONOMY_LLM_DAILY_TOKEN_BUDGET;
      else process.env.AOI_AUTONOMY_LLM_DAILY_TOKEN_BUDGET = saved;
    }
  });
});
