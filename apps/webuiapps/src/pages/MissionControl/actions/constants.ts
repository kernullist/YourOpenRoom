export const APP_ID = 26;
export const APP_NAME = 'Mission Control';
export const APP_STORAGE_NAME = 'missioncontrol';

// Read and navigation only.
export const OperationActions = {
  SELECT_VIEW: 'SELECT_MISSION_CONTROL_VIEW',
  SELECT_SESSION: 'SELECT_MISSION_CONTROL_SESSION',
} as const;

export const RefreshActions = {
  REFRESH: 'REFRESH_MISSION_CONTROL',
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
 * Actions this app deliberately does NOT expose, and must never gain.
 *
 * Approving a proposal, raising the autonomy policy, and running a tick are all
 * reachable from this app's UI -- but only from DOM click handlers. Exposing any
 * of them as an agent action would let Aoi drive them through reportAction,
 * turning an observability surface into a bypass of the no-self-approval
 * invariant (L5 is unreachable by auto-promotion, and promotion writes throw for
 * any actor other than 'user'). That invariant is structural precisely because
 * it must not depend on anyone remembering it, so the separation is enforced by
 * __tests__/actionSafety.test.ts rather than by this comment.
 *
 * Listed here so the omission reads as a decision, not an oversight.
 */
export const DELIBERATELY_UNEXPOSED_ACTIONS = [
  'APPROVE_PROPOSAL',
  'DISMISS_PROPOSAL',
  'EXECUTE_PROPOSAL',
  'SET_AUTONOMY_POLICY',
  'RUN_TICK',
] as const;
