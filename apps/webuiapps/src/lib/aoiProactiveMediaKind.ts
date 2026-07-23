import type {
  AoiProactiveBriefMediaBucket,
  AoiProactiveBriefMediaKind,
  AoiProactiveBriefSource,
} from './aoiAutonomyTypes';

// Coarse media classification for a public search result. The goal is to let
// the proactive trend advisor group briefs into things worth watching,
// listening to, or reading, without any network calls or heavy parsing.

export interface AoiProactiveMediaKindInput {
  url?: string;
  host?: string;
  title?: string;
  snippet?: string;
}

// Video-first platforms. Plain youtube.com is video; music.youtube.com is
// intentionally listed under music below and checked before this list.
const VIDEO_HOST_SUFFIXES = [
  'youtube.com',
  'youtu.be',
  'vimeo.com',
  'twitch.tv',
  'ted.com',
  'bilibili.com',
  'bilibili.tv',
  'dailymotion.com',
  'nicovideo.jp',
  'rumble.com',
  'odysee.com',
];

// Podcast hosting/directory platforms.
const PODCAST_HOST_SUFFIXES = [
  'overcast.fm',
  'pocketcasts.com',
  'castbox.fm',
  'anchor.fm',
  'podbean.com',
  'listennotes.com',
  'buzzsprout.com',
  'simplecast.com',
  'transistor.fm',
  'redcircle.com',
  'stitcher.com',
  'podcasts.google.com',
];

// Music streaming/hosting platforms. music.youtube.com and music.apple.com are
// listed here so they win over the generic youtube/apple handling.
const MUSIC_HOST_SUFFIXES = [
  'soundcloud.com',
  'bandcamp.com',
  'tidal.com',
  'deezer.com',
  'music.apple.com',
  'music.youtube.com',
  'music.amazon.com',
];

function stripWww(host: string): string {
  return host.replace(/^www\./, '');
}

function normalizeHost(input: AoiProactiveMediaKindInput): string {
  const rawHost = (input.host ?? '').trim().toLowerCase();
  if (rawHost) {
    return stripWww(rawHost);
  }
  const rawUrl = (input.url ?? '').trim();
  if (!rawUrl) {
    return '';
  }
  try {
    return stripWww(new URL(rawUrl).hostname.toLowerCase());
  } catch {
    return '';
  }
}

function urlPath(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return '';
  }
  try {
    return new URL(trimmed).pathname.toLowerCase();
  } catch {
    return trimmed.toLowerCase();
  }
}

function hostMatches(host: string, suffixes: string[]): boolean {
  return suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

// Classify a single source into a coarse media kind. Deterministic and pure:
// host suffixes decide first, then platform-specific path rules, then generic
// URL/title hints, and finally the article fallback.
export function classifyAoiProactiveBriefMediaKind(
  input: AoiProactiveMediaKindInput,
): AoiProactiveBriefMediaKind {
  const host = normalizeHost(input);
  const path = urlPath(input.url ?? '');
  const text = `${input.title ?? ''} ${input.snippet ?? ''}`.toLowerCase();
  const pathAndText = `${path} ${text}`;

  // Spotify and Apple serve both podcasts and music from one host; path decides.
  if (host === 'open.spotify.com' || host === 'spotify.com') {
    if (/\/(episode|show)(\/|$)/.test(path)) {
      return 'podcast';
    }
    if (/\/(track|album|playlist|artist)(\/|$)/.test(path)) {
      return 'music';
    }
  }
  if (host === 'podcasts.apple.com') {
    return 'podcast';
  }

  // Explicit host lists. Music is checked before video so music.youtube.com
  // does not fall through to the video branch.
  if (hostMatches(host, MUSIC_HOST_SUFFIXES)) {
    return 'music';
  }
  if (hostMatches(host, PODCAST_HOST_SUFFIXES)) {
    return 'podcast';
  }
  if (hostMatches(host, VIDEO_HOST_SUFFIXES)) {
    return 'video';
  }

  // Generic hints for hosts we do not list explicitly.
  if (
    /(^|\/)(watch|videos?|webinar)(\/|$)/.test(path) ||
    /\b(conference talk|webinar|video explainer)\b/.test(text)
  ) {
    return 'video';
  }
  if (/\b(podcast|episode)\b/.test(pathAndText)) {
    return 'podcast';
  }
  if (/\b(playlist|soundtrack|ost|album)\b/.test(text)) {
    return 'music';
  }

  return 'article';
}

export function mediaKindToBucket(
  kind: AoiProactiveBriefMediaKind,
): Exclude<AoiProactiveBriefMediaBucket, 'mixed'> {
  switch (kind) {
    case 'video': {
      return 'watch';
    }
    case 'podcast':
    case 'music': {
      return 'listen';
    }
    case 'article':
    default: {
      return 'read';
    }
  }
}

// Derive a candidate-level bucket from its sources. Uses each source's stored
// mediaKind when present, otherwise classifies on the fly. The dominant bucket
// wins; an exact tie between the top two buckets yields 'mixed'.
export function deriveAoiProactiveBriefMediaBucket(
  sources: AoiProactiveBriefSource[],
): AoiProactiveBriefMediaBucket {
  const counts: Record<Exclude<AoiProactiveBriefMediaBucket, 'mixed'>, number> = {
    watch: 0,
    listen: 0,
    read: 0,
  };
  for (const source of sources) {
    const kind = source.mediaKind ?? classifyAoiProactiveBriefMediaKind(source);
    counts[mediaKindToBucket(kind)] += 1;
  }
  const total = counts.watch + counts.listen + counts.read;
  if (total === 0) {
    return 'read';
  }
  const ranked = (['watch', 'listen', 'read'] as const)
    .map((bucket) => ({ bucket, count: counts[bucket] }))
    .sort((left, right) => right.count - left.count);
  const top = ranked[0];
  const second = ranked[1];
  if (second && second.count === top.count) {
    return 'mixed';
  }
  return top.bucket;
}

// Locale-neutral label for the card view-model. Presentation layers may map the
// bucket enum to a localized label if desired.
export function aoiProactiveBriefMediaBucketLabel(bucket: AoiProactiveBriefMediaBucket): string {
  switch (bucket) {
    case 'watch': {
      return 'Watch';
    }
    case 'listen': {
      return 'Listen';
    }
    case 'read': {
      return 'Read';
    }
    case 'mixed':
    default: {
      return 'Mixed';
    }
  }
}

export function aoiProactiveBriefMediaKindLabel(kind: AoiProactiveBriefMediaKind): string {
  switch (kind) {
    case 'video': {
      return 'video';
    }
    case 'podcast': {
      return 'podcast';
    }
    case 'music': {
      return 'music';
    }
    case 'article':
    default: {
      return 'article';
    }
  }
}
