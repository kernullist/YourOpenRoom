import { describe, expect, it } from 'vitest';

import {
  DEFAULT_AOI_VOICE_INPUT_CONFIG,
  decideAoiVoiceInputCapture,
  finalizeAoiVoiceTranscript,
  normalizeAoiVoiceInputConfig,
  summarizeAoiVoiceInputReadiness,
} from '../aoiVoiceInput';

describe('aoiVoiceInput config (P5.6)', () => {
  it('defaults mic input OFF (both gates)', () => {
    expect(DEFAULT_AOI_VOICE_INPUT_CONFIG).toEqual({ micEnabled: false, micConsent: false });
  });

  it('normalizes missing/malformed config to the default-off posture', () => {
    expect(normalizeAoiVoiceInputConfig(null)).toEqual({ micEnabled: false, micConsent: false });
    expect(normalizeAoiVoiceInputConfig({ micEnabled: 'yes' as unknown as boolean })).toEqual({
      micEnabled: false,
      micConsent: false,
    });
    expect(normalizeAoiVoiceInputConfig({ micEnabled: true, micConsent: true })).toEqual({
      micEnabled: true,
      micConsent: true,
    });
  });
});

describe('decideAoiVoiceInputCapture (P5.6, never hot-mic)', () => {
  const enabled = { micEnabled: true, micConsent: true };

  it('blocks capture when the mic is disabled', () => {
    const d = decideAoiVoiceInputCapture({
      config: { micEnabled: false, micConsent: true },
      pushToTalkActive: true,
    });
    expect(d).toMatchObject({ allowed: false, state: 'blocked', reason: 'mic_disabled' });
  });

  it('blocks capture when mic-consent is missing (even if enabled + pressed)', () => {
    const d = decideAoiVoiceInputCapture({
      config: { micEnabled: true, micConsent: false },
      pushToTalkActive: true,
    });
    expect(d).toMatchObject({ allowed: false, state: 'blocked', reason: 'mic_consent_missing' });
  });

  it('is ready but NOT capturing when enabled + consented but no push-to-talk (no hot-mic)', () => {
    const d = decideAoiVoiceInputCapture({ config: enabled, pushToTalkActive: false });
    expect(d).toMatchObject({ allowed: false, state: 'ready', reason: 'awaiting_push_to_talk' });
  });

  it('allows capture ONLY while push-to-talk is actively held', () => {
    const d = decideAoiVoiceInputCapture({ config: enabled, pushToTalkActive: true });
    expect(d).toMatchObject({ allowed: true, state: 'listening', reason: 'push_to_talk_active' });
  });
});

describe('finalizeAoiVoiceTranscript (P5.6)', () => {
  it('redacts secrets and strips source-instructions from the transcript', () => {
    const raw = 'my key -----BEGIN PRIVATE KEY-----abc-----END PRIVATE KEY----- please';
    const out = finalizeAoiVoiceTranscript(raw);
    expect(out).not.toContain('BEGIN PRIVATE KEY');
  });

  it('collapses whitespace and caps length', () => {
    expect(finalizeAoiVoiceTranscript('  hello    world  ')).toBe('hello world');
    expect(finalizeAoiVoiceTranscript('abcdef', 3)).toBe('abc');
  });

  it('returns null for empty / whitespace / non-string input', () => {
    expect(finalizeAoiVoiceTranscript('')).toBeNull();
    expect(finalizeAoiVoiceTranscript('   ')).toBeNull();
    expect(finalizeAoiVoiceTranscript(null)).toBeNull();
    expect(finalizeAoiVoiceTranscript(42)).toBeNull();
  });
});

describe('summarizeAoiVoiceInputReadiness (P5.6)', () => {
  it('is ready only when BOTH gates are satisfied', () => {
    expect(summarizeAoiVoiceInputReadiness({ micEnabled: false, micConsent: false })).toMatchObject(
      {
        ready: false,
        reason: 'mic_disabled',
      },
    );
    expect(summarizeAoiVoiceInputReadiness({ micEnabled: true, micConsent: false })).toMatchObject({
      ready: false,
      reason: 'mic_consent_missing',
    });
    expect(summarizeAoiVoiceInputReadiness({ micEnabled: true, micConsent: true })).toMatchObject({
      ready: true,
      reason: 'push_to_talk_ready',
    });
  });
});
