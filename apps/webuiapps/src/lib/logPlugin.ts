/**
 * Log Plugin — Node.js ONLY
 * Core logic for the Vite dev-server log middleware.
 * Do NOT import this file from frontend code.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import type * as fsType from 'fs';

export interface LogBody {
  level: string;
  tag: string;
  args: unknown[];
  ts: number;
}

const pad = (n: number) => String(n).padStart(2, '0');
const pad3 = (n: number) => String(n).padStart(3, '0');

/**
 * Generate log file name with local-time timestamp.
 * Format: debug-YYYY-MM-DD_HH-mm-ss.log
 */
export function generateLogFileName(now: Date = new Date()): string {
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  return `debug-${date}_${time}.log`;
}

/**
 * Format a single log line using local time (consistent with file name).
 */
export function formatLogLine(body: LogBody): string {
  const d = new Date(body.ts);
  const time =
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad3(d.getMilliseconds())}`;
  const argsStr = body.args
    .map((a) => (a !== null && typeof a === 'object' ? JSON.stringify(a) : String(a)))
    .join(' ');
  return `${time} [${body.level.toUpperCase()}] [${body.tag}] ${argsStr}`;
}

type FsLike = Pick<typeof fsType, 'appendFileSync' | 'existsSync' | 'mkdirSync'>;

/**
 * Create the /api/log Express-style middleware.
 * Accepts POST requests with LogBody JSON, appends formatted lines to logFile.
 */
export function createLogMiddleware(logFile: string, fsModule: FsLike) {
  const logDir = logFile.split('/').slice(0, -1).join('/');

  return (req: IncomingMessage, res: ServerResponse, _next: () => void) => {
    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end();
      return;
    }

    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const body: LogBody = JSON.parse(Buffer.concat(chunks).toString());
        const line = formatLogLine(body);
        if (!fsModule.existsSync(logDir)) {
          fsModule.mkdirSync(logDir, { recursive: true });
        }
        fsModule.appendFileSync(logFile, line + '\n', 'utf8');
        res.writeHead(204);
        res.end();
      } catch {
        res.writeHead(400);
        res.end();
      }
    });
  };
}
