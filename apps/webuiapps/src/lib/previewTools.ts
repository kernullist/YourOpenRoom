import type { ToolDef } from './llmClient';

import { validateAppDataWrite } from './appDataSchemas';
import * as idb from './diskStorage';

const TOOL_NAME = 'preview_changes';
const MAX_PREVIEW_LINES = 16;

function countOccurrences(content: string, searchText: string): number {
  if (!searchText) return 0;
  let count = 0;
  let cursor = 0;
  while (cursor <= content.length) {
    const foundAt = content.indexOf(searchText, cursor);
    if (foundAt < 0) break;
    count++;
    cursor = foundAt + searchText.length;
  }
  return count;
}

function replaceOnce(content: string, oldText: string, newText: string): string {
  const index = content.indexOf(oldText);
  if (index < 0) return content;
  return `${content.slice(0, index)}${newText}${content.slice(index + oldText.length)}`;
}

function buildPreview(beforeContent: string | null, afterContent: string | null): string[] {
  const beforeLines = (beforeContent ?? '').replace(/\r\n/g, '\n').split('\n');
  const afterLines = (afterContent ?? '').replace(/\r\n/g, '\n').split('\n');
  const maxLength = Math.max(beforeLines.length, afterLines.length);
  const preview: string[] = [];

  for (let index = 0; index < maxLength; index++) {
    const beforeLine = beforeLines[index];
    const afterLine = afterLines[index];
    if (beforeLine === afterLine) continue;
    if (beforeLine !== undefined) preview.push(`- ${beforeLine}`);
    if (afterLine !== undefined) preview.push(`+ ${afterLine}`);
    if (preview.length >= MAX_PREVIEW_LINES) break;
  }

  return preview;
}

export function getPreviewToolDefinitions(): ToolDef[] {
  return [
    {
      type: 'function',
      function: {
        name: TOOL_NAME,
        description:
          'Preview the effect of a proposed file write, patch, or delete before applying it.',
        parameters: {
          type: 'object',
          properties: {
            operation: {
              type: 'string',
              enum: ['write', 'patch', 'delete'],
              description: 'The planned file mutation operation',
            },
            file_path: {
              type: 'string',
              description: 'File path relative to workspace root',
            },
            content: {
              type: 'string',
              description: 'New file content for write previews',
            },
            old_text: {
              type: 'string',
              description: 'Exact text to replace for patch previews',
            },
            new_text: {
              type: 'string',
              description: 'Replacement text for patch previews',
            },
            replace_all: {
              type: 'boolean',
              description: 'Whether the patch should replace all matches',
            },
          },
          required: ['operation', 'file_path'],
        },
      },
    },
  ];
}

export function isPreviewTool(toolName: string): boolean {
  return toolName === TOOL_NAME;
}

export async function executePreviewTool(params: Record<string, unknown>): Promise<string> {
  const operation = String(params.operation || '').trim();
  const filePath = String(params.file_path || '').replace(/^\/+/, '');
  if (!operation) return 'error: operation is required';
  if (!filePath) return 'error: file_path is required';

  const existing = await idb.getFile(filePath);
  const beforeContent =
    existing === null || existing === undefined
      ? null
      : typeof existing === 'string'
        ? existing
        : JSON.stringify(existing, null, 2);

  let afterContent: string | null = beforeContent;
  const result: Record<string, unknown> = {
    operation,
    file_path: filePath,
    exists_before: beforeContent !== null,
  };

  if (operation === 'write') {
    afterContent = String(params.content ?? '');
  } else if (operation === 'delete') {
    afterContent = null;
  } else if (operation === 'patch') {
    const oldText = String(params.old_text ?? '');
    const newText = String(params.new_text ?? '');
    if (!oldText) return 'error: old_text is required for patch previews';
    if (beforeContent === null) return 'error: file not found';
    const replaceAll = params.replace_all === true;
    const matchCount = countOccurrences(beforeContent, oldText);
    result.match_count = matchCount;
    if (matchCount === 0) return 'error: old_text not found in file';
    afterContent = replaceAll ? beforeContent.split(oldText).join(newText) : replaceOnce(beforeContent, oldText, newText);
  } else {
    return `error: unsupported preview operation ${operation}`;
  }

  const previewLines = buildPreview(beforeContent, afterContent);
  result.preview_lines = previewLines;
  result.would_change = beforeContent !== afterContent;
  result.before_length = beforeContent?.length ?? 0;
  result.after_length = afterContent?.length ?? 0;

  if (afterContent !== null && filePath.endsWith('.json')) {
    const validation = validateAppDataWrite(filePath, afterContent);
    if (validation) {
      result.schema_id = validation.schemaId;
      result.schema_valid = validation.ok;
      if (validation.ok) {
        result.schema_warnings = validation.warnings;
      } else {
        result.schema_errors = validation.errors;
      }
    }
  }

  return JSON.stringify(result);
}
