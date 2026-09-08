// @vitest-environment node
//
// The mount: URL parsing, body reading, loopback token filling, and the JSON
// envelope. Small surface, but it is the only thing between the browser and every
// route -- and it is where the "the browser never holds the secret" property
// actually lives.
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureAoiHostBridgeToken, loadAoiHostBridgeToken } from '../aoiHostBridgeAuth';
import {
  saveAoiHostBridgeKillSwitchState,
  setAoiHostBridgeCapability,
} from '../aoiHostBridgeKillSwitch';
import { normalizeGhidraLabConfig } from '../ghidraLabConfig';
import {
  bootstrapPyghidraVenv,
  createGhidraLabMiddleware,
  findGhidraBinariesUnder,
  getGhidraLabRoute,
  ghidraLabPlugin,
  listGhidraDirectory,
  loadGhidraLabConfig,
  saveGhidraLabConfig,
} from '../ghidraLabPlugin';

let home = '';
let configFile = '';
let token = '';

interface FakeResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  writeHead(status: number, headers: Record<string, string>): void;
  end(chunk: string): void;
}

function makeResponse(): FakeResponse {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(chunk) {
      this.body = chunk;
    },
  };
}

interface CallOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  remoteAddress?: string;
  /** Raw request text, for bodies that are not valid JSON objects. */
  rawBody?: string;
}

/** Emitted in pieces, so the size guard sees a stream rather than one buffer. */
const CHUNK = 64 * 1024;

async function call(url: string, options: CallOptions = {}): Promise<FakeResponse> {
  const middleware = createGhidraLabMiddleware({
    sessionsDir: join(home, 'sessions'),
    openroomHome: home,
    configFile,
    trustLoopbackToken: true,
  });
  const req = new EventEmitter() as EventEmitter & Record<string, unknown>;
  req.url = url;
  req.method = options.method ?? 'GET';
  req.headers = options.headers ?? {};
  req.socket = { remoteAddress: options.remoteAddress ?? '127.0.0.1' };
  req.destroy = () => {};
  const res = makeResponse();

  let nextCalled = false;
  const done = new Promise<void>((resolve) => {
    const originalEnd = res.end.bind(res);
    res.end = (chunk: string) => {
      originalEnd(chunk);
      resolve();
    };
    middleware(req as never, res as never, () => {
      nextCalled = true;
      resolve();
    });
  });

  if (options.method && options.method !== 'GET' && options.method !== 'DELETE') {
    setImmediate(() => {
      const raw = options.rawBody ?? JSON.stringify(options.body ?? {});
      for (let offset = 0; offset < raw.length; offset += CHUNK) {
        req.emit('data', Buffer.from(raw.slice(offset, offset + CHUNK)));
      }
      if (!raw) {
        req.emit('data', Buffer.from(''));
      }
      req.emit('end');
    });
  }
  await done;
  (res as FakeResponse & { nextCalled?: boolean }).nextCalled = nextCalled;
  return res;
}

beforeEach(() => {
  home = fs.mkdtempSync(join(os.tmpdir(), 'ghidra-mw-'));
  configFile = join(home, 'config.json');
  ensureAoiHostBridgeToken(home);
  token = loadAoiHostBridgeToken(home) ?? '';
  saveAoiHostBridgeKillSwitchState(
    home,
    setAoiHostBridgeCapability(null, 'os_ghidra_analysis', true, Date.now()),
  );
});

