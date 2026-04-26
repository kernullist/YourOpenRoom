const defaultGoogleVoices = [
  { voiceName: 'Despina', note: '매끈하고 차가운 밸런스형' },
  { voiceName: 'Kore', note: '단호하고 주도적인 타입' },
  { voiceName: 'Pulcherrima', note: '직설적이고 밀어붙이는 타입' },
  { voiceName: 'Achernar', note: '부드럽고 쓸쓸한 타입' },
  { voiceName: 'Gacrux', note: '성숙하고 위험한 타입' },
];

const transcriptInput = document.getElementById('transcript');
const stylePromptInput = document.getElementById('stylePrompt');
const statusEl = document.getElementById('status');
const googleResultsEl = document.getElementById('googleResults');
const accountVoiceResultsEl = document.getElementById('accountVoiceResults');
const accountVoiceErrorEl = document.getElementById('accountVoiceError');
const sharedVoiceResultsEl = document.getElementById('sharedVoiceResults');
const sharedVoiceErrorEl = document.getElementById('sharedVoiceError');

transcriptInput.value =
  '……勘違いしないで。特別扱いしてるんじゃない。ただ、少し気にかけてるだけ。';
stylePromptInput.value =
  '20代半ばの日本人女性。上品で少し高飛車、感情は抑えめ。冷たすぎず、余裕と色気がある。語尾は軽く流し、決して子供っぽくしない。テンポはやや 빠르게, 기본보다 10~15% 정도 빠른 호흡으로 또렷하게 말하고, 불필요하게 늘이지 않는다.';

function setStatusBadges(items) {
  statusEl.innerHTML = '';
  for (const item of items) {
    const badge = document.createElement('div');
    badge.className = 'badge';
    badge.textContent = `${item.label}: ${item.value}`;
    statusEl.appendChild(badge);
  }
}

function makeAudioUrl(audioBase64, mimeType) {
  const byteCharacters = atob(audioBase64);
  const byteArray = new Uint8Array(byteCharacters.length);
  for (let i = 0; i < byteCharacters.length; i += 1) {
    byteArray[i] = byteCharacters.charCodeAt(i);
  }
  const blob = new Blob([byteArray], { type: mimeType });
  return URL.createObjectURL(blob);
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(parsed.error || `Request failed (${response.status})`);
  }
  return parsed;
}

function createMetaBadge(text) {
  const span = document.createElement('span');
  span.textContent = text;
  return span;
}

function createAudioPlayer(url) {
  const audio = document.createElement('audio');
  audio.controls = true;
  audio.src = url;
  audio.preload = 'none';
  return audio;
}

function createGoogleCard({ voiceName, note }) {
  const card = document.createElement('div');
  card.className = 'voiceCard';

  const header = document.createElement('div');
  header.className = 'voiceCardHeader';
  const titleWrap = document.createElement('div');
  const title = document.createElement('strong');
  title.textContent = voiceName;
  const noteEl = document.createElement('div');
  noteEl.className = 'hint';
  noteEl.textContent = note;
  titleWrap.append(title, noteEl);

  const button = document.createElement('button');
  button.className = 'secondary';
  button.textContent = '샘플 생성';
  let audioUrl = '';
  let lastRun = Promise.resolve();

  const runGeneration = async () => {
    button.disabled = true;
    button.textContent = '생성 중...';
    errorEl.textContent = '';
    try {
      const result = await fetchJson('/api/tts-lab/google/synthesize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: transcriptInput.value,
          stylePrompt: stylePromptInput.value,
          voiceName,
        }),
      });
      if (audioUrl) URL.revokeObjectURL(audioUrl);
      audioUrl = makeAudioUrl(result.audioBase64, result.mimeType);
      audioWrap.innerHTML = '';
      audioWrap.appendChild(createAudioPlayer(audioUrl));
    } catch (error) {
      errorEl.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      button.disabled = false;
      button.textContent = '샘플 생성';
    }
  };

  button.addEventListener('click', () => {
    lastRun = runGeneration();
  });

  header.append(titleWrap, button);

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.append(createMetaBadge('Google Gemini TTS'));
  meta.append(createMetaBadge('ja-JP'));

  const errorEl = document.createElement('div');
  errorEl.className = 'error';
  const audioWrap = document.createElement('div');

  card.append(header, meta, errorEl, audioWrap);
  return {
    card,
    trigger: async () => {
      lastRun = runGeneration();
      await lastRun;
    },
  };
}

function renderGoogleCards() {
  googleResultsEl.innerHTML = '';
  return defaultGoogleVoices.map((item) => {
    const card = createGoogleCard(item);
    googleResultsEl.appendChild(card.card);
    return card;
  });
}

