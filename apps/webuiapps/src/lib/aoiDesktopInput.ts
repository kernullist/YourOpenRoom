// Aoi desktop input (DI1): the daemon side of tools/aoi-desktop-input.
//
// Aoi could see the desktop (desktop-activity, screen-vision) but not touch it.
// This is the acting half: enumerate windows, snapshot a window's interactable
// elements, and drive one of them through Windows UI Automation.
//
// The native helper is a separate one-shot process (crash isolation + privilege
// separation, and nothing resident sits around holding an input capability). It
// emits the SAME verdict vocabulary as browser-drive, so this module parses its
// output with parseAoiBrowserDriveVerdict rather than growing a second dialect:
// one question, one answer shape, whichever surface Aoi acted on.
//
// Authorization model (chosen by the operator): the kill-switch toggle IS the
// stored approval. Once os_desktop_input is on, Aoi acts without a per-action
// inbox click -- the operator explicitly asked not to be asked every time. The
// SendInput rung is a SEPARATE toggle, because that one moves the real mouse and
// cannot be verified; leaving it off keeps Aoi on the rung that can prove what it
// did. Both default OFF, both are killed by global panic.
//
// Server-only (child_process/fs). The pure parts (request parsing, result
// mapping, helper resolution) are exported so the policy is testable without
// spawning anything.
import * as fs from 'fs';
import { resolve } from 'path';
import { spawnSync } from 'child_process';
import { parseAoiBrowserDriveVerdict, type AoiBrowserDriveVerdict } from './aoiBrowserDriveVerdict';

// Kill-switch capability: snapshot + drive through UIA patterns. Default OFF.
export const AOI_DESKTOP_INPUT_CAPABILITY = 'os_desktop_input';
// Kill-switch capability for the SendInput rung ONLY. Default OFF, and never
// implied by the one above -- taking over the mouse is its own decision.
export const AOI_DESKTOP_INPUT_FOREGROUND_CAPABILITY = 'os_desktop_input_foreground';

const HOST_BRIDGE_DIR = 'host-bridge';
const HELPER_FILE = 'aoi_desktop_input.exe';
// The helper is bounded internally; this is the outer stop so a wedged UIA call
// cannot hold a daemon request open.
const HELPER_TIMEOUT_MS = 20_000;
const MAX_VALUE_CHARS = 4096;
const HWND_PATTERN = /^0x[0-9a-f]{1,16}$/i;
const SNAPSHOT_ID_PATTERN = /^dis-[0-9a-f]{8}$/;

export type AoiDesktopInputOp = 'list_windows' | 'snapshot' | 'invoke' | 'set_value';

export interface AoiDesktopInputRequest {
  op: AoiDesktopInputOp;
  hwnd?: string;
  ref?: number;
  snapshotId?: string;
  value?: string;
  // Opt in to the SendInput rung. Honored only when the separate foreground
  // capability is also enabled; the route enforces that, not this parser.
  allowForeground?: boolean;
}

export interface AoiDesktopInputWindow {
  hwnd: string;
  title: string;
  process: string;
}

export interface AoiDesktopInputElement {
  ref: number;
  role: string;
  name: string;
  automationId: string;
  enabled: boolean;
  sensitive: boolean;
}

export interface AoiDesktopInputSnapshot {
  snapshotId: string;
  // 'ok' | 'no_interactable_elements' | 'no_automation_tree' -- an empty list is
  // ambiguous and the helper says which kind of empty it is.
  note: string;
  elements: AoiDesktopInputElement[];
}

export interface AoiDesktopInputActResult {
  ok: boolean;
  verdict: AoiBrowserDriveVerdict;
  // Which rung ran: uia_invoke | uia_value | sendinput. Absent on refusals,
  // because a refusal means no rung ran at all.
  path?: string;
  detail: string;
}

export type AoiDesktopInputResult =
  | { kind: 'windows'; windows: AoiDesktopInputWindow[] }
  | { kind: 'snapshot'; snapshot: AoiDesktopInputSnapshot }
  | { kind: 'act'; act: AoiDesktopInputActResult }
  | { kind: 'error'; code: string; detail: string };

// Injected seam so the policy can be tested without a desktop.
export interface AoiDesktopInputSpawnOutcome {
  status: number | null;
  stdout: string;
  stderr: string;
}
export type AoiDesktopInputSpawn = (
  helperPath: string,
  args: string[],
  stdin: string,
) => AoiDesktopInputSpawnOutcome;

// --- Request parsing ---------------------------------------------------------

