export type PrimitiveSchemaType =
  | 'string'
  | 'integer'
  | 'number'
  | 'boolean'
  | 'nullable-string'
  | 'iso-datetime'
  | 'date'
  | 'string-array';

export interface SchemaFieldBase {
  required?: boolean;
  description?: string;
}

export interface PrimitiveFieldSchema extends SchemaFieldBase {
  kind: 'primitive';
  type: PrimitiveSchemaType;
  enum?: string[];
}

export interface ObjectFieldSchema extends SchemaFieldBase {
  kind: 'object';
  fields: Record<string, AppSchemaField>;
}

export interface ArrayFieldSchema extends SchemaFieldBase {
  kind: 'array';
  item: AppSchemaField;
}

export type AppSchemaField = PrimitiveFieldSchema | ObjectFieldSchema | ArrayFieldSchema;

export interface AppSchemaDocument {
  id: string;
  appName: string;
  entityName: string;
  pathPattern: RegExp;
  description: string;
  fields: Record<string, AppSchemaField>;
}

export interface AppSchemaValidationSuccess {
  ok: true;
  normalized: Record<string, unknown>;
  warnings: string[];
}

export interface AppSchemaValidationFailure {
  ok: false;
  errors: string[];
}

export type AppSchemaValidationResult = AppSchemaValidationSuccess | AppSchemaValidationFailure;

type JsonRecord = Record<string, unknown>;

function primitive(
  type: PrimitiveSchemaType,
  options: Omit<PrimitiveFieldSchema, 'kind' | 'type'> = {},
): PrimitiveFieldSchema {
  return { kind: 'primitive', type, ...options };
}

function object(
  fields: Record<string, AppSchemaField>,
  options: Omit<ObjectFieldSchema, 'kind' | 'fields'> = {},
): ObjectFieldSchema {
  return { kind: 'object', fields, ...options };
}

function array(
  item: AppSchemaField,
  options: Omit<ArrayFieldSchema, 'kind' | 'item'> = {},
): ArrayFieldSchema {
  return { kind: 'array', item, ...options };
}

function isObject(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.floor(value) === value;
}

function isIsoDateTime(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

function isDateString(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function validatePrimitiveField(
  key: string,
  value: unknown,
  schema: PrimitiveFieldSchema,
  errors: string[],
): unknown {
  if (value === undefined || value === null) {
    if (schema.required) {
      errors.push(`${key} is required`);
    }
    return value ?? null;
  }

  switch (schema.type) {
    case 'string':
      if (typeof value !== 'string') errors.push(`${key} must be a string`);
      break;
    case 'integer':
      if (!isInteger(value)) errors.push(`${key} must be an integer`);
      break;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) errors.push(`${key} must be a number`);
      break;
    case 'boolean':
      if (typeof value !== 'boolean') errors.push(`${key} must be a boolean`);
      break;
    case 'nullable-string':
      if (!(typeof value === 'string' || value === null)) errors.push(`${key} must be a string or null`);
      break;
    case 'iso-datetime':
      if (typeof value !== 'string' || !isIsoDateTime(value)) {
        errors.push(`${key} must be a valid ISO datetime string`);
      }
      break;
    case 'date':
      if (typeof value !== 'string' || !isDateString(value)) {
        errors.push(`${key} must be a YYYY-MM-DD date string`);
      }
      break;
    case 'string-array':
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
        errors.push(`${key} must be an array of strings`);
      }
      break;
  }

  if (schema.enum && typeof value === 'string' && !schema.enum.includes(value)) {
    errors.push(`${key} must be one of: ${schema.enum.join(', ')}`);
  }

  return value;
}

function validateField(
  key: string,
  value: unknown,
  schema: AppSchemaField,
  errors: string[],
): unknown {
  if (schema.kind === 'primitive') {
    return validatePrimitiveField(key, value, schema, errors);
  }

  if (schema.kind === 'object') {
    if (value === undefined || value === null) {
      if (schema.required) errors.push(`${key} is required`);
      return value ?? null;
    }
    if (!isObject(value)) {
      errors.push(`${key} must be an object`);
      return {};
    }
    const normalized: JsonRecord = { ...value };
    for (const [childKey, childSchema] of Object.entries(schema.fields)) {
      normalized[childKey] = validateField(`${key}.${childKey}`, value[childKey], childSchema, errors);
    }
    return normalized;
  }

  if (value === undefined || value === null) {
    if (schema.required) errors.push(`${key} is required`);
    return [];
  }
  if (!Array.isArray(value)) {
    errors.push(`${key} must be an array`);
    return [];
  }
  return value.map((item, index) => validateField(`${key}[${index}]`, item, schema.item, errors));
}

