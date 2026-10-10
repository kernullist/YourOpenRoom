// Aoi browser-drive action classifier (P2.1): the safety core for Phase 2 (acting
// on the user's OWN logged-in browser). PURE + no execution -- it maps a proposed
// browser action into one of three categories:
//
//   read      -> observation only (navigate/extract/scroll/...). Runs without
//                per-action approval (still domain-allowlisted at navigation time).
//   act       -> a real side effect (click/type/select/submit). Requires explicit
//                per-action human approval before it may run (Phase 2 wiring).
//   forbidden -> HARD-BLOCKED, never runnable even with approval. Enforces the
//                permanent invariants: Aoi never enters passwords/payment/OTP/SSN,
//                never commits a financial transaction (pay/buy/transfer/trade),
//                and never interacts with a CAPTCHA. Login stays a human act.
//
// These hard-blocks are DETERMINISTIC (field metadata + accessible-name patterns)
// so they cannot be talked around by the model; the approval layer is the softer
// second gate for everything in 'act'.

export type AoiBrowserDriveActionKind =
  // read-only / observational
  | 'navigate'
  | 'extract'
  // Element-addressed snapshot: lists interactables with refs so an act can
  // target `element: N` instead of a model-authored selector.
  | 'elements'
  | 'scroll'
  | 'screenshot'
  | 'wait'
  | 'back'
  // Tabs. A link with target=_blank, an OAuth popup or a payment iframe opens a
  // page that is simply unreachable without these -- the drive would keep acting
  // on the original tab while the thing it was asked about sits in another one.
  | 'tabs'
  | 'tab'
  // side-effecting
  | 'click'
  | 'type'
  | 'select'
  | 'press'
  | 'submit'
  | 'hover'
  | 'drag'
  // Answer a native alert/confirm/prompt. This is an ACT, not a convenience:
  // accepting a confirm is how a page asks "really delete this?".
  | 'dialog'
  // Attach a local file to a file input.
  | 'upload'
  // Save a file the page offers. The click that triggers it is the act; this
  // says where the bytes are allowed to land.
  | 'download';

export interface AoiBrowserDriveActionField {
  // The target input's `type` attribute (password/email/text/tel/number/...).
  type?: string;
  name?: string;
  id?: string;
  autocomplete?: string;
  ariaLabel?: string;
  // What a site shows beside a field, where "카드번호" or "パスワード" usually is.
  placeholder?: string;
  title?: string;
  label?: string;
  // The words of the group the field sits in -- its fieldset's legend, its
  // group's name ("Payment details", "Buy a gift card") -- apart from its own
  // label. Every rule reads them with the field's own words, as a label that
  // carried them was read, but one: what else an expiry belongs to is looked
  // for in the field's own words only (see the card expiry below).
  group?: string;
  // Words the executor reads around the field -- e.g. "card" when its form,
  // fieldset, group or page holds a card field, "address" when its form,
  // fieldset or group holds an address field. Used ONLY for the card-expiry and
  // postal-PIN decisions, never as a field's own words.
  near?: string;
}

export interface AoiBrowserDriveActionRequest {
  kind: AoiBrowserDriveActionKind;
  selector?: string;
  // Element ref from an `elements` snapshot, used INSTEAD of authoring a
  // selector. Resolved to a concrete selector before anything else runs, so the
  // forbidden re-check, the approval fingerprint and the allowlist all see the
  // real target -- a ref is addressing, never a trust shortcut.
  element?: number;
  // The snapshot the ref came from. Required with `element`: it is a content
  // hash of the page, so a mismatch means the page changed and the ref is
  // refused rather than rebound onto whatever is there now.
  snapshotId?: string;
  url?: string;
  text?: string;
  value?: string;
  key?: string;
  // Metadata about the target element, used for deterministic hard-blocks.
  field?: AoiBrowserDriveActionField;
  // The accessible name / visible text of a click/submit target, used to block
  // financial-commit and captcha controls.
  targetText?: string;
  // drag: where to drop. Same addressing rules as `selector` / `element`.
  toSelector?: string;
  toElement?: number;
  // tab: which tab to make current, by index from a `tabs` listing.
  tabIndex?: number;
  // dialog: 'accept' or 'dismiss', plus the text for a prompt().
  disposition?: string;
  promptText?: string;
  // upload: absolute path of the file to attach. Refused unless it sits inside
  // an operator-registered read root -- see the executor.
  // download: the directory to save into, bounded the same way by WRITE roots.
  filePath?: string;
}

/**
 * Accept the snake_case key names the tool schema advertises.
 *
 * The schema says `snapshot_id`, `to_element`, `file_path`; the internal type is
 * camelCase. Translating in ONE place matters more than it looks: a key that is
 * silently dropped does not fail loudly, it produces an action missing the very
 * field that would have constrained it -- a drag with no destination, or worse,
 * an upload whose file_path never reaches the gate that was supposed to check
 * it. Both key styles are accepted so a model that guesses either is understood.
 */
export function normalizeAoiBrowserDriveActionKeys(raw: unknown): AoiBrowserDriveActionRequest {
  if (!raw || typeof raw !== 'object') {
    return { kind: 'wait' };
  }
  const source = raw as Record<string, unknown>;
  const pick = (camel: string, snake: string): unknown =>
    source[camel] !== undefined ? source[camel] : source[snake];

  const action = { ...source } as AoiBrowserDriveActionRequest & Record<string, unknown>;
  const pairs: [keyof AoiBrowserDriveActionRequest, string][] = [
    ['snapshotId', 'snapshot_id'],
    ['toSelector', 'to_selector'],
    ['toElement', 'to_element'],
    ['tabIndex', 'tab_index'],
    ['promptText', 'prompt_text'],
    ['filePath', 'file_path'],
    ['targetText', 'target_text'],
  ];
  for (const [camel, snake] of pairs) {
    const value = pick(camel as string, snake);
    if (value !== undefined) {
      (action as Record<string, unknown>)[camel as string] = value;
    }
  }
  return action;
}

export type AoiBrowserDriveActionCategory = 'read' | 'act' | 'forbidden';

export type AoiBrowserDriveActionForbidReason =
  | 'sensitive_field'
  | 'financial_commit'
  | 'captcha'
  | 'unknown_action';

export interface AoiBrowserDriveActionDecision {
  category: AoiBrowserDriveActionCategory;
  requiresApproval: boolean;
  reason: string;
  forbidReason?: AoiBrowserDriveActionForbidReason;
}

const READ_KINDS: ReadonlySet<AoiBrowserDriveActionKind> = new Set([
  'navigate',
  'extract',
  'elements',
  'scroll',
  'screenshot',
  'wait',
  'back',
  // Listing tabs observes; SELECTING one only changes which page the next step
  // addresses, and every act is separately gated anyway.
  'tabs',
  'tab',
]);

const ACT_KINDS: ReadonlySet<AoiBrowserDriveActionKind> = new Set([
  'click',
  'type',
  'select',
  'press',
  'submit',
  // Hover opens menus and fires the same handlers a click path does, so it is
  // not filed with the read-only steps just because nothing is pressed.
  'hover',
  'drag',
  'dialog',
  'upload',
  'download',
]);

// Autocomplete tokens that name a credential / payment / one-time secret.
const SENSITIVE_AUTOCOMPLETE = new Set([
  'current-password',
  'new-password',
  'one-time-code',
  'cc-number',
  'cc-csc',
  'cc-exp',
  'cc-exp-month',
  'cc-exp-year',
]);

// Field name/id/label patterns that indicate a secret to be typed. The English
// terms alone let a Korean or Japanese site's password and card fields through,
// so their usual labels are listed too (\b does not apply to them).
// "passengers", "footprint" and 암호화폐 (cryptocurrency) are not credentials,
// and refusing to type into them only made ordinary forms unusable. A one-time
// code goes by many names ("Verification code", "Authenticator code", "SMS
// code", "Backup code", "Login code", 認証コード, 인증코드, 確認コード, 动态码,
// 校验码) -- a booking's confirmation number (予約確認コード too) or a door's
// access code is no secret, and is not listed. A card's security code has
// several names too ("Card code", "Card verification value", CSC, CVN). An
// identity number is entered no more than a password is: a tax ID, 여권번호,
// 운전면허번호, 외국인등록번호, マイナンバー, 护照号 -- while a "Promo code", a
// "Cardholder name" or a "National park" is none of these. A passport, a
// driver's license, a national ID and 身份证 are judged below, where a name
// written as it is on one counts. "MM/YY" is a card's expiry by itself;
// "MM/YYYY" is any month of any year. The expiry words and the PIN are judged
// below, where what is beside them counts.
// A one-time code also arrives as an "MFA code", from an "Authenticator app",
// as "the code we emailed you", an "Email code", a "Text code", a "Login
// approval code", 动态口令, 短信验证 or 확인 코드 -- but 예약 확인 코드 is a
// booking's, and a "Phone code" or a "Country code" is a dialling prefix. A
// code named for what it is, however it arrived, is no one-time code either:
// a "Discount code we emailed you", a "Referral code sent to you by a friend",
// a "Booking confirmation code we emailed you" -- a bare "Confirmation code we
// texted you" still is one, and so is an "access code" sent to a phone, which
// is what some banks call their one-time code -- and
// a "Gift card code", which redeems a gift card and is no card's security
// code. An account or card number is often written short: "Account #", "Acct
// #", "Account no.", "CC number", "Card #", 银行账号 -- while an "Account
// name", an "Account type" or an "Order #" is none. "pass" finds no secret
// inside "passport".
// A one-time code is also "the code we've sent to your phone", "the code we
// have sent" or "the code that is sent", and it is what a message just
// brought when a field says where to find it ("Check your email for a code",
// "Check your phone for the code", "Enter the code in the email we sent you",
// "Enter the code from Google Authenticator") or that one was sent, emailed or
// texted ("We sent a code to your phone", "We've sent a 6-digit code to
// j***@gmail.com", "We emailed you a code", "We texted a confirmation code to
// your phone", "We sent a text with a code to (***) ***-1234", "Code sent via
// SMS" -- while "We emailed you a discount code" and "Promo code sent by text"
// name their codes), or that it was received ("Enter the code you received";
// "the promo code you received" is a promo code). A hardware token's code is
// one too ("Tokencode", "Token code"), and so is a code from an app ("Enter
// the code from your app"), a code under "2-Step Verification" or "Two-step
// authentication" (below), and a number of so many digits that was sent
// ("Enter the 6-digit number we sent to your phone" -- "the 6-digit number on
// your ticket" is a ticket's). A "Confirmation code" or a
// "Confirmation number" alone is a booking's reference, not a one-time code. A
// government number goes by many names too: a "Social Insurance Number" or a
// "SIN" (below), a "SSN" in a name ("applicant_ssn",
// "ssnNumber", and "employeeSsn" below), a "National Insurance number" or "NI
// number", a "PAN number", a "PAN card" (a bare "PAN" below), a "Tax
// File Number" or "TFN", 证件号码, 신분증 번호, 免許証番号 -- while a "Promo
// code", a "Postal code" or a "Confirmation number for your booking" is none.
// Aadhaar is an identity document, judged with the passport below.
const NAMED_CODE = String.raw`(?<!\b(?:promo(?:tion(?:al)?)?|discount|coupon|voucher|(?:e-?)?gift(?:[-_ ]?card)?|referral|invite|invitation|booking|reservation|tracking|order|ticket|rewards?|(?:booking|reservation|order)[-_ ]?confirmation)[-_ ]?)`;
const SENSITIVE_FIELD_PATTERN = new RegExp(
  String.raw`(pass(?!enger|port)(word|wd|code)?|\bpwd\b|credit|card ?number|card ?num|card[-_ ]?no(?![a-z])|card ?#|\bccnum|\bcc ?(#|num)|(?<!\b(?:e-?)?gift[-_ ]?)card ?code|card ?verification|\bcvv2?\b|\bcvc2?\b|\bcvn2?\b|\bcsc\b|security code|verification ?(code|number|pin)|verify ?code|authenticat(ion|or) ?code|authenticator ?app|\bauth ?code\b|\b(log|sign)[- ]?in ?code|\bapproval ?code|\bmfa\b|\b2fa\b|two[- ]?factor|\bsms ?(code|pin)s?\b|${NAMED_CODE}\b(e-?mail|text) ?code\b|(texted|text message|e-?mailed) code|${NAMED_CODE}\bcode ((that )?(we|we['’]ve|we have|was|has been|have been|is) (just )?(sent|texted|e-?mailed)|(sent|texted|e-?mailed) (to|via|by)\b)|\bcheck (your )?(e-?mail|phone|inbox|texts?|messages?) for (a|the|your) ((\d{1,2}|four|six|eight)[- ]digit )?code\b|\bwe(['’]ve| have)? (just )?(sent|e-?mailed|texted|messaged) (you )?(an? (text( message)?|sms|e-?mail|message) (with|containing) )?(a|an|the|your) ((\d{1,2}|four|six|eight)[- ]digit )?((verification|security|one[- ]time|login|sign[- ]in|access|confirmation) )?${NAMED_CODE}code\b|\btoken[-_ ]?codes?\b|\b(\d{1,2}|four|five|six|seven|eight)[- ]digit number (we(['’]ve| have)? (just )?(sent|texted|e-?mailed)|(that (was|is) )?(sent|texted|e-?mailed) (to|via)\b)|${NAMED_CODE}\bcode (from|in) (the |your |this |our )?(e-?mail|text( message)?|sms|message|app)\b|${NAMED_CODE}\bcode ((shown|displayed|generated) )?(from|in|on|by) (the |your |this )?([a-z]{1,15} )?authenticator\b|${NAMED_CODE}\bcode (that )?you(['’]ve| have)? (just )?received\b|\b(backup|recovery) ?codes?\b|\bmm ?\/ ?yy\b|(?<![a-z\d])ssn|social ?security|(social|national)[-_ ]?insurance[-_ ]?(number|num|no\b|#)|\bni[-_ ]?(number|num|no\b|#)|\bpan[-_ ]?(card[-_ ]?)?(number|num|no\b|#)|\bpan[-_ ]?card\b|tax[-_ ]?file[-_ ]?(number|num|no\b|#)|\btfn\b|\b(government|state|national|personal|resident(ial)?|citizen)[-_ ]?(id|identity|identification|registration)[-_ ]?(number|num|no\b|#|code)|\bidentity[-_ ]?(number|num|no\b|code)\b|\bnric\b|\bresident[-_ ]?registration\b|\bdl[-_ ]?(number|num|no\b|#)|\btax(payer)?[-_ ]?id|one[- ]?time|otp(?!rint)|routing|\biban\b|account ?number|\bacc(oun)?t\.? ?(#|no\b\.?|num)|비밀번호|패스워드|암호(?!화폐)|카드 ?번호|보안 ?코드|주민(등록)?번호|인증 ?(번호|코드)|(?<!예약 ?)확인 ?코드|계좌 ?번호|여권 ?번호|운전 ?면허(증)? ?번호|외국인 ?등록 ?번호|신분증 ?번호|パスワード|暗証番号|カード番号|セキュリティコード|口座番号|認証(コード|番号)|(?<!予約)確認コード|ワンタイム|マイナンバー|個人番号|運転免許(証)?番号|免許証番号|パスポート番号|旅券番号|密码|密碼|卡号|卡號|验证码|驗證碼|安全码|安全碼|动态码|動態碼|动态口令|動態口令|短信验证|短信驗證|校验码|校驗碼|银行账号|銀行帳號|银行卡号|銀行卡號|护照号|護照號|[证證]件[号號])`,
  'i',
);
// A SIN is a word of its own or a part of a name ("SIN", "Your SIN", "SIN
// number", "applicant_sin", "sinNumber") -- but not one with another word
// after it, unless that word is its number or says what the field is
// ("SIN - required", "Enter SIN here", "SIN (optional)", "SIN only"): Spanish
// "sin" is "without" ("Teléfono (sin espacios)", "Precio sin IVA"). It is
// looked for in each of a field's facts alone, so the next fact's words,
// joined after it, are not taken for a word after it ("SIN" over a "Personal
// information" legend).
const SIN_PATTERN =
  /(?<![a-z\d])sin(?:[-_ ]?(?:number|num|no|nr)\b|(?![a-z\d])(?:(?![\s_-]{1,9}[a-z])|[\s_:–—-]{1,9}(?:required|optional|here|field|only)\b))/i;
