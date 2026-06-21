import { describe, expect, it } from 'vitest';

import {
  normalizeAppActionParams,
  parseAppActionToolParams,
  parseAppActionToolParamsWithValidation,
} from '../appActionParams';

describe('appActionParams', () => {
  it('preserves JSON-string app action params', () => {
    expect(normalizeAppActionParams('{"content":"hello","save":true}')).toEqual({
      content: 'hello',
      save: 'true',
    });
  });

  it('preserves object app action params from providers that skip stringification', () => {
    const parsed = parseAppActionToolParams({
      app_name: 'openvscode',
      action_type: 'APPEND_ACTIVE_FILE',
      params: {
        content: 'new notes',
        position: 'end',
        save: true,
      },
    });

    expect(parsed).toEqual({
      appName: 'openvscode',
      actionType: 'APPEND_ACTIVE_FILE',
      params: {
        content: 'new notes',
        position: 'end',
        save: 'true',
      },
    });
  });

  it('reports malformed JSON params for authority-gated mutations', () => {
    const parsed = parseAppActionToolParamsWithValidation({
      app_name: 'kira',
      action_type: 'APPLY_MODEL_SETTINGS',
      params: '{"reasoningEffort":"high"',
    });

    expect(parsed.params).toEqual({});
    expect(parsed.paramsMalformed).toBe(true);
    expect(parsed.parseErrors).toContain('params_malformed_json');
  });
});
