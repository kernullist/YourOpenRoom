import { beforeEach, describe, expect, it } from 'vitest';
import {
  loadPendingIdleMusicOffer,
  loadPendingNewsOffer,
  loadPendingPreferencePoll,
  loadPendingTastePoll,
  savePendingIdleMusicOffer,
  savePendingNewsOffer,
  savePendingPreferencePoll,
  savePendingTastePoll,
  type PendingIdleMusicOffer,
  type PendingNewsOffer,
  type PendingPreferencePoll,
  type PendingTastePoll,
} from '../aoiPendingOffers';

const MUSIC_KEY = 'aoi-pending-idle-music-offer-v1';
const NEWS_KEY = 'aoi-pending-news-offer-v1';

const musicOffer: PendingIdleMusicOffer = {
  playPrompt: '▶ 재생',
  dismissPrompt: '다음에',
  query: 'chill lofi evening mix',
  mood: 'chill',
};

const newsOffer: PendingNewsOffer = {
  playPrompt: '📰 관심 있어',
  dismissPrompt: '다음에',
  articleId: 'article-1',
  category: 'breaking',
  title: 'Agentic AI used to conduct ransomware attack',
};

describe('aoiPendingOffers', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe('pending idle music offer', () => {
    it('round-trips an offer across save and load (reload survival)', () => {
      savePendingIdleMusicOffer(musicOffer);
      expect(loadPendingIdleMusicOffer()).toEqual(musicOffer);
    });

    it('returns null when nothing is stored', () => {
      expect(loadPendingIdleMusicOffer()).toBeNull();
    });

    it('clears the stored offer when saving null (offer consumed)', () => {
      savePendingIdleMusicOffer(musicOffer);
      savePendingIdleMusicOffer(null);
      expect(loadPendingIdleMusicOffer()).toBeNull();
      expect(localStorage.getItem(MUSIC_KEY)).toBeNull();
    });

    it('rejects malformed JSON', () => {
      localStorage.setItem(MUSIC_KEY, '{not json');
      expect(loadPendingIdleMusicOffer()).toBeNull();
    });

    it('rejects a payload with missing or blank fields', () => {
      localStorage.setItem(MUSIC_KEY, JSON.stringify({ ...musicOffer, query: '  ' }));
      expect(loadPendingIdleMusicOffer()).toBeNull();
      localStorage.setItem(MUSIC_KEY, JSON.stringify({ ...musicOffer, playPrompt: undefined }));
      expect(loadPendingIdleMusicOffer()).toBeNull();
    });

    it('rejects an unknown mood', () => {
      localStorage.setItem(MUSIC_KEY, JSON.stringify({ ...musicOffer, mood: 'metal' }));
      expect(loadPendingIdleMusicOffer()).toBeNull();
    });
  });

  describe('pending news offer', () => {
    it('round-trips an offer across save and load (reload survival)', () => {
      savePendingNewsOffer(newsOffer);
      expect(loadPendingNewsOffer()).toEqual(newsOffer);
    });

    it('returns null when nothing is stored', () => {
      expect(loadPendingNewsOffer()).toBeNull();
    });

    it('clears the stored offer when saving null (offer consumed)', () => {
      savePendingNewsOffer(newsOffer);
      savePendingNewsOffer(null);
      expect(loadPendingNewsOffer()).toBeNull();
      expect(localStorage.getItem(NEWS_KEY)).toBeNull();
    });

    it('rejects an unknown category', () => {
      localStorage.setItem(NEWS_KEY, JSON.stringify({ ...newsOffer, category: 'gossip' }));
      expect(loadPendingNewsOffer()).toBeNull();
    });

    it('rejects a payload with a missing articleId', () => {
      localStorage.setItem(NEWS_KEY, JSON.stringify({ ...newsOffer, articleId: '' }));
      expect(loadPendingNewsOffer()).toBeNull();
    });
  });

  describe('pending taste poll', () => {
    const TASTE_KEY = 'aoi-pending-taste-poll-v1';
    const poll: PendingTastePoll = {
      questionId: 'vibe',
      options: [
        { id: 'calm_lofi', label: '잔잔한 로파이·칠' },
        { id: 'depends', label: '그때그때 달라' },
      ],
    };

    it('round-trips a poll across save and load (reload survival)', () => {
      savePendingTastePoll(poll);
      expect(loadPendingTastePoll()).toEqual(poll);
    });

    it('returns null when nothing is stored', () => {
      expect(loadPendingTastePoll()).toBeNull();
    });

    it('clears the stored poll when saving null (poll consumed)', () => {
      savePendingTastePoll(poll);
      savePendingTastePoll(null);
      expect(loadPendingTastePoll()).toBeNull();
      expect(localStorage.getItem(TASTE_KEY)).toBeNull();
    });

    it('rejects malformed payloads', () => {
      localStorage.setItem(TASTE_KEY, JSON.stringify({ ...poll, questionId: '' }));
      expect(loadPendingTastePoll()).toBeNull();
      localStorage.setItem(TASTE_KEY, JSON.stringify({ ...poll, options: [] }));
      expect(loadPendingTastePoll()).toBeNull();
      localStorage.setItem(
        TASTE_KEY,
        JSON.stringify({ ...poll, options: [{ id: 'x', label: '  ' }] }),
      );
      expect(loadPendingTastePoll()).toBeNull();
      localStorage.setItem(
        TASTE_KEY,
        JSON.stringify({
          ...poll,
          options: Array.from({ length: 9 }, (_, i) => ({ id: `o${i}`, label: `L${i}` })),
        }),
      );
      expect(loadPendingTastePoll()).toBeNull();
    });
  });

  describe('pending preference poll', () => {
    const PREFERENCE_KEY = 'aoi-pending-preference-poll-v1';
    const poll: PendingPreferencePoll = {
      questionId: 'focus_area',
      options: [
        { id: 'kernel_internals', label: 'Windows 커널·드라이버 내부' },
        { id: 'anti_cheat', label: '안티치트·게임 보안' },
      ],
    };

    it('round-trips a poll across save and load (reload survival)', () => {
      savePendingPreferencePoll(poll);
      expect(loadPendingPreferencePoll()).toEqual(poll);
    });

    it('returns null when nothing is stored', () => {
      expect(loadPendingPreferencePoll()).toBeNull();
    });

    it('clears the stored poll when saving null (poll consumed)', () => {
      savePendingPreferencePoll(poll);
      savePendingPreferencePoll(null);
      expect(loadPendingPreferencePoll()).toBeNull();
      expect(localStorage.getItem(PREFERENCE_KEY)).toBeNull();
    });

    it('rejects malformed payloads', () => {
      localStorage.setItem(PREFERENCE_KEY, '{not json');
      expect(loadPendingPreferencePoll()).toBeNull();
      localStorage.setItem(PREFERENCE_KEY, JSON.stringify({ ...poll, questionId: '' }));
      expect(loadPendingPreferencePoll()).toBeNull();
      localStorage.setItem(PREFERENCE_KEY, JSON.stringify({ ...poll, options: [] }));
      expect(loadPendingPreferencePoll()).toBeNull();
      localStorage.setItem(
        PREFERENCE_KEY,
        JSON.stringify({ ...poll, options: [{ id: 'x', label: '  ' }] }),
      );
      expect(loadPendingPreferencePoll()).toBeNull();
      localStorage.setItem(
        PREFERENCE_KEY,
        JSON.stringify({
          ...poll,
          options: Array.from({ length: 9 }, (_, i) => ({ id: `o${i}`, label: `L${i}` })),
        }),
      );
      expect(loadPendingPreferencePoll()).toBeNull();
    });
  });
});
