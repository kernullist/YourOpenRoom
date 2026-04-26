type TtsLanguage = 'ko' | 'ja' | 'zh' | 'en';
type TtsEmotion = string | undefined;

interface TtsAsset {
  audioUrl: string;
  mimeType: string;
}

interface PlayAoiTtsMessageOptions {
  text: string;
  language: TtsLanguage;
  emotion?: TtsEmotion;
  characterName?: string;
  characterDescription?: string;
}

interface PrewarmAoiPhrasesOptions {
  language: TtsLanguage;
  characterName?: string;
  characterDescription?: string;
}

interface PrewarmAoiLinesOptions extends PrewarmAoiPhrasesOptions {
  lines: string[];
  emotion?: TtsEmotion;
}

export interface AoiTtsStatusSnapshot {
  cachedCount: number;
  pendingCount: number;
  prewarmRuns: number;
  lastBatchSize: number;
  lastWarmAt: number | null;
  recentWarmedLines: string[];
}

const AOI_TTS_VOICE_NAME = 'Despina';
const AOI_TTS_ENDPOINT = '/api/tts-lab/google/synthesize';

const speechCache = new Map<string, Promise<TtsAsset>>();
let activeAudio: HTMLAudioElement | null = null;
let playbackNonce = 0;
const ttsStatusListeners = new Set<(status: AoiTtsStatusSnapshot) => void>();
const ttsStatus: AoiTtsStatusSnapshot = {
  cachedCount: 0,
  pendingCount: 0,
  prewarmRuns: 0,
  lastBatchSize: 0,
  lastWarmAt: null,
  recentWarmedLines: [],
};

function emitTtsStatus(): void {
  const snapshot = getAoiTtsStatusSnapshot();
  for (const listener of ttsStatusListeners) listener(snapshot);
}

function updateTtsStatus(partial: Partial<AoiTtsStatusSnapshot>): void {
  Object.assign(ttsStatus, partial);
  ttsStatus.cachedCount = speechCache.size;
  emitTtsStatus();
}

function pushRecentWarmedLine(line: string): void {
  const next = [line, ...ttsStatus.recentWarmedLines.filter((item) => item !== line)].slice(0, 8);
  updateTtsStatus({ recentWarmedLines: next, lastWarmAt: Date.now() });
}

export function getAoiTtsStatusSnapshot(): AoiTtsStatusSnapshot {
  return {
    cachedCount: ttsStatus.cachedCount,
    pendingCount: ttsStatus.pendingCount,
    prewarmRuns: ttsStatus.prewarmRuns,
    lastBatchSize: ttsStatus.lastBatchSize,
    lastWarmAt: ttsStatus.lastWarmAt,
    recentWarmedLines: [...ttsStatus.recentWarmedLines],
  };
}

export function subscribeAoiTtsStatus(
  listener: (status: AoiTtsStatusSnapshot) => void,
): () => void {
  ttsStatusListeners.add(listener);
  listener(getAoiTtsStatusSnapshot());
  return () => {
    ttsStatusListeners.delete(listener);
  };
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function normalizeSpokenText(text: string): string {
  const withoutMarkdownLinks = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1');
  const withoutUrls = withoutMarkdownLinks.replace(/https?:\/\/[^\s)]+/g, '');
  const withoutActionMarkers = withoutUrls.replace(/\(([^)]+)\)/g, ' ');
  return collapseWhitespace(withoutActionMarkers);
}

function escapeControl(text: string): string {
  return text.replace(/[\u0000-\u001f]+/g, ' ').trim();
}

