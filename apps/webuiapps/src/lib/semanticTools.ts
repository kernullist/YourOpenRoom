import type { ToolDef } from './llmClient';

import { executeCheckpointTool } from './checkpointTools';

const FIND_REFERENCES_TOOL = 'find_references';
const LIST_EXPORTS_TOOL = 'list_exports';
const PEEK_DEFINITION_TOOL = 'peek_definition';
const RENAME_PREVIEW_TOOL = 'rename_preview';
const APPLY_RENAME_TOOL = 'apply_semantic_rename';

export function getSemanticToolDefinitions(): ToolDef[] {
  return [
    {
      type: 'function',
      function: {
        name: FIND_REFERENCES_TOOL,
        description:
          'Find likely references, imports, and declarations for a symbol in the OpenVSCode workspace.',
        parameters: {
          type: 'object',
          properties: {
            symbol: {
              type: 'string',
              description: 'Symbol name to search for',
            },
            directory: {
              type: 'string',
              description: 'Optional directory relative to the IDE workspace root.',
            },
            max_results: {
              type: 'number',
              description: 'Maximum number of matches to return.',
            },
          },
          required: ['symbol'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: LIST_EXPORTS_TOOL,
        description: 'List exported symbols in the OpenVSCode workspace or a subdirectory.',
        parameters: {
          type: 'object',
          properties: {
            directory: {
              type: 'string',
              description: 'Optional directory relative to the IDE workspace root.',
            },
            max_results: {
              type: 'number',
              description: 'Maximum number of exports to return.',
            },
          },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: PEEK_DEFINITION_TOOL,
        description: 'Show the best-matching symbol definition with nearby source context.',
        parameters: {
          type: 'object',
          properties: {
            symbol: {
              type: 'string',
              description: 'Symbol name to resolve',
            },
            directory: {
              type: 'string',
              description: 'Optional directory relative to the IDE workspace root.',
            },
          },
          required: ['symbol'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: RENAME_PREVIEW_TOOL,
        description:
          'Preview the impact of renaming a symbol across the IDE workspace without changing any files.',
        parameters: {
          type: 'object',
          properties: {
            symbol: {
              type: 'string',
              description: 'Existing symbol name',
            },
            new_name: {
              type: 'string',
              description: 'Proposed new symbol name',
            },
            directory: {
              type: 'string',
              description: 'Optional directory relative to the IDE workspace root.',
            },
            max_results: {
              type: 'number',
              description: 'Maximum number of affected files to include in the preview.',
            },
          },
          required: ['symbol', 'new_name'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: APPLY_RENAME_TOOL,
        description:
          'Apply a previously previewed semantic rename across the IDE workspace. Requires a preview_signature from rename_preview.',
        parameters: {
          type: 'object',
          properties: {
            symbol: {
              type: 'string',
              description: 'Existing symbol name',
            },
            new_name: {
              type: 'string',
              description: 'New symbol name to apply',
            },
            preview_signature: {
              type: 'string',
              description: 'Signature returned by rename_preview for the same symbol/new_name pair',
            },
            directory: {
              type: 'string',
              description: 'Optional directory relative to the IDE workspace root.',
            },
            create_checkpoint: {
              type: 'boolean',
              description: 'When true, create an IDE checkpoint before applying the rename. Defaults to true.',
            },
          },
          required: ['symbol', 'new_name', 'preview_signature'],
        },
      },
    },
  ];
}

export function isSemanticTool(toolName: string): boolean {
  return (
    toolName === FIND_REFERENCES_TOOL ||
    toolName === LIST_EXPORTS_TOOL ||
    toolName === PEEK_DEFINITION_TOOL ||
    toolName === RENAME_PREVIEW_TOOL ||
    toolName === APPLY_RENAME_TOOL
  );
}

export async function executeSemanticTool(
  toolName: string,
  params: Record<string, unknown>,
): Promise<string> {
  const endpoint =
    toolName === FIND_REFERENCES_TOOL
      ? '/api/openvscode/references'
      : toolName === LIST_EXPORTS_TOOL
        ? '/api/openvscode/exports'
        : toolName === PEEK_DEFINITION_TOOL
          ? '/api/openvscode/peek-definition'
          : toolName === RENAME_PREVIEW_TOOL
            ? '/api/openvscode/rename-preview'
            : toolName === APPLY_RENAME_TOOL
              ? '/api/openvscode/apply-rename'
        : '';

  if (!endpoint) return `error: unknown semantic tool ${toolName}`;

  const url = new URL(endpoint, window.location.origin);
  if (typeof params.directory === 'string' && params.directory.trim()) {
    url.searchParams.set('directory', params.directory.trim());
  }
  if (toolName === FIND_REFERENCES_TOOL || toolName === PEEK_DEFINITION_TOOL) {
    const symbol = String(params.symbol || '').trim();
    if (!symbol) return 'error: missing symbol';
    url.searchParams.set('symbol', symbol);
  }
  if (toolName === RENAME_PREVIEW_TOOL || toolName === APPLY_RENAME_TOOL) {
    const symbol = String(params.symbol || '').trim();
    const newName = String(params.new_name || '').trim();
    if (!symbol) return 'error: missing symbol';
    if (!newName) return 'error: missing new_name';
    url.searchParams.set('symbol', symbol);
    url.searchParams.set('new_name', newName);
    if (toolName === APPLY_RENAME_TOOL) {
      const previewSignature = String(params.preview_signature || '').trim();
      if (!previewSignature) return 'error: missing preview_signature';
      url.searchParams.set('preview_signature', previewSignature);
    }
  }
  if (params.max_results !== undefined) {
    url.searchParams.set('max_results', String(params.max_results));
  }

  if (toolName === APPLY_RENAME_TOOL) {
    let checkpointId: string | null = null;
    if (params.create_checkpoint !== false) {
      const checkpointRaw = await executeCheckpointTool({
        mode: 'create',
        scope: 'ide',
        roots: [typeof params.directory === 'string' && params.directory.trim() ? params.directory.trim() : ''],
        name: `Semantic rename ${String(params.symbol || '').trim()} -> ${String(params.new_name || '').trim()}`,
      });
      if (!/^error:/i.test(checkpointRaw)) {
        checkpointId = (JSON.parse(checkpointRaw) as { id?: string }).id || null;
      }
    }
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const contentType = res.headers.get('content-type') || '';
    if (!res.ok) {
      if (contentType.includes('application/json')) {
        const data = (await res.json()) as { error?: string };
        return `error: ${data.error || `Semantic API error ${res.status}`}`;
      }
      return `error: ${await res.text()}`;
    }
    const payload = (await res.json()) as Record<string, unknown>;
    return JSON.stringify({
      ...payload,
      checkpoint_id: checkpointId,
    });
  }

  const res = await fetch(url.toString());
  const contentType = res.headers.get('content-type') || '';
  if (!res.ok) {
    if (contentType.includes('application/json')) {
      const data = (await res.json()) as { error?: string };
      return `error: ${data.error || `Semantic API error ${res.status}`}`;
    }
    return `error: ${await res.text()}`;
  }

  return JSON.stringify(await res.json());
}
