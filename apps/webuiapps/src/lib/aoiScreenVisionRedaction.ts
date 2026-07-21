// SV2.2: redaction + validation for screen-vision text.
//
// A vision model describing the FOCUSED window emits FREE-FORM text -- unlike
// app-activity, whose summary is derived purely from validated slugs. That text
// is UNTRUSTED observed content: it can contain secrets shown on screen (keys,
// tokens, passwords), personal data (emails, paths, long account/card/phone
// numbers, URLs), and even prompt-injection strings the model transcribed from
// the screen. This module is the mandatory boundary that turns raw model output
// into a redacted, bounded, structurally-safe summary BEFORE it can become a
// stored signal (SV3.1 calls this server-side; the store keeps only the output).
//
// Safety:
//   * Prompt-injection stripped: screen text is data, never instructions --
//     source-instruction lines are removed first.
//   * Secrets + personal data redacted: reuses the shared secret redactor and
//     adds screen-specific URL / local-path / email / long-number patterns.
//   * Bounded: every field is whitespace-normalized and length-capped.
//   * Fail-closed: if nothing survives redaction (empty summary), the result is
//     dropped (null) -- an empty signal is never stored.
import { redactAoiSensitiveContent, stripAoiSourceInstructions } from './aoiMemoryShared';
import type { AoiScreenVisionChannel, AoiScreenVisionResult } from './aoiScreenVisionBackend';

const DEFAULT_MAX_SUMMARY_CHARS = 320;
const DEFAULT_MAX_DETAILS = 6;
const DEFAULT_MAX_DETAIL_CHARS = 160;

const URL_PATTERN = /\bhttps?:\/\/[^\s'"<>]+/gi;
const WINDOWS_PATH_PATTERN = /(?:[A-Za-z]:\\|\\\\)[^\s'"<>|]+/g;
const UNIX_PATH_PATTERN =
  /(?:\/(?:Users|home|mnt|tmp|var|Volumes|workspace|etc|opt|root)\/[^\s'"<>|]+)/g;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
// A run that contains 10+ digits ignoring spaces/dashes -- card / account /
// phone numbers. Guarded so ordinary short numbers ("42 files") are untouched.
const LONG_NUMBER_PATTERN = /\b\d(?:[\d -]{8,})\d\b/g;

export interface AoiScreenVisionRedactedSummary {
  version: 1;
  channel: AoiScreenVisionChannel;
  modelId: string;
  summary: string;
  details: string[];
  appLabel: string | null;
  confidence: number;
  producedAt: number;
  redactionState: 'redacted';
  // True when redaction changed the model's raw text in any field.
  redacted: boolean;
}

export interface AoiScreenVisionRedactionOptions {
  maxSummaryChars?: number;
  maxDetails?: number;
  maxDetailChars?: number;
}

// The placeholders redaction substitutes in. Their presence in the output is a
// reliable signal that sensitive content was removed.
const REDACTION_MARKER_PATTERN = /\[url\]|\[local path\]|\[email\]|\[number\]|\[redacted_secret\]/i;

// Redact one free-form screen-vision string: strip injection lines, redact
// secrets, then screen-specific URL/path/email/long-number patterns; finally
// normalize whitespace and cap length. Deterministic and side-effect free.
export function redactAoiScreenVisionText(value: unknown, maxChars: number): string {
  if (typeof value !== 'string' || value.length === 0) {
    return '';
  }
  let text = stripAoiSourceInstructions(value);
  text = redactAoiSensitiveContent(text);
  text = text.replace(URL_PATTERN, '[url]');
  text = text.replace(WINDOWS_PATH_PATTERN, '[local path]');
  text = text.replace(UNIX_PATH_PATTERN, '[local path]');
  text = text.replace(EMAIL_PATTERN, '[email]');
  text = text.replace(LONG_NUMBER_PATTERN, (match) =>
    (match.match(/\d/g)?.length ?? 0) >= 10 ? '[number]' : match,
  );
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length <= maxChars) {
    return text;
  }
  // Keep the total within maxChars, reserving room for the ellipsis.
  const ellipsis = '...';
  const keep = Math.max(0, maxChars - ellipsis.length);
  return text.slice(0, keep).trimEnd() + ellipsis;
}

// True when redaction removed sensitive content (for the `redacted` honesty
// flag). A redaction placeholder in the output, or a stripped injection line,
// both count; a pure whitespace-normalize or length-cap does NOT.
function wasContentRedacted(raw: string, redactedText: string): boolean {
  if (REDACTION_MARKER_PATTERN.test(redactedText)) {
    return true;
  }
  const normalizedRaw = raw.replace(/\s+/g, ' ').trim();
  const strippedRaw = stripAoiSourceInstructions(raw).replace(/\s+/g, ' ').trim();
  return strippedRaw !== normalizedRaw;
}

// Turn a raw SV2.1 result into a redacted, bounded, storable summary. Returns
// null (fail-closed) when nothing usable survives redaction.
export function redactAoiScreenVisionResult(
  result: AoiScreenVisionResult,
  options: AoiScreenVisionRedactionOptions = {},
): AoiScreenVisionRedactedSummary | null {
  const maxSummaryChars = options.maxSummaryChars ?? DEFAULT_MAX_SUMMARY_CHARS;
  const maxDetails = options.maxDetails ?? DEFAULT_MAX_DETAILS;
  const maxDetailChars = options.maxDetailChars ?? DEFAULT_MAX_DETAIL_CHARS;

  const rawSummary = typeof result.summary === 'string' ? result.summary : '';
  const summary = redactAoiScreenVisionText(rawSummary, maxSummaryChars);
  if (summary.length === 0) {
    return null;
  }
  const rawDetails = Array.isArray(result.details) ? result.details : [];
  const details: string[] = [];
  let detailRedacted = false;
  for (const detail of rawDetails) {
    if (details.length >= maxDetails) {
      break;
    }
    const rawDetail = typeof detail === 'string' ? detail : '';
    const redactedDetail = redactAoiScreenVisionText(rawDetail, maxDetailChars);
    if (redactedDetail.length > 0) {
      details.push(redactedDetail);
      if (wasContentRedacted(rawDetail, redactedDetail)) {
        detailRedacted = true;
      }
    }
  }
  const rawAppLabel = typeof result.appLabel === 'string' ? result.appLabel : '';
  const appLabel = redactAoiScreenVisionText(rawAppLabel, 120);

  const redacted =
    wasContentRedacted(rawSummary, summary) ||
    wasContentRedacted(rawAppLabel, appLabel) ||
    detailRedacted;

  const confidence =
    typeof result.confidence === 'number' && Number.isFinite(result.confidence)
      ? Math.min(1, Math.max(0, result.confidence))
      : 0;

  return {
    version: 1,
    channel: result.channel,
    modelId:
      typeof result.modelId === 'string' && result.modelId.length > 0 ? result.modelId : 'unknown',
    summary,
    details,
    appLabel: appLabel.length > 0 ? appLabel : null,
    confidence,
    producedAt: typeof result.producedAt === 'number' ? result.producedAt : 0,
    redactionState: 'redacted',
    redacted,
  };
}
