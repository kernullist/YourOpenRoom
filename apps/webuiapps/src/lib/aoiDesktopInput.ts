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
import { spawn } from 'child_process';
import { parseAoiBrowserDriveVerdict, type AoiBrowserDriveVerdict } from './aoiBrowserDriveVerdict';
import { loadAoiBrowserDriveAllowlist } from './aoiBrowserDriveAllowlist';

// Kill-switch capability: snapshot + drive through UIA patterns. Default OFF.
export const AOI_DESKTOP_INPUT_CAPABILITY = 'os_desktop_input';
// Kill-switch capability for the SendInput rung ONLY. Default OFF, and never
// implied by the one above -- taking over the mouse is its own decision.
export const AOI_DESKTOP_INPUT_FOREGROUND_CAPABILITY = 'os_desktop_input_foreground';
// Kill-switch capability for CAPTURE, which is its own decision. Everything else
// here returns the names of controls; capture returns a picture of whatever is
// on that window, and it goes to whichever model the operator has configured.
// There is no redacting a screenshot, so this is not folded into desktop input
// generally. Default OFF.
export const AOI_DESKTOP_CAPTURE_CAPABILITY = 'os_desktop_capture';

const HOST_BRIDGE_DIR = 'host-bridge';
const HELPER_FILE = 'aoi_desktop_input.exe';
// The helper is bounded internally; this is the outer stop so a wedged UIA call
// cannot hold a daemon request open.
const HELPER_TIMEOUT_MS = 20_000;
const MAX_VALUE_CHARS = 4096;
const HWND_PATTERN = /^0x[0-9a-f]{1,16}$/i;
const SNAPSHOT_ID_PATTERN = /^dis-[0-9a-f]{8}$/;

export type AoiDesktopInputOp =
  | 'list_windows'
  | 'list_apps'
  | 'snapshot'
  | 'invoke'
  | 'set_value'
  | 'click'
  | 'scroll'
  | 'key'
  | 'type'
  | 'drag'
  | 'focus'
  | 'select'
  | 'toggle'
  | 'capture';

// Which rung to use. 'auto' walks them weakest-side-effect first; naming one
// pins it, and a pinned rung that cannot run refuses instead of quietly falling
// through to a more invasive one.
export type AoiDesktopInputDelivery = 'auto' | 'background' | 'foreground';

export interface AoiDesktopInputRequest {
  op: AoiDesktopInputOp;
  hwnd?: string;
  ref?: number;
  snapshotId?: string;
  value?: string;
  delivery?: AoiDesktopInputDelivery;
  button?: string;
  clicks?: number;
  modifiers?: string;
  direction?: string;
  amount?: number;
  keys?: string;
  text?: string;
  toRef?: number;
  option?: string;
  state?: string;
  x?: number;
  y?: number;
  // Where x/y are measured from. 'window' is the window rectangle's top-left,
  // frame included -- the space a desktop_capture picture is in, so a point read
  // off it lands where it was seen. 'client' (the default) is the client area.
  space?: 'window' | 'client';
  // The window size the picture was taken at. The helper refuses the point if
  // the window has since been resized, because it no longer matches the picture.
  windowWidth?: number;
  windowHeight?: number;
  mode?: string;
  maxLongSide?: number;
  // Cap on the picture's SHORT side. Some providers shrink any image whose
  // short side is over 768 px, and a re-shrunk picture no longer has the pixels
  // a point was read off.
  maxShortSide?: number;
  // Opt in to the SendInput rung. Honored only when the separate foreground
  // capability is also enabled; the route enforces that, not this parser.
  allowForeground?: boolean;
}

export interface AoiDesktopInputWindow {
  hwnd: string;
  title: string;
  process: string;
}

export interface AoiDesktopInputCapture {
  snapshotId: string;
  // 'som' when controls are numbered on the image, 'plain' when it is just a
  // picture (a window that describes no controls cannot be numbered).
  mode: string;
  width: number;
  height: number;
  // <1 when the image was shrunk to fit the long-side cap.
  scale: number;
  // The window's own size when it was pictured, before shrinking. 0 from a
  // helper that predates these fields.
  windowWidth: number;
  windowHeight: number;
  totalElements: number;
  elements: AoiDesktopInputElement[];
  pngBase64: string;
}

