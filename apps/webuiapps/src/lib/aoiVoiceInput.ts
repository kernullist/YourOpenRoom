// P5.6: voice INPUT (speech-to-text / mic) as a FAIL-CLOSED scaffold.
//
// Voice is half-duplex today -- there is real TTS output (aoiTts / aoiOperatorVoice) but no
// mic input. This owns the SAFE decision layer for push-to-talk speech input feeding the
// existing chat-turn pipeline; the actual browser SpeechRecognition / MediaRecorder capture
// lives in the client and is driven by this model.
//
// Safety (mirrors the ttsEnabled default-off posture; never hot-mic):
//   * Default OFF: mic input is disabled until the operator explicitly enables it, AND a
//     separate in-app mic-consent grant is required (browser permission is necessary but not
//     sufficient).
//   * Push-to-talk ONLY: capture is permitted ONLY while an explicit push-to-talk gesture is
//     active, so the mic is never open outside a deliberate press -- there is no continuous /
//     wake-word / hot-mic path here at all.
//   * Redaction: a raw transcript is redacted (secrets + source-instructions stripped, capped)
//     before it is allowed to enter the chat-turn pipeline.
//   * Fail-closed everywhere: disabled / no consent / no push-to-talk / empty transcript ->
//     no capture, nothing submitted.
//
// Pure + deterministic (no browser APIs here) so it is unit-testable; the client supplies the
// real capture behind decideAoiVoiceInputCapture + finalizeAoiVoiceTranscript.
import { redactAoiSensitiveContent, stripAoiSourceInstructions } from './aoiMemoryShared';

export interface AoiVoiceInputConfig {
  // Default OFF (mirrors ttsEnabled). The operator must enable mic input explicitly.
  micEnabled: boolean;
  // Explicit, separate in-app mic-consent grant. Default OFF.
  micConsent: boolean;
}

export const DEFAULT_AOI_VOICE_INPUT_CONFIG: AoiVoiceInputConfig = {
  micEnabled: false,
  micConsent: false,
};

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

// Normalize a stored/partial config to the conservative default-off posture. Anything missing
// or malformed falls back to OFF, so a corrupt config can never accidentally open the mic.
export function normalizeAoiVoiceInputConfig(
  raw: Partial<AoiVoiceInputConfig> | null | undefined,
): AoiVoiceInputConfig {
  return {
    micEnabled: normalizeBoolean(raw?.micEnabled, DEFAULT_AOI_VOICE_INPUT_CONFIG.micEnabled),
    micConsent: normalizeBoolean(raw?.micConsent, DEFAULT_AOI_VOICE_INPUT_CONFIG.micConsent),
  };
}

export type AoiVoiceInputCaptureState = 'blocked' | 'ready' | 'listening';

export interface AoiVoiceInputCaptureDecision {
  // May the mic capture RIGHT NOW?
  allowed: boolean;
  state: AoiVoiceInputCaptureState;
  reason: string;
}

// The core gate. Capture is allowed ONLY when the mic is enabled AND consented AND a
// push-to-talk gesture is actively held -- so the mic is never open outside an explicit press.
export function decideAoiVoiceInputCapture(params: {
  config: AoiVoiceInputConfig;
  pushToTalkActive: boolean;
}): AoiVoiceInputCaptureDecision {
  if (!params.config.micEnabled) {
    return { allowed: false, state: 'blocked', reason: 'mic_disabled' };
  }
  if (!params.config.micConsent) {
    return { allowed: false, state: 'blocked', reason: 'mic_consent_missing' };
  }
  if (!params.pushToTalkActive) {
    // Enabled + consented but no active press -> ready, but NOT capturing (no hot-mic).
    return { allowed: false, state: 'ready', reason: 'awaiting_push_to_talk' };
  }
  return { allowed: true, state: 'listening', reason: 'push_to_talk_active' };
}

const DEFAULT_TRANSCRIPT_MAX_CHARS = 2000;

// Sanitize a raw STT transcript before it enters the chat-turn pipeline: redact secrets, strip
// source-instructions, collapse whitespace, cap length. Empty/whitespace -> null (submit
// nothing). This is the boundary that keeps a spoken secret or an injected instruction out of
// the conversation.
export function finalizeAoiVoiceTranscript(
  raw: unknown,
  maxChars: number = DEFAULT_TRANSCRIPT_MAX_CHARS,
): string | null {
  const text = stripAoiSourceInstructions(
    redactAoiSensitiveContent(typeof raw === 'string' ? raw : ''),
  )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, Math.max(0, maxChars));
  return text.length > 0 ? text : null;
}

export interface AoiVoiceInputReadiness {
  micEnabled: boolean;
  micConsent: boolean;
  // True only when BOTH gates are satisfied -- the operator surface shows "ready" only then.
  ready: boolean;
  reason: string;
}

// Operator-surface readiness summary (does NOT open the mic; push-to-talk is still required to
// actually capture).
export function summarizeAoiVoiceInputReadiness(
  config: AoiVoiceInputConfig,
): AoiVoiceInputReadiness {
  const ready = config.micEnabled && config.micConsent;
  const reason = !config.micEnabled
    ? 'mic_disabled'
    : !config.micConsent
      ? 'mic_consent_missing'
      : 'push_to_talk_ready';
  return { micEnabled: config.micEnabled, micConsent: config.micConsent, ready, reason };
}
