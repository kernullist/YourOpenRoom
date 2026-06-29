// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import { createServer, type Server } from 'http';
import { join } from 'path';
import { createSessionDataMiddleware } from '../sessionDataServer';

const tempRoots: string[] = [];
const servers: Server[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'aoi-session-data-'));
  tempRoots.push(dir);
  return dir;
}

// Boot a tiny http server wrapping the middleware with a 404 fallback, so the
// real request/response I/O path (POST body streaming, binary writes) is
// exercised rather than a hand-mocked req/res.
async function bootServer(sessionsDir: string): Promise<string> {
  const middleware = createSessionDataMiddleware({ sessionsDir });
  const server = createServer((req, res) => {
    middleware(req, res, () => {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found', code: 'route_not_found' }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolveListen) => {
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const address = server.address();
  const port = address && typeof address === 'object' ? address.port : 0;
  return `http://127.0.0.1:${port}`;
}

function dataUrl(base: string, path: string, action?: string): string {
  const suffix = action ? `&action=${action}` : '';
  return `${base}/api/session-data?path=${encodeURIComponent(path)}${suffix}`;
}

async function postJson(base: string, path: string, value: unknown): Promise<Response> {
  return fetch(dataUrl(base, path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  });
}

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (server) {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  }
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('createSessionDataMiddleware', () => {
  it('round-trips a POST write and GET read under the sessions dir', async () => {
    const dir = makeTempDir();
    const base = await bootServer(dir);
    const rel = 'aoi/memory-v2/memories/m1.json';
    const body = { id: 'm1', content: 'hi' };

    const post = await postJson(base, rel, body);
    expect(post.status).toBe(200);
    expect(((await post.json()) as { ok?: boolean }).ok).toBe(true);
    // Written to disk under the sessions root.
    expect(fs.existsSync(join(dir, rel))).toBe(true);

    const get = await fetch(dataUrl(base, rel));
    expect(get.status).toBe(200);
    expect(await get.json()).toEqual(body);
  });

  it('returns {} for a missing file', async () => {
    const dir = makeTempDir();
    const base = await bootServer(dir);
    const get = await fetch(dataUrl(base, 'aoi/memory-v2/memories/none.json'));
    expect(get.status).toBe(200);
    expect(await get.json()).toEqual({});
  });

  it('lists files and dirs with action=list', async () => {
    const dir = makeTempDir();
    const base = await bootServer(dir);
    await postJson(base, 'aoi/mem/a.json', {});
    await postJson(base, 'aoi/mem/sub/b.json', {});

    const list = await fetch(dataUrl(base, 'aoi/mem', 'list'));
    expect(list.status).toBe(200);
    const data = (await list.json()) as { files: Array<{ path: string; type: number }> };
    const file = data.files.find((f) => f.path === 'aoi/mem/a.json');
    const subdir = data.files.find((f) => f.path === 'aoi/mem/sub');
    expect(file?.type).toBe(0);
    expect(subdir?.type).toBe(1);
  });

  it('deletes a file', async () => {
    const dir = makeTempDir();
    const base = await bootServer(dir);
    const rel = 'aoi/mem/del.json';
    await postJson(base, rel, {});
    expect(fs.existsSync(join(dir, rel))).toBe(true);

    const del = await fetch(dataUrl(base, rel), { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect(fs.existsSync(join(dir, rel))).toBe(false);
  });

  it('resets a session directory recursively via /api/session-reset', async () => {
    const dir = makeTempDir();
    const base = await bootServer(dir);
    await postJson(base, 'aoi/mod/chat/history.json', {});
    const sessionDir = join(dir, 'aoi', 'mod');
    expect(fs.existsSync(sessionDir)).toBe(true);

    const reset = await fetch(`${base}/api/session-reset?path=${encodeURIComponent('aoi/mod')}`, {
      method: 'DELETE',
    });
    expect(reset.status).toBe(200);
    expect(fs.existsSync(sessionDir)).toBe(false);
  });

  it('confines a traversal path to the sessions root', async () => {
    const dir = makeTempDir();
    const base = await bootServer(dir);
    // '..' segments are stripped by the sanitizer: this must NOT escape `dir`.
    const post = await postJson(base, '../escape.json', {});
    expect(post.status).toBe(200);
    // The parent of the sessions dir must not gain an escape.json.
    expect(fs.existsSync(join(dir, '..', 'escape.json'))).toBe(false);
  });

  it('rejects a missing path parameter with 400', async () => {
    const dir = makeTempDir();
    const base = await bootServer(dir);
    const res = await fetch(`${base}/api/session-data`);
    expect(res.status).toBe(400);
  });

  it('rejects a non-DELETE on /api/session-reset with 405', async () => {
    const dir = makeTempDir();
    const base = await bootServer(dir);
    const res = await fetch(`${base}/api/session-reset?path=${encodeURIComponent('aoi/mod')}`);
    expect(res.status).toBe(405);
  });

  it('calls next() for a path it does not own', async () => {
    const dir = makeTempDir();
    const base = await bootServer(dir);
    const res = await fetch(`${base}/api/not-session-data`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code?: string }).code).toBe('route_not_found');
  });

  it('does not capture a session-data-prefixed typo (exact-match routing)', async () => {
    const dir = makeTempDir();
    const base = await bootServer(dir);
    const res = await fetch(`${base}/api/session-data-typo?path=x`);
    expect(res.status).toBe(404);
  });
});
