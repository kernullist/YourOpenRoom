import * as fs from 'fs';

import {
  normalizeAoiAutonomyCapabilitiesConfig,
  type AoiAutonomyCapabilitiesConfig,
} from './configPersistence';

// Single resolver for the autonomy CAPABILITY settings (self-execute, live
// app-operation dispatch, proactive push, goal synthesis, idle confidence surge).
//
// These used to be env-var only, so the Autonomy panel showed a system that
// looked configurable while the capabilities behind it could only be turned on
// by editing system environment variables and restarting. The settings UI now
// writes them into config.json (field: aoiAutonomyCapabilities) and this resolver
// decides the effective values:
//
//   explicit config field  >  env var  >  built-in default (off)
//
// A field ABSENT from the config block hands the decision to the env var, so an
// existing headless deployment keeps working untouched; once the operator flips
// a toggle in the UI, that field wins for good.
//
// What this resolver deliberately does NOT cover, so it cannot be flipped from
// inside the app: AOI_AUTONOMY_AUTO_PROMOTE (raises Aoi's own trust level),
// AOI_AUTONOMY_APPROVAL_TTL (widens the fresh-approval window for irreversible
// actions), AOI_MCP_SIDE_EFFECTING_RPC (env-only by explicit design), and the
// AOI_AUTONOMY_BACKGROUND* hard-off ceilings. Those are trust escalation and
// approval weakening, not capability enablement.

export type AoiAutonomyCapabilitySource = 'config' | 'env' | 'default';

export interface AoiAutonomyCapabilitySettings {
  selfExecute: boolean;
  appOpLiveDispatch: boolean;
  // Empty string means "no push transport configured", which is the off state.
  pushWebhookUrl: string;
  goalSynthesis: boolean;
  idleConfidenceSurge: boolean;
  // Which side decided each one, for an honest UI ("on via environment").
  sources: {
    selfExecute: AoiAutonomyCapabilitySource;
    appOpLiveDispatch: AoiAutonomyCapabilitySource;
    pushWebhookUrl: AoiAutonomyCapabilitySource;
    goalSynthesis: AoiAutonomyCapabilitySource;
    idleConfidenceSurge: AoiAutonomyCapabilitySource;
  };
}

// Every capability explicitly off. Used when the operator's decisions exist but
// cannot be read: falling back to the env there would discard an explicit OFF
// and let a deployment env var turn the capability back on.
const ALL_CAPABILITIES_OFF: AoiAutonomyCapabilitiesConfig = {
  version: 1,
  selfExecuteEnabled: false,
  appOpLiveDispatchEnabled: false,
  pushWebhookUrl: '',
  goalSynthesisEnabled: false,
  idleConfidenceSurgeEnabled: false,
};

export function readAoiAutonomyCapabilitiesConfigFromFile(
  configFile: string | undefined,
): AoiAutonomyCapabilitiesConfig | null {
  if (!configFile) {
    return null;
  }
  // A file that does not exist is not a failure: it is the headless case, and
  // null hands every field to the env fallback.
  if (!fs.existsSync(configFile)) {
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(configFile, 'utf-8')) as {
      aoiAutonomyCapabilities?: unknown;
    } | null;
    const raw =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed.aoiAutonomyCapabilities
        : null;
    return normalizeAoiAutonomyCapabilitiesConfig(
      raw as Partial<AoiAutonomyCapabilitiesConfig> | null,
    );
  } catch {
    // The file EXISTS but could not be read or parsed, so the operator's
    // decisions are there and we cannot see them. Fail closed.
    return ALL_CAPABILITIES_OFF;
  }
}

// Self-execute and live dispatch have always accepted a strict '1' only -- not
// 'true'/'yes' like the background flag. That is preserved exactly: loosening it
// here would silently enable a capability on a deployment that wrote 'true'
// expecting nothing to happen.
function parseStrictOneEnv(value: string | undefined): boolean {
  return value === '1';
}

function parseBoolEnv(value: string | undefined): boolean {
  return value === '1' || value === 'true' || value === 'yes';
}

