import { test, expect, type Page, type Route } from '@playwright/test';

// E2E for the turn-understanding layer: the recent-turns block, the classifier
// that pulls a misrouted turn onto the main route, the model's own
// request_capabilities escalation, and the clarification path.
//
// Before this layer the persisted history kept only { role, content }, so on the
// next turn the model had no record of which tools had run; "그거 다시 읽어줘"
// resolved against prose. Routing was regex over the latest message, and a turn
// sent to the dialog route (four tools) could only be answered with "I cannot".
//
// The classifier request is identified by the tool it is offered
// (understand_turn); everything else is a conversation call, counted separately.

const CONFIG_KEY = 'webuiapps-llm-config';
const PREFERENCES_KEY = 'webuiapps-conversation-preferences';
const MUSIC_TASTE_KEY = 'aoi-music-taste-v1';

// A remembered user play, in the label shape the YouTube app reports
// ("title - channel"). Only the artist has to be recognisable.
const REMEMBERED_AESPA_PLAY = "aespa エスパ 'KISS N TELL' MV - SMTOWN";
const REMEMBERED_AESPA_QUERY = "aespa エスパ 'KISS N TELL' MV";

function tasteWithPlays(recentPlays: string[]) {
  return { version: 1, answers: {}, recentSearches: [], recentPlays, lastAskedAt: 0 };
}

function youtubeResult(title: string) {
  return {
    id: `vid-${title.length}`,
    title,
    channel: 'SMTOWN',
    duration: '3:12',
    views: '12,345,678 views',
    published: '2 weeks ago',
    thumbnail: '',
    url: `https://www.youtube.com/watch?v=vid-${title.length}`,
  };
}

const PRIOR_REPLY = '읽었어. 런 레저 엔트리를 만들고 이벤트를 누적하는 모듈이야.';
const REFERENCED_PATH = 'src/lib/aoiRunLedger.ts';

interface Capture {
  classifierCalls: number;
  classifierPrompts: string[];
  conversationCalls: Array<{ toolNames: string[]; systemText: string }>;
  turnRecordGets: number;
  ledgerPosts: Array<Record<string, unknown>>;
  turnRecordPosts: Array<Record<string, unknown>>;
}

function transcript() {
  return {
    version: 1,
    savedAt: 1,
    messages: [
      { id: 'u-1', role: 'user', content: `${REFERENCED_PATH} 읽어줘` },
      { id: 'a-1', role: 'assistant', content: PRIOR_REPLY },
    ],
    chatHistory: [
      { role: 'user', content: `${REFERENCED_PATH} 읽어줘` },
      { role: 'assistant', content: PRIOR_REPLY },
    ],
    suggestedReplies: [],
  };
}

function priorTurnRecords() {
  return {
    version: 1,
    savedAt: 1,
    turns: [
      {
        version: 1,
        id: 'aoi-run-prior',
        turnIndex: 1,
        createdAt: Date.now() - 120_000,
        userMessage: `${REFERENCED_PATH} 읽어줘`,
        assistantMessage: PRIOR_REPLY,
        route: 'main',
        routeReason: 'regex: main',
        kind: 'action_request',
        families: ['file'],
        tools: [{ name: 'ide_read_file', args: `path=${REFERENCED_PATH}`, outcome: 'ok' }],
        entities: [REFERENCED_PATH],
        offers: [],
        openQuestion: null,
        outcome: 'delivered',
      },
    ],
  };
}

