import * as fs from 'fs';
import { resolve } from 'path';
import { createAoiLocalEmbeddingProvider } from './aoiLocalEmbedding';
import { createServerAoiEmbeddingProvider } from './aoiMemoryEmbeddingServer';
import { embedAndPersistServerAoiMemories, loadServerAoiMemories } from './aoiMemoryServerWriter';
import { runAoiMeasuredMemoryRecall } from './aoiMeasuredMemoryRecall';
import type { AoiMemoryRecallTrial } from './aoiMemoryRecallDiagnostics';
import { normalizeAoiAutonomySessionPath } from './aoiAutonomyStore';

export const AOI_MEASURED_RECALL_EXIT_OK = 0;
export const AOI_MEASURED_RECALL_EXIT_ERROR = 1;
export const AOI_MEASURED_RECALL_EXIT_INPUT = 2;

export interface AoiMeasuredMemoryRecallCliOptions {
  sessionsDir: string;
  sessionPath: string;
  configFile?: string;
  query: string;
  expectedMemoryIds: string[];
  limit: number;
  localEmbedder: boolean;
  embedPending: boolean;
}
export interface AoiMeasuredMemoryRecallCliReport {
  version: 1;
  trial: AoiMemoryRecallTrial;
  providerModel: string | null;
  embeddedCount: number;
  pendingCount: number;
}

export interface AoiMeasuredMemoryRecallCliDeps {
  argv: readonly string[];
  env: Record<string, string | undefined>;
  runMeasurement: (
    options: AoiMeasuredMemoryRecallCliOptions,
    env: Record<string, string | undefined>,
  ) => Promise<AoiMeasuredMemoryRecallCliReport>;
  log: (message: string) => void;
  logError: (message: string) => void;
}

function readOption(argv: readonly string[], optionName: string): string {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === optionName && index + 1 < argv.length) {
      return argv[index + 1].trim();
    }
    const prefix = `${optionName}=`;
    if (arg.startsWith(prefix)) {
      return arg.slice(prefix.length).trim();
    }
  }
  return '';
}

function hasFlag(argv: readonly string[], optionName: string): boolean {
  return argv.includes(optionName);
}

function normalizeExpectedIds(value: string): string[] {
  return [
    ...new Set(
      value
        .split(',')
        .map((item) => item.trim())
        .filter((item) => /^[A-Za-z0-9_.:-]{3,160}$/.test(item)),
    ),
  ];
}

export function parseAoiMeasuredMemoryRecallCliOptions(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): AoiMeasuredMemoryRecallCliOptions {
  const sessionsDir =
    readOption(argv, '--sessions-dir') ||
    env.AOI_SESSIONS_DIR?.trim() ||
    env.AOI_DAEMON_SESSIONS_DIR?.trim() ||
    '';
  const sessionPath = readOption(argv, '--session-path') || env.AOI_SESSION_PATH?.trim() || '';
  const configFile =
    readOption(argv, '--config-file') || env.AOI_DAEMON_CONFIG_FILE?.trim() || undefined;
  const query = readOption(argv, '--query');
  const expectedMemoryIds = normalizeExpectedIds(readOption(argv, '--expected-memory-ids'));
  const limitText = readOption(argv, '--limit') || '5';
  const limit = Number.parseInt(limitText, 10);
  if (!sessionsDir || !sessionPath || !query || expectedMemoryIds.length === 0) {
    throw new Error(
      'Required: --sessions-dir, --session-path, --query, and --expected-memory-ids.',
    );
  }
  if (query.length > 1_000) {
    throw new Error('--query must be at most 1000 characters.');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
    throw new Error('--limit must be an integer from 1 to 10.');
  }
  return {
    sessionsDir,
    sessionPath,
    ...(configFile ? { configFile } : {}),
    query,
    expectedMemoryIds,
    limit,
    localEmbedder: hasFlag(argv, '--local-embedder'),
    embedPending: hasFlag(argv, '--embed-pending'),
  };
}

export async function measureAoiMemoryRecall(
  options: AoiMeasuredMemoryRecallCliOptions,
  env: Record<string, string | undefined> = process.env,
): Promise<AoiMeasuredMemoryRecallCliReport> {
  const sessionsDir = resolve(options.sessionsDir);
  if (!fs.existsSync(sessionsDir) || !fs.statSync(sessionsDir).isDirectory()) {
    throw new Error('sessionsDir must be an existing directory.');
  }
  const sessionPath = normalizeAoiAutonomySessionPath(options.sessionPath);
  if (!sessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const memoriesBefore = loadServerAoiMemories(sessionsDir).filter(
    (memory) => memory.sessionPath === sessionPath && memory.status === 'active',
  );
  const activeIds = new Set(memoriesBefore.map((memory) => memory.id));
  const invalidExpectedIds = options.expectedMemoryIds.filter((id) => !activeIds.has(id));
  if (invalidExpectedIds.length > 0) {
    throw new Error(`Expected active session memories not found: ${invalidExpectedIds.join(',')}`);
  }

  const provider = options.localEmbedder
    ? createAoiLocalEmbeddingProvider()
    : createServerAoiEmbeddingProvider({ configFile: options.configFile, env });
  let embeddedCount = 0;
  let pendingCount = memoriesBefore.filter(
    (memory) => !Array.isArray(memory.embedding) || memory.embedding.length === 0,
  ).length;
  if (options.embedPending) {
    if (!provider) {
      throw new Error('No embedding provider is available for --embed-pending.');
    }
    const embedded = await embedAndPersistServerAoiMemories(sessionsDir, provider, { max: 32 });
    embeddedCount = embedded.embeddedCount;
    pendingCount = embedded.pendingCount;
  }
  const trial = await runAoiMeasuredMemoryRecall({
    sessionsDir,
    sessionPath,
    query: options.query,
    expectedMemoryIds: options.expectedMemoryIds,
    provider,
    limit: options.limit,
  });
  return {
    version: 1,
    trial,
    providerModel: provider?.model ?? null,
    embeddedCount,
    pendingCount,
  };
}

export async function runAoiMeasuredMemoryRecallCli(
  deps: AoiMeasuredMemoryRecallCliDeps,
): Promise<number> {
  let options: AoiMeasuredMemoryRecallCliOptions;
  try {
    options = parseAoiMeasuredMemoryRecallCliOptions(deps.argv, deps.env);
  } catch (error) {
    deps.logError(`[aoi-measured-recall] invalid input: ${String(error)}`);
    return AOI_MEASURED_RECALL_EXIT_INPUT;
  }
  try {
    const report = await deps.runMeasurement(options, deps.env);
    deps.log(JSON.stringify(report, null, 2));
    deps.log(`[aoi-measured-recall] trial ${report.trial.success ? 'HIT' : 'MISS'}.`);
    return AOI_MEASURED_RECALL_EXIT_OK;
  } catch (error) {
    deps.logError(`[aoi-measured-recall] measurement failed: ${String(error)}`);
    return AOI_MEASURED_RECALL_EXIT_ERROR;
  }
}
