import type { ToolDef } from './llmClient';

import * as idb from './diskStorage';
import { listRecentMutations, popLastMutation, recordFileMutation } from './toolMutationHistory';

const TOOL_NAME = 'undo_last_action';

export function getUndoToolDefinitions(): ToolDef[] {
  return [
    {
      type: 'function',
      function: {
        name: TOOL_NAME,
        description:
          'Undo the most recent reversible file mutation from file_write, file_patch, or file_delete in this session.',
        parameters: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
    },
  ];
}

export function isUndoTool(toolName: string): boolean {
  return toolName === TOOL_NAME;
}

export async function executeUndoTool(): Promise<string> {
  const mutation = popLastMutation();
  if (!mutation) {
    return 'error: no reversible mutation was found in the current session history';
  }

  if (mutation.kind !== 'file') {
    return 'error: last mutation is not reversible';
  }

  const filePath = mutation.file_path.replace(/^\/+/, '');

  if (mutation.before_content === null) {
    await idb.deleteFilesByPaths({ file_paths: [filePath] });
  } else {
    const parts = filePath.split('/');
    const name = parts.pop() || filePath;
    const dir = parts.join('/');
    await idb.putTextFilesByJSON({
      files: [{ path: dir || undefined, name, content: mutation.before_content }],
    });
  }

  recordFileMutation({
    tool_name: 'undo_last_action',
    file_path: filePath,
    before_content: mutation.after_content,
    after_content: mutation.before_content,
  });

  return JSON.stringify({
    undone_mutation_id: mutation.id,
    file_path: filePath,
    restored_to_previous_state: true,
    remaining_reversible_actions: listRecentMutations().length,
  });
}
