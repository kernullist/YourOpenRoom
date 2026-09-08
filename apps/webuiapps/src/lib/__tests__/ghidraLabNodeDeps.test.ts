// @vitest-environment node
//
// The production wiring, exercised for real.
//
// Everywhere else in this feature the effects are injected, which is what makes
// the logic testable -- but it also means the actual fs/spawn/socket
// implementations were the one part nothing touched. These are the functions
// that decide whether a real install is detected correctly, so they get real
// files, a real port, and a real (tiny) process.
import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { normalizeGhidraLabConfig } from '../ghidraLabConfig';
import { createGhidraLabNodePreflightDeps, runGhidraLabPreflight } from '../ghidraLabPreflight';
import { createGhidraLabNodeDeps } from '../ghidraLabSession';
import { hashFileSync } from '../ghidraLabSweep';

const isWindows = process.platform === 'win32';
let base = '';

beforeAll(() => {
  base = fs.mkdtempSync(join(os.tmpdir(), 'ghidra-node-deps-'));
});

afterAll(() => {
  try {
    fs.rmSync(base, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

describe('preflight node deps', () => {
  const deps = createGhidraLabNodePreflightDeps();

  it('distinguishes files, directories and neither', () => {
    const file = join(base, 'a.txt');
    fs.writeFileSync(file, 'x');
    expect(deps.fileExists(file)).toBe(true);
    expect(deps.directoryExists(file)).toBe(false);
    expect(deps.directoryExists(base)).toBe(true);
    expect(deps.fileExists(base)).toBe(false);
    expect(deps.fileExists(join(base, 'missing'))).toBe(false);
    expect(deps.directoryExists(join(base, 'missing'))).toBe(false);
  });

  it('reads a text file and returns empty for one that is not there', () => {
    const file = join(base, 'props.txt');
    fs.writeFileSync(file, 'application.version=12.1.3\n');
    expect(deps.readTextFile(file)).toContain('12.1.3');
    expect(deps.readTextFile(join(base, 'nope.txt'))).toBe('');
  });

  it('creates the project folder when it is missing and reports it writable', () => {
    const target = join(base, 'projects', 'nested');
    expect(deps.checkWritableDirectory(target)).toBe('');
    expect(fs.existsSync(target)).toBe(true);
    // Leaves nothing behind.
    expect(fs.readdirSync(target)).toEqual([]);
  });

  it('reports a directory it cannot create', () => {
    // A path under a FILE cannot become a directory on any platform.
    const file = join(base, 'blocker');
    fs.writeFileSync(file, 'x');
    expect(deps.checkWritableDirectory(join(file, 'child'))).not.toBe('');
  });

  it('probes a real process and captures its output', () => {
    const result = deps.probe(process.execPath, ['-e', 'console.log("hello-probe")'], {
      ...(process.env as Record<string, string>),
    });
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain('hello-probe');
    expect(result.code).toBe(0);
  });

  it('reports a non-zero exit rather than throwing', () => {
    const result = deps.probe(process.execPath, ['-e', 'process.exit(3)'], {});
    expect(result.ok).toBe(false);
    expect(result.code).toBe(3);
  });

  it('reports a missing program as an error, not a crash', () => {
    const result = deps.probe(join(base, 'definitely-not-here.exe'), ['--version'], {});
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('drives a full preflight against a fake install laid out on disk', () => {
    // Build something shaped like a Ghidra install, with node standing in for
    // java so the version probe has something real to read.
    const ghidra = join(base, 'ghidra');
    fs.mkdirSync(join(ghidra, 'support'), { recursive: true });
    fs.mkdirSync(join(ghidra, 'Ghidra'), { recursive: true });
    fs.writeFileSync(
      join(ghidra, 'support', isWindows ? 'analyzeHeadless.bat' : 'analyzeHeadless'),
      '@echo off',
    );
    fs.writeFileSync(
      join(ghidra, 'Ghidra', 'application.properties'),
      'application.name=Ghidra\napplication.version=12.1.3\n',
    );
    const roots = join(base, 'bins');
    fs.mkdirSync(roots, { recursive: true });

    const config = normalizeGhidraLabConfig({
      ghidraInstallDir: ghidra,
      projectRoot: join(base, 'projects2'),
      binaryRoots: [{ id: 'bins', path: roots, label: 'Bins' }],
    });
    const result = runGhidraLabPreflight(config, deps);

    const byId = new Map(result.checks.map((check) => [check.id, check]));
    expect(byId.get('ghidra')?.ok).toBe(true);
    expect(result.ghidraVersion).toBe('12.1.3');
    expect(byId.get('projects')?.ok).toBe(true);
    expect(byId.get('roots')?.ok).toBe(true);
    // No JDK configured, so nothing may run -- the point of the gate.
    expect(byId.get('jdk')?.ok).toBe(false);
    expect(result.availableModes).toEqual([]);
  });
});

describe('session node deps', () => {
  const deps = createGhidraLabNodeDeps();

  it('reports a free port as free and a bound one as taken', async () => {
    const net = await import('net');
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as { port: number }).port;
    expect(await deps.isPortFree(port)).toBe(false);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await deps.isPortFree(port)).toBe(true);
  });

  it('spawns a real process, streams its output, and reports its exit', async () => {
    const chunks: string[] = [];
    const exited = new Promise<number | null>((resolve) => {
      const child = deps.spawnProcess(
        process.execPath,
        ['-e', 'console.log("child-alive"); process.exit(0)'],
        { cwd: base, env: { ...(process.env as Record<string, string>) } },
      );
      expect(child.pid).toBeGreaterThan(0);
      child.onOutput((chunk) => chunks.push(chunk));
      child.onExit((code) => resolve(code));
    });
    expect(await exited).toBe(0);
    expect(chunks.join('')).toContain('child-alive');
  });

  it('kills a process that would otherwise keep running', async () => {
    const exited = new Promise<void>((resolve) => {
      const child = deps.spawnProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        cwd: base,
        env: { ...(process.env as Record<string, string>) },
      });
      child.onExit(() => resolve());
      setTimeout(() => child.kill(), 50);
    });
    await expect(exited).resolves.toBeUndefined();
  });

  it('kills the whole process tree, not just the launcher', async () => {
    // `python -m pyghidra_mcp` re-execs and the DESCENDANT holds the Ghidra JVM,
    // so killing only the process we spawned leaves a multi-hundred-megabyte JVM
    // orphaned. Observed live: launcher at 4MB/1 thread, descendant at
    // 530MB/102 threads.
    const script =
      'const {spawn}=require("child_process");' +
      'const c=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});' +
      'console.log(c.pid); setInterval(()=>{},1000);';
    const childPid = await new Promise<number>((resolve) => {
      const child = deps.spawnProcess(process.execPath, ['-e', script], {
        cwd: base,
        env: { ...(process.env as Record<string, string>) },
      });
      child.onOutput((chunk) => {
        const pid = Number.parseInt(String(chunk).trim(), 10);
        if (Number.isFinite(pid) && pid > 0) {
          child.kill();
          resolve(pid);
        }
      });
    });

    // Give the kill a moment to walk the tree, then confirm the grandchild died.
    await new Promise((resolve) => setTimeout(resolve, 2500));
    let grandchildAlive = true;
    try {
      process.kill(childPid, 0);
    } catch {
      grandchildAlive = false;
    }
    if (grandchildAlive) {
      try {
        process.kill(childPid);
      } catch {
        // best effort cleanup
      }
    }
    expect(grandchildAlive).toBe(false);
  });

  it('reports a spawn error through the exit listener instead of throwing', async () => {
    const settled = new Promise<void>((resolve) => {
      const child = deps.spawnProcess(join(base, 'no-such-binary.exe'), [], {
        cwd: base,
        env: {},
      });
      child.onExit(() => resolve());
    });
    await expect(settled).resolves.toBeUndefined();
  });

  it('measures project bytes and returns zero for a project that is not there', () => {
    const projects = join(base, 'projroot');
    const rep = join(projects, 'demo.rep', 'sub');
    fs.mkdirSync(rep, { recursive: true });
    fs.writeFileSync(join(rep, 'db.dat'), Buffer.alloc(2048));
    expect(deps.projectBytes?.(projects, 'demo')).toBeGreaterThanOrEqual(2048);
    expect(deps.projectBytes?.(projects, 'missing')).toBe(0);
    expect(deps.projectBytes?.('', 'demo')).toBe(0);
  });

  it('recognizes an existing project, which is what forces a re-analysis', () => {
    // pyghidra-mcp skips analysis entirely when the project already holds the
    // binary, so a half-imported project is never finished without
    // --force-analysis -- three sessions stalled for tens of minutes each before
    // this answer was consulted. The .gpr beside the project root is the tell.
    const projects = join(base, 'existing');
    fs.mkdirSync(projects, { recursive: true });
    fs.writeFileSync(join(projects, 'demo.gpr'), '');
    expect(deps.projectExists?.(projects, 'demo')).toBe(true);
    expect(deps.projectExists?.(projects, 'never-made')).toBe(false);
    // No project root configured yet: not an error, just nothing to reuse.
    expect(deps.projectExists?.('', 'demo')).toBe(false);
  });

  it('logs through the shared prefix instead of throwing during teardown', () => {
    const original = console.error;
    const seen: unknown[] = [];
    console.error = (...args: unknown[]) => {
      seen.push(args[0]);
    };
    try {
      expect(() => deps.logError?.('kill failed', new Error('gone'))).not.toThrow();
    } finally {
      console.error = original;
    }
    expect(String(seen[0])).toContain('[ghidra-lab]');
  });

  it('sleeps for real, so the start-up poll actually waits between ticks', async () => {
    const started = Date.now();
    await deps.sleep(20);
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
  });

  it('builds a distinct MCP client per endpoint', () => {
    const first = deps.createMcpClient('http://127.0.0.1:8500/mcp');
    const second = deps.createMcpClient('http://127.0.0.1:8500/mcp');
    // A shared cache would hand a reused port a dead session's MCP id.
    expect(first).not.toBe(second);
  });
});

describe('hashFileSync', () => {
  it('hashes a real file and reports its size', () => {
    const file = join(base, 'binary.bin');
    fs.writeFileSync(file, Buffer.from('MZ padding here'));
    const hashed = hashFileSync(file);
    expect(hashed.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(hashed.sizeBytes).toBe(15);
    expect(hashed.mtimeMs).toBeGreaterThan(0);
  });

  it('throws for a file that is not there, so the stage can record the failure', () => {
    expect(() => hashFileSync(join(base, 'nope.bin'))).toThrow();
  });
});
