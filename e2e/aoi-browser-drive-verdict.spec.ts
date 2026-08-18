import { test, expect, type Page } from '@playwright/test';

// E2E for the browser-drive semantic verdict reaching the model.
//
// The unit tests pin each layer; this pins that they are actually connected.
// A verdict is computed in the executor, serialized by the daemon, validated in
// the client view, and turned into the tool result the model reads -- and if any
// link in that chain drops it, the model silently goes back to being told
// "the action was performed" on transport success alone, which is the defect the
// whole contract exists to remove.
//
// The browser-drive daemon route is stubbed: driving a real CDP browser is not
// what is under test here, the wiring is.

const CONFIG_KEY = 'webuiapps-llm-config';
const EXECUTE_ROUTE = '**/api/aoi-host/browser-drive/execute';

const PLAN = {
  goal: 'refresh the dashboard',
  steps: [
    { description: 'open', action: { kind: 'navigate', url: 'https://example.com/' } },
    { description: 'click refresh', action: { kind: 'click', selector: '#refresh' } },
  ],
  target_step_index: 1,
};

function toolCallResponse(name: string, args: Record<string, unknown>) {
  return {
    choices: [
      {
        message: {
          content: '',
          tool_calls: [
            { id: 'tc_1', type: 'function', function: { name, arguments: JSON.stringify(args) } },
          ],
        },
      },
    ],
  };
}

function respondResponse(content: string) {
  return {
    choices: [
      {
        message: {
          content: '',
          tool_calls: [
            {
              id: 'tc_2',
              type: 'function',
              function: {
                name: 'respond_to_user',
                arguments: JSON.stringify({
                  character_expression: { content, emotion: 'neutral' },
                  recommended_replies: ['그래', '알겠어', '다시'],
                }),
              },
            },
          ],
        },
      },
    ],
  };
}

