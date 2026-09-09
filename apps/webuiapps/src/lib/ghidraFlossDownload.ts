// Fetch FLOSS from its official release, on the operator's click.
//
// This installs software, so it sits exactly where `bootstrap-python` sits: an
// operator button in the Setup panel, behind the same approval, and NEVER in
// Aoi's tool list. The model can ask for an analysis; it cannot put a new
// executable on the machine.
//
// Three things are pinned rather than parameterised, because every one of them
// is a place where a caller-supplied value would turn this into a downloader for
// arbitrary code:
//
//   * the repository (mandiant/flare-floss),
//   * the hosts a download may come from,
//   * the destination directory.
//
// Nothing about the request is taken from the caller at all. The only input is
// which OPENROOM_HOME to install into.
import { spawn } from 'child_process';
import * as fs from 'fs';
import { join } from 'path';

/** The only repository this will ever fetch from. */
const FLOSS_RELEASE_API = 'https://api.github.com/repos/mandiant/flare-floss/releases/latest';

/**
 * Where a release asset may be served from.
 *
 * GitHub redirects release downloads to its object store, so both hosts are
 * needed -- and an asset URL pointing anywhere else means the API answer was not
 * what we think it is, which is a reason to stop rather than to follow it.
 */
const ALLOWED_DOWNLOAD_HOSTS: readonly string[] = [
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
];

/** A release zip is ~32MB. This is a stop, not a target. */
const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const EXTRACT_TIMEOUT_MS = 5 * 60 * 1000;

export interface GhidraFlossInstallResult {
  ok: boolean;
  /** Absolute path to the installed executable, when it worked. */
  flossExePath: string;
  detail: string;
}

export interface GhidraFlossInstallDeps {
  /** Injected so the whole decision tree is testable without a network. */
  fetchJson?(url: string): Promise<unknown>;
  fetchBinary?(url: string): Promise<Uint8Array>;
  /** Unpack `archive` into `dir`. Returns '' on success, else the failure. */
  extract?(archive: string, dir: string): Promise<string>;
  mkdir?(dir: string): void;
  writeFile?(path: string, bytes: Uint8Array): void;
  /** Every file under `dir`, recursively, as absolute paths. */
  listFilesDeep?(dir: string): string[];
  removeFile?(path: string): void;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The Windows release asset, by name.
 *
 * Matched on the platform word rather than on position: the asset order in the
 * API answer is not a contract, and picking `assets[0]` would silently install
 * the Linux build.
 */
export function pickFlossAsset(
  payload: unknown,
  platform: string = process.platform,
): { name: string; url: string; tag: string } | null {
  const release = asRecord(payload);
  if (!release || !Array.isArray(release.assets)) {
    return null;
  }
  const wanted =
    platform === 'win32' ? /windows/i : platform === 'darwin' ? /mac(os)?|darwin/i : /linux/i;
  const tag = typeof release.tag_name === 'string' ? release.tag_name : '';
  for (const raw of release.assets) {
    const asset = asRecord(raw);
    if (!asset) {
      continue;
    }
    const name = typeof asset.name === 'string' ? asset.name : '';
    const url = typeof asset.browser_download_url === 'string' ? asset.browser_download_url : '';
    if (!name || !url || !wanted.test(name) || !/\.zip$/i.test(name)) {
      continue;
    }
    return { name, url, tag };
  }
  return null;
}

/** Refuse an asset URL that does not come from where GitHub serves them. */
export function isAllowedDownloadUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && ALLOWED_DOWNLOAD_HOSTS.includes(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * The executable inside an extracted release.
 *
 * The archive layout has changed across releases (bare, then under a versioned
 * folder), so this searches rather than assuming a path.
 */
export function findFlossExecutable(files: readonly string[], platform = process.platform): string {
  const wanted = platform === 'win32' ? 'floss.exe' : 'floss';
  const matches = files.filter((path) => {
    const base = path.split(/[\\/]/).pop()?.toLowerCase() ?? '';
    return base === wanted;
  });
  // Shallowest wins: a nested copy is usually a bundled dependency.
  return (
    matches.sort((left, right) => left.split(/[\\/]/).length - right.split(/[\\/]/).length)[0] ?? ''
  );
}

async function nodeFetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'openroom-ghidra-lab' },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    throw new Error(`GitHub answered HTTP ${response.status}`);
  }
  return response.json();
}

