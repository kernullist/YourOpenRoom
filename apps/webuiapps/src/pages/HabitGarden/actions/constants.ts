export const APP_ID = 27;
export const APP_NAME = 'Habit Garden';
export const APP_STORAGE_NAME = 'habitgarden';

export const OperationActions = {
  CHECK_IN: 'CHECK_IN_HABIT',
  UNDO_CHECK_IN: 'UNDO_HABIT_CHECK_IN',
  SELECT_HABIT: 'SELECT_HABIT',
} as const;

export const MutationActions = {
  CREATE_HABIT: 'CREATE_HABIT',
  UPDATE_HABIT: 'UPDATE_HABIT',
  DELETE_HABIT: 'DELETE_HABIT',
} as const;

export const RefreshActions = {
  REFRESH: 'REFRESH_HABIT_GARDEN',
} as const;

export const SystemActions = {
  SYNC_STATE: 'SYNC_STATE',
} as const;

export const ActionTypes = {
  ...OperationActions,
  ...MutationActions,
  ...RefreshActions,
  ...SystemActions,
} as const;

/**
 * Settings this app deliberately does NOT expose as agent actions.
 *
 * Unlike check-ins -- which are the user's own record and are the most natural
 * thing to ask Aoi to write down -- these two are consent switches. One decides
 * whether habit data flows to Aoi at all, and the other repaints the user's
 * desktop. An opt-in that the agent can switch on for itself is not an opt-in,
 * so the toggles stay DOM-only and __tests__/actionSafety.test.ts enforces it.
 */
export const DELIBERATELY_UNEXPOSED_ACTIONS = [
  'SET_GARDEN_SETTINGS',
  'SET_REFLECT_WEATHER_IN_ROOM',
  'SET_SHARE_MOMENTUM_WITH_AOI',
] as const;