function toolCallChoice(name: string, args: unknown) {
  return {
    choices: [
      {
        message: {
          content: null,
          tool_calls: [
            {
              id: `call_${name}`,
              type: 'function',
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
      },
    ],
  };
}

function respondChoice(content: string) {
  return toolCallChoice('respond_to_user', {
    character_expression: { content, emotion: 'peaceful' },
    user_interaction: { suggested_replies: ['응', '아니', '그래'] },
    performed_actions: [],
  });
}

async function setup(
  page: Page,
  capture: Capture,
  options: {
    classifierAnswer: Record<string, unknown> | null;
    withPriorRecords: boolean;
    turnUnderstandingOff?: boolean;
    // Seeds this browser's taste memory. The server copy is hidden from the app
    // and its write-back swallowed, so the shared e2e home never learns these
    // plays and the test does not depend on what other specs played.
    tasteState?: Record<string, unknown>;
    youtubeResults?: Array<Record<string, unknown>>;
    conversation: (call: number, toolNames: string[]) => unknown;
  },
): Promise<void> {
  await page.addInitScript(
    ({ configKey, preferencesKey, turnUnderstandingOff, tasteKey, tasteState }) => {
      localStorage.clear();
      if (tasteState) {
        localStorage.setItem(tasteKey, JSON.stringify(tasteState));
      }
      localStorage.setItem(
        configKey,
        JSON.stringify({
          provider: 'openai',
          apiKey: 'sk-test',
          baseUrl: 'https://mock-llm.test/v1',
          model: 'gpt-4',
        }),
      );
      if (turnUnderstandingOff) {
        localStorage.setItem(
          preferencesKey,
          JSON.stringify({ responseLanguageMode: 'match-user', turnUnderstandingMode: 'off' }),
        );
      }
    },
    {
      configKey: CONFIG_KEY,
      preferencesKey: PREFERENCES_KEY,
      turnUnderstandingOff: options.turnUnderstandingOff === true,
      tasteKey: MUSIC_TASTE_KEY,
      tasteState: options.tasteState ?? null,
    },
  );
  await page.route('**/api/session-data**', async (route: Route) => {
    const request = route.request();
    const path = decodeURIComponent(request.url());
    if (request.method() === 'GET' && path.includes('chat/chat.json')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(transcript()),
      });
      return;
    }
    if (request.method() === 'GET' && path.includes('aoi-turn-records/turns.json')) {
      capture.turnRecordGets += 1;
      await route.fulfill({
        status: options.withPriorRecords ? 200 : 404,
        contentType: 'application/json',
        body: options.withPriorRecords ? JSON.stringify(priorTurnRecords()) : '{}',
      });
      return;
    }
    if (request.method() === 'POST' && path.includes('aoi-turn-records/turns.json')) {
      capture.turnRecordPosts.push(request.postDataJSON() as Record<string, unknown>);
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
      return;
    }
    if (request.method() === 'POST' && path.includes('aoi-run-ledger/runs.json')) {
      capture.ledgerPosts.push(request.postDataJSON() as Record<string, unknown>);
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
      return;
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
      capture.classifierPrompts.push(
        (body.messages ?? []).map((message) => message.content).join('\n'),
      );
      if (options.classifierAnswer) {
        await route.fulfill({ json: toolCallChoice('understand_turn', options.classifierAnswer) });
      } else {
        await route.fulfill({ json: { choices: [{ message: { content: 'prose' } }] } });
      }
      return;
    }
    const systemText = (body.messages ?? [])
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n');
    // Only a call that can answer the user is a conversation call; anything else
    // (a memory distiller pass, for instance) is answered with prose and not
    // counted, so the counts below are not timing-dependent.
    if (!toolNames.includes('respond_to_user')) {
      await route.fulfill({ json: { choices: [{ message: { content: 'ok' } }] } });
      return;
    }
    capture.conversationCalls.push({ toolNames, systemText });
    await route.fulfill({
      json: options.conversation(capture.conversationCalls.length, toolNames),
    });
  });
  if (options.turnUnderstandingOff || options.tasteState) {
    // The server config is the source of truth for conversation preferences (the
    // app overwrites the localStorage copy with it on load), so the switch has to
    // be in what /api/llm-config returns. The taste memory is merged from the same
    // file, so a seeded memory hides the server copy and swallows the write-back.
    await page.route('**/api/llm-config**', async (route: Route) => {
      if (route.request().method() !== 'GET') {
        if (options.tasteState) {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: '{"ok":true}',
          });
          return;
        }
        await route.continue();
        return;
      }
      const response = await route.fetch();
      let json: Record<string, unknown> = {};
      try {
        json = (await response.json()) as Record<string, unknown>;
      } catch {
        json = {};
      }
      if (options.turnUnderstandingOff) {
        json.conversationPreferences = {
          ...((json.conversationPreferences as Record<string, unknown> | undefined) ?? {}),
          responseLanguageMode: 'match-user',
          turnUnderstandingMode: 'off',
        };
      }
      if (options.tasteState) {
        delete json.aoiMusicTaste;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(json),
      });
    });
  }
  await page.route('**/api/youtube-search**', (route) =>
    route.fulfill({ json: { results: options.youtubeResults ?? [] } }),
  );
  await page.route('https://www.youtube.com/**', (route) => route.abort());
  await page.route('**/api/aoi-autonomy/**', (route) => route.abort());
  await page.route('**/api/kira-automation/**', (route) => route.abort());
}

