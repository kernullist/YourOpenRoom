import { describe, expect, it } from 'vitest';
import { isAoiPreferenceNearDuplicateContent } from '../aoiMemoryShared';

describe('isAoiPreferenceNearDuplicateContent', () => {
  it('merges same pref: key even when wording diverges', () => {
    expect(
      isAoiPreferenceNearDuplicateContent('I prefer dark mode in the IDE', '항상 다크 모드 써', {
        leftTags: ['preference', 'pref:editor.theme'],
        rightTags: ['preference', 'pref:editor.theme'],
      }),
    ).toBe(true);
  });

  it('catches short restatements that used to slip past the 0.8 bar', () => {
    expect(isAoiPreferenceNearDuplicateContent('한국어로 답변해줘', '답변은 한국어로 해줘')).toBe(
      true,
    );
  });

  it('does not merge opposite preferences', () => {
    expect(
      isAoiPreferenceNearDuplicateContent('I like classical music', 'I dislike classical music'),
    ).toBe(false);
  });
});