const APP_SCHEMAS: AppSchemaDocument[] = [
  {
    id: 'browser-bookmark',
    appName: 'browser',
    entityName: 'bookmark',
    pathPattern: /^apps\/browser\/data\/bookmarks\/[^/]+\.json$/,
    description: 'Browser bookmark record',
    fields: {
      id: primitive('string', { required: true }),
      url: primitive('string', { required: true }),
      title: primitive('string', { required: true }),
      createdAt: primitive('integer', { required: true }),
    },
  },
  {
    id: 'browser-history',
    appName: 'browser',
    entityName: 'history',
    pathPattern: /^apps\/browser\/data\/history\/[^/]+\.json$/,
    description: 'Browser history record',
    fields: {
      id: primitive('string', { required: true }),
      url: primitive('string', { required: true }),
      title: primitive('string', { required: true }),
      visitedAt: primitive('integer', { required: true }),
    },
  },
  {
    id: 'browser-state',
    appName: 'browser',
    entityName: 'state',
    pathPattern: /^apps\/browser\/data\/state\.json$/,
    description: 'Browser UI state',
    fields: {
      currentUrl: primitive('string', { required: true }),
      inputUrl: primitive('string', { required: true }),
      viewMode: primitive('string', { required: true, enum: ['browse', 'reader'] }),
      sidebarOpen: primitive('boolean', { required: true }),
    },
  },
  {
    id: 'calendar-event',
    appName: 'calendar',
    entityName: 'event',
    pathPattern: /^apps\/calendar\/data\/events\/[^/]+\.json$/,
    description: 'Calendar event',
    fields: {
      id: primitive('string', { required: true }),
      title: primitive('string', { required: true }),
      notes: primitive('string', { required: true }),
      startAt: primitive('iso-datetime', { required: true }),
      remindBeforeMinutes: primitive('integer', { required: true }),
      completed: primitive('boolean', { required: true }),
      createdAt: primitive('integer', { required: true }),
      updatedAt: primitive('integer', { required: true }),
      lastReminderSentAt: primitive('integer'),
    },
  },
  {
    id: 'calendar-state',
    appName: 'calendar',
    entityName: 'state',
    pathPattern: /^apps\/calendar\/data\/state\.json$/,
    description: 'Calendar UI state',
    fields: {
      selectedEventId: primitive('nullable-string'),
    },
  },
  {
    id: 'diary-entry',
    appName: 'diary',
    entityName: 'entry',
    pathPattern: /^apps\/diary\/data\/entries\/[^/]+\.json$/,
    description: 'Diary entry',
    fields: {
      id: primitive('string', { required: true }),
      date: primitive('date', { required: true }),
      title: primitive('string', { required: true }),
      content: primitive('string', { required: true }),
      mood: primitive('string'),
      weather: primitive('string'),
      createdAt: primitive('integer', { required: true }),
      updatedAt: primitive('integer', { required: true }),
    },
  },
  {
    id: 'diary-state',
    appName: 'diary',
    entityName: 'state',
    pathPattern: /^apps\/diary\/data\/state\.json$/,
    description: 'Diary UI state',
    fields: {
      selectedDate: primitive('nullable-string'),
    },
  },
  {
    id: 'notes-note',
    appName: 'notes',
    entityName: 'note',
    pathPattern: /^apps\/notes\/data\/notes\/[^/]+\.json$/,
    description: 'Notes app note',
    fields: {
      id: primitive('string', { required: true }),
      title: primitive('string', { required: true }),
      content: primitive('string', { required: true }),
      tags: primitive('string-array', { required: true }),
      pinned: primitive('boolean', { required: true }),
      createdAt: primitive('integer', { required: true }),
      updatedAt: primitive('integer', { required: true }),
    },
  },
  {
    id: 'notes-state',
    appName: 'notes',
    entityName: 'state',
    pathPattern: /^apps\/notes\/data\/state\.json$/,
    description: 'Notes UI state',
    fields: {
      selectedNoteId: primitive('nullable-string'),
      activeTag: primitive('nullable-string'),
      searchQuery: primitive('string', { required: true }),
      previewMode: primitive('boolean', { required: true }),
    },
  },
  {
    id: 'email-email',
    appName: 'email',
    entityName: 'email',
    pathPattern: /^apps\/email\/data\/emails\/[^/]+\.json$/,
    description: 'Email record',
    fields: {
      id: primitive('string', { required: true }),
      from: object(
        {
          name: primitive('string', { required: true }),
          address: primitive('string', { required: true }),
        },
        { required: true },
      ),
      to: array(
        object({
          name: primitive('string', { required: true }),
          address: primitive('string', { required: true }),
        }),
        { required: true },
      ),
      cc: array(
        object({
          name: primitive('string', { required: true }),
          address: primitive('string', { required: true }),
        }),
        { required: true },
      ),
      subject: primitive('string', { required: true }),
      content: primitive('string', { required: true }),
      timestamp: primitive('integer', { required: true }),
      isRead: primitive('boolean', { required: true }),
      isStarred: primitive('boolean', { required: true }),
      folder: primitive('string', {
        required: true,
        enum: ['inbox', 'sent', 'drafts', 'trash'],
      }),
    },
  },
  {
    id: 'email-state',
    appName: 'email',
    entityName: 'state',
    pathPattern: /^apps\/email\/data\/state\.json$/,
    description: 'Email UI state',
    fields: {
      selectedEmailId: primitive('nullable-string'),
      currentFolder: primitive('string', {
        required: true,
        enum: ['inbox', 'sent', 'drafts', 'trash'],
      }),
    },
  },
  {
    id: 'twitter-post',
    appName: 'twitter',
    entityName: 'post',
    pathPattern: /^apps\/twitter\/data\/posts\/[^/]+\.json$/,
    description: 'Twitter post',
    fields: {
      id: primitive('string', { required: true }),
      author: object(
        {
          name: primitive('string', { required: true }),
          username: primitive('string', { required: true }),
          avatar: primitive('string', { required: true }),
        },
        { required: true },
      ),
      content: primitive('string', { required: true }),
      timestamp: primitive('integer', { required: true }),
      likes: primitive('integer', { required: true }),
      isLiked: primitive('boolean', { required: true }),
      comments: array(
        object({
          id: primitive('string', { required: true }),
          author: object(
            {
              name: primitive('string', { required: true }),
              username: primitive('string', { required: true }),
              avatar: primitive('string', { required: true }),
            },
            { required: true },
          ),
          content: primitive('string', { required: true }),
          timestamp: primitive('integer', { required: true }),
        }),
        { required: true },
      ),
    },
  },
  {
    id: 'twitter-state',
    appName: 'twitter',
    entityName: 'state',
    pathPattern: /^apps\/twitter\/data\/state\.json$/,
    description: 'Twitter UI state',
    fields: {
      draftContent: primitive('string'),
      currentUser: object(
        {
          name: primitive('string', { required: true }),
          username: primitive('string', { required: true }),
          avatar: primitive('string', { required: true }),
        },
        { required: true },
      ),
    },
  },
  {
    id: 'kira-work',
    appName: 'kira',
    entityName: 'work',
    pathPattern: /^apps\/kira\/data\/works\/[^/]+\.json$/,
    description: 'Kira work item',
    fields: {
      id: primitive('string', { required: true }),
      type: primitive('string', { required: true, enum: ['work'] }),
      projectName: primitive('string', { required: true }),
      title: primitive('string', { required: true }),
      description: primitive('string', { required: true }),
      status: primitive('string', {
        required: true,
        enum: ['todo', 'in_progress', 'in_review', 'blocked', 'done'],
      }),
      assignee: primitive('string'),
      createdAt: primitive('integer', { required: true }),
      updatedAt: primitive('integer', { required: true }),
    },
  },
  {
    id: 'kira-comment',
    appName: 'kira',
    entityName: 'comment',
    pathPattern: /^apps\/kira\/data\/comments\/[^/]+\.json$/,
    description: 'Kira comment',
    fields: {
      id: primitive('string', { required: true }),
      taskId: primitive('string', { required: true }),
      taskType: primitive('string', { required: true, enum: ['work'] }),
      author: primitive('string', { required: true }),
      body: primitive('string', { required: true }),
      createdAt: primitive('integer', { required: true }),
    },
  },
  {
    id: 'kira-state',
    appName: 'kira',
    entityName: 'state',
    pathPattern: /^apps\/kira\/data\/state\.json$/,
    description: 'Kira UI state',
    fields: {
      selectedTaskId: primitive('nullable-string'),
      activeProjectName: primitive('nullable-string'),
      previewMode: primitive('boolean', { required: true }),
    },
  },
  {
    id: 'youtube-state',
    appName: 'youtube',
    entityName: 'state',
    pathPattern: /^apps\/youtube\/data\/state\.json$/,
    description: 'YouTube launcher state',
    fields: {
      searchQuery: primitive('string', { required: true }),
      recentSearches: array(
        object({
          id: primitive('string', { required: true }),
          query: primitive('string', { required: true }),
          createdAt: primitive('integer', { required: true }),
        }),
        { required: true },
      ),
      favoriteTopics: primitive('string-array', { required: true }),
      activePlaylistId: primitive('nullable-string', { required: true }),
      lastPlayedPlaylistId: primitive('nullable-string', { required: true }),
      lastPlayedPlaylistMode: primitive('nullable-string', { required: true }),
      playlists: array(
        object({
          id: primitive('string', { required: true }),
          name: primitive('string', { required: true }),
          createdAt: primitive('integer', { required: true }),
          updatedAt: primitive('integer', { required: true }),
          items: array(
            object({
              id: primitive('string', { required: true }),
              title: primitive('string', { required: true }),
              channel: primitive('string', { required: true }),
              duration: primitive('string', { required: true }),
              views: primitive('string', { required: true }),
              published: primitive('string', { required: true }),
              thumbnail: primitive('string', { required: true }),
              url: primitive('string', { required: true }),
              addedAt: primitive('integer', { required: true }),
            }),
            { required: true },
          ),
        }),
        { required: true },
      ),
      sidebarOpen: primitive('boolean', { required: true }),
      resultsAutoHide: primitive('boolean', { required: true }),
      loopPlayback: primitive('boolean', { required: true }),
      playerZoom: primitive('number', { required: true }),
    },
  },
  {
    id: 'album-image',
    appName: 'album',
    entityName: 'image',
    pathPattern: /^apps\/album\/data\/images\/[^/]+\.json$/,
    description: 'Album image metadata',
    fields: {
      id: primitive('string', { required: true }),
      src: primitive('string', { required: true }),
      createdAt: primitive('integer', { required: true }),
    },
  },
  {
    id: 'evidencevault-file',
    appName: 'evidencevault',
    entityName: 'file',
    pathPattern: /^apps\/evidencevault\/data\/files\/[^/]+\.json$/,
    description: 'Evidence Vault file metadata',
    fields: {
      id: primitive('string', { required: true }),
      title: primitive('string', { required: true }),
      description: primitive('string', { required: true }),
      content: primitive('string', { required: true }),
      type: primitive('string', { required: true }),
      category: primitive('string', { required: true }),
      impact: primitive('string', { required: true }),
      source: primitive('string', { required: true }),
      timestamp: primitive('integer', { required: true }),
      credibility: primitive('number', { required: true }),
      importance: primitive('number', { required: true }),
      tags: primitive('string-array', { required: true }),
      vindicateText: primitive('string'),
      exposeText: primitive('string'),
    },
  },
];

