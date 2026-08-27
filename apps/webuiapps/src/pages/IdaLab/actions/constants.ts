export const APP_ID = 31;
export const APP_NAME = 'IDA Lab';
export const APP_STORAGE_NAME = 'idalab';

export const OperationActions = {
  SELECT_SESSION: 'SELECT_IDA_SESSION',
  SET_SQL_DRAFT: 'SET_IDA_SQL_DRAFT',
  BROWSE: 'BROWSE_IDA_BINARIES',
} as const;

export const RefreshActions = {
  REFRESH: 'REFRESH_IDA_LAB',
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
 * Aoi already has first-class tools for the effectful paths (ida_analyze_start,
 * ida_sql_query), and those go through preview -> operator approval -> execute.
 * An app action that started a session, ran a write, approved a pending action,
 * edited the configured paths, or minted a standing grant would be a second
 * door into the same effects that skips the popup -- and the popup IS the
 * control. The window stays read-and-navigate only.
 *
 * Enforced by __tests__/actionSafety.test.ts.
 */
export const DELIBERATELY_UNEXPOSED_ACTIONS = [
  'START_IDA_ANALYSIS',
  'RUN_IDA_SQL',
  'STOP_IDA_SESSION',
  'APPROVE_IDA_ACTION',
  'SET_IDA_CONFIG',
  'ADD_IDA_BINARY_ROOT',
  'CREATE_IDA_GRANT',
  'ATTACH_IDA_GUI',
] as const;
