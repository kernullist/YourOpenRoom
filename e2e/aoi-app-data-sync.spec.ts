import { test, expect, type Page, type Route } from '@playwright/test';

// E2E for two Jarvis-shaped rules added after the 2026-09-11 diary incident:
//
// 1. App data Aoi writes reaches the app before she says it is there. The model
//    wrote apps/diary/data/entries/x.json, never dispatched CREATE_ENTRY, and
//    told the user the entry was on the page while the Diary showed "No diaries
//    yet". Now the runtime finishes the app's protocol after a successful write
//    to an open app, and respond_to_user is checked against it.
//
// 2. A "[User performed action in …]" report is something the user did, not a
//    request. That turn gets the conversation and app tools only -- no file,
//    host, browser, or research tools -- and no classifier call.

const CONFIG_KEY = 'webuiapps-llm-config';
const TOOL_POLICY_KEY = 'openroom-tool-safety-policy-v1';
const DIARY_APP_ID = 4;
const YOUTUBE_APP_ID = 3;

interface ConversationCall {
  toolNames: string[];
  systemText: string;
  lastUserText: string;
}

interface Capture {
  classifierCalls: number;
  conversationCalls: ConversationCall[];
  ledgerPosts: Array<Record<string, unknown>>;
}

function toolCallChoice(calls: Array<{ name: string; args: unknown }>) {
  return {
    choices: [
      {
        message: {
          content: null,
          tool_calls: calls.map((call, index) => ({
            id: `call_${call.name}_${index}`,
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.args) },
          })),
        },
      },
    ],
  };
}

function respondArgs(content: string) {
  return {
    character_expression: { content, emotion: 'peaceful' },
    user_interaction: { suggested_replies: ['응', '아니', '그래'] },
    performed_actions: [],
  };
}

async function setup(
  page: Page,
  capture: Capture,
  options: {
    classifierAnswer: Record<string, unknown> | null;
    conversation: (call: ConversationCall, index: number) => unknown;
  },
): Promise<void> {
  await page.addInitScript(
    ({ configKey, toolPolicyKey }) => {
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
      // A scripted file_write must not be turned away by the preview-first policy.
      localStorage.setItem(
        toolPolicyKey,
        JSON.stringify({
          autoVerifyFixes: false,
          allowWorkspaceCommands: false,
          allowSemanticRefactors: false,
          allowBackgroundWatches: false,
          requirePreviewBeforeMutation: false,
        }),
      );
    },
    { configKey: CONFIG_KEY, toolPolicyKey: TOOL_POLICY_KEY },
  );
  await page.route('**/api/session-data**', async (route: Route) => {
    const request = route.request();
    if (
      request.method() === 'POST' &&
      decodeURIComponent(request.url()).includes('aoi-run-ledger/runs.json')
    ) {
      capture.ledgerPosts.push(request.postDataJSON() as Record<string, unknown>);
    }
    await route.continue();
  });
  await page.route('**/api/llm-proxy', async (route: Route) => {
    const body = route.request().postDataJSON() as {
      messages?: Array<{ role: string; content: string }>;
      tools?: Array<{ function: { name: string } }>;
    };
    const toolNames = (body?.tools ?? []).map((tool) => tool.function.name);
    if (toolNames.includes('understand_turn')) {
      capture.classifierCalls += 1;
      if (options.classifierAnswer) {
        await route.fulfill({
          json: toolCallChoice([{ name: 'understand_turn', args: options.classifierAnswer }]),
        });
      } else {
        await route.fulfill({ json: { choices: [{ message: { content: 'prose' } }] } });
      }
      return;
    }
    if (!toolNames.includes('respond_to_user')) {
      await route.fulfill({ json: { choices: [{ message: { content: 'ok' } }] } });
      return;
    }
    const messages = body.messages ?? [];
    const call: ConversationCall = {
      toolNames,
      systemText: messages
        .filter((message) => message.role === 'system')
        .map((message) => message.content)
        .join('\n'),
      lastUserText:
        [...messages].reverse().find((message) => message.role === 'user')?.content ?? '',
    };
    capture.conversationCalls.push(call);
    await route.fulfill({ json: options.conversation(call, capture.conversationCalls.length) });
  });
  await page.route('**/api/youtube-search**', (route) =>
    route.fulfill({
      json: {
        results: [
          {
            id: 'vid-sync',
            title: 'lofi beats to sync to',
            channel: 'E2E',
            duration: '1:00',
            views: '1 view',
            published: 'today',
            thumbnail: '',
            url: 'https://www.youtube.com/watch?v=vid-sync',
          },
        ],
      },
    }),
  );
  await page.route('https://www.youtube.com/**', (route) => route.abort());
  await page.route('https://i.ytimg.com/**', (route) => route.abort());
  await page.route('**/api/aoi-autonomy/**', (route) => route.abort());
  await page.route('**/api/kira-automation/**', (route) => route.abort());
}

function emptyCapture(): Capture {
  return { classifierCalls: 0, conversationCalls: [], ledgerPosts: [] };
}

function runsFor(capture: Capture, sentText: string): Array<Record<string, unknown>> {
  const last = capture.ledgerPosts[capture.ledgerPosts.length - 1];
  return ((last?.runs as Array<Record<string, unknown>>) ?? []).filter(
    (run) => (run.goal as { sourceMessage?: string } | undefined)?.sourceMessage === sentText,
  );
}

