// "Wake Aoi into active-assistant mode" -- the Tier 1-3 ignition.
//
// Out of the box every autonomy layer is OFF (policy.enabled=false): Aoi is inert. This turns on
// the SAFE active tier -- it proposes, reaches out, reasons, and starts earning trust -- while
// keeping EVERY real action behind human approval. It provably cannot enable autonomous
// self-execution (Tier 4): that is gated by the AOI_AUTONOMY_SELF_EXECUTE env var + trusted_operator
// readiness, both entirely outside the policy, so no policy value can reach it.
//
// The preset also FORCES the supervised-safety invariants on regardless of the caller's base, so
// "active" is, by construction, not "autonomous":
//   * previewMode: true               -- prepare/preview only, never auto-apply
//   * requireApprovalForHighRisk: true -- a human always clears high-risk
//   * requireEvidenceRefs: true        -- every proposal must cite evidence
// allowNetwork + level are left at the caller's base: outward web-scouting and higher autonomy
// levels are separate, deliberate opt-ins, not part of waking up.
import { DEFAULT_AOI_AUTONOMY_POLICY } from './aoiAutonomyPolicy';
import { loadAoiAutonomyPolicy, saveAoiAutonomyPolicy } from './aoiAutonomyStore';
import type { AoiAutonomyPolicy } from './aoiAutonomyTypes';

export function buildAoiActiveAssistantPolicy(
  base: AoiAutonomyPolicy = DEFAULT_AOI_AUTONOMY_POLICY,
): AoiAutonomyPolicy {
  return {
    ...base,
    // Wake the Tier 1-3 layers.
    enabled: true, // the master engine switch
    proactiveSuggestionsEnabled: true, // proactivity
    agenticReflectionEnabled: true, // cognition / reason-act-observe loop (read-only tools)
    fieldShadowCaptureEnabled: true, // trust accrual -- observation only, feeds the readiness ladder
    proactiveBriefing: {
      ...base.proactiveBriefing,
      enabled: true,
      directChatHookOptIn: true, // proactive contact; delivery loudness still governed by readiness
    },
    // Force the supervised-safety invariants -- never weakened by waking up.
    previewMode: true,
    requireApprovalForHighRisk: true,
    requireEvidenceRefs: true,
  };
}

// The reverse switch: flip off exactly the layers ignition turned on, preserving the caller's
// other tuning. A dormant Aoi proposes/executes/observes nothing.
export function buildAoiDormantPolicy(
  base: AoiAutonomyPolicy = DEFAULT_AOI_AUTONOMY_POLICY,
): AoiAutonomyPolicy {
  return {
    ...base,
    enabled: false,
    proactiveSuggestionsEnabled: false,
    agenticReflectionEnabled: false,
    fieldShadowCaptureEnabled: false,
    proactiveBriefing: {
      ...base.proactiveBriefing,
      enabled: false,
    },
  };
}

export interface AoiActiveAssistantResult {
  sessionPath: string;
  policy: AoiAutonomyPolicy;
  // Whether the engine was already enabled before this call (so a caller can report a no-op).
  wasEnabled: boolean;
}

export function igniteAoiActiveAssistant(params: {
  sessionsDir: string;
  sessionPath: string;
  now?: number;
}): AoiActiveAssistantResult {
  const current = loadAoiAutonomyPolicy(params.sessionsDir, params.sessionPath);
  const policy = saveAoiAutonomyPolicy(
    params.sessionsDir,
    params.sessionPath,
    buildAoiActiveAssistantPolicy(current),
    params.now,
  );
  return { sessionPath: params.sessionPath, policy, wasEnabled: current.enabled === true };
}

export function sleepAoiActiveAssistant(params: {
  sessionsDir: string;
  sessionPath: string;
  now?: number;
}): AoiActiveAssistantResult {
  const current = loadAoiAutonomyPolicy(params.sessionsDir, params.sessionPath);
  const policy = saveAoiAutonomyPolicy(
    params.sessionsDir,
    params.sessionPath,
    buildAoiDormantPolicy(current),
    params.now,
  );
  return { sessionPath: params.sessionPath, policy, wasEnabled: current.enabled === true };
}

export type AoiIgnitionAction = 'ignite' | 'sleep';

export interface AoiIgnitionCommand {
  action: AoiIgnitionAction;
  sessionPath: string;
}

const DEFAULT_IGNITION_SESSION_PATH = 'aoi/default';

// Pure CLI parse: `--ignite [sessionPath]` / `--sleep [sessionPath]` (also accepts `--wake` as an
// alias for ignite). Returns null when neither flag is present, so the daemon entry falls through
// to its normal boot.
export function resolveAoiIgnitionCommand(argv: readonly string[]): AoiIgnitionCommand | null {
  const igniteIndex = argv.findIndex((arg) => arg === '--ignite' || arg === '--wake');
  const sleepIndex = argv.indexOf('--sleep');
  if (igniteIndex < 0 && sleepIndex < 0) {
    return null;
  }
  const action: AoiIgnitionAction =
    sleepIndex >= 0 && sleepIndex > igniteIndex ? 'sleep' : 'ignite';
  const flagIndex = action === 'sleep' ? sleepIndex : igniteIndex;
  const next = argv[flagIndex + 1];
  const sessionPath =
    typeof next === 'string' && next.length > 0 && !next.startsWith('-')
      ? next
      : DEFAULT_IGNITION_SESSION_PATH;
  return { action, sessionPath };
}
