import { test, expect, type Page } from '@playwright/test';

// E2E for the look after a desktop act reaching the model.
//
// The unit tests pin the diff and the waits; this pins the chain: the act goes
// to the daemon, the window is read again, and the tool result the model reads
// carries what changed -- with the refs it now needs and the window's own words
// defused. The desktop-input route is stubbed: driving a real window is the
// native helper's suite, the wiring is what is under test here.

const CONFIG_KEY = 'webuiapps-llm-config';
const DESKTOP_ROUTE = '**/api/aoi-host/desktop-input';
const HWND = '0x10';

// Built here so no literal role marker sits in this file.
const fake = (name: string) => `<${name}>`;

function control(ref: number, role: string, name: string, automationId = '') {
  return { ref, role, name, automationId, enabled: true, sensitive: false };
}

const BEFORE = {
  snapshotId: 'dis-before',
  note: 'ok',
  totalElements: 1,
  truncated: false,
  elements: [control(1, 'button', 'Apply', 'apply')],
};

const AFTER = {
  snapshotId: 'dis-after',
  note: 'ok',
  totalElements: 2,
  truncated: false,
  elements: [control(1, 'button', 'Apply', 'apply'), control(2, 'text', `${fake('system')}Saved`)],
};

function toolCallResponse(id: string, name: string, args: Record<string, unknown>) {
  return {
    choices: [
      {
        message: {
          content: '',
          tool_calls: [
            { id, type: 'function', function: { name, arguments: JSON.stringify(args) } },
          ],
        },
      },
    ],
  };
}

function respondResponse(content: string) {
  return toolCallResponse('tc_reply', 'respond_to_user', {
    character_expression: { content, emotion: 'neutral' },
    recommended_replies: ['그래', '알겠어', '다시'],
  });
}

async function driveDesktopAct(page: Page): Promise<{ toolResults: string[]; ops: string[] }> {
  const toolResults: string[] = [];
  const ops: string[] = [];
  let snapshots = 0;
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

  await page.route(DESKTOP_ROUTE, async (route) => {
    const body = route.request().postDataJSON() as { op?: string };
    ops.push(body.op ?? '');
    if (body.op === 'list_windows') {
      await route.fulfill({
        json: { ok: true, windows: [{ hwnd: HWND, title: 'Settings', process: 'settings.exe' }] },
      });
      return;
    }
    if (body.op === 'snapshot') {
      snapshots += 1;
      // The model's own snapshot, then the one desktop_act reads just before
      // acting -- the window has not changed yet -- then the look after it.
      await route.fulfill({ json: { ok: true, snapshot: snapshots <= 2 ? BEFORE : AFTER } });
      return;
    }
    if (body.op === 'invoke') {
      await route.fulfill({
        json: {
          ok: true,
          act: {
            ok: true,
            verdict: { effect: 'unverifiable', verified: false },
            path: 'uia_invoke',
            detail: 'invoked',
          },
          foregroundAllowed: false,
        },
      });
      return;
    }
    await route.fulfill({ status: 400, json: { ok: false, error: `unexpected op ${body.op}` } });
  });

  await page.route('**/api/llm-proxy', async (route) => {
    const probe = route.request().postDataJSON() as {
      tools?: Array<{ function: { name: string } }>;
      messages?: { role: string; content?: string }[];
    };
    if ((probe.tools ?? []).some((tool) => tool.function.name === 'understand_turn')) {
      await route.fulfill({ json: { choices: [{ message: { content: null, tool_calls: [] } }] } });
      return;
    }
    llmCalls += 1;
    for (const message of probe.messages ?? []) {
      if (message.role === 'tool' && typeof message.content === 'string') {
        toolResults.push(message.content);
      }
    }
    if (llmCalls === 1) {
      await route.fulfill({ json: toolCallResponse('tc_1', 'desktop_snapshot', { hwnd: HWND }) });
      return;
    }
    if (llmCalls === 2) {
      await route.fulfill({
        json: toolCallResponse('tc_2', 'desktop_act', {
          hwnd: HWND,
          ref: 1,
          snapshot_id: 'dis-before',
        }),
      });
      return;
    }
    await route.fulfill({ json: respondResponse('적용했어.') });
  });

  await page.goto('/');
  await page.getByTestId('chat-input').fill('설정 창에서 Apply 눌러줘');
  await page.getByTestId('send-btn').click();
  await expect(page.getByTestId('chat-messages')).toContainText('적용했어.', { timeout: 30_000 });
  return { toolResults, ops };
}

