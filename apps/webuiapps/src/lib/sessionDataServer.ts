import * as fs from 'fs';
import type { IncomingMessage, ServerResponse } from 'http';
import { dirname, join, resolve } from 'path';

// Durable session-data file store over ~/.openroom/sessions, factored out of the
// Vite sessionDataPlugin so the SAME handler can be mounted by BOTH the Vite dev
// server and the standalone autonomy daemon (the P0a factory pattern -- no forked
// fs logic). Browser memory / chat / disk writes hit /api/session-data; lifting
// the handler onto the always-on daemon lets a daemon-hosted deployment persist
// those captures durably without the dev-only Vite middleware.
//
// Server-only (Node fs): never import this from client code -- pnpm build would
// leak fs into the browser bundle.

const BINARY_MIMES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  webm: 'video/webm',
};

export interface SessionDataMiddlewareOptions {
  sessionsDir: string;
}

// Connect-style request handler: owns the session-data routes and calls next()
// for anything it does not handle. Identical shape to AoiAutonomyMiddleware so
// the daemon can chain the two.
export type SessionDataMiddleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
) => void;

// Sanitize a client-supplied relative path: allow only a conservative charset and
// strip parent-dir escapes before joining under the sessions root. Byte-identical
// to the original Vite sessionDataPlugin sanitizer.
function sanitizeRelPath(relPath: string): string {
  return relPath.replace(/[^a-zA-Z0-9_\-./]/g, '_').replace(/\.\./g, '');
}

function handleSessionData(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  sessionsDir: string,
): void {
  res.setHeader('Content-Type', 'application/json');

  const relPath = url.searchParams.get('path') || '';
  const action = url.searchParams.get('action') || '';
  console.info('[SessionData] Request received', {
    method: req.method,
    relPath,
    action,
  });

  if (!relPath) {
    res.writeHead(400);
    res.end(JSON.stringify({ error: 'Missing path parameter' }));
    return;
  }

  const safePath = sanitizeRelPath(relPath);
  const filePath = join(sessionsDir, safePath);

  // Directory listing: ?action=list&path=...
  if (action === 'list' && req.method === 'GET') {
    try {
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isDirectory()) {
        res.writeHead(200);
        res.end(JSON.stringify({ files: [], not_exists: !fs.existsSync(filePath) }));
        return;
      }
      const entries = fs.readdirSync(filePath, { withFileTypes: true });
      const files = entries.map((e) => ({
        path: safePath === '' || safePath === '/' ? e.name : `${safePath}/${e.name}`,
        type: e.isDirectory() ? 1 : 0,
        size: e.isDirectory() ? 0 : fs.statSync(join(filePath, e.name)).size,
      }));
      res.writeHead(200);
      res.end(JSON.stringify({ files, not_exists: false }));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: String(err) }));
    }
    return;
  }

  if (req.method === 'GET') {
    try {
      if (fs.existsSync(filePath)) {
        const ext = filePath.split('.').pop()?.toLowerCase() || '';
        const mime = BINARY_MIMES[ext];
        if (mime) {
          res.setHeader('Content-Type', mime);
          res.writeHead(200);
          res.end(fs.readFileSync(filePath));
        } else {
          res.writeHead(200);
          res.end(fs.readFileSync(filePath, 'utf-8'));
        }
      } else {
        res.writeHead(200);
        res.end('{}');
      }
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: String(err) }));
    }
    return;
  }

  if (req.method === 'POST') {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const buf = Buffer.concat(chunks);
        const dir = dirname(filePath);
        fs.mkdirSync(dir, { recursive: true });
        const ct = (req.headers['content-type'] || '').toLowerCase();
        if (
          ct.startsWith('image/') ||
          ct.startsWith('video/') ||
          ct === 'application/octet-stream'
        ) {
          fs.writeFileSync(filePath, buf);
        } else {
          fs.writeFileSync(filePath, buf.toString(), 'utf-8');
        }
        if (safePath.includes('/memory/') || safePath.endsWith('/chat/chat.json')) {
          console.info('[SessionData] Wrote file', {
            path: safePath,
            contentType: ct || 'text/plain',
            bytes: buf.length,
            preview: buf.toString('utf-8').slice(0, 200),
          });
        }
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        console.error('[SessionData] Failed to write file', {
          path: safePath,
          filePath,
          error: String(err),
        });
        res.writeHead(500);
        res.end(JSON.stringify({ error: String(err) }));
      }
    });
    return;
  }

  if (req.method === 'DELETE') {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: String(err) }));
    }
    return;
  }

  res.writeHead(405);
  res.end(JSON.stringify({ error: 'Method not allowed' }));
}

// Session reset: DELETE /api/session-reset?path={charId}/{modId}
// Recursively removes the entire session directory.
function handleSessionReset(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  sessionsDir: string,
): void {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'DELETE') {
    res.writeHead(405);
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  const relPath = url.searchParams.get('path') || '';
  if (!relPath) {
    res.writeHead(400);
    res.end(JSON.stringify({ error: 'Missing path parameter' }));
    return;
  }

  const safePath = sanitizeRelPath(relPath);
  const targetDir = join(sessionsDir, safePath);

  try {
    if (fs.existsSync(targetDir)) {
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true }));
  } catch (err) {
    res.writeHead(500);
    res.end(JSON.stringify({ error: String(err) }));
  }
}

// Build the shared middleware. Path resolution happens once at creation, matching
// createAoiAutonomyMiddleware. Routes are matched by exact pathname (every caller
// uses a fixed /api/session-data?path=... query; no subpaths), and anything else
// falls through to next().
export function createSessionDataMiddleware(
  options: SessionDataMiddlewareOptions,
): SessionDataMiddleware {
  const sessionsDir = resolve(options.sessionsDir);
  return (req, res, next) => {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname === '/api/session-data') {
      handleSessionData(req, res, url, sessionsDir);
      return;
    }
    if (url.pathname === '/api/session-reset') {
      handleSessionReset(req, res, url, sessionsDir);
      return;
    }
    next();
  };
}