function formatVoiceDescription(voice) {
  const parts = [];
  if (voice.description) parts.push(voice.description);
  if (voice.category) parts.push(`category: ${voice.category}`);
  return parts.join(' / ');
}

function normalizeVoiceScore(voice) {
  const labels = voice.labels || {};
  const verifiedLanguages = Array.isArray(voice.verifiedLanguages) ? voice.verifiedLanguages : [];
  const descriptionBlob = [
    voice.name,
    voice.description,
    voice.category,
    labels.gender,
    labels.accent,
    ...verifiedLanguages.map((item) => `${item.language || ''} ${item.locale || ''}`),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  let score = 0;
  if ((labels.gender || '').toLowerCase() === 'female') score += 4;
  if (verifiedLanguages.some((item) => String(item.locale || '').toLowerCase().startsWith('ja'))) {
    score += 6;
  }
  if (descriptionBlob.includes('japanese')) score += 4;
  if (descriptionBlob.includes('anime')) score += 3;
  if (descriptionBlob.includes('character')) score += 2;
  if (
    ['cool', 'calm', 'soft', 'gentle', 'mature', 'elegant', 'sassy', 'seductive'].some((token) =>
      descriptionBlob.includes(token),
    )
  ) {
    score += 2;
  }
  return score;
}

function createElevenAccountCard(voice) {
  const card = document.createElement('div');
  card.className = 'voiceCard';

  const header = document.createElement('div');
  header.className = 'voiceCardHeader';
  const titleWrap = document.createElement('div');
  const title = document.createElement('strong');
  title.textContent = voice.name || voice.voiceId;
  const noteEl = document.createElement('div');
  noteEl.className = 'hint';
  noteEl.textContent = `score ${normalizeVoiceScore(voice)}`;
  titleWrap.append(title, noteEl);

  const buttonRow = document.createElement('div');
  buttonRow.className = 'row';

  const generateButton = document.createElement('button');
  generateButton.className = 'secondary';
  generateButton.textContent = '샘플 생성';

  const copyButton = document.createElement('button');
  copyButton.className = 'ghost';
  copyButton.textContent = 'voice_id 복사';
  copyButton.addEventListener('click', async () => {
    await navigator.clipboard.writeText(voice.voiceId || '');
    copyButton.textContent = '복사됨';
    setTimeout(() => {
      copyButton.textContent = 'voice_id 복사';
    }, 1200);
  });

  buttonRow.append(generateButton, copyButton);
  header.append(titleWrap, buttonRow);

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.append(createMetaBadge(voice.category || 'account voice'));
  if (voice.labels?.gender) meta.append(createMetaBadge(voice.labels.gender));
  const locale = Array.isArray(voice.verifiedLanguages)
    ? voice.verifiedLanguages.map((item) => item.locale).filter(Boolean)[0]
    : '';
  if (locale) meta.append(createMetaBadge(locale));

  const desc = document.createElement('div');
  desc.className = 'desc';
  desc.textContent = formatVoiceDescription(voice) || 'No description';

  const errorEl = document.createElement('div');
  errorEl.className = 'error';

  const previewWrap = document.createElement('div');
  if (voice.previewUrl) {
    previewWrap.appendChild(createAudioPlayer(voice.previewUrl));
  }

  const generatedWrap = document.createElement('div');
  let generatedAudioUrl = '';

  generateButton.addEventListener('click', async () => {
    generateButton.disabled = true;
    generateButton.textContent = '생성 중...';
    errorEl.textContent = '';
    try {
      const result = await fetchJson('/api/tts-lab/elevenlabs/synthesize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          voiceId: voice.voiceId,
          text: transcriptInput.value,
          modelId: 'eleven_multilingual_v2',
          voiceSettings: {
            stability: 0.45,
            similarity_boost: 0.8,
            style: 0.35,
            speed: 0.94,
            use_speaker_boost: true,
          },
        }),
      });
      if (generatedAudioUrl) URL.revokeObjectURL(generatedAudioUrl);
      generatedAudioUrl = makeAudioUrl(result.audioBase64, result.mimeType);
      generatedWrap.innerHTML = '';
      generatedWrap.appendChild(createAudioPlayer(generatedAudioUrl));
    } catch (error) {
      errorEl.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      generateButton.disabled = false;
      generateButton.textContent = '샘플 생성';
    }
  });

  card.append(header, meta, desc, previewWrap, errorEl, generatedWrap);
  return card;
}