async function nodeFetchBinary(url: string): Promise<Uint8Array> {
  const response = await fetch(url, {
    headers: { 'user-agent': 'openroom-ghidra-lab' },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`download answered HTTP ${response.status}`);
  }
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) {
    throw new Error(`refusing a ${declared}-byte download; the cap is ${MAX_DOWNLOAD_BYTES}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_DOWNLOAD_BYTES) {
    throw new Error(`download was ${bytes.byteLength} bytes, over the ${MAX_DOWNLOAD_BYTES} cap`);
  }
  return bytes;
}

/**
 * Unpack with `tar`, which ships with Windows 10+, macOS and Linux and reads zip.
 *
 * A separate process rather than a library so no new dependency enters the tree
 * for a button most operators will press once, and `shell:false` so the archive
 * path cannot be read as anything but a path.
 */
function nodeExtract(archive: string, dir: string): Promise<string> {
  return new Promise<string>((resolve) => {
    let stderr = '';
    let settled = false;
    const finish = (result: string): void => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('tar', ['-xf', archive, '-C', dir], { windowsHide: true, shell: false });
    } catch (error) {
      finish(error instanceof Error ? error.message : String(error));
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // Already gone.
      }
      finish(`extract timed out after ${EXTRACT_TIMEOUT_MS}ms`);
    }, EXTRACT_TIMEOUT_MS);
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length < 16 * 1024) {
        stderr += chunk;
      }
    });
    child.on('error', (error: Error) => {
      clearTimeout(timer);
      finish(error.message);
    });
    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      finish(code === 0 ? '' : stderr.trim().slice(0, 400) || `tar exited ${code}`);
    });
  });
}

function nodeListFilesDeep(dir: string, depth = 0): string[] {
  if (depth > 6) {
    return [];
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...nodeListFilesDeep(full, depth + 1));
    } else if (entry.isFile()) {
      found.push(full);
    }
  }
  return found;
}

/** Where the lab keeps tools it installed itself. */
export function flossToolsDir(openroomHome: string): string {
  return join(openroomHome, 'ghidra-lab', 'tools');
}

/**
 * Download and unpack the latest official FLOSS release.
 *
 * Every failure returns a reason rather than throwing: this runs behind a button
 * and the operator needs to know whether the network refused, the archive was
 * wrong, or the executable simply was not in it.
 */
export async function installFloss(
  openroomHome: string,
  deps: GhidraFlossInstallDeps = {},
): Promise<GhidraFlossInstallResult> {
  const fetchJson = deps.fetchJson ?? nodeFetchJson;
  const fetchBinary = deps.fetchBinary ?? nodeFetchBinary;
  const extract = deps.extract ?? nodeExtract;
  const mkdir = deps.mkdir ?? ((dir: string) => fs.mkdirSync(dir, { recursive: true }));
  const writeFile =
    deps.writeFile ?? ((path: string, bytes: Uint8Array) => fs.writeFileSync(path, bytes));
  const listFilesDeep = deps.listFilesDeep ?? ((dir: string) => nodeListFilesDeep(dir));
  const removeFile =
    deps.removeFile ??
    ((path: string) => {
      try {
        fs.rmSync(path, { force: true });
      } catch {
        // The archive is scratch; failing to remove it is not a failure.
      }
    });

  const dir = flossToolsDir(openroomHome);
  let release: unknown;
  try {
    release = await fetchJson(FLOSS_RELEASE_API);
  } catch (error) {
    return {
      ok: false,
      flossExePath: '',
      detail: `Could not reach the FLOSS release list: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const asset = pickFlossAsset(release);
  if (!asset) {
    return {
      ok: false,
      flossExePath: '',
      detail: 'The latest FLOSS release has no archive for this platform.',
    };
  }
  if (!isAllowedDownloadUrl(asset.url)) {
    // The API said something we do not recognise. Stop rather than follow it.
    return {
      ok: false,
      flossExePath: '',
      detail: `Refusing to download ${asset.name}: its URL is not a GitHub release host.`,
    };
  }

  let bytes: Uint8Array;
  try {
    bytes = await fetchBinary(asset.url);
  } catch (error) {
    return {
      ok: false,
      flossExePath: '',
      detail: `Download failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const archive = join(dir, asset.name);
  try {
    mkdir(dir);
    writeFile(archive, bytes);
  } catch (error) {
    return {
      ok: false,
      flossExePath: '',
      detail: `Could not write into ${dir}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const problem = await extract(archive, dir);
  removeFile(archive);
  if (problem) {
    return { ok: false, flossExePath: '', detail: `Could not unpack ${asset.name}: ${problem}` };
  }

  const exe = findFlossExecutable(listFilesDeep(dir));
  if (!exe) {
    return {
      ok: false,
      flossExePath: '',
      detail: `${asset.name} unpacked but contained no FLOSS executable.`,
    };
  }
  return {
    ok: true,
    flossExePath: exe,
    detail: `Installed FLOSS ${asset.tag || ''} to ${exe}`.trim(),
  };
}
