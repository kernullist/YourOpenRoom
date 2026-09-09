// Recovered strings: the ones that are not in the binary as text.
//
// A static string list is the easy half. The half that matters on anything
// obfuscated is the strings that only exist at run time -- assembled on the
// stack a byte at a time, or produced by a decoder inside the binary. FLOSS
// (Mandiant) recovers both by emulating the code that builds them, and it is the
// state of the art for this; reimplementing it would be a research project.
//
// Integration shape is deliberately the same as capa's: an operator-configured
// executable, an injectable spawn so the whole decision tree is testable with
// nothing installed, and a stage that is SKIPPED rather than failed when the
// tool is absent. A missing optional tool is a smaller report, not a broken run.
//
// Parsing is defensive on purpose. FLOSS's JSON has changed shape across
// versions (`strings.decoded_strings` vs a flat list, `string` vs `value`,
// addresses as ints vs hex text), so this accepts the shapes rather than pinning
// one and breaking on the operator's build.
import { spawn } from 'child_process';

import { buildGhidraChildEnv } from './ghidraLabConfig';
import type { GhidraLabConfigView } from './ghidraLabTypes';

/** How long FLOSS may run. It emulates, so it is slower than a string dump. */
const FLOSS_TIMEOUT_MS = 10 * 60 * 1000;
const FLOSS_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
/** Past this a "string" is a blob, and listing it teaches nothing. */
const MAX_DECODED_VALUE_CHARS = 300;
/** The report cannot carry thousands; these are the ones worth a citation. */
export const MAX_DECODED_STRINGS = 400;

/**
 * Where a recovered string came from.
 *
 * The kind is not cosmetic: a `stack` string means the author went out of their
 * way to keep it out of the string table, and a `decoded` string means there is
 * a decoder function in the binary worth reading. Both are findings on their own.
 */
export type GhidraDecodedStringKind = 'static' | 'stack' | 'tight' | 'decoded' | 'language';

export interface GhidraDecodedString {
  value: string;
  kind: GhidraDecodedStringKind;
  /** Where the string ends up, when FLOSS knows. Hex, or ''. */
  address: string;
  /** The routine that produced it. The reason this is worth an anchor. */
  decodingRoutine: string;
  /** Encoding for static strings ('ASCII' / 'UTF-16LE'), else ''. */
  encoding: string;
}

export interface GhidraFlossOutcome {
  ok: boolean;
  payload: unknown;
  error: string;
}

export type SpawnFloss = typeof spawn;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** An address in whatever form this FLOSS build emitted, as hex text. */
function asAddress(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `0x${Math.trunc(value).toString(16)}`;
  }
  if (typeof value === 'string' && value.trim()) {
    const trimmed = value.trim();
    if (/^0x[0-9a-f]+$/i.test(trimmed)) {
      return trimmed.toLowerCase();
    }
    if (/^[0-9]+$/.test(trimmed)) {
      return `0x${Number.parseInt(trimmed, 10).toString(16)}`;
    }
    return trimmed;
  }
  return '';
}

function pick(record: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

function pickAddress(record: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) {
      const address = asAddress(record[key]);
      if (address) {
        return address;
      }
    }
  }
  return '';
}

/** One row of a FLOSS string list, whatever the list was called. */
function toDecodedString(row: unknown, kind: GhidraDecodedStringKind): GhidraDecodedString | null {
  if (typeof row === 'string') {
    const value = row.trim();
    return value ? { value, kind, address: '', decodingRoutine: '', encoding: '' } : null;
  }
  const record = asRecord(row);
  if (!record) {
    return null;
  }
  const value = pick(record, ['string', 'value', 'text', 'decoded_string']);
  if (!value) {
    return null;
  }
  return {
    value: value.slice(0, MAX_DECODED_VALUE_CHARS),
    kind,
    // `address` is where it lands; `offset` is a file offset; `program_counter`
    // is where a stack string was assembled. Any of the three locates it.
    address: pickAddress(record, ['address', 'offset', 'program_counter', 'decoded_at']),
    decodingRoutine: pickAddress(record, ['decoding_routine', 'function', 'decoded_at']),
    encoding: pick(record, ['encoding']),
  };
}

const LIST_KINDS: readonly { keys: readonly string[]; kind: GhidraDecodedStringKind }[] = [
  { keys: ['decoded_strings', 'decoded'], kind: 'decoded' },
  { keys: ['stack_strings', 'stackstrings'], kind: 'stack' },
  { keys: ['tight_strings', 'tightstrings'], kind: 'tight' },
  { keys: ['static_strings', 'static'], kind: 'static' },
  { keys: ['language_strings', 'language'], kind: 'language' },
];

/**
 * Read whatever this FLOSS build produced into one list.
 *
 * Deduplicated by (value, routine): the same plaintext decoded by two different
 * routines is two findings -- a binary with two decoders is a different thing
 * from a binary with one -- but the same string reported twice by the same
 * routine is one.
 */