export function listAppSchemas(): AppSchemaDocument[] {
  return APP_SCHEMAS;
}

export function findAppSchemaByFilePath(filePath: string): AppSchemaDocument | null {
  return APP_SCHEMAS.find((schema) => schema.pathPattern.test(filePath)) ?? null;
}

export function listSchemasForApp(appName: string): AppSchemaDocument[] {
  return APP_SCHEMAS.filter((schema) => schema.appName === appName);
}

export function validateAgainstAppSchema(
  schema: AppSchemaDocument,
  value: JsonRecord,
  filePath: string,
): AppSchemaValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const normalized: JsonRecord = { ...value };

  for (const [fieldName, fieldSchema] of Object.entries(schema.fields)) {
    normalized[fieldName] = validateField(fieldName, value[fieldName], fieldSchema, errors);
  }

  const idValue = normalized.id;
  if (typeof idValue === 'string') {
    const fileName = filePath.split('/').pop()?.replace(/\.json$/i, '') || '';
    if (fileName && idValue !== fileName) {
      errors.push(`id must match the filename (${fileName})`);
    }
  }

  if (schema.id === 'album-image') {
    const src = normalized.src;
    if (
      typeof src === 'string' &&
      src &&
      !/^https?:\/\//i.test(src) &&
      !/^data:image\//i.test(src)
    ) {
      errors.push('src must be an https URL or data:image URL');
    }
  }

  if (schema.id === 'calendar-event') {
    if (typeof normalized.remindBeforeMinutes === 'number' && normalized.remindBeforeMinutes < 0) {
      errors.push('remindBeforeMinutes must be >= 0');
    }
    if (!('lastReminderSentAt' in value) && normalized.completed === false) {
      warnings.push('Consider omitting or resetting lastReminderSentAt when changing event timing.');
    }
  }

  if (schema.id === 'twitter-post' && typeof normalized.content === 'string' && normalized.content.length > 280) {
    warnings.push('Twitter post content exceeds the documented 280 character guideline.');
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, normalized, warnings };
}
