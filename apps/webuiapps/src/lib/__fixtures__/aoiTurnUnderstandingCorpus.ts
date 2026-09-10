// Labelled utterances for the turn-understanding evaluation.
//
// Each case is one user message, optionally preceded by the turns it depends on,
// with the reading a careful operator would give it: what kind of turn it is,
// which capability families it needs, and whether the conversation-only route
// (respond_to_user, finish_target, list_apps, app_action) can serve it.
//
// Gold labels describe NEED, not the current router's behaviour. A pure question
// that the regex router sends to the main model is labelled dialog here, so the
// gap shows up as a number instead of a hunch. Phrasings mirror the real
// transcript shape (short, mostly Korean, chips and bare confirmations), with
// English variants of the same intents.

import type { AoiCapabilityFamily, AoiTurnKind, AoiTurnToolRecord } from '../aoiTurnRecord';

export interface AoiTurnCorpusTurn {
  user: string;
  assistant: string;
  route?: 'dialog' | 'main';
  tools?: AoiTurnToolRecord[];
  offers?: string[];
  openQuestion?: string | null;
  outcome?: 'delivered' | 'failed' | 'clarification_asked';
}

export interface AoiTurnCorpusGold {
  kind: AoiTurnKind;
  families: AoiCapabilityFamily[];
  route: 'dialog' | 'main';
  // Relative position of the referenced turn (1 = the previous turn).
  refersToTurn?: number;
}

export interface AoiTurnCorpusCase {
  id: string;
  text: string;
  turns?: AoiTurnCorpusTurn[];
  gold: AoiTurnCorpusGold;
  tags: string[];
}

const MUSIC_OFFER: AoiTurnCorpusTurn = {
  user: '노래 추천해줘',
  assistant: '에스파 "KISS N TELL" 어때?\nYouTube 검색어: `aespa KISS N TELL MV`\n이거 틀어줄까?',
  route: 'main',
  offers: ['▶ 재생', '다른 거'],
};

const MUSIC_PLAYED: AoiTurnCorpusTurn = {
  user: '에스파 KISS N TELL 틀어줘',
  assistant: 'aespa KISS N TELL MV 재생 시작했어.',
  route: 'main',
  tools: [{ name: 'app_action', args: 'app_name=youtube, action_type=OPEN_SEARCH', outcome: 'ok' }],
};

const FILE_READ: AoiTurnCorpusTurn = {
  user: 'src/lib/aoiRunLedger.ts 읽어줘',
  assistant:
    '읽었어. 런 레저 엔트리를 만들고 이벤트를 누적하는 모듈이야. 320줄이고 저장은 /api/session-data로 해.',
  route: 'main',
  tools: [{ name: 'ide_read_file', args: 'path=src/lib/aoiRunLedger.ts', outcome: 'ok' }],
};

const FILE_EDIT: AoiTurnCorpusTurn = {
  user: '현재 파일에 TODO 섹션 추가해줘',
  assistant: 'docs/notes.md 끝에 TODO 섹션 추가했어.',
  route: 'main',
  tools: [{ name: 'ide_patch_file', args: 'path=docs/notes.md', outcome: 'ok' }],
};

const TEST_FAILED: AoiTurnCorpusTurn = {
  user: '테스트 돌려줘',
  assistant: 'pnpm test 돌렸는데 chatTokenControl 테스트 2개가 실패했어.',
  route: 'main',
  tools: [{ name: 'run_command', args: 'command=pnpm test', outcome: 'error' }],
};

const BUILD_OFFER: AoiTurnCorpusTurn = {
  user: '변경사항 다 반영됐어?',
  assistant: '반영됐어. 빌드 한 번 돌릴까?',
  route: 'main',
};

const SAVE_OFFER: AoiTurnCorpusTurn = {
  user: '이 내용 정리해줘',
  assistant: '정리했어. notes.md에 저장할까?',
  route: 'main',
};

const CHAT_OFFER: AoiTurnCorpusTurn = {
  user: '오늘 좀 힘들었어',
  assistant: '그랬구나. 무슨 일이었는지 더 얘기할래?',
  route: 'dialog',
};

