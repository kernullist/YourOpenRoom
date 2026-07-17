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

// Reported Events — App → Agent notifications only (NOT agent-callable, so
// they are intentionally excluded from ActionTypes and the action handler).
// PLAY_VIDEO fires when the user starts playback of a specific video, carrying
// { video_id, title, channel, queue } so the agent knows what is playing.
export const ReportedEvents = {
  PLAY_VIDEO: 'PLAY_VIDEO',
} as const;

// All Action Types
export const ActionTypes = {
  ...OperationActions,
  ...SystemActions,
} as const;