function emptyCapture(): Capture {
  return {
    classifierCalls: 0,
    classifierPrompts: [],
    conversationCalls: [],
    ledgerPosts: [],
    turnRecordPosts: [],
    turnRecordGets: 0,
  };
}

async function send(page: Page, text: string): Promise<void> {
  const input = page.getByTestId('chat-input');
  await expect(input).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('chat-messages')).toContainText(PRIOR_REPLY, { timeout: 30_000 });
  await input.fill(text);
  await page.getByTestId('send-btn').click();
}

// The transcript and the turn records load in the same effect but resolve
// independently; a send before the records arrive would classify without them.
async function waitForTurnRecords(page: Page, capture: Capture): Promise<void> {
  await expect(page.getByTestId('chat-input')).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => capture.turnRecordGets, { timeout: 15_000 }).toBeGreaterThan(0);
}

// The e2e home is shared across specs, so the ledger the app posts back carries
// earlier runs too; only the run for the message this test sent counts.
function latestRuns(capture: Capture, sentText: string): Array<Record<string, unknown>> {
  const last = capture.ledgerPosts[capture.ledgerPosts.length - 1];
  return ((last?.runs as Array<Record<string, unknown>>) ?? []).filter(
    (run) => (run.goal as { sourceMessage?: string } | undefined)?.sourceMessage === sentText,
  );
}