function buildAoiStylePrompt(
  language: TtsLanguage,
  emotion: TtsEmotion,
  characterName?: string,
  characterDescription?: string,
): string {
  const voiceLanguageLabel =
    language === 'ko'
      ? 'Korean'
      : language === 'ja'
        ? 'Japanese'
        : language === 'zh'
          ? 'Chinese'
          : 'English';

  const emotionPromptMap: Record<string, string> = {
    happy: 'A little warmer and more amused, but still composed.',
    shy: 'Softer, quieter, a little hesitant, but never childish.',
    peaceful: 'Gentle and steady, with calm assurance.',
    depressing: 'Softer and more melancholic, with controlled emotion.',
    angry: 'Sharper and colder, with restrained irritation instead of shouting.',
    default: 'Cool, elegant, aloof, and composed.',
  };

  const moodPrompt = emotionPromptMap[emotion || 'default'] || emotionPromptMap.default;
  const characterHint = collapseWhitespace(
    escapeControl(characterDescription || '').slice(0, 220).replace(/\n+/g, ' '),
  );

  return [
    `${characterName || 'Aoi'} is an elegant, aloof Japanese woman in her mid-20s.`,
    `Speak in ${voiceLanguageLabel}.`,
    'Keep the performance mature, lightly teasing, emotionally restrained, and never bubbly or childlike.',
    'Use a brisk conversational pace, around 10 to 15 percent faster than default, while staying clear and natural.',
    'Keep pauses short and avoid slow, drawn-out delivery.',
    moodPrompt,
    characterHint ? `Persona notes: ${characterHint}` : '',
    'Read only the transcript itself. Do not add labels, explanations, or extra narration.',
  ]
    .filter(Boolean)
    .join(' ');
}

function buildCacheKey(
  text: string,
  language: TtsLanguage,
  emotion: TtsEmotion,
  characterName?: string,
): string {
  return JSON.stringify({
    voice: AOI_TTS_VOICE_NAME,
    language,
    emotion: emotion || 'default',
    characterName: characterName || 'Aoi',
    text,
  });
}

async function synthesizeAoiTtsAsset(
  text: string,
  language: TtsLanguage,
  emotion: TtsEmotion,
  characterName?: string,
  characterDescription?: string,
): Promise<TtsAsset> {
  const response = await fetch(AOI_TTS_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      stylePrompt: buildAoiStylePrompt(language, emotion, characterName, characterDescription),
      voiceName: AOI_TTS_VOICE_NAME,
    }),
  });
  const payload = (await response.json()) as {
    audioBase64?: string;
    mimeType?: string;
    error?: string;
  };
  if (!response.ok) {
    throw new Error(payload?.error || `TTS synthesis failed (${response.status})`);
  }
  if (!payload.audioBase64 || !payload.mimeType) {
    throw new Error('TTS response did not include audio data.');
  }

  const byteCharacters = atob(payload.audioBase64);
  const byteArray = new Uint8Array(byteCharacters.length);
  for (let i = 0; i < byteCharacters.length; i += 1) {
    byteArray[i] = byteCharacters.charCodeAt(i);
  }
  const blob = new Blob([byteArray], { type: payload.mimeType });
  return {
    audioUrl: URL.createObjectURL(blob),
    mimeType: payload.mimeType,
  };
}

function getOrCreateSpeechAsset(
  text: string,
  language: TtsLanguage,
  emotion: TtsEmotion,
  characterName?: string,
  characterDescription?: string,
): Promise<TtsAsset> {
  const cacheKey = buildCacheKey(text, language, emotion, characterName);
  const cached = speechCache.get(cacheKey);
  if (cached) return cached;

  updateTtsStatus({ pendingCount: ttsStatus.pendingCount + 1 });
  const pending = synthesizeAoiTtsAsset(
    text,
    language,
    emotion,
    characterName,
    characterDescription,
  ).catch((error) => {
    speechCache.delete(cacheKey);
    updateTtsStatus({ pendingCount: Math.max(0, ttsStatus.pendingCount - 1) });
    throw error;
  }).then((asset) => {
    updateTtsStatus({ pendingCount: Math.max(0, ttsStatus.pendingCount - 1) });
    pushRecentWarmedLine(text);
    return asset;
  });
  speechCache.set(cacheKey, pending);
  updateTtsStatus({ cachedCount: speechCache.size });
  return pending;
}

export function stopAoiTtsPlayback(): void {
  playbackNonce += 1;
  if (activeAudio) {
    activeAudio.pause();
    activeAudio.currentTime = 0;
    activeAudio = null;
  }
}

export async function playAoiTtsMessage(options: PlayAoiTtsMessageOptions): Promise<void> {
  const spokenText = normalizeSpokenText(options.text);
  if (!spokenText) return;

  stopAoiTtsPlayback();
  const nonce = playbackNonce;
  const asset = await getOrCreateSpeechAsset(
    spokenText,
    options.language,
    options.emotion,
    options.characterName,
    options.characterDescription,
  );
  if (nonce !== playbackNonce) return;

  const audio = new Audio(asset.audioUrl);
  activeAudio = audio;
  audio.addEventListener(
    'ended',
    () => {
      if (activeAudio === audio) activeAudio = null;
    },
    { once: true },
  );
  await audio.play();
}

