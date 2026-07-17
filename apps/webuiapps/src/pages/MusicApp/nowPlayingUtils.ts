// Now-playing snapshot helpers.
//
// The snapshot is persisted in state.json so the agent surface (get_app_state)
// can answer "which video is on screen right now" -- including queue
// auto-advance, which never goes through a user action report. updatedAt is
// refreshed on every playback change; a stale timestamp means the app went
// away without clearing the field and the claim must not be trusted as live.

export interface NowPlayingState {
  videoId: string;
  title: string;
  channel: string;
  queueName: string | null;
  startedAt: number;
  updatedAt: number;
}

export interface NowPlayingSource {
  id: string;
  title: string;
  channel: string;
}

// startedAt survives while the same video keeps playing (queue metadata or
// repeated updates must not reset it); a different video restarts the clock.
export function buildNowPlaying(
  item: NowPlayingSource,
  queueName: string | null,
  now: number,
  previous: NowPlayingState | null,
): NowPlayingState {
  const sameVideo = previous !== null && previous.videoId === item.id;
  const normalizedQueueName = queueName && queueName.trim() ? queueName.trim() : null;
  return {
    videoId: item.id,
    title: item.title,
    channel: item.channel,
    queueName: normalizedQueueName,
    startedAt: sameVideo ? previous.startedAt : now,
    updatedAt: now,
  };
}

// Defensive parse for the persisted field: anything that does not carry a
// non-empty videoId and title reads as "nothing playing".
export function normalizeNowPlaying(raw: unknown): NowPlayingState | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const obj = raw as Partial<NowPlayingState>;
  if (typeof obj.videoId !== 'string' || !obj.videoId.trim()) {
    return null;
  }
  if (typeof obj.title !== 'string' || !obj.title.trim()) {
    return null;
  }
  return {
    videoId: obj.videoId,
    title: obj.title,
    channel: typeof obj.channel === 'string' ? obj.channel : '',
    queueName: typeof obj.queueName === 'string' && obj.queueName.trim() ? obj.queueName : null,
    startedAt:
      typeof obj.startedAt === 'number' && Number.isFinite(obj.startedAt) ? obj.startedAt : 0,
    updatedAt:
      typeof obj.updatedAt === 'number' && Number.isFinite(obj.updatedAt) ? obj.updatedAt : 0,
  };
}

// PLAY_VIDEO report params: reportAction params must be Record<string, string>,
// so the queue name collapses to '' when the video plays outside a queue.
export function buildPlayVideoParams(
  item: NowPlayingSource,
  queueName: string | null,
): Record<string, string> {
  return {
    video_id: item.id,
    title: item.title,
    channel: item.channel,
    queue: queueName && queueName.trim() ? queueName.trim() : '',
  };
}
