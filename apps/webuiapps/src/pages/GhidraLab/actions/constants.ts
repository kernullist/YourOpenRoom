export const APP_ID = 32;
export const APP_NAME = 'Ghidra Lab';
export const APP_STORAGE_NAME = 'ghidralab';

export const OperationActions = {
  SELECT_SESSION: 'SELECT_GHIDRA_SESSION',
  SELECT_RUN: 'SELECT_GHIDRA_RUN',
  BROWSE: 'BROWSE_GHIDRA_BINARIES',
  SET_TAB: 'SET_GHIDRA_TAB',
} as const;

export const RefreshActions = {
  REFRESH: 'REFRESH_GHIDRA_LAB',
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
 * Actions this app must never gain.
 *
 * Aoi already has first-class tools for the effectful paths
 * (ghidra_analyze_start, ghidra_report_run), and those go through
 * preview -> operator approval -> execute. An app action that started a session,
 * started a sweep, approved a pending action, edited the configured paths, or
 * created the Python environment would be a second door into the same effects
 * that skips the popup -- and the popup IS the control.
 *
 * The bootstrap one matters most: it installs software. It stays operator-only,
 * behind a button in this window, and out of every automated surface.
 *
 * Enforced by __tests__/actionSafety.test.ts.
 */
export const DELIBERATELY_UNEXPOSED_ACTIONS = [
  'START_GHIDRA_ANALYSIS',
  'STOP_GHIDRA_SESSION',
  'RUN_GHIDRA_SWEEP',
  'CANCEL_GHIDRA_SWEEP',
  'APPROVE_GHIDRA_ACTION',
  'SET_GHIDRA_CONFIG',
  'ADD_GHIDRA_BINARY_ROOT',
  'BOOTSTRAP_GHIDRA_PYTHON',
] as const;
