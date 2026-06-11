import { describe, expect, it } from 'vitest';

import { buildAoiResearchStartAckMessage } from '../aoiResearchAck';

describe('buildAoiResearchStartAckMessage()', () => {
  it('builds a Korean acknowledgement for a background research start', () => {
    const message = buildAoiResearchStartAckMessage(
      JSON.stringify({
        ok: true,
        background: true,
        run: {
          id: 'aoi-research-test-1234',
          status: 'running',
          phase: 'searching',
          statusMessage: 'Searching the web with Tavily.',
        },
      }),
      'ko',
    );

    expect(message).toContain('연구를 시작했어');
    expect(message).toContain('aoi-research-test-1234');
    expect(message).toContain('웹 검색');
    expect(message).toContain('다른 대화를 계속해도 돼');
  });

  it('returns null for non-background or invalid results', () => {
    expect(buildAoiResearchStartAckMessage('error: failed', 'ko')).toBeNull();
    expect(
      buildAoiResearchStartAckMessage(
        JSON.stringify({
          ok: true,
          background: false,
          run: {
            id: 'aoi-research-test-1234',
            status: 'completed',
            phase: 'completed',
          },
        }),
        'ko',
      ),
    ).toBeNull();
  });
});
