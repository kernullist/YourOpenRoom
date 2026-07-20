import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import {
  buildAoiHostBrowserHeadlessArgs,
  extractAoiHostBrowserReadable,
  resolveAoiHostBrowserExecutable,
  resolveAoiHostBrowserUrl,
  runAoiHostBrowserRead,
} from '../aoiHostBrowserRead';

describe('resolveAoiHostBrowserUrl', () => {
  it('accepts public https URLs and adds https when missing', () => {
    expect(resolveAoiHostBrowserUrl('https://example.com/a').ok).toBe(true);
    const bare = resolveAoiHostBrowserUrl('example.com/path');
    expect(bare.ok).toBe(true);
    if (bare.ok) {
      expect(bare.url).toBe('https://example.com/path');
    }
  });

  it('rejects private/local hosts and non-http schemes', () => {
    expect(resolveAoiHostBrowserUrl('http://127.0.0.1/').ok).toBe(false);
    expect(resolveAoiHostBrowserUrl('http://192.168.1.1/').ok).toBe(false);
    expect(resolveAoiHostBrowserUrl('http://10.0.0.2/x').ok).toBe(false);
    expect(resolveAoiHostBrowserUrl('http://169.254.169.254/latest').ok).toBe(false);
    expect(resolveAoiHostBrowserUrl('file:///C:/Windows').ok).toBe(false);
    expect(resolveAoiHostBrowserUrl('javascript:alert(1)').ok).toBe(false);
    expect(resolveAoiHostBrowserUrl('').ok).toBe(false);
  });
});

describe('extractAoiHostBrowserReadable', () => {
  it('pulls title and paragraph-ish blocks from HTML', () => {
    const html = `
      <html><head><title>Hello World Research</title></head>
      <body>
        <h1>Main Heading About Topic</h1>
        <p>This is a sufficiently long paragraph that should be kept for the model summary path.</p>
        <p>Another paragraph with enough characters for the minimum length filter to accept it.</p>
      </body></html>`;
    const readable = extractAoiHostBrowserReadable(html, 'https://example.com/article');
    expect(readable.title).toContain('Hello World');
    expect(readable.blocks.length).toBeGreaterThan(0);
    expect(readable.text.length).toBeGreaterThan(20);
  });
});

describe('resolveAoiHostBrowserExecutable', () => {
  it('picks the first existing chrome/edge candidate', () => {
    const resolved = resolveAoiHostBrowserExecutable({
      platform: 'win32',
      env: {},
      existsSyncImpl: (path) => path.toLowerCase().includes('msedge.exe'),
    });
    expect(resolved?.engine).toBe('edge-headless');
    expect(resolved?.path.toLowerCase()).toContain('msedge');
  });
});

describe('buildAoiHostBrowserHeadlessArgs', () => {
  it('includes dump-dom and isolates user-data-dir', () => {
    const args = buildAoiHostBrowserHeadlessArgs('https://example.com', 'C:\\tmp\\aoi-profile');
    expect(args).toContain('--dump-dom');
    expect(args).toContain('--headless=new');
    expect(args).toContain('--user-data-dir=C:\\tmp\\aoi-profile');
    expect(args[args.length - 1]).toBe('https://example.com');
  });
});

describe('runAoiHostBrowserRead', () => {
  it('returns a page snapshot when spawn dumps HTML', async () => {
    const spawnImpl = vi.fn(() => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: () => void;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn();
      queueMicrotask(() => {
        child.stdout.emit(
          'data',
          Buffer.from(
            '<html><head><title>Injected Page Title Here</title></head><body><p>Injected paragraph content that is long enough for extraction filters to keep.</p></body></html>',
          ),
        );
        child.emit('close', 0);
      });
      return child;
    });

    const result = await runAoiHostBrowserRead({
      url: 'https://example.com/doc',
      now: 123,
      spawnImpl: spawnImpl as never,
      existsSyncImpl: () => true,
      mkdtempImpl: () => 'C:\\tmp\\aoi-test-profile',
      rmImpl: () => undefined,
      browserPath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.title).toContain('Injected Page Title');
      expect(result.text.length).toBeGreaterThan(10);
      expect(result.engine).toBe('chrome-headless');
    }
    expect(spawnImpl).toHaveBeenCalled();
  });

  it('fails closed for private hosts without spawning', async () => {
    const spawnImpl = vi.fn();
    const result = await runAoiHostBrowserRead({
      url: 'http://127.0.0.1/secret',
      spawnImpl: spawnImpl as never,
      existsSyncImpl: () => true,
      browserPath: 'C:\\chrome.exe',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('host_not_allowed');
    }
    expect(spawnImpl).not.toHaveBeenCalled();
  });
});
