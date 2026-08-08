// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';

import {
  loadAoiAutonomyCapabilitySettings,
  readAoiAutonomyCapabilitiesConfigFromFile,
  resolveAoiAutonomyCapabilitySettings,
  writeAoiAutonomyCapabilitiesConfigToFile,
} from '../aoiAutonomyCapabilitySettings';
import { KNOWN_CONFIG_KEYS, normalizeAoiAutonomyCapabilitiesConfig } from '../configPersistence';
import { runAoiAutonomyBackgroundCycle } from '../aoiAutonomyBackgroundRunner';
import type { loadAoiAutonomyPolicy } from '../aoiAutonomyStore';
import type { runAoiAutonomyWakeup } from '../aoiAutonomyScheduler';

const tempRoots: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'aoi-capability-settings-'));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('resolveAoiAutonomyCapabilitySettings', () => {
  it('is OFF by default with no config and no env', () => {
    const settings = resolveAoiAutonomyCapabilitySettings({ config: null, env: {} });
    expect(settings.selfExecute).toBe(false);
    expect(settings.appOpLiveDispatch).toBe(false);
    expect(settings.pushWebhookUrl).toBe('');
    expect(settings.goalSynthesis).toBe(false);
    expect(settings.idleConfidenceSurge).toBe(false);
    expect(settings.sources).toEqual({
      selfExecute: 'default',
      appOpLiveDispatch: 'default',
      pushWebhookUrl: 'default',
      goalSynthesis: 'default',
      idleConfidenceSurge: 'default',
    });
  });

  it('falls back to env when the config block is absent', () => {
    const settings = resolveAoiAutonomyCapabilitySettings({
      config: null,
      env: {
        AOI_AUTONOMY_SELF_EXECUTE: '1',
        AOI_AUTONOMY_APP_OP_LIVE_DISPATCH: '1',
        AOI_PUSH_WEBHOOK_URL: 'https://push.example.com/hook',
        AOI_AUTONOMY_GOAL_SYNTHESIS: 'true',
        AOI_AUTONOMY_IDLE_CONFIDENCE_SURGE: 'yes',
      },
    });
    expect(settings.selfExecute).toBe(true);
    expect(settings.appOpLiveDispatch).toBe(true);
    expect(settings.pushWebhookUrl).toBe('https://push.example.com/hook');
    expect(settings.goalSynthesis).toBe(true);
    expect(settings.idleConfidenceSurge).toBe(true);
    expect(settings.sources.selfExecute).toBe('env');
    expect(settings.sources.pushWebhookUrl).toBe('env');
  });

  it('keeps the strict "1"-only parsing for self-execute and live dispatch', () => {
    // These two never accepted true/yes. Loosening it would silently enable a
    // capability on a deployment that wrote 'true' expecting nothing to happen.
    const settings = resolveAoiAutonomyCapabilitySettings({
      config: null,
      env: {
        AOI_AUTONOMY_SELF_EXECUTE: 'true',
        AOI_AUTONOMY_APP_OP_LIVE_DISPATCH: 'yes',
      },
    });
    expect(settings.selfExecute).toBe(false);
    expect(settings.appOpLiveDispatch).toBe(false);
  });

  it('lets an explicit config field beat the env var', () => {
    const settings = resolveAoiAutonomyCapabilitySettings({
      config: { version: 1, selfExecuteEnabled: true, goalSynthesisEnabled: true },
      env: { AOI_AUTONOMY_SELF_EXECUTE: '', AOI_AUTONOMY_GOAL_SYNTHESIS: '' },
    });
    expect(settings.selfExecute).toBe(true);
    expect(settings.goalSynthesis).toBe(true);
    expect(settings.sources.selfExecute).toBe('config');
    expect(settings.sources.goalSynthesis).toBe('config');
  });

  it('lets an explicit config OFF beat an env var that says on', () => {
    const settings = resolveAoiAutonomyCapabilitySettings({
      config: { version: 1, selfExecuteEnabled: false, appOpLiveDispatchEnabled: false },
      env: {
        AOI_AUTONOMY_SELF_EXECUTE: '1',
        AOI_AUTONOMY_APP_OP_LIVE_DISPATCH: '1',
      },
    });
    expect(settings.selfExecute).toBe(false);
    expect(settings.appOpLiveDispatch).toBe(false);
    // Reported as decided HERE, so the UI never says "on via environment" for
    // something the operator switched off.
    expect(settings.sources.selfExecute).toBe('config');
    expect(settings.sources.appOpLiveDispatch).toBe('config');
  });

  it('treats an explicitly empty webhook URL as a real setting that beats env', () => {
    const settings = resolveAoiAutonomyCapabilitySettings({
      config: { version: 1, pushWebhookUrl: '' },
      env: { AOI_PUSH_WEBHOOK_URL: 'https://push.example.com/hook' },
    });
    expect(settings.pushWebhookUrl).toBe('');
    expect(settings.sources.pushWebhookUrl).toBe('config');
  });

  it('resolves each field independently', () => {
    const settings = resolveAoiAutonomyCapabilitySettings({
      config: { version: 1, selfExecuteEnabled: true },
      env: { AOI_AUTONOMY_IDLE_CONFIDENCE_SURGE: '1' },
    });
    expect(settings.sources.selfExecute).toBe('config');
    expect(settings.sources.idleConfidenceSurge).toBe('env');
    expect(settings.sources.goalSynthesis).toBe('default');
  });
});

