// Aoi host-bridge kill switch (HP0): the machine-level master gate for every
// real-PC capability (process inspect/spawn/kill, filesystem read/write,
// desktop-activity). It sits ABOVE consent and the capability broker -- the
// first thing every host-bridge request is checked against.
//
// Design (docs/aoi-host-access-design.md):
//   - Machine/daemon scoped, NOT session scoped: PC access is a decision about
//     the physical machine, not a chat session. Stored under ~/.openroom/
//     host-bridge/ so one toggle governs every session's requests.
//   - Fail-closed by construction: a capability is allowed ONLY when it is
//     explicitly enabled AND global panic is off. An absent key, an empty
//     store, or an unreadable file all read as "disabled" -- so a fresh or
//     corrupt store grants nothing.
//   - Global panic is the operator's one-switch stop: it overrides every
//     per-capability enable at once without clearing them, so flipping panic
//     off restores the prior toggles.
//
// Server-only (fs). The pure state helpers are exported separately so the gate
// and the settings UI can reason about the state without the filesystem.
import * as fs from 'fs';
import { dirname, resolve } from 'path';
import { randomUUID } from 'crypto';

export const AOI_HOST_BRIDGE_KILL_SWITCH_VERSION = 1 as const;

/**
 * The single Computer-Use switch: driving windows, seeing them, and driving the
 * operator's own browser.
 *
 * Unlike every other capability here this one DEFAULTS ON. That is a deliberate
 * exception, not a loosening of the rule: the operator asked for one switch for
 * the whole feature, and a feature that must be discovered and enabled before it
 * does anything is a feature that appears broken. Everything underneath it is
 * unchanged -- credential fields are still refused, acts still need per-action
 * approval, refs still fail closed, and global panic still overrides it.
 *
 * What it deliberately does NOT include is anything that takes the machine away
 * from the person at it: the synthetic-mouse rung, standing grants and
 * autonomous multi-act tasks stay separate and stay off. Those are not "use the
 * computer", they are "act unattended", and folding them into a default-on
 * switch would grant them to someone who only wanted the feature to work.
 */
export const AOI_COMPUTER_USE_CAPABILITY = 'os_computer_use';

// Capabilities that are ON until the operator says otherwise. An explicit false
// in the store still wins -- turning something off must stick.
export const AOI_HOST_BRIDGE_DEFAULT_ENABLED_CAPABILITIES: readonly string[] = [
  AOI_COMPUTER_USE_CAPABILITY,
];

const DEFAULT_ENABLED_CAPABILITIES: ReadonlySet<string> = new Set(
  AOI_HOST_BRIDGE_DEFAULT_ENABLED_CAPABILITIES,
);

/** Is this capability on when the store says nothing about it? */
export function isAoiHostBridgeCapabilityDefaultEnabled(key: string): boolean {
  return DEFAULT_ENABLED_CAPABILITIES.has(key);
}

const HOST_BRIDGE_DIR = 'host-bridge';
const KILL_SWITCH_FILE = 'killswitch.json';
// Bound the enable map so a corrupt/hostile file can never balloon the store.
const MAX_KILL_SWITCH_ENTRIES = 64;
const KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface AoiHostBridgeKillSwitchState {
  version: 1;
  // When true, EVERY host-bridge capability is blocked regardless of `entries`.
  globalPanic: boolean;
  // Per-capability / per-source enable flags. Absent key => disabled (fail-closed).
  entries: Record<string, boolean>;
  updatedAt: number;
  // The stored file EXISTS but could not be read.
  //
  // This file is the operator's safety configuration: what Aoi may do on this
  // machine, and whether the emergency stop is engaged. Falling back to defaults
  // when it cannot be read CLEARED AN ENGAGED PANIC and re-enabled every
  // default-on capability -- including computer use, which the operator may have
  // switched off deliberately. Absent and unreadable are not the same state.
  unreadable?: true;
}

export const DEFAULT_AOI_HOST_BRIDGE_KILL_SWITCH_STATE: AoiHostBridgeKillSwitchState = {
  version: AOI_HOST_BRIDGE_KILL_SWITCH_VERSION,
  globalPanic: false,
  entries: {},
  updatedAt: 0,
};

// --- Pure state helpers ------------------------------------------------------

// A capability is allowed ONLY when panic is off AND it is enabled: explicitly
// in the store, or by default for the few keys that ship on. An unknown key is
// still false, and an explicit false still wins over a default -- so turning
// something off sticks, and panic overrides everything.
export function isAoiHostBridgeCapabilityEnabled(
  state: AoiHostBridgeKillSwitchState | null | undefined,
  key: string,
): boolean {
  if (!state) {
    // No store at all: only the default-on set is available, and only because
    // "not configured yet" is not the same as "switched off".
    return isAoiHostBridgeCapabilityDefaultEnabled(key);
  }
  if (state.globalPanic) {
    return false;
  }
  const entry = state.entries[key];
  if (entry === undefined) {
    return isAoiHostBridgeCapabilityDefaultEnabled(key);
  }
  return entry === true;
}

export function setAoiHostBridgeCapability(
  state: AoiHostBridgeKillSwitchState | null | undefined,
  key: string,
  enabled: boolean,
  now: number,
): AoiHostBridgeKillSwitchState {
  const base = normalizeAoiHostBridgeKillSwitchState(state);
  if (!KEY_PATTERN.test(key)) {
    return base;
  }
  const entries = { ...base.entries };
  if (enabled) {
    // Enforce the cap only when ADDING a new key; toggling an existing one is
    // always allowed so a full store can still be turned off.
    if (entries[key] === undefined && Object.keys(entries).length >= MAX_KILL_SWITCH_ENTRIES) {
      return base;
    }
    entries[key] = true;
  } else if (isAoiHostBridgeCapabilityDefaultEnabled(key)) {
    // Record the OFF decision rather than forgetting the key. For a default-on
    // capability, absent means on -- so deleting it here would quietly turn the
    // feature back on the moment the operator switched it off.
    entries[key] = false;
  } else {
    // Everything else is off when absent, so dropping the key keeps the store
    // small and means the same thing.
    delete entries[key];
  }
  return { ...base, entries, updatedAt: now };
}