function getCommonPhrasesForLanguage(language: TtsLanguage): string[] {
  switch (language) {
    case 'ko':
      return [
        '알겠어, 기억해둘게.',
        '알겠어.',
        '좋아, 해볼게.',
        '잠깐만.',
        '내가 볼게.',
        '지금 확인해볼게.',
        '같이 보자.',
        '괜찮아, 맡겨둬.',
        '조금만 기다려.',
        '열어둘게.',
        '바로 해볼게.',
        '내가 정리해볼게.',
        '다시 확인해볼까.',
        'YouTube를 열어둘게.',
        'Kira를 열어둘게.',
        "Aoi's IDE를 열어둘게.",
        'PE Analyst를 열어둘게.',
        '마지막 재생한 플레이리스트를 틀어볼게.',
        '아직 재생할 플레이리스트가 없어. 먼저 하나 만들어서 틀어줘.',
      ];
    case 'ja':
      return [
        '分かった。覚えておくよ。',
        '分かった。',
        'いいよ、やってみる。',
        'ちょっと待って。',
        '私が見るよ。',
        '今確認してみるね。',
        '一緒に見ようか。',
        '大丈夫、任せて。',
        '少し待ってて。',
        '開いておくね。',
        'すぐやってみる。',
        '私が整理してみるね。',
        'もう一回確認してみようか。',
        'YouTubeを開いておくね。',
        'Kiraを開いておくね。',
        "Aoi's IDEを開いておくね。",
        'PE Analystを開いておくね。',
        '最後に再生したプレイリストを流してみるね。',
        'まだ再生できるプレイリストがないよ。先に一つ再生してみて。',
      ];
    case 'zh':
      return [
        '好，我记住了。',
        '好。',
        '行，我来试试。',
        '等一下。',
        '我来看看。',
        '我现在确认一下。',
        '一起看看吧。',
        '没事，交给我。',
        '稍等一下。',
        '我先帮你打开。',
        '我马上试试。',
        '我来整理一下。',
        '要不要再确认一次？',
        '我把 YouTube 打开给你。',
        '我把 Kira 打开给你。',
        "我把 Aoi's IDE 打开给你。",
        '我把 PE Analyst 打开给你。',
        '我来播放你上次听的播放列表。',
        '现在还没有可播放的播放列表，先播放一次列表吧。',
      ];
    default:
      return [
        "Got it. I'll remember that.",
        'Got it.',
        "Alright, I'll take a look.",
        'Give me a second.',
        "I'll check right now.",
        "Let's look at it together.",
        "It's fine. Leave it to me.",
        'Wait a moment.',
        "I'll open it for you.",
        "I'll handle it now.",
        "I'll sort it out.",
        'Want me to check that again?',
        "I'll open YouTube for you.",
        "I'll open Kira for you.",
        "I'll open Aoi's IDE for you.",
        "I'll open PE Analyst for you.",
        "I'll play your most recent playlist.",
        "There isn't a playlist ready to play yet. Try playing one first.",
      ];
  }
}

export async function prewarmAoiTtsCommonPhrases(
  options: PrewarmAoiPhrasesOptions,
): Promise<void> {
  const phrases = getCommonPhrasesForLanguage(options.language);
  await prewarmAoiTtsLines({
    ...options,
    lines: phrases,
  });
}

export async function prewarmAoiTtsLines(options: PrewarmAoiLinesOptions): Promise<void> {
  const normalizedLines = [...new Set(options.lines.map(normalizeSpokenText).filter(Boolean))];
  updateTtsStatus({
    prewarmRuns: ttsStatus.prewarmRuns + 1,
    lastBatchSize: normalizedLines.length,
  });
  await Promise.allSettled(
    normalizedLines.map((phrase) =>
      getOrCreateSpeechAsset(
        phrase,
        options.language,
        options.emotion ?? 'default',
        options.characterName,
        options.characterDescription,
      ),
    ),
  );
}
