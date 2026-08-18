// Postcondition contract: Aoi may not say an in-room app did something unless it
// actually dispatched an app_action that succeeded.
//
// The deterministic intent parsers in ChatPanel catch the common "play this"
// phrasings before the model ever runs. Everything they miss reaches the LLM --
// and the LLM has repeatedly answered "틀어줄게 / 재생 준비해뒀어" without calling
// app_action at all, so nothing opened and nothing played. Each individual miss
// was fixed by widening a parser, but the shape of the failure is structural:
// a missed parse degrades into a confident false claim.
//
// This closes it from the other end. When the user's message asks an app to act,
// the claim in the reply is checked against what was actually dispatched this
// turn. A claim with no successful dispatch behind it fails the postcondition,
// which feeds a correction back to the model (call app_action, or stop saying
// you did) exactly like the file-task and outcome-feedback contracts do.
//
// Deliberately narrow: it only fires when the user asked for an app action AND
// the reply claims one happened. Offers ("틀어줄까?"), refusals, and questions
// are not claims, and a turn that never asked for anything is never enforced.

export type AoiAppActionClaimKind = 'playback' | 'app_open';

export interface AoiAppActionClaimContract {
  kind: AoiAppActionClaimKind;
  // The user message that created the obligation, for the correction prompt.
  sourceMessage: string;
  // Whether app_action was actually in this turn's tool array. False means the
  // claim is still wrong, but the model cannot fix it by dispatching -- the
  // correction has to ask it to drop the claim instead of telling it to act.
  appToolsAvailable: boolean;
}

export interface AoiAppActionDispatchRecord {
  appId: number;
  actionType: string;
  result: string;
}

export interface AoiAppActionClaimEvidence {
  succeeded: AoiAppActionDispatchRecord[];
  failed: AoiAppActionDispatchRecord[];
}

export interface AoiAppActionClaimVerification {
  passed: boolean;
  enforced: boolean;
  issues: string[];
}

export function createAoiAppActionClaimEvidence(): AoiAppActionClaimEvidence {
  return { succeeded: [], failed: [] };
}

// dispatchAgentAction resolves (never rejects) with "error:"/"timeout:" when the
// action did not happen, so success cannot be inferred from the absence of a
// thrown error. Mirrors chatDirectActions.isFailedAgentActionResult; kept local
// so this module stays dependency-free and testable on its own.
function isFailedDispatchResult(result: string): boolean {
  const normalized = result.trim().toLowerCase();
  return normalized === '' || normalized.startsWith('error:') || normalized.startsWith('timeout:');
}

export function observeAoiAppActionDispatch(
  evidence: AoiAppActionClaimEvidence,
  record: AoiAppActionDispatchRecord,
): AoiAppActionClaimEvidence {
  if (isFailedDispatchResult(record.result)) {
    return { ...evidence, failed: [...evidence.failed, record] };
  }
  return { ...evidence, succeeded: [...evidence.succeeded, record] };
}

// --- Request detection --------------------------------------------------------

// "Play something" in the languages Aoi speaks. Verb stems only: the surrounding
// grammar varies far too much to enumerate.
const PLAYBACK_REQUEST_PATTERN =
  /(틀어|틀어줘|틀어줄래|재생|들려|들을래|플레이|かけて|流して|再生|播放|放一?首|\bplay\b|\bput\s+on\b|\blisten\s+to\b)/iu;

// "Open / launch that app".
const APP_OPEN_REQUEST_PATTERN =
  /(열어|띄워|실행|켜줘|보여줘|開いて|起動|打开|启动|\bopen\b|\blaunch\b|\bstart\s+up\b)/iu;

// A question ABOUT music is not a request to play it. Checked first so "무슨
// 노래 좋아해?" never creates an obligation.
const NON_REQUEST_PATTERN =
  /(뭐야\?|뭐였|어떤\s*(?:거|것|곡|노래)\?|좋아해\?|알아\?|있어\?|추천해?줄래\?|\bwhat\b.*\?|\bwhich\b.*\?|\bdo you\b.*\?)/iu;