test.describe('turn understanding', () => {
  test('a reference to the previous turn reaches the model with the turn that ran, and is pulled to main', async ({
    page,
  }) => {
    const capture = emptyCapture();
    await setup(page, capture, {
      withPriorRecords: true,
      classifierAnswer: {
        kind: 'action_request',
        families: ['file'],
        refers_to_turn: 1,
        referent: REFERENCED_PATH,
        confidence: 'high',
      },
      conversation: () => respondChoice('다시 읽었어. 같은 내용이야.'),
    });
    await page.goto('/');
    await waitForTurnRecords(page, capture);
    const SENT = '그거 다시 읽어줘';
    await send(page, SENT);

    await expect(page.getByTestId('chat-messages')).toContainText('다시 읽었어', {
      timeout: 30_000,
    });

    // The classifier ran once and saw the record of what T-1 actually did.
    expect(capture.classifierCalls).toBe(1);
    expect(capture.classifierPrompts[0]).toContain('Recent turns');
    expect(capture.classifierPrompts[0]).toContain(`ide_read_file(path=${REFERENCED_PATH}) ok`);
    expect(capture.classifierPrompts[0]).toContain('User message: "그거 다시 읽어줘"');

    // The conversation call carried the same block plus the reading, and the app
    // tools the regex router alone would have withheld from this phrasing.
    expect(capture.conversationCalls).toHaveLength(1);
    const call = capture.conversationCalls[0];
    expect(call.systemText).toContain('Recent turns');
    expect(call.systemText).toContain(`ide_read_file(path=${REFERENCED_PATH}) ok`);
    expect(call.systemText).toContain('Reading of the latest user message');
    expect(call.systemText).toContain(`refers to T-1 ("${REFERENCED_PATH}")`);
    expect(call.toolNames).toContain('ide_read_file');
    expect(call.toolNames).not.toContain('request_capabilities');

    // The ledger says why, and the new turn record is written for the next turn.
    await expect
      .poll(() => latestRuns(capture, SENT).length, { timeout: 15_000 })
      .toBeGreaterThan(0);
    const run = latestRuns(capture, SENT)[0];
    expect(run.modelRoute).toBe('main');
    expect(String(run.routeReason)).toContain('classifier: action_request needs file');
    expect((run.understanding as { referent: string }).referent).toBe(REFERENCED_PATH);
    await expect.poll(() => capture.turnRecordPosts.length, { timeout: 15_000 }).toBeGreaterThan(0);
    const turns = capture.turnRecordPosts[capture.turnRecordPosts.length - 1].turns as Array<
      Record<string, unknown>
    >;
    expect(turns).toHaveLength(2);
    expect(turns[1]).toMatchObject({
      turnIndex: 2,
      userMessage: '그거 다시 읽어줘',
      route: 'main',
      kind: 'action_request',
      outcome: 'delivered',
    });
    expect(turns[1].families as string[]).toContain('file');
  });

  test('a dialog-route model asks for capabilities and the turn is re-run on main with them', async ({
    page,
  }) => {
    const capture = emptyCapture();
    await setup(page, capture, {
      withPriorRecords: false,
      // The classifier misses on purpose (reads it as chit-chat), so the turn stays
      // on the dialog route and the model has to use its own escape.
      classifierAnswer: { kind: 'chitchat', families: ['none'], confidence: 'high' },
      conversation: (call) =>
        call === 1
          ? toolCallChoice('request_capabilities', {
              families: ['file'],
              reason: 'the user wants a file opened',
            })
          : respondChoice('package.json 열었어. 스크립트 12개가 있어.'),
    });
    await page.goto('/');
    const SENT = 'package.json 열어봐';
    await send(page, SENT);

    await expect(page.getByTestId('chat-messages')).toContainText('package.json 열었어', {
      timeout: 30_000,
    });

    expect(capture.conversationCalls).toHaveLength(2);
    const [first, second] = capture.conversationCalls;
    expect(first.toolNames).toContain('request_capabilities');
    expect(first.toolNames).not.toContain('ide_read_file');
    expect(first.systemText).toContain('Missing capabilities this turn');
    expect(second.toolNames).not.toContain('request_capabilities');
    expect(second.toolNames).toContain('ide_read_file');
    // One reading per turn: the re-run carried the reading over.
    expect(capture.classifierCalls).toBe(1);

    await expect
      .poll(() => latestRuns(capture, SENT).length, { timeout: 15_000 })
      .toBeGreaterThan(0);
    const runs = latestRuns(capture, SENT);
    // One turn, one run: the escalation continued the dialog attempt's entry.
    expect(runs).toHaveLength(1);
    expect(runs[0].modelRoute).toBe('main');
    expect(runs[0].escalation).toMatchObject({ fromRoute: 'dialog', families: ['file'] });
    expect(String(runs[0].routeReason)).toContain('escalation');
    const events = runs[0].events as Array<{ type: string }>;
    expect(events.some((event) => event.type === 'capability_escalated')).toBe(true);
  });

  test('a low-confidence side-effect request is answered with a question and chips, not a guess', async ({
    page,
  }) => {
    const capture = emptyCapture();
    await setup(page, capture, {
      withPriorRecords: false,
      classifierAnswer: {
        kind: 'action_request',
        families: ['file'],
        confidence: 'low',
        needs_clarification: '어느 파일을 정리할까?',
        clarification_options: ['notes.md', 'README.md'],
      },
      conversation: () => respondChoice('SHOULD NOT RUN'),
    });
    await page.goto('/');
    const SENT = '그거 정리해줘';
    await send(page, SENT);

    await expect(page.getByTestId('chat-messages')).toContainText('어느 파일을 정리할까?', {
      timeout: 30_000,
    });
    await expect(page.getByTestId('suggested-reply').filter({ hasText: 'notes.md' })).toBeVisible();
    await expect(
      page.getByTestId('suggested-reply').filter({ hasText: 'README.md' }),
    ).toBeVisible();
    expect(capture.classifierCalls).toBe(1);
    expect(capture.conversationCalls).toHaveLength(0);
    await expect(page.getByTestId('chat-messages')).not.toContainText('SHOULD NOT RUN');

    await expect.poll(() => capture.turnRecordPosts.length, { timeout: 15_000 }).toBeGreaterThan(0);
    const turns = capture.turnRecordPosts[capture.turnRecordPosts.length - 1].turns as Array<
      Record<string, unknown>
    >;
    expect(turns[turns.length - 1]).toMatchObject({
      outcome: 'clarification_asked',
      openQuestion: '어느 파일을 정리할까?',
    });
    await expect
      .poll(() => latestRuns(capture, SENT).length, { timeout: 15_000 })
      .toBeGreaterThan(0);
    const events = latestRuns(capture, SENT)[0].events as Array<{ type: string }>;
    expect(events.some((event) => event.type === 'clarification_asked')).toBe(true);
  });

  test('with the setting off no classifier call is made and the regex route stands', async ({
    page,
  }) => {
    const capture = emptyCapture();
    await setup(page, capture, {
      withPriorRecords: false,
      turnUnderstandingOff: true,
      classifierAnswer: { kind: 'action_request', families: ['file'], confidence: 'high' },
      conversation: () => respondChoice('그냥 대화로 답할게.'),
    });
    await page.goto('/');
    const SENT = '오늘 좀 피곤하다';
    await send(page, SENT);

    await expect(page.getByTestId('chat-messages')).toContainText('그냥 대화로 답할게', {
      timeout: 30_000,
    });
    expect(capture.classifierCalls).toBe(0);
    expect(capture.conversationCalls).toHaveLength(1);
    expect(capture.conversationCalls[0].toolNames).toContain('request_capabilities');
    expect(capture.conversationCalls[0].systemText).not.toContain(
      'Reading of the latest user message',
    );
    await expect
      .poll(() => latestRuns(capture, SENT).length, { timeout: 15_000 })
      .toBeGreaterThan(0);
    expect(String(latestRuns(capture, SENT)[0].routeReason)).toBe('regex: dialog');
  });
  test('a turn the music parser answers in code is still recorded for the next turn', async ({
    page,
  }) => {
    const capture = emptyCapture();
    const title = "aespa 'KISS N TELL' MV";
    await setup(page, capture, {
      withPriorRecords: false,
      // The classifier reads the request before it plays: a named title, no
      // reference to taste, so the parser's literal query stands.
      classifierAnswer: {
        kind: 'action_request',
        families: ['app'],
        confidence: 'high',
        music_target: '에스파 KISS N TELL',
        music_reference: 'none',
      },
      conversation: () => respondChoice('SHOULD NOT RUN'),
      youtubeResults: [youtubeResult(title)],
    });
    await page.goto('/');
    const SENT = '에스파 KISS N TELL 틀어줘';
    await send(page, SENT);

    // One classifier read, then the direct parser dispatched the play; no
    // conversation call was made.
    await expect(page.getByTestId('app-window-3')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('yt-player-title')).toHaveText(title, { timeout: 30_000 });
    await expect(page.getByTestId('yt-search-input')).toHaveValue('에스파 KISS N TELL');
    expect(capture.classifierCalls).toBe(1);
    expect(capture.classifierPrompts[0]).toContain(`User message: "${SENT}"`);
    expect(capture.conversationCalls).toHaveLength(0);

    // But the turn is on record, so "그 노래 다시" on the next turn has a referent.
    await expect.poll(() => capture.turnRecordPosts.length, { timeout: 15_000 }).toBeGreaterThan(0);
    const turns = capture.turnRecordPosts[capture.turnRecordPosts.length - 1].turns as Array<
      Record<string, unknown>
    >;
    const direct = turns[turns.length - 1];
    expect(direct).toMatchObject({
      userMessage: SENT,
      route: 'main',
      kind: 'action_request',
      outcome: 'delivered',
    });
    expect(String(direct.routeReason)).toContain('direct action: play_music');
    expect((direct.tools as Array<{ name: string }>)[0].name).toBe('play_music');
  });

  test('"the one I like" by an artist plays the remembered track, not the words', async ({
    page,
  }) => {
    const capture = emptyCapture();
    await setup(page, capture, {
      withPriorRecords: false,
      tasteState: tasteWithPlays([REMEMBERED_AESPA_PLAY]),
      classifierAnswer: {
        kind: 'action_request',
        families: ['app'],
        confidence: 'high',
        music_target: '에스파',
        music_reference: 'taste',
      },
      conversation: () => respondChoice('SHOULD NOT RUN'),
      youtubeResults: [youtubeResult(REMEMBERED_AESPA_QUERY)],
    });
    await page.goto('/');
    const SENT = '에스파 내가 좋아하는 노래 틀어줘';
    await send(page, SENT);

    // The search is the remembered aespa title, not "에스파 내가 좋아하는", and the
    // ack says which memory it used.
    await expect(page.getByTestId('app-window-3')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('yt-search-input')).toHaveValue(REMEMBERED_AESPA_QUERY, {
      timeout: 30_000,
    });
    await expect(page.getByTestId('yt-player-title')).toHaveText(REMEMBERED_AESPA_QUERY, {
      timeout: 30_000,
    });
    await expect(page.getByTestId('chat-messages')).toContainText(
      `전에 네가 들었던 에스파 곡으로 "${REMEMBERED_AESPA_QUERY}" 틀었어`,
      { timeout: 30_000 },
    );
    expect(capture.classifierCalls).toBe(1);
    expect(capture.conversationCalls).toHaveLength(0);

    // The record says which memory path ran, so the next turn (and the ledger
    // panel) can tell a remembered play from a literal search.
    await expect.poll(() => capture.turnRecordPosts.length, { timeout: 15_000 }).toBeGreaterThan(0);
    const turns = capture.turnRecordPosts[capture.turnRecordPosts.length - 1].turns as Array<
      Record<string, unknown>
    >;
    const direct = turns[turns.length - 1];
    expect(direct).toMatchObject({ userMessage: SENT, route: 'main', outcome: 'delivered' });
    expect((direct.tools as Array<{ name: string; args: string }>)[0]).toMatchObject({
      name: 'play_music',
      args: 'play_remembered',
    });
  });

  test('with nothing remembered by that artist the search is the artist and the ack says so', async ({
    page,
  }) => {
    const capture = emptyCapture();
    const started = "NewJeans (뉴진스) 'Supernatural' Official MV";
    await setup(page, capture, {
      withPriorRecords: false,
      tasteState: tasteWithPlays([REMEMBERED_AESPA_PLAY]),
      classifierAnswer: {
        kind: 'action_request',
        families: ['app'],
        confidence: 'high',
        music_target: '뉴진스',
        music_reference: 'taste',
      },
      conversation: () => respondChoice('SHOULD NOT RUN'),
      youtubeResults: [youtubeResult(started)],
    });
    await page.goto('/');
    const SENT = '뉴진스 내가 좋아하는 노래 틀어줘';
    await send(page, SENT);

    await expect(page.getByTestId('app-window-3')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('yt-search-input')).toHaveValue('뉴진스', { timeout: 30_000 });
    await expect(page.getByTestId('chat-messages')).toContainText(
      `기억해 둔 뉴진스 곡이 없어서 "뉴진스"로 찾아서 "${started}" 틀었어`,
      { timeout: 30_000 },
    );
    expect(capture.classifierCalls).toBe(1);
    expect(capture.conversationCalls).toHaveLength(0);
    await expect.poll(() => capture.turnRecordPosts.length, { timeout: 15_000 }).toBeGreaterThan(0);
    const turns = capture.turnRecordPosts[capture.turnRecordPosts.length - 1].turns as Array<
      Record<string, unknown>
    >;
    expect((turns[turns.length - 1].tools as Array<{ args: string }>)[0].args).toBe(
      'play_artist_fallback',
    );
  });

  test('a sentence the parser misreads as playback goes to the model on a confident other reading', async ({
    page,
  }) => {
    const capture = emptyCapture();
    await setup(page, capture, {
      withPriorRecords: false,
      // "...으로 해줘" matches the parser's playback pattern; the classifier reads
      // a file request, so nothing plays and the turn runs on main with files.
      classifierAnswer: { kind: 'action_request', families: ['file'], confidence: 'high' },
      conversation: () => respondChoice('어제 만든 버전으로 바꿨어.'),
      youtubeResults: [youtubeResult('SHOULD NOT PLAY')],
    });
    await page.goto('/');
    const SENT = '발표 자료는 어제 만든 버전으로 해줘';
    await send(page, SENT);

    await expect(page.getByTestId('chat-messages')).toContainText('어제 만든 버전으로 바꿨어', {
      timeout: 30_000,
    });
    await expect(page.getByTestId('app-window-3')).toHaveCount(0);
    // The reading made before the parser was consulted is reused; the classifier
    // is not called a second time for the conversation.
    expect(capture.classifierCalls).toBe(1);
    expect(capture.conversationCalls).toHaveLength(1);
    expect(capture.conversationCalls[0].toolNames).toContain('ide_read_file');
    expect(capture.conversationCalls[0].systemText).toContain('Reading of the latest user message');
    await expect
      .poll(() => latestRuns(capture, SENT).length, { timeout: 15_000 })
      .toBeGreaterThan(0);
    expect(String(latestRuns(capture, SENT)[0].routeReason)).toContain(
      'classifier: action_request needs file',
    );
  });
});
