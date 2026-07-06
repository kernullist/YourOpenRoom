/**
 * YouTube app constants
 *
 * Actions represent methods the Agent can invoke on the App, divided into
 * two categories used by this app:
 * - Operation Actions: directly execute an in-app method
 * - System Actions: system-level state synchronization
 */

export const APP_ID = 3;
export const APP_NAME = 'youtube';

// File paths
export const STATE_FILE = '/state.json';

// Operation Actions — App directly executes the corresponding method
export const OperationActions = {
  OPEN_SEARCH: 'OPEN_SEARCH',
  OPEN_HOME: 'OPEN_HOME',
  OPEN_VIDEO: 'OPEN_VIDEO',
  PLAY_LAST_PLAYLIST: 'PLAY_LAST_PLAYLIST',
} as const;

// System Actions — system-level
export const SystemActions = {
  SYNC_STATE: 'SYNC_STATE',
} as const;

// All Action Types
export const ActionTypes = {
  ...OperationActions,
  ...SystemActions,
} as const;