/**
 * Decide whether this user turn obliges Aoi to actually drive an app.
 *
 * Returns null when it does not, which is the common case; the postcondition is
 * then never enforced for the turn.
 *
 * @param knownAppNames In-room app names/labels. "Open X" only arms when the
 * message names one of these. Without that guard the obligation also fired on
 * host PC programs ("계산기 실행해줘"), which go through host_process_spawn and
 * never touch app_action -- the correction would then have demanded the one
 * tool that is wrong for the job. Found by the offline sweep on real runs.
 */
export function resolveAoiAppActionClaimContract(params: {
  latestUserMessage: string;
  knownAppNames?: readonly string[];
  appToolsAvailable?: boolean;
}): AoiAppActionClaimContract | null {
  const message = params.latestUserMessage?.trim() ?? '';
  const appToolsAvailable = params.appToolsAvailable ?? true;
  if (!message) {
    return null;
  }
  if (NON_REQUEST_PATTERN.test(message)) {
    return null;
  }
  if (PLAYBACK_REQUEST_PATTERN.test(message)) {
    return { kind: 'playback', sourceMessage: message, appToolsAvailable };
  }
  if (APP_OPEN_REQUEST_PATTERN.test(message) && namesKnownApp(message, params.knownAppNames)) {
    return { kind: 'app_open', sourceMessage: message, appToolsAvailable };
  }
  return null;
}

function namesKnownApp(message: string, knownAppNames: readonly string[] | undefined): boolean {
  const normalized = message.toLowerCase();
  return (knownAppNames ?? []).some((name) => {
    const candidate = name.trim().toLowerCase();
    return candidate.length > 1 && normalized.includes(candidate);
  });
}

// --- Claim detection ----------------------------------------------------------

