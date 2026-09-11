// Postcondition: app data Aoi wrote is data the app has been told about.
//
// Every in-room app's meta.yaml says the same thing in its header: the agent
// writes the file, then dispatches the matching action (CREATE_ENTRY,
// UPDATE_NOTE, ...) so the frontend re-reads it. The write alone is invisible;
// an app re-reads its data directory only at startup. On 2026-09-11 the model
// wrote apps/diary/data/entries/mission-list-2026-09-11.json (success), then
// spent its last iterations focusing the window, ran into the loop guard, and
// told the user the entry was on the page. The file was real; the page showed
// "No diaries yet".
//
// Two things close that, both structural, neither reading prose:
//
//   1. The runtime finishes the protocol itself. After a successful write under
//      apps/<app>/data/ while that app's window is open, it plans the sync
//      action from the app's declared actions (a CREATE_/UPDATE_/DELETE_ action
//      whose params are a file path or an id; for the app's own state file only
//      a parameterless REFRESH_/SYNC_STATE) and dispatches it. The model is told
//      what ran.
//   2. respond_to_user is checked per written file: a file written while its
//      app was open, with no successful sync covering it -- runtime or model --
//      fails the postcondition, and the correction names the exact call.
//      Enforced only when a plan exists; a contract the model cannot satisfy
//      would loop.
//
// The obligation is decided at write time. An app that was closed when the file
// was written re-reads it when it opens (including an open the model does later
// in the same turn), so nothing is owed and nothing is dispatched for it, which
// also keeps the runtime from opening windows nobody asked for
// (dispatchAgentAction opens its target).

import type { AppActionDef, AppDef } from './appRegistry';

export type AoiAppDataWriteTool = 'file_write' | 'file_patch' | 'file_delete';

export const AOI_APP_DATA_WRITE_TOOLS: ReadonlySet<string> = new Set([
  'file_write',
  'file_patch',
  'file_delete',
]);

export interface AoiAppDataWriteRecord {
  tool: AoiAppDataWriteTool;
  appId: number;
  appName: string;
  // The path the tool was given, normalised to forward slashes, no leading slash.
  filePath: string;
  // The path the app knows the file by: relative to apps/<app>/data, with a
  // leading slash ("/entries/x.json"), which is how meta.yaml params spell it.
  appRelativePath: string;
  // Whether the app's window was open when the write landed. Only then does
  // the app hold stale data that a sync has to replace.
  appWindowOpenAtWrite: boolean;
}

export interface AoiAppSyncDispatchRecord {
  appId: number;
  actionType: string;
  params?: Record<string, string>;
  result: string;
  // Whether the runtime dispatched it after the write, or the model did.
  source: 'runtime' | 'model';
}

export interface AoiAppMutationSyncEvidence {
  writes: AoiAppDataWriteRecord[];
  dispatches: AoiAppSyncDispatchRecord[];
}

export function createAoiAppMutationSyncEvidence(): AoiAppMutationSyncEvidence {
  return { writes: [], dispatches: [] };
}

// dispatchAgentAction and the file tools both resolve with "error:" / "timeout:"
// rather than throwing; success is the absence of those, not of an exception.
export function isFailedAoiToolResult(result: string): boolean {
  const normalized = result.trim().toLowerCase();
  return normalized === '' || normalized.startsWith('error:') || normalized.startsWith('timeout:');
}

const APP_DATA_PATH_PATTERN = /^apps\/([^/]+)\/data\/(.+)$/i;

