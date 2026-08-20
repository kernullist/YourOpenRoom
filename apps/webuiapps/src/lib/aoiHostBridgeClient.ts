// Client-side wrapper for the host-bridge daemon API (/api/aoi-host/*).
//
// Same-origin: the Vite dev mount (vite.config.ts) trusts loopback callers, so no
// token is attached here -- the browser never holds the secret. Against the
// standalone daemon a caller WOULD need the x-aoi-host-bridge-token header; this
// wrapper targets the dev/same-origin mount. Mirrors aoiAutonomyClient's
// fetch + parse shape (throw on !ok, surface denyReasons).

import {
  isAoiBrowserDriveEffect,
  parseAoiBrowserDriveVerdict,
  type AoiBrowserDriveEffect,
  type AoiBrowserDriveVerdict,
} from './aoiBrowserDriveVerdict';

const API_PREFIX = '/api/aoi-host';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

// Parse the uniform { ok, ... } envelope, throwing a readable error (including
// gate denyReasons) on any non-ok response.
async function readOk(response: Response): Promise<Record<string, unknown>> {
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!isRecord(payload)) {
    throw new Error(`host-bridge request failed (HTTP ${response.status})`);
  }
  if (payload.ok !== true) {
    const base = asString(payload.error) || `request failed (HTTP ${response.status})`;
    const reasons = Array.isArray(payload.denyReasons) ? asStringArray(payload.denyReasons) : [];
    // Carry the detail. `error` is a CODE -- 'helper_not_installed',
    // 'browser_window_denylisted' -- and every explanation the routes write
    // lives in `detail`: what is actually in the way, and what to do instead.
    // Dropping it here meant the install instructions written specifically
    // because "the message is the only place anyone will find out about it"
    // reached nobody, and a refusal arrived at the model as a bare slug.
    const detail = Array.isArray(payload.detail)
      ? asStringArray(payload.detail).join('; ')
      : asString(payload.detail);
    const withReasons = reasons.length > 0 ? `${base} [${reasons.join(', ')}]` : base;
    throw new Error(detail && detail !== base ? `${withReasons}: ${detail}` : withReasons);
  }
  return payload;
}

async function getJson(route: string): Promise<Record<string, unknown>> {
  return readOk(await fetch(`${API_PREFIX}${route}`));
}

