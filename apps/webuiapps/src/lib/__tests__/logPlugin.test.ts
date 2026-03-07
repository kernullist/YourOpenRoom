import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';
import { formatLogLine, generateLogFileName, createLogMiddleware } from '../logPlugin';

// ============ formatLogLine ============

describe('formatLogLine', () => {
  it('格式正确：时间 + LEVEL + tag + args', () => {
    const ts = new Date('2026-03-07T01:15:44.123Z').getTime();
    const line = formatLogLine({ level: 'info', tag: 'ChatPanel', args: ['hello', 42], ts });
    expect(line).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}/);
    expect(line).toContain('[INFO]');
    expect(line).toContain('[ChatPanel]');
    expect(line).toContain('hello');
    expect(line).toContain('42');
  });

  it('level 转为大写', () => {
    const line = formatLogLine({ level: 'warn', tag: 'T', args: [], ts: Date.now() });
    expect(line).toContain('[WARN]');
  });

  it('error level 转为大写', () => {
    const line = formatLogLine({ level: 'error', tag: 'T', args: [], ts: Date.now() });
    expect(line).toContain('[ERROR]');
  });

  it('object 类型 args 序列化为 JSON', () => {
    const line = formatLogLine({ level: 'info', tag: 'T', args: [{ id: 1 }], ts: Date.now() });
    expect(line).toContain('{"id":1}');
  });

  it('null args 不崩溃', () => {
    const line = formatLogLine({ level: 'info', tag: 'T', args: [null], ts: Date.now() });
    expect(line).toContain('null');
  });

  it('多个 args 用空格拼接', () => {
    const line = formatLogLine({ level: 'info', tag: 'T', args: ['a', 'b', 'c'], ts: Date.now() });
    expect(line).toContain('a b c');
  });
});

// ============ generateLogFileName ============

describe('generateLogFileName', () => {
  it('文件名格式为 debug-YYYY-MM-DD_HH-mm-ss.log', () => {
    const name = generateLogFileName(new Date(2026, 2, 7, 9, 15, 44)); // 月份从0开始
    expect(name).toBe('debug-2026-03-07_09-15-44.log');
  });

  it('个位数月/日/时/分/秒补零', () => {
    const name = generateLogFileName(new Date(2026, 0, 5, 8, 3, 9));
    expect(name).toBe('debug-2026-01-05_08-03-09.log');
  });

  it('不传参数时使用当前时间，格式仍正确', () => {
    const name = generateLogFileName();
    expect(name).toMatch(/^debug-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.log$/);
  });
});

// ============ createLogMiddleware ============

type FsMock = {
  appendFileSync: ReturnType<typeof vi.fn>;
  existsSync: ReturnType<typeof vi.fn>;
  mkdirSync: ReturnType<typeof vi.fn>;
};

function makeFsMock(dirExists = true): FsMock {
  return {
    appendFileSync: vi.fn(),
    existsSync: vi.fn().mockReturnValue(dirExists),
    mkdirSync: vi.fn(),
  };
}

function makeReq(method: string, body: string): IncomingMessage {
  const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
  const req = {
    method,
    headers: {},
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      listeners[event] = listeners[event] || [];
      listeners[event].push(cb);
      // Emit synchronously for testing
      if (event === 'data') cb(Buffer.from(body));
      if (event === 'end') cb();
    }),
  } as unknown as IncomingMessage;
  return req;
}

function makeRes(): {
  res: ServerResponse;
  writeHead: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
} {
  const writeHead = vi.fn();
  const end = vi.fn();
  const res = { writeHead, end } as unknown as ServerResponse;
  return { res, writeHead, end };
}

describe('createLogMiddleware', () => {
  let fsMock: FsMock;

  beforeEach(() => {
    fsMock = makeFsMock();
  });

  it('POST 合法 body → 写文件，返回 204', () => {
    const middleware = createLogMiddleware('/tmp/logs/test.log', fsMock);
    const body = JSON.stringify({ level: 'info', tag: 'ChatPanel', args: ['msg'], ts: Date.now() });
    const req = makeReq('POST', body);
    const { res, writeHead } = makeRes();

    middleware(req, res, vi.fn());

    expect(writeHead).toHaveBeenCalledWith(204);
    expect(fsMock.appendFileSync).toHaveBeenCalledOnce();
    const written = fsMock.appendFileSync.mock.calls[0][1] as string;
    expect(written).toContain('[ChatPanel]');
    expect(written).toContain('msg');
    expect(written).toContain('[INFO]');
  });

  it('写入内容以换行结尾', () => {
    const middleware = createLogMiddleware('/tmp/logs/test.log', fsMock);
    const body = JSON.stringify({ level: 'info', tag: 'T', args: ['x'], ts: Date.now() });
    const req = makeReq('POST', body);
    const { res } = makeRes();

    middleware(req, res, vi.fn());

    const written = fsMock.appendFileSync.mock.calls[0][1] as string;
    expect(written.endsWith('\n')).toBe(true);
  });

  it('非 POST 请求 → 返回 405，不写文件', () => {
    const middleware = createLogMiddleware('/tmp/logs/test.log', fsMock);
    const req = makeReq('GET', '');
    const { res, writeHead } = makeRes();

    middleware(req, res, vi.fn());

    expect(writeHead).toHaveBeenCalledWith(405);
    expect(fsMock.appendFileSync).not.toHaveBeenCalled();
  });

  it('body 非合法 JSON → 返回 400，不写文件', () => {
    const middleware = createLogMiddleware('/tmp/logs/test.log', fsMock);
    const req = makeReq('POST', 'not-json{{{');
    const { res, writeHead } = makeRes();

    middleware(req, res, vi.fn());

    expect(writeHead).toHaveBeenCalledWith(400);
    expect(fsMock.appendFileSync).not.toHaveBeenCalled();
  });

  it('logs 目录不存在时自动创建', () => {
    fsMock = makeFsMock(false);
    const middleware = createLogMiddleware('/tmp/logs/test.log', fsMock);
    const body = JSON.stringify({ level: 'info', tag: 'T', args: [], ts: Date.now() });
    const req = makeReq('POST', body);
    const { res } = makeRes();

    middleware(req, res, vi.fn());

    expect(fsMock.mkdirSync).toHaveBeenCalledWith('/tmp/logs', { recursive: true });
    expect(fsMock.appendFileSync).toHaveBeenCalledOnce();
  });

  it('logs 目录已存在时不调用 mkdirSync', () => {
    const middleware = createLogMiddleware('/tmp/logs/test.log', fsMock);
    const body = JSON.stringify({ level: 'info', tag: 'T', args: [], ts: Date.now() });
    const req = makeReq('POST', body);
    const { res } = makeRes();

    middleware(req, res, vi.fn());

    expect(fsMock.mkdirSync).not.toHaveBeenCalled();
  });
});
