declare global {
  const __ENV__: string;
  interface Window {
    YT?: {
      Player: new (
        target: string | HTMLElement,
        options?: {
          events?: {
            onReady?: (event: { target: YoutubeIframePlayer }) => void;
            onStateChange?: (event: { data: number; target: YoutubeIframePlayer }) => void;
          };
        },
      ) => YoutubeIframePlayer;
      PlayerState: {
        UNSTARTED: -1;
        ENDED: 0;
        PLAYING: 1;
        PAUSED: 2;
        BUFFERING: 3;
        CUED: 5;
      };
    };
    onYouTubeIframeAPIReady?: () => void;
  }
}

interface YoutubeVideoData {
  video_id?: string;
}

interface YoutubeIframePlayer {
  destroy: () => void;
  getVideoData: () => YoutubeVideoData;
}

export {};
