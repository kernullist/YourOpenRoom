export const APP_ID = 28;
export const APP_NAME = 'Drive Console';
export const APP_STORAGE_NAME = 'driveconsole';

export const OperationActions = {
  SELECT_VIEW: 'SELECT_DRIVE_CONSOLE_VIEW',
} as const;

export const RefreshActions = {
  REFRESH: 'REFRESH_DRIVE_CONSOLE',
} as const;

export const SystemActions = {
  SYNC_STATE: 'SYNC_STATE',
} as const;

export const ActionTypes = {
  ...OperationActions,
  ...RefreshActions,
  ...SystemActions,
} as const;

/**
 * Actions this console must never gain.
 *
 * Everything that drives the user's real, logged-in browser stays behind an
 * operator click. The execute path is fail-closed on a human-approved, single-use
 * approval, and an agent action that could reach preview -> approve -> execute
 * would let Aoi authorize its own plan and act in that browser. Aoi already has
 * its own tool path (aoiBrowserDriveTools) that goes through the same gates; this
 * app is the operator's cockpit, not a second pair of hands.
 *
 * Enforced by __tests__/actionSafety.test.ts, not by memory.
 */
export const DELIBERATELY_UNEXPOSED_ACTIONS = [
  'PREVIEW_DRIVE_STEP',
  'EXECUTE_DRIVE_STEP',
  'APPROVE_DRIVE_STEP',
  'RUN_DRIVE_TASK',
  'READ_DRIVE_PAGE',
] as const;