async function sendJson(
  route: string,
  method: 'POST' | 'DELETE',
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return readOk(
    await fetch(`${API_PREFIX}${route}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
  );
}

// --- Status + kill switch ----------------------------------------------------

export interface AoiHostBridgeKillSwitchView {
  globalPanic: boolean;
  enabledCapabilities: string[];
  updatedAt: number;
}

export interface AoiHostBridgeStatus {
  tokenConfigured: boolean;
  killSwitch: AoiHostBridgeKillSwitchView;
}

function parseKillSwitch(value: unknown): AoiHostBridgeKillSwitchView {
  const record = isRecord(value) ? value : {};
  return {
    globalPanic: record.globalPanic === true,
    enabledCapabilities: asStringArray(record.enabledCapabilities),
    updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : 0,
  };
}

export async function fetchAoiHostBridgeStatus(): Promise<AoiHostBridgeStatus> {
  const payload = await getJson('/status');
  return {
    tokenConfigured: payload.tokenConfigured === true,
    killSwitch: parseKillSwitch(payload.killSwitch),
  };
}

export type AoiHostKillSwitchAction = 'panic' | 'clear_panic' | 'set';

export async function setAoiHostBridgeKillSwitch(
  action: AoiHostKillSwitchAction,
  options: { capability?: string; enabled?: boolean } = {},
): Promise<AoiHostBridgeKillSwitchView> {
  const payload = await sendJson('/killswitch', 'POST', { action, ...options });
  return parseKillSwitch(payload.killSwitch);
}

// --- Spawn allowlist ---------------------------------------------------------

export interface AoiHostSpawnAllowlistEntryView {
  id: string;
  path: string;
  label?: string;
  match?: 'file' | 'directory';
  fixedArgs?: string[];
}

function parseSpawnEntries(value: unknown): AoiHostSpawnAllowlistEntryView[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isRecord).map((record) => {
    const entry: AoiHostSpawnAllowlistEntryView = {
      id: asString(record.id),
      path: asString(record.path),
    };
    if (typeof record.label === 'string') {
      entry.label = record.label;
    }
    if (record.match === 'directory' || record.match === 'file') {
      entry.match = record.match;
    }
    if (Array.isArray(record.fixedArgs)) {
      entry.fixedArgs = asStringArray(record.fixedArgs);
    }
    return entry;
  });
}

export async function fetchAoiHostSpawnAllowlist(): Promise<AoiHostSpawnAllowlistEntryView[]> {
  return parseSpawnEntries((await getJson('/spawn-allowlist')).entries);
}

export async function addAoiHostSpawnAllowlistEntry(entry: {
  id?: string;
  path: string;
  label?: string;
  match?: 'file' | 'directory';
  fixedArgs?: string[];
}): Promise<AoiHostSpawnAllowlistEntryView[]> {
  return parseSpawnEntries((await sendJson('/spawn-allowlist', 'POST', { ...entry })).entries);
}

export async function removeAoiHostSpawnAllowlistEntry(
  id: string,
): Promise<AoiHostSpawnAllowlistEntryView[]> {
  return parseSpawnEntries(
    (await sendJson(`/spawn-allowlist?id=${encodeURIComponent(id)}`, 'DELETE')).entries,
  );
}

// --- Process spawn preview / execute (HP2a) ----------------------------------

export interface AoiHostSpawnPreviewView {
  allowed: boolean;
  blockReasons: string[];
  allowlistId: string;
  label: string;
  program: string;
  args: string[];
  approvalFingerprint: string;
  expiresAt: number;
}

export interface AoiHostSpawnExecuteView {
  ok: boolean;
  allowlistId: string;
  program: string;
  spawnedPid: number | null;
  blockReasons: string[];
}

export interface AoiHostSpawnRequestBody {
  allowlistId?: string;
  programPath?: string;
  args?: string[];
}

function parseSpawnPreview(value: unknown): AoiHostSpawnPreviewView {
  const record = isRecord(value) ? value : {};
  return {
    allowed: record.allowed === true,
    blockReasons: asStringArray(record.blockReasons),
    allowlistId: asString(record.allowlistId),
    label: asString(record.label),
    program: asString(record.program),
    args: asStringArray(record.args),
    approvalFingerprint: asString(record.approvalFingerprint),
    expiresAt: typeof record.expiresAt === 'number' ? record.expiresAt : 0,
  };
}

export async function fetchAoiHostSpawnPreview(
  body: AoiHostSpawnRequestBody,
): Promise<AoiHostSpawnPreviewView> {
  const payload = await sendJson('/spawn/preview', 'POST', {
    ...(body.allowlistId ? { allowlistId: body.allowlistId } : {}),
    ...(body.programPath ? { programPath: body.programPath } : {}),
    ...(body.args ? { args: body.args } : {}),
  });
  return parseSpawnPreview(payload.preview);
}

export async function runAoiHostSpawnExecute(
  body: AoiHostSpawnRequestBody,
): Promise<AoiHostSpawnExecuteView> {
  const payload = await sendJson('/spawn/execute', 'POST', {
    ...(body.allowlistId ? { allowlistId: body.allowlistId } : {}),
    ...(body.programPath ? { programPath: body.programPath } : {}),
    ...(body.args ? { args: body.args } : {}),
  });
  return {
    ok: payload.ok === true,
    allowlistId: asString(payload.allowlistId),
    program: asString(payload.program),
    spawnedPid: typeof payload.spawnedPid === 'number' ? payload.spawnedPid : null,
    blockReasons: asStringArray(payload.blockReasons),
  };
}

// --- Read / write roots ------------------------------------------------------

export interface AoiHostRootView {
  id: string;
  path: string;
  label?: string;
}

function parseRoots(value: unknown): AoiHostRootView[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isRecord).map((record) => {
    const root: AoiHostRootView = { id: asString(record.id), path: asString(record.path) };
    if (typeof record.label === 'string') {
      root.label = record.label;
    }
    return root;
  });
}

export type AoiHostRootKind = 'read' | 'write';

function rootsRoute(kind: AoiHostRootKind): string {
  return kind === 'read' ? '/read-roots' : '/write-roots';
}

export async function fetchAoiHostRoots(kind: AoiHostRootKind): Promise<AoiHostRootView[]> {
  return parseRoots((await getJson(rootsRoute(kind))).roots);
}

// --- Process listing (HP1, read-only metadata) -------------------------------

export interface AoiHostProcessRecordView {
  pid: number;
  imageName: string;
  sessionName?: string;
  memKb?: number;
}

export interface AoiHostProcessSummaryView {
  version: 1;
  sampledAt: number;
  totalCount: number;
  topImages: Array<{ imageName: string; count: number }>;
  distinctImageCount: number;
}

export interface AoiHostProcessListingView {
  version: 1;
  sampledAt: number;
  records: AoiHostProcessRecordView[];
  summary: AoiHostProcessSummaryView;
}

function parseProcessRecord(value: unknown): AoiHostProcessRecordView | null {
  if (!isRecord(value)) {
    return null;
  }
  const pid = typeof value.pid === 'number' ? value.pid : Number.NaN;
  const imageName = asString(value.imageName);
  if (!Number.isFinite(pid) || pid <= 0 || !imageName) {
    return null;
  }
  const record: AoiHostProcessRecordView = { pid, imageName };
  if (typeof value.sessionName === 'string' && value.sessionName.trim()) {
    record.sessionName = value.sessionName.trim().slice(0, 32);
  }
  if (typeof value.memKb === 'number' && Number.isFinite(value.memKb)) {
    record.memKb = value.memKb;
  }
  return record;
}

function parseProcessListing(value: unknown): AoiHostProcessListingView {
  const record = isRecord(value) ? value : {};
  const summaryRaw = isRecord(record.summary) ? record.summary : {};
  const topImagesRaw = Array.isArray(summaryRaw.topImages) ? summaryRaw.topImages : [];
  const recordsRaw = Array.isArray(record.records) ? record.records : [];
  const topImages = topImagesRaw
    .filter(isRecord)
    .map((item) => ({
      imageName: asString(item.imageName),
      count: typeof item.count === 'number' ? item.count : 0,
    }))
    .filter((item) => item.imageName && item.count > 0);
  const records = recordsRaw
    .map(parseProcessRecord)
    .filter((item): item is AoiHostProcessRecordView => item !== null);
  const sampledAt =
    typeof record.sampledAt === 'number'
      ? record.sampledAt
      : typeof summaryRaw.sampledAt === 'number'
        ? summaryRaw.sampledAt
        : 0;
  return {
    version: 1,
    sampledAt,
    records,
    summary: {
      version: 1,
      sampledAt,
      totalCount:
        typeof summaryRaw.totalCount === 'number' ? summaryRaw.totalCount : records.length,
      topImages,
      distinctImageCount:
        typeof summaryRaw.distinctImageCount === 'number'
          ? summaryRaw.distinctImageCount
          : topImages.length,
    },
  };
}

export async function fetchAoiHostProcesses(
  sessionPath: string,
): Promise<AoiHostProcessListingView> {
  const path = typeof sessionPath === 'string' ? sessionPath.trim() : '';
  if (!path) {
    throw new Error('sessionPath is required for host process listing');
  }
  const payload = await getJson(`/processes?sessionPath=${encodeURIComponent(path)}`);
  return parseProcessListing(payload.listing);
}

// --- Headless browser page read (HP5) ----------------------------------------

export interface AoiHostBrowserPageView {
  url: string;
  finalUrl: string;
  title: string;
  excerpt: string;
  siteName: string;
  blocks: Array<{ type: string; text: string }>;
  text: string;
  browserPath: string;
  sampledAt: number;
  durationMs: number;
  engine: string;
}

function parseBrowserPage(value: unknown): AoiHostBrowserPageView {
  const record = isRecord(value) ? value : {};
  const blocksRaw = Array.isArray(record.blocks) ? record.blocks : [];
  return {
    url: asString(record.url),
    finalUrl: asString(record.finalUrl) || asString(record.url),
    title: asString(record.title),
    excerpt: asString(record.excerpt),
    siteName: asString(record.siteName),
    blocks: blocksRaw.filter(isRecord).map((block) => ({
      type: asString(block.type) || 'paragraph',
      text: asString(block.text),
    })),
    text: asString(record.text),
    browserPath: asString(record.browserPath),
    sampledAt: typeof record.sampledAt === 'number' ? record.sampledAt : 0,
    durationMs: typeof record.durationMs === 'number' ? record.durationMs : 0,
    engine: asString(record.engine),
  };
}

export async function fetchAoiHostBrowserRead(
  sessionPath: string,
  url: string,
): Promise<AoiHostBrowserPageView> {
  const path = typeof sessionPath === 'string' ? sessionPath.trim() : '';
  if (!path) {
    throw new Error('sessionPath is required for host browser read');
  }
  const target = typeof url === 'string' ? url.trim() : '';
  if (!target) {
    throw new Error('url is required for host browser read');
  }
  const payload = await sendJson('/browser-read', 'POST', { sessionPath: path, url: target });
  return parseBrowserPage(payload.page);
}

// --- Browser drive: read an allowlisted, logged-in page (BD P1.3) ------------

export interface AoiHostBrowserDrivePageView extends AoiHostBrowserPageView {
  hostname: string;
}

export async function fetchAoiHostBrowserDriveRead(
  sessionPath: string,
  url: string,
): Promise<AoiHostBrowserDrivePageView> {
  const path = typeof sessionPath === 'string' ? sessionPath.trim() : '';
  if (!path) {
    throw new Error('sessionPath is required for host browser drive read');
  }
  const target = typeof url === 'string' ? url.trim() : '';
  if (!target) {
    throw new Error('url is required for host browser drive read');
  }
  const payload = await sendJson('/browser-drive-read', 'POST', {
    sessionPath: path,
    url: target,
  });
  const page = parseBrowserPage(payload.page);
  const record = isRecord(payload.page) ? payload.page : {};
  return { ...page, hostname: asString(record.hostname) };
}

// --- Browser drive: propose (preview) + run (execute) ONE act (BD P2.3) ------

export interface AoiHostBrowserDriveActPreviewView {
  capability: string;
  approvalFingerprint: string;
  targetSummary: string;
  stepIndex: number;
  hostname: string;
  finalUrl: string;
  expiresAt: number;
  beforeScreenshotBase64?: string;
  // What the read prefix saw while previewing. This is where a model can first
  // obtain an element ref: propose replays the reads without acting, so the
  // snapshot comes back before any approval is spent.
  reads?: AoiHostBrowserDriveReadView[];
}

/**
 * What a read step in the plan's prefix actually saw.
 *
 * These were being computed and then thrown away at this boundary, which quietly
 * disabled the safest way to address an element: `element: N` + `snapshot_id`
 * only works if the model can OBTAIN a ref, and the snapshot that mints them
 * arrives here. Without it every act had to name a hand-written CSS selector --
 * the weaker path the ref system exists to replace. Same for `tabs`: a listing
 * the caller never receives cannot inform which tab to switch to.
 *
 * Bounded on purpose: a snapshot of a dense page is large, and this rides in
 * every act result.
 */
export interface AoiHostBrowserDriveReadView {
  index: number;
  kind?: string;
  finalUrl?: string;
  snapshotId?: string;
  elements?: { ref: number; role: string; name: string }[];
  // Set when the element list was cut, so a caller never reads a partial list as
  // the whole page.
  elementsTruncated?: boolean;
  // Interactables the page exposes that carry no id/name/testid and so cannot be
  // addressed by ref. Carried through because dropping it turns "here are the
  // controls you can address" into "here are the controls", and the caller stops
  // looking for the ones that need a hand-written selector.
  unaddressable?: number;
  tabs?: { index: number; url: string; title: string; current: boolean }[];
  text?: string;
}

const MAX_READ_ELEMENTS = 60;
const MAX_READ_TEXT = 4_000;

function readViewsFrom(raw: unknown): AoiHostBrowserDriveReadView[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const views: AoiHostBrowserDriveReadView[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) {
      continue;
    }
    const view: AoiHostBrowserDriveReadView = {
      index: typeof entry.index === 'number' ? entry.index : views.length,
    };
    if (typeof entry.finalUrl === 'string' && entry.finalUrl) {
      view.finalUrl = entry.finalUrl;
    }
    const snapshot = isRecord(entry.snapshot) ? entry.snapshot : null;
    if (snapshot) {
      view.kind = 'elements';
      view.snapshotId = asString(snapshot.id ?? snapshot.snapshotId);
      const elements = Array.isArray(snapshot.elements) ? snapshot.elements : [];
      view.elements = elements
        .filter(isRecord)
        .slice(0, MAX_READ_ELEMENTS)
        .map((element) => ({
          ref: typeof element.ref === 'number' ? element.ref : 0,
          role: asString(element.role),
          name: asString(element.name).slice(0, 120),
        }));
      if (elements.length > MAX_READ_ELEMENTS) {
        view.elementsTruncated = true;
      }
      const unaddressable = snapshot.unaddressable;
      if (typeof unaddressable === 'number' && unaddressable > 0) {
        view.unaddressable = unaddressable;
      }
    }
    if (Array.isArray(entry.tabs)) {
      view.kind = 'tabs';
      view.tabs = entry.tabs.filter(isRecord).map((tab) => ({
        index: typeof tab.index === 'number' ? tab.index : 0,
        url: asString(tab.url),
        title: asString(tab.title).slice(0, 200),
        current: tab.current === true,
      }));
    }
    const extract = isRecord(entry.extract) ? entry.extract : null;
    if (extract && typeof extract.text === 'string' && extract.text) {
      view.kind = view.kind ?? 'extract';
      view.text = extract.text.slice(0, MAX_READ_TEXT);
    }
    // Only carry a step that actually observed something.
    if (view.snapshotId || view.tabs || view.text) {
      views.push(view);
    }
  }
  return views;
}

export interface AoiHostBrowserDriveActExecuteView {
  // Transport success: the call ran and no gate stopped it. NOT proof the
  // action landed -- that is what `verdict` is for.
  ok: boolean;
  stepIndex: number;
  stopReason?: string;
  finalUrl?: string;
  // Semantic verdict from the executor. Absent when the daemon did not send one
  // (older build) or it failed validation; callers must then use the honest
  // "delivered, unproven" wording rather than reporting success.
  verdict?: AoiBrowserDriveVerdict;
  // What the read steps before the act observed: element refs, tabs, page text.
  reads?: AoiHostBrowserDriveReadView[];
}

// Preview: replay the read prefix and record a PENDING per-action approval. The
// operator approves it in the Host Bridge Approvals inbox before run can execute.
export async function fetchAoiHostBrowserDriveActPreview(
  sessionPath: string,
  plan: unknown,
  targetStepIndex: number,
): Promise<AoiHostBrowserDriveActPreviewView> {
  const path = typeof sessionPath === 'string' ? sessionPath.trim() : '';
  if (!path) {
    throw new Error('sessionPath is required for browser-drive act preview');
  }
  const payload = await sendJson('/browser-drive/preview', 'POST', {
    sessionPath: path,
    plan,
    targetStepIndex,
  });
  const record = isRecord(payload.preview) ? payload.preview : {};
  return {
    capability: asString(record.capability),
    approvalFingerprint: asString(record.approvalFingerprint),
    targetSummary: asString(record.targetSummary),
    stepIndex: typeof record.stepIndex === 'number' ? record.stepIndex : targetStepIndex,
    hostname: asString(record.hostname),
    finalUrl: asString(record.finalUrl),
    expiresAt: typeof record.expiresAt === 'number' ? record.expiresAt : 0,
    ...(typeof record.beforeScreenshotBase64 === 'string'
      ? { beforeScreenshotBase64: record.beforeScreenshotBase64 }
      : {}),
    ...((): { reads?: AoiHostBrowserDriveReadView[] } => {
      const reads = readViewsFrom(record.prefix);
      return reads.length ? { reads } : {};
    })(),
  };
}

// Execute: run the ONE approved act. Throws (403) if there is no operator-approved,
// single-use store entry for this exact action fingerprint (fail-closed).
export async function runAoiHostBrowserDriveActExecute(
  sessionPath: string,
  plan: unknown,
  targetStepIndex: number,
): Promise<AoiHostBrowserDriveActExecuteView> {
  const path = typeof sessionPath === 'string' ? sessionPath.trim() : '';
  if (!path) {
    throw new Error('sessionPath is required for browser-drive act execute');
  }
  const payload = await sendJson('/browser-drive/execute', 'POST', {
    sessionPath: path,
    plan,
    targetStepIndex,
  });
  const result = isRecord(payload.result) ? payload.result : {};
  const target = isRecord(result.target) ? result.target : {};
  const verdict = parseAoiBrowserDriveVerdict(target.verdict);
  return {
    ok: payload.ok === true && result.ok === true,
    stepIndex: typeof result.stepIndex === 'number' ? result.stepIndex : targetStepIndex,
    ...(typeof target.stopReason === 'string' ? { stopReason: target.stopReason } : {}),
    ...(typeof target.finalUrl === 'string' ? { finalUrl: target.finalUrl } : {}),
    ...(verdict ? { verdict } : {}),
    // Carry what the read prefix saw. Dropping it here is what left the model
    // unable to obtain an element ref at all.
    ...((): { reads?: AoiHostBrowserDriveReadView[] } => {
      const reads = readViewsFrom(result.prefix);
      return reads.length ? { reads } : {};
    })(),
  };
}

// --- Browser-drive bounded task (BD P3.2) ------------------------------------

export interface AoiHostBrowserDriveTaskStepView {
  index: number;
  // Transport success; `effect` says what was proven.
  ok: boolean;
  reason?: string;
  finalUrl?: string;
  effect?: AoiBrowserDriveEffect;
  verified?: boolean;
}

export interface AoiHostBrowserDriveTaskResultView {
  ok: boolean;
  goal: string;
  stopReason: string;
  actsRun: number;
  stepsRun: number;
  steps: AoiHostBrowserDriveTaskStepView[];
  detail?: string;
}

// Run a bounded, operator-authored multi-act task. Throws (403) when the
// os_browser_drive_task toggle is off or the task is refused as not operator-
// authored; the daemon fail-stops on the first non-ok step.
export async function runAoiHostBrowserDriveTask(
  sessionPath: string,
  task: unknown,
  budget?: { maxActs?: number; maxSteps?: number },
): Promise<AoiHostBrowserDriveTaskResultView> {
  const path = typeof sessionPath === 'string' ? sessionPath.trim() : '';
  if (!path) {
    throw new Error('sessionPath is required for browser-drive task');
  }
  const payload = await sendJson('/browser-drive/task', 'POST', {
    sessionPath: path,
    task,
    ...(typeof budget?.maxActs === 'number' ? { maxActs: budget.maxActs } : {}),
    ...(typeof budget?.maxSteps === 'number' ? { maxSteps: budget.maxSteps } : {}),
  });
  const result = isRecord(payload.result) ? payload.result : {};
  const stepsRaw = Array.isArray(result.results) ? result.results : [];
  return {
    ok: payload.ok === true && result.ok === true,
    goal: asString(result.goal),
    stopReason: asString(result.stopReason),
    actsRun: typeof result.actsRun === 'number' ? result.actsRun : 0,
    stepsRun: typeof result.stepsRun === 'number' ? result.stepsRun : 0,
    steps: stepsRaw.filter(isRecord).map((record) => ({
      index: typeof record.index === 'number' ? record.index : 0,
      ok: record.ok === true,
      ...(typeof record.reason === 'string' ? { reason: record.reason } : {}),
      ...(typeof record.finalUrl === 'string' ? { finalUrl: record.finalUrl } : {}),
      // Validated the same way as the single-act verdict: an unrecognized
      // effect is dropped rather than shown as proof of anything.
      ...(isAoiBrowserDriveEffect(record.effect) ? { effect: record.effect } : {}),
      ...(record.verified === true ? { verified: true } : {}),
    })),
    ...(typeof result.detail === 'string' ? { detail: result.detail } : {}),
  };
}

// --- Browser-drive step audit ledger (auth-only read, BD P3.3) ---------------

export interface AoiBrowserDriveAuditEntryView {
  id: string;
  runId: string;
  stepIndex: number;
  actionKind: string;
  actionSummary: string;
  category: string;
  ok: boolean;
  effect?: AoiBrowserDriveEffect;
  verified?: boolean;
  stopReason?: string;
  viaStanding: boolean;
  url: string;
  recordedAt: number;
  hasScreenshot: boolean;
}

export async function fetchAoiBrowserDriveAudit(): Promise<AoiBrowserDriveAuditEntryView[]> {
  const payload = await getJson('/browser-drive/audit');
  const raw = Array.isArray(payload.entries) ? payload.entries : [];
  return raw.filter(isRecord).map((record) => ({
    id: asString(record.id),
    runId: asString(record.runId),
    stepIndex: typeof record.stepIndex === 'number' ? record.stepIndex : 0,
    actionKind: asString(record.actionKind),
    actionSummary: asString(record.actionSummary),
    category: asString(record.category) || 'read',
    ok: record.ok === true,
    ...(isAoiBrowserDriveEffect(record.effect) ? { effect: record.effect } : {}),
    ...(record.verified === true ? { verified: true } : {}),
    ...(typeof record.stopReason === 'string' ? { stopReason: record.stopReason } : {}),
    viaStanding: record.viaStanding === true,
    url: asString(record.url),
    recordedAt: typeof record.recordedAt === 'number' ? record.recordedAt : 0,
    hasScreenshot:
      typeof record.beforeScreenshotRef === 'string' ||
      typeof record.afterScreenshotRef === 'string',
  }));
}

// --- Browser-drive standing grants (auth-only config CRUD, BD P3.1) ----------

export interface AoiBrowserDriveStandingGrantView {
  id: string;
  domain: string;
  label: string;
  createdAt: number;
  expiresAt: number;
  maxActions: number;
  usedActions: number;
}

function parseStandingGrants(value: unknown): AoiBrowserDriveStandingGrantView[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isRecord).map((record) => ({
    id: asString(record.id),
    domain: asString(record.domain),
    label: asString(record.label) || asString(record.domain),
    createdAt: typeof record.createdAt === 'number' ? record.createdAt : 0,
    expiresAt: typeof record.expiresAt === 'number' ? record.expiresAt : 0,
    maxActions: typeof record.maxActions === 'number' ? record.maxActions : 0,
    usedActions: typeof record.usedActions === 'number' ? record.usedActions : 0,
  }));
}

export async function fetchAoiBrowserDriveStandingGrants(): Promise<
  AoiBrowserDriveStandingGrantView[]
> {
  return parseStandingGrants((await getJson('/browser-drive/standing-grants')).grants);
}

export async function addAoiBrowserDriveStandingGrant(input: {
  domain: string;
  label?: string;
  ttlMs?: number;
  maxActions?: number;
}): Promise<AoiBrowserDriveStandingGrantView[]> {
  const payload = await sendJson('/browser-drive/standing-grants', 'POST', {
    domain: input.domain,
    ...(input.label ? { label: input.label } : {}),
    ...(typeof input.ttlMs === 'number' ? { ttlMs: input.ttlMs } : {}),
    ...(typeof input.maxActions === 'number' ? { maxActions: input.maxActions } : {}),
  });
  return parseStandingGrants(payload.grants);
}

export async function removeAoiBrowserDriveStandingGrant(
  id: string,
): Promise<AoiBrowserDriveStandingGrantView[]> {
  return parseStandingGrants(
    (await sendJson('/browser-drive/standing-grants', 'DELETE', { id })).grants,
  );
}

// --- Browser-drive domain denylist (auth-only config CRUD; default-allow) ----

export interface AoiBrowserDriveAllowlistEntryView {
  id: string;
  domain: string;
  label: string;
  addedAt: number;
}

function parseBrowserDriveAllowlistEntries(value: unknown): AoiBrowserDriveAllowlistEntryView[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isRecord).map((record) => ({
    id: asString(record.id),
    domain: asString(record.domain),
    label: asString(record.label) || asString(record.domain),
    addedAt: typeof record.addedAt === 'number' ? record.addedAt : 0,
  }));
}

export async function fetchAoiBrowserDriveAllowlist(): Promise<
  AoiBrowserDriveAllowlistEntryView[]
> {
  return parseBrowserDriveAllowlistEntries((await getJson('/browser-drive-allowlist')).entries);
}

export async function addAoiBrowserDriveAllowlistDomain(entry: {
  domain: string;
  label?: string;
}): Promise<AoiBrowserDriveAllowlistEntryView[]> {
  return parseBrowserDriveAllowlistEntries(
    (await sendJson('/browser-drive-allowlist', 'POST', { ...entry })).entries,
  );
}

export async function removeAoiBrowserDriveAllowlistDomain(
  id: string,
): Promise<AoiBrowserDriveAllowlistEntryView[]> {
  return parseBrowserDriveAllowlistEntries(
    (await sendJson(`/browser-drive-allowlist?id=${encodeURIComponent(id)}`, 'DELETE')).entries,
  );
}

export async function addAoiHostRoot(
  kind: AoiHostRootKind,
  root: { id?: string; path: string; label?: string },
): Promise<AoiHostRootView[]> {
  return parseRoots((await sendJson(rootsRoute(kind), 'POST', { ...root })).roots);
}

export async function removeAoiHostRoot(
  kind: AoiHostRootKind,
  id: string,
): Promise<AoiHostRootView[]> {
  return parseRoots(
    (await sendJson(`${rootsRoute(kind)}?id=${encodeURIComponent(id)}`, 'DELETE')).roots,
  );
}

// --- Approvals ---------------------------------------------------------------

export interface AoiHostBridgeApprovalView {
  id: string;
  capability: string;
  approvalFingerprint: string;
  targetSummary: string;
  state: string;
  expiresAt: number;
  canExecute: boolean;
}

function parseApprovals(value: unknown): AoiHostBridgeApprovalView[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isRecord).map((record) => ({
    id: asString(record.id),
    capability: asString(record.capability),
    approvalFingerprint: asString(record.approvalFingerprint),
    targetSummary: asString(record.targetSummary),
    state: asString(record.state),
    expiresAt: typeof record.expiresAt === 'number' ? record.expiresAt : 0,
    canExecute: record.canExecute === true,
  }));
}

export async function fetchAoiHostApprovals(): Promise<AoiHostBridgeApprovalView[]> {
  return parseApprovals((await getJson('/approvals')).approvals);
}

export async function approveAoiHostApproval(approvalFingerprint: string): Promise<{
  alreadyApproved: boolean;
  canExecute: boolean;
  note: string;
}> {
  const payload = await sendJson('/approvals/approve', 'POST', { approvalFingerprint });
  return {
    alreadyApproved: payload.alreadyApproved === true,
    canExecute: payload.canExecute === true,
    note: asString(payload.note),
  };
}

export interface AoiHostApprovalExecuteView {
  ok: boolean;
  alreadyApproved: boolean;
  program: string;
  spawnedPid: number | null;
  allowlistId: string;
  blockReasons: string[];
}

export async function approveAndExecuteAoiHostApproval(
  approvalFingerprint: string,
): Promise<AoiHostApprovalExecuteView> {
  const payload = await sendJson('/approvals/approve-and-execute', 'POST', { approvalFingerprint });
  return {
    ok: payload.ok === true,
    alreadyApproved: payload.alreadyApproved === true,
    program: asString(payload.program),
    spawnedPid: typeof payload.spawnedPid === 'number' ? payload.spawnedPid : null,
    allowlistId: asString(payload.allowlistId),
    blockReasons: asStringArray(payload.blockReasons),
  };
}

// --- Process kill: propose (preview) + run (execute) --------------------------
//
// Same three-step shape as browser-drive: preview records a PENDING approval,
// the operator approves it in the Host Bridge inbox, and execute is fail-closed
// without that approval.
//
// killAllowlistImages is CALLER-DECLARED by design -- the protected-process list
// is the real guard, not this list. Callers should surface that honestly rather
// than presenting the allowlist as a security boundary.

export interface AoiHostKillPreviewView {
  allowed: boolean;
  pid: number;
  imageName: string;
  approvalFingerprint?: string;
  targetSummary?: string;
  denyReasons: string[];
  expiresAt?: number;
}

export interface AoiHostKillExecuteView {
  ok: boolean;
  pid: number;
  denyReasons: string[];
  detail?: string;
}

export interface AoiHostKillRequest {
  pid: number;
  expectedImageName: string;
  expectedStartTime?: string | number;
  killAllowlistImages?: string[];
}

function killBody(request: AoiHostKillRequest): Record<string, unknown> {
  return {
    pid: request.pid,
    expectedImageName: request.expectedImageName,
    ...(request.expectedStartTime !== undefined
      ? { expectedStartTime: request.expectedStartTime }
      : {}),
    killAllowlistImages: request.killAllowlistImages ?? [],
  };
}

function parseDenyReasons(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

export async function fetchAoiHostKillPreview(
  request: AoiHostKillRequest,
): Promise<AoiHostKillPreviewView> {
  const payload = await sendJson('/kill/preview', 'POST', killBody(request));
  const policy = isRecord(payload.policy) ? payload.policy : {};
  return {
    allowed: payload.ok === true && policy.allowed === true,
    pid: typeof policy.pid === 'number' ? policy.pid : request.pid,
    imageName: asString(policy.imageName) || request.expectedImageName,
    ...(typeof policy.approvalFingerprint === 'string'
      ? { approvalFingerprint: policy.approvalFingerprint }
      : {}),
    ...(typeof policy.targetSummary === 'string' ? { targetSummary: policy.targetSummary } : {}),
    denyReasons: parseDenyReasons(policy.denyReasons ?? payload.denyReasons),
    ...(typeof policy.expiresAt === 'number' ? { expiresAt: policy.expiresAt } : {}),
  };
}

export async function runAoiHostKillExecute(
  request: AoiHostKillRequest,
): Promise<AoiHostKillExecuteView> {
  const payload = await sendJson('/kill/execute', 'POST', killBody(request));
  const result = isRecord(payload.result) ? payload.result : {};
  return {
    ok: payload.ok === true,
    pid: typeof result.pid === 'number' ? result.pid : request.pid,
    denyReasons: parseDenyReasons(payload.denyReasons ?? result.denyReasons),
    ...(typeof payload.detail === 'string' ? { detail: payload.detail } : {}),
  };
}

// --- Desktop input (DI3) -----------------------------------------------------
//
// Aoi acting on a real window. The daemon answers an act with a VERDICT rather
// than an HTTP error, including refusals, so these views keep `ok` (transport)
// and `effect` (what was proven) apart exactly as the browser-drive views do.

export interface AoiHostDesktopWindowView {
  hwnd: string;
  title: string;
  process: string;
}

export interface AoiHostDesktopElementView {
  ref: number;
  role: string;
  name: string;
  automationId: string;
  enabled: boolean;
  // True unless the daemon said otherwise: an element Aoi should not drive.
  sensitive: boolean;
}

export interface AoiHostDesktopSnapshotView {
  snapshotId: string;
  // What the window actually holds, versus what fit in the list.
  totalElements: number;
  truncated: boolean;
  // 'ok' | 'no_interactable_elements' | 'no_automation_tree'. The last one means
  // the window told UI Automation nothing -- which is NOT the same as having
  // nothing to click, and the caller must not read it that way.
  note: string;
  elements: AoiHostDesktopElementView[];
}

export interface AoiHostDesktopActView {
  // Transport succeeded. Says nothing about whether the window changed.
  ok: boolean;
  effect: AoiBrowserDriveEffect;
  verified: boolean;
  // Which rung ran (uia_invoke / uia_value / sendinput). Absent on a refusal,
  // because a refusal means no rung ran at all.
  path?: string;
  code?: string;
  detail: string;
  // Whether the synthetic-mouse rung was available for this call.
  foregroundAllowed: boolean;
}

// List drivable top-level windows. Throws (403) when os_desktop_input is off.
export async function listAoiHostDesktopWindows(): Promise<AoiHostDesktopWindowView[]> {
  const payload = await sendJson('/desktop-input', 'POST', { op: 'list_windows' });
  const windows = Array.isArray(payload.windows) ? payload.windows : [];
  return windows.filter(isRecord).map((record) => ({
    hwnd: asString(record.hwnd),
    title: asString(record.title),
    process: asString(record.process),
  }));
}

// Snapshot one window's interactable elements. The returned snapshotId is what
// makes a ref usable, and it is valid for THIS snapshot only.
export async function snapshotAoiHostDesktopWindow(
  hwnd: string,
): Promise<AoiHostDesktopSnapshotView> {
  const payload = await sendJson('/desktop-input', 'POST', { op: 'snapshot', hwnd });
  const snapshot = isRecord(payload.snapshot) ? payload.snapshot : {};
  const elements = Array.isArray(snapshot.elements) ? snapshot.elements : [];
  const mapped = elements.filter(isRecord);
  const totalElements =
    typeof snapshot.totalElements === 'number' && snapshot.totalElements >= mapped.length
      ? snapshot.totalElements
      : mapped.length;
  return {
    snapshotId: asString(snapshot.snapshotId),
    note: asString(snapshot.note) || 'ok',
    totalElements,
    truncated: snapshot.truncated === true || totalElements > mapped.length,
    elements: mapped.map((record) => ({
      ref: typeof record.ref === 'number' ? record.ref : 0,
      role: asString(record.role),
      name: asString(record.name),
      automationId: asString(record.automationId),
      enabled: record.enabled === true,
      // Fail-closed on a malformed entry: assume it must not be touched.
      sensitive: record.sensitive !== false,
    })),
  };
}

/**
 * Drive one element.
 *
 * `snapshotId` must be the one that produced `ref`; the helper re-resolves the
 * ref against a fresh snapshot and refuses a mismatch rather than acting on
 * whatever now sits at that index.
 *
 * A refusal comes back as a normal result with effect='suspected_noop' and a
 * code -- not a thrown error. Callers must read `effect`, never `ok`, to decide
 * whether anything happened.
 */
/**
 * Click a raw point inside a window, for windows that describe no controls.
 *
 * There is no ref and so no snapshot check; the daemon resolves the point back
 * to whatever element is there and applies the same credential and disabled
 * guards, and says whether anything was behind it.
 */
export async function clickAoiHostDesktopPoint(params: {
  hwnd: string;
  x: number;
  y: number;
  button?: string;
  clicks?: number;
  delivery?: 'background' | 'foreground';
}): Promise<AoiHostDesktopActView> {
  const payload = await sendJson('/desktop-input', 'POST', {
    op: 'click',
    hwnd: params.hwnd,
    x: params.x,
    y: params.y,
    ...(params.button ? { button: params.button } : {}),
    ...(typeof params.clicks === 'number' ? { clicks: params.clicks } : {}),
    ...(params.delivery ? { delivery: params.delivery } : {}),
    ...(params.delivery === 'foreground' ? { allowForeground: true } : {}),
  });
  return readDesktopActPayload(payload);
}

export async function actOnAoiHostDesktopElement(params: {
  op?: 'invoke' | 'set_value' | 'click' | 'scroll' | 'drag' | 'select' | 'toggle';
  hwnd: string;
  ref: number;
  snapshotId: string;
  value?: string;
  button?: string;
  clicks?: number;
  modifiers?: string[];
  direction?: string;
  amount?: number;
  toRef?: number;
  option?: string;
  state?: string;
  delivery?: 'background' | 'foreground';
  allowForeground?: boolean;
}): Promise<AoiHostDesktopActView> {
  const op = params.op ?? (typeof params.value === 'string' ? 'set_value' : 'invoke');
  // The synthetic-input rung is asked for whenever a rung was pinned to it or
  // the action cannot be delivered any other way. The daemon still decides
  // whether it is granted -- asking is not the same as being allowed.
  const wantsForeground =
    params.allowForeground === true || params.delivery === 'foreground' || op === 'drag';
  const payload = await sendJson('/desktop-input', 'POST', {
    op,
    hwnd: params.hwnd,
    ref: params.ref,
    snapshotId: params.snapshotId,
    ...(typeof params.value === 'string' ? { value: params.value } : {}),
    ...(params.button ? { button: params.button } : {}),
    ...(typeof params.clicks === 'number' ? { clicks: params.clicks } : {}),
    ...(params.modifiers?.length ? { modifiers: params.modifiers } : {}),
    ...(params.direction ? { direction: params.direction } : {}),
    ...(typeof params.amount === 'number' ? { amount: params.amount } : {}),
    ...(typeof params.toRef === 'number' ? { toRef: params.toRef } : {}),
    ...(params.option ? { option: params.option } : {}),
    ...(params.state ? { state: params.state } : {}),
    ...(params.delivery ? { delivery: params.delivery } : {}),
    ...(wantsForeground ? { allowForeground: true } : {}),
  });
  return readDesktopActPayload(payload);
}

// One reader for every acting route, so a new op cannot accidentally get a
// looser reading of the same verdict than the ops that came before it.
function readDesktopActPayload(payload: Record<string, unknown>): AoiHostDesktopActView {
  const act = isRecord(payload.act) ? payload.act : {};
  const verdict = isRecord(act.verdict) ? act.verdict : {};
  const effect = asString(verdict.effect);
  const view: AoiHostDesktopActView = {
    ok: act.ok === true,
    // An unrecognized effect is not proof of anything; fall back to unverifiable
    // rather than letting an unknown string reach a caller that tests for
    // 'confirmed'.
    effect: isAoiBrowserDriveEffect(effect) ? effect : 'unverifiable',
    verified: verdict.verified === true,
    detail: asString(act.detail),
    foregroundAllowed: payload.foregroundAllowed === true,
  };
  if (typeof act.path === 'string' && act.path.trim()) {
    view.path = act.path.trim();
  }
  if (typeof verdict.code === 'string' && verdict.code.trim()) {
    view.code = verdict.code.trim();
  }
  return view;
}

export interface AoiHostDesktopAppView {
  process: string;
  windowCount: number;
  sampleTitle: string;
}

// Running apps that have windows, grouped by program.
export async function listAoiHostDesktopApps(): Promise<AoiHostDesktopAppView[]> {
  const payload = await sendJson('/desktop-input', 'POST', { op: 'list_apps' });
  const apps = Array.isArray(payload.apps) ? payload.apps : [];
  return apps.filter(isRecord).map((record) => ({
    process: asString(record.process),
    windowCount: typeof record.windowCount === 'number' ? record.windowCount : 0,
    sampleTitle: asString(record.sampleTitle),
  }));
}

/**
 * Input aimed at a WINDOW rather than an element: keystrokes, typed text, and
 * raising it.
 *
 * There is no ref here because there is nothing to address -- a keystroke goes
 * wherever focus already is. That also means none of these can be proven, so
 * they answer with the same verdict shape and lean on 'unverifiable' rather than
 * inventing a weaker kind of certainty.
 */
export async function sendAoiHostDesktopWindowInput(params: {
  op: 'key' | 'type' | 'focus';
  hwnd: string;
  keys?: string;
  text?: string;
  delivery?: 'background' | 'foreground';
}): Promise<AoiHostDesktopActView> {
  const payload = await sendJson('/desktop-input', 'POST', {
    op: params.op,
    hwnd: params.hwnd,
    ...(params.keys ? { keys: params.keys } : {}),
    ...(typeof params.text === 'string' ? { text: params.text } : {}),
    ...(params.delivery ? { delivery: params.delivery } : {}),
    // focus exists to raise a window, so it always needs the rung that can.
    ...(params.delivery === 'foreground' || params.op === 'focus' ? { allowForeground: true } : {}),
  });
  return readDesktopActPayload(payload);
}

export interface AoiHostDesktopCaptureView {
  snapshotId: string;
  mode: string;
  width: number;
  height: number;
  scale: number;
  totalElements: number;
  elements: AoiHostDesktopElementView[];
  // A data: URL ready to attach to a message. Deliberately not written to disk
  // anywhere along the way.
  dataUrl: string;
}

/**
 * Take a picture of one window, optionally with its controls numbered.
 *
 * Gated by its own capability, because this returns whatever is on the window
 * rather than a list of control names, and no redaction is possible on pixels.
 * The numbers drawn on the image are the same refs the reply carries, so the
 * image can be acted on without a second lookup.
 */
export async function captureAoiHostDesktopWindow(params: {
  hwnd: string;
  mode?: 'som' | 'plain';
  maxLongSide?: number;
}): Promise<AoiHostDesktopCaptureView> {
  const payload = await sendJson('/desktop-input', 'POST', {
    op: 'capture',
    hwnd: params.hwnd,
    mode: params.mode ?? 'som',
    ...(typeof params.maxLongSide === 'number' ? { maxLongSide: params.maxLongSide } : {}),
  });
  const capture = isRecord(payload.capture) ? payload.capture : {};
  const elements = Array.isArray(capture.elements) ? capture.elements : [];
  const base64 = asString(capture.pngBase64);
  return {
    snapshotId: asString(capture.snapshotId),
    mode: asString(capture.mode) || 'plain',
    width: typeof capture.width === 'number' ? capture.width : 0,
    height: typeof capture.height === 'number' ? capture.height : 0,
    scale: typeof capture.scale === 'number' ? capture.scale : 1,
    totalElements: typeof capture.totalElements === 'number' ? capture.totalElements : 0,
    elements: elements.filter(isRecord).map((record) => ({
      ref: typeof record.ref === 'number' ? record.ref : 0,
      role: asString(record.role),
      name: asString(record.name),
      automationId: asString(record.automationId),
      enabled: record.enabled === true,
      sensitive: record.sensitive !== false,
    })),
    dataUrl: base64 ? `data:image/png;base64,${base64}` : '',
  };
}

export interface AoiBrowserDriveProfileView {
  userDataDir: string;
  configured: boolean;
  // The browser's own default directory, so the UI can say why it is refused.
  defaultProfileDir: string;
}

// Which browser profile Aoi drives. Chrome refuses remote debugging on its
// default profile, so this is a required setup step rather than a preference.
export async function fetchAoiBrowserDriveProfile(): Promise<AoiBrowserDriveProfileView> {
  const payload = await getJson('/browser-drive/profile');
  return {
    userDataDir: asString(payload.userDataDir),
    configured: payload.configured === true,
    defaultProfileDir: asString(payload.defaultProfileDir),
  };
}

// Pass an empty string to clear it.
export async function setAoiBrowserDriveProfile(
  userDataDir: string,
): Promise<AoiBrowserDriveProfileView> {
  const payload = await sendJson('/browser-drive/profile', 'POST', { userDataDir });
  return {
    userDataDir: asString(payload.userDataDir),
    configured: payload.configured === true,
    defaultProfileDir: asString(payload.defaultProfileDir),
  };
}

/**
 * Open the configured profile so the operator can sign in.
 *
 * Launched WITHOUT a debug port: this window is theirs, not Aoi's, and the drive
 * opens its own session later. Close it before driving -- a browser already
 * running on a profile swallows the next launch, so the debug port never opens.
 */
export async function openAoiBrowserDriveProfile(): Promise<string> {
  const payload = await sendJson('/browser-drive/profile/open', 'POST', {});
  return asString(payload.userDataDir);
}
