import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appDir = path.resolve(__dirname, '..');

const defaultGoogleVoices = ['Despina', 'Kore', 'Pulcherrima', 'Achernar', 'Gacrux'];
const defaultTranscript =
  '……勘違いしないで。特別扱いしてるんじゃない。ただ、少し気にかけてるだけ。';
const defaultStylePrompt =
  '20代半ばの日本人女性。上品で少し高飛車、感情は抑えめ。冷たすぎず、余裕と色気がある。語尾は軽く流し、決して子供っぽくしない。テンポはやや 빠르게, 기본보다 10~15% 정도 빠른 호흡으로 또렷하게 말하고, 불필요하게 늘이지 않는다.';

function printHelp() {
  console.log(`
Usage:
  node apps/webuiapps/script/generate-aoi-voice-samples.mjs [options]

Options:
  --text "..."              Override transcript
  --style "..."             Override acting/style prompt
  --google-voice NAME       Add an extra Google voice candidate (repeatable)
  --eleven-limit N          Number of ElevenLabs account voices to synthesize (default: 3)
  --out-dir PATH            Custom output directory
  --dry-run                 Print configuration without generating audio
  --help                    Show this help
`);
}

function parseArgs(argv) {
  const args = {
    text: defaultTranscript,
    style: defaultStylePrompt,
    googleVoices: [...defaultGoogleVoices],
    elevenLimit: 3,
    dryRun: false,
    outDir: '',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help') {
      args.help = true;
      continue;
    }
    if (arg === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    if (arg === '--text') {
      args.text = argv[i + 1] ?? args.text;
      i += 1;
      continue;
    }
    if (arg === '--style') {
      args.style = argv[i + 1] ?? args.style;
      i += 1;
      continue;
    }
    if (arg === '--google-voice') {
      const voice = argv[i + 1];
      if (voice) args.googleVoices.push(voice);
      i += 1;
      continue;
    }
    if (arg === '--eleven-limit') {
      const nextValue = Number(argv[i + 1]);
      if (Number.isFinite(nextValue) && nextValue >= 0) {
        args.elevenLimit = nextValue;
      }
      i += 1;
      continue;
    }
    if (arg === '--out-dir') {
      args.outDir = argv[i + 1] ?? '';
      i += 1;
    }
  }

  args.googleVoices = [...new Set(args.googleVoices.filter(Boolean))];
  return args;
}