test.describe('app data sync and event turns', () => {
  test('a diary entry Aoi writes reaches the open Diary window before she says it is there', async ({
    page,
  }) => {
    const capture = emptyCapture();
    const stamp = Date.now();
    const entryId = `e2e-sync-${stamp}`;
    const title = `E2E sync entry ${stamp}`;
    const today = new Date().toISOString().slice(0, 10);
    await setup(page, capture, {
      // Pulled to main with the app and file families, as a real reading would.
      classifierAnswer: { kind: 'action_request', families: ['app', 'file'], confidence: 'high' },
      conversation: (_call, index) =>
        index === 1
          ? toolCallChoice([
              {
                name: 'file_write',
                args: {
                  file_path: `apps/diary/data/entries/${entryId}.json`,
                  content: JSON.stringify({
                    id: entryId,
                    date: today,
                    title,
                    content: 'Written by the e2e model.',
                    createdAt: stamp,
                    updatedAt: stamp,
                  }),
                },
              },
              // The model claims it is there without dispatching CREATE_ENTRY.
              { name: 'respond_to_user', args: respondArgs(`일기장에 써놨어. 제목은 '${title}'.`) },
            ])
          : toolCallChoice([{ name: 'respond_to_user', args: respondArgs('SHOULD NOT RUN') }]),
    });
    await page.goto('/');
    await page.getByTestId(`app-icon-${DIARY_APP_ID}`).dblclick();
    const diaryWindow = page.getByTestId(`app-window-${DIARY_APP_ID}`);
    await expect(diaryWindow).toBeVisible();
    await expect(diaryWindow).toContainText('My Diary', { timeout: 30_000 });

    const SENT = '일기장 앱에 오늘 일기 하나 써줘';
    const input = page.getByTestId('chat-input');
    await expect(input).toBeVisible({ timeout: 30_000 });
    await input.fill(SENT);
    await page.getByTestId('send-btn').click();

    await expect(page.getByTestId('chat-messages')).toContainText('일기장에 써놨어', {
      timeout: 30_000,
    });
    // The runtime dispatched CREATE_ENTRY after the write, so the open Diary
    // shows the entry the reply talks about, and no correction round was needed.
    await expect(diaryWindow).toContainText(title, { timeout: 30_000 });
    expect(capture.conversationCalls).toHaveLength(1);

    await expect.poll(() => runsFor(capture, SENT).length, { timeout: 15_000 }).toBeGreaterThan(0);
    const run = runsFor(capture, SENT)[0];
    const events = run.events as Array<{ type: string; message?: string; toolNames?: string[] }>;
    const sync = events.find((event) =>
      String(event.message ?? '').startsWith('app sync diary CREATE_ENTRY'),
    );
    expect(sync).toBeTruthy();
    expect(sync?.toolNames).toContain('diary/CREATE_ENTRY');
    expect(String(sync?.message)).toContain(`/entries/${entryId}.json`);
    expect(String(sync?.message)).toContain('-> success');
    expect(events.some((event) => event.type === 'postcondition_failed')).toBe(false);
  });

  test('an app event report gets a reaction turn: conversation and app tools only, no classifier call', async ({
    page,
  }) => {
    const capture = emptyCapture();
    await setup(page, capture, {
      classifierAnswer: { kind: 'action_request', families: ['app'], confidence: 'high' },
      conversation: () =>
        toolCallChoice([{ name: 'respond_to_user', args: respondArgs('검색했네. 재생할까?') }]),
    });
    await page.goto('/');
    await page.getByTestId(`app-icon-${YOUTUBE_APP_ID}`).dblclick();
    await expect(page.getByTestId(`app-window-${YOUTUBE_APP_ID}`)).toBeVisible();
    await page.getByTestId(`window-maximize-${YOUTUBE_APP_ID}`).click();
    await expect(page.getByTestId('yt-search-input')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('yt-search-input').fill('lofi beats');
    await page.getByTestId('yt-search-submit').click();
    await expect(page.getByTestId('yt-results-popup')).toBeVisible();

    // The app reports the user's search; the report becomes a turn.
    await expect
      .poll(
        () =>
          capture.conversationCalls.filter((call) =>
            call.lastUserText.startsWith('[User performed action in YouTube'),
          ).length,
        { timeout: 30_000 },
      )
      .toBeGreaterThan(0);
    const eventCall = capture.conversationCalls.find((call) =>
      call.lastUserText.startsWith('[User performed action in YouTube'),
    )!;
    await expect(page.getByTestId('chat-messages')).toContainText('검색했네', { timeout: 30_000 });

    // Conversation and app tools stay; anything that writes, runs, drives, or
    // searches is gone. The report is not read by the classifier either.
    expect(eventCall.toolNames).toContain('respond_to_user');
    expect(eventCall.toolNames).toContain('app_action');
    for (const forbidden of [
      'file_write',
      'file_read',
      'file_list',
      'host_process_spawn_preview',
      'search_web',
      'ide_read_file',
      'browser_drive_act',
      'desktop_click',
    ]) {
      expect(eventCall.toolNames, forbidden).not.toContain(forbidden);
    }
    expect(capture.classifierCalls).toBe(0);
    if (eventCall.toolNames.includes('get_app_state')) {
      // Main route: the policy text rides the system prompt.
      expect(eventCall.systemText).toContain('not a request to you');
    }
  });
});