export function resolveAoiAutonomyCapabilitySettings(params: {
  config?: AoiAutonomyCapabilitiesConfig | null;
  env?: Record<string, string | undefined>;
}): AoiAutonomyCapabilitySettings {
  const config = normalizeAoiAutonomyCapabilitiesConfig(params.config);
  const env = params.env ?? process.env;

  const envSelfExecute = parseStrictOneEnv(env.AOI_AUTONOMY_SELF_EXECUTE);
  const envAppOpLiveDispatch = parseStrictOneEnv(env.AOI_AUTONOMY_APP_OP_LIVE_DISPATCH);
  const envPushWebhookUrl =
    typeof env.AOI_PUSH_WEBHOOK_URL === 'string' ? env.AOI_PUSH_WEBHOOK_URL.trim() : '';
  const envGoalSynthesis = parseBoolEnv(env.AOI_AUTONOMY_GOAL_SYNTHESIS);
  const envIdleConfidenceSurge = parseBoolEnv(env.AOI_AUTONOMY_IDLE_CONFIDENCE_SURGE);

  // 'config' whenever the field is PRESENT, including when it is explicitly off
  // or an empty URL -- the operator deciding "off" here has to be visible, and
  // has to beat an env var that says on.
  const decide = (fromConfig: boolean, fromEnv: boolean): AoiAutonomyCapabilitySource => {
    if (fromConfig) {
      return 'config';
    }
    return fromEnv ? 'env' : 'default';
  };

  return {
    selfExecute: config?.selfExecuteEnabled ?? envSelfExecute,
    appOpLiveDispatch: config?.appOpLiveDispatchEnabled ?? envAppOpLiveDispatch,
    pushWebhookUrl: config?.pushWebhookUrl ?? envPushWebhookUrl,
    goalSynthesis: config?.goalSynthesisEnabled ?? envGoalSynthesis,
    idleConfidenceSurge: config?.idleConfidenceSurgeEnabled ?? envIdleConfidenceSurge,
    sources: {
      selfExecute: decide(config?.selfExecuteEnabled !== undefined, envSelfExecute),
      appOpLiveDispatch: decide(
        config?.appOpLiveDispatchEnabled !== undefined,
        envAppOpLiveDispatch,
      ),
      pushWebhookUrl: decide(config?.pushWebhookUrl !== undefined, envPushWebhookUrl.length > 0),
      goalSynthesis: decide(config?.goalSynthesisEnabled !== undefined, envGoalSynthesis),
      idleConfidenceSurge: decide(
        config?.idleConfidenceSurgeEnabled !== undefined,
        envIdleConfidenceSurge,
      ),
    },
  };
}

// Read-modify-write just this block, preserving every other persisted setting.
// Atomic temp+rename so a crash mid-write cannot truncate the operator's whole
// config. Passing null clears the block, handing every field back to the env.
export function writeAoiAutonomyCapabilitiesConfigToFile(
  configFile: string,
  config: AoiAutonomyCapabilitiesConfig | null,
): void {
  let existing: Record<string, unknown> = {};
  try {
    if (fs.existsSync(configFile)) {
      const parsed = JSON.parse(fs.readFileSync(configFile, 'utf-8')) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
      }
    }
  } catch {
    // A malformed config file must not be silently replaced with just this
    // block -- that would drop the operator's keys.
    throw new Error('config.json could not be read; refusing to overwrite it.');
  }

  const next: Record<string, unknown> = { ...existing };
  if (config) {
    // MERGE, not replace. A body carrying one field must change only that field:
    // replacing the block would drop the operator's other explicit decisions, and
    // a dropped field falls back to the env var -- so a partial save could
    // silently re-enable something that had been deliberately turned off.
    const current = normalizeAoiAutonomyCapabilitiesConfig(
      (existing as { aoiAutonomyCapabilities?: Partial<AoiAutonomyCapabilitiesConfig> })
        .aoiAutonomyCapabilities,
    );
    next.aoiAutonomyCapabilities = { ...(current ?? {}), ...config, version: 1 };
  } else {
    delete next.aoiAutonomyCapabilities;
  }

  // Per-process temp name: a fixed one lets two concurrent writers scribble over
  // each other's temp file and rename the result into place.
  const tmp = `${configFile}.tmp-autonomy-capabilities-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
  fs.renameSync(tmp, configFile);
}

// Convenience for server callers that only have the config file path.
export function loadAoiAutonomyCapabilitySettings(params: {
  configFile?: string;
  env?: Record<string, string | undefined>;
}): AoiAutonomyCapabilitySettings {
  return resolveAoiAutonomyCapabilitySettings({
    config: readAoiAutonomyCapabilitiesConfigFromFile(params.configFile),
    ...(params.env ? { env: params.env } : {}),
  });
}