// Collects every tool result the model is shown, so the assertions read the same
// bytes the model would.
async function driveBrowserRun(
  page: Page,
  options: {
    verdict?: Record<string, unknown>;
    toolArgs?: Record<string, unknown>;
    onExecuteBody?: (body: Record<string, unknown>) => void;
  },
): Promise<{ toolResults: string[] }> {
  const toolResults: string[] = [];
  let llmCalls = 0;

  await page.addInitScript((configKey) => {
    localStorage.clear();
    localStorage.setItem(
      configKey,
      JSON.stringify({
        provider: 'openai',
        apiKey: 'sk-test',
        baseUrl: 'https://mock-llm.test/v1',
        model: 'gpt-4',
      }),
    );
  }, CONFIG_KEY);
  await page.route('**/api/aoi-autonomy/**', (route) => route.abort());
  await page.route('**/api/kira-automation/**', (route) => route.abort());

  await page.route(EXECUTE_ROUTE, async (route) => {
    options.onExecuteBody?.(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({
      json: {
        ok: true,
        result: {
          ok: true,
          stepIndex: 1,
          target: {
            index: 1,
            category: 'act',
            ok: true,
            finalUrl: 'https://example.com/',
            ...(options.verdict ? { verdict: options.verdict } : {}),
          },
        },
      },
    });
  });

  await page.route('**/api/llm-proxy', async (route) => {
    llmCalls += 1;
    const body = route.request().postDataJSON() as {
      messages?: { role: string; content?: string }[];
    };
    for (const message of body.messages ?? []) {
      if (message.role === 'tool' && typeof message.content === 'string') {
        toolResults.push(message.content);
      }
    }
    if (llmCalls === 1) {
      await route.fulfill({
        json: toolCallResponse('browser_drive_run', options.toolArgs ?? PLAN),
      });
      return;
    }
    await route.fulfill({ json: respondResponse('확인했어.') });
  });

  await page.goto('/');
  await page.getByTestId('chat-input').fill('대시보드 새로고침 실행해줘');
  await page.getByTestId('send-btn').click();
  await expect(page.getByTestId('chat-messages')).toContainText('확인했어.', { timeout: 30_000 });
  return { toolResults };
}

test.describe('browser-drive verdict reaches the model', () => {
  test('a delivered-but-unproven act is never reported as done', async ({ page }) => {
    const { toolResults } = await driveBrowserRun(page, {
      verdict: {
        effect: 'unverifiable',
        verified: false,
        escalation: { recommended: 'fresh_state', reason: 'nothing observable changed' },
      },
    });

    const result = toolResults.find((entry) => entry.includes('step_index'));
    expect(result, 'the run tool result should reach the model').toBeTruthy();
    const parsed = JSON.parse(result as string);
    // ok is transport success and stays true; status follows the verdict.
    expect(parsed.ok).toBe(true);
    expect(parsed.status).toBe('delivered_unverified');
    expect(parsed.effect).toBe('unverifiable');
    expect(parsed.next).toBe('verify_fresh_state');
    expect(parsed.note).toContain('do NOT repeat');
  });

  test('a proven act is reported as done', async ({ page }) => {
    const { toolResults } = await driveBrowserRun(page, {
      verdict: { effect: 'confirmed', verified: true },
    });
    const parsed = JSON.parse(toolResults.find((entry) => entry.includes('step_index')) as string);
    expect(parsed.status).toBe('done');
    expect(parsed.verified).toBe(true);
    expect(parsed.note).toContain('Do not repeat');
  });

  test('a daemon that sends no verdict still does not yield a completion claim', async ({
    page,
  }) => {
    // Older daemon: the chain must degrade to the honest wording, not to "done".
    const { toolResults } = await driveBrowserRun(page, {});
    const parsed = JSON.parse(toolResults.find((entry) => entry.includes('step_index')) as string);
    expect(parsed.ok).toBe(true);
    expect(parsed.status).toBe('delivered_unverified');
    expect(parsed.note).toContain('Nothing here proves it landed');
  });

  test('a malformed verdict is rejected rather than trusted', async ({ page }) => {
    // The daemon response is a trust boundary and this value decides whether the
    // model may say the action happened.
    const { toolResults } = await driveBrowserRun(page, {
      verdict: { effect: 'totally-done', verified: 'yes' },
    });
    const parsed = JSON.parse(toolResults.find((entry) => entry.includes('step_index')) as string);
    expect(parsed.status).toBe('delivered_unverified');
    expect(parsed.effect).toBeUndefined();
  });

  test('an element ref and its snapshot id are forwarded to the daemon', async ({ page }) => {
    // The ref path is only safe because the daemon re-resolves it; the tool layer
    // has to actually send both halves for that to happen at all.
    let sentPlan: Record<string, unknown> | undefined;
    await driveBrowserRun(page, {
      verdict: { effect: 'confirmed', verified: true },
      toolArgs: {
        goal: 'refresh the dashboard',
        steps: [
          { description: 'open', action: { kind: 'navigate', url: 'https://example.com/' } },
          { description: 'list', action: { kind: 'elements' } },
          {
            description: 'click by ref',
            action: { kind: 'click', element: 7, snapshot_id: 'bds-abc123' },
          },
        ],
        target_step_index: 2,
      },
      onExecuteBody: (body) => {
        sentPlan = body.plan as Record<string, unknown>;
      },
    });

    const steps = sentPlan?.steps as { action: Record<string, unknown> }[];
    expect(steps?.[1].action.kind).toBe('elements');
    expect(steps?.[2].action).toMatchObject({ element: 7, snapshot_id: 'bds-abc123' });
  });
});

// The multi-act path is the riskiest one: it runs unattended, so an act that was
// never proven would otherwise have the rest of the task stacked on top of it.
test.describe('browser-drive task stops on unproven acts', () => {
  const TASK_ROUTE = '**/api/aoi-host/browser-drive/task';

  async function driveTask(
    page: Page,
    result: Record<string, unknown>,
  ): Promise<{ toolResults: string[] }> {
    const toolResults: string[] = [];
    let llmCalls = 0;
    await page.addInitScript((configKey) => {
      localStorage.clear();
      localStorage.setItem(
        configKey,
        JSON.stringify({
          provider: 'openai',
          apiKey: 'sk-test',
          baseUrl: 'https://mock-llm.test/v1',
          model: 'gpt-4',
        }),
      );
    }, CONFIG_KEY);
    await page.route('**/api/aoi-autonomy/**', (route) => route.abort());
    await page.route('**/api/kira-automation/**', (route) => route.abort());
    await page.route(TASK_ROUTE, (route) => route.fulfill({ json: { ok: true, result } }));
    await page.route('**/api/llm-proxy', async (route) => {
      llmCalls += 1;
      const body = route.request().postDataJSON() as {
        messages?: { role: string; content?: string }[];
      };
      for (const message of body.messages ?? []) {
        if (message.role === 'tool' && typeof message.content === 'string') {
          toolResults.push(message.content);
        }
      }
      if (llmCalls === 1) {
        await route.fulfill({
          json: toolCallResponse('browser_drive_task', {
            goal: 'refresh twice',
            steps: [
              {
                plan: { goal: 'p', steps: [{ action: { kind: 'click', selector: '#a' } }] },
                target_step_index: 0,
              },
              {
                plan: { goal: 'p', steps: [{ action: { kind: 'click', selector: '#b' } }] },
                target_step_index: 0,
              },
            ],
          }),
        });
        return;
      }
      await route.fulfill({ json: respondResponse('확인했어.') });
    });
    await page.goto('/');
    await page.getByTestId('chat-input').fill('두 번 새로고침하는 작업 실행해줘');
    await page.getByTestId('send-btn').click();
    await expect(page.getByTestId('chat-messages')).toContainText('확인했어.', { timeout: 30_000 });
    return { toolResults };
  }

  test('reports a task stopped on an act that did nothing', async ({ page }) => {
    const { toolResults } = await driveTask(page, {
      ok: false,
      goal: 'refresh twice',
      stopReason: 'act_not_performed',
      actsRun: 1,
      stepsRun: 2,
      results: [{ index: 0, ok: true, effect: 'suspected_noop' }],
      detail: 'step 0 did not take effect',
    });
    const parsed = JSON.parse(toolResults.find((entry) => entry.includes('acts_run')) as string);
    expect(parsed.status).toBe('stopped');
    expect(parsed.stop_reason).toBe('act_not_performed');
    expect(parsed.steps[0].effect).toBe('suspected_noop');
    expect(parsed.note).toContain('do not re-run the task unchanged');
  });

  test('does not call a task done when its last act was unproven', async ({ page }) => {
    const { toolResults } = await driveTask(page, {
      ok: true,
      goal: 'refresh twice',
      stopReason: 'completed',
      actsRun: 2,
      stepsRun: 4,
      results: [
        { index: 0, ok: true, effect: 'confirmed', verified: true },
        { index: 1, ok: true, effect: 'unverifiable' },
      ],
    });
    const parsed = JSON.parse(toolResults.find((entry) => entry.includes('acts_run')) as string);
    expect(parsed.status).toBe('done_unverified');
    expect(parsed.note).toContain('could not be proven');
  });
});