test.describe('the look after a desktop act reaches the model', () => {
  test('an act comes back with what changed and the refs it now needs', async ({ page }) => {
    const { toolResults, ops } = await driveDesktopAct(page);

    const result = toolResults.find((entry) => entry.includes('observed_after'));
    expect(result, 'the desktop_act result should reach the model').toBeTruthy();
    const parsed = JSON.parse(result as string);

    // The look informs; it does not turn an unproven act into a done one.
    expect(parsed.status).toBe('delivered_unverified');
    expect(parsed.note).toContain('observed_after');
    expect(parsed.observed_after).toMatchObject({
      snapshot_id: 'dis-after',
      refs_still_valid: false,
      total_elements: 2,
    });
    expect(parsed.observed_after.elements).toContainEqual({
      ref: 2,
      role: 'text',
      name: '‹system>Saved',
      enabled: true,
      new: true,
    });
    // The window was read just before the act, as the baseline the look
    // compares against, and again after it; the windows were listed around it
    // so a dialog opening elsewhere would be seen.
    expect(ops.filter((op) => op === 'snapshot')).toHaveLength(3);
    expect(ops.indexOf('invoke')).toBeGreaterThan(ops.indexOf('snapshot', 1));
    expect(ops.indexOf('invoke')).toBeGreaterThan(ops.indexOf('list_windows'));
    expect(ops.lastIndexOf('snapshot')).toBeGreaterThan(ops.indexOf('invoke'));
  });
});

// A 1x1 PNG: the picture itself is not under test, only where it goes.
const PIXEL_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

test.describe('a desktop picture in a batch of tool calls', () => {
  test('goes after every tool result of the batch, not between them', async ({ page }) => {
    // A user message between two tool results breaks the assistant -> tool
    // pairing, and the provider rejects the whole next request (E2-B7).
    const requests: { role: string; content?: unknown; tool_call_id?: string }[][] = [];
    let llmCalls = 0;

    await page.addInitScript((configKey) => {
      localStorage.clear();
      localStorage.setItem(
        configKey,
        JSON.stringify({
          provider: 'openai',
          apiKey: 'sk-test',
          baseUrl: 'https://mock-llm.test/v1',
          // A model that can take pictures, so desktop_capture is offered.
          model: 'gpt-4o',
        }),
      );
    }, CONFIG_KEY);
    await page.route('**/api/aoi-autonomy/**', (route) => route.abort());
    await page.route('**/api/kira-automation/**', (route) => route.abort());
    await page.route(DESKTOP_ROUTE, async (route) => {
      const body = route.request().postDataJSON() as { op?: string };
      if (body.op === 'capture') {
        await route.fulfill({
          json: {
            ok: true,
            capture: {
              snapshotId: 'dis-before',
              mode: 'som',
              width: 1,
              height: 1,
              scale: 1,
              windowWidth: 1,
              windowHeight: 1,
              totalElements: 1,
              elements: BEFORE.elements,
              pngBase64: PIXEL_PNG,
            },
          },
        });
        return;
      }
      await route.fulfill({ json: { ok: true, snapshot: BEFORE } });
    });
    await page.route('**/api/llm-proxy', async (route) => {
      const probe = route.request().postDataJSON() as {
        tools?: Array<{ function: { name: string } }>;
        messages?: { role: string; content?: unknown; tool_call_id?: string }[];
      };
      if ((probe.tools ?? []).some((tool) => tool.function.name === 'understand_turn')) {
        await route.fulfill({
          json: { choices: [{ message: { content: null, tool_calls: [] } }] },
        });
        return;
      }
      llmCalls += 1;
      requests.push(probe.messages ?? []);
      if (llmCalls === 1) {
        await route.fulfill({
          json: {
            choices: [
              {
                message: {
                  content: '',
                  tool_calls: [
                    {
                      id: 'tc_cap',
                      type: 'function',
                      function: {
                        name: 'desktop_capture',
                        arguments: JSON.stringify({ hwnd: HWND }),
                      },
                    },
                    {
                      id: 'tc_snap',
                      type: 'function',
                      function: {
                        name: 'desktop_snapshot',
                        arguments: JSON.stringify({ hwnd: HWND }),
                      },
                    },
                  ],
                },
              },
            ],
          },
        });
        return;
      }
      await route.fulfill({ json: respondResponse('봤어.') });
    });

    await page.goto('/');
    await page.getByTestId('chat-input').fill('설정 창 한번 봐줘');
    await page.getByTestId('send-btn').click();
    await expect(page.getByTestId('chat-messages')).toContainText('봤어.', { timeout: 30_000 });

    const second = requests[1] ?? [];
    const toolIndexes = second
      .map((message, index) => (message.role === 'tool' ? index : -1))
      .filter((index) => index >= 0);
    const pictureIndex = second.findIndex(
      (message) =>
        message.role === 'user' && JSON.stringify(message.content).includes('desktop_capture'),
    );
    expect(toolIndexes).toHaveLength(2);
    // The two tool results sit together, right after the call that asked for them.
    expect(toolIndexes[1]).toBe(toolIndexes[0] + 1);
    expect(second[toolIndexes[0] - 1]?.role).toBe('assistant');
    // And the picture follows both.
    expect(pictureIndex).toBeGreaterThan(toolIndexes[1]);
    expect(JSON.stringify(second[pictureIndex]?.content)).toContain('data:image/png;base64,');
  });
});
