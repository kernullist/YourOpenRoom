import { describe, expect, it } from 'vitest';

import {
  buildAoiAppActionClaimCorrectionPrompt,
  buildAoiAppActionClaimFailureMessage,
  createAoiAppActionClaimEvidence,
  detectAoiAppActionClaim,
  observeAoiAppActionDispatch,
  parseDeclaredAppActions,
  resolveAoiAppActionClaimContract,
  verifyAoiAppActionClaimContract,
  type AoiAppActionClaimEvidence,
} from '../aoiAppActionClaimContract';

const PLAYBACK_CONTRACT = { kind: 'playback' as const, sourceMessage: '아까 그거 틀어줘' };

function evidenceWith(results: string[]): AoiAppActionClaimEvidence {
  return results.reduce(
    (evidence, result) =>
      observeAoiAppActionDispatch(evidence, { appId: 3, actionType: 'OPEN_SEARCH', result }),
    createAoiAppActionClaimEvidence(),
  );
}

describe('resolveAoiAppActionClaimContract', () => {
  it('creates a playback obligation for a request to play something', () => {
    const requests = [
      '아까 그거 틀어줘',
      '노래 재생해줘',
      '뭐 좀 들려줘',
      'play something chill',
      'put on some lofi',
      '音楽をかけて',
      '放一首歌',
    ];
    for (const message of requests) {
      expect(resolveAoiAppActionClaimContract({ latestUserMessage: message })?.kind, message).toBe(
        'playback',
      );
    }
  });

  it('creates an app-open obligation for a request to open an app', () => {
    for (const message of ['유튜브 열어줘', 'Kira 실행해', 'open the notes app']) {
      expect(resolveAoiAppActionClaimContract({ latestUserMessage: message })?.kind, message).toBe(
        'app_open',
      );
    }
  });

  it('does not oblige anything for a question about music', () => {
    // Talking about music is not asking for it. An obligation here would police
    // ordinary conversation.
    const questions = [
      '무슨 노래 좋아해?',
      '아까 튼 거 뭐야?',
      'what music do you like?',
      'which playlist was that?',
      '오늘 날씨 어때',
      '',
    ];
    for (const message of questions) {
      expect(resolveAoiAppActionClaimContract({ latestUserMessage: message }), message).toBeNull();
    }
  });
});

describe('detectAoiAppActionClaim', () => {
  it('recognizes a reply asserting playback happened', () => {
    const claims = [
      '틀어줄게. 유튜브에서 "어떤 곡" 찾아서 재생 준비해뒀어.',
      '지금 바로 틀어줄게.',
      '틀었어. 볼륨은 네가 정해.',
      '재생하고 있어.',
      "I'll play it now.",
      'Now playing that mix.',
      'I lined it up in YouTube for you.',
    ];
    for (const content of claims) {
      expect(detectAoiAppActionClaim(content, 'playback'), content).toBe(true);
    }
  });

  it('does not treat an offer or a refusal as a claim', () => {
    // The contract polices false claims, not unfinished work: Aoi is always free
    // to offer, ask, or say it could not.
    const nonClaims = [
      '은은한 사운드 하나 깔아줄까?',
      '뭘 틀까? 검색어를 알려주면 바로 찾아줄게',
      '미안, 아까 추천한 곡을 다시 못 찾겠어. 아직 아무것도 틀지 않았어.',
      'Want me to play something?',
      'Shall I put on some music?',
      '',
    ];
    for (const content of nonClaims) {
      expect(detectAoiAppActionClaim(content, 'playback'), content).toBe(false);
    }
  });
});

