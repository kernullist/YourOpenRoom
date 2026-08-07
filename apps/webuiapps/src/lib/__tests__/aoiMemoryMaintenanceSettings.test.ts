import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  loadAoiMemoryMaintenanceSettings,
  readAoiMemoryMaintenanceConfigFromFile,
  resolveAoiMemoryMaintenanceSettings,
  writeAoiMemoryMaintenanceConfigToFile,
} from '../aoiMemoryMaintenanceSettings';
import { normalizeAoiMemoryMaintenanceConfig } from '../configPersistence';
import { resolveAoiMemoryEmbedSweepConfigFromEnv } from '../aoiMemoryEmbedSweep';
import { resolveAoiMemoryConsolidationConfigFromEnv } from '../aoiMemoryConsolidationSweep';

let tmpDir = '';
let configFile = '';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aoi-maintenance-'));
  configFile = path.join(tmpDir, 'config.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('normalizeAoiMemoryMaintenanceConfig', () => {
  it('keeps absent fields absent so the env fallback still decides them', () => {
    const normalized = normalizeAoiMemoryMaintenanceConfig({ embedSweepEnabled: true });
    expect(normalized).toEqual({ version: 1, embedSweepEnabled: true });
    expect(normalized).not.toHaveProperty('consolidationEnabled');
    expect(normalized).not.toHaveProperty('localEmbedderEnabled');
  });

  it('clamps numeric fields into their safe ranges', () => {
    expect(
      normalizeAoiMemoryMaintenanceConfig({
        embedSweepIntervalMinutes: 9999,
        embedSweepMax: 0,
        consolidationMax: 999,
      }),
    ).toEqual({
      version: 1,
      embedSweepIntervalMinutes: 120,
      embedSweepMax: 1,
      consolidationMax: 32,
    });
  });

  it('returns null for empty or non-object input', () => {
    expect(normalizeAoiMemoryMaintenanceConfig(null)).toBeNull();
    expect(normalizeAoiMemoryMaintenanceConfig({})).toBeNull();
  });
});

describe('resolveAoiMemoryMaintenanceSettings precedence', () => {
  it('lets an explicit config field win over the env var', () => {
    const settings = resolveAoiMemoryMaintenanceSettings({
      config: { version: 1, embedSweepEnabled: false, localEmbedderEnabled: true },
      env: { AOI_AUTONOMY_EMBED_SWEEP: '1', AOI_LOCAL_EMBEDDER: '' },
    });

    // The UI switch is authoritative in BOTH directions: it can turn a sweep
    // off that the environment turned on, and on that the environment left off.
    expect(settings.embedSweep.enabled).toBe(false);
    expect(settings.sources.embedSweep).toBe('config');
    expect(settings.localEmbedder).toBe(true);
    expect(settings.sources.localEmbedder).toBe('config');
  });

  it('falls back to the env var when the field is absent', () => {
    const settings = resolveAoiMemoryMaintenanceSettings({
      config: { version: 1, embedSweepEnabled: true },
      env: { AOI_AUTONOMY_CONSOLIDATION: '1', AOI_LOCAL_EMBEDDER: '1' },
    });

    expect(settings.consolidation.enabled).toBe(true);
    expect(settings.sources.consolidation).toBe('env');
    expect(settings.localEmbedder).toBe(true);
    expect(settings.sources.localEmbedder).toBe('env');
  });

  it('is off by default with neither config nor env', () => {
    const settings = resolveAoiMemoryMaintenanceSettings({ config: null, env: {} });

    expect(settings.embedSweep.enabled).toBe(false);
    expect(settings.consolidation.enabled).toBe(false);
    expect(settings.localEmbedder).toBe(false);
    expect(settings.sources.embedSweep).toBe('default');
  });

  it('converts the operator-facing interval in minutes to milliseconds', () => {
    const settings = resolveAoiMemoryMaintenanceSettings({
      config: { version: 1, embedSweepIntervalMinutes: 10, embedSweepMax: 4 },
      env: {},
    });

    expect(settings.embedSweep.intervalMs).toBe(600_000);
    expect(settings.embedSweep.max).toBe(4);
  });

  it('agrees with the env-only resolvers it duplicates (drift guard)', () => {
    // The env parsing is duplicated in this module to break an import cycle;
    // if either side changes its defaults, this fails.
    const env = {
      AOI_AUTONOMY_EMBED_SWEEP: '1',
      AOI_AUTONOMY_EMBED_SWEEP_INTERVAL_MS: '90000',
      AOI_AUTONOMY_EMBED_SWEEP_MAX: '4',
      AOI_AUTONOMY_CONSOLIDATION: '1',
      AOI_AUTONOMY_CONSOLIDATION_MAX: '3',
    };
    const settings = resolveAoiMemoryMaintenanceSettings({ config: null, env });
    const envSweep = resolveAoiMemoryEmbedSweepConfigFromEnv(env);
    const envConsolidation = resolveAoiMemoryConsolidationConfigFromEnv(env);

    expect(settings.embedSweep).toEqual(envSweep);
    expect(settings.consolidation).toEqual(envConsolidation);

    const defaults = resolveAoiMemoryMaintenanceSettings({ config: null, env: {} });
    expect(defaults.embedSweep).toEqual(resolveAoiMemoryEmbedSweepConfigFromEnv({}));
    expect(defaults.consolidation).toEqual(resolveAoiMemoryConsolidationConfigFromEnv({}));
  });
});

