// The autonomy gates that stay ENVIRONMENT-ONLY on purpose, described for a
// read-only status display.
//
// Capability enablement moved into the settings UI (aoiAutonomyCapabilitySettings).
// These did not, and the line is deliberate: they either raise Aoi's own trust
// level, weaken the approval an irreversible action needs, or are a hard ceiling
// the deployment puts over everything the app can decide. Letting the app flip
// them would change the safety posture rather than its accessibility -- and an
// operator with the app open is exactly who must not be able to.
//
// Showing them is still worth it: an operator staring at a panel of toggles has
// no other way to tell whether trust promotion is running or whether a hard-off
// ceiling is quietly overriding everything they just set.

export interface AoiAutonomyEnvOnlyGate {
  key: string;
  label: string;
  detail: string;
  on: boolean;
}

// Mirrors aoiMcpConnectorsConfigFile: '1' | 'true' | 'yes' | 'on'.
function parseMcpStyleEnv(value: string | undefined): boolean {
  const raw = (value ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

// Each entry reproduces its own gate's parsing EXACTLY rather than guessing a
// shared convention -- these vars deliberately differ, and a status line that
// disagrees with the gate it reports is worse than no status line.
export function describeAoiEnvOnlyAutonomyGates(
  env: Record<string, string | undefined>,
): AoiAutonomyEnvOnlyGate[] {
  return [
    {
      key: 'AOI_AUTONOMY_AUTO_PROMOTE',
      label: 'Automatic trust promotion',
      detail: 'Lets earned readiness raise the autonomy level on its own (capped at L4).',
      on: env.AOI_AUTONOMY_AUTO_PROMOTE === '1',
    },
    {
      key: 'AOI_AUTONOMY_AUTO_PROMOTE_LOW_TIER',
      label: 'Automatic promotion, low tiers',
      detail: 'Extends automatic promotion to the low tiers (capped at L3).',
      on: env.AOI_AUTONOMY_AUTO_PROMOTE_LOW_TIER === '1',
    },
    {
      key: 'AOI_AUTONOMY_APPROVAL_TTL',
      label: 'Standing approval window',
      detail:
        'Lets one approval cover repeat executions for a while instead of requiring a fresh click.',
      on: env.AOI_AUTONOMY_APPROVAL_TTL === '1',
    },
    {
      key: 'AOI_MCP_SIDE_EFFECTING_RPC',
      label: 'Side-effecting MCP calls',
      detail: 'Unlocks connector calls that change remote state. Env-only by design.',
      on: parseMcpStyleEnv(env.AOI_MCP_SIDE_EFFECTING_RPC),
    },
    {
      key: 'AOI_AUTONOMY_BACKGROUND',
      label: 'Background loop hard-off',
      detail: 'Set to 0 to stop the loop from starting at all, whatever the settings say.',
      on: isHardOff(env.AOI_AUTONOMY_BACKGROUND),
    },
    {
      key: 'AOI_AUTONOMY_BACKGROUND_ALLOW_NETWORK',
      label: 'Network hard-off',
      detail: 'Blocks all autonomy network access, whatever the policy says.',
      // Mirrors parseBoolEnvTristate: unset means "no ceiling", and ANY other
      // non-truthy value blocks -- including 'false', 'off', and a typo. Reading
      // only '0' here would report "not blocking" for a deployment whose network
      // is in fact hard-off.
      on: isNetworkCeilingBlocking(env.AOI_AUTONOMY_BACKGROUND_ALLOW_NETWORK),
    },
    {
      key: 'AOI_AUTONOMY_FIELD_SHADOW_CAPTURE',
      label: 'Field-shadow capture hard-off',
      detail: 'Blocks field-shadow capture, whatever the policy says.',
      on: isHardOff(env.AOI_AUTONOMY_FIELD_SHADOW_CAPTURE),
    },
  ];
}

// The background flag and the field-shadow ceiling both block on these.
function isHardOff(value: string | undefined): boolean {
  return value === '0' || value === 'false' || value === 'no';
}

// Mirrors parseBoolEnvTristate in aoiAutonomyBackgroundRunner: unset (or empty)
// means no ceiling, a truthy value permits, and anything else is a hard block.
function isNetworkCeilingBlocking(value: string | undefined): boolean {
  if (value === undefined || value.trim() === '') {
    return false;
  }
  return !(value === '1' || value === 'true' || value === 'yes');
}
