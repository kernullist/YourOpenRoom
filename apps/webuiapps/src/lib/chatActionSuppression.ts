const LOW_SIGNAL_APP_ACTIONS = new Set([
  'REFRESH_AOI_MEMORY_DASHBOARD',
  'REFRESH_AOI_RESEARCH_RUNS',
  'REFRESH_DEWDROP_CANVAS',
  'REFRESH_WRITTEN_BY_ME',
]);

export interface UserActionConversationApp {
  appId: number;
  appName: string;
  displayName: string;
}

export interface UserActionConversationAction {
  action_type: string;
  params?: Record<string, string>;
}

export function shouldSuppressUserActionConversation(
  app: UserActionConversationApp,
  action: UserActionConversationAction,
): boolean {
  if (app.appName === 'os') {
    if (action.action_type === 'OPEN_APP' || action.action_type === 'CLOSE_APP') {
      return true;
    }
  }

  if (LOW_SIGNAL_APP_ACTIONS.has(action.action_type)) {
    return true;
  }

  return false;
}