describe('normalizeAoiAutonomyCapabilitiesConfig', () => {
  it('drops fields that are absent so they keep falling back to env', () => {
    expect(
      normalizeAoiAutonomyCapabilitiesConfig({ version: 1, selfExecuteEnabled: true }),
    ).toEqual({ version: 1, selfExecuteEnabled: true });
  });

  it('returns null when nothing usable is supplied', () => {
    expect(normalizeAoiAutonomyCapabilitiesConfig(null)).toBeNull();
    expect(normalizeAoiAutonomyCapabilitiesConfig({ version: 1 })).toBeNull();
    expect(
      normalizeAoiAutonomyCapabilitiesConfig({
        version: 1,
        selfExecuteEnabled: 'yes' as unknown as boolean,
      }),
    ).toBeNull();
  });

  it('rejects a webhook URL that is not http(s)', () => {
    // A typo must not become an outbound target.
    for (const url of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'push.example.com',
      'ftp://x',
    ]) {
      expect(
        normalizeAoiAutonomyCapabilitiesConfig({ version: 1, pushWebhookUrl: url }),
      ).toBeNull();
    }
  });

  it('keeps an http(s) webhook URL and a deliberate empty one', () => {
    expect(
      normalizeAoiAutonomyCapabilitiesConfig({
        version: 1,
        pushWebhookUrl: ' https://push.example.com/hook ',
      }),
    ).toEqual({ version: 1, pushWebhookUrl: 'https://push.example.com/hook' });
    expect(normalizeAoiAutonomyCapabilitiesConfig({ version: 1, pushWebhookUrl: '  ' })).toEqual({
      version: 1,
      pushWebhookUrl: '',
    });
  });
});