export function parseFlossResult(payload: unknown): GhidraDecodedString[] {
  const root = asRecord(payload);
  if (!root) {
    return [];
  }
  // Newer builds nest under `strings`; older ones put the lists at the top.
  const container = asRecord(root.strings) ?? root;
  const found: GhidraDecodedString[] = [];
  const seen = new Set<string>();
  for (const { keys, kind } of LIST_KINDS) {
    for (const key of keys) {
      const rows = container[key];
      if (!Array.isArray(rows)) {
        continue;
      }
      for (const row of rows) {
        const entry = toDecodedString(row, kind);
        if (!entry) {
          continue;
        }
        const identity = `${entry.kind}|${entry.decodingRoutine}|${entry.value}`;
        if (seen.has(identity)) {
          continue;
        }
        seen.add(identity);
        found.push(entry);
      }
      break;
    }
  }
  return found;
}

/**
 * The strings worth spending report space and anchors on.
 *
 * Static strings are dropped here: the sweep already has its own string stage
 * for those, and re-listing them would bury the ones that were hidden. Ordering
 * is by how much work was done to hide the string -- decoded first, because a
 * decoder routine is itself a lead.
 */
/**
 * Worth keeping: not a plain static string, and not a single character.
 *
 * FLOSS's static strings are the same ones the normal string table already
 * holds, so they are dropped here rather than counted twice.
 */
function isInterestingDecoded(entry: GhidraDecodedString): boolean {
  return entry.kind !== 'static' && entry.value.trim().length > 1;
}

/**
 * How many recovered strings are worth keeping, BEFORE any limit.
 *
 * The number a report should print. Counting the kept list instead made the
 * limit the largest number of hidden strings any binary could be said to have.
 */
export function countInterestingDecoded(strings: readonly GhidraDecodedString[]): number {
  return strings.filter(isInterestingDecoded).length;
}

export function selectInterestingDecoded(
  strings: readonly GhidraDecodedString[],
  limit: number = MAX_DECODED_STRINGS,
): GhidraDecodedString[] {
  const rank: Record<GhidraDecodedStringKind, number> = {
    decoded: 0,
    tight: 1,
    stack: 2,
    language: 3,
    static: 4,
  };
  return strings
    .filter(isInterestingDecoded)
    .sort(
      (left, right) => rank[left.kind] - rank[right.kind] || left.value.localeCompare(right.value),
    )
    .slice(0, Math.max(0, limit));
}

/** How many of each kind came back. Reported so a zero is legible. */
export function countByKind(
  strings: readonly GhidraDecodedString[],
): Record<GhidraDecodedStringKind, number> {
  const counts: Record<GhidraDecodedStringKind, number> = {
    static: 0,
    stack: 0,
    tight: 0,
    decoded: 0,
    language: 0,
  };
  for (const entry of strings) {
    counts[entry.kind] += 1;
  }
  return counts;
}

/**
 * Run FLOSS over a binary and hand back its JSON document.
 *
 * Asynchronous for the same reason capa is: this executes inside the dev
 * server's Node process, FLOSS emulates and can run for minutes, and a
 * synchronous spawn there freezes every other request for the whole run.
 *
 * The argument vector is exact, and both halves of it were wrong at first:
 *
 *   * The JSON switch is `-j`. `--json` is not a FLOSS flag at all -- it exits
 *     with a usage message, which the stage then reported as "did not produce a
 *     result". Measured on 3.1.1.
 *   * `--no` takes one or more choices, so argparse swallows a following
 *     positional into it: `--no static <sample>` fails with "invalid choice:
 *     <path>". `--` ends the option list and makes the sample unambiguous.
 *
 * `--no static` itself is deliberate: the sweep already has a static string
 * stage, and asking FLOSS for them again doubles a run that takes minutes to
 * produce a list we would throw away.
 */
export function runFloss(
  params: { binaryPath: string; config: GhidraLabConfigView },
  spawnFloss: SpawnFloss = spawn,
): Promise<GhidraFlossOutcome> {
  const exe = params.config.flossExePath;
  if (!exe) {
    return Promise.resolve({ ok: false, payload: null, error: 'floss_not_configured' });
  }
  return new Promise<GhidraFlossOutcome>((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (outcome: GhidraFlossOutcome): void => {
      if (!settled) {
        settled = true;
        resolve(outcome);
      }
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawnFloss(exe, ['-j', '--no', 'static', '--', params.binaryPath], {
        env: buildGhidraChildEnv(params.config),
        windowsHide: true,
        shell: false,
      });
    } catch (error) {
      finish({
        ok: false,
        payload: null,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // Already gone.
      }
      finish({ ok: false, payload: null, error: `floss timed out after ${FLOSS_TIMEOUT_MS}ms` });
    }, FLOSS_TIMEOUT_MS);

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (stdout.length < FLOSS_MAX_OUTPUT_BYTES) {
        stdout += chunk;
      }
    });
    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length < 64 * 1024) {
        stderr += chunk;
      }
    });
    child.on('error', (error: Error) => {
      clearTimeout(timer);
      finish({ ok: false, payload: null, error: error.message });
    });
    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      const start = stdout.indexOf('{');
      if (start < 0) {
        finish({
          ok: false,
          payload: null,
          // FLOSS writes its progress bar to stderr, so the tail is the part
          // that says why -- the head is a banner.
          error: stderr.trim().slice(-500) || `floss exited ${code} with no JSON`,
        });
        return;
      }
      try {
        finish({ ok: true, payload: JSON.parse(stdout.slice(start)), error: '' });
      } catch (error) {
        finish({
          ok: false,
          payload: null,
          error: `floss output was not JSON: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    });
  });
}
