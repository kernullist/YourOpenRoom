// Client-side wrapper for the host-bridge daemon API (/api/aoi-host/*).
//
// Same-origin: the Vite dev mount (vite.config.ts) trusts loopback callers, so no
// token is attached here -- the browser never holds the secret. Against the
// standalone daemon a caller WOULD need the x-aoi-host-bridge-token header; this
// wrapper targets the dev/same-origin mount. Mirrors aoiAutonomyClient's
// fetch + parse shape (throw on !ok, surface denyReasons).

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
    throw new Error(reasons.length > 0 ? `${base} [${reasons.join(', ')}]` : base);
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
}

export interface AoiHostBrowserDriveActExecuteView {
  ok: boolean;
  stepIndex: number;
  stopReason?: string;
  finalUrl?: string;
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
  return {
    ok: payload.ok === true && result.ok === true,
    stepIndex: typeof result.stepIndex === 'number' ? result.stepIndex : targetStepIndex,
    ...(typeof target.stopReason === 'string' ? { stopReason: target.stopReason } : {}),
    ...(typeof target.finalUrl === 'string' ? { finalUrl: target.finalUrl } : {}),
  };
}

// --- Browser-drive bounded task (BD P3.2) ------------------------------------

export interface AoiHostBrowserDriveTaskStepView {
  index: number;
  ok: boolean;
  reason?: string;
  finalUrl?: string;
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
