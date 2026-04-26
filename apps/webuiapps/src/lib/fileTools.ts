/**
 * File Tools - Allow Agent to directly read/write disk-based file storage
 * Simulates chat-agent's nas_file_read / nas_file_write capabilities
 */

import * as idb from './diskStorage';
import { validateAppDataWrite } from './appDataSchemas';
import { logger } from './logger';
import { recordFileMutation } from './toolMutationHistory';

const MAX_FILE_READ_LINES = 220;
const MAX_FILE_READ_CHARS = 6000;
const DEFAULT_FILE_READ_HEAD_LINES = 150;
const DEFAULT_FILE_READ_TAIL_LINES = 40;

/**
 * Extract valid JSON string from LLM output.
 * Handles common cases: markdown code block wrapping, extra text around JSON.
 */
function extractJson(raw: string): string {
  const trimmed = raw.trim();

  // 1. Already valid JSON, return directly
  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    // continue
  }

  // 2. Wrapped in markdown code block
  const codeBlockMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (codeBlockMatch) {
    const inner = codeBlockMatch[1].trim();
    try {
      JSON.parse(inner);
      return inner;
    } catch {
      // continue
    }
  }

  // 3. Extract the first { ... } or [ ... ] structure
  const firstBrace = trimmed.indexOf('{');
  const firstBracket = trimmed.indexOf('[');
  let start = -1;
  let open = '{';
  let close = '}';
  if (firstBrace >= 0 && (firstBracket < 0 || firstBrace < firstBracket)) {
    start = firstBrace;
  } else if (firstBracket >= 0) {
    start = firstBracket;
    open = '[';
    close = ']';
  }
  if (start >= 0) {
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\' && inString) {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === open) depth++;
      else if (ch === close) depth--;
      if (depth === 0) {
        const candidate = trimmed.slice(start, i + 1);
        try {
          JSON.parse(candidate);
          return candidate;
        } catch {
          break;
        }
      }
    }
  }

  // 4. Cannot extract, return raw content
  logger.warn('fileTools', 'extractJson: could not extract valid JSON, using raw content');
  return trimmed;
}

// ============ Tool Definitions ============