function createSharedVoiceCard(voice) {
  const card = document.createElement('div');
  card.className = 'voiceCard';
  const header = document.createElement('div');
  header.className = 'voiceCardHeader';
  const titleWrap = document.createElement('div');
  const title = document.createElement('strong');
  title.textContent = voice.name || voice.voice_id;
  const noteEl = document.createElement('div');
  noteEl.className = 'hint';
  noteEl.textContent = voice.descriptive || voice.use_case || 'Voice Library candidate';
  titleWrap.append(title, noteEl);

  const copyButton = document.createElement('button');
  copyButton.className = 'ghost';
  copyButton.textContent = 'voice_id 복사';
  copyButton.addEventListener('click', async () => {
    await navigator.clipboard.writeText(voice.voice_id || '');
    copyButton.textContent = '복사됨';
    setTimeout(() => {
      copyButton.textContent = 'voice_id 복사';
    }, 1200);
  });

  header.append(titleWrap, copyButton);

  const meta = document.createElement('div');
  meta.className = 'meta';
  if (voice.category) meta.append(createMetaBadge(voice.category));
  if (voice.gender) meta.append(createMetaBadge(voice.gender));
  if (voice.locale) meta.append(createMetaBadge(voice.locale));

  const desc = document.createElement('div');
  desc.className = 'desc';
  desc.textContent = voice.description || 'No description';

  const hint = document.createElement('div');
  hint.className = 'hint';
  hint.textContent =
    '이 섹션은 preview 청취용입니다. 마음에 들면 ElevenLabs에서 저장한 뒤 계정 음성 섹션에서 샘플 생성하는 흐름을 권장합니다.';

  card.append(header, meta, desc);
  if (voice.preview_url) {
    card.appendChild(createAudioPlayer(voice.preview_url));
  }
  card.append(hint);
  return card;
}

async function loadStatus() {
  try {
    const status = await fetchJson('/api/tts-lab/status');
    setStatusBadges([
      { label: 'Gemini', value: status.geminiAvailable ? 'ready' : 'missing' },
      { label: 'ElevenLabs', value: status.elevenLabsAvailable ? 'ready' : 'missing' },
      { label: 'Google model', value: status.defaultGoogleModel },
      { label: 'Eleven model', value: status.defaultElevenModel },
    ]);
  } catch (error) {
    setStatusBadges([{ label: 'status', value: error instanceof Error ? error.message : String(error) }]);
  }
}

async function loadAccountVoices() {
  accountVoiceErrorEl.textContent = '';
  accountVoiceResultsEl.innerHTML = '';
  try {
    const search = document.getElementById('accountVoiceSearch').value.trim();
    const result = await fetchJson(
      `/api/tts-lab/elevenlabs/account-voices?${new URLSearchParams({
        search,
        pageSize: '50',
      }).toString()}`,
    );
    const rankedVoices = [...result.voices].sort((a, b) => normalizeVoiceScore(b) - normalizeVoiceScore(a));
    if (!rankedVoices.length) {
      accountVoiceErrorEl.textContent = '계정에서 사용할 수 있는 음성을 찾지 못했습니다.';
      return;
    }
    rankedVoices.forEach((voice) => {
      accountVoiceResultsEl.appendChild(createElevenAccountCard(voice));
    });
  } catch (error) {
    accountVoiceErrorEl.textContent = error instanceof Error ? error.message : String(error);
  }
}

async function loadSharedVoices() {
  sharedVoiceErrorEl.textContent = '';
  sharedVoiceResultsEl.innerHTML = '';
  try {
    const search = document.getElementById('sharedVoiceSearch').value.trim();
    const result = await fetchJson(
      `/api/tts-lab/elevenlabs/shared-voices?${new URLSearchParams({
        language: 'ja',
        gender: 'Female',
        category: 'professional',
        search,
        page_size: '18',
      }).toString()}`,
    );
    if (!result.voices.length) {
      sharedVoiceErrorEl.textContent = 'Voice Library 후보를 찾지 못했습니다.';
      return;
    }
    result.voices.forEach((voice) => {
      sharedVoiceResultsEl.appendChild(createSharedVoiceCard(voice));
    });
  } catch (error) {
    sharedVoiceErrorEl.textContent = error instanceof Error ? error.message : String(error);
  }
}

const googleCards = renderGoogleCards();

document.getElementById('generateGoogleAll').addEventListener('click', async () => {
  for (const card of googleCards) {
    await card.trigger();
  }
});

document.getElementById('loadAccountVoices').addEventListener('click', loadAccountVoices);
document.getElementById('loadSharedVoices').addEventListener('click', loadSharedVoices);

loadStatus();
