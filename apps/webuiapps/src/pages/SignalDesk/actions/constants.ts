export const APP_ID = 30;
export const APP_NAME = 'Signal Desk';
export const APP_STORAGE_NAME = 'signaldesk';

export const OperationActions = {
  SELECT_VIEW: 'SELECT_SIGNAL_DESK_VIEW',
} as const;

export const RefreshActions = {
  REFRESH_SIGNALS: 'REFRESH_SIGNALS',
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
 * Actions this desk must never gain.
 *
 * START_RESEARCH would let the agent spawn an AoiResearch run — an LLM+web
 * pipeline with real budget and network cost — through this app. Aoi already
 * has its own research tool path with its own gates; the desk hands off on an
 * operator click only.
 *
 * REFRESH_SIGNALS stays exposed on purpose: it is a read-only, idempotent GET
 * against a fixed in-plugin source registry, the same fetch the app performs
 * on open, and no action parameter can influence any outbound URL.
 *
 * Enforced by __tests__/actionSafety.test.ts, not by memory.
 */
export const DELIBERATELY_UNEXPOSED_ACTIONS = ['START_RESEARCH'] as const;
