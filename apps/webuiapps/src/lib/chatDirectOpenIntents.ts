// Regex fast paths the chat panel takes BEFORE the LLM sees a message.
//
// A hit here opens an app and answers with a canned ack, and the message never
// reaches the model. That makes a false positive expensive: the user's actual
// question is dropped. A miss is cheap: the model can still open the app with
// its own tools. So every detector here is built for precision -- a short,
// explicit "open <app>" request with word boundaries on both sides -- and
// anything longer or looser is left to the model.
//
// The older patterns matched substrings ("side project" contained "ide",
// "type" contained "pe") and verbless topics ("Scrum vs Kanban"), and opened
// apps for ordinary questions.

// Longer messages carry more than an open request; let the model read them.
const DIRECT_OPEN_MAX_LENGTH = 80;

// Polite or vocative lead-ins that can precede an English imperative.
const EN_LEAD_IN = String.raw`(?:(?:hey|hi|ok|okay|aoi|please|pls|can you|could you|would you|will you|go ahead and|just)[\s,]+)*`;
// Trailing softeners after an English imperative.
const EN_TAIL = String.raw`(?:[\s,]+(?:for me|please|now|again|up))*[\s.!?]*`;
const EN_OPEN_VERB = String.raw`(?:open|launch|run|start|show|bring up|pull up)(?:\s+up)?`;
const EN_ARTICLE = String.raw`(?:(?:the|my|your)\s+)?`;

// Korean imperatives: 열어줘 / 열어 줘 / 열어줄래 / 열어 주세요 / 실행해 / 실행해줘 ...
const KO_REQUEST_ENDING = String.raw`(?:\s*(?:줘|줄래|줄래요|주세요|주라))?`;
const KO_OPEN_VERB = String.raw`(?:실행(?:해|시켜)${KO_REQUEST_ENDING}|열어${KO_REQUEST_ENDING}|띄워${KO_REQUEST_ENDING}|켜${KO_REQUEST_ENDING}|보여${KO_REQUEST_ENDING})`;
const KO_PARTICLE = String.raw`(?:\s*(?:을|를|좀|좀\s+더))?`;
const KO_TAIL = String.raw`[\s.!?~]*`;

function buildOpenPatterns(enNames: string, koNames: string): RegExp[] {
  return [
    new RegExp(
      String.raw`^\s*${EN_LEAD_IN}${EN_OPEN_VERB}\s+${EN_ARTICLE}(?:${enNames})(?:\s+app)?\b${EN_TAIL}$`,
      'i',
    ),
    new RegExp(
      String.raw`^\s*(?:${koNames}|${enNames})${KO_PARTICLE}\s*${KO_OPEN_VERB}${KO_TAIL}$`,
      'i',
    ),
  ];
}

function matchesShortRequest(text: string, patterns: readonly RegExp[]): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > DIRECT_OPEN_MAX_LENGTH) {
    return false;
  }
  return patterns.some((pattern) => pattern.test(trimmed));
}

const YOUTUBE_OPEN_PATTERNS = buildOpenPatterns(
  String.raw`youtube|you tube|music app`,
  String.raw`유튜브|뮤직\s*앱`,
);

const KIRA_OPEN_PATTERNS = buildOpenPatterns(
  String.raw`kira|project board|task board|kanban board|kanban|work board`,
  String.raw`키라|칸반(?:\s*보드)?|프로젝트\s*보드|작업\s*보드`,
);

const IDE_OPEN_PATTERNS = buildOpenPatterns(
  String.raw`aoi'?s ide|ide|code editor`,
  String.raw`아오이\s*ide|코드\s*에디터|에디터`,
);

