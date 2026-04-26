import type { ToolDef } from './llmClient';

import { findAppSchemaByFilePath, listAppSchemas, listSchemasForApp } from './appSchemaRegistry';

const TOOL_NAME = 'get_app_schema';

export function getAppSchemaToolDefinitions(): ToolDef[] {
  return [
    {
      type: 'function',
      function: {
        name: TOOL_NAME,
        description:
          'Return machine-readable app data schema definitions by app name or exact file path.',
        parameters: {
          type: 'object',
          properties: {
            app_name: {
              type: 'string',
              description: 'Optional appName, for example "notes" or "calendar".',
            },
            file_path: {
              type: 'string',
              description: 'Optional exact app data file path, for example "apps/notes/data/notes/foo.json".',
            },
          },
          required: [],
        },
      },
    },
  ];
}

export function isAppSchemaTool(toolName: string): boolean {
  return toolName === TOOL_NAME;
}

export async function executeAppSchemaTool(params: Record<string, unknown>): Promise<string> {
  const filePath = String(params.file_path || '').trim().replace(/^\/+/, '');
  if (filePath) {
    const schema = findAppSchemaByFilePath(filePath);
    if (!schema) return `error: no machine-readable schema found for ${filePath}`;
    return JSON.stringify(schema);
  }

  const appName = String(params.app_name || '').trim();
  if (appName) {
    const schemas = listSchemasForApp(appName);
    if (schemas.length === 0) return `error: no machine-readable schemas found for app "${appName}"`;
    return JSON.stringify({ app_name: appName, schemas });
  }

  return JSON.stringify({
    apps: [...new Set(listAppSchemas().map((schema) => schema.appName))].sort(),
    schema_count: listAppSchemas().length,
  });
}