// Engage panic: block everything at once WITHOUT clearing the per-capability
// enables, so clearing panic restores exactly the prior toggle set.
export function engageAoiHostBridgePanic(
  state: AoiHostBridgeKillSwitchState | null | undefined,
  now: number,
): AoiHostBridgeKillSwitchState {
  return { ...normalizeAoiHostBridgeKillSwitchState(state), globalPanic: true, updatedAt: now };
}

export function clearAoiHostBridgePanic(
  state: AoiHostBridgeKillSwitchState | null | undefined,
  now: number,
): AoiHostBridgeKillSwitchState {
  return { ...normalizeAoiHostBridgeKillSwitchState(state), globalPanic: false, updatedAt: now };
}

export function normalizeAoiHostBridgeKillSwitchState(raw: unknown): AoiHostBridgeKillSwitchState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...DEFAULT_AOI_HOST_BRIDGE_KILL_SWITCH_STATE, entries: {} };
  }
  const value = raw as Partial<AoiHostBridgeKillSwitchState>;
  if (value.version !== AOI_HOST_BRIDGE_KILL_SWITCH_VERSION) {
    return { ...DEFAULT_AOI_HOST_BRIDGE_KILL_SWITCH_STATE, entries: {} };
  }
  // Carried through: every consumer funnels into this, so dropping the flag here
  // would quietly restore the fail-open the loader closes.
  const unreadable = value.unreadable === true ? ({ unreadable: true } as const) : null;
  const entries: Record<string, boolean> = {};
  if (value.entries && typeof value.entries === 'object' && !Array.isArray(value.entries)) {
    for (const [key, enabled] of Object.entries(value.entries)) {
      // Keep an explicit false, not just true. For a default-on capability
      // "absent" means ON, so dropping the false here would silently turn the
      // feature back on the next time the file was read -- the operator's OFF
      // would survive exactly one process lifetime. Anything that is not a
      // boolean is still discarded.
      if (typeof enabled === 'boolean' && KEY_PATTERN.test(key)) {
        entries[key] = enabled;
      }
      if (Object.keys(entries).length >= MAX_KILL_SWITCH_ENTRIES) {
        break;
      }
    }
  }
  return {
    version: AOI_HOST_BRIDGE_KILL_SWITCH_VERSION,
    // An unreadable state stays stopped through normalize, so a consumer that
    // normalizes before deciding cannot lose the stop.
    globalPanic: value.globalPanic === true || unreadable !== null,
    entries,
    updatedAt:
      typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt) ? value.updatedAt : 0,
    ...(unreadable ?? {}),
  };
}

// --- Persistence -------------------------------------------------------------

export function resolveAoiHostBridgeKillSwitchPath(openroomHome: string): string {
  return resolve(openroomHome, HOST_BRIDGE_DIR, KILL_SWITCH_FILE);
}

// Fail-closed load: an unreadable or malformed file yields the all-disabled
// default (entries {}), so a corrupt store grants no capability.
// Cannot read the safety configuration => the machine is stopped.
//
// globalPanic is set, not merely reported, so that every existing panic check
// inherits this without having to know about it -- the alternative is a second
// condition that each call site has to remember, and the ones that forgot would
// be the ones that mattered. `unreadable` rides along so the operator is told
// the stop came from an unreadable file rather than from their own panic press.
function unreadableKillSwitchState(): AoiHostBridgeKillSwitchState {
  return {
    ...DEFAULT_AOI_HOST_BRIDGE_KILL_SWITCH_STATE,
    entries: {},
    globalPanic: true,
    unreadable: true,
  };
}

export function loadAoiHostBridgeKillSwitchState(
  openroomHome: string,
): AoiHostBridgeKillSwitchState {
  try {
    const filePath = resolveAoiHostBridgeKillSwitchPath(openroomHome);
    if (!fs.existsSync(filePath)) {
      // Never configured. The one honest empty: a fresh install has to get its
      // defaults or nothing works until something is written.
      return { ...DEFAULT_AOI_HOST_BRIDGE_KILL_SWITCH_STATE, entries: {} };
    }
    const raw: unknown = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const shaped =
      !!raw &&
      typeof raw === 'object' &&
      !Array.isArray(raw) &&
      (raw as Partial<AoiHostBridgeKillSwitchState>).version ===
        AOI_HOST_BRIDGE_KILL_SWITCH_VERSION;
    if (!shaped) {
      return unreadableKillSwitchState();
    }
    return normalizeAoiHostBridgeKillSwitchState(raw);
  } catch {
    // Present and unreadable: bad JSON, a truncated write, a denied permission.
    return unreadableKillSwitchState();
  }
}

export function saveAoiHostBridgeKillSwitchState(
  openroomHome: string,
  state: AoiHostBridgeKillSwitchState,
): AoiHostBridgeKillSwitchState {
  const normalized = normalizeAoiHostBridgeKillSwitchState(state);
  const filePath = resolveAoiHostBridgeKillSwitchPath(openroomHome);
  fs.mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf-8');
  fs.renameSync(tmpPath, filePath);
  return normalized;
}
