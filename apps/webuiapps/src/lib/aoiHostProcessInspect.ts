// Aoi host-bridge process inspection (HP1): read-only, metadata-only listing of
// the real machine's running processes, so Aoi can finally answer "what is
// running on my PC right now" (docs/aoi-host-access-design.md).
//
// Safety posture (load-bearing):
//   - METADATA ONLY, structurally: a record carries { pid, imageName,
//     sessionName?, memKb? } and there is NO command-line field, ever. Command
//     lines leak secrets/tokens, so they are never parsed or stored here.
//   - The consent gate (`process-activity` source) and the host-bridge kill
//     switch are enforced by the CALLER (the daemon route) before this runs;
//     this module is the pure/effectful data layer only. It executes NOTHING
//     except a fixed read-only listing command with a fixed argument vector
//     (shell:false), so it can neither spawn nor mutate anything.
//   - Bounded: the parsed list is capped so a machine with thousands of
//     processes cannot blow up memory or a downstream prompt.
//
// Server-only (child_process). The parsers and the summarizer are PURE and
// exported for unit testing without spawning anything.
import { spawn } from 'child_process';

// Hard cap on how many process records are retained from one listing.
export const AOI_MAX_HOST_PROCESS_RECORDS = 400;
const LIST_TIMEOUT_MS = 8_000;
const MAX_OUTPUT_BYTES = 4_000_000;
const MAX_IMAGE_NAME_CHARS = 128;

// Metadata-only. The absence of a command-line field is the structural privacy
// boundary -- do not add one.
export interface AoiHostProcessRecord {
  pid: number;
  imageName: string;
  sessionName?: string;
  memKb?: number;
}

export interface AoiHostProcessImageCount {
  imageName: string;
  count: number;
}

export interface AoiHostProcessSummary {
  version: 1;
  sampledAt: number;
  totalCount: number;
  // Distinct image names, ranked by instance count (most-run first), bounded.
  topImages: AoiHostProcessImageCount[];
  distinctImageCount: number;
}

export interface AoiHostProcessListing {
  version: 1;
  sampledAt: number;
  records: AoiHostProcessRecord[];
  summary: AoiHostProcessSummary;
}

function normalizeImageName(value: string): string {
  return value.trim().replace(/\s+/g, ' ').slice(0, MAX_IMAGE_NAME_CHARS);
}

// Split one CSV line honoring double-quoted fields (tasklist quotes every
// field). Good enough for tasklist's fixed shape -- no embedded quotes.
function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      fields.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields;
}

function parseMemKb(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  // "123,456 K" -> 123456
  const digits = value.replace(/[^0-9]/g, '');
  if (!digits) {
    return undefined;
  }
  const parsed = Number.parseInt(digits, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

// Parse `tasklist /FO CSV /NH` output. Columns:
// "Image Name","PID","Session Name","Session#","Mem Usage".
export function parseWindowsTasklistCsv(stdout: string): AoiHostProcessRecord[] {
  const records: AoiHostProcessRecord[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const fields = splitCsvLine(line);
    if (fields.length < 2) {
      continue;
    }
    const imageName = normalizeImageName(fields[0]);
    const pid = Number.parseInt((fields[1] || '').replace(/[^0-9]/g, ''), 10);
    if (!imageName || !Number.isFinite(pid) || pid <= 0) {
      continue;
    }
    const sessionName = fields[2]?.trim();
    const record: AoiHostProcessRecord = { pid, imageName };
    if (sessionName) {
      record.sessionName = sessionName.slice(0, 32);
    }
    const memKb = parseMemKb(fields[4]);
    if (memKb !== undefined) {
      record.memKb = memKb;
    }
    records.push(record);
    if (records.length >= AOI_MAX_HOST_PROCESS_RECORDS) {
      break;
    }
  }
  return records;
}

// Parse `ps -eo pid=,comm=` output (POSIX fallback / tests). Each line is
// "  <pid> <command>". Only pid + image name are taken (metadata-only).
export function parsePosixPsOutput(stdout: string): AoiHostProcessRecord[] {
  const records: AoiHostProcessRecord[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const match = line.match(/^(\d+)\s+(.+)$/);
    if (!match) {
      continue;
    }
    const pid = Number.parseInt(match[1], 10);
    // Keep only the final path segment as the image name (drop any leading path
    // so nothing resembling a working directory is retained).
    const imageName = normalizeImageName((match[2].split(/[\\/]/).pop() ?? match[2]).trim());
    if (!imageName || !Number.isFinite(pid) || pid <= 0) {
      continue;
    }
    records.push({ pid, imageName });
    if (records.length >= AOI_MAX_HOST_PROCESS_RECORDS) {
      break;
    }
  }
  return records;
}

export function summarizeHostProcesses(
  records: readonly AoiHostProcessRecord[],
  now: number,
  maxTopImages = 20,
): AoiHostProcessSummary {
  const counts = new Map<string, number>();
  for (const record of records) {
    counts.set(record.imageName, (counts.get(record.imageName) ?? 0) + 1);
  }
  const topImages = [...counts.entries()]
    .map(([imageName, count]) => ({ imageName, count }))
    .sort(
      (left, right) => right.count - left.count || left.imageName.localeCompare(right.imageName),
    )
    .slice(0, Math.max(1, maxTopImages));
  return {
    version: 1,
    sampledAt: now,
    totalCount: records.length,
    topImages,
    distinctImageCount: counts.size,
  };
}

export interface ListHostProcessesOptions {
  platform?: NodeJS.Platform;
  now?: number;
  spawnImpl?: typeof spawn;
}

// Effectful: spawn the platform's read-only process-listing command with a
// FIXED argument vector (shell:false) and parse it. Never runs a shell, never
// takes caller-supplied arguments, so it cannot be turned into an exec channel.
// Resolves to a listing; rejects on spawn error / timeout / non-zero exit.
export function listHostProcesses(
  options: ListHostProcessesOptions = {},
): Promise<AoiHostProcessListing> {
  const platform = options.platform ?? process.platform;
  const now = options.now ?? Date.now();
  const spawnImpl = options.spawnImpl ?? spawn;
  const isWindows = platform === 'win32';
  const program = isWindows ? 'tasklist' : 'ps';
  const args = isWindows ? ['/FO', 'CSV', '/NH'] : ['-eo', 'pid=,comm='];

  return new Promise((resolveListing, rejectListing) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let bytes = 0;
    const child = spawnImpl(program, args, { shell: false, windowsHide: true });

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill();
      rejectListing(new Error(`process listing timed out after ${LIST_TIMEOUT_MS}ms`));
    }, LIST_TIMEOUT_MS);

    child.stdout?.on('data', (chunk: Buffer | string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_OUTPUT_BYTES) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          child.kill();
          rejectListing(new Error('process listing output exceeded the byte cap'));
        }
        return;
      }
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString().slice(0, 2000);
    });
    child.on('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      rejectListing(error instanceof Error ? error : new Error(String(error)));
    });
    child.on('close', (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        rejectListing(new Error(`process listing exited with code ${code}: ${stderr.trim()}`));
        return;
      }
      const records = isWindows ? parseWindowsTasklistCsv(stdout) : parsePosixPsOutput(stdout);
      resolveListing({
        version: 1,
        sampledAt: now,
        records,
        summary: summarizeHostProcesses(records, now),
      });
    });
  });
}