// Aoi stating the action is done or is happening now. "틀어줄게" counts: this is
// the last thing said in the turn, so a promise with nothing dispatched behind
// it never comes true.
const PLAYBACK_CLAIM_PATTERN =
  /(틀어줄게|틀어줄께|틀게|틀었|틀어놨|틀어놓|재생할게|재생했|재생하고\s*있|재생\s*준비|재생\s*중|플레이할게|流すね|かけるね|かけたよ|再生する|播放了|正在播放|开始播放|\bplaying\b|\bstarted\b|\blined\s+(?:\w+\s+)?up\b|\bput\s+on\b|\bi'?ll\s+play\b|\bnow\s+playing\b)/iu;

// Stems, not whole phrases: the real acks say "열어둘게" (not "열어줄게"),
// "開いておくね", "打开给你". Matching the exact sentences would have missed
// every one of them.
const APP_OPEN_CLAIM_PATTERN =
  /(열어\s*[둘줄뒀놨놓]|열었|띄워\s*[둘줄뒀놨]|띄웠|실행[했할해]|켜\s*[줄둘]게|켰어|開い|開くね|起動|打开|\bopened\b|\bopening\b|\bi'?ll\s+open\b|\blaunch(?:ed|ing)?\b)/iu;

// An offer is not a claim. Checked first so "틀어줄까?" / "want me to play it?"
// never trips the postcondition.
const OFFER_PATTERN =
  /(줄까\?|할까\?|들을래\?|볼래\?|어때\?|ましょうか|でいい\?|好吗\?|\bwant me to\b|\bshall i\b|\bshould i\b)/iu;

/**
 * True when the reply asserts the app action happened (or is happening now),
 * rather than offering, asking, or declining.
 */
export function detectAoiAppActionClaim(
  assistantContent: string,
  kind: AoiAppActionClaimKind,
): boolean {
  const content = assistantContent?.trim() ?? '';
  if (!content) {
    return false;
  }
  if (OFFER_PATTERN.test(content)) {
    return false;
  }
  return kind === 'playback'
    ? PLAYBACK_CLAIM_PATTERN.test(content)
    : APP_OPEN_CLAIM_PATTERN.test(content);
}

// --- Verification -------------------------------------------------------------

/**
 * Read respond_to_user's self-declaration of what it performed.
 *
 * This is the primary check. Reading the prose and guessing whether it asserts
 * an action is inherently lossy -- a phrasing nobody anticipated slips through,
 * which is how every fix in this area started. A declared list is structured on
 * both sides: the model states what it did, and that is compared against what
 * was really dispatched. The prose detector below stays as the backstop for a
 * reply that claims something while leaving this empty.
 */
export function parseDeclaredAppActions(params: unknown): string[] {
  const raw = (params as { performed_actions?: unknown })?.performed_actions;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function verifyAoiAppActionClaimContract(params: {
  contract: AoiAppActionClaimContract | null;
  evidence: AoiAppActionClaimEvidence;
  assistantContent: string;
  declaredActions?: readonly string[];
}): AoiAppActionClaimVerification {
  const { contract, evidence, assistantContent } = params;
  const declaredActions = params.declaredActions ?? [];

  // A self-declaration is checked on its own terms, with no request contract
  // required: if the model states it performed something and nothing was
  // dispatched, that is a false claim whatever the user happened to ask for.
  if (declaredActions.length > 0 && evidence.succeeded.length === 0) {
    const attempted =
      evidence.failed.length > 0
        ? ` Every app_action attempted this turn failed: ${evidence.failed
            .map((record) => `${record.actionType} -> ${record.result.trim().slice(0, 80)}`)
            .join('; ')}.`
        : ' No app_action was dispatched in this turn.';
    return {
      passed: false,
      enforced: true,
      issues: [
        `the reply declares performed_actions [${declaredActions.join(', ')}] that did not happen.${attempted}`,
      ],
    };
  }

  if (!contract) {
    return { passed: true, enforced: false, issues: [] };
  }
  const claimed = detectAoiAppActionClaim(assistantContent, contract.kind);
  if (!claimed) {
    // Saying nothing happened, asking a question, or offering is always allowed:
    // the contract polices false claims, not unfinished work.
    return { passed: true, enforced: false, issues: [] };
  }
  if (evidence.succeeded.length > 0) {
    return { passed: true, enforced: true, issues: [] };
  }

  const issues: string[] = [];
  if (evidence.failed.length > 0) {
    issues.push(
      `the reply claims the ${contract.kind === 'playback' ? 'playback' : 'app'} happened, but every app_action this turn failed: ` +
        evidence.failed
          .map((record) => `${record.actionType} -> ${record.result.trim().slice(0, 80)}`)
          .join('; '),
    );
  } else {
    issues.push(
      `the reply claims the ${contract.kind === 'playback' ? 'playback' : 'app'} happened, but no app_action was dispatched in this turn`,
    );
  }
  return { passed: false, enforced: true, issues };
}

export function buildAoiAppActionClaimCorrectionPrompt(
  verification: AoiAppActionClaimVerification,
  contract: AoiAppActionClaimContract | null,
  evidence: AoiAppActionClaimEvidence,
): string {
  if (verification.passed) {
    return '';
  }
  const lines = [
    'respond_to_user rejected: you reported an app action that did not happen.',
    ...verification.issues.map((issue) => `- ${issue}`),
    // A self-declaration failure can arrive without a request contract, so this
    // line is only added when there is a request to quote back.
    ...(contract ? [`The user asked: "${contract.sourceMessage.slice(0, 160)}"`] : []),
    // When app_action is not in this turn's tools there is only one way out, and
    // telling the model to call it would loop until the correction budget runs
    // out. Both real cases the sweep surfaced were this.
    ...(contract && !contract.appToolsAvailable
      ? [
          'app_action is NOT available to you in this turn, so you cannot perform it here.',
          'Say plainly that you have not done it and ask for what you need. Do NOT write that you played, opened, started, or lined anything up, and leave performed_actions empty.',
        ]
      : [
          'Do exactly one of these, then call respond_to_user again:',
          '1. Actually perform it. Call list_apps for the numeric app_id, then app_action with the real action (for playback that is the YouTube app OPEN_SEARCH with a query, autoplay="1").',
          '2. If you cannot -- you do not know what to play, or the action is unavailable -- say so plainly and ask for what you need. Do NOT write that you played, opened, started, or lined anything up, and leave performed_actions empty.',
        ]),
  ];
  if (evidence.failed.length > 0) {
    lines.push(
      'An app_action was attempted and failed. Either retry it correctly or tell the user it failed; never describe a failed action as done.',
    );
  }
  return lines.join('\n');
}

export function buildAoiAppActionClaimFailureMessage(
  verification: AoiAppActionClaimVerification,
): string {
  if (verification.passed) {
    return '';
  }
  return `app action claim unverified: ${verification.issues.join('; ')}`;
}