export interface AoiDesktopInputApp {
  process: string;
  windowCount: number;
  sampleTitle: string;
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
  // How many elements the window actually has, and whether the list was cut.
  // A cap that reports nothing reads as "this is all of them".
  totalElements: number;
  truncated: boolean;
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
  | { kind: 'apps'; apps: AoiDesktopInputApp[] }
  | { kind: 'capture'; capture: AoiDesktopInputCapture }
  | { kind: 'snapshot'; snapshot: AoiDesktopInputSnapshot }
  | { kind: 'act'; act: AoiDesktopInputActResult }
  | { kind: 'error'; code: string; detail: string };

// Injected seam so the policy can be tested without a desktop.
export interface AoiDesktopInputSpawnOutcome {
  status: number | null;
  stdout: string;
  stderr: string;
  // The helper ran past HELPER_TIMEOUT_MS and was killed.
  timedOut?: boolean;
}
export type AoiDesktopInputSpawn = (
  helperPath: string,
  args: string[],
  stdin: string,
) => AoiDesktopInputSpawnOutcome | Promise<AoiDesktopInputSpawnOutcome>;

// --- Request parsing ---------------------------------------------------------

function readString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === 'string' ? value.trim() : '';
}

const DELIVERIES: ReadonlySet<string> = new Set(['auto', 'background', 'foreground']);
const BUTTONS: ReadonlySet<string> = new Set(['left', 'right', 'middle']);
const DIRECTIONS: ReadonlySet<string> = new Set(['up', 'down', 'left', 'right']);
// Bounded so a bad number cannot turn one action into a flood of real input.
const MAX_CLICKS = 3;
const MAX_SCROLL = 30;
const MAX_KEYS_CHARS = 64;

/**
 * Parse and validate a desktop-input request.
 *
 * Fail-closed: an unknown op, a malformed handle, or an act with no snapshot id
 * yields null rather than a partially-filled request. A ref is only meaningful
 * paired with the snapshot that minted it, so the two are required together --
 * the helper refuses a mismatch anyway, but a request that cannot possibly
 * succeed should not reach the spawn boundary.
 *
 * Note which ops do NOT take a ref: key, type and focus act on the window, not
 * on an element, because there is no element to aim a keystroke at -- it goes
 * wherever focus already is. Requiring a ref there would be theatre.
 */