async function loadEnv() {
  const envPath = path.join(appDir, '.env.local');
  const env = { ...process.env };
  try {
    const raw = await fs.readFile(envPath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const match = line.match(/^\s*([^#=\s]+)\s*=\s*(.*)\s*$/);
      if (!match) continue;
      const [, key, value] = match;
      if (!env[key]) env[key] = value.replace(/^['"]|['"]$/g, '');
    }
  } catch {
    // ignore missing env file
  }
  return env;
}

function buildGeminiPrompt(stylePrompt, transcript) {
  return [
    stylePrompt.trim() || 'Speak in natural Japanese with elegant, cool confidence.',
    'Speak the transcript exactly once in Japanese.',
    'Do not add extra narration, labels, or explanations.',
    'Transcript:',
    transcript.trim(),
  ].join('\n\n');
}

function buildWavFromPcm(pcmData, sampleRate = 24000, channels = 1, bitsPerSample = 16) {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcmData.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcmData.length, 40);
  return Buffer.concat([header, pcmData]);
}

function sanitizeFileName(name) {
  return name.replace(/[^a-z0-9._-]+/gi, '_').replace(/^_+|_+$/g, '');
}

function simplifyVoice(voice) {
  return {
    voiceId: voice.voice_id,
    name: voice.name,
    category: voice.category,
    description: voice.description,
    previewUrl: voice.preview_url,
    labels: voice.labels,
    verifiedLanguages: voice.verified_languages,
    settings: voice.settings,
  };
}

function scoreElevenVoice(voice) {
  const labels = voice.labels || {};
  const verifiedLanguages = Array.isArray(voice.verifiedLanguages) ? voice.verifiedLanguages : [];
  const blob = [
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
  if (blob.includes('japanese')) score += 4;
  if (blob.includes('anime')) score += 3;
  if (blob.includes('character')) score += 2;
  if (
    ['cool', 'calm', 'soft', 'gentle', 'mature', 'elegant', 'sassy', 'seductive'].some((token) =>
      blob.includes(token),
    )
  ) {
    score += 2;
  }
  return score;
}

async function synthesizeGemini({ apiKey, transcript, stylePrompt, voiceName }) {
  const model = 'gemini-3.1-flash-tts-preview';
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      model,
    )}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: buildGeminiPrompt(stylePrompt, transcript) }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName,
              },
            },
          },
        },
      }),
    },
  );

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Gemini TTS failed for ${voiceName}: ${text}`);
  }

  const parsed = JSON.parse(text);
  const pcmBase64 = parsed?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data?.trim();
  if (!pcmBase64) {
    throw new Error(`Gemini TTS returned no audio for ${voiceName}`);
  }
  return buildWavFromPcm(Buffer.from(pcmBase64, 'base64'));
}

async function fetchElevenAccountVoices(apiKey) {
  const response = await fetch('https://api.elevenlabs.io/v2/voices?page_size=100', {
    headers: {
      'xi-api-key': apiKey,
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`ElevenLabs voice list failed: ${text}`);
  }
  const parsed = JSON.parse(text);
  return Array.isArray(parsed.voices) ? parsed.voices.map(simplifyVoice) : [];
}

async function fetchElevenSharedVoices(apiKey) {
  const response = await fetch(
    'https://api.elevenlabs.io/v1/shared-voices?language=ja&gender=Female&category=professional&search=anime&page_size=20',
    {
      headers: {
        'xi-api-key': apiKey,
      },
    },
  );
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`ElevenLabs shared voice list failed: ${text}`);
  }
  const parsed = JSON.parse(text);
  return Array.isArray(parsed.voices) ? parsed.voices : [];
}

async function synthesizeEleven({ apiKey, voiceId, transcript }) {
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(
      voiceId,
    )}?output_format=mp3_44100_128`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key': apiKey,
      },
      body: JSON.stringify({
        text: transcript,
        model_id: 'eleven_multilingual_v2',
        voice_settings: {
          stability: 0.45,
          similarity_boost: 0.8,
          style: 0.35,
          speed: 0.94,
          use_speaker_boost: true,
        },
      }),
    },
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`ElevenLabs synthesis failed for ${voiceId}: ${text}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const env = await loadEnv();
  const geminiApiKey = env.GEMINI_API_KEY || '';
  const elevenApiKey = env.ELEVENLABS_API_KEY || '';
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = args.outDir
    ? path.resolve(process.cwd(), args.outDir)
    : path.join(appDir, '__generated__', 'tts-lab', timestamp);

  console.log('[tts-lab] Output directory:', outDir);
  console.log('[tts-lab] Google voices:', args.googleVoices.join(', '));
  console.log('[tts-lab] ElevenLabs synthesis limit:', args.elevenLimit);

  if (args.dryRun) {
    console.log('[tts-lab] Dry run only. No audio requests will be sent.');
    return;
  }

  if (!geminiApiKey) {
    throw new Error('GEMINI_API_KEY is missing.');
  }

  await fs.mkdir(outDir, { recursive: true });
  const manifest = {
    generatedAt: new Date().toISOString(),
    transcript: args.text,
    stylePrompt: args.style,
    google: [],
    elevenlabs: {
      accountCandidates: [],
      synthesized: [],
      sharedSuggestions: [],
    },
  };

  for (const voiceName of args.googleVoices) {
    console.log(`[tts-lab] Generating Google sample for ${voiceName}...`);
    const wavBuffer = await synthesizeGemini({
      apiKey: geminiApiKey,
      transcript: args.text,
      stylePrompt: args.style,
      voiceName,
    });
    const fileName = `google-${sanitizeFileName(voiceName)}.wav`;
    await fs.writeFile(path.join(outDir, fileName), wavBuffer);
    manifest.google.push({ voiceName, fileName });
  }

  if (elevenApiKey) {
    console.log('[tts-lab] Fetching ElevenLabs account voices...');
    const accountVoices = await fetchElevenAccountVoices(elevenApiKey);
    const rankedCandidates = [...accountVoices]
      .map((voice) => ({ ...voice, score: scoreElevenVoice(voice) }))
      .sort((a, b) => b.score - a.score);
    manifest.elevenlabs.accountCandidates = rankedCandidates.slice(0, 20);
    await fs.writeFile(
      path.join(outDir, 'eleven-account-candidates.json'),
      JSON.stringify(rankedCandidates.slice(0, 20), null, 2),
      'utf8',
    );

    const voicesToSynthesize = rankedCandidates
      .filter((voice) => voice.score > 0)
      .slice(0, args.elevenLimit);

    for (const voice of voicesToSynthesize) {
      console.log(`[tts-lab] Generating ElevenLabs sample for ${voice.name} (${voice.voiceId})...`);
      try {
        const audioBuffer = await synthesizeEleven({
          apiKey: elevenApiKey,
          voiceId: voice.voiceId,
          transcript: args.text,
        });
        const fileName = `eleven-${sanitizeFileName(voice.name || voice.voiceId)}.mp3`;
        await fs.writeFile(path.join(outDir, fileName), audioBuffer);
        manifest.elevenlabs.synthesized.push({
          voiceId: voice.voiceId,
          name: voice.name,
          score: voice.score,
          fileName,
        });
      } catch (error) {
        manifest.elevenlabs.synthesized.push({
          voiceId: voice.voiceId,
          name: voice.name,
          score: voice.score,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    console.log('[tts-lab] Fetching ElevenLabs shared Japanese female suggestions...');
    try {
      const sharedVoices = await fetchElevenSharedVoices(elevenApiKey);
      manifest.elevenlabs.sharedSuggestions = sharedVoices.slice(0, 20);
      await fs.writeFile(
        path.join(outDir, 'eleven-shared-suggestions.json'),
        JSON.stringify(sharedVoices.slice(0, 20), null, 2),
        'utf8',
      );
    } catch (error) {
      manifest.elevenlabs.sharedSuggestions = [
        { error: error instanceof Error ? error.message : String(error) },
      ];
    }
  } else {
    console.log('[tts-lab] ELEVENLABS_API_KEY is missing. Skipping ElevenLabs generation.');
  }

  await fs.writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  console.log('[tts-lab] Done.');
}

main().catch((error) => {
  console.error('[tts-lab] Failed:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
