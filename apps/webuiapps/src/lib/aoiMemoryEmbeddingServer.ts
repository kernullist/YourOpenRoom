import * as fs from 'fs';

import {
  AOI_EMBEDDING_DEFAULT_BASE_URL,
  AOI_EMBEDDING_DEFAULT_MODEL,
  normalizeAoiEmbeddingConfig,
} from './configPersistence';
import {
  createAoiEmbeddingProviderFromConfig,
  createAoiGeminiEmbeddingProvider,
  type AoiEmbeddingProvider,
} from './aoiMemoryEmbedding';
import { createAoiLocalEmbeddingProvider } from './aoiLocalEmbedding';

// Server-only resolver for the Aoi memory embedding provider. The autonomy
// engines run in Node and cannot read the browser-persisted config via the dev
// API, so this reads ~/.openroom/config.json directly (the same aoiEmbedding block
// the chat settings write) with an env fallback. Returns null when no key is set,
// so server capture/recall stay lexical by default -- the key is the opt-in,
// matching the browser path. Provider calls remain best-effort (failures yield
// empty vectors), so embeddings never block the loop.

function readEmbeddingConfigFromFile(
  configFile: string | undefined,
): { apiKey?: string; baseUrl?: string; model?: string } | null {
  if (!configFile) {
    return null;
  }
  try {
    if (!fs.existsSync(configFile)) {
      return null;
    }
    const parsed = JSON.parse(fs.readFileSync(configFile, 'utf-8')) as {
      aoiEmbedding?: unknown;
    } | null;
    const raw =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed.aoiEmbedding : null;
    return normalizeAoiEmbeddingConfig(raw as Record<string, unknown> | null);
  } catch {
    return null;
  }
}

export function createServerAoiEmbeddingProvider(params: {
  configFile?: string;
  env?: Record<string, string | undefined>;
}): AoiEmbeddingProvider | null {
  // Config file takes precedence (explicit operator setting).
  const fileProvider = createAoiEmbeddingProviderFromConfig(
    readEmbeddingConfigFromFile(params.configFile),
  );
  if (fileProvider) {
    return fileProvider;
  }

  // Env fallback for headless / server deployments.
  const env = params.env ?? process.env;
  const gemini = (env.GEMINI_API_KEY ?? '').trim();
  if (gemini) {
    return createAoiGeminiEmbeddingProvider({ apiKey: gemini });
  }
  const openRouter = (env.OPENROUTER_API_KEY ?? '').trim();
  if (openRouter) {
    return createAoiEmbeddingProviderFromConfig({
      apiKey: openRouter,
      baseUrl: AOI_EMBEDDING_DEFAULT_BASE_URL,
      model: AOI_EMBEDDING_DEFAULT_MODEL,
    });
  }
  const openai = (env.OPENAI_API_KEY ?? '').trim();
  if (openai) {
    return createAoiEmbeddingProviderFromConfig({
      apiKey: openai,
      baseUrl: 'https://api.openai.com/v1',
      model: AOI_EMBEDDING_DEFAULT_MODEL,
    });
  }
  // Offline fallback (P4.4): opt-in local hash embedder so the keyless default is
  // not dark (semantic recall + consolidation get real vectors, no egress). Only
  // when NO cloud key is configured above, so it never overrides a real provider.
  if (env.AOI_LOCAL_EMBEDDER === '1' || env.AOI_LOCAL_EMBEDDER === 'true') {
    return createAoiLocalEmbeddingProvider();
  }
  return null;
}