const FILE_WHICH: AoiTurnCorpusTurn = {
  user: '그 파일 정리해줘',
  assistant: 'src/lib/aoiRunLedger.ts 말하는 거지?',
  route: 'main',
  outcome: 'clarification_asked',
  openQuestion: 'src/lib/aoiRunLedger.ts 말하는 거지?',
};

const NOTES_OPENED: AoiTurnCorpusTurn = {
  user: '메모 앱 열어줘',
  assistant: '메모 앱 열었어.',
  route: 'main',
  tools: [
    { name: 'app_action', args: 'app_name=notes, action_type=OPEN_APP_WINDOW', outcome: 'ok' },
  ],
};

const CHROME_READ: AoiTurnCorpusTurn = {
  user: '크롬에서 지금 탭 읽어봐',
  assistant: '네이버 뉴스 메인이 열려 있어. 헤드라인 3개 요약하면...',
  route: 'main',
  tools: [{ name: 'host_browser_read', args: 'url=https://news.naver.com', outcome: 'ok' }],
};

function c(
  id: string,
  text: string,
  gold: AoiTurnCorpusGold,
  tags: string[],
  turns?: AoiTurnCorpusTurn[],
): AoiTurnCorpusCase {
  return { id, text, gold, tags, ...(turns ? { turns } : {}) };
}

const dialog = (kind: AoiTurnKind): AoiTurnCorpusGold => ({
  kind,
  families: ['none'],
  route: 'dialog',
});
const main = (
  kind: AoiTurnKind,
  families: AoiCapabilityFamily[],
  refersToTurn?: number,
): AoiTurnCorpusGold => ({
  kind,
  families,
  route: 'main',
  ...(refersToTurn ? { refersToTurn } : {}),
});

