import type { ToolDef } from './llmClient';

import { createAutofixCheckpoint } from './checkpointTools';
import { executeDiagnosticsTool } from './diagnosticsTools';

const TOOL_NAME = 'autofix_diagnostics';

export function getAutofixMacroToolDefinitions(): ToolDef[] {
  return [
    {
      type: 'function',
      function: {
        name: TOOL_NAME,
        description:
          'Start an autofix workflow by creating an IDE checkpoint and running structured diagnostics.',
        parameters: {
          type: 'object',
          properties: {
            command: {
              type: 'string',
              description: 'Verification command to run, such as "pnpm exec tsc --noEmit"',
            },
            directory: {
              type: 'string',
              description: 'Optional IDE workspace directory to scope both the checkpoint and diagnostics.',
            },
          },
          required: ['command'],
        },
      },
    },
  ];
}

export function isAutofixMacroTool(toolName: string): boolean {
  return toolName === TOOL_NAME;
}

export async function executeAutofixMacroTool(params: Record<string, unknown>): Promise<string> {
  const command = String(params.command || '').trim();
  if (!command) return 'error: missing command';
  const directory = typeof params.directory === 'string' ? params.directory.trim() : '';

  const checkpointId = await createAutofixCheckpoint(command, directory);
  const diagnosticsResult = await executeDiagnosticsTool({
    command,
    ...(directory ? { directory } : {}),
  });
  if (/^error:/i.test(diagnosticsResult)) return diagnosticsResult;

  return JSON.stringify({
    checkpoint_id: checkpointId,
    command,
    directory: directory || '.',
    diagnostics: JSON.parse(diagnosticsResult),
  });
}
