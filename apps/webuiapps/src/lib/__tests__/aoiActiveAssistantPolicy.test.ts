import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildAoiActiveAssistantPolicy,
  buildAoiDormantPolicy,
  igniteAoiActiveAssistant,
  resolveAoiIgnitionCommand,
  sleepAoiActiveAssistant,
} from '../aoiActiveAssistantPolicy';
import { DEFAULT_AOI_AUTONOMY_POLICY, isAoiFieldShadowCaptureEnabled } from '../aoiAutonomyPolicy';
import { loadAoiAutonomyPolicy } from '../aoiAutonomyStore';

const NOW = 1_800_000_000_000;
const SESSION = 'aoi/default';
const tempRoots: string[] = [];

function makeRoot(): string {
  const root = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'aoi-ignite-')));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

describe('isAoiFieldShadowCaptureEnabled', () => {
  it('respects hard env off even when policy is on', () => {
    expect(
      isAoiFieldShadowCaptureEnabled({
        policyEnabled: true,
        env: { AOI_AUTONOMY_FIELD_SHADOW_CAPTURE: '0' },
      }),
    ).toBe(false);
  });

  it('requires the session policy toggle; soft env=1 alone does not force capture', () => {
    expect(
      isAoiFieldShadowCaptureEnabled({
        policyEnabled: false,
        env: { AOI_AUTONOMY_FIELD_SHADOW_CAPTURE: '1' },
      }),
    ).toBe(false);
    expect(
      isAoiFieldShadowCaptureEnabled({
        policyEnabled: true,
        env: { AOI_AUTONOMY_FIELD_SHADOW_CAPTURE: '1' },
      }),
    ).toBe(true);
  });
});

describe('buildAoiActiveAssistantPolicy', () => {
  it('wakes exactly the Tier 1-3 layers', () => {
    const policy = buildAoiActiveAssistantPolicy();
    expect(policy.enabled).toBe(true);
    expect(policy.proactiveSuggestionsEnabled).toBe(true);
    expect(policy.agenticReflectionEnabled).toBe(true);
    expect(policy.fieldShadowCaptureEnabled).toBe(true);
    expect(policy.proactiveBriefing.enabled).toBe(true);
    expect(policy.proactiveBriefing.directChatHookOptIn).toBe(true);
  });

  it('FORCES the supervised-safety invariants even if the base weakened them', () => {
    const reckless = {
      ...DEFAULT_AOI_AUTONOMY_POLICY,
      previewMode: false,
      requireApprovalForHighRisk: false,
      requireEvidenceRefs: false,
    };
    const policy = buildAoiActiveAssistantPolicy(reckless);
    expect(policy.previewMode).toBe(true);
    expect(policy.requireApprovalForHighRisk).toBe(true);
    expect(policy.requireEvidenceRefs).toBe(true);
  });

  it('never introduces any self-execution flag (Tier 4 is env-gated, outside the policy)', () => {
    const policy = buildAoiActiveAssistantPolicy() as unknown as Record<string, unknown>;
    // There is no policy field that can turn on autonomous self-execution.
    expect('selfExecute' in policy).toBe(false);
    expect('autonomousExecute' in policy).toBe(false);
    expect('allowSelfExecution' in policy).toBe(false);
  });

  it('preserves the base tuning it does not own (allowNetwork, level)', () => {
    const base = { ...DEFAULT_AOI_AUTONOMY_POLICY, allowNetwork: true, level: 'L3' as const };
    const policy = buildAoiActiveAssistantPolicy(base);
    expect(policy.allowNetwork).toBe(true);
    expect(policy.level).toBe('L3');
  });
});

describe('buildAoiDormantPolicy', () => {
  it('flips off exactly the layers ignition turned on', () => {
    const dormant = buildAoiDormantPolicy(buildAoiActiveAssistantPolicy());
    expect(dormant.enabled).toBe(false);
    expect(dormant.proactiveSuggestionsEnabled).toBe(false);
    expect(dormant.agenticReflectionEnabled).toBe(false);
    expect(dormant.fieldShadowCaptureEnabled).toBe(false);
    expect(dormant.proactiveBriefing.enabled).toBe(false);
  });
});

describe('igniteAoiActiveAssistant / sleepAoiActiveAssistant', () => {
  it('persists the active policy, then reverts it (round-trip)', () => {
    const root = makeRoot();
    // Fresh session -> the default policy is inert.
    expect(loadAoiAutonomyPolicy(root, SESSION).enabled).toBe(false);

    const ignited = igniteAoiActiveAssistant({ sessionsDir: root, sessionPath: SESSION, now: NOW });
    expect(ignited.wasEnabled).toBe(false);
    const afterIgnite = loadAoiAutonomyPolicy(root, SESSION);
    expect(afterIgnite.enabled).toBe(true);
    expect(afterIgnite.proactiveSuggestionsEnabled).toBe(true);
    expect(afterIgnite.previewMode).toBe(true); // still supervised

    const slept = sleepAoiActiveAssistant({
      sessionsDir: root,
      sessionPath: SESSION,
      now: NOW + 1,
    });
    expect(slept.wasEnabled).toBe(true);
    expect(loadAoiAutonomyPolicy(root, SESSION).enabled).toBe(false);
  });
});

describe('resolveAoiIgnitionCommand', () => {
  it('parses --ignite with a default session', () => {
    expect(resolveAoiIgnitionCommand(['node', 'x', '--ignite'])).toEqual({
      action: 'ignite',
      sessionPath: 'aoi/default',
    });
  });

  it('parses --ignite with an explicit session', () => {
    expect(resolveAoiIgnitionCommand(['--ignite', 'aoi/kernul'])).toEqual({
      action: 'ignite',
      sessionPath: 'aoi/kernul',
    });
  });

  it('accepts --wake as an alias for ignite', () => {
    expect(resolveAoiIgnitionCommand(['--wake'])?.action).toBe('ignite');
  });

  it('parses --sleep', () => {
    expect(resolveAoiIgnitionCommand(['--sleep', 'aoi/x'])).toEqual({
      action: 'sleep',
      sessionPath: 'aoi/x',
    });
  });

  it('returns null when no ignition flag is present', () => {
    expect(resolveAoiIgnitionCommand(['--supervise'])).toBeNull();
  });
});
