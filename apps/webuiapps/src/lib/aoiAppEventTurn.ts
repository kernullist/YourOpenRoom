// A turn that starts with "[User performed action in <App> …]" is a report of
// something the user just did in an in-room app, not a request. Aoi reacts to
// it in conversation; she does not start work of her own because of it.
//
// This is where the 2026-09-11 diary incident began: a YouTube PLAY_VIDEO report
// arrived with the full main toolset, the prompt said "read its meta.yaml and
// respond accordingly", and the model spent twelve tool calls writing a mission
// list into the Diary app. Initiative has its own path in this project (the
// autonomy loop, proposals, the L1-L4 gates, approval); a reaction turn with
// file tools bypasses all of it. So an event turn keeps the conversation tools
// and the app tools it needs to react (a game reports the user's move and Aoi
// answers with her own through app_action) and nothing that writes files, runs
// commands, drives the host, or searches the web.

import type { ToolDef } from './llmClient';

const APP_EVENT_MESSAGE_PATTERN = /^\s*\[User performed action in /;

export function isAoiAppEventMessage(text: string | null | undefined): boolean {
  return APP_EVENT_MESSAGE_PATTERN.test(text ?? '');
}

/** Keep only the tools an event turn may use, in their original order. */
export function scopeToolsForAoiAppEventTurn(
  tools: readonly ToolDef[],
  keepNames: ReadonlySet<string>,
): ToolDef[] {
  return tools.filter((tool) => keepNames.has(tool.function.name));
}

export function buildAoiAppEventTurnPolicyPrompt(): string {
  return [
    'When the user message is a report of the form "[User performed action in <App> (appName: xxx)] …", it is something the user just did, not a request to you.',
    'React to it in conversation: acknowledge it, comment, or offer something in one line. Do not start work of your own because of it -- no files, no writes to other apps, no research, no host actions. If it suggests something worth doing, offer it and wait for the user to ask.',
    "Exception: games. When a game app reports the user's move, make your own move through app_action. Use get_app_state / get_app_schema when you need the app's state; file tools are not available on these turns.",
  ].join('\n');
}
