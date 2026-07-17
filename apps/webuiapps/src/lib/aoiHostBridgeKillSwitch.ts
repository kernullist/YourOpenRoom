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
}

export const DEFAULT_AOI_HOST_BRIDGE_KILL_SWITCH_STATE: AoiHostBridgeKillSwitchState = {
  version: AOI_HOST_BRIDGE_KILL_SWITCH_VERSION,
  globalPanic: false,
  entries: {},
  updatedAt: 0,
};

// --- Pure state helpers ------------------------------------------------------

// A capability is allowed ONLY when panic is off AND its key is explicitly
// enabled. Missing key / unknown key => false. This is the load-bearing gate.
export function isAoiHostBridgeCapabilityEnabled(
  state: AoiHostBridgeKillSwitchState | null | undefined,
  key: string,
): boolean {
  if (!state || state.globalPanic) {
    return false;
  }
  return state.entries[key] === true;
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
  } else {
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
  const entries: Record<string, boolean> = {};
  if (value.entries && typeof value.entries === 'object' && !Array.isArray(value.entries)) {
    for (const [key, enabled] of Object.entries(value.entries)) {
      if (enabled === true && KEY_PATTERN.test(key)) {
        entries[key] = true;
      }
      if (Object.keys(entries).length >= MAX_KILL_SWITCH_ENTRIES) {
        break;
      }
    }
  }
  return {
    version: AOI_HOST_BRIDGE_KILL_SWITCH_VERSION,
    globalPanic: value.globalPanic === true,
    entries,
    updatedAt:
      typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt) ? value.updatedAt : 0,
  };
}

// --- Persistence -------------------------------------------------------------

export function resolveAoiHostBridgeKillSwitchPath(openroomHome: string): string {
  return resolve(openroomHome, HOST_BRIDGE_DIR, KILL_SWITCH_FILE);
}

// Fail-closed load: an unreadable or malformed file yields the all-disabled
// default (entries {}), so a corrupt store grants no capability.
export function loadAoiHostBridgeKillSwitchState(
  openroomHome: string,
): AoiHostBridgeKillSwitchState {
  try {
    const filePath = resolveAoiHostBridgeKillSwitchPath(openroomHome);
    if (!fs.existsSync(filePath)) {
      return { ...DEFAULT_AOI_HOST_BRIDGE_KILL_SWITCH_STATE, entries: {} };
    }
    return normalizeAoiHostBridgeKillSwitchState(JSON.parse(fs.readFileSync(filePath, 'utf-8')));
  } catch {
    return { ...DEFAULT_AOI_HOST_BRIDGE_KILL_SWITCH_STATE, entries: {} };
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