describe('writeAoiAutonomyCapabilitiesConfigToFile', () => {
  it('preserves every other persisted setting', () => {
    const dir = makeTempDir();
    const configFile = join(dir, 'config.json');
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        llm: { apiKey: 'keep-me' },
        aoiMemoryMaintenance: { version: 1, embedSweepEnabled: true },
      }),
    );

    writeAoiAutonomyCapabilitiesConfigToFile(configFile, {
      version: 1,
      selfExecuteEnabled: true,
    });

    const saved = JSON.parse(fs.readFileSync(configFile, 'utf-8')) as Record<string, unknown>;
    expect(saved.llm).toEqual({ apiKey: 'keep-me' });
    expect(saved.aoiMemoryMaintenance).toEqual({ version: 1, embedSweepEnabled: true });
    expect(saved.aoiAutonomyCapabilities).toEqual({ version: 1, selfExecuteEnabled: true });
  });

  it('clearing the block hands every field back to the environment', () => {
    const dir = makeTempDir();
    const configFile = join(dir, 'config.json');
    writeAoiAutonomyCapabilitiesConfigToFile(configFile, {
      version: 1,
      selfExecuteEnabled: false,
    });
    expect(loadAoiAutonomyCapabilitySettings({ configFile, env: {} }).sources.selfExecute).toBe(
      'config',
    );

    writeAoiAutonomyCapabilitiesConfigToFile(configFile, null);
    expect(readAoiAutonomyCapabilitiesConfigFromFile(configFile)).toBeNull();
    const settings = loadAoiAutonomyCapabilitySettings({
      configFile,
      env: { AOI_AUTONOMY_SELF_EXECUTE: '1' },
    });
    expect(settings.selfExecute).toBe(true);
    expect(settings.sources.selfExecute).toBe('env');
  });

  it('MERGES a partial save instead of replacing the block', () => {
    // A body carrying one field must change only that field. Replacing would drop
    // the operator's other explicit decisions, and a dropped field falls back to
    // the env var -- so a partial save could silently re-enable something that had
    // been deliberately turned off.
    const dir = makeTempDir();
    const configFile = join(dir, 'config.json');
    writeAoiAutonomyCapabilitiesConfigToFile(configFile, {
      version: 1,
      selfExecuteEnabled: false,
      appOpLiveDispatchEnabled: false,
    });

    writeAoiAutonomyCapabilitiesConfigToFile(configFile, { version: 1, pushWebhookUrl: '' });

    const settings = loadAoiAutonomyCapabilitySettings({
      configFile,
      env: { AOI_AUTONOMY_SELF_EXECUTE: '1', AOI_AUTONOMY_APP_OP_LIVE_DISPATCH: '1' },
    });
    expect(settings.selfExecute).toBe(false);
    expect(settings.appOpLiveDispatch).toBe(false);
    expect(settings.sources.selfExecute).toBe('config');
  });

  it('fails CLOSED when the config file exists but cannot be read', () => {
    // The operator's decisions are in there and we cannot see them. Falling back
    // to env would discard an explicit OFF and let a deployment env var turn the
    // capability back on.
    const dir = makeTempDir();
    const configFile = join(dir, 'config.json');
    fs.writeFileSync(configFile, '{ truncated');

    const settings = loadAoiAutonomyCapabilitySettings({
      configFile,
      env: { AOI_AUTONOMY_SELF_EXECUTE: '1', AOI_AUTONOMY_APP_OP_LIVE_DISPATCH: '1' },
    });
    expect(settings.selfExecute).toBe(false);
    expect(settings.appOpLiveDispatch).toBe(false);
  });

  it('still uses the env fallback when the file simply does not exist', () => {
    // Absent is the headless case, not a failure.
    const settings = loadAoiAutonomyCapabilitySettings({
      configFile: join(makeTempDir(), 'missing.json'),
      env: { AOI_AUTONOMY_SELF_EXECUTE: '1' },
    });
    expect(settings.selfExecute).toBe(true);
    expect(settings.sources.selfExecute).toBe('env');
  });

  it('survives a whole-file settings Save', () => {
    // aoiMcpConnectors and then aoiMemoryMaintenance were each wiped the first
    // time the user pressed Save, because the whole-file writer rebuilt
    // config.json from a hand-maintained key list this block was missing from.
    // Worst direction here: an explicit "off" that was overriding an inherited
    // env var disappears and the capability turns back ON.
    expect(KNOWN_CONFIG_KEYS).toContain('aoiAutonomyCapabilities');
  });

  it('refuses to overwrite a config file it cannot read', () => {
    const dir = makeTempDir();
    const configFile = join(dir, 'config.json');
    fs.writeFileSync(configFile, '{ this is not json');
    expect(() =>
      writeAoiAutonomyCapabilitiesConfigToFile(configFile, {
        version: 1,
        selfExecuteEnabled: true,
      }),
    ).toThrow(/refusing to overwrite/);
    // The operator's file is untouched.
    expect(fs.readFileSync(configFile, 'utf-8')).toBe('{ this is not json');
  });
});

