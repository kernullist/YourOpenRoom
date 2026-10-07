// @vitest-environment node
import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { Readable } from 'stream';
import type { IncomingMessage, ServerResponse } from 'http';
import { afterAll, describe, expect, it } from 'vitest';

import { idaPePlugin, isRealPathInside } from '../idaPePlugin';

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'ida-pe-contain-'));
  roots.push(dir);
  return dir;
}

describe('isRealPathInside (PE sample containment)', () => {
  it('accepts uploaded samples under the sample root', () => {
    const root = tempDir();
    fs.mkdirSync(join(root, 'abc'), { recursive: true });
    fs.writeFileSync(join(root, 'abc', 'sample.exe'), 'MZ');
    fs.writeFileSync(join(root, '..odd-name.bin'), 'MZ');
    expect(isRealPathInside(root, join(root, 'abc', 'sample.exe'))).toBe(true);
    expect(isRealPathInside(root, join(root, '..odd-name.bin'))).toBe(true);
  });

  it('refuses any other file on disk, the root itself, and missing paths', () => {
    // /api/ida-pe/analyses used to read whatever samplePath it was given and
    // return the file's strings.
    const root = tempDir();
    const outside = tempDir();
    fs.writeFileSync(join(outside, 'secret.txt'), 'token');
    expect(isRealPathInside(root, join(outside, 'secret.txt'))).toBe(false);
    expect(isRealPathInside(root, join(root, '..', 'x'))).toBe(false);
    expect(isRealPathInside(root, root)).toBe(false);
    expect(isRealPathInside(root, join(root, 'missing.exe'))).toBe(false);
    expect(isRealPathInside(join(root, 'no-such-root'), join(outside, 'secret.txt'))).toBe(false);
  });

  describe('sample routes', () => {
    type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;
    interface RouteResult {
      status: number;
      body: { error?: string };
    }

    // No backend is configured, so the function routes take the headless path.
    function mountRoutes(cacheRoot: string): Map<string, Handler> {
      const routes = new Map<string, Handler>();
      const plugin = idaPePlugin({ configFile: join(cacheRoot, 'config.json'), cacheRoot });
      (plugin.configureServer as (server: unknown) => void)({
        middlewares: { use: (path: string, handler: Handler) => routes.set(path, handler) },
      });
      return routes;
    }

    async function call(
      handler: Handler | undefined,
      request: { method: 'GET' | 'POST'; url?: string; body?: unknown },
    ): Promise<RouteResult> {
      expect(handler).toBeDefined();
      const payload = request.body === undefined ? [] : [Buffer.from(JSON.stringify(request.body))];
      const req = Object.assign(Readable.from(payload), {
        method: request.method,
        url: request.url ?? '/',
        headers: {},
      }) as unknown as IncomingMessage;
      let status = 0;
      let text = '';
      const res = {
        writeHead: (code: number) => {
          status = code;
        },
        end: (chunk: string) => {
          text = chunk;
        },
      } as unknown as ServerResponse;
      await handler?.(req, res);
      return { status, body: JSON.parse(text) as { error?: string } };
    }

    function uploadedSample(cacheRoot: string): string {
      fs.mkdirSync(join(cacheRoot, 'pe-samples', 's1'), { recursive: true });
      const path = join(cacheRoot, 'pe-samples', 's1', 'sample.exe');
      fs.writeFileSync(path, 'not a PE');
      return path;
    }

    function secretOutsideRoot(): string {
      const path = join(tempDir(), 'secret.txt');
      fs.writeFileSync(path, 'token');
      return path;
    }

    it('makes /api/ida-pe/analyses refuse a samplePath outside the sample root', async () => {
      const cacheRoot = tempDir();
      const analyses = mountRoutes(cacheRoot).get('/api/ida-pe/analyses');

      const refused = await call(analyses, {
        method: 'POST',
        body: { samplePath: secretOutsideRoot(), sampleId: 's1' },
      });
      expect(refused.status).toBe(403);
      expect(refused.body.error).toContain('/api/ida-pe/samples');

      // An uploaded sample passes containment and reaches the PE parser, which
      // rejects this one for not being a PE file.
      const parsed = await call(analyses, {
        method: 'POST',
        body: { samplePath: uploadedSample(cacheRoot), sampleId: 's1' },
      });
      expect(parsed.status).toBe(400);
    });

    it('keeps the headless backend from opening a binary outside the sample root', async () => {
      // open_binary would return the disassembly and decompilation of any file.
      const cacheRoot = tempDir();
      const routes = mountRoutes(cacheRoot);
      const secret = encodeURIComponent(secretOutsideRoot());
      const inside = encodeURIComponent(uploadedSample(cacheRoot));

      for (const [route, query] of [
        ['/api/ida-pe/functions', ''],
        ['/api/ida-pe/function-detail', '&address=0x401000'],
      ]) {
        const handler = routes.get(route);
        const refused = await call(handler, {
          method: 'GET',
          url: `/?samplePath=${secret}${query}`,
        });
        expect(refused.status, route).toBe(403);

        // An uploaded sample gets past containment; with no backend configured
        // the backend call itself fails.
        const allowed = await call(handler, {
          method: 'GET',
          url: `/?samplePath=${inside}${query}`,
        });
        expect(allowed.status, route).toBe(502);
        expect(allowed.body.error, route).toContain('not configured');
      }
    });
  });

  it('follows links before deciding', () => {
    const root = tempDir();
    const outside = tempDir();
    fs.writeFileSync(join(outside, 'secret.txt'), 'token');
    try {
      fs.symlinkSync(outside, join(root, 'link'), 'junction');
    } catch {
      return; // no permission to create links here; the realpath branch is covered above
    }
    expect(isRealPathInside(root, join(root, 'link', 'secret.txt'))).toBe(false);
  });
});
