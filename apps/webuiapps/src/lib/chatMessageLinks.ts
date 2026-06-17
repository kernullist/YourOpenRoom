export type ChatMessageContentSegment =
  | {
      type: 'text';
      text: string;
    }
  | {
      type: 'link';
      label: string;
      url: string;
    }
  | {
      type: 'emotion';
      text: string;
    };

const MESSAGE_TOKEN_PATTERN =
  /\[([^\]]+)\]\((https?:\/\/[^\s)'"`<>]+)\)|(https?:\/\/[^\s'"`<>]+)|(\([^)]+\))/g;
const TRAILING_URL_DECORATION_PATTERN = /[`'"\u2019\u201d\]).,;:!?]+$/;

function splitUrlDecoration(rawUrl: string): { url: string; trailingText: string } {
  let url = rawUrl.trim().replace(/^[`'"\u2018\u201c]+/, '');
  let trailingText = '';

  while (url && TRAILING_URL_DECORATION_PATTERN.test(url)) {
    const nextUrl = url.replace(TRAILING_URL_DECORATION_PATTERN, '');
    trailingText = `${url.slice(nextUrl.length)}${trailingText}`;
    url = nextUrl;
  }

  return { url, trailingText };
}

function pushTextSegment(segments: ChatMessageContentSegment[], text: string): void {
  if (!text) {
    return;
  }
  const previous = segments[segments.length - 1];
  if (previous?.type === 'text') {
    previous.text += text;
    return;
  }
  segments.push({ type: 'text', text });
}

export function parseChatMessageContent(content: string): ChatMessageContentSegment[] {
  const segments: ChatMessageContentSegment[] = [];
  let lastIndex = 0;

  for (const match of content.matchAll(MESSAGE_TOKEN_PATTERN)) {
    const token = match[0];
    const index = match.index ?? 0;
    pushTextSegment(segments, content.slice(lastIndex, index));

    const markdownLabel = match[1];
    const markdownUrl = match[2];
    const bareUrl = match[3];
    const emotion = match[4];

    if (markdownLabel && markdownUrl) {
      const { url, trailingText } = splitUrlDecoration(markdownUrl);
      if (url) {
        segments.push({ type: 'link', label: markdownLabel, url });
        pushTextSegment(segments, trailingText);
      } else {
        pushTextSegment(segments, token);
      }
    } else if (bareUrl) {
      const { url, trailingText } = splitUrlDecoration(bareUrl);
      if (url) {
        segments.push({ type: 'link', label: url, url });
        pushTextSegment(segments, trailingText);
      } else {
        pushTextSegment(segments, token);
      }
    } else if (emotion) {
      segments.push({ type: 'emotion', text: emotion });
    }

    lastIndex = index + token.length;
  }

  pushTextSegment(segments, content.slice(lastIndex));
  return segments;
}