describe('runAoiAutonomyBackgroundCycle capability refresh', () => {
  it('re-reads the capabilities every cycle so a toggle applies without a restart', async () => {
    // These two used to be resolved once at process start and handed to the
    // runner as static values, so on an always-on daemon switching one OFF did
    // nothing until the next restart -- and OFF is the safety-relevant direction.
    const seen: Array<boolean | undefined> = [];
    let goalSynthesis = true;
    const runCycle = async (): Promise<void> => {
      await runAoiAutonomyBackgroundCycle({
        sessionsDir: '/tmp/aoi-capability-refresh',
        configFile: '/tmp/aoi-capability-refresh/config.json',
        workspaceRoot: '/tmp/aoi-capability-refresh',
        goalSynthesisEnabled: true,
        idleConfidenceSurgeEnabled: true,
        resolveCapabilities: () => ({ goalSynthesis, idleConfidenceSurge: goalSynthesis }),
        listSessions: () => ['aoi/default'],
        loadPolicy: () =>
          ({ enabled: true, allowNetwork: true }) as unknown as ReturnType<
            typeof loadAoiAutonomyPolicy
          >,
        runWakeup: async (input) => {
          seen.push(input.budget?.goalSynthesisEnabled);
          return { proposals: [], reflection: null } as unknown as Awaited<
            ReturnType<typeof runAoiAutonomyWakeup>
          >;
        },
      });
    };

    await runCycle();
    goalSynthesis = false;
    await runCycle();

    expect(seen).toEqual([true, false]);
  });

  it('keeps the startup values when the resolver throws (never falls open)', async () => {
    const seen: Array<boolean | undefined> = [];
    await runAoiAutonomyBackgroundCycle({
      sessionsDir: '/tmp/aoi-capability-refresh',
      configFile: '/tmp/aoi-capability-refresh/config.json',
      workspaceRoot: '/tmp/aoi-capability-refresh',
      goalSynthesisEnabled: false,
      idleConfidenceSurgeEnabled: false,
      resolveCapabilities: () => {
        throw new Error('config unreadable');
      },
      listSessions: () => ['aoi/default'],
      loadPolicy: () =>
        ({ enabled: true, allowNetwork: true }) as unknown as ReturnType<
          typeof loadAoiAutonomyPolicy
        >,
      runWakeup: async (input) => {
        seen.push(input.budget?.goalSynthesisEnabled);
        return { proposals: [], reflection: null } as unknown as Awaited<
          ReturnType<typeof runAoiAutonomyWakeup>
        >;
      },
    });

    expect(seen).toEqual([false]);
  });
});

describe('loadAoiAutonomyCapabilitySettings', () => {
  it('reads the block from a real config file', () => {
    const dir = makeTempDir();
    const configFile = join(dir, 'config.json');
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        aoiAutonomyCapabilities: {
          version: 1,
          appOpLiveDispatchEnabled: true,
          pushWebhookUrl: 'https://push.example.com/hook',
        },
      }),
    );

    const settings = loadAoiAutonomyCapabilitySettings({ configFile, env: {} });
    expect(settings.appOpLiveDispatch).toBe(true);
    expect(settings.pushWebhookUrl).toBe('https://push.example.com/hook');
    expect(settings.sources.appOpLiveDispatch).toBe('config');
    expect(settings.sources.goalSynthesis).toBe('default');
  });

  it('is OFF when the config file does not exist', () => {
    const settings = loadAoiAutonomyCapabilitySettings({
      configFile: join(makeTempDir(), 'missing.json'),
      env: {},
    });
    expect(settings.selfExecute).toBe(false);
    expect(settings.sources.selfExecute).toBe('default');
  });
});