describe('verifyAoiAppActionClaimContract', () => {
  it('fails a playback claim with no dispatch behind it', () => {
    // The exact reported shape: the parser missed the request, the model
    // answered as if it had played something, and nothing ran.
    const verification = verifyAoiAppActionClaimContract({
      contract: PLAYBACK_CONTRACT,
      evidence: createAoiAppActionClaimEvidence(),
      assistantContent: '아, 그거! 지금 바로 틀어줄게. 늦은 밤에 딱 좋은 곡들이야.',
    });
    expect(verification.passed).toBe(false);
    expect(verification.enforced).toBe(true);
    expect(verification.issues.join(' ')).toContain('no app_action was dispatched');
  });

  it('passes once a dispatch actually succeeded', () => {
    expect(
      verifyAoiAppActionClaimContract({
        contract: PLAYBACK_CONTRACT,
        evidence: evidenceWith(['success']),
        assistantContent: '틀어줄게. 재생 준비해뒀어.',
      }).passed,
    ).toBe(true);
  });

  it('fails when every dispatch failed, and names the failure', () => {
    // dispatchAgentAction resolves with these instead of throwing, so a claim
    // can otherwise survive an action that plainly did not happen.
    const verification = verifyAoiAppActionClaimContract({
      contract: PLAYBACK_CONTRACT,
      evidence: evidenceWith(['error: no results for "x"', 'timeout: no response from app']),
      assistantContent: '틀었어.',
    });
    expect(verification.passed).toBe(false);
    expect(verification.issues.join(' ')).toContain('every app_action this turn failed');
  });

  it('passes when one dispatch succeeded even though another failed', () => {
    expect(
      verifyAoiAppActionClaimContract({
        contract: PLAYBACK_CONTRACT,
        evidence: evidenceWith(['error: nope', 'success']),
        assistantContent: '틀었어.',
      }).passed,
    ).toBe(true);
  });

  it('stays out of the way when nothing was claimed', () => {
    const verification = verifyAoiAppActionClaimContract({
      contract: PLAYBACK_CONTRACT,
      evidence: createAoiAppActionClaimEvidence(),
      assistantContent: '뭘 틀까? 제목을 알려줘.',
    });
    expect(verification.passed).toBe(true);
    expect(verification.enforced).toBe(false);
  });

  it('is never enforced on a turn that asked for nothing', () => {
    expect(
      verifyAoiAppActionClaimContract({
        contract: null,
        evidence: createAoiAppActionClaimEvidence(),
        assistantContent: '틀어줄게!',
      }),
    ).toEqual({ passed: true, enforced: false, issues: [] });
  });
});

describe('the app-open obligation', () => {
  const OPEN_CONTRACT = { kind: 'app_open' as const, sourceMessage: '유튜브 열어줘' };

  it('recognizes a reply asserting an app was opened', () => {
    // The literal acks the app ships, which an exact-phrase pattern missed.
    for (const content of [
      'YouTube를 열어둘게.',
      'Kira를 열어둘게.',
      'YouTubeを開いておくね。',
      '我把 YouTube 打开给你。',
      '띄웠어.',
      'Opened it for you.',
    ]) {
      expect(detectAoiAppActionClaim(content, 'app_open'), content).toBe(true);
    }
  });

  it('does not mistake a playback claim for an app-open claim', () => {
    expect(detectAoiAppActionClaim('틀어줄게.', 'app_open')).toBe(false);
  });

  it('fails an open claim with nothing dispatched, and words the issue for apps', () => {
    const verification = verifyAoiAppActionClaimContract({
      contract: OPEN_CONTRACT,
      evidence: createAoiAppActionClaimEvidence(),
      assistantContent: 'YouTube를 열어둘게.',
    });
    expect(verification.passed).toBe(false);
    expect(verification.issues.join(' ')).toContain('the app happened');
  });

  it('names a failed open attempt rather than the generic wording', () => {
    const verification = verifyAoiAppActionClaimContract({
      contract: OPEN_CONTRACT,
      evidence: evidenceWith(['error: failed to open app_id=3']),
      assistantContent: '열었어.',
    });
    expect(verification.issues.join(' ')).toContain('every app_action this turn failed');
    expect(verification.issues.join(' ')).toContain('failed to open app_id=3');
  });

  it('handles an empty reply without claiming anything', () => {
    expect(detectAoiAppActionClaim('', 'app_open')).toBe(false);
  });
});

describe('parseDeclaredAppActions', () => {
  it('reads the declared list off respond_to_user params', () => {
    expect(
      parseDeclaredAppActions({
        performed_actions: ['youtube OPEN_SEARCH', ' cyberNews VIEW_ARTICLE '],
      }),
    ).toEqual(['youtube OPEN_SEARCH', 'cyberNews VIEW_ARTICLE']);
  });

  it('treats anything missing or malformed as no declaration', () => {
    for (const params of [
      {},
      null,
      undefined,
      { performed_actions: null },
      { performed_actions: 'youtube OPEN_SEARCH' },
      { performed_actions: [] },
      { performed_actions: ['', '   ', 42] },
    ]) {
      expect(parseDeclaredAppActions(params), JSON.stringify(params)).toEqual([]);
    }
  });
});