const PE_ANALYST_NAMES_EN = String.raw`pe analyst|pe analyzer|pe analyser|pe analysis(?:\s+(?:app|tool))?`;
const PE_ANALYST_OPEN_PATTERNS = [
  ...buildOpenPatterns(PE_ANALYST_NAMES_EN, String.raw`pe\s*분석기`),
  // "I want to analyze a PE file": the app's whole purpose, so it opens it.
  // `pe` must be its own word -- "type" and "TypeScript" contain it.
  new RegExp(
    String.raw`^\s*${EN_LEAD_IN}(?:(?:i\s+)?(?:want|need|would like)\s+to\s+|let'?s\s+|wanna\s+)?(?:analy[sz]e|inspect|triage|reverse(?:\s+engineer)?)\s+(?:(?:a|an|this|the|my)\s+)?pe(?:\s+(?:file|binary|executable|sample))?${EN_TAIL}$`,
    'i',
  ),
  new RegExp(
    String.raw`^\s*pe(?:\s*(?:파일|바이너리))?(?:\s*(?:을|를|좀))?\s*(?:분석하고\s*싶어|분석하자|분석해\s*보자|분석할래|분석\s*좀\s*해\s*줘|분석해\s*줘)${KO_TAIL}$`,
    'i',
  ),
];

export function isDirectYouTubeOpenIntent(text: string): boolean {
  return matchesShortRequest(text, YOUTUBE_OPEN_PATTERNS);
}

export function isDirectKiraOpenIntent(text: string): boolean {
  return matchesShortRequest(text, KIRA_OPEN_PATTERNS);
}

export function isDirectIdeOpenIntent(text: string): boolean {
  return matchesShortRequest(text, IDE_OPEN_PATTERNS);
}

export function isDirectPeAnalystOpenIntent(text: string): boolean {
  return matchesShortRequest(text, PE_ANALYST_OPEN_PATTERNS);
}

// Words that end an English name capture: "My name is Alex and I ..." is Alex.
const NAME_STOP_WORDS = new Set([
  'and',
  'but',
  'so',
  'or',
  'from',
  'i',
  'im',
  "i'm",
  'nice',
  'to',
  'the',
  'a',
  'an',
  'by',
  'btw',
  'please',
  'thanks',
  'thank',
]);

function takeNameTokens(rest: string): string | null {
  const clause = rest.split(/[.,!?;:\n]/)[0] ?? '';
  const tokens: string[] = [];
  for (const raw of clause.trim().split(/\s+/)) {
    if (!/^[A-Za-z][A-Za-z'-]{0,29}$/.test(raw) || NAME_STOP_WORDS.has(raw.toLowerCase())) {
      break;
    }
    tokens.push(raw);
    if (tokens.length === 3) {
      break;
    }
  }
  return tokens.length > 0 ? tokens.join(' ') : null;
}

// Copulas that follow a Korean name ("철수입니다", "철수예요", "철수야").
const KO_COPULA = /(?:입니다|이에요|예요|이야|이고요|이고|이요|라고\s*해|이라고\s*해)$/u;

function stripKoreanCopula(name: string): string {
  const stripped = name.replace(KO_COPULA, '');
  if (stripped !== name && stripped.length > 0) {
    return stripped;
  }
  // A bare 야 is only a copula when something is left that still looks like a
  // name: "철수야" -> 철수, but "미야" stays 미야.
  if (name.endsWith('야') && name.length >= 3) {
    return name.slice(0, -1);
  }
  return name;
}

/**
 * The user's name, when the message states it outright ("my name is …",
 * "call me …", "내 이름은 …"). Returns the memory sentence to store, or null.
 *
 * Deliberately narrow: the result is saved as a high-importance identity fact,
 * and "I'm tired" or "나는 학생이야" are not names. Phrasings this misses still
 * reach the model, which can save a memory itself.
 */
/** The name itself, when the message states it outright; otherwise null. */
export function extractStatedUserName(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  const english = trimmed.match(/(?:^|[\s,.!?])(?:my name is|my name's|call me)\s+(.+)/i);
  if (english) {
    const name = takeNameTokens(english[1] ?? '');
    if (name) {
      return name;
    }
  }

  const korean =
    trimmed.match(/(?:내|제|나의|저의)\s*이름은\s*([A-Za-z가-힣]{1,20})/u) ??
    trimmed.match(
      /(?:나를|저를)\s*([A-Za-z가-힣]{1,20}?)(?:이)?라고\s*(?:불러|불러줘|불러\s*줘|불러주세요)/u,
    );
  if (korean?.[1]) {
    const name = stripKoreanCopula(korean[1]);
    if (name) {
      return name;
    }
  }

  return null;
}

export function extractNameMemory(text: string): string | null {
  const name = extractStatedUserName(text);
  return name ? `The user's name is ${name}.` : null;
}
