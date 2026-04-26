import type { ToolDef } from './llmClient';

import { executeCommandTool } from './commandTools';

const TOOL_NAME = 'structured_diagnostics';

interface DiagnosticItem {
  file?: string;
  line?: number;
  column?: number;
  severity: 'error' | 'warning' | 'info';
  code?: string;
  message: string;
  test_name?: string;
}

function parseTscDiagnostics(output: string): DiagnosticItem[] {
  const diagnostics: DiagnosticItem[] = [];
  const regex = /^(.+)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/gm;
  for (const match of output.matchAll(regex)) {
    diagnostics.push({
      file: match[1],
      line: Number.parseInt(match[2], 10),
      column: Number.parseInt(match[3], 10),
      severity: match[4] === 'warning' ? 'warning' : 'error',
      code: match[5],
      message: match[6],
    });
  }
  return diagnostics;
}

function parseEslintDiagnostics(output: string): DiagnosticItem[] {
  const diagnostics: DiagnosticItem[] = [];
  let currentFile = '';
  const lines = output.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (!trimmed) continue;
    if (/^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith('/')) {
      currentFile = trimmed.trim();
      continue;
    }

    const match = trimmed.match(/^(\d+):(\d+)\s+(error|warning)\s+(.+?)\s{2,}([@\w/-]+)$/);
    if (match) {
      diagnostics.push({
        file: currentFile || undefined,
        line: Number.parseInt(match[1], 10),
        column: Number.parseInt(match[2], 10),
        severity: match[3] === 'warning' ? 'warning' : 'error',
        code: match[5],
        message: match[4],
      });
    }
  }

  return diagnostics;
}

function parseVitestDiagnostics(output: string): DiagnosticItem[] {
  const diagnostics: DiagnosticItem[] = [];
  const fileRegex = /^\s*❯\s+(.+?)\s+\(.+\)$/gm;
  for (const match of output.matchAll(fileRegex)) {
    diagnostics.push({
      file: match[1].trim(),
      severity: 'error',
      message: 'Test suite reported a failure.',
    });
  }

  const assertionRegex = /^\s*→\s+(.+)$/gm;
  for (const match of output.matchAll(assertionRegex)) {
    diagnostics.push({
      severity: 'error',
      message: match[1].trim(),
    });
  }

  return diagnostics;
}

function parsePlaywrightDiagnostics(output: string): DiagnosticItem[] {
  const diagnostics: DiagnosticItem[] = [];
  const fileRegex = /^\s*([^\s].+\.spec\.[jt]sx?)[\s:].*$/gm;
  for (const match of output.matchAll(fileRegex)) {
    diagnostics.push({
      file: match[1].trim(),
      severity: 'info',
      message: 'Playwright listed this spec.',
    });
  }
  return diagnostics;
}

function parseDiagnostics(command: string, stdout: string, stderr: string): DiagnosticItem[] {
  const merged = `${stdout}\n${stderr}`.trim();
  const lowered = command.toLowerCase();
  if (!merged) return [];
  if (lowered.includes('tsc')) return parseTscDiagnostics(merged);
  if (lowered.includes('eslint')) return parseEslintDiagnostics(merged);
  if (lowered.includes('vitest') || lowered.includes('test')) return parseVitestDiagnostics(merged);
  if (lowered.includes('playwright')) return parsePlaywrightDiagnostics(merged);
  return [];
}

export function getDiagnosticsToolDefinitions(): ToolDef[] {
  return [
    {
      type: 'function',
      function: {
        name: TOOL_NAME,
        description:
          'Run a safe verification command and parse the output into structured diagnostics when possible.',
        parameters: {
          type: 'object',
          properties: {
            command: {
              type: 'string',
              description: 'Safe verification command, such as "pnpm exec tsc --noEmit" or "pnpm test -- foo.test.ts"',
            },
            directory: {
              type: 'string',
              description: 'Optional directory relative to the OpenVSCode workspace root.',
            },
            timeout_ms: {
              type: 'number',
              description: 'Optional timeout in milliseconds.',
            },
          },
          required: ['command'],
        },
      },
    },
  ];
}

export function isDiagnosticsTool(toolName: string): boolean {
  return toolName === TOOL_NAME;
}

export async function executeDiagnosticsTool(params: Record<string, unknown>): Promise<string> {
  const raw = await executeCommandTool(params);
  if (/^error:/i.test(raw)) return raw;

  const parsed = JSON.parse(raw) as {
    command?: string;
    cwd?: string;
    exitCode?: number;
    timedOut?: boolean;
    durationMs?: number;
    stdout?: string;
    stderr?: string;
  };

  const diagnostics = parseDiagnostics(
    parsed.command || String(params.command || ''),
    parsed.stdout || '',
    parsed.stderr || '',
  );

  return JSON.stringify({
    command: parsed.command || '',
    cwd: parsed.cwd || '.',
    exitCode: parsed.exitCode ?? -1,
    timedOut: !!parsed.timedOut,
    durationMs: parsed.durationMs ?? 0,
    diagnostic_count: diagnostics.length,
    diagnostics,
    stdout: parsed.stdout || '',
    stderr: parsed.stderr || '',
  });
}
