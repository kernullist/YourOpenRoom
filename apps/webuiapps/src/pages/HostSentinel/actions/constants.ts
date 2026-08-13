export const APP_ID = 29;
export const APP_NAME = 'Host Sentinel';
export const APP_STORAGE_NAME = 'hostsentinel';

export const OperationActions = {
  FILTER: 'FILTER_HOST_PROCESSES',
} as const;

export const RefreshActions = {
  REFRESH: 'REFRESH_HOST_SENTINEL',
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
 * Killing a process is irreversible and the execute path is fail-closed on a
 * human-approved, single-use approval. An agent action reaching preview ->
 * approve -> execute would let Aoi terminate processes on the real machine on
 * its own say-so. The kill-switch controls are excluded for the same reason
 * inverted: they are the operator's brake, and a brake the agent can release is
 * not a brake.
 *
 * Enforced by __tests__/actionSafety.test.ts.
 */
export const DELIBERATELY_UNEXPOSED_ACTIONS = [
  'PREVIEW_HOST_KILL',
  'EXECUTE_HOST_KILL',
  'APPROVE_HOST_KILL',
  'SET_HOST_KILLSWITCH',
  'CLEAR_HOST_PANIC',
] as const;
