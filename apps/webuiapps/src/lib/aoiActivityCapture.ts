// Aoi activity capture helpers (SA1.3): the CLIENT-SAFE, pure mapping layer
// between host-side user-action events and metadata-only activity events.
//
// Boundary rules (load-bearing):
// - PURE + browser-safe: no fs/server imports (ChatPanel bundles this module).
// - METADATA ONLY leaves this layer: the mapper emits {kind, appId, actionType}
//   and nothing else -- action params and message content never cross.
// - Consent pre-check is a COURTESY gate to avoid useless requests; the server
//   route re-enforces the real consent gate fail-closed regardless.
// - Agent-triggered actions (trigger_by === 2) are Aoi's own dispatches, not
//   user activity -- they are never captured (no self-observation loop).

export const AOI_ACTIVITY_CAPTURE_SOURCE_ID = 'app-activity';

const OS_APP_ID = 1;

export interface AoiActivityCaptureUserAction {
  app_id?: number;
  action_type?: string;
  params?: Record<string, string>;
  trigger_by?: number;
}

export interface AoiActivityCaptureEventInput {
  kind: 'app_opened' | 'app_closed' | 'app_action' | 'chat_turn';
  appId?: string;
  actionType?: string;
}

export interface AoiActivityCaptureRegistryLike {
  sources: Array<{ id: string; enabled: boolean }>;
}

// True only when the operator explicitly enabled the app-activity source.
// Missing registry / missing source / disabled all read as NOT consented.
export function isAoiActivityCaptureConsented(
  registry: AoiActivityCaptureRegistryLike | null | undefined,
): boolean {
  return (
    registry?.sources.some(
      (source) => source.id === AOI_ACTIVITY_CAPTURE_SOURCE_ID && source.enabled === true,
    ) === true
  );
}

// Map a host-side user-action event to a metadata-only activity event input.
// Returns null for anything that must not be captured (agent-triggered,
// unresolvable app, unknown OS action).
export function mapAoiUserActionToActivityCapture(
  action: AoiActivityCaptureUserAction | null | undefined,
  resolveAppName: (appId: number) => string | null,
): AoiActivityCaptureEventInput | null {
  if (!action || typeof action.action_type !== 'string' || !action.action_type) {
    return null;
  }
  if (action.trigger_by === 2) {
    return null;
  }
  if (action.app_id === OS_APP_ID) {
    if (action.action_type !== 'OPEN_APP' && action.action_type !== 'CLOSE_APP') {
      return null;
    }
    const targetAppId = Number(action.params?.app_id);
    if (!Number.isFinite(targetAppId) || targetAppId === OS_APP_ID) {
      return null;
    }
    const appName = resolveAppName(targetAppId);
    if (!appName) {
      return null;
    }
    return {
      kind: action.action_type === 'OPEN_APP' ? 'app_opened' : 'app_closed',
      appId: appName,
    };
  }
  if (typeof action.app_id !== 'number') {
    return null;
  }
  const appName = resolveAppName(action.app_id);
  if (!appName) {
    return null;
  }
  return {
    kind: 'app_action',
    appId: appName,
    actionType: action.action_type,
  };
}