function readString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Parse and validate a desktop-input request.
 *
 * Fail-closed: an unknown op, a malformed handle, or an act with no snapshot id
 * yields null rather than a partially-filled request. A ref is only meaningful
 * paired with the snapshot that minted it, so the two are required together --
 * the helper refuses a mismatch anyway, but a request that cannot possibly
 * succeed should not reach the spawn boundary.
 */
export function parseAoiDesktopInputRequest(
  body: Record<string, unknown>,
): AoiDesktopInputRequest | null {
  const op = readString(body, 'op');
  if (op === 'list_windows') {
    return { op: 'list_windows' };
  }

  const hwnd = readString(body, 'hwnd');
  if (!HWND_PATTERN.test(hwnd)) {
    return null;
  }

  if (op === 'snapshot') {
    return { op: 'snapshot', hwnd };
  }

  if (op !== 'invoke' && op !== 'set_value') {
    return null;
  }

  const ref = body.ref;
  if (typeof ref !== 'number' || !Number.isInteger(ref) || ref < 1 || ref > 10_000) {
    return null;
  }
  const snapshotId = readString(body, 'snapshotId');
  if (!SNAPSHOT_ID_PATTERN.test(snapshotId)) {
    return null;
  }

  const request: AoiDesktopInputRequest = {
    op,
    hwnd,
    ref,
    snapshotId,
    allowForeground: body.allowForeground === true,
  };

  if (op === 'set_value') {
    const value = body.value;
    if (typeof value !== 'string' || value.length > MAX_VALUE_CHARS) {
      return null;
    }
    request.value = value;
  }
  return request;
}

// --- Helper resolution -------------------------------------------------------

/**
 * Where the native helper lives.
 *
 * An explicit env override wins (that is how the daemon is pointed at a build
 * tree); otherwise it is the installed copy under the host-bridge directory.
 * Returns null when nothing is there, so the route can say "not installed"
 * instead of failing to spawn a path that never existed.
 */
export function resolveAoiDesktopInputHelperPath(
  openroomHome: string,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const override =
    typeof env.AOI_DESKTOP_INPUT_HELPER === 'string' ? env.AOI_DESKTOP_INPUT_HELPER.trim() : '';
  const candidate = override || resolve(openroomHome, HOST_BRIDGE_DIR, HELPER_FILE);
  try {
    return fs.statSync(candidate).isFile() ? candidate : null;
  } catch {
    return null;
  }
}

// --- Result mapping ----------------------------------------------------------

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function mapWindows(raw: Record<string, unknown>): AoiDesktopInputWindow[] {
  const list = Array.isArray(raw.windows) ? raw.windows : [];
  const windows: AoiDesktopInputWindow[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const item = entry as Record<string, unknown>;
    const hwnd = typeof item.hwnd === 'string' ? item.hwnd : '';
    if (!HWND_PATTERN.test(hwnd)) {
      continue;
    }
    windows.push({
      hwnd,
      title: typeof item.title === 'string' ? item.title.slice(0, 200) : '',
      process: typeof item.process === 'string' ? item.process.slice(0, 120) : '',
    });
  }
  return windows;
}

function mapSnapshot(raw: Record<string, unknown>): AoiDesktopInputSnapshot | null {
  const snapshotId = typeof raw.snapshotId === 'string' ? raw.snapshotId : '';
  if (!SNAPSHOT_ID_PATTERN.test(snapshotId)) {
    return null;
  }
  const list = Array.isArray(raw.elements) ? raw.elements : [];
  const elements: AoiDesktopInputElement[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const item = entry as Record<string, unknown>;
    if (typeof item.ref !== 'number' || !Number.isInteger(item.ref)) {
      continue;
    }
    elements.push({
      ref: item.ref,
      role: typeof item.role === 'string' ? item.role : 'other',
      name: typeof item.name === 'string' ? item.name.slice(0, 120) : '',
      automationId: typeof item.automationId === 'string' ? item.automationId.slice(0, 120) : '',
      enabled: item.enabled === true,
      // Absent/garbled reads as sensitive: the safe default for "should Aoi
      // touch this" is no.
      sensitive: item.sensitive !== false,
    });
  }
  return {
    snapshotId,
    note: typeof raw.note === 'string' ? raw.note : 'ok',
    elements,
  };
}

/**
 * Map one helper reply to an act result.
 *
 * The helper is a trust boundary like any other: its output decides whether Aoi
 * may say the action happened, so a reply that does not carry a well-formed
 * verdict is treated as unproven rather than believed. Note what is NOT done
 * here -- ok:true is never promoted to "it worked". Transport is transport.
 */