export function parseAoiDesktopInputRequest(
  body: Record<string, unknown>,
): AoiDesktopInputRequest | null {
  const op = readString(body, 'op');
  if (op === 'list_windows' || op === 'list_apps') {
    return { op };
  }

  const hwnd = readString(body, 'hwnd');
  if (!HWND_PATTERN.test(hwnd)) {
    return null;
  }

  if (op === 'snapshot' || op === 'focus') {
    return { op, hwnd };
  }

  if (op === 'capture') {
    const mode = readString(body, 'mode') || 'som';
    if (mode !== 'som' && mode !== 'plain') {
      return null;
    }
    const request: AoiDesktopInputRequest = { op, hwnd, mode };
    for (const key of ['maxLongSide', 'maxShortSide'] as const) {
      const cap = body[key];
      if (cap === undefined) {
        continue;
      }
      if (typeof cap !== 'number' || !Number.isInteger(cap) || cap < 200 || cap > 4096) {
        return null;
      }
      request[key] = cap;
    }
    return request;
  }

  const deliveryRaw = readString(body, 'delivery');
  const delivery: AoiDesktopInputDelivery = DELIVERIES.has(deliveryRaw)
    ? (deliveryRaw as AoiDesktopInputDelivery)
    : 'auto';
  // Naming a rung this parser does not know is a request for something specific
  // that would not be honored, so it is refused rather than downgraded to auto.
  if (deliveryRaw && !DELIVERIES.has(deliveryRaw)) {
    return null;
  }
  const allowForeground = body.allowForeground === true;

  // Window-scoped input: no element, because a keystroke goes to whatever holds
  // focus and there is nothing to address.
  if (op === 'key') {
    const keys = readString(body, 'keys');
    if (!keys || keys.length > MAX_KEYS_CHARS) {
      return null;
    }
    return { op, hwnd, keys, delivery, allowForeground };
  }
  if (op === 'type') {
    const text = body.text;
    if (typeof text !== 'string' || !text || text.length > MAX_VALUE_CHARS) {
      return null;
    }
    return { op, hwnd, text, delivery, allowForeground };
  }

  // Coordinate click: the fallback for windows that expose no automation tree,
  // where there is no ref to give. The helper still resolves the point back to
  // whatever element sits there and applies the same credential/disabled
  // checks, so this is a targeting fallback, not a way around the guards.
  if (op === 'click' && typeof body.x === 'number' && typeof body.y === 'number') {
    const x = body.x;
    const y = body.y;
    if (
      !Number.isInteger(x) ||
      !Number.isInteger(y) ||
      x < 0 ||
      y < 0 ||
      x > 32_767 ||
      y > 32_767
    ) {
      return null;
    }
    const request: AoiDesktopInputRequest = { op, hwnd, x, y, delivery, allowForeground };
    const space = body.space;
    if (space !== undefined) {
      if (space !== 'window' && space !== 'client') {
        return null;
      }
      request.space = space;
    }
    for (const key of ['windowWidth', 'windowHeight'] as const) {
      const value = body[key];
      if (value === undefined) {
        continue;
      }
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 16_384) {
        return null;
      }
      request[key] = value;
    }
    const button = readString(body, 'button');
    if (button && !BUTTONS.has(button)) {
      return null;
    }
    if (button) {
      request.button = button;
    }
    const clicks = body.clicks;
    if (clicks !== undefined) {
      if (
        typeof clicks !== 'number' ||
        !Number.isInteger(clicks) ||
        clicks < 1 ||
        clicks > MAX_CLICKS
      ) {
        return null;
      }
      request.clicks = clicks;
    }
    return request;
  }

  const ELEMENT_OPS: ReadonlySet<string> = new Set([
    'invoke',
    'set_value',
    'click',
    'scroll',
    'drag',
    'select',
    'toggle',
  ]);
  if (!ELEMENT_OPS.has(op)) {
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
    op: op as AoiDesktopInputOp,
    hwnd,
    ref,
    snapshotId,
    delivery,
    allowForeground,
  };

  if (op === 'set_value') {
    const value = body.value;
    if (typeof value !== 'string' || value.length > MAX_VALUE_CHARS) {
      return null;
    }
    request.value = value;
    return request;
  }

  if (op === 'click') {
    const button = readString(body, 'button');
    if (button && !BUTTONS.has(button)) {
      return null;
    }
    if (button) {
      request.button = button;
    }
    const clicks = body.clicks;
    if (clicks !== undefined) {
      if (
        typeof clicks !== 'number' ||
        !Number.isInteger(clicks) ||
        clicks < 1 ||
        clicks > MAX_CLICKS
      ) {
        return null;
      }
      request.clicks = clicks;
    }
    const modifiers = body.modifiers;
    if (Array.isArray(modifiers)) {
      request.modifiers = modifiers.filter((entry) => typeof entry === 'string').join('+');
    } else if (typeof modifiers === 'string') {
      request.modifiers = modifiers;
    }
    return request;
  }

  if (op === 'scroll') {
    const direction = readString(body, 'direction');
    if (!DIRECTIONS.has(direction)) {
      return null;
    }
    request.direction = direction;
    const amount = body.amount;
    if (amount !== undefined) {
      if (
        typeof amount !== 'number' ||
        !Number.isInteger(amount) ||
        amount < 1 ||
        amount > MAX_SCROLL
      ) {
        return null;
      }
      request.amount = amount;
    }
    return request;
  }

  if (op === 'select') {
    const option = readString(body, 'option');
    if (!option || option.length > 200) {
      return null;
    }
    request.option = option;
    return request;
  }

  if (op === 'toggle') {
    const state = readString(body, 'state') || 'toggle';
    if (state !== 'on' && state !== 'off' && state !== 'toggle') {
      return null;
    }
    request.state = state;
    return request;
  }

  if (op === 'drag') {
    const toRef = body.toRef;
    if (typeof toRef !== 'number' || !Number.isInteger(toRef) || toRef < 1 || toRef > 10_000) {
      return null;
    }
    request.toRef = toRef;
    return request;
  }

  // invoke: a ref and its snapshot are all it needs.
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
  const totalElements =
    typeof raw.totalElements === 'number' && raw.totalElements >= elements.length
      ? raw.totalElements
      : elements.length;
  return {
    snapshotId,
    note: typeof raw.note === 'string' ? raw.note : 'ok',
    totalElements,
    // Trust the count over the flag: a helper that under-reported truncation
    // would otherwise present a cut list as complete.
    truncated: raw.truncated === true || totalElements > elements.length,
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

// The ops that only read. Every other op changes a window, and runs alone.
const AOI_DESKTOP_INPUT_READ_OPS: ReadonlySet<string> = new Set([
  'list_windows',
  'list_apps',
  'snapshot',
  'capture',
]);

export function isAoiDesktopInputReadOp(op: string): boolean {
  return AOI_DESKTOP_INPUT_READ_OPS.has(op);
}

// How long an act waits for the one ahead of it. Well inside the client's own
// 30 s deadline: an act that runs after its caller has stopped waiting is an
// act nobody is told about.
const ACT_LOCK_WAIT_MS = 5_000;

let actTail: Promise<void> = Promise.resolve();

/**
 * Run one act with no other act in flight.
 *
 * spawnSync used to serialize every helper run by holding the event loop. With
 * the helper asynchronous, two acts -- two open tabs, a cancelled turn's act
 * still running beside a new one -- could interleave: one raising its window
 * while the other's real click lands on it. Reads stay concurrent, since they
 * change nothing. An act that cannot get its turn in time is not run at all.
 */
export async function withAoiDesktopActLock<T>(
  work: () => Promise<T>,
  waitMs = ACT_LOCK_WAIT_MS,
): Promise<{ ran: true; value: T } | { ran: false }> {
  const ahead = actTail;
  let release: () => void = () => undefined;
  const mine = new Promise<void>((resolveTurn) => {
    release = resolveTurn;
  });
  actTail = ahead.then(() => mine);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const gotTurn = await Promise.race([
    ahead.then(() => true),
    new Promise<boolean>((resolveWait) => {
      timer = setTimeout(() => resolveWait(false), waitMs);
    }),
  ]);
  clearTimeout(timer);
  if (!gotTurn) {
    // Giving up still has to free the slot, or every act after this one waits
    // forever behind an act that never runs.
    release();
    return { ran: false };
  }
  try {
    return { ran: true, value: await work() };
  } finally {
    release();
  }
}

// A capture reply carries a base64 PNG, which at the top of the size range runs
// to several megabytes. Past this the reply is cut, and a cut reply no longer
// parses, so the cap only has to stop a runaway helper, not a real capture.
const HELPER_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

// Asynchronous on purpose. spawnSync held the dev server's (or the daemon's)
// event loop for as long as the helper ran -- up to 20 s on a wedged UI
// Automation call -- and that included the kill-switch route, so the panic
// button could not be heard while an action was in flight.
export function spawnAoiDesktopInputHelper(
  helperPath: string,
  args: string[],
  stdin: string,
  timeoutMs = HELPER_TIMEOUT_MS,
  maxOutputBytes = HELPER_MAX_OUTPUT_BYTES,
): Promise<AoiDesktopInputSpawnOutcome> {
  return new Promise((resolveOutcome, rejectOutcome) => {
    const child = spawn(helperPath, args, { windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let timedOut = false;
    let settled = false;

    const collect = (sink: Buffer[]) => (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        child.kill();
        return;
      }
      sink.push(chunk);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.on('error', (error) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        rejectOutcome(error);
      }
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      if (settled) {
        return;
      }
      settled = true;
      resolveOutcome({
        status: typeof status === 'number' ? status : null,
        stdout: Buffer.concat(stdout).toString('utf-8'),
        stderr: Buffer.concat(stderr).toString('utf-8'),
        ...(timedOut ? { timedOut } : {}),
      });
    });

    // The helper reads its command from stdin. A helper that exits before
    // reading it closes the pipe; that surfaces through 'close', not as a crash.
    child.stdin.on('error', () => undefined);
    child.stdin.end(stdin, 'utf-8');
  });
}

// Processes whose windows show CONTENT FROM THE WEB. Snapshotting one returns
// the live page's controls and text; capturing one returns a picture of it.
const AOI_BROWSER_PROCESS_NAMES = new Set([
  'chrome.exe',
  'msedge.exe',
  'firefox.exe',
  'brave.exe',
  'opera.exe',
  'vivaldi.exe',
  'chromium.exe',
  'whale.exe',
]);

/**
 * The browser denylist is containment, and these two ops walked around it.
 *
 * The denylist stops browser-drive from NAVIGATING to a host the operator ruled
 * out. It says nothing about the desktop tools, and a UIA snapshot of a browser
 * window returns the live page's controls and text -- measured, not assumed: a
 * snapshot of a Chrome window comes back with the page's own buttons and links,
 * not just the browser chrome. So an operator who denylisted a site and then had
 * it open in their own browser was still one snapshot away from handing it over.
 *
 * There is nothing to check per-URL here: the UIA tree of a browser window
 * carries no URL at all (also measured -- no edit control, no element whose
 * value is a URL). A containment check that cannot see what it is bounding is
 * worse than none, because it reads as protection.
 *
 * So this refuses the whole read when a denylist exists, and points at the tools
 * that DO enforce it. An empty denylist means the operator ruled nothing out and
 * nothing is refused, so the default posture is unchanged.
 *
 * Only the READ ops. Acting is not exempted by oversight: a click that navigates
 * somewhere denylisted still cannot be read back through either op, so the
 * content never reaches Aoi -- which is what the denylist is protecting.
 */
function refuseBrowserWindowRead(
  op: string,
  processName: string,
  openroomHome: string,
): AoiDesktopInputResult | null {
  if (op !== 'snapshot' && op !== 'capture') {
    return null;
  }
  const name = processName.trim().toLowerCase();
  const isBrowser = AOI_BROWSER_PROCESS_NAMES.has(name);
  // An ABSENT name is not evidence that this is not a browser.
  //
  // The helper is a separately installed copy, so an operator can be running one
  // built before it reported the process at all -- and OpenProcess can fail on a
  // window owned by a more privileged process even with a current helper. Either
  // way the answer is "cannot tell", and treating that as "not a browser" reopens
  // the whole bypass silently, on exactly the machines least able to notice.
  if (!isBrowser && name) {
    return null;
  }
  let contained = true;
  try {
    const denylist = loadAoiBrowserDriveAllowlist(openroomHome);
    // Unreadable counts as configured. A stored list that cannot be read is not
    // an absent one, and this gate exists precisely to respect that list.
    contained = denylist.unreadable === true || denylist.entries.length > 0;
  } catch {
    // Fail closed: if the denylist cannot be read, we cannot claim it is empty.
    contained = true;
  }
  if (!contained) {
    return null;
  }
  if (!isBrowser) {
    return {
      kind: 'error',
      code: 'browser_window_unknown',
      detail:
        'a browser denylist is configured, and this reply does not say which process owns the ' +
        'window -- so it cannot be ruled out that this is a browser showing a denylisted site. ' +
        'Reinstall the desktop-input helper (tools/aoi-desktop-input/Install-AoiDesktopInput.ps1); ' +
        'a current one reports the owning process.',
    };
  }
  return {
    kind: 'error',
    code: 'browser_window_denylisted',
    detail:
      `that window belongs to ${processName}, and a browser denylist is configured. Reading a ` +
      'browser this way returns the live page, and the window exposes no URL to check it ' +
      'against, so the denylist could not be applied. Use the browser tools instead -- they ' +
      'enforce it.',
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
export async function runAoiDesktopInput(
  params: RunAoiDesktopInputParams,
): Promise<AoiDesktopInputResult> {
  const helperPath = resolveAoiDesktopInputHelperPath(params.openroomHome, params.env);
  if (!helperPath) {
    return {
      kind: 'error',
      code: 'helper_not_installed',
      // Computer use is on by default, so this is the one setup step left --
      // and the message is the only place anyone will find out about it. A bare
      // "not installed" leaves the model guessing and the operator searching.
      detail:
        'the desktop-input helper is not installed on this machine. Install it by running ' +
        'tools/aoi-desktop-input/Install-AoiDesktopInput.ps1 (needs Visual Studio C++ build ' +
        'tools). Nothing else about desktop input needs enabling.',
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

  for (const key of [
    'button',
    'modifiers',
    'direction',
    'keys',
    'text',
    'delivery',
    'option',
    'state',
    'mode',
    'space',
  ] as const) {
    const value = request[key];
    if (typeof value === 'string' && value) {
      command[key] = value;
    }
  }
  for (const key of [
    'clicks',
    'amount',
    'toRef',
    'x',
    'y',
    'maxLongSide',
    'maxShortSide',
    'windowWidth',
    'windowHeight',
  ] as const) {
    const value = request[key];
    if (typeof value === 'number') {
      command[key] = value;
    }
  }

  const args = ['--stdin'];
  // Asking for the rung is not the same as being allowed it.
  if (request.allowForeground === true && params.foregroundAllowed) {
    args.push('--allow-foreground');
  }

  const spawnImpl = params.spawnImpl ?? spawnAoiDesktopInputHelper;
  let outcome: AoiDesktopInputSpawnOutcome;
  try {
    outcome = await spawnImpl(helperPath, args, JSON.stringify(command));
  } catch (error) {
    return {
      kind: 'error',
      code: 'helper_spawn_failed',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  // The reply is read before the timeout is looked at. The helper writes its
  // verdict and only then tears down COM, and that teardown can stall on a
  // window the act just made busy -- so a helper stopped for running long may
  // already have said exactly what happened. Throwing that away turned a proven
  // act into "unknown".
  const raw = parseJsonObject(outcome.stdout);
  if (!raw && outcome.timedOut) {
    return {
      kind: 'error',
      code: 'helper_timeout',
      detail:
        `the desktop-input helper did not finish within ${HELPER_TIMEOUT_MS / 1000} s and was ` +
        'stopped; the window may be hung. Whether the action took effect is unknown.',
    };
  }
  if (!raw) {
    return {
      kind: 'error',
      code: 'helper_no_reply',
      detail: outcome.stderr.trim().slice(0, 400) || 'the helper produced no parseable reply',
    };
  }

  // Before anything is mapped or returned: a browser window read while a
  // denylist exists is refused, and the reply is dropped rather than shaped.
  const browserRefusal = refuseBrowserWindowRead(
    request.op,
    typeof raw.process === 'string' ? raw.process : '',
    params.openroomHome,
  );
  if (browserRefusal) {
    return browserRefusal;
  }

  if (request.op === 'list_apps') {
    if (raw.ok !== true) {
      return {
        kind: 'error',
        code: typeof raw.code === 'string' ? raw.code : 'list_failed',
        detail: typeof raw.detail === 'string' ? raw.detail : '',
      };
    }
    const list = Array.isArray(raw.apps) ? raw.apps : [];
    return {
      kind: 'apps',
      apps: list
        .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
        .map((entry) => ({
          process: typeof entry.process === 'string' ? entry.process.slice(0, 120) : '',
          windowCount: typeof entry.windowCount === 'number' ? entry.windowCount : 0,
          sampleTitle: typeof entry.sampleTitle === 'string' ? entry.sampleTitle.slice(0, 200) : '',
        })),
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

  if (request.op === 'capture') {
    if (raw.ok !== true || typeof raw.pngBase64 !== 'string' || !raw.pngBase64) {
      return {
        kind: 'error',
        code: typeof raw.code === 'string' ? raw.code : 'capture_failed',
        detail: typeof raw.detail === 'string' ? raw.detail : '',
      };
    }
    const snapshot = mapSnapshot(raw);
    return {
      kind: 'capture',
      capture: {
        snapshotId: snapshot ? snapshot.snapshotId : '',
        mode: typeof raw.mode === 'string' ? raw.mode : 'plain',
        width: typeof raw.width === 'number' ? raw.width : 0,
        height: typeof raw.height === 'number' ? raw.height : 0,
        scale: typeof raw.scale === 'number' ? raw.scale : 1,
        windowWidth: typeof raw.windowWidth === 'number' ? raw.windowWidth : 0,
        windowHeight: typeof raw.windowHeight === 'number' ? raw.windowHeight : 0,
        totalElements: snapshot ? snapshot.totalElements : 0,
        elements: snapshot ? snapshot.elements : [],
        pngBase64: raw.pngBase64,
      },
    };
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
