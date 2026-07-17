import { describe, expect, it } from 'vitest';

import { buildAoiUndeliveredConversationFailureMessage } from '../aoiConversationFailure';

describe('buildAoiUndeliveredConversationFailureMessage()', () => {
  it('builds a Korean fail-visible response and keeps only recent tool steps', () => {
    const message = buildAoiUndeliveredConversationFailureMessage({
      userMessage: '이 파일을 읽어줘',
      iterations: 9,
      pendingToolCalls: ['first', 'file_read(a.md)', 'file_list(src)', 'ide_read_file(src/a.ts)'],
    });

    expect(message).toContain('Aoi 오류');
    expect(message).toContain('9회');
    expect(message).toContain('file_read(a.md)');
    expect(message).toContain('ide_read_file(src/a.ts)');
    expect(message).not.toContain('first');
  });

  it('builds an English response when the request has no Korean text', () => {
    const message = buildAoiUndeliveredConversationFailureMessage({
      userMessage: 'Read this file',
      iterations: 2.9,
    });

    expect(message).toContain('Aoi error');
    expect(message).toContain('2 model/tool iterations');
    expect(message).toContain('chat input was preserved');
  });
});