export const AOI_TURN_UNDERSTANDING_CORPUS: readonly AoiTurnCorpusCase[] = [
  // --- chitchat -----------------------------------------------------------
  c('chat-01', '오늘 좀 피곤하다', dialog('chitchat'), ['chitchat', 'ko']),
  c('chat-02', '고마워', dialog('chitchat'), ['chitchat', 'ko']),
  c('chat-03', 'ㅋㅋㅋ 웃기다', dialog('chitchat'), ['chitchat', 'ko']),
  c('chat-04', '잘 잤어?', dialog('chitchat'), ['chitchat', 'ko']),
  c('chat-05', '밥 먹었어?', dialog('chitchat'), ['chitchat', 'ko']),
  c('chat-06', '심심해', dialog('chitchat'), ['chitchat', 'ko']),
  c('chat-07', '오늘 날씨 좋다', dialog('chitchat'), ['chitchat', 'ko']),
  c('chat-08', '나 왔어', dialog('chitchat'), ['chitchat', 'ko']),
  c('chat-09', '굿나잇', dialog('chitchat'), ['chitchat', 'ko']),
  c('chat-10', '수고했어', dialog('chitchat'), ['chitchat', 'ko']),
  c('chat-11', '재밌었어', dialog('chitchat'), ['chitchat', 'ko']),
  c('chat-12', '그냥 좀 쉬고 싶어', dialog('chitchat'), ['chitchat', 'ko']),
  c('chat-13', '요즘 회사 일이 많아', dialog('chitchat'), ['chitchat', 'ko']),
  c('chat-14', '오늘은 여기까지 하자', dialog('chitchat'), ['chitchat', 'ko']),
  c('chat-15', '너랑 얘기하면 편하다', dialog('chitchat'), ['chitchat', 'ko']),
  c('chat-16', 'hi', dialog('chitchat'), ['chitchat', 'en']),
  c('chat-17', 'That sounds nice', dialog('chitchat'), ['chitchat', 'en']),
  c('chat-18', "I'm back", dialog('chitchat'), ['chitchat', 'en']),
  c('chat-19', 'long day today', dialog('chitchat'), ['chitchat', 'en']),
  c('chat-20', 'thanks, that helped', dialog('chitchat'), ['chitchat', 'en']),
  c('chat-21', 'Kira 좋네', dialog('chitchat'), ['chitchat', 'ko', 'app-name-mention']),
  c('chat-22', "Aoi's IDE 꽤 마음에 들어", dialog('chitchat'), [
    'chitchat',
    'ko',
    'app-name-mention',
  ]),
  c('chat-23', '아 맞다 내일 회의 있네', dialog('chitchat'), ['chitchat', 'ko']),
  c('chat-24', '커피 한 잔 하고 올게', dialog('chitchat'), ['chitchat', 'ko']),
  c('chat-25', '점심 뭐 먹을까 고민이야', dialog('chitchat'), ['chitchat', 'ko']),

  // --- questions the model can answer without tools ------------------------
  c('q-01', '왜 그렇게 생각해?', dialog('question'), ['question', 'ko']),
  c('q-02', 'TPM이 뭐야?', dialog('question'), ['question', 'ko']),
  c('q-03', 'IRQL이 뭔지 설명해줘', dialog('question'), ['question', 'ko', 'explain-word']),
  c('q-04', '어땠어?', dialog('question'), ['question', 'ko']),
  c('q-05', '기술적인 뒷맛이 궁금해', dialog('question'), ['question', 'ko']),
  c('q-06', '커널 드라이버에서 페이지 폴트 나면 어떻게 돼?', dialog('question'), [
    'question',
    'ko',
  ]),
  c('q-07', '이 두 접근 중에 뭐가 나아?', dialog('question'), ['question', 'ko']),
  c('q-08', '그건 왜 안 되는 거야?', dialog('question'), ['question', 'ko']),
  c('q-09', 'What is a page table walker?', dialog('question'), ['question', 'en']),
  c('q-10', 'How does prompt caching work?', dialog('question'), [
    'question',
    'en',
    'explain-word',
  ]),
  c('q-11', 'Why did you pick that one?', dialog('question'), ['question', 'en']),
  c('q-12', '방금 말한 거 좀 더 풀어서 말해줘', dialog('question'), ['question', 'ko']),
  c('q-13', 'DKOM이 탐지 관점에서 왜 어려워?', dialog('question'), ['question', 'ko']),
  c('q-14', '이게 맞는 방향이야?', dialog('question'), ['question', 'ko']),
  c('q-15', 'Which is faster, mutex or spinlock?', dialog('question'), ['question', 'en']),

  // --- questions that need a tool to answer --------------------------------
  c('qt-01', 'Kira 모델 설정 뭐야?', main('question', ['app']), ['question', 'ko', 'needs-tool']),
  c('qt-02', '지금 무슨 프로세스 돌아?', main('question', ['host']), [
    'question',
    'ko',
    'needs-tool',
  ]),
  c('qt-03', '이 파일 뭐 하는 거야?', main('question', ['file']), ['question', 'ko', 'needs-tool']),
  c('qt-04', '최신 뉴스 뭐 있어?', main('question', ['research']), [
    'question',
    'ko',
    'needs-tool',
  ]),
  c('qt-05', 'Which window is currently active?', main('question', ['host']), [
    'question',
    'en',
    'needs-tool',
  ]),
  c('qt-06', 'What are Kira model settings?', main('question', ['app']), [
    'question',
    'en',
    'needs-tool',
  ]),
  c('qt-07', '이 폴더에 뭐 있어?', main('question', ['file']), ['question', 'ko', 'needs-tool']),
  c('qt-08', '오늘 속보 뭐 있어?', main('question', ['research']), [
    'question',
    'ko',
    'needs-tool',
  ]),
  c('qt-09', 'ChatPanel 컴포넌트 어디 있어?', main('question', ['file']), [
    'question',
    'ko',
    'needs-tool',
  ]),
  c('qt-10', 'is the dev server running?', main('question', ['host']), [
    'question',
    'en',
    'needs-tool',
  ]),

  // --- app actions --------------------------------------------------------
  c('app-01', '에스파 KISS N TELL 틀어줘', main('action_request', ['app']), [
    'action',
    'app',
    'ko',
  ]),
  c('app-02', '9월 걸그룹 노래 틀어줘', main('action_request', ['app']), ['action', 'app', 'ko']),
  c('app-03', '유튜브 켜줘', main('action_request', ['app']), ['action', 'app', 'ko']),
  c('app-04', '노래 하나 추천해서 틀어줘', main('action_request', ['app']), [
    'action',
    'app',
    'ko',
  ]),
  c('app-05', '메모 앱 열어줘', main('action_request', ['app']), ['action', 'app', 'ko']),
  c('app-06', '타이머 5분 맞춰줘', main('action_request', ['app']), ['action', 'app', 'ko']),
  c('app-07', 'Open Written By Me', main('action_request', ['app']), ['action', 'app', 'en']),
  c('app-08', "Aoi's IDE 열어줘", main('action_request', ['app']), ['action', 'app', 'ko']),
  c('app-09', 'play something upbeat', main('action_request', ['app']), ['action', 'app', 'en']),
  c('app-10', 'open the notes app', main('action_request', ['app']), ['action', 'app', 'en']),
  c('app-11', '유튜브에서 틀어줘', main('action_request', ['app']), ['action', 'app', 'ko']),
  c('app-12', 'Kira 모델 설정을 high/deep으로 변경해줘', main('action_request', ['app']), [
    'action',
    'app',
    'ko',
  ]),
  c('app-13', '캘린더에 내일 3시 회의 추가해줘', main('action_request', ['app']), [
    'action',
    'app',
    'ko',
  ]),
  c('app-14', '음악 꺼줘', main('action_request', ['app']), ['action', 'app', 'ko']),
  c('app-15', 'queue up some lo-fi', main('action_request', ['app']), ['action', 'app', 'en']),

  // --- files --------------------------------------------------------------
  c('file-01', 'src/lib/aoiRunLedger.ts 읽어줘', main('action_request', ['file']), [
    'action',
    'file',
    'ko',
  ]),
  c('file-02', '현재 파일에 TODO 내용을 추가해줘', main('action_request', ['file']), [
    'action',
    'file',
    'ko',
  ]),
  c('file-03', 'read the current file', main('action_request', ['file']), ['action', 'file', 'en']),
  c('file-04', 'docs/notes.md 끝에 오늘 정리한 내용 써줘', main('action_request', ['file']), [
    'action',
    'file',
    'ko',
  ]),
  c('file-05', '이 함수 리팩터링해서 저장해줘', main('action_request', ['file']), [
    'action',
    'file',
    'ko',
  ]),
  c('file-06', 'Find the ChatPanel component in the codebase', main('action_request', ['file']), [
    'action',
    'file',
    'en',
  ]),
  c('file-07', 'package.json 열어봐', main('action_request', ['file']), ['action', 'file', 'ko']),
  c('file-08', '새 파일 utils/format.ts 만들어줘', main('action_request', ['file']), [
    'action',
    'file',
    'ko',
  ]),
  c('file-09', 'delete the temp folder', main('action_request', ['file']), [
    'action',
    'file',
    'en',
  ]),
  c('file-10', '방금 말한 내용을 현재 파일에 써줘', main('action_request', ['file']), [
    'action',
    'file',
    'ko',
  ]),
  c('file-11', '워크스페이스에서 shouldUseDialogModel 찾아줘', main('action_request', ['file']), [
    'action',
    'file',
    'ko',
  ]),
  c('file-12', 'rename this file to index.ts', main('action_request', ['file']), [
    'action',
    'file',
    'en',
  ]),

  // --- commands -----------------------------------------------------------
  c('cmd-01', '빌드 돌려줘', main('action_request', ['command']), ['action', 'command', 'ko']),
  c('cmd-02', '테스트 실행해', main('action_request', ['command']), ['action', 'command', 'ko']),
  c('cmd-03', '커밋해줘', main('action_request', ['command']), ['action', 'command', 'ko']),
  c('cmd-04', 'run the tests', main('action_request', ['command']), ['action', 'command', 'en']),
  c('cmd-05', 'lint 돌려봐', main('action_request', ['command']), ['action', 'command', 'ko']),
  c('cmd-06', 'pnpm build 해봐', main('action_request', ['command']), ['action', 'command', 'ko']),
  c('cmd-07', 'git status 확인해줘', main('action_request', ['command']), [
    'action',
    'command',
    'ko',
  ]),
  c('cmd-08', '타입체크 해줘', main('action_request', ['command']), ['action', 'command', 'ko']),

  // --- browser ------------------------------------------------------------
  c('web-01', '크롬 열어줘', main('action_request', ['browser']), ['action', 'browser', 'ko']),
  c('web-02', '네이버 확인해봐', main('action_request', ['browser']), ['action', 'browser', 'ko']),
  c('web-03', '내 크롬 브라우저 접근해봐', main('action_request', ['browser']), [
    'action',
    'browser',
    'ko',
  ]),
  c('web-04', 'https://example.com 요약해줘', main('action_request', ['browser']), [
    'action',
    'browser',
    'ko',
    'url',
  ]),
  c('web-05', 'open chrome', main('action_request', ['browser']), ['action', 'browser', 'en']),
  c('web-06', '지금 열린 탭 읽어봐', main('action_request', ['browser']), [
    'action',
    'browser',
    'ko',
  ]),
  c('web-07', 'Access my Chrome browser', main('action_request', ['browser']), [
    'action',
    'browser',
    'en',
  ]),
  c('web-08', '브라우저 드라이브로 네이버 확인해봐', main('action_request', ['browser']), [
    'action',
    'browser',
    'ko',
  ]),

  // --- host PC ------------------------------------------------------------
  c('host-01', '메모장 켜줘', main('action_request', ['host']), ['action', 'host', 'ko']),
  c('host-02', '계산기 실행해', main('action_request', ['host']), ['action', 'host', 'ko']),
  c('host-03', '지금 실행 중인 프로세스 보여줘', main('action_request', ['host']), [
    'action',
    'host',
    'ko',
  ]),
  c('host-04', 'notepad 열어', main('action_request', ['host']), ['action', 'host', 'ko']),
  c('host-05', 'kill the calculator process', main('action_request', ['host']), [
    'action',
    'host',
    'en',
  ]),
  c('host-06', 'list running programs', main('action_request', ['host']), ['action', 'host', 'en']),

  // --- binary analysis labs -----------------------------------------------
  c('ida-01', 'IDA로 이 바이너리 분석해줘', main('action_request', ['ida']), [
    'action',
    'ida',
    'ko',
  ]),
  c('ida-02', 'idasql로 함수 목록 뽑아줘', main('action_request', ['ida']), [
    'action',
    'ida',
    'ko',
  ]),
  c('ida-03', 'IDA에서 xref 찾아줘', main('action_request', ['ida']), ['action', 'ida', 'ko']),
  c('ida-04', 'list functions in IDA', main('action_request', ['ida']), ['action', 'ida', 'en']),
  c('ghidra-01', 'Ghidra에서 main 함수 디컴파일해줘', main('action_request', ['ghidra']), [
    'action',
    'ghidra',
    'ko',
  ]),
  c('ghidra-02', '기드라로 문자열 검색해봐', main('action_request', ['ghidra']), [
    'action',
    'ghidra',
    'ko',
  ]),
  c('ghidra-03', 'decompile this function in Ghidra', main('action_request', ['ghidra']), [
    'action',
    'ghidra',
    'en',
  ]),
  c('ghidra-04', 'ghidra 프로젝트 열어서 심볼 목록 보여줘', main('action_request', ['ghidra']), [
    'action',
    'ghidra',
    'ko',
  ]),

  // --- research -----------------------------------------------------------
  c('res-01', '최신 뉴스 검색해줘', main('action_request', ['research']), [
    'action',
    'research',
    'ko',
  ]),
  c('res-02', '이거 웹에서 검증해봐', main('action_request', ['research']), [
    'action',
    'research',
    'ko',
  ]),
  c('res-03', 'Rust 2026 로드맵 조사해서 정리해줘', main('action_request', ['research']), [
    'action',
    'research',
    'ko',
  ]),
  c('res-04', 'search the web for the latest CVE', main('action_request', ['research']), [
    'action',
    'research',
    'en',
  ]),
  c('res-05', 'Can you verify this fact on the web?', main('action_request', ['research']), [
    'action',
    'research',
    'en',
  ]),
  c('res-06', '이 주제로 보고서 만들어줘, 출처 포함해서', main('action_request', ['research']), [
    'action',
    'research',
    'ko',
  ]),
  c('res-07', 'look up the current price of RTX 5090', main('action_request', ['research']), [
    'action',
    'research',
    'en',
  ]),
  c('res-08', '안티치트 커널 드라이버 최신 동향 조사해줘', main('action_request', ['research']), [
    'action',
    'research',
    'ko',
  ]),
  c('res-09', '두 라이브러리 비교 조사해줘', main('action_request', ['research']), [
    'action',
    'research',
    'ko',
  ]),
  c('res-10', '리서치 시작해', main('action_request', ['research']), ['action', 'research', 'ko']),

  // --- memory -------------------------------------------------------------
  c('mem-01', '내 생일은 3월 3일이야 기억해줘', main('action_request', ['memory']), [
    'action',
    'memory',
    'ko',
  ]),
  c('mem-02', '이거 기억해 둬', main('action_request', ['memory']), ['action', 'memory', 'ko']),
  c('mem-03', 'remember that I prefer dark mode', main('action_request', ['memory']), [
    'action',
    'memory',
    'en',
  ]),
  c('mem-04', 'Kira는 내 프로젝트 이름이야, 기억해', main('action_request', ['memory']), [
    'action',
    'memory',
    'ko',
  ]),
  c('mem-05', 'forget what I said about the deadline', main('action_request', ['memory']), [
    'action',
    'memory',
    'en',
  ]),

  // --- images -------------------------------------------------------------
  c('img-01', '고양이 그림 그려줘', main('action_request', ['image']), ['action', 'image', 'ko']),
  c('img-02', '일러스트 하나 만들어줘', main('action_request', ['image']), [
    'action',
    'image',
    'ko',
  ]),
  c('img-03', 'draw a sunset over the sea', main('action_request', ['image']), [
    'action',
    'image',
    'en',
  ]),
  c('img-04', 'generate an image of a robot', main('action_request', ['image']), [
    'action',
    'image',
    'en',
  ]),

  // --- confirmations (depend on the previous turn) ------------------------
  c(
    'yes-01',
    '응',
    main('confirmation', ['app'], 1),
    ['confirmation', 'ko', 'context'],
    [MUSIC_OFFER],
  ),
  c(
    'yes-02',
    '그래',
    main('confirmation', ['app'], 1),
    ['confirmation', 'ko', 'context'],
    [MUSIC_OFFER],
  ),
  c(
    'yes-03',
    '▶ 재생',
    main('confirmation', ['app'], 1),
    ['confirmation', 'ko', 'chip', 'context'],
    [MUSIC_OFFER],
  ),
  c(
    'yes-04',
    '좋아 그걸로',
    main('confirmation', ['app'], 1),
    ['confirmation', 'ko', 'context'],
    [MUSIC_OFFER],
  ),
  c(
    'yes-05',
    'yes do it',
    main('confirmation', ['app'], 1),
    ['confirmation', 'en', 'context'],
    [MUSIC_OFFER],
  ),
  c(
    'yes-06',
    '응 돌려',
    main('confirmation', ['command'], 1),
    ['confirmation', 'ko', 'context'],
    [BUILD_OFFER],
  ),
  c(
    'yes-07',
    'ㅇㅇ',
    main('confirmation', ['file'], 1),
    ['confirmation', 'ko', 'context'],
    [SAVE_OFFER],
  ),
  c(
    'yes-08',
    '응 저장해',
    main('confirmation', ['file'], 1),
    ['confirmation', 'ko', 'context'],
    [SAVE_OFFER],
  ),
  c(
    'yes-09',
    '맞아',
    main('confirmation', ['file'], 1),
    ['confirmation', 'ko', 'context'],
    [FILE_READ, FILE_WHICH],
  ),
  c(
    'yes-10',
    '응',
    dialog('confirmation'),
    ['confirmation', 'ko', 'context', 'conversational'],
    [CHAT_OFFER],
  ),
  c(
    'yes-11',
    'sure, go ahead',
    main('confirmation', ['command'], 1),
    ['confirmation', 'en', 'context'],
    [BUILD_OFFER],
  ),
  c(
    'yes-12',
    '오케이 진행해',
    main('confirmation', ['command'], 1),
    ['confirmation', 'ko', 'context'],
    [BUILD_OFFER],
  ),

  // --- rejections and corrections -----------------------------------------
  c(
    'no-01',
    '아니 그거 말고',
    main('rejection_or_correction', ['app'], 1),
    ['rejection', 'ko', 'context'],
    [MUSIC_OFFER],
  ),
  c(
    'no-02',
    '아니야 다른 거',
    main('rejection_or_correction', ['app'], 1),
    ['rejection', 'ko', 'context'],
    [MUSIC_OFFER],
  ),
  c(
    'no-03',
    'no not that one',
    main('rejection_or_correction', ['app'], 1),
    ['rejection', 'en', 'context'],
    [MUSIC_OFFER],
  ),
  c(
    'no-04',
    '아니 다른 노래',
    main('rejection_or_correction', ['app'], 1),
    ['rejection', 'ko', 'context'],
    [MUSIC_PLAYED],
  ),
  c(
    'no-05',
    'wrong file, the other one',
    main('rejection_or_correction', ['file'], 1),
    ['rejection', 'en', 'context'],
    [FILE_READ],
  ),
  c(
    'no-06',
    '됐어 그만해',
    dialog('rejection_or_correction'),
    ['rejection', 'ko', 'context'],
    [CHAT_OFFER],
  ),
  c(
    'no-07',
    '그게 아니라 aoiTurnRecord.ts',
    main('rejection_or_correction', ['file'], 1),
    ['rejection', 'ko', 'context'],
    [FILE_READ, FILE_WHICH],
  ),
  c(
    'no-08',
    '아니 취소해',
    main('rejection_or_correction', ['command'], 1),
    ['rejection', 'ko', 'context'],
    [BUILD_OFFER],
  ),

  // --- anaphora: the request points at an earlier turn ----------------------
  c(
    'ref-01',
    '그거 다시 읽어줘',
    main('action_request', ['file'], 1),
    ['action', 'file', 'anaphora', 'ko'],
    [FILE_READ],
  ),
  c(
    'ref-02',
    '아까 그 파일 열어줘',
    main('action_request', ['file'], 2),
    ['action', 'file', 'anaphora', 'ko'],
    [FILE_READ, CHAT_OFFER],
  ),
  c(
    'ref-03',
    '다시 해줘',
    main('action_request', ['command'], 1),
    ['action', 'command', 'anaphora', 'ko'],
    [TEST_FAILED],
  ),
  c(
    'ref-04',
    '그 노래 다시 틀어줘',
    main('action_request', ['app'], 1),
    ['action', 'app', 'anaphora', 'ko'],
    [MUSIC_PLAYED],
  ),
  c(
    'ref-05',
    'the same one again',
    main('action_request', ['app'], 1),
    ['action', 'app', 'anaphora', 'en'],
    [MUSIC_PLAYED],
  ),
  c(
    'ref-06',
    '거기에 방금 내용 붙여줘',
    main('action_request', ['file'], 1),
    ['action', 'file', 'anaphora', 'ko'],
    [FILE_EDIT],
  ),
  c(
    'ref-07',
    '그거 커밋해줘',
    main('action_request', ['command'], 1),
    ['action', 'command', 'anaphora', 'ko'],
    [FILE_EDIT],
  ),
  c(
    'ref-08',
    '그 앱 닫아줘',
    main('action_request', ['app'], 1),
    ['action', 'app', 'anaphora', 'ko'],
    [NOTES_OPENED],
  ),
  c(
    'ref-09',
    '재시도?',
    main('action_request', ['command'], 1),
    ['action', 'command', 'anaphora', 'ko'],
    [TEST_FAILED],
  ),
  c(
    'ref-10',
    '그 문서 작업 계속해',
    main('action_request', ['file'], 1),
    ['action', 'file', 'anaphora', 'ko'],
    [FILE_EDIT],
  ),
  c(
    'ref-11',
    '그 탭 다시 읽어봐',
    main('action_request', ['browser'], 1),
    ['action', 'browser', 'anaphora', 'ko'],
    [CHROME_READ],
  ),
  c(
    'ref-12',
    'retry that',
    main('action_request', ['command'], 1),
    ['action', 'command', 'anaphora', 'en'],
    [TEST_FAILED],
  ),

  // --- meta: about Aoi herself --------------------------------------------
  c('meta-01', '너 어떤 모델이야?', dialog('meta'), ['meta', 'ko']),
  c('meta-02', '너 지금 뭐 할 수 있어?', dialog('meta'), ['meta', 'ko']),
  c('meta-03', 'who are you', dialog('meta'), ['meta', 'en']),
  c('meta-04', 'what model are you running on', dialog('meta'), ['meta', 'en']),
  c('meta-05', '너 기억 어떻게 하는 거야?', dialog('meta'), ['meta', 'ko']),
  c('meta-06', '네 설정 바꾸려면 어디로 가야 해?', dialog('meta'), ['meta', 'ko']),
];
