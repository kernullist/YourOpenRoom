// Which model the turn-understanding classifier runs on.
//
// By default it follows the main model: one provider, one key, nothing to
// configure. Two situations want something else. A main model that spawns a
// process per call (the CLI and managed-auth providers) would usually outlive
// the classifier's budget, so the dialog model stands in when it is an API
// provider. And a main model that is the right choice for answering can be the
// wrong one for reading: measured 2026-09-11, DeepSeek flash read kind and
// family better than qwen3.7-flash (98.9% / 96.6% against 95.5% / 90.9%) but
// answered "medium" confidence on clear requests often enough to under-route
// eleven turns where qwen under-routed one. The explicit override lets the
// main model move without the classifier following it.
//
// The override is honoured only when it can actually be called: an API
// provider with an endpoint, a model, and a key (a local server needs none). A
// remote override without a key would 401 on every turn, and a classifier that
// fails on every turn is indistinguishable from one that is switched off.

import type { LLMConfig } from './llmModels';
import { resolveLlmOverride } from './llmClient';

export const TURN_CLASSIFIER_PROCESS_PROVIDERS: ReadonlySet<string> = new Set([
  'claude-cli',
  'codex-cli',
  'codex-auth',
]);

const KEYLESS_PROVIDERS: ReadonlySet<string> = new Set(['llama.cpp']);

function hasEndpointAndModel(config: LLMConfig | null): config is LLMConfig {
  return Boolean(config && config.baseUrl.trim() && config.model.trim());
}

/** Whether an explicit classifier override can be called as configured. */
export function isUsableTurnClassifierOverride(config: LLMConfig | null): config is LLMConfig {
  if (!hasEndpointAndModel(config)) {
    return false;
  }
  if (TURN_CLASSIFIER_PROCESS_PROVIDERS.has(config.provider)) {
    return false;
  }
  return KEYLESS_PROVIDERS.has(config.provider) || config.apiKey.trim().length > 0;
}

/**
 * The config the classifier should run with, or null when no API model is
 * available for it (a CLI main model with no API dialog model): the caller then
 * skips the call and the regex reading stands.
 */
export function resolveTurnClassifierConfig(
  cfg: LLMConfig,
  dialogCfg: Partial<LLMConfig> | null | undefined,
  classifierCfg: Partial<LLMConfig> | null | undefined,
): LLMConfig | null {
  if (classifierCfg && Object.keys(classifierCfg).length > 0) {
    // Blank fields inherit from the main config when the provider matches, the
    // same way the dialog model does; a different provider must be complete.
    const explicit = resolveLlmOverride(cfg, classifierCfg);
    if (isUsableTurnClassifierOverride(explicit)) {
      return explicit;
    }
  }
  if (!TURN_CLASSIFIER_PROCESS_PROVIDERS.has(cfg.provider)) {
    return cfg;
  }
  const dialogCandidate = resolveLlmOverride(cfg, dialogCfg);
  return hasEndpointAndModel(dialogCandidate) &&
    !TURN_CLASSIFIER_PROCESS_PROVIDERS.has(dialogCandidate.provider)
    ? dialogCandidate
    : null;
}