export function getFileToolDefinitions(): Array<{
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required: string[];
    };
  };
}> {
  return [
    {
      type: 'function',
      function: {
        name: 'file_read',
        description:
          'Read a file from storage. Returns the file content. Path is relative to workspace root, e.g. "apps/{appName}/data/state.json"',
        parameters: {
          type: 'object',
          properties: {
            file_path: {
              type: 'string',
              description: 'File path relative to workspace root',
            },
            start_line: {
              type: 'number',
              description: 'Optional 1-based start line for a focused excerpt',
            },
            end_line: {
              type: 'number',
              description: 'Optional 1-based end line for a focused excerpt',
            },
          },
          required: ['file_path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'file_write',
        description:
          'Write content to a file in storage. Creates parent directories automatically. Path is relative to workspace root, e.g. "apps/{appName}/data/state.json"',
        parameters: {
          type: 'object',
          properties: {
            file_path: {
              type: 'string',
              description: 'File path relative to workspace root',
            },
            content: {
              type: 'string',
              description: 'File content to write (string or JSON string)',
            },
          },
          required: ['file_path', 'content'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'file_patch',
        description:
          'Patch a small section of an existing file by replacing exact text. Prefer this over file_write when only a targeted edit is needed.',
        parameters: {
          type: 'object',
          properties: {
            file_path: {
              type: 'string',
              description: 'File path relative to workspace root',
            },
            old_text: {
              type: 'string',
              description: 'Exact text to replace',
            },
            new_text: {
              type: 'string',
              description: 'Replacement text',
            },
            expected_occurrences: {
              type: 'number',
              description:
                'Optional exact number of matches expected before replacement. Use this to guard against accidental broad edits.',
            },
            replace_all: {
              type: 'boolean',
              description: 'When true, replace every exact match instead of only one.',
            },
          },
          required: ['file_path', 'old_text', 'new_text'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'file_list',
        description:
          'List files and directories at a given path. Returns file names and types. Path is relative to workspace root, e.g. "apps/{appName}/data"',
        parameters: {
          type: 'object',
          properties: {
            directory: {
              type: 'string',
              description: 'Directory path relative to workspace root. Use "/" or "" for root.',
            },
          },
          required: ['directory'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'file_delete',
        description:
          'Delete a file from storage. Path is relative to workspace root, e.g. "apps/{appName}/data/articles/article-001.json"',
        parameters: {
          type: 'object',
          properties: {
            file_path: {
              type: 'string',
              description: 'File path relative to workspace root',
            },
          },
          required: ['file_path'],
        },
      },
    },
  ];
}

// ============ Tool Execution ============

export function isFileTool(toolName: string): boolean {
  return (
    toolName === 'file_read' ||
    toolName === 'file_write' ||
    toolName === 'file_patch' ||
    toolName === 'file_list' ||
    toolName === 'file_delete'
  );
}

function countOccurrences(content: string, searchText: string): number {
  if (!searchText) return 0;
  let count = 0;
  let startIndex = 0;

  while (startIndex <= content.length) {
    const foundIndex = content.indexOf(searchText, startIndex);
    if (foundIndex < 0) break;
    count++;
    startIndex = foundIndex + searchText.length;
  }

  return count;
}

function replaceOnce(content: string, oldText: string, newText: string): string {
  const index = content.indexOf(oldText);
  if (index < 0) return content;
  return `${content.slice(0, index)}${newText}${content.slice(index + oldText.length)}`;
}

function clampLineNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function formatLineBlock(lines: string[], startLine: number): string {
  return lines.map((line, index) => `${startLine + index}: ${line}`).join('\n');
}

export function buildFileReadResponse(
  filePath: string,
  content: string,
  options: { startLine?: number; endLine?: number } = {},
): string {
  const normalized = content.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const totalLines = lines.length;
  const hasExplicitRange =
    typeof options.startLine === 'number' || typeof options.endLine === 'number';

  if (
    !hasExplicitRange &&
    totalLines <= MAX_FILE_READ_LINES &&
    normalized.length <= MAX_FILE_READ_CHARS
  ) {
    return normalized;
  }

  if (hasExplicitRange) {
    const start = clampLineNumber(options.startLine ?? 1, 1, Math.max(1, totalLines));
    const requestedEnd = clampLineNumber(
      options.endLine ?? start + MAX_FILE_READ_LINES - 1,
      start,
      totalLines,
    );
    const end = Math.min(requestedEnd, start + MAX_FILE_READ_LINES - 1);
    const excerpt = formatLineBlock(lines.slice(start - 1, end), start);
    return [
      `Focused excerpt for ${filePath} — showing lines ${start}-${end} of ${totalLines}.`,
      excerpt,
    ].join('\n\n');
  }

  const headLines = lines.slice(0, DEFAULT_FILE_READ_HEAD_LINES);
  const tailStart = Math.max(
    DEFAULT_FILE_READ_HEAD_LINES,
    totalLines - DEFAULT_FILE_READ_TAIL_LINES + 1,
  );
  const tailLines = lines.slice(tailStart - 1);
  const body = [formatLineBlock(headLines, 1), '...', formatLineBlock(tailLines, tailStart)].join(
    '\n',
  );

  return [
    `File ${filePath} is large (${totalLines} lines, ${normalized.length} chars).`,
    `Showing the first ${headLines.length} lines and the last ${tailLines.length} lines. Use file_read with start_line/end_line for a focused excerpt.`,
    body,
  ].join('\n\n');
}

export async function executeFileTool(
  toolName: string,
  params: Record<string, unknown>,
): Promise<string> {
  switch (toolName) {
    case 'file_read': {
      const filePath = String(params.file_path || '').replace(/^\/+/, '');
      if (!filePath) return 'error: file_path is required';
      try {
        const content = await idb.getFile(filePath);
        if (content === null || content === undefined) {
          return 'error: file not found';
        }
        const textContent =
          typeof content === 'string' ? content : JSON.stringify(content, null, 2);
        const startLine =
          typeof params.start_line === 'number'
            ? Math.floor(params.start_line)
            : Number(String(params.start_line || ''));
        const endLine =
          typeof params.end_line === 'number'
            ? Math.floor(params.end_line)
            : Number(String(params.end_line || ''));
        return buildFileReadResponse(filePath, textContent, {
          startLine: Number.isFinite(startLine) ? startLine : undefined,
          endLine: Number.isFinite(endLine) ? endLine : undefined,
        });
      } catch (e) {
        return `error: ${String(e)}`;
      }
    }

    case 'file_write': {
      const filePath = String(params.file_path || '').replace(/^\/+/, '');
      let content = String(params.content ?? '');
      if (!filePath) return 'error: file_path is required';
      if (params.content === undefined) return 'error: content is required';
      // For JSON files, extract JSON (strip markdown wrapping) and validate
      if (filePath.endsWith('.json')) {
        content = extractJson(content);
        const validation = validateAppDataWrite(filePath, content);
        if (validation) {
          if (!validation.ok) {
            return `error: schema validation failed for ${validation.schemaId} — ${validation.errors.join('; ')}`;
          }
          content = validation.normalizedContent;
        } else {
          try {
            JSON.parse(content);
          } catch (e) {
            return `error: invalid JSON — ${String(e)}. Please regenerate valid JSON.`;
          }
        }
      }
      try {
        const existing = await idb.getFile(filePath);
        const beforeContent =
          existing === null || existing === undefined
            ? null
            : typeof existing === 'string'
              ? existing
              : JSON.stringify(existing, null, 2);
        const parts = filePath.split('/');
        const name = parts.pop() || filePath;
        const dir = parts.join('/');
        await idb.putTextFilesByJSON({
          files: [{ path: dir || undefined, name, content }],
        });
        if (beforeContent !== content) {
          recordFileMutation({
            tool_name: 'file_write',
            file_path: filePath,
            before_content: beforeContent,
            after_content: content,
          });
        }
        return 'success';
      } catch (e) {
        return `error: ${String(e)}`;
      }
    }

    case 'file_patch': {
      const filePath = String(params.file_path || '').replace(/^\/+/, '');
      const oldText = String(params.old_text ?? '');
      const newText = String(params.new_text ?? '');
      const expectedOccurrences =
        typeof params.expected_occurrences === 'number'
          ? Math.floor(params.expected_occurrences)
          : Number.parseInt(String(params.expected_occurrences || ''), 10);
      const replaceAll = params.replace_all === true;

      if (!filePath) return 'error: file_path is required';
      if (!oldText) return 'error: old_text is required';

      try {
        const content = await idb.getFile(filePath);
        if (content === null || content === undefined) {
          return 'error: file not found';
        }

        const textContent = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
        const occurrenceCount = countOccurrences(textContent, oldText);
        if (occurrenceCount === 0) {
          return 'error: old_text not found in file';
        }

        if (Number.isFinite(expectedOccurrences) && occurrenceCount !== expectedOccurrences) {
          return `error: expected ${expectedOccurrences} occurrences, found ${occurrenceCount}`;
        }

        if (!replaceAll && !Number.isFinite(expectedOccurrences) && occurrenceCount > 1) {
          return `error: old_text matched ${occurrenceCount} times. Use expected_occurrences or replace_all to disambiguate.`;
        }

        const patchedContent = replaceAll
          ? textContent.split(oldText).join(newText)
          : replaceOnce(textContent, oldText, newText);
        let finalContent = patchedContent;

        if (filePath.endsWith('.json')) {
          const validation = validateAppDataWrite(filePath, patchedContent);
          if (validation) {
            if (!validation.ok) {
              return `error: schema validation failed for ${validation.schemaId} — ${validation.errors.join('; ')}`;
            }
            finalContent = validation.normalizedContent;
          } else {
            try {
              JSON.parse(patchedContent);
            } catch (error) {
              return `error: patched JSON became invalid — ${String(error)}`;
            }
          }
        }

        const parts = filePath.split('/');
        const name = parts.pop() || filePath;
        const dir = parts.join('/');
        await idb.putTextFilesByJSON({
          files: [{ path: dir || undefined, name, content: finalContent }],
        });
        if (textContent !== finalContent) {
          recordFileMutation({
            tool_name: 'file_patch',
            file_path: filePath,
            before_content: textContent,
            after_content: finalContent,
          });
        }
        return `success: patched ${filePath}; replacements=${replaceAll ? occurrenceCount : 1}`;
      } catch (error) {
        return `error: ${String(error)}`;
      }
    }

    case 'file_list': {
      const dir = String(params.directory || '')
        .replace(/^\/+/, '')
        .replace(/\/+$/, '');
      try {
        const result = await idb.listFiles(dir || '/');
        const items = result.files.map((f) => {
          const name = f.path.split('/').pop() || f.path;
          return f.type === 1 ? `[dir]  ${name}` : `[file] ${name}`;
        });
        if (items.length === 0) return 'empty directory';
        return items.join('\n');
      } catch (e) {
        return `error: ${String(e)}`;
      }
    }

    case 'file_delete': {
      const filePath = String(params.file_path || '').replace(/^\/+/, '');
      if (!filePath) return 'error: file_path is required';
      try {
        const existing = await idb.getFile(filePath);
        const beforeContent =
          existing === null || existing === undefined
            ? null
            : typeof existing === 'string'
              ? existing
              : JSON.stringify(existing, null, 2);
        await idb.deleteFilesByPaths({ file_paths: [filePath] });
        if (beforeContent !== null) {
          recordFileMutation({
            tool_name: 'file_delete',
            file_path: filePath,
            before_content: beforeContent,
            after_content: null,
          });
        }
        return 'success';
      } catch (e) {
        return `error: ${String(e)}`;
      }
    }

    default:
      return `error: unknown file tool ${toolName}`;
  }
}
