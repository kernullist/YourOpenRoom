import { describe, expect, it } from 'vitest';
import { parseDirectMusicIntent } from '../chatDirectActions';

describe('parseDirectMusicIntent', () => {
  it('treats Korean go-with phrasing as a direct YouTube music search', () => {
    expect(parseDirectMusicIntent('6월 걸그룹 노래로 가자')).toEqual({
      query: '6월 걸그룹',
    });
  });

  it('enriches generic girl group replies from recent assistant context', () => {
    expect(
      parseDirectMusicIntent('걸그룹 노래로 가자', [
        {
          role: 'assistant',
          content: '내 추천은 **6월 걸그룹 쪽으로 가볍게 시작**. 틀어줄 곡만 골라.',
        },
      ]),
    ).toEqual({
      query: '6월 걸그룹',
    });
  });

  it('uses the latest explicit YouTube query when the user asks Aoi to choose', () => {
    expect(
      parseDirectMusicIntent('네가 골라', [
        {
          role: 'assistant',
          content: 'YouTube 검색어:\n`KATSEYE Gabriela Official MV`',
        },
      ]),
    ).toEqual({
      query: 'KATSEYE Gabriela Official MV',
    });
  });
});
