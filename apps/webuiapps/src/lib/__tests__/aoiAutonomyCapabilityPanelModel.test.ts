import { describe, expect, it } from 'vitest';

import {
  buildAoiAutonomyCapabilityBody,
  describeAoiCapabilitySource,
  parseAoiAutonomyCapabilityResponse,
  validateAoiPushWebhookUrl,
  type AoiAutonomyCapabilityView,
} from '../aoiAutonomyCapabilityPanelModel';

const okResponse = {
  ok: true,
  settings: {
    selfExecute: true,
    appOpLiveDispatch: false,
    pushWebhookUrl: 'https://push.example.com/hook',
    goalSynthesis: true,
    idleConfidenceSurge: false,
    sources: {
      selfExecute: 'config',
      appOpLiveDispatch: 'default',
      pushWebhookUrl: 'env',
      goalSynthesis: 'config',
      idleConfidenceSurge: 'default',
    },
  },
  envOnly: [
    {
      key: 'AOI_AUTONOMY_AUTO_PROMOTE',
      label: 'Automatic trust promotion',
      detail: 'Raises Aoi trust level',
      on: false,
    },
  ],
};

describe('parseAoiAutonomyCapabilityResponse', () => {
  it('reads the settings and their sources', () => {
    const parsed = parseAoiAutonomyCapabilityResponse(okResponse);
    expect(parsed?.capabilities.selfExecute).toBe(true);
    expect(parsed?.capabilities.pushWebhookUrl).toBe('https://push.example.com/hook');
    expect(parsed?.capabilities.sources.selfExecute).toBe('config');
    expect(parsed?.capabilities.sources.pushWebhookUrl).toBe('env');
  });

  it('reads the read-only env-only gates', () => {
    const parsed = parseAoiAutonomyCapabilityResponse(okResponse);
    expect(parsed?.envOnly).toHaveLength(1);
    expect(parsed?.envOnly[0].key).toBe('AOI_AUTONOMY_AUTO_PROMOTE');
    expect(parsed?.envOnly[0].on).toBe(false);
  });

  it('returns null when the payload carries no settings', () => {
    expect(parseAoiAutonomyCapabilityResponse(null)).toBeNull();
    expect(parseAoiAutonomyCapabilityResponse({ ok: true })).toBeNull();
    expect(parseAoiAutonomyCapabilityResponse('nope')).toBeNull();
  });

  it('treats missing or unknown fields as OFF and default-sourced', () => {
    // A capability whose state cannot be read must never render as enabled.
    const parsed = parseAoiAutonomyCapabilityResponse({
      settings: { selfExecute: 'yes', sources: { selfExecute: 'somewhere' } },
    });
    expect(parsed?.capabilities.selfExecute).toBe(false);
    expect(parsed?.capabilities.sources.selfExecute).toBe('default');
    expect(parsed?.capabilities.pushWebhookUrl).toBe('');
    expect(parsed?.envOnly).toEqual([]);
  });

  it('drops env-only rows with no key', () => {
    const parsed = parseAoiAutonomyCapabilityResponse({
      settings: { sources: {} },
      envOnly: [{ label: 'orphan' }, { key: 'A', label: 'a', detail: 'd', on: true }],
    });
    expect(parsed?.envOnly).toEqual([{ key: 'A', label: 'a', detail: 'd', on: true }]);
  });
});

describe('buildAoiAutonomyCapabilityBody', () => {
  it('sends every controlled field explicitly so it beats the env fallback', () => {
    const view: AoiAutonomyCapabilityView = {
      selfExecute: false,
      appOpLiveDispatch: true,
      pushWebhookUrl: '',
      goalSynthesis: false,
      idleConfidenceSurge: true,
      sources: {
        selfExecute: 'default',
        appOpLiveDispatch: 'config',
        pushWebhookUrl: 'default',
        goalSynthesis: 'default',
        idleConfidenceSurge: 'config',
      },
    };
    expect(buildAoiAutonomyCapabilityBody(view)).toEqual({
      version: 1,
      selfExecuteEnabled: false,
      appOpLiveDispatchEnabled: true,
      pushWebhookUrl: '',
      goalSynthesisEnabled: false,
      idleConfidenceSurgeEnabled: true,
    });
  });
});

describe('validateAoiPushWebhookUrl', () => {
  it('accepts an empty value (that is the off state) and http(s) URLs', () => {
    expect(validateAoiPushWebhookUrl('')).toBeNull();
    expect(validateAoiPushWebhookUrl('   ')).toBeNull();
    expect(validateAoiPushWebhookUrl('https://push.example.com/hook')).toBeNull();
    expect(validateAoiPushWebhookUrl('http://localhost:9000/hook')).toBeNull();
  });

  it('rejects a non-http(s) or unparseable URL', () => {
    expect(validateAoiPushWebhookUrl('javascript:alert(1)')).toMatch(/http/);
    expect(validateAoiPushWebhookUrl('file:///etc/passwd')).toMatch(/http/);
    expect(validateAoiPushWebhookUrl('push.example.com')).toMatch(/valid URL/);
  });
});

describe('describeAoiCapabilitySource', () => {
  it('names which side decided', () => {
    expect(describeAoiCapabilitySource('config')).toBe('set here');
    expect(describeAoiCapabilitySource('env')).toBe('on via environment');
    expect(describeAoiCapabilitySource('default')).toBe('default');
  });
});