// A PAN is asked for by its name alone when that is all a fact says ("PAN",
// "PAN:"), or by a placeholder shaped like one (ABCDE1234F: five letters, four
// digits, a letter), or wherever its name is written in capitals ("Enter your
// PAN", "PAN Card", "Your PAN") -- read in the facts as written -- while
// "Pan size", "Frying pan" and "Grease the pan" are cooking.
const PAN_FACT_PATTERN = /^\s*(?:pan|[a-z]{5}\d{4}[a-z])\s*[:*#]?\s*$/i;
const PAN_CAPITALS_PATTERN = /\bPAN\b/;
// A name or an id written in camelCase or Hungarian ("employeeSsn", "txtSIN",
// "txtSsn") holds an SSN or a SIN where its capitals start a word -- read in
// the attribute as written, before it is lowercased ("isSingle", "BASIN"
// hold none).
const CAMEL_ID_NUMBER_PATTERN = /(?<![A-Z])(?:Ssn|SSN|Sin|SIN)(?![a-z]|[A-Z]{2})/;
// A code of so many digits is a one-time code ("Enter the 6-digit code").
// One-time codes run from four to eight digits, so a code of eight or fewer is
// one whatever the field's words name around it ("Enter the 6-digit code"
// under "Check your gift card balance" or "Manage your booking"). A longer one
// -- nine digits or more, as a gift card's or a voucher's is -- is no one-time
// code when the field's words name what it redeems: a gift card, a voucher, a
// coupon, a promo, a ticket or a booking ("Enter the 16-digit code on the back
// of your card" under a "Gift card" label).
const DIGIT_CODE_TAIL = String.raw`[- ]digit\s(?:(?:verification|security|one[- ]time|login|sign[- ]in|access|confirmation)\s)?${NAMED_CODE}code\b`;
const SHORT_DIGIT_CODE_PATTERN = new RegExp(
  String.raw`\b(?:0?[0-8]|four|five|six|seven|eight)${DIGIT_CODE_TAIL}`,
  'i',
);
const LONG_DIGIT_CODE_PATTERN = new RegExp(String.raw`\b(?:0?9|[1-9]\d)${DIGIT_CODE_TAIL}`, 'i');
const REDEEMED_CODE_PATTERN =
  /\b(?:(?:e-?)?gift(?:[-_ ]?cards?)?|vouchers?|coupons?|promo(?:tion(?:al)?)?s?|tickets?|bookings?)\b/i;
// Two-step verification asks for a one-time code where the field's own words
// name a code, digits or a number sent, wherever they say it comes from
// ("Enter the code from your phone", "Mobile code", "Enter the code shown on
// your phone", "Code" with the id phone-code), where they name the step or a
// number and no phone or method ("2-step verification code", "Two-step
// authentication", "Enter the number" under "2-Step Verification"), and where
// the field has no words of its own under a legend that names the step (a box
// of the split digits, "123456" as its placeholder) -- not a phone number or a
// way to receive the code set up under it ("Phone number", "Mobile number",
// autocomplete="tel", "2-step verification method", "… options"), nor a
// dialling prefix ("Country/area code").
const TWO_STEP_PATTERN =
  /\b(?:2|two)[- ]?step\s(?:verification|authentication|log[- ]?in|sign[- ]?in)\b/i;
const TWO_STEP_ASIDE_PATTERN =
  /\b(?:phone|mobile|cell(?:phone)?|telephone|tel|methods?|options?)\b/i;
const TWO_STEP_CODE_PATTERN = /\b(?:codes?|numbers?|digits?)\b/i;
const TWO_STEP_CODE_NAMED_PATTERN =
  /\b(?:codes?|digits?|numbers?\s(?:(?:we(?:['’]ve|\shave)?|that\s(?:was|is)|was)\s)?(?:just\s)?(?:sent|texted|e-?mailed))\b/i;
const DIALLING_CODE_PATTERN =
  /\b(?:country|area|dial(?:l)?ing|calling|region(?:al)?)(?:\s?\/\s?(?:country|area|region))?[-_ ]?codes?\b/gi;
// A word of a field's own, past the names a box of split digits is given.
// A field whose own words start by naming a phone number or an email address
// -- "Mobile number", "Enter 10-digit mobile number", "Mobile number – we'll
// text you a code", "Phone number to receive codes", "Email address to send
// codes to", or the bare word ("phone", "tel") -- asks for where the codes go,
// not for a code; so does a placeholder shaped like a phone number ("(555)
// 555-5555", "+1 555 555 5555": ten digits or more, or a leading +). Words
// that start with the code stay one ("Enter the code sent to your mobile
// number", "Mobile number verification code"), and so do words that show a
// number already known rather than ask for one ("Phone number ending in 34").
// Such a head is taken for where the codes go only when no other fact of the
// field's own asks for a code: one that starts by naming it or a code's own
// length of four to eight digits ("Code", "Enter code", "Enter the 6-digit
// code", "Enter the 6 digits") or a placeholder of four to eight digits
// ("123456") -- a box labelled "Mobile" with the placeholder "Enter code" is
// the code's, while "10 digits" and "Digits only" say how a phone number is
// written.
const PHONE_HEAD_PATTERN =
  /^\s*(?:(?:enter\s(?:your\s)?)?(?:\d{1,2}[- ]digit\s)?(?:(?:mobile|cell(?:ular)?)\s)?(?:phone|mobile|cell|telephone)\s?(?:number|no\.?|#)(?!\s{0,3}(?:verification|confirmation|security|one[- ]time|otp|sms|text)?\s{0,3}codes?\b|\s{1,3}(?:that\s{1,3})?(?:ending|ends)\b)|(?:enter\s(?:your\s)?)?e-?mail\saddress\b(?!\s{0,3}(?:verification|confirmation)?\s{0,3}codes?\b|\s{1,3}(?:that\s{1,3})?(?:ending|ends)\b)|(?:phone|mobile|tel|telephone|cell(?:phone)?|e-?mail)\s*$)/i;
const PHONE_SHAPED_PATTERN = /^\s*\+?[\d\s().-]+$/;
const CODE_HEAD_PATTERN =
  /^\s*(?:(?:enter|type|input)\s{1,3}(?:(?:the|your|a)\s{1,3})?)?(?:[\w-]{1,15}\s{1,3}){0,2}?(?:codes?\b|(?:[4-8]|four|five|six|seven|eight)[- ]digits?\b)/i;
const CODE_SHAPED_PATTERN = /^\s*\d{4,8}\s*$/;
const OWN_WORD_PATTERN = /\p{L}{3,}/u;
const BOX_NAME_PATTERN = /(?<![a-z])(?:input|field|box|char(?:acter)?|cell|entry|off)s?(?![a-z])/gi;

// A passport, a driver's license, a national ID or a 身份证 named in a field's
// words is what the field asks for -- its number, or the document itself
// ("Passport", "Driver's license number", "Enter the number on your passport",
// "Document number (as shown on your passport)") -- unless the field is a
// person's name as it is written on one: "Given name(s) as per passport",
// "Full name (as it appears on your driver's license)", "Name (as on
// passport)", 姓名（请填写身份证上的姓名）. Such a field names a name and says
// where it is written: on, in, per, from or matching the document, as shown,
// written or printed on it, or 上的, 上の, 一致 or 와 일치 after it. A field's
// label carries its fieldset's words too, so a passenger's "Passport number"
// box shares "Use the names exactly as written in their passports" with the
// name boxes beside it: a name is taken for one only when no number is named
// ("Document number", "No.", "#", 号) and the document is named nowhere else
// ("Passport", "Name and passport number") -- the document's name written
// into an attribute ("passportGivenName") names where the name is, not the
// document. Named as a country, a date or a status, the document is not asked
// for at all: "Passport issuing country", "Passport expiry date", "Driver's
// license state", 与身份证一致. Aadhaar (or "Aadhar") is one of these documents
// ("Aadhaar", "Aadhaar number", "Enter your Aadhar"; "Full name (as per
// Aadhaar)", "Name on Aadhaar" and "Date of birth (as per Aadhaar)" are
// written on it) -- but the phone it is linked with is no Aadhaar: "Mobile
// number linked with your Aadhaar", "Aadhaar linked mobile number".
const ID_DOCUMENT = String.raw`(?:passport(?![-_ ]?(?:issu|countr|expir|nationalit))|driv(?:er['’]?s?|ing)[-_ ]?licen[cs]e(?![-_ ]?(?:stat(?:e|us)|class|countr|type|expir|issu))|national[-_ ]?id|(?:身份证|身份證|身分證)(?!一致)|(?<!\b(?:with|to|via|using|through|from)\s(?:(?:your|the|my)\s)?)aadhaa?r(?![-_ ]?(?:linked|registered|seeded)\b))`;
const ON_ID_DOCUMENT = String.raw`(?:(?:your|the|their|a|an)\s)?${ID_DOCUMENT}`;
const WRITTEN_ON_ID_DOCUMENT = String.raw`\b(?:on|in|of|per|from|match(?:es|ing)?|as\s(?:shown|written|printed|it\sappears|they\sappear)(?:\s(?:on|in))?)\s${ON_ID_DOCUMENT}(?:\s?(?:\/|\bor\b)\s?${ON_ID_DOCUMENT}){0,2}|\(\s?${ON_ID_DOCUMENT}\s?\)|${ID_DOCUMENT}\s?(?:上的|上の|一致|와\s?일치)`;
const ID_DOCUMENT_PATTERN = new RegExp(ID_DOCUMENT, 'i');
const WRITTEN_ON_ID_DOCUMENT_PATTERN = new RegExp(WRITTEN_ON_ID_DOCUMENT, 'i');
const ID_DOCUMENT_AS_WRITTEN_PATTERN = new RegExp(
  String.raw`${WRITTEN_ON_ID_DOCUMENT}|${ID_DOCUMENT}[-_.:[\]]{0,3}(?:(?:first|last|given|middle|full|family|sur)[-_.:[\]]{0,3})?names?\b`,
  'gi',
);
// What is written on a document, apart from its number: a name, a nationality,
// a birth date, a sex, an issue or expiry, an address ("Address (as per
// Aadhaar)", a field named address_line1 with the placeholder "As per
// Aadhaar").
const NAME_CUE_PATTERN =
  /(\b(names?|given|surname|family|first|last|middle|full name|nationality|citizenship|country|birth|dob|sex|gender|issu(e|ed|ing)|place|expir(y|ation|es))\b|\baddress(es)?(?![a-z])|姓名|名字|이름|성명|氏名|名前|フリガナ|国籍|국적|生年月日|생년월일|出生|有效期|有効期限|유효 ?기간|发证|發證|発行|발급)/i;
const NUMBER_CUE_PATTERN =
  /(\b(numbers?|num|nr)\b|\bnos?\b(?!\s+[a-z]{3,})|#(?!\s?\d)|号|號|번호|番号)/i;

// An expiry is a card detail only beside a card ("Card expiry", an "Expiry
// date" whose id is card-expiry, 카드 유효기간, カード有効期限, 信用卡有效期): a
// coupon's expiry date, a link's expiration or ポイント有効期限 (when points
// lapse) is nothing to keep from anyone. autocomplete="cc-exp" says card by
// itself, above. A card form often labels its expiry "Expiration date" and
// nothing more, so a card among the field's surroundings (`near`) counts as
// the card cue too -- unless the field's own words name another thing that
// expires. A one-page travel checkout puts the traveller's "Passport expiry
// date" on the page with the card number, and a "Document expiry date", a
// "Driver's license expiration", a "Membership expiry", a "Coupon expiry
// date" or an "Insurance policy expiration" is no card's either, wherever it
// sits. A card in the field's words still counts ("Card expiry"), and so does
// a payment beside a card -- paying, billing, a checkout, buying, a purchase,
// a fee, an amount or a price, in the field's own words or its group's: the
// expiry under "Insurance premium payment" or "Visa application fee" is the
// card's. The other thing that expires is looked for in the field's OWN words
// only, not its group's (`group`): a legend over a card's number, expiry and
// CVC -- "Buy a gift card", "Annual parking permit - $120.00", "Domain
// registration", "Software license", "Student fees", "Insurance policy" --
// names what the card buys, not what the expiry is.
const CARD_EXPIRY_PATTERN =
  /(\bexpir(y|ation)\b|\bexp\.? ?(date|month|year)\b|유효 ?기간|有効期限|有效期)/i;
const CARD_CUE_PATTERN =
  /((?<!\b(?:id|identity|residence|membership|member|loyalty|gift|library|health|insurance|student|green)[-_ ]?)card|\bcc(\b|_)|credit|debit|카드|カード|卡)/i;
const NEAR_CARD_PATTERN = /card/i;
const OTHER_EXPIRY_PATTERN =
  /(passport|document|licen[cs]e|(?<![-_])\bid\b(?![-_])|identity|\bvisa\b|permit|residence|membership|coupon|voucher|insurance|warranty|policy|certificate|domain|\bgift\b|loyalty|library|student|여권|신분증|면허|비자|쿠폰|パスポート|免許|ビザ|クーポン|在留|[护護]照|身[份分][证證]|[驾駕]照|[签簽][证證]|[优優]惠券)/i;
// Whether words name a thing other than a payment card that expires -- a
// passport's number, a licence's -- read by the live-DOM check of the fields
// beside an expiry: a group of such a thing's fields is no card's.
export function namesAnotherExpiringThing(words: string): boolean {
  return OTHER_EXPIRY_PATTERN.test(words);
}

const PAYMENT_CUE_PATTERN =
  /(\bpay(ing|ments?)?\b|\bbilling\b|\bcheckout\b|\b(buy|purchase|fees?|amount|price)\b|결제|支払|決済|支付|付款)/i;

// A PIN is a secret -- but India's postal "PIN code" (Postal Index Number) is
// an address. Beside a postal cue ("Pincode", "ZIP / PIN code", or
// autocomplete="postal-code", which is part of what is read) the bare word PIN
// is no cue; a PIN by any other name ("SMS PIN", "Verification PIN") still is.
// A field that says only "PIN code" is the postal one too when it sits among
// an address (`near`) -- unless its own words name what a secret PIN unlocks
// ("ATM PIN", "Card PIN code", a SIM, a bank account).
const PIN_PATTERN = /\bpin\b/i;
const POSTAL_PATTERN = /(postal|post[- ]?code|\bzip\b|pincode)/i;
const PIN_CODE_PATTERN = /\bpin[-_ ]?code\b/i;
const NEAR_ADDRESS_PATTERN = /\baddress\b/i;
const SECRET_PIN_CUE_PATTERN = /(card|\batm\b|\bsim\b|debit|credit|bank|account|security)/i;

// An amount of money as a page prints it, its currency on either side ("$3.99",
// "US$25", "€12", "₺49", "USD 49", "INR 499.00", "CAD 500.00", "500 kr",
// "49 zł", "49,000원", "4,900円") -- a bare number is as likely a count. A
// currency's code is a word of its own ("Arcade 49" holds no CAD, "Kr. Smith"
// no krona), and no amount before a number that runs into letters, or a year
// that names a thing ("Send CAD 3D model", "Export CAD 2024 drawing", "CNY
// 2025 sale" -- "CAD 2024.00", "Total: CAD 2024.", "Total: EUR 1999 incl.
// VAT" and "Send USD 2000 to Jane" are amounts); "Rs", "RM", "Rp" and "R" are
// money only before a number that ends there ("Rs. 499", "RM 49.00", "R
// 499.00", "Tip RM2", "Total: Rp5"; "Users 5", "prices in Rs" and "R2-D2"
// name none), and a bare "R" only before one of two digits or more or with a
// decimal part ("R 49", "R5.00" -- "Send logs to R2" names none). The digits are
// bounded: a page writes its own dialog messages, and an endless run of digits
// must not cost more than reading it once. A point or a comma is the amount's
// only between its digits: "$49.00." ends its sentence there. Signs written
// full width count too ("＄49.00", "￥49.00"), and so do digits written full
// width, which are read as the digits they are (withHalfWidthDigits, below).
const CURRENCY = String.raw`(?:[a-z]{0,2}[$€£¥₩₹￥￦＄￡₺₪₱₽฿₫]|\b(?:usd|eur|gbp|jpy|krw|cny|rmb|twd|hkd|inr|cad|aud|nzd|chf|sgd|mxn|brl|zar|sek|nok|dkk|pln|aed|kr)\b(?!\s?(?:(?:19|20)\d\d\s?(?!(?:to|for|from|in|on|at|per|each|a|an|the|now|today|only|and|or|incl|including|excl|excluding|plus|vat|gst|tax)\b)[a-z]|\d{1,4}[a-z]))|\bzł(?![a-z])|\b(?:rs|kr|rp)\.(?=\s?\d)|\b(?:rs|rm|rp)(?=\s?\d(?:[\d,]|\.\d){0,15}(?![\w-]))|\br(?=\s?\d(?:\d|[.,]\d)(?:[\d,]|\.\d){0,14}(?![\w-])))`;
const MONEY = String.raw`(?:${CURRENCY}\s?\d|\d(?:[\d,]|\.(?=\d)){0,15}\s?(?:${CURRENCY}|[원円元]))`;
// Digits written full width ("４，９００円", "＄４９．００"), read as the digits
// they are, with the comma or the point between two of them -- for a button's
// words and a confirm's alike. Nothing else is changed: a full-width comma
// between words still ends a clause.
const FULL_WIDTH_DIGIT_PATTERN = /[０-９]/g;
const FULL_WIDTH_SEPARATOR_PATTERN = /(?<=\d)[，．](?=\d)/g;
function withHalfWidthDigits(text: string): string {
  return text
    .replace(FULL_WIDTH_DIGIT_PATTERN, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xfee0))
    .replace(FULL_WIDTH_SEPARATOR_PATTERN, (mark) => (mark === '，' ? ',' : '.'));
}
// The rest of an amount's digits after the first one MONEY reads.
const AMOUNT_TAIL = String.raw`(?:[\d,]|\.(?=\d)){0,16}`;
// Money that comes back to the user: a refund, a credit, cashback or a rebate
// -- but a credit card, a credit line, a credit union, a credit limit, score,
// check, report, rating or history gives nothing back ("Using your Visa credit
// card ending 4242, $49.00 will be paid to Acme Inc.").
const MONEY_BACK = String.raw`(?:refund(?:s|ed)?|credit(?:s|ed)?(?![-\s]?(?:cards?|lines?|unions?|limits?|scores?|checks?|reports?|ratings?|history)\b)|cashbacks?|rebates?)`;
// A rate said after an amount: "/month", "/wk", "a month", "per year",
// "monthly", "weekly", "quarterly".
const RATE = String.raw`(?:\s?\/\s?(?:mo|month|wk|week|yr|year|qtr|quarter)\b|\s(?:a|each|every|per)\s(?:month|week|year|quarter)\b|\severy\s(?:[1-9]\d?|two|three|four|six)\s(?:weeks|months|years)\b|\s(?:monthly|weekly|yearly|annually|quarterly|bi-?weekly)\b)`;
const RATE_AFTER = String.raw`${AMOUNT_TAIL}${RATE}`;

// Accessible-name / selector patterns for controls that COMMIT a financial action.
// Clicking these is hard-blocked (the prohibited transfer/trade/purchase class),
// not merely approval-gated. Korean, Japanese and Chinese commit labels are
// listed for the same reason; a free "구독" (subscribe) button is deliberately
// not one of them.
// A page that only LISTS past payments or reviews of purchases is not a commit:
// 결제 내역, 구매 후기, 購入履歴, "Purchase history", "Your purchases" and 支付宝
// (a brand) are links, not buttons that pay. An order is committed in many
// words -- "Place your order", "This places your order", "Place a new order",
// "Complete order", "Finish your order", "Order now" -- and "Order history" or
// "Track your order" commits nothing. A
// tip or a bid moves money
// too ("Send tip", "Place bid"), and a rental buys ("Rent now") -- named by the
// whole phrase, since "Pro tip" or "bid farewell" commit nothing.
// Money also moves when a wallet is topped up or cashed out, a bet or a swap is
// placed -- a bet or a wager made with its amount too ("Bet $10.00 on Team
// A?", "Wager $25.00", "Place a $10 bet") -- a project is backed or a gift is
// given ("Top up", "Add funds", "Cash
// out", "Place bet", "Confirm swap", "Pledge $10", "Give now", "Send $25.00",
// 기부하기, 投げ銭, 提现, 打赏, 下注), a top-up, a donation or a sponsorship is
// asked for (충전하시겠습니까, 기부할까요, 후원하실래요, チャージしますか,
// 寄付しましょうか -- 배터리를 충전하시겠습니까 charges a device), an amount is
// sent, topped up or charged where the words after it say so (10,000원을
// 보내시겠습니까, 10,000원을 보낼까요, 10,000원 충전, 1,000円チャージ, 1,000円を
// 送りますか -- 10,000원 충전되었습니다 and 1,000円チャージしました tell of one
// made), a card is charged where a control's words start ("Charge $49.00"),
// an amount is added, loaded or reloaded to a
// wallet, a balance, a card or an account ("Add $10 to your wallet?", "Reload
// $25 to your Starbucks Card?", "Add $50 to your PayPal account?", "Add $50.00
// to your account number ending 1234?" -- "Add $10 to your cart" and "Add $500
// to your credit card limit?" add none), an amount
// is moved to or into another account, the amount right after "move" or after
// "move money/funds (of)" ("Move $49.00 to Savings?", "Move $49.00 from
// Checking to Savings?" -- "Move 3 items to your cart?" and "Move the $49.00
// item to your wishlist?" move none), a prepaid plan is recharged with its
// amount or now ("Recharge ₹199", "Recharge now", "Proceed to recharge" --
// "Recharge your batteries" pays nothing), an order is asked for with its
// amount ("Order for $49.00", "Order 2 items for $49.00", "Pre-order for
// $49.00", "Click to order for $49.00", "Order 500 for $29.99 - Free
// shipping", and a named order repeated, placed, confirmed, submitted,
// completed, finalised, reordered or scheduled: "Repeat last order for
// $23.50", "Place gift order for $49.00", "Schedule next order for $49.00" --
// not "Your order for $49.00", "Track order for $49.00", "Gift order for
// $49.00 shipped to Jane" or "…your next order for $0", which name one, nor
// "Order 123 for $49.00 - Delivered", an order's number in a list with its
// status after it, or "Order for $49.00 or more" and "Place your next order
// for $49.00 or more", a threshold)
// or asked for or completed in Korean or Japanese (주문하시겠습니까, 주문할까요,
// 주문을 진행할까요, 주문이 완료되고, 주문을 완료하시겠습니까, 注文しますか,
// ご注文を送信しますか -- 주문하신, 주문이 완료되었습니다, ご注文を完了しました,
// 已下单 and 下单成功 tell of one made, and so does a completed order told as
// a state: 완료된 or 완료한 before 상품, 주문 내역, 내역, 고객, 분 or 회원 (주문이
// 완료된 상품입니다), or 완료되어 or 완료돼 before what is being done (주문이
// 완료되어 배송을 준비하고 있습니다, …준비 중입니다) -- while 주문이 완료되어
// 취소할 수 없습니다, 주문이 완료된 후, 주문이 완료된 것으로 처리됩니다 and
// 주문이 완료돼요 tell what accepting does), and a checkout goes by other words
// ("Check out", "Continue to payment") -- though "Check out our deals" only
// points somewhere, and "Add credit card" adds no money. A rental is named
// with its format or price ("Rent HD", "Rent Dune (HD)", "Rent for $3.99");
// "Rent apartments" and "Rent apartments in SD" rent nothing. A link that
// only lists or explains is no commit either:
// "Transfer history", "Withdrawal limits", "How to buy", "How to pay $25
// online", "How much to pay $50", "How to donate $25" (after how, where, when
// or why to), a payment told as no longer made ("You will no longer pay
// $9.99/month", never, won't -- while "Do not pay anyone who calls you" warns
// of one), "Buy it again", "Checkout help", 결제수단 관리, お支払い方法,
// 支付方式, 提现记录, 入札履歴 -- and 決済方法, 送金履歴, 振込先, 购买记录,
// 이체내역조회, 출금 한도, 입금 확인, nor is a payment's date or one already made:
// 결제일, 決済日, お支払い済み -- nor the label of its amount, as 결제 금액 is
// none: お支払い金額, 支付金额, 付款金额 (a total, read in a confirm below).
// A payment is also made, or proceeded or continued with ("Make a payment",
// "Make this payment", "Proceed with payment", "Continue with your $49.00
// payment") -- not a
// payment reminder, request, link, plan, method, option, history, schedule,
// arrangement, extension or agreement, nor one made recurring or automatic
// ("Make this payment recurring", "Make a payment arrangement") -- and an
// order is placed with its amount said in it ("This places your $49.00
// order", "Place an order"). A payment is approved, scheduled, released,
// retried or initiated ("Approve payment", "Schedule payment" -- "Schedule a
// payment reminder" schedules a reminder, "Approve payment method" a way to
// pay and "Schedule payments overview" opens a page), a donation or a pledge
// is completed, confirmed, submitted, made or sent ("Complete donation", "Make
// a donation", "Complete your pledge"), a tip or a gift is confirmed,
// completed or made with its amount or without ("Confirm tip", "Make a gift")
// and submitted or sent only with it ("Submit $5 tip", "Send a $5 gift" --
// "Submit a tip", "Send us a tip" and "Submit tips and tricks" send words, and
// a gift message, note, receipt, wrap or registry is none), a tip, a gift or a
// donation is given of an amount ("Give a gift of $25"), and an order or a
// purchase completed, confirmed, submitted or finished ("Confirm $49.00
// order"; "Finish order later" leaves it). Each of these may say its amount
// and what kind it is between the verb and the noun, in either order: "Submit
// $49.00 payment", "Make a $49.00 payment", "Make a one-time payment", "Make
// an online payment", "Make an extra $50 payment", "Make a $25 donation",
// "Complete your $25 donation" (one-time, monthly, minimum, extra, full,
// final, partial, early, recurring, online or secure for a payment; monthly,
// one-time or recurring for a donation). An offer is submitted
// ("Submit offer" -- one submitted "for approval" is not made yet), and
// "Convert now" and "Invest now" do what they say. Money given, tipped, bid,
// contributed, invested, authorized or chipped in with its amount moves ("Give
// $25", "Tip $5", "Authorize $49.00", "Bid US $12.50" -- a currency word may
// stand before the amount -- "Tip: $5", "Tip Jane $5", "Tip the driver $5",
// "Tip your rider RM3",
// "Chip in $5", and a tip or a donation added, left or given with its amount:
// "Add a $5 tip", "Leave a $5 tip", "Support with a $5 tip"; "Tip: save 20%"
// names no amount), and so does money sent with an amount at most three words
// on ("Send Jane Doe
// $49.00", "Sending $49.00 to Jane Doe"); "Give feedback", "Convert to PDF",
// "Invest in yourself" and "Send a reminder to Jane about the $49.00 invoice"
// move none. A control says so where its words start, or after a mark that
// starts a new part of them (".", "!", "?", ":", ";", "|", "•", "·", an em or
// an en dash -- not a hyphen -- or a line break, then spaces or symbols --
// counted as characters, so an emoji with its skin tone is one: "Support us:
// Give $25", "👍🏽 Tip $5") -- or anywhere in a control of five words or
// fewer, a button's whole label ("Add tip $5", "Leave tip $5", "Quick bid US
// $12.50", "Support us - Give $25"), unless those few words ask how, where,
// when, why or what to do it, or whether one should ("How to invest $1,000",
// "How much to tip $50?", "Why you should tip $5": headlines, as "How to buy"
// is a link). Said further on in longer words, they are a headline or a
// message ("3 smart ways to invest $500 this year", "Holiday deals - give $25
// gift cards", "Can you send me $20 for the cab?", "How to add a $5 tip on
// DoorDash and why it matters") -- a confirm() reads them anywhere, below.
// Money sent "me" or "us" is asked for (though "US$25" and "US $25" are
// amounts), an amount "off" is a discount ("Send a $5 off coupon"), a refund
// sent is sent back ("We're sending your $49.00 refund"), and money given or
// sent "to a friend" is a referral ("Give $5 to a friend", like "Give $10,
// get $10") -- but "to friends and family" is a transfer. "Sell" sells, but
// "Do Not Sell or Share My Personal Information" (the link a US site must
// show) and "We never sell your data" sell nothing.
// "Check out" two words is a commit only where it plainly is one: alone at the
// end ("Check out", or "Check out Check out" as a joined read gives it), or
// followed by "now", "securely", "with", "as guest", "(2 items)", an arrow
// ("Check out »", "Check out ▸", "Check out ➜") or an amount, even behind a
// dash, a dot, a bar or a colon ("Check out - $49.00", "Check out · $49.00",
// "Check out: $49.00"). Otherwise it is a link ("Check out reviews", "Check
// out branch", "Check out: 2 items") or a hotel's day ("Check out Tue, Oct
// 14", "Check out / Add dates"), and a check-out date, time or day is never one
// in any spacing. 加值 is a top-up, but 加值服务 (value-added service) and 加值税
// (VAT) are not.
// An amount that moves no money: a discount ("$5 off"), a referral ("$5 to a
// friend", "$10, get $10"), a refund ("your $49.00 refund").
const NOT_A_DISCOUNT = String.raw`(?!${AMOUNT_TAIL}\s?off\b)`;
const NOT_A_REFERRAL = String.raw`(?!${AMOUNT_TAIL}\sto\s(?:a\s)?friends?\b(?!['’]|\s(?:and|&)\s(?:family|families)\b))`;
const NOT_GIVEN_TO_GET = String.raw`(?!${AMOUNT_TAIL},?\s(?:and\s)?get\b)`;
const NOT_A_REFUND = String.raw`(?!${AMOUNT_TAIL}\s${MONEY_BACK}\b)`;
const MONEY_SENT = String.raw`send(?:ing)?\s(?!(?:an?\s|the\s|your\s)?(?:invoices?|reminders?|requests?|bills?|quotes?|estimates?|receipts?|statements?)\b|me\b|us\b(?!\s?\$))(?:[^\s]{1,30}\s){0,3}${MONEY}${NOT_A_DISCOUNT}${NOT_A_REFERRAL}${NOT_A_REFUND}`;
const MONEY_GIVEN = String.raw`(?:give\s(?:[a-z]{1,3}\s)?${MONEY}${NOT_A_REFERRAL}|(?:bid|contribute|invest|authori[sz]e)\s(?:[a-z]{1,3}\s)?${MONEY}|tip:?\s{1,3}(?:(?:the|your|our)\s)?(?:[a-z'’-]{1,20}\s)?${MONEY}|chip\s?in\s(?:[a-z]{1,3}\s)?${MONEY}|(?:add|leave|with)\s(?:an?\s)?${MONEY}${AMOUNT_TAIL}\s(?:tip|donation)s?\b)${NOT_GIVEN_TO_GET}${NOT_A_DISCOUNT}`;
// Where a control's words say what it does: at their start, or after a mark
// that starts a new part of them, and the spaces or symbols after it (read by
// code point) -- or, in a control of five words or fewer, anywhere.
const AT_PIECE_START = String.raw`(?:^|[.!?:;|•·—–\r\n])[^\p{L}\p{N}]{0,8}`;
// Words that ask how, where, when, why or what to do something, or whether
// one should, or say why someone does it or the ways to, and the verb they
// ask about: a short piece that says them is a headline ("How to invest
// $1,000", "How much to tip $50?", "Why you should tip $5", "What to give
// $50", "Should you give $50?", "Why I give $100 monthly", "Best ways to
// invest $5,000"), so they are taken out before its verb and amount are read
// -- as "how to buy", "how to pay" and "how to donate" buy nothing.
const ASKED_HOW_PATTERN =
  /\b(?:(?:how|where|when|why|what)(?:\s(?:much|many|best|not|else))?\sto|ways?\sto|should\s(?:you|i|we)|(?:you|i|we)\sshould|why\s(?:i|we|you|people)(?:\s(?:should|must|still|always|would|do|don['’]t))?)\s{1,3}[a-z'’-]{1,20}/gi;
const MONEY_MOVED_ON_CONTROL_PATTERN = new RegExp(
  String.raw`${AT_PIECE_START}(?:${MONEY_SENT}|${MONEY_GIVEN})`,
  'iu',
);
const MONEY_MOVED_PATTERN = new RegExp(String.raw`\b(?:${MONEY_SENT}|${MONEY_GIVEN})`, 'i');
// A tip or a donation given with its amount where a control's words end is
// what the control does, however many words come before it ("Say thanks with
// a $5 tip").
const GIVEN_AT_END_PATTERN = new RegExp(
  String.raw`\bwith\s(?:an?\s)?${MONEY}${AMOUNT_TAIL}\s(?:tip|donation)s?\s{0,3}[.!]?\s{0,3}$`,
  'i',
);
const SHORT_PIECE_WORDS = 5;
const WORD_TOKEN_PATTERN = /[\p{L}\p{N}]/u;
function isShortPiece(text: string): boolean {
  let words = 0;
  for (const token of text.split(/\s+/)) {
    if (WORD_TOKEN_PATTERN.test(token)) {
      words += 1;
      if (words > SHORT_PIECE_WORDS) {
        return false;
      }
    }
  }
  return true;
}
// What a commit phrase may say between its verb and its noun: the amount, a
// rate after it or not ("Make a $49.00 payment", "Confirm your $9.99/month
// payment"), and the kind of payment or donation it is.
const COMMIT_AMOUNT = String.raw`(?:${MONEY}${AMOUNT_TAIL}${RATE}?\s)?`;
const PAYMENT_KIND = String.raw`(?:(?:one[- ]time|monthly|minimum|extra|full|final|partial|early|recurring|online|secure)\s)?`;
const DONATION_KIND = String.raw`(?:(?:monthly|one[- ]time|recurring)\s)?`;
// Asked how, where, when or why to, so a headline ("How to pay $25 online",
// "How much to pay $50", "Why to donate").
const NOT_ASKED_TO = String.raw`(?<!\b(?:how|where|when|why)(?:\s(?:much|many|best|not|else))?\sto\s)`;
const FINANCIAL_COMMIT_PATTERN = new RegExp(
  String.raw`(${NOT_ASKED_TO}(?<!\b(never|no\s(longer|more)|will\snot|won['’]t|wouldn['’]t)\s)pay\b(?!\s+nothing\b)|pay now|proceed to payment|continue to (payment|checkout|pay)\b|send (a |the )?tip|leave a tip|place (a |your |my )?bid|(confirm|submit) (your |my |the )?bid|bid now|rent now|\brent (hd|uhd|4k|sd)\b|\brent\s([^\s.?!()]{1,30}\s){1,3}\((hd|uhd|4k|sd)\)|\b(rent( for| from)?|pledge) ${MONEY}|pledge now|back this project|\bgive now\b|\b(convert|invest) now\b|(make|confirm|complete|submit|send|process|authori[sz]e|finali[sz]e|(proceed|continue) with) (the |your |my |an? |this )?${PAYMENT_KIND}${COMMIT_AMOUNT}${PAYMENT_KIND}payment(?!\s+(reminders?|requests?|links?|plans?|methods?|options?|history|schedules?|recurring|automatic(ally)?|arrangements?|extensions?|agreements?)\b)|\bplac(e|es|ing)\s([a-z'’]{1,10}\s){0,2}${MONEY}${AMOUNT_TAIL}\s(order|purchase)\b|(approve|schedule|release|retry|initiate) (the |your |this |an? )?${PAYMENT_KIND}${COMMIT_AMOUNT}${PAYMENT_KIND}payments?\b(?!\s+(overview|history|list|settings|summary|details|schedule|reminders?|methods?)\b)|(complete|confirm|submit|make|send) (the |your |an? |this |my )?${COMMIT_AMOUNT}${DONATION_KIND}(donations?|pledges?)\b|(complete|confirm|submit|make|send) (the |your |an? |this |my )?${MONEY}${AMOUNT_TAIL}${RATE}?\s${DONATION_KIND}(tips?|gifts?(?!\s+(messages?|notes?|receipts?|wrap(ping)?|registr(y|ies)|ideas?|guides?|options?|lists?)\b))\b|(complete|confirm|submit|make|send|give) (the |your |an? |this |my )?${DONATION_KIND}(tips?|gifts?|donations?)\s(of|for)\s${MONEY}|(complete|confirm|make) (the |your |an? |this |my )?${DONATION_KIND}(tips?|gifts?)\b(?!\s+(messages?|notes?|receipts?|wrap(ping)?|registr(y|ies)|ideas?|guides?|options?|lists?)\b)|\bsubmit (your |an |the |my )?offer\b(?!\s+(letters?|for\s+approval)\b)|places? (the |your |my |this |an? )?(new )?order|(complete|confirm|submit|finali[sz]e|finish) (the |your |my |this )?${COMMIT_AMOUNT}(order|purchase)(?!\s+later\b)|\breorder\s(for\s)?${MONEY}|(?<!\b(your|the|this|my|an?|our|their|his|her|new|next|last|previous|past|recent|gift|track|tracking|view|cancel|return)\s)\border\s(?!\d{3,12}\sfor\s${MONEY}${AMOUNT_TAIL}\s{1,3}[-–—·•|]\s{0,3}(delivered|shipped|cancell?ed|returned|refunded|completed|processing|pending|in\stransit|out\sfor\sdelivery|paid)\b)((it|this|now|\d{1,12})\s([a-z]{1,15}\s)?)?for\s${MONEY}(?!${AMOUNT_TAIL}\s(or\s(more|above|over)|and\s(up|above|over))\b)|\b(repeat|place|confirm|submit|complete|finali[sz]e|reorder|schedule)\s((your|the|this|my|a)\s)?(next|last|previous|past|recent|gift)\sorders?\s(again\s)?for\s${MONEY}(?!${AMOUNT_TAIL}\s(or\s(more|above|over)|and\s(up|above|over))\b)|\brecharge\s(now\b|((for|of)\s)?${MONEY})|\bproceed\sto\srecharge\b|order now|checkout(?!\s*(help|faqs?|guide|support|issues|problems|dates?|times?|days?)\b)|\bcheck\s{1,3}out(?=\s*([.?!]\s*)?$|\s{1,3}(now|securely|with|as\s(a\s)?guest)\b|\s{0,3}[(»›→>▸▶►➔➜]|[\s\-–—·•|:,]{0,4}(?:for\s{1,3})?${MONEY})|buy now|${NOT_ASKED_TO}\bbuy\b(?!\s+(it\s+)?again\b)|purchase(?![sd]\b|\s+(history|details?|records?|summary|receipts?)\b)|subscribe and pay|${NOT_ASKED_TO}\bdonate\b|\btop[- ]?up\b(?!\s*(history|records?)\b)|\badd (funds|money)\b|\b(add|load|reload)\s([a-z]{1,4}\s)?${MONEY}${AMOUNT_TAIL}\s(to|onto|into)\s((your|the|my|this|a)\s)?([\w'’-]{1,20}\s){0,2}?(wallet|balance|card|account)s?\b(?!\s(limits?|goals?|budgets?)\b)|\bmove\s((money|funds)\s(of\s)?)?${MONEY}${AMOUNT_TAIL}\s(from\s([\w'’-]{1,20}\s){1,3}?)?(to|into|onto)\b|\bcash[- ]?out\b(?!\s*(history|records?)\b)|place (a |your |my )?bets?\b|\bbet now\b|\b(bet|wager)\s([a-z]{1,3}\s)?${MONEY}|^\s{0,3}charge\s([a-z]{1,3}\s)?${MONEY}|\bplac(e|es|ing)\s((a|an|your|the|my|this)\s)?${MONEY}${AMOUNT_TAIL}\s(bets?|wagers?|stakes?)\b|confirm (the )?swap\b|transfer(?!s?\s*(history|details?|records?|status|limits?|activity)\b)|send money|wire\b|withdraw(?!als?\s*(history|details?|records?|status|limits?|methods?|activity)\b)|deposit(?!s?\s*(history|details?|records?|status|limits?|methods?|activity)\b)|\btrade\b|place trade|(?<!\b(not|never)\s)(?<!n['’]t\s)sell\b|결제(?! ?(내역|수단|방법|정보|안내|설정|관리|이력|기록|예정일|금액)|일)|구매(?! ?(후기|내역))|주문하기|주문[이을]?\s?완료(?!되었|됐|했|(된|한)\s?(상품|주문\s?내역|내역|고객|분|회원)|(되어|돼)\s?[^.?!。？！\r\n]{0,20}?(고\s?있습니다|고\s?있어요|중입니다|중이에요))|주문을?\s?(진행\s?)?(하시겠|할까|하겠)|(송금|이체|출금)(?! ?(내역|한도|조회))|입금(?! ?(내역|확인|조회))|매수|매도|지불|충전하기|선물하기|기부하기|후원하기|입찰하기|베팅하기|(?<!(배터리|전지|휴대폰|핸드폰|기기)[을를]?\s?)충전(하시겠|할까|하실래)|(후원|기부)(하시겠|할까|하실래)|(?=보내|보낼|충전|チャージ|送り)(?<=${MONEY}${AMOUNT_TAIL}\s?[을를이가をが]?\s?)(보내(시겠|실래|실까|겠)|보낼까|충전(?!\s?(되었|됐|완료|내역))|チャージ(?!しました|済|完了|履歴)|送り(ますか|ましょうか))|(チャージ|寄付)(しますか|しましょうか)|환전하기|購入(?!履歴)|買う|売る|売却(?!履歴|益|損)|買い付け|注文する|注文を確定|注文確定|注文しますか|ご?注文を(送信|完了)(?!しました|いたしました|済)|注文して(も)?よろしい|レジに進む|決済(?!方法|履歴|情報|設定|明細|手段|日)|支払(?!い?(済|方法|履歴|情報|設定|状況|期限|明細|金額))|送金(?!履歴|明細|先)|振込(?!履歴|明細|先|口座)|出金(?!履歴|明細)|入金(?!履歴|明細|確認)|チャージする|入札(?!履歴|一覧)|ベットする|寄付する|投げ銭|购买(?!记录|記錄|历史|歷史|须知|須知|指南)|購買(?!紀錄|記錄|歷史|須知)|支付(?!宝|方式|记录|記錄|设置|設定|方法|金[额額])|付款(?!方式|记录|記錄|方法|金[额額])|(?<!已)下单(?!了|成功)|提交订单(?!了|成功)|确认订单|確認訂單|立即(抢购|搶購|订购|訂購|下單)|去结算|结算|結算|结账|结帐|結帳|转账(?!记录|明细|記錄)|轉帳(?!紀錄|明細|記錄)|(提现|提款|充值)(?!记录|明细)|(儲值|(?<!附)加值(?!服[務务]|型|[稅税]))(?!紀錄|明細)|卖出|賣出|买入|買入|出价(?!记录)|出價(?!紀錄)|投注|下注|捐款|捐赠|捐贈|打赏|打賞)`,
  'i',
);

// A confirm() says what accepting it will do, not what a button says: "Your
// card will be charged $49.00", "Proceed with the payment of $49.00?", "$49.00
// will be deducted", 청구됩니다, 請求されます, 扣款 -- and every commit phrase
// above counts there too ("Send $50.00 to Alice?", "This places your order for
// $49.00"), money given, tipped, bid, contributed, invested, authorized, sent
// or spent with its amount wherever the message says it ("Do you want to send
// $50.00 to Alice?", "You are sending $49.00 to Jane Doe", "You'll spend $49.00
// from your balance": a confirm is no headline -- while "Spend $5 more to get
// free shipping" spends nothing yet), money debited ("We will debit $49.00
// from your account"), stored money spent -- an amount used or applied from a
// balance, a credit, a wallet or a gift card ("Use $49.00 from your gift card
// balance?", "Apply $49.00 store credit to this order?"), a card used for an
// order of an amount ("Your Visa ending 4242 will be used for this $49.00
// order") -- while an offer accepted brings money in ("Accept the offer of
// $49.00 for your item?"), and an offer named with its price (below). These are
// read in dialog messages only: on a link, "Why was I charged $9.99?" is a
// help page. Removing a debit card pays nothing, so "debit" alone is not one
// of them, and a charge is one only beside an amount ("Charge your phone
// now?" is not). An amount confirmed, approved or authorized pays where the
// question ends with it or names what moves money right after it ("Confirm
// $49.00?", "Approve the $49.00 transaction?", "Authorize a $49.00 charge?")
// -- while "Confirm cancellation of your $9.99/month plan?", "Approve this
// request?", "Confirm the $49.00 refund?" and "We did not approve $49.00."
// pay nothing. A card or an account charged is one too ("OK to charge your
// card?", "This will charge your card ending in 4242", "Charge my card now?"
// -- "Charge your phone" and "We won't charge your card" are not), and so is
// a charge authorized ("Authorize this charge?"). An order is asked for with
// its amount anywhere in a confirm but after a word that names one ("Do you
// want to order this item for $49.00?" -- "Your order for $49.00 has
// shipped" is read with the totals, below).
// Money paid is also told as under way ("You are paying $49.00 to Acme Inc.",
// "You are buying 2 tickets for $49.00", "You are donating $25.00 to Red
// Cross") or as about to go through ("…or the $49.00 payment will go
// through"), and an amount is sent, sent again, or a payment tried again or
// repeated, by a bare question after it ("$500.00 to Jane Doe. Send?",
// "Payment declined ($49.00). Retry?", "Previous payment: $49.00. Repeat
// it?" -- an invoice or a reminder sent is no money).
// Money is also taken from an account or a card, or out of one, whatever it
// is called ("£49.00 will be taken from your current account on 1 March",
// "taken from your Visa card", "taken out of your PayPal balance"); an amount
// is sent, paid, transferred, collected, taken, debited or withdrawn -- the
// amount, a rate after it or not, at most three words before "will be sent",
// "is being paid", "gets collected", "will be taken" ("$49.00 will be sent to
// Jane Doe", "$9.99/month will be paid from your card", "£49.00 will be taken
// on 1 March"), but not one sent, paid or taken back or off ("$49.00 will be
// sent back to your card"), nor one a refund, a credit, cashback or a rebate
// names as its own: right before the amount, or before words that only say
// which amount it is ("A refund for the full $49.00 will be sent to your
// card", "Your store credit is $0.00" -- while the $49.00 in "…, so $49.00
// will be paid by card" is taken), or among the words between the amount and
// what is done with it ("A $49.00 store credit will be sent to your account")
// -- a credit card is no credit ("With your credit card, $49.00 will be sent
// to Jane Doe now"); "Your message will be sent to Jane. You have $5 credit
// left." and "You will be paid $49.00 for this survey" send nothing; a
// donation, a transaction, a transfer, a withdrawal or a purchase is of an
// amount ("Confirm this transaction of $49.00?"); and a total is an amount,
// with up to three words that say which total and a parenthesis before it
// ("Total: $49.00. Proceed?", "Your total today is $49.00", "Total due today:
// $49.00", "Total amount due: $49.00", "Total price: $49.00", "Total (incl.
// VAT): $49.00") -- where "Total items: 3" is a count and a "Total refund"
// pays nothing. A total is read only where the message stops nothing, so
// "Remove this item? Your new total is $39.00." is let through: the new total
// is what the stop leaves.
// A bill is worded in more ways than a charge: any billing word within forty
// characters of an amount, on either side ("Confirm subscription: $9.99/month",
// "This will cost $49.00", "A $5 fee applies", 年額4,900円を請求します,
// 收取 ¥49.00 年费), and a few that bill with no amount at all ("will be
// billed", "billed annually", 과금됩니다, 청구될, 課金されます, 引き落とします,
// 扣费). "Total" alone is not a billing word ("Your total is 3 items"). A
// deduction moves money only beside an amount, or the word "amount" itself,
// or out of an account ("$49.00 will be deducted", "deducted from your
// account"); "500 points will be deducted" moves none. A budget, a limit, a
// price, a goal, a target, a threshold or a cap changed, set, updated,
// adjusted, raised, lowered, increased, decreased or reduced to an amount is
// set, not billed ("Change your budget to $600/month?", "Set your spending
// limit to $500/month?").
// Some billing words charge (a bill, a charge, a cost, a fee, 청구, 請求, 扣款,
// a deduction) and some only describe a plan and its rate (a subscription, a
// renewal, "monthly", "weekly", "quarterly", "biweekly", "per year", "a
// month", "every week", "every 2 weeks", "/month", "/wk", "/qtr", 요금, 料金,
// 年费, 월 9,900원
// and 연 99,000원 -- not 3월 5일, a date --, 매월, 매년, 每月, 每年, 毎月, 毎年,
// 月々, "/月", "/年"). A confirm that stops something names its price without
// paying it: "Are you sure you want to cancel your Premium plan
// ($9.99/month)?". So when the message stops something -- cancels it (any
// plan, "Cancel Premium ($9.99/month)?", "Cancel Spotify Premium") or says it
// is cancelled ("Your Premium plan ($9.99/month) will be cancelled"),
// unsubscribes, stops renewing it, names a cancellation ("Confirm
// cancellation ($9.99/month)?" -- a "free cancellation" is sold, not done), or
// says "end your plan" (or subscription, membership, trial) -- not a
// downgrade, which sets a new price -- or turns off, stops, removes, deletes,
// pauses, disables or deactivates something a bill is for: a plan, a
// subscription, a membership, a trial, auto-renew or a renewal, an account, a
// card, a payment, an order, a transaction, a transfer, a withdrawal, a wire, a
// deposit, a trade, a bid, a booking, a reservation, an item, a cart, a
// basket, a bag, a product, a donation, a pledge, a purchase or a ticket,
// named at most four words on ("Turn off auto-renew", "Remove this card",
// "Delete this transaction", "Remove from cart", "Cancel this scheduled
// transfer of $500.00?"), or says 해지, 취소, 解約, キャンセル, 取消, 取り消し,
// 退订 or their kin, which need nothing after them (关闭 needs what a bill is
// for after it: 关闭自动续费, 关闭订阅) --
// only the words that charge count beside an amount: "Cancel your plan? A $10
// cancellation fee applies." and "Cancellation fee: $25.00" still bill. "Remove
// ads ($4.99/month)?" and "Turn off ads with Premium ($4.99/month)?" stop
// nothing a bill is for, so their rates bill -- and so does "Delete the budget
// category "Groceries" ($600/month)?", a refusal accepted with them. The
// phrases above and every commit phrase count whatever the message stops. A
// reassurance names no action -- "Subscribe for $9.99/month? Cancel
// anytime.", "You can cancel at any time", 언제든지 해지, いつでも解約 and 随时取消
// are said beside a plan being sold -- and an action with a price of its own
// is bought, not stopped: "Remove ads for $4.99/month?", "Pause your
// membership for $5/month?". So is a stop priced for the time it is stopped:
// a pause ("while paused", "while it is paused", "during the pause") right
// after its rate or right before it ("Pause your membership ($5/month while
// paused)?", "While paused: $2/month"), or anywhere in a sentence that names
// an amount with a fee, a charge or a cost ("It costs $5/month while paused")
// -- "Your $30/month rate is locked while paused" and "We keep your data while
// paused" price no pause. A billing period, cycle, date, address, details or
// history only describes the plan: "You will lose access at the end of the
// current billing period ($9.99/month)".
const BILLING_DETAIL = String.raw`\s(?:period|cycle|date|address|details|history)s?\b`;
const ACTIVE_BILLING_WORD = String.raw`(?:\b(?:bill(?:s|ed|ing)?(?!${BILLING_DETAIL})|charge[sd]?|costs?|fees?)\b|청구|과금|부과|請求|課金|引き落と|扣[费費]|扣款|收[费費]|收取|扣除)`;
const DESCRIPTIVE_BILLING_WORD = String.raw`(?:\b(?:subscriptions?|renew(?:s|al|ed)?|monthly|annually|yearly|weekly|quarterly|bi-?weekly|bill(?:ing)?(?=${BILLING_DETAIL}))\b|\b(?:a|each|every|per)\s(?:month|year|week)\b|\bevery\s(?:[1-9]\d?|two|three|four|six)\s(?:weeks|months|years)\b|\/\s?(?:mo|month|wk|week|yr|year|qtr)\b|\/\s?[月年]|(?<!\d)[월연]\s?(?=\d)|매[월년]|[每毎][月年]|月々|요금|料金|月額|年額|[费費]用|[年月][费費]|[计計][费費])`;
const DEDUCTED = String.raw`\b(?:deducted|debited)\b`;
// What a stop stops when a bill is for it, and the words before it, each with
// no mark in it that ends a sentence (the point in "$9.99" is none): "Remove
// ads? Your plan stays at $9.99/month." stops no plan. Nor do the words reach
// past another action: not past "and", "or", "then", "&", "+", a comma or a
// semicolon, and not over a word that commits or starts something ("This
// promo code has expired. Remove it and place order?", "Remove coupon and
// complete purchase?" -- the order and the purchase are the commit's, not
// what is stopped). Billed things named together are one thing stopped ("Cancel
// this wire transfer?").
const BILLED_THING = String.raw`(?:plans?|subscriptions?|memberships?|trials?|auto[-\s]?renew(?:als?)?|renewals?|accounts?|cards?|payments?|orders?|transactions?|transfers?|withdrawals?|wires?|deposits?|trades?|bids?|bookings?|reservations?|items?|carts?|baskets?|bags?|products?|donations?|pledges?|purchases?|tickets?)\b`;
const SENTENCE_WORD = String.raw`(?:[^\s.?!。？！]|\.(?=\d)){1,30}`;
const COMMITTING_VERB = String.raw`(?:plac(?:e|es|ing)|complet(?:e|es|ing)|confirm(?:s|ing)?|submit(?:s|ting)?|mak(?:e|es|ing)|pay(?:s|ing)?|buy(?:s|ing)?|purchas(?:e|es|ing)|order(?:s|ing)?|send(?:s|ing)?|retr(?:y|ies|ying)|process(?:es|ing)?|authori[sz](?:e|es|ing)|finali[sz](?:e|es|ing)|start(?:s|ing)?|subscrib(?:e|es|ing)|upgrad(?:e|es|ing)|get(?:s|ting)?|add(?:s|ing)?|checkout|donat(?:e|es|ing)|transfer(?:s|ring)?|renew(?:s|ing)?|join(?:s|ing)?|activat(?:e|es|ing)|switch(?:es|ing)?|keep(?:s|ing)?|stay(?:s|ing)?|go(?:es|ing)?|mov(?:e|es|ing)|chang(?:e|es|ing)|tr(?:y|ies|ying)|continu(?:e|es|ing)|choos(?:e|es|ing)|pick(?:s|ing)?|select(?:s|ing)?|tak(?:e|es|ing)|extend(?:s|ing)?|resum(?:e|es|ing)|restart(?:s|ing)?|re-?activat(?:e|es|ing)|re-?subscrib(?:e|es|ing)|re-?join(?:s|ing)?|unlock(?:s|ing)?|book(?:s|ing)?|rent(?:s|ing)?|bid(?:s|ding)?|tip(?:s|ping)?|giv(?:e|es|ing)|invest(?:s|ing)?|contribut(?:e|es|ing)|deposit(?:s|ing)?|withdraw(?:s|ing)?|trad(?:e|es|ing)|sell(?:s|ing)?)`;
const STOP_WINDOW_WORD = String.raw`(?!(?:and|or|then|&|\+|${COMMITTING_VERB})(?=\s))(?:[^\s.?!。？！,;]|[.,](?=\d)){1,30}`;
const STOP_WINDOW = String.raw`(?:\s{1,3}${STOP_WINDOW_WORD}){0,3}?\s{1,3}${BILLED_THING}(?:\s{1,3}${BILLED_THING}){0,2}`;
// A stop said in Korean, Japanese or Chinese names what it stops right beside
// it, a price in brackets between them or not: 결제를 취소, 자동결제를 해지,
// 정기결제(월 9,900원)를 해지, 구독을 해지, 주문을 취소, 注文をキャンセル,
// お支払いを取り消し, 決済をキャンセル, 定期購入を停止, 取消订单, 取消支付,
// 关闭订阅, 关闭自动扣款, 取消自动扣费. What it stops is taken out and the stop
// word left, which says what else it is (구독 해지를 신청 applies for a
// cancellation).
const CJK_STOPPED_THING = String.raw`(?:(?:자동|정기)?\s?결제|구독|주문|구매|송금|이체|예약)(?:\s?[(（][^()（）]{0,30}[)）])?\s?[을를]?\s?(?=취소|해지)|(?:注文|お?支払い?|決済|購入|送金|振込|予約)[をの]?\s?(?=キャンセル|取り?消|解約|(?:一時)?停止)|(?<=取消|关闭|關閉)\s?(?:订单|訂單|支付|付款|订阅|訂閱|购买|購買|转账|轉帳|充值|(?:自[动動])?(?:扣款|扣[费費]|续费|續費))`;
// The stop and what it stops, taken out of the phrases of a message that
// stops something: what it stops is no commit of its own ("Cancel your
// purchase of $49.00?", "Cancel this payment of $49.00?", 결제를
// 취소하시겠습니까?), and what the rest says still counts ("Remove this card
// and pay $49.00 now?", 결제를 취소하고 다시 결제하시겠습니까?).
const STOPPED_THING_PATTERN = new RegExp(
  String.raw`\b(?:cancel(?:l?ing)?|turn\soff|stop|remove|delete|pause|disable|deactivate)\b${STOP_WINDOW}|${CJK_STOPPED_THING}`,
  'gi',
);
const STOPPING_ACTION_PATTERN = new RegExp(
  String.raw`(?<!\b(?:can|may)\s|언제든지?\s?|いつでも|[随隨][时時]\s?)(?:\b(?:(?:turn\soff|stop|remove|delete|pause|disable|deactivate)\b(?=${STOP_WINDOW})|cancel(?:l?(?:ing|ed))?\b|unsubscribe\b|stop\srenewing\b|(?<!\bfree\s)cancell?ations?\b|end\s(?:your|the|my|this)\s(?:plan|subscription|membership|trial)\b)(?!(?:\s[a-z'’]{1,15}){0,3}\s(?:(?:anytime|any\stime|at\sany\stime)\b|for\s${MONEY}))|해지|취소|삭제|중지|해제|解約|キャンセル|削除|停止|取り?消|删除|刪除|停用|退订|退訂|[关關][闭閉](?=\s?(?:自[动動])?(?:订阅|訂閱|续费|續費|续订|續訂|订单|訂單|支付|付款|扣[费費]|扣款|会员|會員)))`,
  'i',
);
// A message that also starts something -- "End your trial and start your
// $9.99/month plan now?", "Subscribe for $9.99/month? No refunds on
// cancellation.", 가입하시겠습니까 -- sells it, whatever it stops: a stopping
// action counts only in one that starts nothing. A plan is started as 변경,
// 전환, 바꾸, 옮기, 업그레이드, 가입하, 구독하, 시작, 신청, 이용하시겠습니까 (or
// 이용하기), 変更, 切り替え, 乗り換え, 移行, アップグレード, 購読する, 登録する (or
// 登録します, 購読しましょう), 契約する (or 契約します, 契約を結ぶ), 開始, 申し込,
// 加入, 订阅, 升级, 切换, 更换, 改为, 改用 and 换成 (in either script) too:
// 베이직을 해지하고 프로로 변경하시겠습니까? --
// while a start date (시작일, 開始日), a start that will not be made (새로
// 시작하지 않습니다, 開始されません), a contract named as a thing (月額980円の
// 契約は3月3日に終了します, 契約更新), a cancellation applied for (해지 신청), a
// plan held (ご契約中, 加入中), a subscription cancelled (取消订阅) or one that
// can be made again (可随时重新订阅) starts nothing. A reassurance starts
// nothing either ("You can upgrade again any time", "You can start again
// anytime", "Upgrade later", "Join whenever you like"). Getting, adding,
// keeping or staying is a start only with its price (below): "You will keep
// access until March 3" and "You'll get a refund for the unused days" are
// said beside a plan being stopped. A start told as under way ("starts",
// "begins") is one in a sentence with an amount: "End your trial now? Premium
// ($9.99/month) starts today." One told as past ("started", "begun") is one
// only when it is today, now or immediately: "Your membership ($9.99/month)
// started on March 3" says when it began. A move onto a plan said to be free
// starts nothing (解約後は無料プランに移行します, 取消后将改用免费版, 무료
// 요금제로 바꾸) unless a later price pays for it (below) -- a free trial is a
// start (프로 무료 체험으로 변경, 無料体験に切り替え, 切换到免费试用) -- and
// neither does a move a Korean message offers only as what
// its Cancel button does: 다른 요금제로 바꾸시려면 취소를 누르세요 ("to change to
// another plan, press Cancel" -- while 변경하시려면 확인을 누르세요 names OK).
const FREE_TRIAL_WORD = String.raw`(?:체험|트라이얼|体験|トライアル|お試し|试用|試用|体验|體驗)`;
const FREE_TARGET_BEFORE = String.raw`(?:무료|無料|フリー)(?![^.?!。？！\r\n]{0,8}?${FREE_TRIAL_WORD})[^.?!。？！\r\n]{0,8}?(?:으?로|[にへ])\s?`;
const FREE_TARGET_AFTER = String.raw`(?:到|至|成|为|為)?\s?免[费費](?![^.?!。？！\r\n]{0,4}?${FREE_TRIAL_WORD})`;
const NOT_ONTO_FREE = String.raw`(?<!${FREE_TARGET_BEFORE})`;
const NOT_TO_FREE = String.raw`(?!${FREE_TARGET_AFTER})`;
// The moves those two pass over, read again where a later price pays for
// them (below).
const CJK_FREE_MOVE_PATTERN = new RegExp(
  String.raw`${FREE_TARGET_BEFORE}(?:변경|전환|바꾸|옮기|変更|切り替え|乗り換え|移行)|(?:切[换換]|更[换換]|改[为為]|改用|[换換]成)${FREE_TARGET_AFTER}`,
);
const NOT_FOR_CANCEL_BUTTON = String.raw`(?![^.?!。？！\r\n,，、]{0,12}?(?:려면|시면)(?:(?!확인)[^.?!。？！\r\n,，、]){0,30}?["“'‘「]?취소["”'’」]?\s?(?:버튼)?\s?[을를]?\s?(?:누르|눌러|클릭|선택|탭))`;
const STARTING_ACTION_PATTERN = new RegExp(
  String.raw`(?<!\b(?:can|may)\s|언제든지?\s?|いつでも|[随隨][时時]\s?)(?:\b(?:start|subscribe|upgrade|join|buy|begin|activate|switch\s(?:to|over)|sign\s?up|enrol(?:l)?|purchase)\b(?!(?:\s[a-z'’]{1,15}){0,3}\s(?:anytime|any\stime|at\sany\stime)\b)(?!(?:\s(?:again|back|up))?\s(?:later|whenever)\b)|(?:가입하|구독하|${NOT_ONTO_FREE}(?:변경|전환|바꾸|옮기)|업그레이드|시작(?!일|\s?[하되]지\s?않|\s?안)|(?<!(?:해지|취소|해제|탈퇴)[을를]?\s?)신청)${NOT_FOR_CANCEL_BUTTON}|이용(?:하시겠|하기)|購読する|登録する|登録しま(?:す|しょう)|購読しま(?:す|しょう)|申し込|申込む|${NOT_ONTO_FREE}(?:変更|切り替え|乗り換え|移行)|アップグレード|契約(?:する|しま(?:す|しょう)|いたします|を結)|開始(?!日|され(?:ません|ない)|しません|しない)|加入(?!中)|(?<!取消|停止|关闭|關閉|终止|終止|随时|隨時|重新)[订訂][阅閱]|[开開]通|升[级級]|(?:切[换換]|更[换換]|改[为為]|改用|[换換]成)${NOT_TO_FREE})`,
  'i',
);
const STARTED_PATTERN =
  /\b(?:starts|begins)\b|\b(?:started|begun)\b(?:\s[a-z'’]{1,15}){0,3}?\s(?:today|now|immediately)\b/i;
// A start told as what accepting does -- the user moved onto a plan ("You will
// be upgraded to Pro automatically", "You'll be switched to Pro", "You'll be
// put on Pro", "Your plan will be renewed as Pro", an enrolment, a
// subscription, a plan activated), told in so many words at a sentence's start
// ("Upgraded to Pro automatically", "Upgrading you to Pro"), or a start that
// will happen ("You'll switch to Pro", "Premium will start today", "We'll
// upgrade you to Pro", "Your membership will renew today") -- is one wherever
// the message says it, when the message holds an amount: "Cancel Basic? You
// will be upgraded to Pro automatically. New price: $14.99/month." A move onto
// a free plan ("You'll be switched to the Free plan", "…to Spotify Free") or
// onto a way to pay ("You will be switched to PayPal", a card, a bank account,
// Apple Pay, Google Pay) buys nothing, and neither does one that only can be
// made, one denied ("You won't be upgraded"), one that stays as it is ("You'll
// still be subscribed to our newsletter"), one in a reassurance ("We'll switch
// you back whenever you like"), a start of doing something ("You will start
// losing access"), a plan renewed as it is ("Your plan will be renewed at
// $9.99/month unless you turn it off"), a subscription kept to its end ("You
// will be subscribed until March 3"), one done before ("Your plan was upgraded
// on March 3", "Upgraded successfully") or what is moved that is not the user
// ("Your data will be moved to cold storage", "We'll move your files to the
// archive", money: "Your refund will be put on your original payment method",
// "Your balance will be moved to your new card"). Nor is a plan said to be
// free that is activated ("Your free plan will be activated", "Spotify Free
// will start" -- a free trial still is one, and so is an "Ad-Free" plan), one
// put on hold, on pause or on a waitlist, or a renewal today that the message
// says will not come if it is turned off ("Your plan will renew today unless
// you turn it off").
// Where a move goes that buys nothing: a way to pay, or a plan said to be free
// within a few words of it ("Spotify Free", "the Basic plan (free)", "Basic,
// which is free", "the free tier at no cost", "$0") -- not a free trial that
// bills after it ("Premium (free for 7 days, then $9.99/month)", "the free Pro
// trial").
const WAY_TO_PAY = String.raw`(?:paypal|apple\s?pay|google\s?pay|(?:(?:credit|debit|new|other|saved|default)\s){0,2}cards?|bank(?:\saccount)?)\b`;
const FREE_SAID = String.raw`(?:\(?free\b\)?(?!\s(?:for|trial|until|then)\b|\s[a-z]{1,20}\strials?\b)|which\sis\sfree|at\sno\s(?:extra\s)?cost|for\sfree|\(?\$0(?:\.00)?\)?(?![\d.,]))`;
const MOVED_ONTO = String.raw`(?:\s[a-z'’]{1,15}){0,2}?\s(?:to|onto|into|on)\s(?:(?:the|a|an|our|your|another)\s)?`;
const MOVED_TO_WAY_TO_PAY = String.raw`${MOVED_ONTO}${WAY_TO_PAY}`;
const MOVED_TO_NOTHING = String.raw`${MOVED_ONTO}(?:${WAY_TO_PAY}|(?:[\w'’-]{1,20},?\s){0,4}?${FREE_SAID})`;
const NOT_RENEWED_IF_OFF = String.raw`(?!,?\s{1,3}(?:unless|otherwise)\b)`;
const NOT_FREE_STARTED = String.raw`(?<!(?:\(|(?<![\w-]))free\)?\s(?!(?:trials?|for|until)\b)(?:[a-z]{1,20}\s)?(?:will|would|is|are|gets?)\s(?:(?:be|being|get|gets|getting)\s)?(?:(?:automatically|instantly|immediately|then|now|also)\s)?)`;
const toldStart = (notFreeStarted: string) =>
  String.raw`(?<!\b(?:can|could|may|might|still|not|never)\s|n['’]t\s|\b(?:data|files?|photos?|documents?|content|emails?|messages?|history|settings|backups?|videos?|music|playlists?|library|folders?|refunds?|credits?|money|funds|balances?|payments?|deposits?|amounts?|points|rewards?|cashback)\s(?:will|would|is|are|gets?)\s)\b(?:(?:be|being|get|gets|getting)\s(?:(?:automatically|instantly|immediately|then|now|also)\s)?(?:upgraded|${notFreeStarted}activated|(?:switched|moved)(?=(?:\s(?:over|back))?\s(?:to|onto|into)\b)|(?:put|placed)(?=\s(?:on|onto)\b(?!\s(?:(?:a|the)\s)?(?:hold|pause|wait(?:ing)?[-\s]?lists?)\b))|renewed(?=\s(?:as|to|into|onto)\b)|enrolled(?=\s(?:in|into|on|onto|to)\b)|subscribed(?=\s(?:to|onto)\b))|(?:will|['’]ll)\s(?:(?:automatically|instantly|immediately|then|now|also)\s)?(?:${notFreeStarted}(?:start|begin|activate)|subscribe|upgrade|join|enrol(?:l)?|renew(?=\s(?:today|now|immediately)\b${NOT_RENEWED_IF_OFF})|(?:switch|move)(?:\s(?:you|over|back)){0,2}(?=\s(?:to|onto|into)\b))(?!\s(?!during\b)[a-z]{2,20}ing\b)|renews(?=\s(?:today|now|immediately)\b${NOT_RENEWED_IF_OFF})|(?<=^|[.?!。？！]\s{0,3}|\n\s{0,3})(?:upgraded|switched|moved|enrolled|subscribed)(?=(?:\s(?:automatically|instantly|immediately|now))?\s(?:to|into|onto|in)\b)|(?:upgrading|switching|moving|enrolling|subscribing)\s(?:you|your\s(?:plan|account|subscription|membership))(?=\s(?:to|into|onto|in)\b))\b`;
const TOLD_START = toldStart(NOT_FREE_STARTED);
const NOT_REASSURED_START = String.raw`(?!(?:\s[a-z'’]{1,15}){0,3}?\s(?:anytime|any\stime|at\sany\stime|whenever)\b)`;
const TOLD_START_PATTERN = new RegExp(
  String.raw`${TOLD_START}(?!${MOVED_TO_NOTHING})${NOT_REASSURED_START}`,
  'i',
);
// The same start with only a way to pay ruled out: a move onto a plan said to
// be free, or a free plan activated, is still one when its sentence prices it
// after it above nothing (pricesStart: "You'll be upgraded to Pro with 1
// month free, then $14.99/month", "…switched to Premium plus free shipping for
// $14.99/month", "…upgraded to Pro for $0 today, then $14.99/month", "…moved to
// the annual plan, which is free for the first month, then $99/year", "…free
// Premium will be activated for 30 days, then $14.99/month") -- not "…moved to
// Basic ($0)", "…and get a prorated refund of $4.99".
const TOLD_START_ANY_PATTERN = new RegExp(
  String.raw`${toldStart('')}(?!${MOVED_TO_WAY_TO_PAY})${NOT_REASSURED_START}`,
  'i',
);
// A plan said to be free that is started or activated, the start
// NOT_FREE_STARTED passes over, or a free one told as starting now ("Free Pro
// starts today", "Your free trial of Pro begins today") -- read again where a
// later price pays for it.
const FREE_START_PATTERN = new RegExp(
  String.raw`(?:\(|(?<![\w-]))free\)?\s(?:(?!(?:trials?|for|until)\b)(?:[a-z]{1,20}\s)?(?:will|would|is|are|gets?)\s(?:(?:be|being|get|gets|getting)\s)?(?:(?:automatically|instantly|immediately|then|now|also)\s)?(?:activated|start|begin|activate)|(?:[a-z]{1,20}\s){0,3}?(?:starts|begins))\b`,
  'i',
);
// An amount of nothing ("$0", "$0.00", "€0", "0원"), taken out before the
// amounts after a move are looked for.
const ZERO_AMOUNT_PATTERN = new RegExp(
  String.raw`(?:${CURRENCY}\s?0(?:[.,]0{1,2})?|(?<![\d.,])0(?:[.,]0{1,2})?\s?(?:${CURRENCY}|[원円元]))(?!\d|[.,]\d)`,
  'gi',
);
// A stop that names what it stops, a bill being for it, or one the user has
// asked for -- "Cancelling your $9.99/month plan. Continue?", "Cancel your
// Premium plan ($9.99/month). Are you sure?", "Turn off auto-renew
// ($9.99/month). Continue?", "Cancellation of your Premium plan", "Unsubscribe
// from Premium ($9.99/month).", "You're about to cancel Premium" -- is what the
// message is about in whatever sentence it says it, while "Cancel within 30
// days for a full refund" and "Cancelling now will empty your cart" name none.
const STOP_NAMED_PATTERN = new RegExp(
  String.raw`\b(?:(?:cancel(?:l?ing)?|cancell?ation\sof|turn(?:ing)?\soff|stop(?:ping)?|remov(?:e|ing)|delet(?:e|ing)|paus(?:e|ing)|disabl(?:e|ing)|deactivat(?:e|ing)|end(?:ing)?)\s(?:(?:your|the|this|my)\s(?:(?:[^\s.?!。？！,;]|\.(?=\d)){1,30}\s){0,2})?${BILLED_THING}|unsubscrib(?:e|ing)\sfrom\b|(?:about|chose|chosen|choosing|requested|asked|decided|going)\sto\s(?:cancel|unsubscribe|end|turn\soff|stop|remove|delete|pause|deactivate)\b)`,
  'i',
);
// A stop told as what will happen counts wherever the message says it: a
// thing cancelled ("Your Premium plan ($9.99/month) will be cancelled.
// Continue?", "This will cancel your order", "Your plan is going to be
// cancelled", 3월 5일에 해지됩니다, 멤버십을 해지합니다, 3月3日に解約されます,
// プレミアムを解約します, 将被取消), a plan, a subscription, a membership or
// its access that will end ("Your subscription will end on March 3"), a plan
// that will no longer renew or won't renew, a renewal or a charge that will
// stop ("We will stop renewing your plan", "…and your $9.99/month charge will
// stop", "your $9.99 Premium charge stops", "…when your $9.99/month billing
// period ends"), a thing a bill is for that will
// be removed, stopped, paused, deleted, disabled, deactivated, terminated or
// turned off ("This item will be removed from your cart"), and a cancel told
// with what it brings ("If you cancel, you will lose your Premium benefits",
// "If you cancel your order, you will get a full refund"). A trial or a sale
// that will end stops nothing ("Your free trial will end today" -- what
// follows it is the paid plan), nor does a discount that will be removed.
const FUTURE = String.raw`(?:will|['’]ll|(?:is|are|['’]re|['’]s)\sgoing\sto)\s(?:(?:now|then|also|automatically|immediately)\s)?`;
const ENDED_THING = String.raw`(?:plans?|subscriptions?|memberships?|renewals?|auto[-\s]?renew(?:als?)?|access|accounts?|services?|contracts?)`;
const TOLD_STOP_PATTERN = new RegExp(
  String.raw`\b${FUTURE}(?:be\s(?:(?:now|then|also|automatically|immediately)\s)?cancell?ed|cancel|no\slonger\s(?:renew|auto-?renew|continue)|stop\s(?:renewing|charging|billing))\b|\b(?:won['’]t|will\snot)\s(?:auto-?)?renew\b|\b${ENDED_THING}(?:\s?\([^()]{0,40}\))?\s${FUTURE}(?:be\s)?end(?:ed)?\b|\b${BILLED_THING}(?:\s?\([^()]{0,40}\))?\s${FUTURE}(?:be\s(?:removed|stopped|paused|deleted|disabled|deactivated|terminated|turned\soff)\b|stop\b|terminate\b)|\b(?:charges?|billing(?:\s(?:period|cycle))?)(?:\s?\([^()]{0,40}\))?\s(?:${FUTURE}(?:stop|end|cease)|(?:stops|ends|ceases))\b|\bif\syou\scancel\b(?:\s{1,3}${STOP_WINDOW_WORD}){0,4}?,?\s{1,3}you(?:['’]ll|\swill)\s(?:(?:also|still)\s)?(?:lose|keep|no\slonger|not|get|receive|be\srefunded)\b|(?:해지|취소)(?:됩니다|될|되며|되고|합니다|하겠습니다)|(?:解約|キャンセル|取り?消し?)(?:されます|となります|になります|します|いたします)|[将將会會]被?(?:取消|退订|退訂)`,
  'i',
);
// A stop told or named outside the sentence the message asks speaks for its
// own sentence only: another sentence's amount is paid for ("Total: $49.00.
// Your pass won't renew automatically. Continue?", "Your monthly plan will
// end today. Total due today: $99.00."), unless that amount is no price of its
// own -- a possibility or a reassurance ("You can rejoin later for
// $9.99/month"), a refund or a credit (환불, 返金, 退款 too), the cart's new
// total ("Your new total is $39.00", "Your total is now $39.00"), the plan as
// it stands until it ends
// ("Your current price is $9.99/month", "Until then, you'll still have access
// ($9.99/month)"), a plan with its price told as ending or expiring ("…and
// your Premium plan ($9.99/month) ends on March 3", "…and your $9.99/month
// membership expires on March 3", "…and Premium ($9.99/month) ends March 3"
// -- read without it, the rest of the sentence may still hold a price) or a
// price in brackets alone ("(월 9,900원)"). A total or an
// amount due that a sentence states is a price of its own whatever else the
// sentence says ("Total: $49.00 (taxes may apply)", "Total due today: $99.00
// (you can cancel anytime)", "…(minus a $4.50 credit)") -- unless it is the
// cart's new total or a refund's ("Refund total: $49.00", "Your refund total
// is $49.00", "Total refunded: $49.00", "Order total: $49.00 will be refunded
// to your card", "Total: $49.00 (refund to original payment method)").
const PLAN_ENDS_PATTERN = new RegExp(
  String.raw`\b(?:your|the|this|my)\s(?:${MONEY}${AMOUNT_TAIL}${RATE}?\s)?(?:[a-z'’-]{1,15}\s){0,2}?${ENDED_THING}(?:\s?\([^()]{0,40}\))?\s(?:ends|expires)\b|\b[a-z][\w'’-]{1,20}\s?\([^()]{0,40}\)\s(?:ends|expires)\b`,
  'gi',
);
// The cause a page gives for a change it reports: the stock, the item's being
// no longer sold.
const REPORTED_CAUSE_PATTERN =
  /\b(?:because|due\s{1,3}to|out\s{1,3}of\s{1,3}stock|sold\s{1,3}out|unavailable|no\s{1,3}longer\s{1,3}(?:available|sold|in\s{1,3}stock)|discontinued)\b/i;
const NEW_TOTAL = String.raw`\bnew\s{1,3}total\b|\btotal\s{1,3}is\s{1,3}now\b`;
const REFUND_TOTAL = String.raw`(?:환불|返金|返還|退款|退回|退还|退還)\s?(?:예정\s?)?(?:합계|총액|총\s?금액|금액|合計|総額|金額|总额|總額|金额|总计|總計)|\brefund\s{1,3}total\b|\btotal\s{1,3}refund(?:ed|s)?\b|\btotal\b(?:[^.?!。？！\r\n]|\.(?=\d)){0,40}?\b(?:will\s{1,3}be|is|are|gets?|has\s{1,3}been)\s{1,3}(?:refunded|returned|reimbursed|credited(?:\s{1,3}back)?)\b|\btotal\b(?:[^.?!。？！\r\n]|\.(?=\d)){0,40}?\(\s?refund(?:ed)?\s{1,3}(?:to|in)\b`;
const REFUND_TOTAL_PATTERN = new RegExp(REFUND_TOTAL, 'i');
const TOTAL_EXCUSED_PATTERN = new RegExp(String.raw`${NEW_TOTAL}|${REFUND_TOTAL}`, 'i');
const AMOUNT_EXCUSED_PATTERN = new RegExp(
  String.raw`\b(?:can|could|may|might)\b|\b(?:anytime|any\s{1,3}time|later|whenever)\b|\b${MONEY_BACK}\b|환불|返金|返還|退款|退回|退还|退還|${NEW_TOTAL}|\bcurrent(?:ly)?\s{1,3}(?:price|plan|rate)\b|\buntil\s{1,3}then\b|\bstill\s{1,3}(?:have|keep|get|enjoy)\b|^\s{0,3}[(（][^()（）]{0,40}[)）]\s{0,3}$`,
  'i',
);
// An offer named with its price is bought, whatever the message stops: get,
// add, go, move, change, stay or keep (not told as what the user will still
// have: "You'll keep Premium ($9.99/month) until then", "You'll stay
// subscribed until March 3 ($9.99/month)"), start, upgrade, switch,
// subscribe, join, renew, activate, try, rent ("Rent 'Dune' for $3.99?"),
// continue, extend,
// resume, restart, reactivate, resubscribe, rejoin or unlock, at most four
// words of its sentence, then
// "for" right before an amount ("Cancel Basic and get Pro for $9.99/month?",
// "Stay on Premium for $4.99/month instead of cancelling?", "Don't cancel -
// get 3 months for $9.99?", "Unlock all levels for $4.99?", "Try again for
// $0.99?") -- or an amount and its rate in brackets or after "at"
// ("Cancel your Basic plan and move to Premium ($14.99/month)?", "…and move to
// Premium at $14.99/month?", "…get Pro at just $9.99/month?"), or a price word
// before the amount in brackets ("get Pro (only $9.99/month)?"). Shopping or
// browsing continued buys nothing ("Continue shopping for $5 deals"). A bare
// amount in brackets names what is
// moved or kept, not a price: "Move 3 transactions ($149.00) to Groceries?",
// "Decline the offer and keep your price ($49.00)?". An amount that moves no
// money is no price ("$5 off", "$5 back", "$5 credit", cashback, a refund),
// nor is a refund, a credit, a discount or a rebate that is got ("You'll get
// a prorated refund for $4.99"). "to $X" and "at $X" alone set a value
// ("Change the price to $49.00?", "Keep the price at $49.00?"). What is
// created, chosen, picked, selected or taken for an amount is no purchase of
// a plan without its rate -- "Create an invoice for $49.00?", "Take the
// buyer's offer for $45.00?", "Select this room for $129/night?", "Choose this
// flight for $249.00?" -- while one with a rate, a term bought for the
// amount, or a plan, a subscription or a membership named by its words is
// ("…and create a Pro account for $9.99/month?", "Select Premium for
// $9.99/month?", "Take 3 months for $9.99?", "Select the annual plan for
// $99.00?", "Pick the lifetime membership for $199.00?"). Like a start, it is no
// offer in a reassurance ("You can get Premium again for $9.99/month any
// time", "Restart anytime for $9.99/month", "Rejoin any time for
// $9.99/month", "Restart for $9.99/month whenever you like" -- anytime, any
// time, later or whenever said before the price or right after it), nor when
// it is denied ("Your plan will no longer renew ($9.99/month)", "won't
// renew"), and it is read where a negated clause is taken out: "You won't be
// charged to keep your plan ($9.99/month)" offers nothing.
const PRICED_VERB = String.raw`(?:get(?!\s(?:(?:a|your)\s)?(?:(?:full|partial|prorated)\s)?(?:refund|credit|discount|rebate)s?\b)|add|go|move|change|(?<!(?:['’]ll|\bwill|\bstill)\s)(?:stay|keep)|start|upgrade|switch|subscribe|join|(?<!auto[-\s]?)renew|activate|try|rent|continue(?!\s(?:shopping|browsing)\b)|extend|resume|restart|re-?activate|re-?subscribe|re-?join|unlock)`;
const RATED_VERB = String.raw`(?:create|choose|pick|select|take)`;
const NO_MONEY_MOVED = String.raw`(?!${AMOUNT_TAIL}\s?(?:off|back|${MONEY_BACK})\b)`;
const REASSURANCE = String.raw`(?:anytime|any\s{1,3}time|later|whenever)\b`;
const PRICE_WORD = String.raw`(?!${REASSURANCE})${SENTENCE_WORD}`;
const NOT_REASSURED = String.raw`(?!${AMOUNT_TAIL}${RATE}?\)?[\s,]{1,3}(?:at\s{1,3})?${REASSURANCE})`;
const PRICE_SAID = String.raw`(?:\s{1,3}${PRICE_WORD}){0,4}?(?:\s{1,3}for\s{1,3}${MONEY}${NOT_REASSURED}${NO_MONEY_MOVED}|\s{0,3}\(\s?(?:(?:only|just|from|now)\s${MONEY}${NOT_REASSURED}${NO_MONEY_MOVED}|${MONEY}${NOT_REASSURED}${RATE_AFTER})|\s{1,3}at\s{1,3}(?:(?:only|just)\s)?${MONEY}${NOT_REASSURED}${RATE_AFTER})`;
const TERM = String.raw`(?:\d{1,3}|an?|one|two|three|four|six|twelve)\s(?:(?:more|extra|additional)\s)?(?:weeks?|months?|years?)\b`;
const PLAN_NAMED = String.raw`(?:annual|yearly|monthly|weekly|lifetime|(?:plan|subscription|membership)s?)\b`;
const PRICED_START_PATTERN = new RegExp(
  String.raw`(?<!\b(?:can|may|not|never|longer)\s|n['’]t\s)\b(?:${PRICED_VERB}\b${PRICE_SAID}|${RATED_VERB}\b(?:(?:\s{1,3}${PRICE_WORD}){0,4}?(?:\s{1,3}(?:for|at)\s{1,3}|\s{0,3}\(\s?(?:(?:only|just|from|now)\s)?)${MONEY}${NOT_REASSURED}${RATE_AFTER}|(?:\s{1,3}${PRICE_WORD}){0,2}?\s{1,3}${TERM}\s{1,3}for\s{1,3}${MONEY}${NOT_REASSURED}${NO_MONEY_MOVED}|(?:\s{1,3}${PRICE_WORD}){0,3}?\s{1,3}${PLAN_NAMED}(?:\s{1,3}${PRICE_WORD}){0,3}?\s{1,3}for\s{1,3}${MONEY}${NOT_REASSURED}${NO_MONEY_MOVED}))`,
  'i',
);
const PAUSED = String.raw`\b(?:while\s(?:it(?:\sis|['’]s)\s)?paused|during\s(?:the|your)\spause)\b`;
const PAUSED_PATTERN = new RegExp(PAUSED, 'i');
const PAUSED_PRICE_PATTERN = new RegExp(
  String.raw`${MONEY}${AMOUNT_TAIL}${RATE}?\s{1,3}${PAUSED}|${PAUSED}[\s:,]{0,3}${MONEY}`,
  'i',
);
const PAUSE_FEE_PATTERN = /\b(?:fees?|charge[sd]?|costs?)\b/i;
// What a message says an amount is -- a donation, a transaction, an order, a
// total, an amount payable or due -- moves money unless the message stops
// something: "Confirm this transaction of $49.00?", "Proceed with your order
// of $49.00?", "Continue with this order ($49.00)?", "Submit this $49.00
// order?", "Your total is now $49.00", "Your total will be $49.00", a total
// with what it includes or counts ("Total incl. VAT: €49.00", "Total for 2
// items: $49.00", "Total (2 items): $49.00", 合計（税込）：4,900円, 합계(부가세
// 포함): 49,000원), "Amount payable: $49.00", "Balance due: $49.00", "Amount
// due today: $49.00", "Due today: $49.00", an amount told as due now ("$49.00
// is due today", "…is now due" -- not a refund due), "Amount to pay: $49.00",
// "Payment amount: $49.00", a count of items set beside its amount as a total
// line ("2 items - $49.00", "3 items · $49.00" -- not "1 item, $49.00" or "2
// items ($49.00)"), an order summed up ("Order summary: 2 items, $49.00",
// "Subtotal $45.00 + tax $4.00 = $49.00"), an
// amount labelled as a payment, a donation or another that is given ("Your
// payment: $49.00", "Donation amount: $25.00") and a total in Korean,
// Japanese or Chinese (총 결제 금액: 49,000원, 총 49,000원, 합계 49,000원,
// お支払い金額：4,900円, 合計 4,900円, ご請求金額, 支付金额：¥49.00, 总计
// ¥49.00, 共计¥49.00, 本次消费¥49.00, 消费金额：¥49.00 -- 消费记录 names no
// amount, and a period's spending is a record: 本月消费¥1,234.00 -- while 총
// before an amount that a discount, an accrual, a refund or a reward names
// right after it, as what is done with that amount, is none -- the word
// followed, after 처리 or 진행 or not, by 됩, 되 (not 되지 않 or 되지 못), 돼,
// 됐, 될 (not 될 수 없), 해 드, 합니다 or 예정, or ending its clause (a point
// before a digit ends none) -- and so is 총 after the label of such an
// amount: 총 5,000원이 할인됩니다, 총 500원 적립, 총 5,000원을 할인해
// 드립니다, 총 49,000원이 환불될 예정입니다, 총 49,000원이 환불 처리됩니다,
// 환불 예정 금액은 총 49,000원입니다; 할인 후 총 44,000원입니다, 할인가 총
// 44,000원, 총 49,000원(할인 적용), 총 44,000원 할인가로 주문됩니다, 총
// 49,000원 환불 불가입니다, 총 49,000원이 환불될 수 없습니다, 총 44,000원
// 할인받고 and 총 49,000원이 할인되지 않습니다 are paid), a particle between
// the label and the amount or not
// (お支払い金額は4,900円です, 결제 금액은 49,000원입니다, 支付金额为¥49.00,
// 付款金额是¥49.00) pay;
// "Delete this transaction of $49.00?", "Cancel your order of $49.00?" and
// "Remove this item? Your new total is $39.00." do not, and neither does a
// balance shown ("Balance: $49.00"), an amount refunded or saved (환불 금액,
// 返金額, "Amount refunded: $49.00", "Total saved: $10.00"), a payment
// amount that names none (결제 금액이 변경되었습니다) or a payment already
// made ("Your last payment: $49.00 on March 3", a previous, prior, recent,
// latest or past one). An order told as about to be placed or submitted pays,
// whatever else the message stops ("Your order will be placed. Continue?",
// "…or your $49.00 order will be placed", "…and your order of $59.00 will be
// placed" -- not one placed on hold).
const ORDER_PLACED_PATTERN = new RegExp(
  String.raw`\b(?:your|the|this|my)\s(?:new\s)?(?:${MONEY}${AMOUNT_TAIL}\s)?order\s(?:(?:of|for)\s${MONEY}${AMOUNT_TAIL}\s)?(?:will|is\sgoing\sto)\s(?:(?:now|then|also)\s)?be\s(?:placed|submitted)\b(?!\s{1,3}on\s{1,3}hold\b)`,
  'i',
);
const NOT_PAST_PAYMENT = String.raw`(?<!\b(?:last|previous|prior|recent|latest|past)\s)`;
const AMOUNT_DIALOG_PATTERN = new RegExp(
  String.raw`(\b(donation|transaction|transfer|withdrawal|purchase|order) (of|for) ${MONEY}|\border\s?\(\s?${MONEY}|\b(submit|place|confirm|complete|finali[sz]e) (the |your |my |this )?${MONEY}${AMOUNT_TAIL}\s(order|purchase)\b|\btotal(\s(due|today|now|charge|amount|price|cost|payable)|\s(incl|including|inc|excl|excluding)\.?(\s(vat|gst|tax(es)?|shipping|delivery|fees?))?|\s(vat|gst|tax)|\sfor\s\d{1,3}\s[a-z]{2,12}){0,3}(\s?[(（][^()（）]{0,40}[)）])?\s?[:：=]?\s?(is\s((now|still|currently)\s)?|of\s|will\sbe\s|comes\sto\s)?${MONEY}|\b((amount|balance)\s(due|payable|owed|owing|to\s(be\s)?(pay|paid|charged))(\s(today|now))?|${NOT_PAST_PAYMENT}payment\samount)(\s?\([^()]{0,40}\))?\s?[:=]?\s?(is\s|of\s|will\sbe\s)?${MONEY}|\bdue(\s(today|now))?\s?[:：=]\s?${MONEY}|(?<!\b(refund|credit|cashback|rebate)s?\s(of\s)?)${MONEY}${AMOUNT_TAIL}${RATE}?\s((is|are|will\sbe)\s(now\s)?due\s(today|now|immediately)|(is|are)\snow\sdue)\b|\b\d{1,3}\s(items?|products?|tickets?|seats?|units?)\s{1,3}[-–—·•|]\s{1,3}${MONEY}|\b(order|cart|checkout)\s(summary|details)\s?[:：]\s?(\d{1,3}\s(items?|products?)\s?[,·•|-]\s?)?${MONEY}|\bsub-?total\b([^.?!。？！\r\n]|\.(?=\d)){0,60}?=\s?${MONEY}|\b${NOT_PAST_PAYMENT}(payment|donation|contribution|purchase|tip|gift|transfer|deposit|withdrawal|pledge)(\s(amount|total|sum))?\s?[:：=]\s?${MONEY}|((총\s?)?(결제|주문|구매|청구)\s?(예정\s?)?금액|합계(\s?금액)?|총\s?금액|총액|(?<!(환불|적립|할인|캐시백|포인트)(\s?예정)?(\s?(금액|액|합계|총액)\s?[은는이가:：]?|\s?[:：])?\s?)총(?=\s?\d([\d,]|\.(?=\d)){0,15}\s?원(?!\s?[이가을를]?\s?(할인|적립|환불|절약|캐시백|지급|증정)(?=\s?((처리|진행)\s?)?(됩|되(?!지\s?[않못])|돼|됐|될(?!\s?수\s?(가\s?)?없)|해\s?드|합니다|예정)|\s?(\.(?!\d)|[,?!。？！，、]|$))))|お?支払い?金額|ご?請求金額|(ご購入|ご注文|決済)金額|合[計计](金額|金额)?|総額|お会計|[共总總][计計]|[总總]金?[额額]|[总總][价價]|(本次|此次|这次|這次)?(?<!本月|上月|当月|當月|本周|上周|本週|上週|今年|去年|本年)(消费|消費)(金[额額])?|(支付|应付|應付|付款|实付|實付|订单|訂單)(金[额額]|[总總][额額]))(\s?[(（][^()（）]{0,20}[)）])?\s?([:：=]|[はが]|[은는이가]|[为為是])?\s?${MONEY})`,
  'i',
);
// An amount stated as due now counts even where the message stops something,
// since accepting leaves it to pay ("Cancel your contract early? Total due
// today: $199.00", "…, but $49.00 is due today", "Early termination: $49.00
// due today", 추가 결제 금액 10,000원) -- not a refund, a credit, cashback or a
// rebate due, a new total, nor an amount of nothing. An amount before "due" is
// looked for back from where "due" stands, so a long run of digits costs no
// more than reading it.
const NOT_GIVEN_BACK = String.raw`(?<!\b(?:refund|credit|cashback|rebate|new)s?\s(?:of\s|amount\s)?)`;
const DUE_STATED_PATTERN = new RegExp(
  String.raw`${NOT_GIVEN_BACK}\b(?:amount|balance|total)\s(?:due|payable|owed|owing)\b(?:\s(?:today|now))?\s?[:：=]?\s?(?:is\s)?${MONEY}|${NOT_GIVEN_BACK}\bdue(?:\s(?:today|now))?\s?[:：=]\s?${MONEY}|(?=due\s(?:today|now|immediately)\b)(?<=${NOT_GIVEN_BACK}${MONEY}${AMOUNT_TAIL}${RATE}?\s(?:(?:is|are|will\sbe)\s)?(?:now\s)?)due|(?=now\sdue\b)(?<=${NOT_GIVEN_BACK}${MONEY}${AMOUNT_TAIL}${RATE}?\s(?:is|are)\s)now|추가\s?결제\s?금액\s?[:：은는이가]?\s?${MONEY}`,
  'i',
);
// A return asked -- an item, an order or a purchase returned, 반품하시겠습니까,
// 반품 신청, 返品しますか, 退货吗 -- lists what was paid beside the refund's
// total ("Return this item? Order total: $52.00, refund total: $49.00.",
// 반품하시겠습니까? 결제 금액: 52,000원, 환불 금액: 49,000원; see
// withoutRefundTotals) -- while an amount due still is one, and so is any
// other amount the message states. An exchange, or something new, a
// replacement or a different, another, other, larger, smaller or bigger size,
// colour, item, model or one bought, is no return: its totals may be paid
// ("Return this item and get a different size? Refund total: $49.00, order
// total: $59.00.").
const RETURN_ASKED_PATTERN =
  /\breturn\s(?:this|these|the|your|my|\d{1,3})\s(?:[a-z]{1,15}\s)?(?:items?|products?|orders?|purchases?)\b|반품(?:을|\s)?\s?(?:신청|접수)?(?:하시겠|할까|하실래)|返品(?:を申請|手続き)?(?:しますか|しましょうか|されますか)|退[货貨](?:吗|嗎)|确定退[货貨]|確定退[货貨]|申[请請]退[货貨]/i;
const EXCHANGED_PATTERN =
  /\bexchang(?:e|es|ed|ing)\b|\bnew\s(?:items?|models?|sizes?|products?|ones?)\b|\b(?:different|another|other|larger|smaller|bigger)\s(?:sizes?|colou?rs?|items?|models?|ones?)\b|\breplacements?\b|교환|交換|交换|换货|換貨/i;
const AMOUNT_MOVED_PATTERN = new RegExp(
  String.raw`${MONEY}${AMOUNT_TAIL}${RATE}?(?:\s{1,3}(?!${MONEY_BACK}\b)${SENTENCE_WORD}){0,3}?\s{1,3}(?:will\sbe|is\sbeing|gets?)\s(?:sent|paid|transferred|collected|taken|debited|withdrawn)\b(?!\s{1,3}(?:back|off)\b)`,
  'i',
);
// A refund, a credit, cashback or a rebate and the amount it names: the
// amount right after it, or after at most four words that only say which
// amount it is ("A refund for the full $49.00", "Your refund amount of
// $49.00", "Your store credit is $0.00", "A refund in the amount of $49.00",
// "Cashback: $5", "Your refund ($49.00)") -- not a refund denied ("No refunds:
// $49.00 will be sent to Acme") nor one beside an amount it does not name
// ("Refunds are not available; $49.00 will be paid now").
const MONEY_BACK_AMOUNT_PATTERN = new RegExp(
  String.raw`(?<!\b(?:no|non)[-\s])\b${MONEY_BACK}\b:?(?:\s{1,3}(?:of|for|the|a|an|your|my|this|full|total(?:ing|ling)?|amount(?:ing)?|sum|partial|is|was|will|be|worth|in|up|to|values?|valued|at)\b){0,4}\s{0,3}\(?\s?${MONEY}${AMOUNT_TAIL}`,
  'gi',
);
// An amount said before the money-back word that names it ("$5 credit", "$4.99
// prorated refund"), or one Korean, Japanese or Chinese says is refunded
// (환불 금액: 4,900원, 4,900円は返金されます, 退款¥49.00).
const MONEY_BACK_AFTER_AMOUNT_PATTERN = new RegExp(
  String.raw`${MONEY}${AMOUNT_TAIL}${RATE}?(?:\s{1,3}[a-z'’-]{1,15}){0,2}?\s{1,3}${MONEY_BACK}\b|(?:환불|返金|返還|退款|退回|退还|退還)[^.?!。？！\r\n\d]{0,10}?${MONEY}${AMOUNT_TAIL}|${MONEY}${AMOUNT_TAIL}[^.?!。？！\r\n\d]{0,6}?(?:환불|返金|返還|退款|退回|退还|退還)`,
  'gi',
);
// A payment already made, named in Korean, Japanese or Chinese by what was
// paid, and the amount it names given back further on in its sentence, with
// no other amount between: "결제하신 49,000원은 3일 이내에 환불됩니다",
// "支払った4,900円は返金されます", "已支付的¥49.00将原路退回" -- no new payment.
// One still to be made is named in other words (결제하신 후, "after you pay"),
// and one not given back may be a policy said before paying (결제한 금액
// 49,000원은 환불되지 않습니다, 返金できません, 不予退款).
const PAID_BACK_PATTERN = new RegExp(
  String.raw`(?:(?:결제|지불|납부)(?:하신|한|된|되신|하셨던|했던)|(?:お?支払|決済)(?:った|われた|い済みの?|済みの?)|お支払いいただいた|(?:已|已经|已經)(?:支付|付款|付|扣款|扣除)的?)\s?(?:(?:금액|金額|金额)\s?[은는이가はがの]?\s?)?${MONEY}${AMOUNT_TAIL}(?:(?!${MONEY})[^.?!。？！\r\n]){0,20}?(?<!不|无法|無法|不能|不予|不会|不會)(?:환불|返金|返還|払い戻|退款|退回|退还|退還)(?!\s?(?:되지|하지|불가|이\s?안|이\s?불가|은\s?불가|은\s?안|안\s?되|안\s?됩)|し?(?:され(?:ません|ない)|でき(?:ません|ない|かね)|(?:いたし|致し)かね|は(?:できません|不可)|不可))`,
  'gi',
);
// Where a clause ends inside a sentence: a comma (not one between digits), a
// semicolon, 、 or ，, a spaced dash ("…your Basic plan will be cancelled - Pro
// is $14.99/month after that"), or "and", "but", "while" or "whereas".
const CLAUSE_END_PATTERN = /(?<!\d),|,(?!\d)|[;，；、]|\s[-–—]\s|\s(?:and|but|while|whereas)\s/i;
// A payment denied in its clause ("you'll no longer pay $9.99/month", "won't be
// charged").
// The stopped plan's own price, told as ending now or as the price that stands
// ("Your Premium ($9.99/month) ends", "Your current plan: $9.99/month").
const STOPPED_NOW_PATTERN =
  /\b(?:current(?:ly)?\s{1,3}(?:price|plan|rate|subscription|membership)|ends|expires|stops|terminates|(?:is|are)\s{1,3}(?:being\s{1,3})?cancell?ed)\b/i;
// The plan as it stands until it changes, its price with it ("Premium
// ($9.99/month) stays active until then", "…is $9.99/month until then"), and a
// payment already made ("Your last payment was $9.99", "You paid $9.99 on
// February 3", "You've already been charged $9.99", "the $9.99 you paid",
// "after your final payment of $9.99"). An end or a date it stands until
// ("until the end", "until March 3", 3월 3일까지, 3月3日まで, 至3月3日) says so
// only beside words that keep or use the plan ("…stays active until March 3",
// 3월 3일까지 이용할 수 있습니다, 可使用至3月3日) -- "After that, Pro is
// $14.99/month until the end of your contract" prices Pro. A plan with its
// price in brackets told as the user's until a date ("Premium ($9.99/month)
// is yours until March 3", "…benefits ($9.99/month) last until March 3",
// 프리미엄(월 9,900원)은 3월 3일까지입니다, プレミアム（月額980円）は3月3日までです)
// stands too, where its sentence tells of nothing that goes on after it (then,
// a renewal, after that, 이후, 以降, 之后).
const STANDS_OR_PAID_PATTERN = new RegExp(
  String.raw`\b(?:stays?|remains?)\s{1,3}(?:active|available|on)\b|\buntil\s{1,3}then\b|\b(?:last|previous|prior|final)\s{1,3}(?:payment|charge|bill)\b|\b(?:was|were|paid|been\s{1,3}(?:charged|billed))\s{1,3}${MONEY}|${MONEY}${AMOUNT_TAIL}\s{1,3}(?:you|we)\s{1,3}(?:paid|were\s{1,3}charged)\b|\bif\s{1,3}you\s{1,3}(?:change\s{1,3}your\s{1,3}mind|come\s{1,3}back|return|re-?subscribe|re-?join)\b`,
  'i',
);
const STANDS_UNTIL_PATTERN =
  /\buntil\s{1,3}(?:the\s{1,3}end|[a-z]{3,9}\s{1,3}\d)|\d\s?[일日]\s?(?:까지|まで)|至\s?\d/i;
const PLAN_KEPT_PATTERN =
  /\b(?:stay(?:s|ing)?|remain(?:s|ing)?|active|keep(?:s|ing)?|kept|still|access|current(?:ly)?|continu(?:e|es|ed|ing)|use|using|available|subscribed|enjoy)\b|이용|사용|유지|利用|使用|継続|維持|继续|繼續|保留|享受|有效/i;
const PLAN_YOURS_UNTIL_PATTERN = new RegExp(
  String.raw`\)\s{1,3}(?:(?:is|are)\s{1,3}yours|lasts?)\s{1,3}until\b|\d\s?[일日]\s?(?:까지\s?(?:입니다|이에요|예요|에요)|まで(?:です|となります|になります))`,
  'i',
);
const GOES_ON_PATTERN =
  /\b(?:then|renews?|renewed|renewal|after\s{1,3}(?:that|which)|afterwards?|thereafter)\b|이후|갱신|以降|更新|之后|之後|然后|然後|续费|續費/i;
const NOT_PAID_PATTERN =
  /(?:\b(?:not|never|no\s(?:longer|more))|n['’]t)\s{1,3}(?:[a-z'’]{1,15}\s{1,3}){0,2}?(?:pay|be\s{1,3}(?:charged|billed))\b/i;
const MONEY_SPENT = String.raw`\bspend(?:ing)?\s(?:[a-z]{1,4}\s)?${MONEY}(?!${AMOUNT_TAIL}\s?more\b)`;
// Money paid told as under way, its amount at most three words on ("You are
// paying $49.00 to Acme Inc.", "You are buying 2 tickets for $49.00", "You are
// donating $25.00") -- not money paid to the user ("We're paying you $49.00"),
// nor a way to pay ("You are paying with Visa ending 4242"), a saving or a
// coupon given away ("You're giving away a $5 coupon").
const MONEY_PAYING = String.raw`\b(?:paying|buying|purchasing|donating|contributing|investing|tipping|transferring|wiring|giving(?!\saway\b))\s(?!(?:you|me|us)\b)(?:[^\s.?!]{1,20}\s){0,3}${MONEY}(?!${AMOUNT_TAIL}\s?(?:off|coupons?|vouchers?|discounts?)\b)`;
// A payment of an amount said to be given back or called off -- refunded,
// returned or reversed, or cancelled, voided or stopped, told as done to it
// right after the amount or after "be", "been", "is", "was", "gets" or the
// like at most five words on, an adverb between or not -- is no payment made
// ("Your payment of $49.00 will be refunded within 5 days", "…has been
// reversed", "…to Acme will be returned", "Payment of $49.00 refunded", "Your
// next payment of $9.99 on March 3 will be cancelled"), while one beside
// another thing called off pays ("Your payment of $49.00 for the cancelled
// booking is still due", "…for the returned item will be sent now"). No
// "and", "but", "or", "then", "plus", a negation, "cannot" or "unable" may
// come between, and before a call-off no "only", "unless" or "except" either:
// "Your payment of $49.00 cannot be cancelled", "…can only be cancelled within
// 24 hours" and "…is scheduled for today unless cancelled" pay, while "…will
// only be refunded once we receive it" and "…can only be refunded to the
// original card" are refunds. So "…will be processed and $5.00 returned" and
// "…will not be refunded" pay, and so does a refund only promised on a
// condition ("…is refunded if you cancel in 14 days", "…will be refunded in
// full if you cancel within 30 days", when, unless, should, in case,
// provided). One named as the last or the previous still is one: a failed
// payment is retried ("Your last payment of $49.00 failed. Try again?").
const RETURNED_ENDER = String.raw`(?:and|but|or|then|plus|not|never|no|non|cannot|unable)\b|[a-z]{1,12}n['’]t\b`;
const CALLED_OFF_ENDER = String.raw`(?:only|unless|except)\b|${RETURNED_ENDER}`;
const toldDoneTo = (ender: string) =>
  String.raw`(?:(?:\s{1,3}(?!${ender})[a-z0-9'’-]{1,15}){0,5}?\s{1,3}(?:be|been|being|is|are|was|were|gets?|got|getting)(?:\s{1,3}(?:fully|partially|automatically|immediately|instantly|successfully|already|then|also|now|just|soon))?)?`;
const GIVEN_BACK_AFTER = String.raw`(?!${AMOUNT_TAIL}(?:\s?(?:${CURRENCY}|[원円元]))?${RATE}?(?:${toldDoneTo(RETURNED_ENDER)}\s{1,3}(?:refunded|returned|reversed)|${toldDoneTo(CALLED_OFF_ENDER)}\s{1,3}(?:cancell?ed|voided|stopped))\b(?!\s{1,3}(?:in\s{1,3}full\s{1,3})?(?:if|when|unless|should|in\s{1,3}case|provided)\b))`;
const FINANCIAL_DIALOG_PATTERN = new RegExp(
  String.raw`((\bwill|['’]ll) be (charged|billed)\b|\bbe (charged|billed) (to|on)\b|\b(billed|charged) (annually|monthly|yearly|weekly|today|now)\b|proceed with (the |your |this )?payment|\b(payments?|transfers?|transactions?|charges?|purchases?)\s(will|would|is\sgoing\sto)\s((now|then|also)\s)?go\sthrough\b|payment of (${CURRENCY}\s?)?\d${GIVEN_BACK_AFTER}|\btaken (from|out of) (your|the|my)( [\w'’-]{1,30}){0,2} (account|card|bank|wallet|balance)|\bdebit(s|ed)?\s${MONEY}|\b(use|apply)\s((your|the|my)\s)?${MONEY}${AMOUNT_TAIL}\s((of|from|in)\s(your|the|my)\s)?([a-z'’-]{1,20}\s){0,2}(balance|credit|funds|wallet|gift\s?card)s?\b|\b(will\sbe|is\sbeing|gets?)\sused\s(to\spay\s)?for\s((this|the|your)\s)?${MONEY}${AMOUNT_TAIL}\s(order|purchase|payment|booking)s?\b|\b(${MONEY_SENT}|${MONEY_GIVEN})|(?<!\b(not|never)\s|n['’]t\s)\bcharge\s(it\s|this\s)?(to\s)?(your|my|the)\s([\w'’-]{1,20}\s){0,2}?(card|account|wallet|balance)s?\b|\bauthori[sz]e\s(this|the)\s(charge|transaction|purchase|payment)s?\b|(?<!\b(not|never)\s|n['’]t\s)\b(confirm|approve|authori[sz]e)\s((the|this|your|an?)\s)?${MONEY}${AMOUNT_TAIL}${RATE}?(\s(now|today))?(\s?([?？!]|\.(?!\d))|\s{0,3}$|\s(transactions?|transfers?|payments?|charges?|purchases?|orders?|withdrawals?|deposits?|bets?|wagers?)\b)|${MONEY_SPENT}|${MONEY_PAYING}|${DEDUCTED}.{0,40}\bamount\b|\bamount\b.{0,40}${DEDUCTED}|${DEDUCTED} from (your|the) (account|card|wallet|balance|bank)\b|청구됩니다|청구될|과금됩니다|과금될|부과됩니다|부과될|차감됩니다|請求されます|請求します|請求いたします|課金されます|課金します|引き落とされ|引き落とします|引き落とし[がを]|扣款|扣[费費]|收[费費]|收取|[将將]扣除)`,
  'is',
);
// A charge told as already made ("You've already been charged $9.99 for this
// month", "You were billed $49.00 on March 3"): its billing word bills
// nothing now.
const PAST_CHARGE_PATTERN =
  /\b(?:(?:have|has|had)|['’](?:ve|s|d))\s(?:already\s)?been\s(?:charged|billed)\b|\b(?:was|were)\s(?:already\s)?(?:charged|billed)\b/gi;
const VALUE_SET_PATTERN = new RegExp(
  String.raw`\b(?:change|set|update|adjust|raise|lower|increase|decrease|reduce)\b(?:\s{1,3}(?!${BILLED_THING})${SENTENCE_WORD}){0,3}?\s{1,3}(?:budget|limit|price|goal|target|threshold|cap)s?\s{1,3}to\s{1,3}${MONEY}${AMOUNT_TAIL}`,
  'gi',
);

// A billing word (a deduction included) beside an amount is found by one walk
// over both, left to right, each compared with the nearest of the other kind
// before it -- not a window tried at every one of them, which a page filling
// its dialog with 청구청구청구... would make many times dearer than reading it.
// A word that only describes is passed over when only the charging ones count.
const AMOUNT_REACH = 40;
const BILLING_WORD_PATTERN = new RegExp(
  String.raw`${ACTIVE_BILLING_WORD}|${DESCRIPTIVE_BILLING_WORD}|${DEDUCTED}`,
  'i',
);
const BILLING_TOKEN_PATTERN = new RegExp(
  String.raw`(${ACTIVE_BILLING_WORD}|${DEDUCTED})|(${DESCRIPTIVE_BILLING_WORD})|${MONEY}`,
  'gi',
);

function amountBesideBillingWord(message: string, chargingOnly: boolean): boolean {
  if (!BILLING_WORD_PATTERN.test(message)) {
    return false;
  }
  let lastWordEnd = -Infinity;
  let lastAmountEnd = -Infinity;
  for (const token of message.matchAll(BILLING_TOKEN_PATTERN)) {
    const start = token.index ?? 0;
    if (token[2] !== undefined && chargingOnly) {
      continue;
    }
    if (token[1] !== undefined || token[2] !== undefined) {
      if (start - lastAmountEnd <= AMOUNT_REACH) {
        return true;
      }
      lastWordEnd = start + token[0].length;
    } else {
      if (start - lastWordEnd <= AMOUNT_REACH) {
        return true;
      }
      lastAmountEnd = start + token[0].length;
    }
  }
  return false;
}

// A confirm that backs out of a bill says what will NOT be billed any more:
// "You will no longer be charged on the 1st", "You won't be charged on March
// 3", "You will no longer pay $9.99/month", 더 이상 청구되지 않습니다,
// 今後は請求されません, 不会再扣费 -- or that a charge or the billing will stop
// ("…and your $9.99 Premium charge stops"), whose clause ends at "and", "but",
// "while" or "whereas" too, since what follows may bill again ("Your monthly
// charges will end and a one-time fee of $25.00 is due now"), as does the
// clause of a payment no longer made ("You'll no longer pay $9.99/month for
// Basic, and Pro will cost $14.99/month starting today"). Any other negated
// clause ends at "and", "while" or "whereas" where a charge and an amount
// follow in its sentence ("You won't be charged $9.99/month for Basic, and
// your new Pro plan costs $14.99/month") -- not a charge already made ("…and
// your last charge of $9.99 was on March 3"). A clause taken out keeps the
// mark that ended it, so the sentence after it stays one of its own ("Your
// installment charges will end. Amount due today: $349.00."). A negated
// billing word is read two ways. Its phrase -- the negation, at most three
// words after it and the billing word ("won't be charged", "will not be
// renewed", 청구되지 않, 請求されません) -- is all that is taken out before the
// phrases above are read, so what the rest of the sentence commits still
// counts: "You won't be charged any extra fees when you pay $49.00 now", "You
// will not be charged twice, but $49.00 will be charged now". Its clause --
// from the negation to the end of the sentence, a line break, a semicolon, a
// colon, a dash (" - ", or – or — anywhere), 、 or ，, or to a "but",
// "instead", "however", "yet", "except", "other than", "apart from", "aside
// from", "besides", "only", "just", "plus" or "save for" -- is taken out
// before an amount is looked for beside a billing word, since the rate it
// names is what will not be billed: "You will no longer be charged
// $9.99/month" -- while what follows an "except", an "other than", an "apart
// from", an "aside from", a "besides", an "only", a "just", a "plus" or a
// "save for" is still charged, so the clause leaves a billing word for it:
// "You won't be charged anything except the $49.00 setup fee" bills the fee,
// and "You won't be charged now, only $49.00 at delivery" the $49.00 -- and so
// does a clause ended by a semicolon or a dash with an amount after it in its
// sentence, or by a "but" with an amount right after it ("You will not be
// charged for shipping; $49.00 for the item", "You won't be charged now, but
// $49.00 is due at delivery"; "You won't be charged; your trial is free" names
// none, and "…not be billed again, but your $9.99/month plan stays active" and
// "…but you can resubscribe for $9.99/month" charge nothing). An ASCII comma
// ends no clause, nor does the point in "$9.99", so "You won't be charged
// until your trial ends, then $9.99/month" is let through too. The words between a
// negation and its billing word are only those a negated bill is said with --
// be, been, being, get, gets, got, going, to, ever, again, still, yet, also,
// further, automatically, immediately, instantly, currently, actually ("You
// won't ever be charged twice", "You have not yet been charged", "You are not
// going to be charged $49.00", "You will not be immediately charged") -- so
// "No more than $50 will be charged" and "Don't forget you'll be charged
// $49.00 today" are no negation. Nothing charged is one too, but only its
// phrase is taken out, never its clause: "Nothing is charged now" pays
// nothing, "Nothing is charged today except the $49.00 setup fee", "Nothing
// will be billed now other than a $49.00 activation fee" and "Nothing is
// charged now, only $49.00 at delivery" bill.
const BILLING_STOPPED = String.raw`\b(?:charges?|billing)\s(?:will\s(?:now\s)?)?(?:stop|end|cease)s?\b`;
const NO_LONGER_PAID = String.raw`\bno\s(?:longer|more)\s{1,3}(?:have\s{1,3}to\s{1,3})?pay\b`;
const NEGATED_BILLING_WORD = String.raw`(?:${BILLING_STOPPED}|${NO_LONGER_PAID}|(?:\b(?:not|never|no\s(?:longer|more)|won['’]t|will\snot)\b|n['’]t\b)(?:\s{1,3}(?:be|been|being|get|gets|got|going|to|ever|again|still|yet|also|further|automatically|immediately|instantly|currently|actually)){0,3}?\s{1,3}(?:charged|billed|debited|deducted|renewed)\b|(?:청구|과금|부과|차감)되지\s?않|(?:請求|課金)されません|引き落とされません|不[会會]?再?(?:扣[费費]|扣款|收[费費]|收取|扣除))`;
const NEGATED_BILLING = String.raw`(?:${NEGATED_BILLING_WORD}|\bnothing\s(?:is|will\sbe|gets)\s(?:charged|billed)\b)`;
// A negated phrase takes the payment it names right after it with it ("You
// won't be charged your next payment of $9.99 on March 3") -- and gives it back
// with an until clause accepting answers ("You won't be charged your first
// payment of $49.00 until you click OK") -- and its "until"
// -- "Your card won't be charged
// until you place your order": the order it names is a later one -- to the
// next mark that ends a clause, an ASCII comma included, and the amount said
// between them ("won't be charged $49.00 until"). Unless what it waits for is
// this dialog's own answer ("until you click OK") or a commit with its amount
// ("until you complete your purchase of $49.00"): accepting does that, so the
// until clause stays to be read with the phrases, and the whole clause, its
// billing word with it, with the amounts ("You won't be billed until you
// click OK, which will charge $49.00 to your card", "You won't be charged
// $49.00 until you click OK").
const UNTIL_CLAUSE = String.raw`\s{1,3}until\b(?:[^.?!。？！\r\n;:；：，、–—,]|\.(?=\d))*`;
const NEGATED_AMOUNT = String.raw`\s{1,3}(?:the\s{1,3})?${MONEY}${AMOUNT_TAIL}`;
const NEGATED_OBJECT = String.raw`\s{1,3}(?:your|the)\s{1,3}(?:(?:next|first|final|monthly|annual|upcoming)\s{1,3})?(?:payment|charge|bill|fee|renewal)\s{1,3}of\s{1,3}${MONEY}${AMOUNT_TAIL}`;
const NEGATED_BILLING_PHRASE_PATTERN = new RegExp(
  String.raw`${NEGATED_BILLING}(?:(${NEGATED_OBJECT}|${NEGATED_AMOUNT})?(${UNTIL_CLAUSE})|${NEGATED_OBJECT})?`,
  'gi',
);
const LEADING_UNTIL_PATTERN = new RegExp(
  String.raw`^(?:${NEGATED_OBJECT}|${NEGATED_AMOUNT})?(${UNTIL_CLAUSE})`,
  'i',
);
const DIALOG_ANSWER_PATTERN =
  /\b(?:ok|okay)\b|\b(?:click|tap|press|select|choose|hit)(?:s|ing)?\s(?:on\s)?(?:the\s)?["“'‘]?(?:yes|accept|agree|confirm|continue|proceed)\b/i;
const MONEY_PATTERN = new RegExp(MONEY, 'i');
// A bare question that sends, in a message with an amount ("$500.00 to Jane
// Doe. Send?", "Send it?", "Send this now?", "Last payment: $49.00 to Jane
// Doe. Send again?") -- not one that sends an invoice, a reminder, a request,
// a bill, a quote, an estimate, a receipt or a statement. One that tries
// again, in a message with an amount that names money moving -- a payment, a
// transfer, a transaction, an order, a purchase, a charge, a donation, a card
// declined, funds missing, an authorization, a checkout, a renewal, a top-up,
// a tip or a booking ("Payment declined ($49.00). Retry?", "Your card was
// declined ($49.00). Try again?", "Insufficient funds for $49.00. Try
// again?") -- not a price alert, a budget or a message that failed
// ("Couldn't save your price alert for $199.99. Try again?"). And one that
// repeats a payment, an order, a transfer or a donation already made ("Repeat
// last payment: $49.00 to Acme Inc.?", "Previous payment: $49.00. Repeat
// it?", "Last order: $49.00. Reorder?", "Previous donation: $25.00. Give
// again?"), whose label is otherwise no payment asked for (NOT_PAST_PAYMENT)
// -- not a receipt, an invoice, a statement, a confirmation, an email, a copy,
// a reminder or a notification resent ("Last payment: $49.00 on March 3.
// Resend receipt?"), which is taken out before a repeat is looked for, so
// one said beside a repeat still repeats ("Repeat last payment: $49.00 to
// Acme Inc.? We will send a receipt to your email.").
const SEND_ASKED_PATTERN =
  /\bsend(?:\s(?:it|this|them|the\s(?:money|payment|transfer|amount)))?(?:\s(?:now|again))?\s?[?？]/i;
const RETRY_ASKED_PATTERN =
  /\b(?:retry|try\sagain)(?:\s(?:it|this|now|the\s(?:payment|transfer|transaction|purchase|order)))?(?:\snow)?\s?[?？]/i;
const MONEY_MOVING_WORD_PATTERN =
  /\b(?:payments?|transfers?|transactions?|orders?|purchases?|charges?|donations?|declined|insufficient\s{1,3}funds|authori[sz]ations?|checkouts?|renewals?|top-?ups?|tips?|bookings?)\b/i;
const REPEAT_ASKED_PATTERN =
  /\b(?:repeat|resend|re-send|reorder)\b|\b(?:pay|send|make|order|give)\s(?:it\s|this\s|that\s|the\spayment\s)?again\b/i;
const RESENT_PAPER_PATTERN =
  /\b(?:resend|re-send|send|repeat)\s(?:(?:the|a|this|your|my)\s)?(?:receipts?|invoices?|statements?|confirmations?|e-?mails?|cop(?:y|ies)|reminders?|notifications?)\b/gi;
const PAST_PAYMENT_LABEL_PATTERN = new RegExp(
  String.raw`\b(?:last|previous|prior|recent|latest|past)\s(?:payment|donation|contribution|purchase|tip|gift|transfer|deposit|withdrawal|pledge|order)(?:\s(?:amount|total|sum))?\s?[:：=]\s?${MONEY}`,
  'i',
);
const PAPER_SENT_PATTERN =
  /\b(?:invoices?|reminders?|requests?|bills?|quotes?|estimates?|receipts?|statements?)\b/i;
// A confirm names its own buttons, and its Cancel is the way back, not a stop
// the message asks for: "Cancel" after click, tap, press, select, choose or hit
// ("Press Cancel to go back", "(Choose Cancel to keep shopping.)", "Click the
// "Cancel" button"), "or Cancel" before "to" or "if" ("Press OK to continue
// or Cancel to go back"), "Cancel" before "to" and going back, returning,
// staying, keeping, editing, reviewing, changing and the like ("OK to
// confirm, Cancel to go back"), "Cancel returns you to the cart" (or takes,
// brings, sends, leads, keeps or leaves you), and "if you cancel" with nothing
// after it to cancel ("If you cancel, your cart is saved"). These words are
// taken out before anything else is read, with what they say the button does
// to the end of their clause -- which ends only where another answer is named
// (OK, Okay, Yes, a quoted "Continue", "Proceed" or "Confirm", another button
// pressed after "and", "or" or "then" -- "and click Pay" -- or selected, chosen
// or used after "or" -- "or select Pay Now", "or use Apple Pay" -- a commit or
// a key offered after "or" -- "or Continue to pay", "or Pay Now", "or Enter to
// pay" -- or a button named after "and" or "then", before "to" or after
// select, choose or use -- "and Confirm to pay", "and select Pay Now"), where
// "or", "or else" or "otherwise" tells what happens to money if the button is
// not pressed, up to five words on ("…go back or your card will be charged
// $49.00", "…or your card on file will automatically be charged $49.00", "…or
// you will pay $49.00 now", "…or we'll place your order", "…or $49.00 will be
// deducted", "…or $49.00 is charged to your card", "…or the $49.00 payment
// will go through", "…or your subscription will renew at $9.99/month", "…or
// we'll go ahead and charge $49.00"), or at a "but", whatever follows
// it being no part of what the button does ("…Cancel to go back but your card
// will still be charged $49.00") -- and the message is read
// as if they were not there: "Total: $49.00. Press OK to continue or Cancel to
// go back and remove items." pays, "Click OK to cancel your plan or Cancel to
// keep it ($9.99/month)." and "Press OK to cancel your subscription or Cancel
// to keep it and pay $9.99/month." stop the plan, "…click OK to place it, or
// click Cancel to cancel your order." places the order, and "Press Cancel to
// go back or OK to pay $49.00 now." pays. A Cancel named as a button at a
// sentence's end after another answer is one too ("Press OK to continue or
// Cancel.", "Click OK or Cancel.", "Do you want to proceed or cancel?") --
// while "Do you want to keep your plan or cancel?" asks about the plan. A
// cancel that names what it cancels still stops it: "Cancel Premium
// ($9.99/month)?", "Press OK to cancel the order or Cancel to keep it", "If
// you cancel your order, …" -- and so does one told with what the plan's stop
// brings ("If you cancel, you will lose your Premium benefits", below).
const QUOTE_OPEN = String.raw`["“'‘]?`;
const QUOTE_CLOSE = String.raw`["”'’]?`;
const CLAUSE_WORD = String.raw`(?:[^\s.,?!;:]|[.,](?=\d)){1,30}`;
const MOVE_ADVERB = String.raw`(?:automatically|immediately|then|now|also|still)`;
const MONEY_MOVED_VERB = String.raw`(?:charged|billed|debited|deducted|transferred|withdrawn|collected|placed|paid|sent|taken|processed|submitted|completed|renewed|charge|bill|debit|deduct|transfer|withdraw|collect|place|pay|send|process|submit|complete|renew|proceed|go\s{1,3}through|go\s{1,3}ahead\s{1,3}and\s{1,3}(?:charge|bill|place|pay|send|process))\b`;
const OR_ELSE_PAID = String.raw`\s(?:or(?:\s{1,3}else)?|otherwise),?\s{1,3}(?:(?:(?:${CLAUSE_WORD}\s{1,3}){0,5}?(?:will|would|gets?|is\s{1,3}going\s{1,3}to)|(?:${CLAUSE_WORD}\s{1,3}){0,4}?[a-z]{1,10}['’]ll)\s{1,3}(?:${MOVE_ADVERB}\s{1,3})?(?:be\s{1,3})?(?:${MOVE_ADVERB}\s{1,3})?${MONEY_MOVED_VERB}|(?:${CLAUSE_WORD}\s{1,3}){0,5}?(?:(?:is|are)\s{1,3}(?:${MOVE_ADVERB}\s{1,3})?(?:charged|billed|debited|deducted|taken|withdrawn|paid|sent|transferred|collected|placed|processed|renewed)|go(?:es)?\s{1,3}through)\b|(?:you|we|they|it)\s{1,3}(?:${MOVE_ADVERB}\s{1,3})?(?:charge|bill|debit|place|pay|send|process)\b)`;
const OTHER_ANSWER = String.raw`\sbut\b|\b(?:ok|okay|yes)\b|["“'‘](?:continue|proceed|confirm)\b|\s(?:or|and|then)\s(?:click|tap|press|hit)\b|\sor\s(?:select|choose|use|enter|continue|proceed|confirm|pay|buy|purchase|submit|place|check\s?out|subscribe|upgrade|donate)\b|\s(?:and|then)\s(?:(?:select|choose|use)\s["“'‘]?(?:pay|buy|purchase|place\s(?:order|it)|check\s?out|submit|confirm|continue|proceed|accept|agree|ok|okay|yes)\b|["“'‘]?(?:continue|proceed|confirm|accept|agree|submit|pay|buy|purchase|check\s?out)["”'’]?\s(?:to|if)\b)|${OR_ELSE_PAID}`;
const BUTTON_CLAUSE = String.raw`(?:(?!${OTHER_ANSWER})(?:[^.?!。？！\r\n;:；：，、,–—(]|\.(?=\d)))*`;
const ANSWER_BEFORE = String.raw`(?<=\b(?:ok|okay|yes|proceed|continue|confirm|pay|submit)\b(?:\s[a-z'’]{1,15}){0,2}\s{1,3})`;
const CANCEL_BUTTON_PATTERN = new RegExp(
  String.raw`\b(?:click|tap|press|select|choose|hit)(?:s|ing)?\s(?:on\s)?(?:the\s)?${QUOTE_OPEN}cancel\b${QUOTE_CLOSE}(?:\s{1,3}(?:button\s{1,3})?(?:to|if)\b${BUTTON_CLAUSE})?|\bor\s${QUOTE_OPEN}cancel\b${QUOTE_CLOSE}(?=\s{1,3}(?:to|if)\b)${BUTTON_CLAUSE}|${ANSWER_BEFORE}or\s${QUOTE_OPEN}cancel\b${QUOTE_CLOSE}(?=\s{0,3}(?:[.?!。？！)]|$))|\bcancel\b${QUOTE_CLOSE}(?=\s{1,3}to\s{1,3}(?:go|return|stay|keep|edit|review|change|exit|abort|close|continue|come|leave|modify|update|remain|dismiss|undo|back|correct|fix|adjust|make|start|try|choose|select|pick|add|see|view|check|discard)\b|\s{1,3}(?:will\s{1,3})?(?:returns?|takes?|brings?|sends?|leads?|keeps?|leaves?)\s{1,3}(?:you|me)\b)${BUTTON_CLAUSE}|\bif\syou\s(?:(?:choose|decide|want|wish|prefer)\sto\s)?cancel\b(?:\snow\b)?(?=\s?[,.;:!?—–)]|\s-\s|\s{0,3}$)(?!,?\s{1,3}you(?:['’]ll|\swill)\s(?:(?:also|still)\s)?(?:lose|keep|no\slonger|not|get|receive|be\srefunded)\b)`,
  'gi',
);
// A confirm in Korean, Japanese or Chinese names its own Cancel button too,
// with what it does in the same clause: the clause that names it is taken
// out, as the English button's words are ("合計：4,900円。よろしければ「OK」を、
// 戻る場合は「キャンセル」を押してください。", "계속하려면 확인을, 돌아가려면
// 취소를 누르세요", "确认请点“确定”，返回请点“取消”", "다른 요금제로
// 바꾸시려면 취소를 누르세요"). A clause starts after a mark that ends one --
// a comma or a point only where no digit stands before it, since 49,000원 and
// ¥49.00 hold them -- and the words taken out stop where they could be what
// another answer does: at that answer (확인, OK, はい, 確定, 确定, 確認, 确认), at
// a digit (an amount), after the button's words at another button named in
// quotes ('예', 「続ける」, “继续”, “好”) or at "otherwise" (否则, 그렇지 않으면,
// 아니면, さもないと: "点击取消返回否则将完成支付" pays), and before the
// button's words at a word that pays
// (결제, 購入, 支付 …) unless the stop names it as what it stops (결제를
// 취소하시려면 취소 버튼을 눌러 주세요) or it names a page or a list to go back
// to (결제 페이지, 구매 목록, お支払い画面, 支付页面: a place is no commit) -- so
// "확인 버튼을 누르면 49,000원이 결제되며 취소 버튼을 누르면 결제가 취소됩니다"
// and "4,900円をお支払いいただきます キャンセルを押すと戻ります" keep what they
// pay. After the button's words a date is no amount ("キャンセルを押すと次回
// 3月3日に…", "点击取消将保留订阅并在3月3日…"). A press told as not made names no
// Cancel button's work at all: "취소를 누르지 않으면 결제가 진행됩니다",
// "「キャンセル」を押さないと980円が請求されます" and "不点击取消将完成支付" say
// what happens if it is not pressed. Where the clause cannot be told apart,
// its words are kept. Each piece of the words before the button is read one
// way only -- what a stop stops, a pay word naming a page, or one character
// -- so a long message costs no more than reading it once.
const CJK_OK_ANSWER = String.raw`(?:확인|오케이|\b[Oo][Kk]\b|ＯＫ|はい|確定|确定|確認|确认)`;
const CJK_COMMIT_WORD = String.raw`(?:결제|구매|주문|지불|송금|이체|충전|청구|과금|支払|購入|注文|決済|請求|課金|送金|振込|支付|购买|購買|付款|扣|充值|下单|下單|结算|結算)`;
const CJK_PAGE_WORD = String.raw`(?:화면|페이지|창|목록|画面|ページ|页面|頁面|界面)`;
const CJK_CANCEL_BEFORE = String.raw`(?:(?=(?<piece>${CJK_STOPPED_THING}|${CJK_COMMIT_WORD}(?=い?\s?${CJK_PAGE_WORD})|(?!${CJK_OK_ANSWER}|\d|${CJK_COMMIT_WORD})[^。．？！?!\r\n、，,；;.]))\k<piece>)`;
const CJK_OTHER_ANSWER = String.raw`(?:否则|否則|그렇지\s?않으면|아니면|さもないと|さもなければ|そうでなければ|["“'‘「『](?:예|네|계속|진행|다음|続ける|続行|進む|次へ|继续|繼續|好|是)["”'’」』])`;
const CJK_CANCEL_AFTER = String.raw`(?:\d{1,4}\s?[年月日년월일号號]|(?!${CJK_OK_ANSWER}|${CJK_OTHER_ANSWER}|\d)[^。．？！?!\r\n、，,；;.])`;
const CJK_CANCEL_BUTTON_PATTERN = new RegExp(
  String.raw`(?<=^|[。．？！?!\r\n、，；;]\s{0,3}|(?<!\d)[,.]\s{0,3})${CJK_CANCEL_BEFORE}{0,60}?(?:["“'‘「『]?キャンセル["”'’」』]?(?:\s?ボタン)?\s?を\s?(?:押(?!さ[なずぬ])|(?:クリック|タップ|選択)(?!し[なず]|せず)|お?選び)|(?:戻る|やめる|中止する)場合は\s?["“「『]?キャンセル|["“'‘「]?취소["”'’」]?(?:\s?버튼)?\s?[을를]?\s?(?:누르|눌러|클릭|선택|탭)(?!(?:시|하|하시)?지\s?(?:않|마))|돌아가(?:시)?려면\s?취소|(?<!(?:[不没沒未别別勿]|没有|沒有)\s?)(?:点(?:击)?|點(?:擊)?|按|选择|選擇)\s?["“「]?取消|返回请点(?:击)?\s?["“「]?取消)${CJK_CANCEL_AFTER}{0,40}`,
  'g',
);
// Where a sentence ends: a mark that ends one (not the point in "$9.99"), or
// a line break.
const SENTENCE_END_PATTERN = /(?<=[.?!。？！])(?!\d)|\r?\n/;
const QUESTION_END_PATTERN = /[?？]\s*$/;
// An amount moved, in a sentence, that no refund, credit, cashback or rebate
// names as its own.
function amountMoved(text: string): boolean {
  return text
    .split(SENTENCE_END_PATTERN)
    .some((sentence) =>
      AMOUNT_MOVED_PATTERN.test(sentence.replace(MONEY_BACK_AMOUNT_PATTERN, ' ')),
    );
}
// The phrases that commit money in a confirm's words.
function dialogCommits(text: string): boolean {
  return (
    FINANCIAL_COMMIT_PATTERN.test(text) || FINANCIAL_DIALOG_PATTERN.test(text) || amountMoved(text)
  );
}
// A pause priced: the pause beside its rate, or in a sentence that names an
// amount and a fee, a charge or a cost.
function pausedPrice(message: string): boolean {
  return (
    PAUSED_PRICE_PATTERN.test(message) ||
    message
      .split(SENTENCE_END_PATTERN)
      .some(
        (sentence) =>
          PAUSED_PATTERN.test(sentence) &&
          MONEY_PATTERN.test(sentence) &&
          PAUSE_FEE_PATTERN.test(sentence),
      )
  );
}
function untilIsAccepted(until: string): boolean {
  return (
    DIALOG_ANSWER_PATTERN.test(until) ||
    (MONEY_PATTERN.test(until) && (dialogCommits(until) || AMOUNT_DIALOG_PATTERN.test(until)))
  );
}
// The words after which a negated clause names what is still charged, the
// marks that end one before an amount in its sentence ("You will not be
// charged for shipping; $49.00 for the item"), and a "but" right before an
// amount or before the words that say which amount is still due ("…but $49.00
// is due at delivery", "…but only $49.00", "…but the remaining $49.00") --
// read past the space a told stop's clause or a payment no longer made leaves
// before its "but" ("You'll no longer pay $9.99/month, but $49.00 is due
// today", "Your monthly charges will stop, but $49.00 is due today").
const STILL_CHARGED = String.raw`(?:except|other\sthan|apart\sfrom|aside\sfrom|besides|only|just|plus|save\sfor)\b`;
const AMOUNT_AHEAD = String.raw`(?:[^.?!。？！\r\n]|\.(?=\d)){0,60}?${MONEY}`;
const MARK_BEFORE_AMOUNT = String.raw`(?:(?:[;；，、–—]|-(?=\s))${AMOUNT_AHEAD}|but\b(?:\s{1,3}(?:the|a|an|only|just))?(?:\s{1,3}(?:your\s{1,3})?(?:remaining|full|final|total|additional|extra|outstanding))?\s{1,3}${MONEY})`;
// The clause of a told stop or of a payment no longer made, to the end of its
// sentence or of its part, or to "and", "but", "while", "whereas", "instead",
// "however", "yet" or a word after which a charge stays.
const STOP_CLAUSE = String.raw`((?:(?!\s(?:and|but|while|whereas)\s|\b(?:instead|however|yet)\b|${STILL_CHARGED})(?:[^.?!。？！\r\n;:；：，、–—-]|\.(?=\d)|(?<!\s)-|(?<=\s)-(?!\s)))*[.?!。？！]?)`;
// A charge and an amount ahead in the sentence, in either order -- not a
// charge told as one already made ("your last charge of $9.99", "your final
// bill", "$9.99 was charged", "you were billed").
const AHEAD_CHAR = String.raw`(?:[^.?!。？！\r\n]|\.(?=\d))`;
const CHARGING_WORD = String.raw`(?<!\b(?:last|previous|prior|final|past|already|been|was|were)\s{1,3}(?:[a-z]{1,12}\s{1,3})?)(?:${ACTIVE_BILLING_WORD}|${DEDUCTED})`;
const CHARGED_AHEAD = String.raw`${AHEAD_CHAR}{0,60}?(?:${CHARGING_WORD}${AHEAD_CHAR}{0,40}?${MONEY}|${MONEY}${AHEAD_CHAR}{0,40}?${CHARGING_WORD})`;
// A charge told as going away by the clause after that "and", which starts
// with it -- a charge, a fee, a bill, a payment, an authorization, a hold, a
// cost or a deposit, a few words of its own before it and after it ("of
// $9.99", "you paid", "on your card"), none of them a negation (not, never,
// cannot, no, nor or a word ending in n't), reversed, refunded, cancelled,
// voided, removed, released, waived, dropped, stopping, ending, dropping off
// or disappearing, or not applying, starting, happening or renewing -- is
// taken out with the clause before it, to the word that tells it gone, where
// nothing follows that word in its sentence but a time span ("within 3 days",
// "in 5-7 business days", "within 3 to 5 business days", "within a few days",
// "within the next two weeks", "within a week", "in an hour"), where the
// money goes back to or comes off -- to, on, from, into or back to your or the
// card, account, statement, bill, wallet, balance, credit, payment method,
// method of payment, form of payment, Visa, Mastercard, Amex, American
// Express or Discover, with at most two words before that noun, none of them
// a condition or a negation, and only "on file" or "ending" (in or with) and
// its digits, masked or not, after it ("to your original payment method", "to
// your bank account", "to your Apple ID balance", "to your card ending in
// 4242", "to your Visa ending in ****4242", "on your next statement"), and
// right after dropping or falling off, "your statement" alone -- or an adverb
// (automatically, immediately, instantly, today, now, right away, shortly,
// soon, in full, as well, too), before the sentence ends (a point before a
// digit ends none: "…to your card ending in 42.00 if you keep it"): "…and the
// $49.00 charge will be reversed within 3 days", "…and your upcoming charge
// of $9.99 has been cancelled", "…and the $99.00 annual fee will not apply",
// "…and the pending $49.00 charge will drop off your statement". Anything
// else after that word keeps the charge -- a condition ("…will be waived upon
// return of your device", "…won't apply if you return your device within 30
// days", "…refunded to your account once returned"), a date ("…will not start
// until March 3"), someone or something not listed ("…refunded to the
// customer who returns it", "…to the card you provided") or another clause
// ("…will be reversed and you'll get an email") -- and so does a negation
// among its words ("…and the early termination fee of $199.00 will not be
// waived", "…cannot be refunded", "…can't be waived"); a charge that resumes
// or applies is none ("…and your $9.99/month fee resumes on April 1"); and
// where another amount follows in its sentence, the charge is read as before.
const CLAUSE_TOKEN = String.raw`(?:[\w$€£¥₩,/'’-]|\.(?=\d)){1,20}`;
const KEPT_TOKEN = String.raw`(?!(?:not|never|cannot|no|nor)\b|[a-z]{1,12}n['’]t\b)${CLAUSE_TOKEN}`;
const SPAN_NUMBER = String.raw`(?:\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten)`;
const GOES_AWAY_TAIL = String.raw`(?:(?:within|in)\s{1,3}(?:the\s{1,3}next\s{1,3})?(?:a\s{1,3}(?:few|couple\s{1,3}of)|an?|few|couple\s{1,3}of|${SPAN_NUMBER}(?:\s?[-–]\s?${SPAN_NUMBER}|\s{1,3}to\s{1,3}${SPAN_NUMBER})?)\s{1,3}(?:(?:business|working)\s{1,3})?(?:days?|hours?|weeks?)|(?:to|on|from|into|back\s{1,3}to)\s{1,3}(?:your|the)\s{1,3}(?:(?!(?:if|unless|provided|once|when|after|until|subject|not|never|no|nor)\b)[\w'’-]{1,20}\s{1,3}){0,2}?(?:card|account|statement|bill|wallet|balance|credit|payment\s{1,3}method|method\s{1,3}of\s{1,3}payment|form\s{1,3}of\s{1,3}payment|visa|master\s?card|amex|american\s{1,3}express|discover)(?:\s{1,3}on\s{1,3}file|\s{1,3}ending(?:\s{1,3}(?:in|with))?\s{1,3}(?:[•*·xX]{1,12}\s?)?\d{2,4})?|automatically|immediately|instantly|today|now|right\s{1,3}away|shortly|soon|in\s{1,3}full|as\s{1,3}well|too)`;
const OFF_WHAT = String.raw`(?:\s{1,3}(?:your|the)\s{1,3}(?:statement|card|account|bill))?`;
const GOES_AWAY_END = String.raw`(?=(?:\s{1,3}${GOES_AWAY_TAIL}){0,4}\s*(?:\.(?!\d)|[!?。？！]|$))`;
const CHARGE_GOES_AWAY = String.raw`(?:the|your|any|this|that|these|those|its|our|a|an)\s{1,3}(?:${KEPT_TOKEN}\s{1,3}){0,3}?(?:charges?|fees?|bills?|payments?|authori[sz]ations?|holds?|costs?|deposits?)\b(?:\s{1,3}(?:of|on|for|from|to|you|we|that|which)\b(?:\s{1,3}${KEPT_TOKEN}){1,5}?)?\s{1,3}(?:(?:(?:will|would|has|have|had|is|are|was|were|be|been|being|now|then|also|already|automatically|immediately|fully|just|soon|instantly)\s{1,3}){0,4}(?:reversed|refunded|cancell?ed|voided|removed|released|waived|dropped|stops|ends|disappears?|drops?\s{1,3}off${OFF_WHAT}|falls?\s{1,3}off${OFF_WHAT})\b|(?:(?:will|would|is|are|does|do)\s{1,3})?(?:not|never)\s{1,3}(?:apply|start|happen|renew)\b|won['’]t\s{1,3}(?:apply|start|happen|renew)\b|never\s{1,3}starts\b)${GOES_AWAY_END}`;
const GOES_AWAY_AFTER = String.raw`(?:\s(?:and|while|whereas)\s${CHARGE_GOES_AWAY}(?!(?:[^.?!。？！\r\n]|\.(?=\d)){0,200}?${MONEY}))?`;
const NEGATED_BILLING_CLAUSE_PATTERN = new RegExp(
  String.raw`(?:${BILLING_STOPPED}${STOP_CLAUSE}${GOES_AWAY_AFTER}|${NO_LONGER_PAID}${STOP_CLAUSE}${GOES_AWAY_AFTER}|${NEGATED_BILLING_WORD}((?:(?!\b(?:(?:but|instead|however|yet)\b|${STILL_CHARGED})|\s(?:and|while|whereas)\s(?=${CHARGED_AHEAD}))(?:[^.?!。？！\r\n;:；：，、–—-]|\.(?=\d)|(?<!\s)-|(?<=\s)-(?!\s)))*[.?!。？！]?)${GOES_AWAY_AFTER})(?:(?=(?:(?<![.?!。？！])\s{1,3})?(?:${STILL_CHARGED}|${MARK_BEFORE_AMOUNT}))()|)`,
  'gi',
);
// The mark a clause taken out ended with.
const MARK_AT_END_PATTERN = /[.?!。？！]$/;

// A CAPTCHA rarely says its name. Cloudflare asks to "Verify you are human" in
// a "security challenge", hCaptcha's box says "I am human", a slider says
// "Slide to verify" or 向右滑动完成验证, and 캡차, 画像認証 and 人機驗證 are what
// Korean, Japanese and Chinese call one (Chinese in either script). "Verify
// your email", "Human resources", "Slide to unlock" and a volume slider
// (音量滑块) only share a word with them.
// A click or slider check says so too: "Click to verify", 点击按钮进行验证,
// 确认您是真人, 按住滑块, 拖动下方滑块完成拼图, 人机身份验证 -- while "Click to
// verify your email" verifies an address, "Update security challenge
// questions" is an account setting, and 拖动滑块调整价格 (drag to set a price)
// checks nothing.
const CAPTCHA_PATTERN =
  /(captcha|recaptcha|hcaptcha|i'?m not a robot|not a robot|(verify(ing)?|confirm) (that )?you( are|['’]re) (a )?human|\bare you (a )?(human|robot)\b|\bi( am|['’]?m) (a )?human\b|human[-_ ]?verification|security[-_ ]?challenge(?![-_ ]?questions?\b)|slide (right |left )?to (verify|complete the puzzle)|\bclick to verify\b(?!\s(your|my|the|this|an?)\b)|로봇이 아닙니다|자동 ?입력 ?방지|보안 ?문자|캡[차챠]|사람인지 ?확인|ロボットではありません|画像認証|人間であることを確認|キャプチャ認証|人机验证|人機驗證|人机身份验证|人機身份驗證|完成(安全)?(验证|驗證)|滑(块|动)验证|滑(塊|動)驗證|拼图验证|拼圖驗證|拖[动動].{0,4}滑[块塊].{0,8}(验证|驗證|拼图|拼圖)|按住滑[块塊]|点击(按钮)?(进行|开始)验证|點擊(按鈕)?(進行|開始)驗證|[确確][认認][您你]是真人)/i;

// A field's facts, lowercased: its own (everything the executor read on it),
// then its group's -- where a label that carried its fieldset's words had
// them -- unless only its own are asked for.
function fieldFacts(field: AoiBrowserDriveActionField, ownOnly = false): string[] {
  return [
    field.name,
    field.id,
    field.autocomplete,
    field.ariaLabel,
    field.placeholder,
    field.title,
    field.label,
    ownOnly ? undefined : field.group,
  ]
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.toLowerCase());
}

// A field's facts read as one text of words.
function fieldHaystack(field: AoiBrowserDriveActionField | undefined, ownOnly = false): string {
  return field ? fieldFacts(field, ownOnly).join(' ') : '';
}

// A bare PIN cue that is India's postal PIN code, not a secret: the words say
// postal, or say "PIN code" among an address and name nothing a PIN unlocks.
function isPostalPin(words: string, near: string): boolean {
  return (
    POSTAL_PATTERN.test(words) ||
    (PIN_CODE_PATTERN.test(words) &&
      NEAR_ADDRESS_PATTERN.test(near) &&
      !SECRET_PIN_CUE_PATTERN.test(words))
  );
}

// An identity document the words ask for: one named anywhere but where a
// name, and no number, is written as it is on it.
function asksForIdDocument(words: string): boolean {
  if (!ID_DOCUMENT_PATTERN.test(words)) {
    return false;
  }
  const nameAsWritten =
    NAME_CUE_PATTERN.test(words) &&
    WRITTEN_ON_ID_DOCUMENT_PATTERN.test(words) &&
    !NUMBER_CUE_PATTERN.test(words) &&
    !ID_DOCUMENT_PATTERN.test(words.replace(ID_DOCUMENT_AS_WRITTEN_PATTERN, ' '));
  return !nameAsWritten;
}

// A one-time code two-step verification asks for, the step named in the
// field's words or its group's: a fact of the field's own that asks for a code
// (a dialling prefix apart), and -- unless one of its own facts names a phone
// number or an email address, or is shaped like a phone number -- a field with
// no words of its own, a code its own words name, or the step or a number its
// own words name with no phone or method.
function phoneShaped(fact: string): boolean {
  return (
    PHONE_SHAPED_PATTERN.test(fact) &&
    (fact.trimStart().startsWith('+') || fact.replace(/\D/g, '').length >= 10)
  );
}

function namesPhone(fact: string): boolean {
  return PHONE_HEAD_PATTERN.test(fact) || phoneShaped(fact);
}

function asksForCode(fact: string): boolean {
  return (
    !namesPhone(fact) &&
    (CODE_HEAD_PATTERN.test(fact.replace(DIALLING_CODE_PATTERN, ' ')) ||
      CODE_SHAPED_PATTERN.test(fact))
  );
}

function asksForTwoStepCode(words: string, ownWords: string, ownFacts: string[]): boolean {
  if (!TWO_STEP_PATTERN.test(words)) {
    return false;
  }
  if (ownFacts.some(asksForCode)) {
    return true;
  }
  if (ownFacts.some(namesPhone)) {
    return false;
  }
  const own = ownWords.replace(DIALLING_CODE_PATTERN, ' ');
  return (
    !OWN_WORD_PATTERN.test(ownWords.replace(BOX_NAME_PATTERN, ' ')) ||
    TWO_STEP_CODE_NAMED_PATTERN.test(own) ||
    (!TWO_STEP_ASIDE_PATTERN.test(own) &&
      (TWO_STEP_PATTERN.test(own) || TWO_STEP_CODE_PATTERN.test(own)))
  );
}

// Whether words name a secret -- a field's facts, or what a prompt() asks for,
// read the same way so neither route is the looser one. `near` is what sits
// around a field (a prompt has none); it decides only an expiry and a PIN.
// `ownWords` are a field's words without its group's (a prompt's words are
// all its own): another thing that expires, and the code, phone or method a
// field under two-step verification names, are looked for in them alone.
// `facts` are the texts the words were joined from, each read alone for a SIN
// or a bare PAN.
function namesSecret(
  words: string,
  near = '',
  ownWords = words,
  facts = [words],
  ownFacts = facts,
): boolean {
  return (
    SENSITIVE_FIELD_PATTERN.test(words) ||
    facts.some((fact) => SIN_PATTERN.test(fact) || PAN_FACT_PATTERN.test(fact)) ||
    SHORT_DIGIT_CODE_PATTERN.test(words) ||
    (LONG_DIGIT_CODE_PATTERN.test(words) && !REDEEMED_CODE_PATTERN.test(words)) ||
    asksForTwoStepCode(words, ownWords, ownFacts) ||
    asksForIdDocument(words) ||
    (PIN_PATTERN.test(words) && !isPostalPin(words, near)) ||
    (CARD_EXPIRY_PATTERN.test(words) &&
      (CARD_CUE_PATTERN.test(words) ||
        (NEAR_CARD_PATTERN.test(near) &&
          (PAYMENT_CUE_PATTERN.test(words) || !OTHER_EXPIRY_PATTERN.test(ownWords)))))
  );
}

function isSensitiveField(field: AoiBrowserDriveActionField | undefined): boolean {
  if (!field) {
    return false;
  }
  if (typeof field.type === 'string' && field.type.trim().toLowerCase() === 'password') {
    return true;
  }
  const autocomplete =
    typeof field.autocomplete === 'string' ? field.autocomplete.trim().toLowerCase() : '';
  if (autocomplete && SENSITIVE_AUTOCOMPLETE.has(autocomplete)) {
    return true;
  }
  if (
    [field.name, field.id].some((v) => typeof v === 'string' && CAMEL_ID_NUMBER_PATTERN.test(v)) ||
    [field.ariaLabel, field.placeholder, field.title, field.label, field.group].some(
      (v) => typeof v === 'string' && PAN_CAPITALS_PATTERN.test(v),
    )
  ) {
    return true;
  }
  return namesSecret(
    fieldHaystack(field),
    typeof field.near === 'string' ? field.near : '',
    fieldHaystack(field, true),
    fieldFacts(field),
    fieldFacts(field, true),
  );
}

// The text a confirm states its totals in, each refund's total taken out with
// its amount ("주문이 취소되었습니다. 환불 합계는 49,000원입니다.", "Refund
// total: $49.00", "Order total: $49.00 will be refunded to your card") -- a
// refund pays nothing -- and what its sentence says beside it kept ("Refund
// total: $10.00, amount due today: $39.00", "환불 금액 39,000원, 추가 결제 금액
// 10,000원", "返金金額：1,000円、お支払い金額：4,900円", "Refund total $10.00 /
// Payment amount $39.00"). In a return that is asked (RETURN_ASKED_PATTERN, no
// exchange), what was paid stated beside the refund's total in its sentence
// goes too ("Order total: $52.00", "Item total: $52.00", 결제 금액: 52,000원,
// お支払い金額：5,200円, 实付金额：¥52.00) -- it is the payment the refund gives
// back -- where no other amount is left in the sentence. The rest is kept as
// written, its marks with it ("Total: Rs. 499.").
const SENTENCE_MARK_PATTERN = /([.?!。？！](?!\d)|\r?\n)/;
const AMOUNT_NAMED = String.raw`\s?[:：=은는이가はが为為是]?\s?(?:(?:is|of|was|will\sbe)\s|총\s?)?${MONEY}${AMOUNT_TAIL}`;
const REFUND_TOTAL_SPAN_PATTERN = new RegExp(
  String.raw`(?:${REFUND_TOTAL})(?:${AMOUNT_NAMED})?`,
  'gi',
);
const PAID_TOTAL_SPAN_PATTERN = new RegExp(
  String.raw`(?<!\bnew\s{1,3}(?:[a-z]{1,10}\s{1,3})?)(?:\b(?:(?:(?:order|item|items|original|purchase)\s{1,3})?total(?:\s{1,3}paid)?|amount\s{1,3}paid)|(?:총\s?)?결제\s?금액|お?支払い?金額|[实實]付金[额額]|支付金[额額]|付款金[额額])${AMOUNT_NAMED}`,
  'gi',
);
function withoutRefundTotals(text: string, returned: boolean): string {
  const parts = text.split(SENTENCE_MARK_PATTERN);
  let kept = '';
  for (let at = 0; at < parts.length; at += 2) {
    const sentence = parts[at] + (parts[at + 1] ?? '');
    if (!REFUND_TOTAL_PATTERN.test(sentence)) {
      kept += sentence;
      continue;
    }
    const rest = sentence.replace(REFUND_TOTAL_SPAN_PATTERN, ' ');
    const unpaid = returned ? rest.replace(PAID_TOTAL_SPAN_PATTERN, ' ') : rest;
    kept += MONEY_PATTERN.test(unpaid) ? rest : unpaid;
  }
  return kept;
}

// Whether a stop is told as what will happen ("…will be cancelled") or named
// with the billed thing it stops ("Cancel your plan").
function toldOrNamedStop(text: string): boolean {
  return (
    TOLD_STOP_PATTERN.test(text) ||
    (STOP_NAMED_PATTERN.test(text) && STOPPING_ACTION_PATTERN.test(text))
  );
}

// A price said after a start: an amount above nothing, not one given back (a
// refund, a credit -- "…and get a prorated refund of $4.99", "…and keep your
// $5 credit"), in a clause that stops nothing, prices no plan that ends or
// stands as it is until then, tells of no payment already made, and pays
// nothing less ("…and your Premium plan ($9.99/month) will be cancelled",
// "Your Premium ($9.99/month) ends", "Premium ($9.99/month) stays active until
// then", "Your last payment was $9.99", "…and you'll no longer pay
// $9.99/month").
function pricesStart(text: string): boolean {
  const goesOn = GOES_ON_PATTERN.test(text);
  return text
    .replace(ZERO_AMOUNT_PATTERN, ' ')
    .replace(MONEY_BACK_AMOUNT_PATTERN, ' ')
    .replace(MONEY_BACK_AFTER_AMOUNT_PATTERN, ' ')
    .split(CLAUSE_END_PATTERN)
    .some(
      (clause) =>
        MONEY_PATTERN.test(clause) &&
        !toldOrNamedStop(clause) &&
        !STOPPED_NOW_PATTERN.test(clause) &&
        !STANDS_OR_PAID_PATTERN.test(clause) &&
        !(STANDS_UNTIL_PATTERN.test(clause) && PLAN_KEPT_PATTERN.test(clause)) &&
        !(!goesOn && PLAN_YOURS_UNTIL_PATTERN.test(clause)) &&
        !NOT_PAID_PATTERN.test(clause),
    );
}

// A plan said to be free that is started (FREE_START_PATTERN), or a move onto
// one in Korean, Japanese or Chinese (CJK_FREE_MOVE_PATTERN), priced after it
// -- in the rest of its sentence or in a later one: "Cancel your Basic plan?
// Free Premium will start today. After 30 days, $14.99/month.", 1개월 무료 프로
// 요금제로 변경하시겠습니까? 이후 월 9,900원 -- while the stopped plan's price
// (in a sentence that stops it) and a price said before it are none: "Your
// free plan will be activated. Your Premium plan ($9.99/month) will be
// cancelled.", "Cancel your Premium plan ($9.99/month)? Your free plan will be
// activated." One walk from the last sentence keeps it linear.
function freeStartPriced(sentences: string[]): boolean {
  let pricedLater = false;
  for (let at = sentences.length - 1; at >= 0; at -= 1) {
    const sentence = sentences[at];
    const free = FREE_START_PATTERN.exec(sentence) ?? CJK_FREE_MOVE_PATTERN.exec(sentence);
    if (free !== null && (pricedLater || pricesStart(sentence.slice(free.index)))) {
      return true;
    }
    pricedLater = pricedLater || pricesStart(sentence);
  }
  return false;
}

// A confirm() that commits money is the same prohibited class as clicking the
// button that raised it -- the dialog is just where the page asked. Its message
// is the thing to read, since there is no element to inspect.
function isFinancialDialog(request: AoiBrowserDriveActionRequest): boolean {
  if (request.kind !== 'dialog') {
    return false;
  }
  // Dismissing is always safe: it is how you back out.
  if ((request.disposition ?? '').trim().toLowerCase() !== 'accept') {
    return false;
  }
  // A confirm's own Cancel button, named in its message in English, Korean,
  // Japanese or Chinese, stops nothing: the words that name it are not read
  // at all, and neither is a payment already made that is given back. What a
  // cancel confirm says will
  // no longer be billed is not a bill: its phrase is not read with the
  // phrases, nor its clause with the amounts -- but an until clause that
  // accepting answers is read with both, and the rest of its clause with the
  // amounts, and what its clause says is still charged ("only $49.00 at
  // delivery") is read with a billing word.
  const message = withHalfWidthDigits(String(request.targetText ?? ''))
    .replace(CANCEL_BUTTON_PATTERN, ' ')
    .replace(CJK_CANCEL_BUTTON_PATTERN, ' ')
    .replace(PAID_BACK_PATTERN, ' ');
  const phrases = message.replace(
    NEGATED_BILLING_PHRASE_PATTERN,
    (_negated: string, amount: string | undefined, until: string | undefined) =>
      until !== undefined && untilIsAccepted(until) ? ` ${amount ?? ''}${until}` : ' ',
  );
  const clauses = message.replace(
    NEGATED_BILLING_CLAUSE_PATTERN,
    (
      negated: string,
      stoppedRest: string | undefined,
      _unpaidRest: string | undefined,
      negatedRest: string | undefined,
      stillCharged: string | undefined,
    ) => {
      const left = stillCharged === undefined ? ' ' : ' charged ';
      const mark = MARK_AT_END_PATTERN.test(negated) ? negated.slice(-1) : '';
      // A charge or the billing told to stop leaves a stop where it was, so
      // the message still stops what it said -- a sentence of its own, so
      // what follows it, after "and" too, is not read as the stopped plan's.
      if (stoppedRest !== undefined) {
        return ` plan will stop${mark || '.'} ${left}`;
      }
      const until = negatedRest === undefined ? null : LEADING_UNTIL_PATTERN.exec(negatedRest);
      if (until !== null && untilIsAccepted(until[1])) {
        return ` ${negated}`;
      }
      return `${left}${mark}`;
    },
  );
  const priced = PRICED_START_PATTERN.test(clauses);
  // What is stopped starts nothing (the purchase in "Cancel your purchase"),
  // and a start sells where the message asks it, or said with a price or
  // beside the stop it replaces -- "Subscribe for $9.99/month? No refunds on
  // cancellation.", 프리미엄에 가입하시겠습니까? (취소 시 환불 불가) 월 요금
  // 9,900원, "End your trial and start your $9.99/month plan now?" -- not as
  // the way back in, told after the question: "Cancel your membership
  // ($30/month)? To rejoin, start a new membership from your account". A
  // message that asks nothing asks all it says. A start told as under way
  // starts something in a sentence with an amount ("Premium ($9.99/month)
  // starts today"), and a start told as what accepting does wherever it is
  // said, in a message with an amount ("Cancel Basic? You will be upgraded to
  // Pro automatically. New price: $14.99/month.", "Your Basic plan will be
  // cancelled. Premium will start today. Continue? ($14.99/month)") -- one
  // onto a plan said to be free too, when its sentence prices it after it
  // ("You'll be upgraded to Pro with 1 month free, then $14.99/month").
  const sentences = clauses.split(SENTENCE_END_PATTERN);
  const asksNothing = !sentences.some((sentence) => QUESTION_END_PATTERN.test(sentence));
  const isAsked = (sentence: string) => asksNothing || QUESTION_END_PATTERN.test(sentence);
  // The price after a start is read in the message as written, its stops and
  // its denials with it (pricesStart passes over both).
  const written = message.split(SENTENCE_END_PATTERN);
  const pricedAfter = (sentence: string) => {
    const told = TOLD_START_ANY_PATTERN.exec(sentence);
    return told !== null && pricesStart(sentence.slice(told.index));
  };
  const starts =
    (TOLD_START_PATTERN.test(clauses) && MONEY_PATTERN.test(clauses)) ||
    written.some(pricedAfter) ||
    ((FREE_START_PATTERN.test(message) || CJK_FREE_MOVE_PATTERN.test(message)) &&
      freeStartPriced(written)) ||
    sentences.some((sentence) => {
      const unstopped = sentence.replace(STOPPED_THING_PATTERN, ' ');
      return (
        (STARTING_ACTION_PATTERN.test(unstopped) &&
          (isAsked(sentence) ||
            MONEY_PATTERN.test(sentence) ||
            STOPPING_ACTION_PATTERN.test(sentence))) ||
        (STARTED_PATTERN.test(unstopped) && MONEY_PATTERN.test(sentence))
      );
    });
  // A stop counts where the message asks it, as a start does -- in a sentence
  // that asks, or in any sentence of a message that asks nothing -- or
  // wherever it names the billed thing it stops (STOP_NAMED_PATTERN) or is
  // told as what will happen (TOLD_STOP_PATTERN), when no other sentence
  // holds an amount of its own (AMOUNT_EXCUSED_PATTERN). A stop the message
  // only reports or names stops nothing it asks: "Cancellation is free.
  // Total: $129.00. Continue?", "One item was cancelled because it is out of
  // stock. Your total is now $49.00. Continue?", "Total: $49.00. Cancelling
  // now will empty your cart. Continue?" -- and one told with the cause the
  // page has for it is a change the page reports, not one the message asks to
  // make: "One item will be removed because it is out of stock. Your total is
  // now $49.00. Continue?" goes on with the order -- and so does one reported
  // with its cause in a message that asks nothing ("One item was cancelled
  // because it is out of stock. Your total is now $49.00. Click OK to
  // continue."). A change is taken for one the page reports where another
  // sentence states a total or an amount due the order goes on with -- not a
  // refund's total ("Your order will be cancelled because the item is sold
  // out. Refund total: $49.00. Continue?" stops the order); without one, a
  // stop told with its cause still stops what it names ("Your subscription
  // ($9.99/month) will be cancelled due to a failed payment. Continue?").
  const goesOn = (sentence: string) =>
    AMOUNT_DIALOG_PATTERN.test(sentence) && !REFUND_TOTAL_PATTERN.test(sentence);
  const totalSentences = sentences.filter(goesOn).length;
  const reportedChange = (sentence: string) =>
    REPORTED_CAUSE_PATTERN.test(sentence) && totalSentences > (goesOn(sentence) ? 1 : 0);
  const namedStop = (sentence: string) => !reportedChange(sentence) && toldOrNamedStop(sentence);
  const pricedElsewhere = sentences.some((sentence) => {
    const rest = sentence.replace(PLAN_ENDS_PATTERN, ' ');
    return (
      MONEY_PATTERN.test(rest) &&
      !namedStop(sentence) &&
      (!AMOUNT_EXCUSED_PATTERN.test(rest) ||
        (AMOUNT_DIALOG_PATTERN.test(rest) && !TOTAL_EXCUSED_PATTERN.test(rest)))
    );
  });
  const stops =
    sentences.some(
      (sentence) =>
        isAsked(sentence) &&
        STOPPING_ACTION_PATTERN.test(sentence) &&
        !(asksNothing && reportedChange(sentence)),
    ) ||
    (!pricedElsewhere && sentences.some(namedStop));
  const stopping = stops && !starts && !priced && !pausedPrice(message);
  const said = stopping ? phrases.replace(STOPPED_THING_PATTERN, ' ') : phrases;
  const totals = withoutRefundTotals(
    phrases,
    RETURN_ASKED_PATTERN.test(phrases) && !EXCHANGED_PATTERN.test(phrases),
  );
  return (
    priced ||
    dialogCommits(said) ||
    (MONEY_PATTERN.test(said) &&
      ((SEND_ASKED_PATTERN.test(said) && !PAPER_SENT_PATTERN.test(said)) ||
        (RETRY_ASKED_PATTERN.test(said) && MONEY_MOVING_WORD_PATTERN.test(said)))) ||
    (REPEAT_ASKED_PATTERN.test(said.replace(RESENT_PAPER_PATTERN, ' ')) &&
      PAST_PAYMENT_LABEL_PATTERN.test(said)) ||
    (!stopping && AMOUNT_DIALOG_PATTERN.test(totals)) ||
    ORDER_PLACED_PATTERN.test(phrases) ||
    DUE_STATED_PATTERN.test(phrases.replace(ZERO_AMOUNT_PATTERN, ' ')) ||
    amountBesideBillingWord(
      clauses.replace(VALUE_SET_PATTERN, ' ').replace(PAST_CHARGE_PATTERN, ' '),
      stopping,
    )
  );
}

// A prompt() that asks for a password or a one-time code is a credential field
// by another name: answering it with text types the secret.
function isSensitiveDialog(request: AoiBrowserDriveActionRequest): boolean {
  if (request.kind !== 'dialog') {
    return false;
  }
  if ((request.disposition ?? '').trim().toLowerCase() !== 'accept') {
    return false;
  }
  if (typeof request.promptText !== 'string' || request.promptText.length === 0) {
    return false;
  }
  const asked = request.targetText ?? '';
  return namesSecret(asked) || PAN_CAPITALS_PATTERN.test(asked);
}

function isCaptchaTarget(request: AoiBrowserDriveActionRequest): boolean {
  const parts = [request.targetText, request.selector, fieldHaystack(request.field)]
    .filter((v): v is string => typeof v === 'string')
    .join(' ');
  return CAPTCHA_PATTERN.test(parts);
}

// Words around a control -- the name of the dialog it sits in -- that only ever add a CAPTCHA refusal.
export function aoiBrowserDriveIsCaptchaText(text: string): boolean {
  return typeof text === 'string' && CAPTCHA_PATTERN.test(text);
}

function isFinancialCommitTarget(request: AoiBrowserDriveActionRequest): boolean {
  const text = withHalfWidthDigits(
    typeof request.targetText === 'string' ? request.targetText : '',
  );
  return (
    FINANCIAL_COMMIT_PATTERN.test(text) ||
    GIVEN_AT_END_PATTERN.test(text) ||
    (isShortPiece(text)
      ? MONEY_MOVED_PATTERN.test(text.replace(ASKED_HOW_PATTERN, ' '))
      : MONEY_MOVED_ON_CONTROL_PATTERN.test(text))
  );
}

/**
 * The key a press step sends: its own when it names one, Enter when it names
 * none (what the executor presses then), null when `key` is there but is not a
 * key name at all. The classifier and the executor both read it from here, so
 * what is judged is what is pressed.
 */
export function aoiBrowserDrivePressKey(request: AoiBrowserDriveActionRequest): string | null {
  if (request.key === undefined || request.key === null) {
    return 'Enter';
  }
  return typeof request.key === 'string' && request.key.length > 0 ? request.key : null;
}

// The keys of a chord, lowercased, split the way Playwright splits them: on a
// '+' that follows something ('Control++' is Control and the plus key), and
// with nothing trimmed (' ' is the Space key, '\n' is Enter). Playwright holds
// down EVERY part, not just the modifiers, so 'Enter+a' presses Enter.
function chordKeys(key: string): string[] {
  const keys: string[] = [];
  let building = '';
  for (const char of key) {
    if (char === '+' && building) {
      keys.push(building);
      building = '';
    } else {
      building += char;
    }
  }
  keys.push(building);
  return keys.map((part) => part.toLowerCase());
}

const MODIFIER_KEYS = new Set([
  'shift',
  'control',
  'alt',
  'meta',
  'controlormeta',
  'altgraph',
  'shiftleft',
  'shiftright',
  'controlleft',
  'controlright',
  'altleft',
  'altright',
  'metaleft',
  'metaright',
]);

// Keys that submit a form or activate the focused control, wherever they sit
// in a chord.
const COMMIT_KEYS = new Set(['enter', 'return', 'numpadenter', '\n', '\r', ' ', 'space']);
// Keys that only move around -- wherever they land, they commit nothing.
const NAVIGATION_KEYS = new Set([
  'tab',
  'escape',
  'esc',
  'arrowup',
  'arrowdown',
  'arrowleft',
  'arrowright',
  'home',
  'end',
  'pageup',
  'pagedown',
]);

// Keys that leave a field, or close what is open, and enter nothing in it.
const LEAVING_KEYS = new Set(['tab', 'escape', 'esc']);

/**
 * Whether a press only moves: past its modifiers, every key it holds is a
 * navigation key. Such a press commits nothing and types nothing, wherever it
 * lands -- so where it lands need not be known for it to be sent.
 */
export function aoiBrowserDrivePressOnlyMoves(request: AoiBrowserDriveActionRequest): boolean {
  const key = aoiBrowserDrivePressKey(request);
  if (key === null) {
    return false;
  }
  const ordinary = chordKeys(key).filter((part) => !MODIFIER_KEYS.has(part));
  return ordinary.length > 0 && ordinary.every((part) => NAVIGATION_KEYS.has(part));
}

/**
 * Classify a proposed action. Forbidden checks run FIRST and are deterministic so
 * they cannot be bypassed by the model's framing.
 */
export function classifyAoiBrowserDriveAction(
  request: AoiBrowserDriveActionRequest,
): AoiBrowserDriveActionDecision {
  const kind = request.kind;

  // Unknown kind -> fail closed as forbidden.
  if (!READ_KINDS.has(kind) && !ACT_KINDS.has(kind)) {
    return {
      category: 'forbidden',
      requiresApproval: false,
      reason: `unknown action kind: ${String(kind)}`,
      forbidReason: 'unknown_action',
    };
  }

  // CAPTCHA: never interact, regardless of kind.
  if (isCaptchaTarget(request)) {
    return {
      category: 'forbidden',
      requiresApproval: false,
      reason: 'CAPTCHA interaction is never permitted; the user must solve it.',
      forbidReason: 'captcha',
    };
  }

  // Typing into a credential / payment / OTP field is never permitted.
  if (kind === 'type' && isSensitiveField(request.field)) {
    return {
      category: 'forbidden',
      requiresApproval: false,
      reason: 'Entering passwords/payment/OTP/SSN is never permitted; the user must do it.',
      forbidReason: 'sensitive_field',
    };
  }

  // A press is modifiers plus ONE key. Anything more is not a press this can
  // judge: Playwright would hold down every key named, so a chord could carry
  // a commit or a typed character behind a harmless last key.
  const pressKey = kind === 'press' ? aoiBrowserDrivePressKey(request) : null;
  const pressKeys = pressKey === null ? [] : chordKeys(pressKey);
  const pressOrdinary = pressKeys.filter((key) => !MODIFIER_KEYS.has(key));
  if (kind === 'press' && (pressKey === null || pressOrdinary.length > 1)) {
    return {
      category: 'forbidden',
      requiresApproval: false,
      reason:
        pressKey === null
          ? 'A press needs a key name.'
          : 'A press may hold modifiers and only one other key; press keys one at a time.',
      forbidReason: 'unknown_action',
    };
  }

  // A key press in a credential field is typing by another name (and Enter
  // submits it); choosing a card-expiry option is entering payment details --
  // and an arrow key, Home or End chooses it as surely, in a select. Only
  // leaving the field stays possible.
  if (
    (kind === 'press' &&
      !pressOrdinary.every((key) => LEAVING_KEYS.has(key)) &&
      isSensitiveField(request.field)) ||
    (kind === 'select' && isSensitiveField(request.field))
  ) {
    return {
      category: 'forbidden',
      requiresApproval: false,
      reason: 'Entering passwords/payment/OTP/SSN is never permitted; the user must do it.',
      forbidReason: 'sensitive_field',
    };
  }

  // Committing a financial action (pay/buy/transfer/trade/checkout) is never
  // permitted, even with approval. Enter or Space on a control submits its form
  // as surely as clicking the form's button does, and a download is a click on
  // whatever it names -- "Buy now" included.
  if (
    (kind === 'click' ||
      kind === 'submit' ||
      kind === 'download' ||
      (kind === 'press' && pressKeys.some((key) => COMMIT_KEYS.has(key)))) &&
    isFinancialCommitTarget(request)
  ) {
    return {
      category: 'forbidden',
      requiresApproval: false,
      reason: 'Financial transactions (pay/buy/transfer/trade) are never permitted.',
      forbidReason: 'financial_commit',
    };
  }

  if (isSensitiveDialog(request)) {
    return {
      category: 'forbidden',
      requiresApproval: false,
      reason: 'Answering a prompt for a password or one-time code is never permitted.',
      forbidReason: 'sensitive_field',
    };
  }

  // ...and neither is confirming one in a dialog. The page moved the commit
  // into a confirm(); the answer is the same.
  if (isFinancialDialog(request)) {
    return {
      category: 'forbidden',
      requiresApproval: false,
      reason: 'Confirming a financial transaction in a dialog is never permitted.',
      forbidReason: 'financial_commit',
    };
  }

  // Dropping a dragged element ONTO a commit control is a click by another
  // route; some UIs really are drag-to-confirm.
  if (kind === 'drag' && isFinancialCommitTarget(request)) {
    return {
      category: 'forbidden',
      requiresApproval: false,
      reason: 'Dragging onto a financial commit control is never permitted.',
      forbidReason: 'financial_commit',
    };
  }

  // An upload targeting a credential-ish field (an identity-document or
  // signature slot) is the same refusal as typing into one.
  if (kind === 'upload' && isSensitiveField(request.field)) {
    return {
      category: 'forbidden',
      requiresApproval: false,
      reason: 'Attaching a file to a credential field is never permitted.',
      forbidReason: 'sensitive_field',
    };
  }

  if (READ_KINDS.has(kind)) {
    return {
      category: 'read',
      requiresApproval: false,
      reason: 'observation only',
    };
  }

  return {
    category: 'act',
    requiresApproval: true,
    reason: 'side-effecting action requires per-action approval',
  };
}
