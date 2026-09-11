import { describe, expect, it } from 'vitest';
import type { ToolDef } from '../llmClient';
import {
  buildAoiAppEventTurnPolicyPrompt,
  isAoiAppEventMessage,
  scopeToolsForAoiAppEventTurn,
} from '../aoiAppEventTurn';

const tool = (name: string): ToolDef => ({
  type: 'function',
  function: {
    name,
    description: name,
    parameters: { type: 'object', properties: {}, required: [] },
  },
});

describe('isAoiAppEventMessage', () => {
  it('recognises the app event report and nothing else', () => {
    expect(
      isAoiAppEventMessage(
        '[User performed action in YouTube (appName: youtube, appId: 3)] action_type: PLAY_VIDEO, params: {}',
      ),
    ).toBe(true);
    expect(isAoiAppEventMessage('  [User performed action in Diary (appName: diary)] x')).toBe(
      true,
    );
    expect(isAoiAppEventMessage('[Background watch triggered] label: x')).toBe(false);
    expect(isAoiAppEventMessage('[aoi-nudge] something')).toBe(false);
    expect(isAoiAppEventMessage('User performed action in YouTube')).toBe(false);
    expect(isAoiAppEventMessage('')).toBe(false);
    expect(isAoiAppEventMessage(null)).toBe(false);
  });
});

describe('scopeToolsForAoiAppEventTurn', () => {
  it('keeps only the allowed tools, in order', () => {
    const tools = [
      tool('respond_to_user'),
      tool('file_write'),
      tool('app_action'),
      tool('host_process_spawn_preview'),
      tool('get_app_state'),
      tool('search_web'),
    ];
    expect(
      scopeToolsForAoiAppEventTurn(
        tools,
        new Set(['respond_to_user', 'app_action', 'get_app_state']),
      ).map((entry) => entry.function.name),
    ).toEqual(['respond_to_user', 'app_action', 'get_app_state']);
    expect(scopeToolsForAoiAppEventTurn([], new Set(['respond_to_user']))).toEqual([]);
  });
});

describe('buildAoiAppEventTurnPolicyPrompt', () => {
  it('states the report is not a request, forbids new work, and keeps the games exception', () => {
    const prompt = buildAoiAppEventTurnPolicyPrompt();
    expect(prompt).toContain('not a request to you');
    expect(prompt).toContain('no files');
    expect(prompt).toContain('games');
    expect(prompt).toContain('app_action');
    expect(prompt).not.toContain('meta.yaml');
  });
});