describe('the self-declaration check', () => {
  it('fails a declared action that never dispatched, whatever the prose says', () => {
    // The point of the field: no phrase matching involved. The reply here reads
    // as an ordinary sentence, and it is still caught.
    const verification = verifyAoiAppActionClaimContract({
      contract: PLAYBACK_CONTRACT,
      evidence: createAoiAppActionClaimEvidence(),
      assistantContent: '오케이, 준비됐어.',
      declaredActions: ['youtube OPEN_SEARCH'],
    });
    expect(verification.passed).toBe(false);
    expect(verification.enforced).toBe(true);
    expect(verification.issues.join(' ')).toContain('performed_actions [youtube OPEN_SEARCH]');
  });

  it('catches a declaration even when the user never asked for anything', () => {
    // No request contract exists here. A self-declaration is checked on its own
    // terms: stating you did something you did not is false either way.
    const verification = verifyAoiAppActionClaimContract({
      contract: null,
      evidence: createAoiAppActionClaimEvidence(),
      assistantContent: '심심해서 하나 틀어놨어.',
      declaredActions: ['youtube OPEN_SEARCH'],
    });
    expect(verification.passed).toBe(false);
    expect(verification.enforced).toBe(true);
  });

  it('names the failed attempt when one was made', () => {
    const verification = verifyAoiAppActionClaimContract({
      contract: PLAYBACK_CONTRACT,
      evidence: evidenceWith(['timeout: no response from app']),
      assistantContent: '틀었어.',
      declaredActions: ['youtube OPEN_SEARCH'],
    });
    expect(verification.issues.join(' ')).toContain('Every app_action attempted this turn failed');
  });

  it('passes a declaration backed by a real dispatch', () => {
    expect(
      verifyAoiAppActionClaimContract({
        contract: PLAYBACK_CONTRACT,
        evidence: evidenceWith(['success']),
        assistantContent: '틀었어.',
        declaredActions: ['youtube OPEN_SEARCH'],
      }).passed,
    ).toBe(true);
  });

  it('still catches a prose claim when the declaration was left empty', () => {
    // The backstop the field does not replace: claiming in text while declaring
    // nothing.
    const verification = verifyAoiAppActionClaimContract({
      contract: PLAYBACK_CONTRACT,
      evidence: createAoiAppActionClaimEvidence(),
      assistantContent: '지금 바로 틀어줄게.',
      declaredActions: [],
    });
    expect(verification.passed).toBe(false);
    expect(verification.issues.join(' ')).toContain('no app_action was dispatched');
  });

  it('does not invent a violation from an empty declaration alone', () => {
    expect(
      verifyAoiAppActionClaimContract({
        contract: PLAYBACK_CONTRACT,
        evidence: createAoiAppActionClaimEvidence(),
        assistantContent: '뭘 틀까?',
        declaredActions: [],
      }).passed,
    ).toBe(true);
  });

  it('explains a contract-less declaration failure without quoting a request', () => {
    const verification = verifyAoiAppActionClaimContract({
      contract: null,
      evidence: createAoiAppActionClaimEvidence(),
      assistantContent: '틀어놨어.',
      declaredActions: ['youtube OPEN_SEARCH'],
    });
    const prompt = buildAoiAppActionClaimCorrectionPrompt(
      verification,
      null,
      createAoiAppActionClaimEvidence(),
    );
    expect(prompt).toContain('performed_actions');
    expect(prompt).not.toContain('The user asked');
  });
});

describe('correction and failure copy', () => {
  it('tells the model both ways out, and never to keep the claim', () => {
    const verification = verifyAoiAppActionClaimContract({
      contract: PLAYBACK_CONTRACT,
      evidence: createAoiAppActionClaimEvidence(),
      assistantContent: '지금 바로 틀어줄게.',
    });
    const prompt = buildAoiAppActionClaimCorrectionPrompt(
      verification,
      PLAYBACK_CONTRACT,
      createAoiAppActionClaimEvidence(),
    );
    expect(prompt).toContain('app_action');
    expect(prompt).toContain('OPEN_SEARCH');
    expect(prompt).toContain('아까 그거 틀어줘');
    expect(prompt).toContain('Do NOT write that you played');
  });

  it('calls out an attempted-but-failed action in the correction', () => {
    const evidence = evidenceWith(['error: article not found']);
    const verification = verifyAoiAppActionClaimContract({
      contract: PLAYBACK_CONTRACT,
      evidence,
      assistantContent: '틀었어.',
    });
    expect(
      buildAoiAppActionClaimCorrectionPrompt(verification, PLAYBACK_CONTRACT, evidence),
    ).toContain('never describe a failed action as done');
  });

  it('produces nothing when the contract passed', () => {
    const passing = { passed: true, enforced: true, issues: [] };
    expect(
      buildAoiAppActionClaimCorrectionPrompt(
        passing,
        PLAYBACK_CONTRACT,
        createAoiAppActionClaimEvidence(),
      ),
    ).toBe('');
    expect(buildAoiAppActionClaimFailureMessage(passing)).toBe('');
  });

  it('summarizes the unmet contract when corrections run out', () => {
    const verification = verifyAoiAppActionClaimContract({
      contract: PLAYBACK_CONTRACT,
      evidence: createAoiAppActionClaimEvidence(),
      assistantContent: '틀어줄게.',
    });
    expect(buildAoiAppActionClaimFailureMessage(verification)).toContain(
      'app action claim unverified',
    );
  });
});
