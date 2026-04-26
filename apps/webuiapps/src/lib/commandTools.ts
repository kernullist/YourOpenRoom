import type { ToolDef } from './llmClient';

const TOOL_NAME = 'run_command';

export function getCommandToolDefinitions(): ToolDef[] {
  return [
    {
      type: 'function',
      function: {
        name: TOOL_NAME,
        description:
          "Run a safe, read-only command inside Aoi's IDE workspace. " +
          'Use this for git status/diff/log or npm/pnpm test/lint/build verification.',
        parameters: {
          type: 'object',
          properties: {
            command: {
              type: 'string',
              description:
                'Read-only command to run, for example "git status" or "pnpm test -- src/lib/__tests__/foo.test.ts"',
            },
            directory: {
              type: 'string',
              description:
                'Optional directory relative to the OpenVSCode workspace root. Defaults to the workspace root.',
            },
            timeout_ms: {
              type: 'number',
              description: 'Optional timeout in milliseconds, between 1000 and 30000.',
            },
          },
          required: ['command'],
        },
      },
    },
  ];
}

export function isCommandTool(toolName: string): boolean {
  return toolName === TOOL_NAME;
}

export async function executeCommandTool(params: Record<string, unknown>): Promise<string> {
  const command = String(params.command || '').trim();
  if (!command) return 'error: missing command';

  const res = await fetch('/api/openvscode/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      command,
      ...(typeof params.directory === 'string' && params.directory.trim()
        ? { directory: params.directory.trim() }
        : {}),
      ...(params.timeout_ms !== undefined ? { timeout_ms: params.timeout_ms } : {}),
    }),
  });

  const contentType = res.headers.get('content-type') || '';
  if (!res.ok) {
    if (contentType.includes('application/json')) {
      const data = (await res.json()) as { error?: string };
      return `error: ${data.error || `Command API error ${res.status}`}`;
    }
    return `error: ${await res.text()}`;
  }

  const result = (await res.json()) as Record<string, unknown>;
  return JSON.stringify(result);
}