export function mapAoiDesktopInputActReply(raw: Record<string, unknown>): AoiDesktopInputActResult {
  const detail = typeof raw.detail === 'string' ? raw.detail.slice(0, 400) : '';
  const verdict = parseAoiBrowserDriveVerdict(raw);
  if (!verdict) {
    return {
      ok: false,
      verdict: { effect: 'unverifiable', verified: false },
      detail: detail || 'the helper returned no usable verdict',
    };
  }
  const result: AoiDesktopInputActResult = {
    ok: raw.ok === true,
    verdict,
    detail,
  };
  // A refusal names no path because no rung ran.
  if (typeof raw.path === 'string' && raw.path.trim()) {
    result.path = raw.path.trim().slice(0, 40);
  }
  return result;
}

// --- Runner ------------------------------------------------------------------

function defaultSpawn(
  helperPath: string,
  args: string[],
  stdin: string,
): AoiDesktopInputSpawnOutcome {
  const outcome = spawnSync(helperPath, args, {
    input: stdin,
    encoding: 'utf-8',
    windowsHide: true,
    timeout: HELPER_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
  });
  return {
    status: typeof outcome.status === 'number' ? outcome.status : null,
    stdout: typeof outcome.stdout === 'string' ? outcome.stdout : '',
    stderr: typeof outcome.stderr === 'string' ? outcome.stderr : '',
  };
}

export interface RunAoiDesktopInputParams {
  request: AoiDesktopInputRequest;
  openroomHome: string;
  // Whether the separate foreground capability is enabled. The request may ASK
  // for the SendInput rung; only this decides whether it gets it.
  foregroundAllowed: boolean;
  spawnImpl?: AoiDesktopInputSpawn;
  env?: Record<string, string | undefined>;
}

/**
 * Run one desktop-input command.
 *
 * The caller has already passed the gate; this resolves the helper, hands it the
 * command on STDIN (so a typed value never lands in a process command line that
 * any other process on the machine can read), and maps the reply.
 */
export function runAoiDesktopInput(params: RunAoiDesktopInputParams): AoiDesktopInputResult {
  const helperPath = resolveAoiDesktopInputHelperPath(params.openroomHome, params.env);
  if (!helperPath) {
    return {
      kind: 'error',
      code: 'helper_not_installed',
      detail: 'the desktop-input helper is not installed on this machine',
    };
  }

  const { request } = params;
  const command: Record<string, unknown> = { op: request.op };
  if (request.hwnd) {
    command.hwnd = request.hwnd;
  }
  if (typeof request.ref === 'number') {
    command.ref = request.ref;
  }
  if (request.snapshotId) {
    command.snapshotId = request.snapshotId;
  }
  if (typeof request.value === 'string') {
    command.value = request.value;
  }

  const args = ['--stdin'];
  // Asking for the rung is not the same as being allowed it.
  if (request.allowForeground === true && params.foregroundAllowed) {
    args.push('--allow-foreground');
  }

  const spawnImpl = params.spawnImpl ?? defaultSpawn;
  let outcome: AoiDesktopInputSpawnOutcome;
  try {
    outcome = spawnImpl(helperPath, args, JSON.stringify(command));
  } catch (error) {
    return {
      kind: 'error',
      code: 'helper_spawn_failed',
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  const raw = parseJsonObject(outcome.stdout);
  if (!raw) {
    return {
      kind: 'error',
      code: 'helper_no_reply',
      detail: outcome.stderr.trim().slice(0, 400) || 'the helper produced no parseable reply',
    };
  }

  if (request.op === 'list_windows') {
    if (raw.ok !== true) {
      return {
        kind: 'error',
        code: typeof raw.code === 'string' ? raw.code : 'list_failed',
        detail: typeof raw.detail === 'string' ? raw.detail : '',
      };
    }
    return { kind: 'windows', windows: mapWindows(raw) };
  }

  if (request.op === 'snapshot') {
    const snapshot = raw.ok === true ? mapSnapshot(raw) : null;
    if (!snapshot) {
      return {
        kind: 'error',
        code: typeof raw.code === 'string' ? raw.code : 'snapshot_failed',
        detail: typeof raw.detail === 'string' ? raw.detail : '',
      };
    }
    return { kind: 'snapshot', snapshot };
  }

  return { kind: 'act', act: mapAoiDesktopInputActReply(raw) };
}