afterEach(() => {
  try {
    fs.rmSync(home, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

describe('route matching', () => {
  it('claims only its own prefix', () => {
    expect(getGhidraLabRoute('/api/ghidra-lab/health')).toBe('/health');
    expect(getGhidraLabRoute('/api/ghidra-labs/health')).toBeNull();
    expect(getGhidraLabRoute('/')).toBeNull();
  });

  it('passes an unrelated URL to the next middleware', async () => {
    const res = await call('/api/something-else');
    expect((res as FakeResponse & { nextCalled?: boolean }).nextCalled).toBe(true);
    expect(res.body).toBe('');
  });
});

describe('loopback token', () => {
  it('fills the token in for a loopback caller so the browser never holds it', async () => {
    const res = await call('/api/ghidra-lab/health');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(true);
  });

  it('refuses a non-loopback caller that brought no token', async () => {
    const res = await call('/api/ghidra-lab/health', { remoteAddress: '10.0.0.5' });
    expect(res.statusCode).toBe(401);
  });

  it('accepts an explicit header token from anywhere', async () => {
    const res = await call('/api/ghidra-lab/health', {
      remoteAddress: '10.0.0.5',
      headers: { 'x-aoi-host-bridge-token': token },
    });
    expect(res.statusCode).toBe(200);
  });

  it('treats IPv6 loopback forms as loopback', async () => {
    for (const address of ['::1', '::ffff:127.0.0.1']) {
      expect((await call('/api/ghidra-lab/health', { remoteAddress: address })).statusCode).toBe(
        200,
      );
    }
  });
});

describe('bodies and responses', () => {
  it('reads a JSON POST body', async () => {
    const res = await call('/api/ghidra-lab/config', {
      method: 'POST',
      body: { config: { maxMemMb: 2048 } },
    });
    expect(res.statusCode).toBe(200);
    expect(loadGhidraLabConfig(configFile).maxMemMb).toBe(2048);
  });

  it('treats an unparseable body as empty rather than 500ing', async () => {
    const middleware = createGhidraLabMiddleware({
      sessionsDir: join(home, 'sessions'),
      openroomHome: home,
      configFile,
      trustLoopbackToken: true,
    });
    const req = new EventEmitter() as EventEmitter & Record<string, unknown>;
    req.url = '/api/ghidra-lab/config';
    req.method = 'POST';
    req.headers = {};
    req.socket = { remoteAddress: '127.0.0.1' };
    req.destroy = () => {};
    const res = makeResponse();
    const done = new Promise<void>((resolve) => {
      const end = res.end.bind(res);
      res.end = (chunk: string) => {
        end(chunk);
        resolve();
      };
      middleware(req as never, res as never, () => resolve());
    });
    setImmediate(() => {
      req.emit('data', Buffer.from('{not json'));
      req.emit('end');
    });
    await done;
    expect(res.statusCode).toBe(200);
  });

  it('parses GET parameters out of the query string', async () => {
    saveGhidraLabConfig(
      configFile,
      normalizeGhidraLabConfig({
        binaryRoots: [{ id: 'r', path: home, label: 'Home' }],
      }),
    );
    const res = await call(`/api/ghidra-lab/browse?path=${encodeURIComponent(home)}`);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).browse.path).toBeTruthy();
  });

  it('answers with a no-store JSON envelope', async () => {
    const res = await call('/api/ghidra-lab/sessions');
    expect(res.headers['Content-Type']).toContain('application/json');
    expect(res.headers['Cache-Control']).toBe('no-store');
  });

  it('404s an unknown route under its own prefix', async () => {
    const res = await call('/api/ghidra-lab/nope');
    expect(res.statusCode).toBe(404);
  });
});

describe('plugin factory', () => {
  it('registers a named vite plugin that installs the middleware', () => {
    const plugin = ghidraLabPlugin({
      sessionsDir: join(home, 'sessions'),
      openroomHome: home,
      configFile,
    });
    expect(plugin.name).toBe('ghidra-lab');
    let installed = 0;
    const closeHandlers: string[] = [];
    (plugin.configureServer as (server: unknown) => void)({
      middlewares: { use: () => (installed += 1) },
      httpServer: { once: (event: string) => closeHandlers.push(event) },
    });
    expect(installed).toBe(1);
    // A Ghidra JVM never exits on its own, so the server going away has to
    // reclaim it -- otherwise every HMR restart leaks one holding a port.
    expect(closeHandlers).toContain('close');
  });
});

describe('filesystem helpers', () => {
  it('lists a directory with folders first and marks analyzable files', () => {
    const dir = join(home, 'listing');
    fs.mkdirSync(join(dir, 'sub'), { recursive: true });
    fs.writeFileSync(join(dir, 'client.exe'), 'MZ');
    fs.writeFileSync(join(dir, 'notes.txt'), 'x');
    const listing = listGhidraDirectory(dir);
    expect(listing.entries[0].kind).toBe('directory');
    expect(listing.entries.find((entry) => entry.name === 'client.exe')?.analyzable).toBe(true);
    expect(listing.entries.find((entry) => entry.name === 'notes.txt')?.analyzable).toBe(false);
  });

  it('reports truncation when a directory is larger than the cap', () => {
    const dir = join(home, 'big');
    fs.mkdirSync(dir, { recursive: true });
    for (let index = 0; index < 12; index += 1) {
      fs.writeFileSync(join(dir, `f${index}.bin`), 'x');
    }
    const listing = listGhidraDirectory(dir, 5);
    expect(listing.entries).toHaveLength(5);
    expect(listing.truncated).toBe(true);
  });

  it('returns empty for a directory it cannot read', () => {
    expect(listGhidraDirectory(join(home, 'missing')).entries).toEqual([]);
  });

  it('finds matching binaries recursively, up to the depth limit', () => {
    const dir = join(home, 'tree', 'a', 'b');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(home, 'tree', 'client.exe'), 'MZ');
    fs.writeFileSync(join(dir, 'deep_client.dll'), 'MZ');
    fs.writeFileSync(join(home, 'tree', 'client.txt'), 'no');

    const shallow = findGhidraBinariesUnder([join(home, 'tree')], 'client', 0);
    expect(shallow.entries.map((entry) => entry.name)).toEqual(['client.exe']);

    const deep = findGhidraBinariesUnder([join(home, 'tree')], 'client', 3);
    expect(deep.entries.map((entry) => entry.name).sort()).toEqual([
      'client.exe',
      'deep_client.dll',
    ]);
  });

  it('skips directories it cannot read instead of failing the search', () => {
    const found = findGhidraBinariesUnder([join(home, 'does-not-exist')], 'x', 2);
    expect(found.entries).toEqual([]);
  });
});

describe('bootstrapPyghidraVenv', () => {
  it('refuses without a usable interpreter', async () => {
    const result = await bootstrapPyghidraVenv({
      config: normalizeGhidraLabConfig({}),
      openroomHome: home,
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('Python');
  });

  it('reports a venv creation failure instead of throwing', async () => {
    // node is a real executable but has no `-m venv`, so this exercises the
    // failure path without depending on the machine having Python.
    const result = await bootstrapPyghidraVenv({
      config: normalizeGhidraLabConfig({ pythonExePath: process.execPath }),
      openroomHome: home,
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toBeTruthy();
  });

  it('leaves the event loop free while it installs', async () => {
    // A pip install is minutes long. Done synchronously it froze the whole dev
    // server -- observed on the first real bootstrap.
    let ticked = false;
    setTimeout(() => {
      ticked = true;
    }, 0);
    const pending = bootstrapPyghidraVenv({
      config: normalizeGhidraLabConfig({ pythonExePath: process.execPath }),
      openroomHome: home,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(ticked).toBe(true);
    await pending;
  });
});

describe('body guards', () => {
  /** What the config route would have written, had the body reached it. */
  const smuggled = `"config":{"maxMemMb":2048}`;

  /** The lab's slice of the shared config file, as persisted. */
  function storedMaxMem(): unknown {
    if (!fs.existsSync(configFile)) {
      return undefined;
    }
    const file = JSON.parse(fs.readFileSync(configFile, 'utf-8')) as Record<string, unknown>;
    return (file.ghidraLab as Record<string, unknown> | undefined)?.maxMemMb;
  }

  it('drops a body larger than the cap rather than buffering and applying it', async () => {
    // The dev server holds the body in memory, so an unbounded one is a way to
    // kill it. The guard has to stop reading AND the request must not take
    // effect -- a partially read body that still gets applied is worse than a
    // rejection, because the operator sees a 200 and a changed config.
    const res = await call('/api/ghidra-lab/config', {
      method: 'POST',
      rawBody: `{${smuggled},"pad":"${'x'.repeat(3 * 1024 * 1024)}"}`,
      headers: { 'x-aoi-host-token': token },
    });
    expect(res.statusCode).toBe(200);
    expect(storedMaxMem() ?? 0).not.toBe(2048);
  });

  it('drops a JSON body that is not an object', async () => {
    // Routes read named fields off the body; an array has none, so treating it
    // as an empty body is right -- but it must not be treated as a patch.
    const res = await call('/api/ghidra-lab/config', {
      method: 'POST',
      rawBody: '[{"maxMemMb":2048}]',
      headers: { 'x-aoi-host-token': token },
    });
    expect(res.statusCode).toBe(200);
    expect(storedMaxMem() ?? 0).not.toBe(2048);
  });

  it('applies a well-formed patch, so the guards above are not just refusing everything', async () => {
    const res = await call('/api/ghidra-lab/config', {
      method: 'POST',
      rawBody: `{${smuggled}}`,
      headers: { 'x-aoi-host-token': token },
    });
    expect(res.statusCode).toBe(200);
    expect(storedMaxMem()).toBe(2048);
  });
});