describe('config file persistence', () => {
  it('preserves every other persisted setting when saving the block', () => {
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        llm: { provider: 'deepseek', apiKey: 'sk-test', model: 'deepseek-v4-flash' },
        tavily: { apiKey: 'tvly-test' },
      }),
      'utf-8',
    );

    writeAoiMemoryMaintenanceConfigToFile(configFile, {
      version: 1,
      embedSweepEnabled: true,
      localEmbedderEnabled: true,
    });

    const saved = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
    expect(saved.llm).toEqual({
      provider: 'deepseek',
      apiKey: 'sk-test',
      model: 'deepseek-v4-flash',
    });
    expect(saved.tavily).toEqual({ apiKey: 'tvly-test' });
    expect(saved.aoiMemoryMaintenance).toEqual({
      version: 1,
      embedSweepEnabled: true,
      localEmbedderEnabled: true,
    });
  });

  it('round-trips through the file reader and clears on null', () => {
    writeAoiMemoryMaintenanceConfigToFile(configFile, { version: 1, consolidationEnabled: true });
    expect(readAoiMemoryMaintenanceConfigFromFile(configFile)).toEqual({
      version: 1,
      consolidationEnabled: true,
    });

    writeAoiMemoryMaintenanceConfigToFile(configFile, null);
    expect(readAoiMemoryMaintenanceConfigFromFile(configFile)).toBeNull();
    // Clearing the block hands the toggles back to the environment.
    expect(
      loadAoiMemoryMaintenanceSettings({ configFile, env: { AOI_AUTONOMY_CONSOLIDATION: '1' } })
        .sources.consolidation,
    ).toBe('env');
  });

  it('refuses to overwrite a malformed config file', () => {
    fs.writeFileSync(configFile, '{ not json', 'utf-8');
    expect(() =>
      writeAoiMemoryMaintenanceConfigToFile(configFile, { version: 1, embedSweepEnabled: true }),
    ).toThrow(/refusing to overwrite/i);
    expect(fs.readFileSync(configFile, 'utf-8')).toBe('{ not json');
  });

  it('creates the block when the config file does not exist yet', () => {
    const fresh = path.join(tmpDir, 'new-config.json');
    writeAoiMemoryMaintenanceConfigToFile(fresh, { version: 1, embedSweepEnabled: true });
    expect(readAoiMemoryMaintenanceConfigFromFile(fresh)).toEqual({
      version: 1,
      embedSweepEnabled: true,
    });
  });

  it('returns null for a missing file or missing block', () => {
    expect(readAoiMemoryMaintenanceConfigFromFile(path.join(tmpDir, 'nope.json'))).toBeNull();
    expect(readAoiMemoryMaintenanceConfigFromFile(undefined)).toBeNull();
    fs.writeFileSync(configFile, JSON.stringify({ llm: {} }), 'utf-8');
    expect(readAoiMemoryMaintenanceConfigFromFile(configFile)).toBeNull();
  });
});
