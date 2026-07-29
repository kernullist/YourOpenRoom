import { describe, expect, it } from 'vitest';

import {
  CHARACTER_EMOTION_FALLBACKS,
  CHARACTER_EMOTION_LIST,
  DEFAULT_CHARACTER,
  resolveCharacterEmotionVideos,
  resolveEmotionMedia,
  type CharacterConfig,
} from '../characterManager';

const ADDED_EMOTIONS = ['curious', 'excited', 'proud', 'worried'] as const;

function characterWith(emotionVideos: Record<string, string[]> | undefined): CharacterConfig {
  return {
    id: 'test-char',
    character_name: 'Test',
    character_gender_desc: '',
    character_desc: '',
    character_emotion_list: [...CHARACTER_EMOTION_LIST],
    character_meta_info: {
      base_image_url: '/base.png',
      ...(emotionVideos ? { emotion_videos: emotionVideos } : {}),
    },
  };
}

describe('extended emotion vocabulary (R6.1)', () => {
  it('adds the partner-grade states to the shared list', () => {
    for (const emotion of ADDED_EMOTIONS) {
      expect(CHARACTER_EMOTION_LIST).toContain(emotion);
    }
    // The original six stay, so existing characters keep working.
    for (const emotion of ['default', 'happy', 'shy', 'peaceful', 'depressing', 'angry']) {
      expect(CHARACTER_EMOTION_LIST).toContain(emotion);
    }
  });

  it('ships a clip for every added emotion on the default character', () => {
    const videos = DEFAULT_CHARACTER.character_meta_info?.emotion_videos ?? {};
    for (const emotion of ADDED_EMOTIONS) {
      expect(videos[emotion]?.length ?? 0).toBeGreaterThan(0);
      expect(videos[emotion]?.[0]).toContain(`${emotion}_0.mp4`);
    }
  });

  it('maps every added emotion to a fallback that actually exists', () => {
    for (const emotion of ADDED_EMOTIONS) {
      const fallback = CHARACTER_EMOTION_FALLBACKS[emotion];
      expect(fallback).toBeTruthy();
      // The fallback must be one of the original clips, or it could dangle.
      expect(
        DEFAULT_CHARACTER.character_meta_info?.emotion_videos?.[fallback]?.length ?? 0,
      ).toBeGreaterThan(0);
    }
  });
});

describe('resolveCharacterEmotionVideos', () => {
  it('prefers an emotion that has its own clips', () => {
    expect(
      resolveCharacterEmotionVideos({ curious: ['/c.mp4'], default: ['/d.mp4'] }, 'curious'),
    ).toEqual(['/c.mp4']);
  });

  it('falls back to the nearest expression when the clip is missing', () => {
    expect(resolveCharacterEmotionVideos({ default: ['/d.mp4'] }, 'curious')).toEqual(['/d.mp4']);
    expect(resolveCharacterEmotionVideos({ happy: ['/h.mp4'] }, 'excited')).toEqual(['/h.mp4']);
    expect(resolveCharacterEmotionVideos({ happy: ['/h.mp4'] }, 'proud')).toEqual(['/h.mp4']);
    expect(resolveCharacterEmotionVideos({ peaceful: ['/p.mp4'] }, 'worried')).toEqual(['/p.mp4']);
  });

  it('treats an empty clip list as missing', () => {
    expect(resolveCharacterEmotionVideos({ curious: [], default: ['/d.mp4'] }, 'curious')).toEqual([
      '/d.mp4',
    ]);
  });

  it('returns nothing when neither the emotion nor its fallback exists', () => {
    expect(resolveCharacterEmotionVideos({ angry: ['/a.mp4'] }, 'curious')).toEqual([]);
    expect(resolveCharacterEmotionVideos(undefined, 'curious')).toEqual([]);
    // An emotion with no fallback mapping at all resolves to nothing, not to a
    // wrong expression.
    expect(resolveCharacterEmotionVideos({ happy: ['/h.mp4'] }, 'unknown_emotion')).toEqual([]);
  });
});

describe('resolveEmotionMedia with the added emotions', () => {
  it('serves the added clip when present', () => {
    const media = resolveEmotionMedia(DEFAULT_CHARACTER, 'worried');
    expect(media?.type).toBe('video');
    expect(media?.url).toContain('worried_0.mp4');
  });

  it('serves the nearest expression for a character missing the new assets', () => {
    const media = resolveEmotionMedia(
      characterWith({ happy: ['/legacy/happy.mp4'], default: ['/legacy/default.mp4'] }),
      'excited',
    );
    expect(media?.url).toBe('/legacy/happy.mp4');
  });

  it('still resolves something for a character with no matching clip at all', () => {
    const media = resolveEmotionMedia(characterWith(undefined), 'curious');
    // Falls through to the pre-existing generic chain rather than returning
    // nothing, so the avatar never blanks out on an added emotion.
    expect(media?.url).toBe('/base.png');
  });
});
