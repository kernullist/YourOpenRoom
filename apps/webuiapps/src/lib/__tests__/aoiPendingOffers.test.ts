import { beforeEach, describe, expect, it } from 'vitest';
import {
  loadPendingIdleMusicOffer,
  loadPendingNewsOffer,
  savePendingIdleMusicOffer,
  savePendingNewsOffer,
  type PendingIdleMusicOffer,
  type PendingNewsOffer,
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
});
