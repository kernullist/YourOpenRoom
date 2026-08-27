// Can Aoi actually reach IDA Lab from a chat turn?
//
// The tools existed and the app worked, and Aoi still answered reversing
// questions by saying it had no such ability. Two separate gates were the
// reason, and neither was in the IDA code itself.
import { beforeEach, describe, expect, it } from 'vitest';

import { shouldUseDialogModel } from '../chatTokenControl';
import {
  markIdaSqlSessionTouched,
  resetIdaSqlToolStickiness,
  shouldEnableIdaSqlTools,
} from '../aoiIdaSqlTools';

/** The two conditions the chat panel ANDs together before offering the tools. */
function idaToolsRide(
  message: string,
  history: { role: 'user' | 'assistant'; content: string }[] = [],
): boolean {
  return shouldEnableIdaSqlTools(message, history) && !shouldUseDialogModel(message, history);
}

beforeEach(() => {
  resetIdaSqlToolStickiness();
});

describe('the dialog-route gap', () => {
  // The dialog model's tool array is respond_to_user + finish_target only. A
  // short reversing question cleared every bar in shouldUseDialogModel -- under
  // 240 chars, no URL, no search/why/how keyword -- so it routed there and Aoi
  // truthfully reported it could not analyze binaries. hasBrowserIntent and
  // shouldEnableAppTools already had escapes for exactly this; IDA had none.
  const REVERSING_QUESTIONS = [
    'ntoskrnl 함수 목록 보여줘',
    'ntoskrnl.exe 분석해줘',
    'IDA로 열어줘',
    '디컴파일 결과 보여줘',
    '역분석 좀 해줘',
    'decompile that function',
    '임포트 테이블 보여줘',
    '문자열 테이블에서 http 들어간 거 찾아줘',
  ];

  for (const question of REVERSING_QUESTIONS) {
    it(`keeps "${question}" off the dialog route`, () => {
      expect(shouldUseDialogModel(question, [])).toBe(false);
      expect(idaToolsRide(question)).toBe(true);
    });
  }

  it('leaves genuinely ambiguous wording to the sticky flag, not to a guess', () => {
    // "show me the imports" is a reversing question or a CSV question depending
    // entirely on context. Widening the keyword list to catch it would put six
    // tool definitions on unrelated turns forever; what actually makes it a
    // reversing question is that a session is open, which stickiness knows.
    expect(shouldEnableIdaSqlTools('show me the imports', [])).toBe(false);
    markIdaSqlSessionTouched();
    expect(shouldEnableIdaSqlTools('show me the imports', [])).toBe(true);
  });

  it('still sends an ordinary chat turn to the dialog model', () => {
    // The escape must not swallow the route it was carved out of.
    expect(shouldUseDialogModel('오늘 기분 어때?', [])).toBe(true);
    expect(idaToolsRide('오늘 기분 어때?')).toBe(false);
  });
});

describe('follow-up turns once a session is open', () => {
  // These carry no IDA vocabulary at all. Nothing in the words can save them --
  // the fact that makes them reversing questions is that a session exists.
  const FOLLOW_UPS = [
    '제일 큰 함수 몇 개만',
    'PsSetCreateProcessNotifyRoutine 어디서 호출돼?',
    '지금 열려있는 세션에서 제일 큰 함수 10개',
    '그거 좀 더 보여줘',
  ];

  it('drops them when nothing is open, which is correct', () => {
    for (const question of FOLLOW_UPS) {
      expect(shouldEnableIdaSqlTools(question, [])).toBe(false);
    }
  });

  it('carries them once a session has been marked', () => {
    markIdaSqlSessionTouched();
    for (const question of FOLLOW_UPS) {
      expect(shouldEnableIdaSqlTools(question, []), question).toBe(true);
      expect(idaToolsRide(question), question).toBe(true);
    }
  });

  it('remembers across a reload, because the session outlives the page', () => {
    markIdaSqlSessionTouched();
    // A reload loses module state but not localStorage. Simulate by clearing
    // only the in-memory half the way a fresh module instance would start.
    const stored = globalThis.localStorage?.getItem('aoi.idaSql.sessionTouchedAt');
    expect(stored).toBeTruthy();
    expect(shouldEnableIdaSqlTools('제일 큰 함수 몇 개만', [])).toBe(true);
  });

  it('lets the mark expire, so yesterday does not keep paying for six tools', () => {
    const thirteenHoursAgo = Date.now() - 13 * 60 * 60 * 1000;
    markIdaSqlSessionTouched(thirteenHoursAgo);
    expect(shouldEnableIdaSqlTools('제일 큰 함수 몇 개만', [])).toBe(false);
  });

  it('treats a stamp from the future as current rather than as expired', () => {
    // A clock that jumped backwards should not silently disable the tools.
    markIdaSqlSessionTouched(Date.now() + 60 * 60 * 1000);
    expect(shouldEnableIdaSqlTools('제일 큰 함수 몇 개만', [])).toBe(true);
  });
});
