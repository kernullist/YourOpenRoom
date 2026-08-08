import { describe, expect, it } from 'vitest';

import { describeAoiEnvOnlyAutonomyGates } from '../aoiAutonomyEnvOnlyGates';

function gate(env: Record<string, string | undefined>, key: string): boolean {
  const found = describeAoiEnvOnlyAutonomyGates(env).find((entry) => entry.key === key);
  if (!found) {
    throw new Error(`no gate named ${key}`);
  }
  return found.on;
}

describe('describeAoiEnvOnlyAutonomyGates', () => {
  it('reports every gate as off in a clean environment', () => {
    const gates = describeAoiEnvOnlyAutonomyGates({});
    expect(gates.every((entry) => entry.on === false)).toBe(true);
    expect(gates.every((entry) => entry.label.length > 0 && entry.detail.length > 0)).toBe(true);
  });

  it('reproduces each gate parsing exactly rather than assuming one convention', () => {
    // Trust promotion and the approval window are strict '1'.
    expect(gate({ AOI_AUTONOMY_AUTO_PROMOTE: 'true' }, 'AOI_AUTONOMY_AUTO_PROMOTE')).toBe(false);
    expect(gate({ AOI_AUTONOMY_AUTO_PROMOTE: '1' }, 'AOI_AUTONOMY_AUTO_PROMOTE')).toBe(true);
    expect(
      gate({ AOI_AUTONOMY_AUTO_PROMOTE_LOW_TIER: 'yes' }, 'AOI_AUTONOMY_AUTO_PROMOTE_LOW_TIER'),
    ).toBe(false);
    expect(gate({ AOI_AUTONOMY_APPROVAL_TTL: '1' }, 'AOI_AUTONOMY_APPROVAL_TTL')).toBe(true);

    // The MCP switch accepts 1/true/yes/on, case-insensitively.
    expect(gate({ AOI_MCP_SIDE_EFFECTING_RPC: ' ON ' }, 'AOI_MCP_SIDE_EFFECTING_RPC')).toBe(true);
    expect(gate({ AOI_MCP_SIDE_EFFECTING_RPC: 'maybe' }, 'AOI_MCP_SIDE_EFFECTING_RPC')).toBe(false);
  });

  it('reports the hard-off ceilings as ON only when they are actually blocking', () => {
    // These are ceilings, not switches: '1' permits, '0' blocks. The status line
    // reports "is this blocking", so =1 must NOT read as on.
    expect(gate({ AOI_AUTONOMY_BACKGROUND: '1' }, 'AOI_AUTONOMY_BACKGROUND')).toBe(false);
    expect(gate({ AOI_AUTONOMY_BACKGROUND: '0' }, 'AOI_AUTONOMY_BACKGROUND')).toBe(true);
    expect(gate({ AOI_AUTONOMY_BACKGROUND: 'no' }, 'AOI_AUTONOMY_BACKGROUND')).toBe(true);
    expect(
      gate({ AOI_AUTONOMY_BACKGROUND_ALLOW_NETWORK: '1' }, 'AOI_AUTONOMY_BACKGROUND_ALLOW_NETWORK'),
    ).toBe(false);
    expect(
      gate({ AOI_AUTONOMY_BACKGROUND_ALLOW_NETWORK: '0' }, 'AOI_AUTONOMY_BACKGROUND_ALLOW_NETWORK'),
    ).toBe(true);
    expect(
      gate({ AOI_AUTONOMY_FIELD_SHADOW_CAPTURE: '0' }, 'AOI_AUTONOMY_FIELD_SHADOW_CAPTURE'),
    ).toBe(true);
  });

  it('matches the network ceiling exactly: ANY non-truthy value blocks', () => {
    // parseBoolEnvTristate treats every non-truthy non-empty value as a hard
    // block, including a typo. Reading only '0' would report "not blocking" for
    // a deployment whose network is in fact off.
    for (const value of ['false', 'no', 'off', 'nope']) {
      expect(
        gate(
          { AOI_AUTONOMY_BACKGROUND_ALLOW_NETWORK: value },
          'AOI_AUTONOMY_BACKGROUND_ALLOW_NETWORK',
        ),
      ).toBe(true);
    }
    for (const value of ['1', 'true', 'yes', '', '   ']) {
      expect(
        gate(
          { AOI_AUTONOMY_BACKGROUND_ALLOW_NETWORK: value },
          'AOI_AUTONOMY_BACKGROUND_ALLOW_NETWORK',
        ),
      ).toBe(false);
    }
  });

  it('matches the field-shadow ceiling exactly (0/false/no)', () => {
    for (const value of ['0', 'false', 'no']) {
      expect(
        gate({ AOI_AUTONOMY_FIELD_SHADOW_CAPTURE: value }, 'AOI_AUTONOMY_FIELD_SHADOW_CAPTURE'),
      ).toBe(true);
    }
    // Anything else leaves the policy in charge, so it is not a ceiling.
    expect(
      gate({ AOI_AUTONOMY_FIELD_SHADOW_CAPTURE: '1' }, 'AOI_AUTONOMY_FIELD_SHADOW_CAPTURE'),
    ).toBe(false);
    expect(
      gate({ AOI_AUTONOMY_FIELD_SHADOW_CAPTURE: 'off' }, 'AOI_AUTONOMY_FIELD_SHADOW_CAPTURE'),
    ).toBe(false);
  });

  it('covers exactly the gates that must never become app-settable', () => {
    const keys = describeAoiEnvOnlyAutonomyGates({}).map((entry) => entry.key);
    expect(keys).toEqual([
      'AOI_AUTONOMY_AUTO_PROMOTE',
      'AOI_AUTONOMY_AUTO_PROMOTE_LOW_TIER',
      'AOI_AUTONOMY_APPROVAL_TTL',
      'AOI_MCP_SIDE_EFFECTING_RPC',
      'AOI_AUTONOMY_BACKGROUND',
      'AOI_AUTONOMY_BACKGROUND_ALLOW_NETWORK',
      'AOI_AUTONOMY_FIELD_SHADOW_CAPTURE',
    ]);
  });
});
