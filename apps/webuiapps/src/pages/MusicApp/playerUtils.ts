/**
 * Pure helpers for the in-app YouTube player embed.
 */

export const MIN_PLAYER_ZOOM = 1;
export const MAX_PLAYER_ZOOM = 2;
export const PLAYER_ZOOM_STEP = 0.25;

export interface PlayerEmbedOptions {
  autoplay?: boolean;
  queueVideoIds?: string[];
  origin?: string;
}

export function clampPlayerZoom(value: number): number {
  const normalized = Number.isFinite(value) ? value : 1;
  return Math.min(MAX_PLAYER_ZOOM, Math.max(MIN_PLAYER_ZOOM, normalized));
}

/**
 * Builds the embed URL for the in-app player.
 *
 * Loop is intentionally not encoded in the URL: it is applied live through the
 * iframe API (setLoop for queues, seek-to-start on ENDED for single videos) so
 * that toggling loop never reloads the iframe and never restarts playback.
 */
export function buildEmbedUrl(videoId: string, options: PlayerEmbedOptions = {}): string {
  const { autoplay = false, queueVideoIds = [], origin } = options;
  const params = new URLSearchParams({
    rel: '0',
    modestbranding: '1',
    playsinline: '1',
    enablejsapi: '1',
    origin: origin ?? window.location.origin,
  });
  if (autoplay) {
    params.set('autoplay', '1');
  }
  if (queueVideoIds.length > 1) {
    params.set('playlist', queueVideoIds.slice(1).join(','));
  }
  return `https://www.youtube.com/embed/${videoId}?${params.toString()}`;
}