/** Split a tool file path into the app it belongs to and the app-relative path. */
export function parseAoiAppDataPath(
  filePath: string,
): { appName: string; filePath: string; appRelativePath: string } | null {
  const normalized = String(filePath ?? '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .trim();
  const match = normalized.match(APP_DATA_PATH_PATTERN);
  if (!match) {
    return null;
  }
  const rest = match[2].replace(/^\/+/, '');
  if (!rest || rest.endsWith('/')) {
    return null;
  }
  return { appName: match[1].toLowerCase(), filePath: normalized, appRelativePath: `/${rest}` };
}

export function observeAoiAppDataWrite(
  evidence: AoiAppMutationSyncEvidence,
  record: { tool: string; filePath: string; result: string; appWindowOpen: boolean },
  apps: readonly Pick<AppDef, 'appId' | 'appName'>[],
): AoiAppMutationSyncEvidence {
  if (!AOI_APP_DATA_WRITE_TOOLS.has(record.tool) || isFailedAoiToolResult(record.result)) {
    return evidence;
  }
  const parsed = parseAoiAppDataPath(record.filePath);
  if (!parsed) {
    return evidence;
  }
  const app = apps.find((entry) => entry.appName.toLowerCase() === parsed.appName);
  if (!app) {
    return evidence;
  }
  return {
    ...evidence,
    writes: [
      ...evidence.writes,
      {
        tool: record.tool as AoiAppDataWriteTool,
        appId: app.appId,
        appName: app.appName,
        filePath: parsed.filePath,
        appRelativePath: parsed.appRelativePath,
        appWindowOpenAtWrite: record.appWindowOpen,
      },
    ],
  };
}

export function observeAoiAppSyncDispatch(
  evidence: AoiAppMutationSyncEvidence,
  record: AoiAppSyncDispatchRecord,
): AoiAppMutationSyncEvidence {
  return { ...evidence, dispatches: [...evidence.dispatches, record] };
}

// The action families that tell an app its data changed. Everything else an app
// declares (SELECT_*, OPEN_*, PLAY_*) is navigation or control, not sync.
const RECORD_SYNC_PATTERN = /^(?:CREATE|UPDATE|DELETE|REMOVE|IMPORT)_/i;
const WHOLE_APP_SYNC_PATTERN = /^(?:REFRESH|RELOAD|SYNC)_/i;

export function isAoiAppSyncActionType(actionType: string): boolean {
  const normalized = actionType.trim().toUpperCase();
  return (
    normalized === 'SYNC_STATE' ||
    RECORD_SYNC_PATTERN.test(normalized) ||
    WHOLE_APP_SYNC_PATTERN.test(normalized)
  );
}

function isWholeAppSyncActionType(actionType: string): boolean {
  const normalized = actionType.trim().toUpperCase();
  return normalized === 'SYNC_STATE' || WHOLE_APP_SYNC_PATTERN.test(normalized);
}

// A file directly under the data root (state.json, settings.json) is the app's
// own state, not a record; CREATE_ENTRY on it would make the Diary read state
// as an entry. Only a whole-app refresh fits it.
export function isAoiAppStateFile(write: Pick<AoiAppDataWriteRecord, 'appRelativePath'>): boolean {
  return write.appRelativePath.split('/').filter(Boolean).length === 1;
}

const PATH_PARAM_PATTERN = /^(?:file_?path|path|entry_?path|note_?path)$/i;
// "id", "entry_id", "entryId", "focusId": the file stem is what every app uses
// as the id of a data file (validateIdMatchesFile enforces it on write).
const ID_PARAM_PATTERN = /(?:^id$|_id$|[a-z]Id$)/;

export function aoiAppDataFileStem(appRelativePath: string): string {
  const name = appRelativePath.split('/').filter(Boolean).pop() ?? '';
  return name.replace(/\.[^.]+$/, '');
}

function paramsFor(
  action: AppActionDef,
  write: AoiAppDataWriteRecord,
): Record<string, string> | null {
  const params: Record<string, string> = {};
  for (const param of action.params ?? []) {
    if (PATH_PARAM_PATTERN.test(param.name)) {
      params[param.name] = write.appRelativePath;
    } else if (ID_PARAM_PATTERN.test(param.name)) {
      params[param.name] = aoiAppDataFileStem(write.appRelativePath);
    } else if (param.required) {
      // A required param we cannot derive from the write: this action is not
      // something the runtime can send on the model's behalf.
      return null;
    }
  }
  return params;
}

export interface AoiAppSyncPlan {
  actionType: string;
  params: Record<string, string>;
}

/**
 * The action the runtime can dispatch to tell `app` about `write`, or null when
 * the app declares nothing the runtime can fill in. Preference by tool:
 * file_delete -> DELETE_*; file_patch -> UPDATE_* then CREATE_*; file_write ->
 * CREATE_* then UPDATE_* (an app's create handler re-reads the file either way).
 * A parameterless REFRESH_* / SYNC_STATE is the fallback for all three and the
 * only choice for the app's state file.
 */
export function planAoiAppSyncDispatch(
  write: AoiAppDataWriteRecord,
  app: { actions?: AppActionDef[] },
): AoiAppSyncPlan | null {
  const actions = (app.actions ?? []).filter((action) => isAoiAppSyncActionType(action.name));
  if (actions.length === 0) {
    return null;
  }
  const preference = isAoiAppStateFile(write)
    ? []
    : write.tool === 'file_delete'
      ? [/^(?:DELETE|REMOVE)_/i]
      : write.tool === 'file_patch'
        ? [/^UPDATE_/i, /^CREATE_/i]
        : [/^CREATE_/i, /^UPDATE_/i];
  const ordered = [
    ...preference.flatMap((pattern) => actions.filter((action) => pattern.test(action.name))),
    ...actions.filter((action) => isWholeAppSyncActionType(action.name)),
  ];
  for (const action of ordered) {
    const params = paramsFor(action, write);
    if (params) {
      return { actionType: action.name, params };
    }
  }
  return null;
}

/**
 * Whether a dispatch tells the app about this particular file: a whole-app
 * refresh covers everything; a record action covers the file its params name,
 * by app-relative path, tool path, or file stem (however the model spelled it).
 */
export function aoiAppSyncDispatchCoversWrite(
  dispatch: AoiAppSyncDispatchRecord,
  write: AoiAppDataWriteRecord,
): boolean {
  if (dispatch.appId !== write.appId || !isAoiAppSyncActionType(dispatch.actionType)) {
    return false;
  }
  if (isWholeAppSyncActionType(dispatch.actionType)) {
    return true;
  }
  const values = Object.values(dispatch.params ?? {}).map((value) =>
    String(value ?? '')
      .replace(/\\/g, '/')
      .trim(),
  );
  if (values.length === 0) {
    // A record action with no params cannot name the file; count it as an
    // attempt at the app rather than at nothing.
    return true;
  }
  const stem = aoiAppDataFileStem(write.appRelativePath);
  return values.some(
    (value) =>
      value === write.appRelativePath ||
      value.replace(/^\/+/, '') === write.appRelativePath.replace(/^\/+/, '') ||
      value.replace(/^\/+/, '') === write.filePath ||
      value === stem,
  );
}

export function formatAoiAppSyncNoteForModel(
  appName: string,
  plan: AoiAppSyncPlan,
  write: AoiAppDataWriteRecord,
  result: string,
): string {
  const paramText = JSON.stringify(plan.params);
  return isFailedAoiToolResult(result)
    ? `\n[app sync] ${appName} ${plan.actionType}(${paramText}) for ${write.appRelativePath} -> FAILED (${result.slice(0, 120)}). The file is saved but the open ${appName} window has NOT refreshed; tell the user so, do not describe the change as visible.`
    : `\n[app sync] ${appName} ${plan.actionType}(${paramText}) for ${write.appRelativePath} -> ok. The open ${appName} window has been told about this file; no further app_action is needed for it.`;
}

export interface AoiAppMutationSyncPendingWrite {
  write: AoiAppDataWriteRecord;
  // What the model could call for this file; null means the app declares
  // nothing that would tell it, and the contract cannot be enforced for it.
  plan: AoiAppSyncPlan | null;
  // A sync was dispatched for this file and failed: reported through the
  // transcript, not re-demanded.
  attemptedButFailed: boolean;
}

export interface AoiAppMutationSyncPending {
  appId: number;
  appName: string;
  writes: AoiAppMutationSyncPendingWrite[];
}

export interface AoiAppMutationSyncVerification {
  passed: boolean;
  enforced: boolean;
  issues: string[];
  pending: AoiAppMutationSyncPending[];
}

/**
 * Check every file this turn wrote while its app was open. Each must be
 * covered by a successful sync dispatch to that app. A failed attempt counts as
 * attempted (the model was told; re-dispatching would usually fail again), and
 * a file with no plan cannot block; both are still reported as pending so the
 * failure message can name them.
 */
export function verifyAoiAppMutationSyncContract(params: {
  evidence: AoiAppMutationSyncEvidence;
  apps: readonly Pick<AppDef, 'appId' | 'appName' | 'actions'>[];
}): AoiAppMutationSyncVerification {
  const { evidence, apps } = params;
  const byApp = new Map<number, AoiAppMutationSyncPending>();
  const seen = new Set<string>();
  for (const write of evidence.writes) {
    if (!write.appWindowOpenAtWrite) {
      continue;
    }
    const key = `${write.appId}:${write.appRelativePath}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const covering = evidence.dispatches.filter((dispatch) =>
      aoiAppSyncDispatchCoversWrite(dispatch, write),
    );
    if (covering.some((dispatch) => !isFailedAoiToolResult(dispatch.result))) {
      continue;
    }
    const app = apps.find((entry) => entry.appId === write.appId);
    const entry = byApp.get(write.appId) ?? {
      appId: write.appId,
      appName: write.appName,
      writes: [],
    };
    entry.writes.push({
      write,
      plan: app ? planAoiAppSyncDispatch(write, app) : null,
      attemptedButFailed: covering.length > 0,
    });
    byApp.set(write.appId, entry);
  }
  const pending = [...byApp.values()];
  const blocking = pending.flatMap((entry) =>
    entry.writes.filter((item) => item.plan !== null && !item.attemptedButFailed),
  );
  const issues = blocking.map(
    (item) =>
      `${item.write.appName} data written (${item.write.appRelativePath}) but the open ${item.write.appName} window was not told; call ${item.plan?.actionType}`,
  );
  return {
    passed: blocking.length === 0,
    enforced: pending.length > 0,
    issues,
    pending,
  };
}

export function buildAoiAppMutationSyncCorrectionPrompt(
  verification: AoiAppMutationSyncVerification,
): string {
  const lines: string[] = [
    'Postcondition failed: you wrote app data but did not tell the app, so the open window still shows the old data.',
  ];
  for (const entry of verification.pending) {
    const calls = entry.writes
      .filter((item) => item.plan !== null && !item.attemptedButFailed)
      .map(
        (item) =>
          `app_action(app_name="${entry.appName}", action_type="${item.plan?.actionType}", params=${JSON.stringify(item.plan?.params ?? {})})`,
      );
    if (calls.length > 0) {
      lines.push(`- ${entry.appName}: ${calls.join('; ')}`);
    }
  }
  lines.push(
    'Call the action(s) above now, then respond_to_user. Until a sync succeeds, do not say the change is showing in the app; say the file is saved and the app has not refreshed.',
  );
  return lines.join('\n');
}

export function buildAoiAppMutationSyncFailureMessage(
  verification: AoiAppMutationSyncVerification,
): string {
  if (verification.passed) {
    return '';
  }
  const apps = [...new Set(verification.pending.map((entry) => entry.appName))];
  return `App data was written for ${apps.join(', ')} but the app was not refreshed; reopen it to see the change.`;
}
