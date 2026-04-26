import {
  findAppSchemaByFilePath,
  validateAgainstAppSchema,
} from './appSchemaRegistry';

interface ValidationSuccess {
  ok: true;
  normalizedContent: string;
  schemaId: string;
  warnings: string[];
}

interface ValidationFailure {
  ok: false;
  errors: string[];
  schemaId: string;
}

export type AppDataValidationResult = ValidationSuccess | ValidationFailure;

type JsonRecord = Record<string, unknown>;

interface SchemaDefinition {
  schemaId: string;
  match: RegExp;
  validate: (value: JsonRecord, filePath: string) => { normalized: JsonRecord; errors: string[]; warnings: string[] };
}

function getFileNameWithoutExtension(filePath: string): string {
  const fileName = filePath.split('/').pop() || filePath;
  return fileName.replace(/\.json$/i, '');
}

function isObject(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.floor(value) === value;
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

function isIsoDateTime(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function isDateString(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function requireString(record: JsonRecord, key: string, errors: string[]): string {
  const value = record[key];
  if (typeof value !== 'string') {
    errors.push(`${key} must be a string`);
    return '';
  }
  return value;
}

function optionalString(record: JsonRecord, key: string, errors: string[]): string | null {
  const value = record[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    errors.push(`${key} must be a string when present`);
    return null;
  }
  return value;
}

function requireInteger(record: JsonRecord, key: string, errors: string[]): number {
  const value = record[key];
  if (!isInteger(value)) {
    errors.push(`${key} must be an integer`);
    return 0;
  }
  return value;
}

function requireBoolean(record: JsonRecord, key: string, errors: string[]): boolean {
  const value = record[key];
  if (!isBoolean(value)) {
    errors.push(`${key} must be a boolean`);
    return false;
  }
  return value;
}

function requireStringArray(record: JsonRecord, key: string, errors: string[]): string[] {
  const value = record[key];
  if (!isStringArray(value)) {
    errors.push(`${key} must be an array of strings`);
    return [];
  }
  return value;
}

function requireEnum<T extends string>(
  record: JsonRecord,
  key: string,
  allowed: readonly T[],
  errors: string[],
): T {
  const value = record[key];
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    errors.push(`${key} must be one of: ${allowed.join(', ')}`);
    return allowed[0];
  }
  return value as T;
}

function requireObject(record: JsonRecord, key: string, errors: string[]): JsonRecord {
  const value = record[key];
  if (!isObject(value)) {
    errors.push(`${key} must be an object`);
    return {};
  }
  return value;
}

function optionalInteger(record: JsonRecord, key: string, errors: string[]): number | null {
  const value = record[key];
  if (value === undefined || value === null) return null;
  if (!isInteger(value)) {
    errors.push(`${key} must be an integer when present`);
    return null;
  }
  return value;
}

function validateIdMatchesFile(record: JsonRecord, filePath: string, errors: string[]): string {
  const id = requireString(record, 'id', errors);
  if (id && id !== getFileNameWithoutExtension(filePath)) {
    errors.push(`id must match the filename (${getFileNameWithoutExtension(filePath)})`);
  }
  return id;
}

function validateBrowserState(record: JsonRecord): { normalized: JsonRecord; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const normalized = {
    ...record,
    currentUrl: requireString(record, 'currentUrl', errors),
    inputUrl: requireString(record, 'inputUrl', errors),
    viewMode: requireEnum(record, 'viewMode', ['browse', 'reader'] as const, errors),
    sidebarOpen: requireBoolean(record, 'sidebarOpen', errors),
  };
  return { normalized, errors, warnings: [] };
}

function validateBrowserBookmark(record: JsonRecord, filePath: string) {
  const errors: string[] = [];
  const normalized = {
    ...record,
    id: validateIdMatchesFile(record, filePath, errors),
    url: requireString(record, 'url', errors),
    title: requireString(record, 'title', errors),
    createdAt: requireInteger(record, 'createdAt', errors),
  };
  return { normalized, errors, warnings: [] };
}

function validateBrowserHistory(record: JsonRecord, filePath: string) {
  const errors: string[] = [];
  const normalized = {
    ...record,
    id: validateIdMatchesFile(record, filePath, errors),
    url: requireString(record, 'url', errors),
    title: requireString(record, 'title', errors),
    visitedAt: requireInteger(record, 'visitedAt', errors),
  };
  return { normalized, errors, warnings: [] };
}

function validateCalendarEvent(record: JsonRecord, filePath: string) {
  const errors: string[] = [];
  const warnings: string[] = [];
  const startAt = record.startAt;
  if (!isIsoDateTime(startAt)) errors.push('startAt must be a valid ISO datetime string');
  const normalized = {
    ...record,
    id: validateIdMatchesFile(record, filePath, errors),
    title: requireString(record, 'title', errors),
    notes: requireString(record, 'notes', errors),
    startAt: typeof startAt === 'string' ? startAt : '',
    remindBeforeMinutes: requireInteger(record, 'remindBeforeMinutes', errors),
    completed: requireBoolean(record, 'completed', errors),
    createdAt: requireInteger(record, 'createdAt', errors),
    updatedAt: requireInteger(record, 'updatedAt', errors),
  };
  const lastReminderSentAt = optionalInteger(record, 'lastReminderSentAt', errors);
  if (lastReminderSentAt !== null) normalized.lastReminderSentAt = lastReminderSentAt;
  if (normalized.remindBeforeMinutes < 0) {
    errors.push('remindBeforeMinutes must be >= 0');
  }
  if (!('lastReminderSentAt' in record) && normalized.completed === false) {
    warnings.push('Consider omitting or resetting lastReminderSentAt when changing event timing.');
  }
  return { normalized, errors, warnings };
}

function validateCalendarState(record: JsonRecord) {
  const errors: string[] = [];
  const value = record.selectedEventId;
  if (!(typeof value === 'string' || value === null || value === undefined)) {
    errors.push('selectedEventId must be a string or null');
  }
  return {
    normalized: {
      ...record,
      selectedEventId: typeof value === 'string' || value === null ? value : null,
    },
    errors,
    warnings: [],
  };
}

function validateDiaryEntry(record: JsonRecord, filePath: string) {
  const errors: string[] = [];
  const normalized = {
    ...record,
    id: validateIdMatchesFile(record, filePath, errors),
    date: isDateString(record.date) ? (record.date as string) : (() => {
      errors.push('date must be YYYY-MM-DD');
      return '';
    })(),
    title: requireString(record, 'title', errors),
    content: requireString(record, 'content', errors),
    createdAt: requireInteger(record, 'createdAt', errors),
    updatedAt: requireInteger(record, 'updatedAt', errors),
  };
  const mood = optionalString(record, 'mood', errors);
  const weather = optionalString(record, 'weather', errors);
  if (mood !== null) normalized.mood = mood;
  if (weather !== null) normalized.weather = weather;
  return { normalized, errors, warnings: [] };
}

function validateDiaryState(record: JsonRecord) {
  const errors: string[] = [];
  const value = record.selectedDate;
  if (!(typeof value === 'string' || value === null)) {
    errors.push('selectedDate must be a string or null');
  }
  return {
    normalized: { ...record, selectedDate: typeof value === 'string' || value === null ? value : null },
    errors,
    warnings: [],
  };
}

function validateNotesNote(record: JsonRecord, filePath: string) {
  const errors: string[] = [];
  const normalized = {
    ...record,
    id: validateIdMatchesFile(record, filePath, errors),
    title: requireString(record, 'title', errors),
    content: requireString(record, 'content', errors),
    tags: requireStringArray(record, 'tags', errors),
    pinned: requireBoolean(record, 'pinned', errors),
    createdAt: requireInteger(record, 'createdAt', errors),
    updatedAt: requireInteger(record, 'updatedAt', errors),
  };
  return { normalized, errors, warnings: [] };
}

function validateNotesState(record: JsonRecord) {
  const errors: string[] = [];
  const selectedNoteId = record.selectedNoteId;
  const activeTag = record.activeTag;
  if (!(typeof selectedNoteId === 'string' || selectedNoteId === null || selectedNoteId === undefined)) {
    errors.push('selectedNoteId must be a string or null');
  }
  if (!(typeof activeTag === 'string' || activeTag === null || activeTag === undefined)) {
    errors.push('activeTag must be a string or null');
  }
  return {
    normalized: {
      ...record,
      selectedNoteId: typeof selectedNoteId === 'string' || selectedNoteId === null ? selectedNoteId : null,
      activeTag: typeof activeTag === 'string' || activeTag === null ? activeTag : null,
      searchQuery: requireString(record, 'searchQuery', errors),
      previewMode: requireBoolean(record, 'previewMode', errors),
    },
    errors,
    warnings: [],
  };
}

function validateEmailAddress(record: JsonRecord, fieldPrefix: string, errors: string[]) {
  return {
    name: requireString(record, `${fieldPrefix}.name`, errors),
    address: requireString(record, `${fieldPrefix}.address`, errors),
  };
}

function validateEmail(record: JsonRecord, filePath: string) {
  const errors: string[] = [];
  const from = requireObject(record, 'from', errors);
  const to = Array.isArray(record.to) ? record.to : (() => {
    errors.push('to must be an array');
    return [];
  })();
  const cc = Array.isArray(record.cc) ? record.cc : (() => {
    errors.push('cc must be an array');
    return [];
  })();
  const normalized = {
    ...record,
    id: validateIdMatchesFile(record, filePath, errors),
    from: validateEmailAddress(
      { 'from.name': from.name, 'from.address': from.address },
      'from',
      errors,
    ),
    to: to.map((item, index) =>
      validateEmailAddress(
        {
          [`to.${index}.name`]: isObject(item) ? item.name : undefined,
          [`to.${index}.address`]: isObject(item) ? item.address : undefined,
        },
        `to.${index}`,
        errors,
      ),
    ),
    cc: cc.map((item, index) =>
      validateEmailAddress(
        {
          [`cc.${index}.name`]: isObject(item) ? item.name : undefined,
          [`cc.${index}.address`]: isObject(item) ? item.address : undefined,
        },
        `cc.${index}`,
        errors,
      ),
    ),
    subject: requireString(record, 'subject', errors),
    content: requireString(record, 'content', errors),
    timestamp: requireInteger(record, 'timestamp', errors),
    isRead: requireBoolean(record, 'isRead', errors),
    isStarred: requireBoolean(record, 'isStarred', errors),
    folder: requireEnum(record, 'folder', ['inbox', 'sent', 'drafts', 'trash'] as const, errors),
  };
  return { normalized, errors, warnings: [] };
}

function validateEmailState(record: JsonRecord) {
  const errors: string[] = [];
  const selected = record.selectedEmailId;
  return {
    normalized: {
      ...record,
      selectedEmailId: typeof selected === 'string' || selected === null ? selected : null,
      currentFolder: requireEnum(record, 'currentFolder', ['inbox', 'sent', 'drafts', 'trash'] as const, errors),
    },
    errors,
    warnings: [],
  };
}

function validateTwitterAuthor(record: JsonRecord, prefix: string, errors: string[]) {
  return {
    name: requireString(record, `${prefix}.name`, errors),
    username: requireString(record, `${prefix}.username`, errors),
    avatar: requireString(record, `${prefix}.avatar`, errors),
  };
}

function validateTwitterPost(record: JsonRecord, filePath: string) {
  const errors: string[] = [];
  const warnings: string[] = [];
  const author = requireObject(record, 'author', errors);
  const comments = Array.isArray(record.comments) ? record.comments : (() => {
    errors.push('comments must be an array');
    return [];
  })();
  const normalized = {
    ...record,
    id: validateIdMatchesFile(record, filePath, errors),
    author: validateTwitterAuthor(
      { 'author.name': author.name, 'author.username': author.username, 'author.avatar': author.avatar },
      'author',
      errors,
    ),
    content: requireString(record, 'content', errors),
    timestamp: requireInteger(record, 'timestamp', errors),
    likes: requireInteger(record, 'likes', errors),
    isLiked: requireBoolean(record, 'isLiked', errors),
    comments: comments.map((item, index) => {
      const comment = isObject(item) ? item : {};
      const authorRecord = isObject(comment.author) ? comment.author : {};
      return {
        ...comment,
        id: requireString(comment, 'id', errors),
        author: validateTwitterAuthor(
          {
            [`comments.${index}.author.name`]: authorRecord.name,
            [`comments.${index}.author.username`]: authorRecord.username,
            [`comments.${index}.author.avatar`]: authorRecord.avatar,
          },
          `comments.${index}.author`,
          errors,
        ),
        content: requireString(comment, 'content', errors),
        timestamp: requireInteger(comment, 'timestamp', errors),
      };
    }),
  };
  if (normalized.content.length > 280) warnings.push('Twitter post content exceeds the documented 280 character guideline.');
  return { normalized, errors, warnings };
}

function validateTwitterState(record: JsonRecord) {
  const errors: string[] = [];
  const currentUser = requireObject(record, 'currentUser', errors);
  return {
    normalized: {
      ...record,
      draftContent: optionalString(record, 'draftContent', errors) ?? '',
      currentUser: validateTwitterAuthor(
        {
          'currentUser.name': currentUser.name,
          'currentUser.username': currentUser.username,
          'currentUser.avatar': currentUser.avatar,
        },
        'currentUser',
        errors,
      ),
    },
    errors,
    warnings: [],
  };
}

function validateKiraWork(record: JsonRecord, filePath: string) {
  const errors: string[] = [];
  const normalized = {
    ...record,
    id: validateIdMatchesFile(record, filePath, errors),
    type: requireEnum(record, 'type', ['work'] as const, errors),
    projectName: requireString(record, 'projectName', errors),
    title: requireString(record, 'title', errors),
    description: requireString(record, 'description', errors),
    status: requireEnum(record, 'status', ['todo', 'in_progress', 'in_review', 'blocked', 'done'] as const, errors),
    createdAt: requireInteger(record, 'createdAt', errors),
    updatedAt: requireInteger(record, 'updatedAt', errors),
  };
  const assignee = optionalString(record, 'assignee', errors);
  if (assignee !== null) normalized.assignee = assignee;
  return { normalized, errors, warnings: [] };
}

function validateKiraComment(record: JsonRecord, filePath: string) {
  const errors: string[] = [];
  const normalized = {
    ...record,
    id: validateIdMatchesFile(record, filePath, errors),
    taskId: requireString(record, 'taskId', errors),
    taskType: requireEnum(record, 'taskType', ['work'] as const, errors),
    author: requireString(record, 'author', errors),
    body: requireString(record, 'body', errors),
    createdAt: requireInteger(record, 'createdAt', errors),
  };
  return { normalized, errors, warnings: [] };
}

function validateKiraState(record: JsonRecord) {
  const errors: string[] = [];
  const selectedTaskId = record.selectedTaskId;
  const activeProjectName = record.activeProjectName;
  return {
    normalized: {
      ...record,
      selectedTaskId: typeof selectedTaskId === 'string' || selectedTaskId === null ? selectedTaskId : null,
      activeProjectName: typeof activeProjectName === 'string' || activeProjectName === null ? activeProjectName : null,
      previewMode: requireBoolean(record, 'previewMode', errors),
    },
    errors,
    warnings: [],
  };
}

function validateYouTubeState(record: JsonRecord) {
  const errors: string[] = [];
  const recentSearches = Array.isArray(record.recentSearches) ? record.recentSearches : (() => {
    errors.push('recentSearches must be an array');
    return [];
  })();
  const playlists = Array.isArray(record.playlists) ? record.playlists : (() => {
    errors.push('playlists must be an array');
    return [];
  })();
  const normalized = {
    ...record,
    searchQuery: requireString(record, 'searchQuery', errors),
    favoriteTopics: requireStringArray(record, 'favoriteTopics', errors),
    activePlaylistId:
      typeof record.activePlaylistId === 'string' || record.activePlaylistId === null
        ? record.activePlaylistId
        : null,
    lastPlayedPlaylistId:
      typeof record.lastPlayedPlaylistId === 'string' || record.lastPlayedPlaylistId === null
        ? record.lastPlayedPlaylistId
        : null,
    lastPlayedPlaylistMode:
      record.lastPlayedPlaylistMode === 'sequential' ||
      record.lastPlayedPlaylistMode === 'shuffle' ||
      record.lastPlayedPlaylistMode === null
        ? record.lastPlayedPlaylistMode
        : null,
    sidebarOpen: requireBoolean(record, 'sidebarOpen', errors),
    resultsAutoHide: requireBoolean(record, 'resultsAutoHide', errors),
    loopPlayback: requireBoolean(record, 'loopPlayback', errors),
    playerZoom: typeof record.playerZoom === 'number' ? record.playerZoom : (() => {
      errors.push('playerZoom must be a number');
      return 1;
    })(),
    recentSearches: recentSearches.map((item) => {
      const entry = isObject(item) ? item : {};
      return {
        id: requireString(entry, 'id', errors),
        query: requireString(entry, 'query', errors),
        createdAt: requireInteger(entry, 'createdAt', errors),
      };
    }),
    playlists: playlists.map((playlist) => {
      const entry = isObject(playlist) ? playlist : {};
      const items = Array.isArray(entry.items) ? entry.items : [];
      if (!Array.isArray(entry.items)) {
        errors.push('playlist.items must be an array');
      }
      return {
        id: requireString(entry, 'id', errors),
        name: requireString(entry, 'name', errors),
        createdAt: requireInteger(entry, 'createdAt', errors),
        updatedAt: requireInteger(entry, 'updatedAt', errors),
        items: items.map((item) => {
          const playlistItem = isObject(item) ? item : {};
          return {
            id: requireString(playlistItem, 'id', errors),
            title: requireString(playlistItem, 'title', errors),
            channel: requireString(playlistItem, 'channel', errors),
            duration: requireString(playlistItem, 'duration', errors),
            views: requireString(playlistItem, 'views', errors),
            published: requireString(playlistItem, 'published', errors),
            thumbnail: requireString(playlistItem, 'thumbnail', errors),
            url: requireString(playlistItem, 'url', errors),
            addedAt: requireInteger(playlistItem, 'addedAt', errors),
          };
        }),
      };
    }),
  };
  return { normalized, errors, warnings: [] };
}

function validateAlbumImage(record: JsonRecord, filePath: string) {
  const errors: string[] = [];
  const src = requireString(record, 'src', errors);
  if (src && !/^https?:\/\//i.test(src) && !/^data:image\//i.test(src)) {
    errors.push('src must be an https URL or data:image URL');
  }
  const normalized = {
    ...record,
    id: validateIdMatchesFile(record, filePath, errors),
    src,
    createdAt: requireInteger(record, 'createdAt', errors),
  };
  return { normalized, errors, warnings: [] };
}

function validateCyberNewsArticle(record: JsonRecord, filePath: string) {
  const errors: string[] = [];
  const normalized = {
    ...record,
    id: validateIdMatchesFile(record, filePath, errors),
    title: requireString(record, 'title', errors),
    category: requireEnum(record, 'category', ['breaking', 'corporate', 'street', 'tech'] as const, errors),
    summary: requireString(record, 'summary', errors),
    content: requireString(record, 'content', errors),
    imageUrl: requireString(record, 'imageUrl', errors),
    publishedAt: isIsoDateTime(record.publishedAt)
      ? (record.publishedAt as string)
      : (() => {
          errors.push('publishedAt must be a valid ISO datetime string');
          return '';
        })(),
  };
  return { normalized, errors, warnings: [] };
}

function validateCyberNewsCase(record: JsonRecord, filePath: string) {
  const errors: string[] = [];
  const clues = Array.isArray(record.clues) ? record.clues : (() => {
    errors.push('clues must be an array');
    return [];
  })();
  const normalized = {
    ...record,
    id: validateIdMatchesFile(record, filePath, errors),
    caseNumber: requireString(record, 'caseNumber', errors),
    title: requireString(record, 'title', errors),
    status: requireEnum(record, 'status', ['open', 'closed', 'classified'] as const, errors),
    clues: clues.map((item) => {
      const clue = isObject(item) ? item : {};
      return {
        ...clue,
        id: requireString(clue, 'id', errors),
        type: requireEnum(clue, 'type', ['press', 'report', 'document', 'message', 'note'] as const, errors),
        title: requireString(clue, 'title', errors),
        content: requireString(clue, 'content', errors),
        posX: typeof clue.posX === 'number' ? clue.posX : (() => {
          errors.push('clue.posX must be a number');
          return 0;
        })(),
        posY: typeof clue.posY === 'number' ? clue.posY : (() => {
          errors.push('clue.posY must be a number');
          return 0;
        })(),
      };
    }),
  };
  return { normalized, errors, warnings: [] };
}

function validateEvidenceVaultFile(record: JsonRecord, filePath: string) {
  const errors: string[] = [];
  const normalized = {
    ...record,
    id: validateIdMatchesFile(record, filePath, errors),
    title: requireString(record, 'title', errors),
    description: requireString(record, 'description', errors),
    content: requireString(record, 'content', errors),
    type: requireString(record, 'type', errors),
    category: requireString(record, 'category', errors),
    impact: requireString(record, 'impact', errors),
    source: requireString(record, 'source', errors),
    timestamp: requireInteger(record, 'timestamp', errors),
    credibility:
      typeof record.credibility === 'number' && Number.isFinite(record.credibility)
        ? record.credibility
        : (() => {
            errors.push('credibility must be a number');
            return 0;
          })(),
    importance:
      typeof record.importance === 'number' && Number.isFinite(record.importance)
        ? record.importance
        : (() => {
            errors.push('importance must be a number');
            return 0;
          })(),
    tags: requireStringArray(record, 'tags', errors),
  };
  const vindicateText = optionalString(record, 'vindicateText', errors);
  const exposeText = optionalString(record, 'exposeText', errors);
  if (vindicateText !== null) normalized.vindicateText = vindicateText;
  if (exposeText !== null) normalized.exposeText = exposeText;
  return { normalized, errors, warnings: [] };
}

function validateChessPiece(value: unknown, errors: string[]): JsonRecord | null {
  if (value === null) return null;
  if (!isObject(value)) {
    errors.push('piece must be an object or null');
    return null;
  }
  const type = requireEnum(value, 'type', ['K', 'Q', 'R', 'B', 'N', 'P'] as const, errors);
  const color = requireEnum(value, 'color', ['w', 'b'] as const, errors);
  return { type, color };
}

function validateChessPositionArray(value: unknown, key: string, errors: string[]): [number, number] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length !== 2 || !value.every((item) => isInteger(item))) {
    errors.push(`${key} must be [number, number] or null`);
    return null;
  }
  return [value[0] as number, value[1] as number];
}

function validateChessState(record: JsonRecord) {
  const errors: string[] = [];
  const board = Array.isArray(record.board) ? record.board : (() => {
    errors.push('board must be a 2D array');
    return [];
  })();
  const normalizedBoard = board.map((row) =>
    Array.isArray(row) ? row.map((cell) => validateChessPiece(cell, errors)) : [],
  );
  const castlingRights = requireObject(record, 'castlingRights', errors);
  const moveHistory = Array.isArray(record.moveHistory) ? record.moveHistory : (() => {
    errors.push('moveHistory must be an array');
    return [];
  })();
  const normalized = {
    ...record,
    board: normalizedBoard,
    currentTurn: requireEnum(record, 'currentTurn', ['w', 'b'] as const, errors),
    castlingRights: {
      wK: requireBoolean(castlingRights, 'wK', errors),
      wQ: requireBoolean(castlingRights, 'wQ', errors),
      bK: requireBoolean(castlingRights, 'bK', errors),
      bQ: requireBoolean(castlingRights, 'bQ', errors),
    },
    enPassantTarget: validateChessPositionArray(record.enPassantTarget, 'enPassantTarget', errors),
    halfMoveClock: requireInteger(record, 'halfMoveClock', errors),
    moveHistory: moveHistory.map((move) => {
      const item = isObject(move) ? move : {};
      return {
        from: validateChessPositionArray(item.from, 'move.from', errors),
        to: validateChessPositionArray(item.to, 'move.to', errors),
        piece: validateChessPiece(item.piece, errors),
        captured: validateChessPiece(item.captured, errors),
        promotion:
          item.promotion === null || item.promotion === undefined
            ? null
            : requireEnum(item, 'promotion', ['K', 'Q', 'R', 'B', 'N', 'P'] as const, errors),
        castling:
          item.castling === null || item.castling === undefined
            ? null
            : requireEnum(item, 'castling', ['K', 'Q'] as const, errors),
        enPassant: requireBoolean(item, 'enPassant', errors),
      };
    }),
    gameStatus: requireEnum(
      record,
      'gameStatus',
      ['playing', 'check', 'checkmate', 'stalemate', 'draw'] as const,
      errors,
    ),
    winner:
      record.winner === null || record.winner === undefined
        ? null
        : requireEnum(record, 'winner', ['w', 'b'] as const, errors),
    gameId: requireString(record, 'gameId', errors),
    lastMove: isObject(record.lastMove)
      ? {
          from: validateChessPositionArray((record.lastMove as JsonRecord).from, 'lastMove.from', errors),
          to: validateChessPositionArray((record.lastMove as JsonRecord).to, 'lastMove.to', errors),
        }
      : null,
    isAgentThinking: requireBoolean(record, 'isAgentThinking', errors),
  };
  return { normalized, errors, warnings: [] };
}

function validateGomokuHistory(record: JsonRecord, filePath: string) {
  const errors: string[] = [];
  const players = Array.isArray(record.players) ? record.players : (() => {
    errors.push('players must be an array');
    return [];
  })();
  const moves = Array.isArray(record.moves) ? record.moves : (() => {
    errors.push('moves must be an array');
    return [];
  })();
  const normalized = {
    ...record,
    id: validateIdMatchesFile(record, filePath, errors),
    players: players.map((player) => {
      const item = isObject(player) ? player : {};
      return {
        name: requireString(item, 'name', errors),
        color: requireEnum(item, 'color', ['black', 'white'] as const, errors),
        role: requireEnum(item, 'role', ['human', 'agent'] as const, errors),
      };
    }),
    moves: moves.map((move) => {
      const item = isObject(move) ? move : {};
      const position = requireObject(item, 'position', errors);
      return {
        position: {
          row: requireInteger(position, 'row', errors),
          col: requireInteger(position, 'col', errors),
        },
        color: requireEnum(item, 'color', ['black', 'white'] as const, errors),
        moveNumber: requireInteger(item, 'moveNumber', errors),
        timestamp: requireInteger(item, 'timestamp', errors),
      };
    }),
    result:
      record.result === null || record.result === undefined
        ? null
        : (() => {
            const result = isObject(record.result) ? record.result : {};
            const winLine = result.winLine;
            return {
              winner:
                result.winner === null || result.winner === undefined
                  ? null
                  : requireEnum(result, 'winner', ['black', 'white'] as const, errors),
              winLine:
                winLine === null || winLine === undefined
                  ? null
                  : (() => {
                      const line = isObject(winLine) ? winLine : {};
                      const positions = Array.isArray(line.positions) ? line.positions : (() => {
                        errors.push('result.winLine.positions must be an array');
                        return [];
                      })();
                      return {
                        positions: positions.map((position) => {
                          const item = isObject(position) ? position : {};
                          return {
                            row: requireInteger(item, 'row', errors),
                            col: requireInteger(item, 'col', errors),
                          };
                        }),
                        color: requireEnum(line, 'color', ['black', 'white'] as const, errors),
                      };
                    })(),
              reason: requireEnum(result, 'reason', ['five-in-a-row', 'surrender', 'draw'] as const, errors),
            };
          })(),
    startedAt: requireInteger(record, 'startedAt', errors),
    endedAt: record.endedAt === null ? null : requireInteger(record, 'endedAt', errors),
  };
  return { normalized, errors, warnings: [] };
}

function validateGomokuState(record: JsonRecord) {
  const errors: string[] = [];
  const stats = requireObject(record, 'stats', errors);
  return {
    normalized: {
      ...record,
      currentGameId:
        typeof record.currentGameId === 'string' || record.currentGameId === null
          ? record.currentGameId ?? null
          : null,
      totalGames: requireInteger(record, 'totalGames', errors),
      stats: {
        blackWins: requireInteger(stats, 'blackWins', errors),
        whiteWins: requireInteger(stats, 'whiteWins', errors),
        draws: requireInteger(stats, 'draws', errors),
      },
    },
    errors,
    warnings: [],
  };
}

function validateFreeCellCard(value: unknown, errors: string[]): JsonRecord | null {
  if (value === null) return null;
  if (!isObject(value)) {
    errors.push('card must be an object or null');
    return null;
  }
  return {
    suit: requireEnum(value, 'suit', ['hearts', 'diamonds', 'clubs', 'spades'] as const, errors),
    rank: requireInteger(value, 'rank', errors),
  };
}

function validateFreeCellState(record: JsonRecord) {
  const errors: string[] = [];
  const columns = Array.isArray(record.columns) ? record.columns : (() => {
    errors.push('columns must be an array');
    return [];
  })();
  const freeCells = Array.isArray(record.freeCells) ? record.freeCells : (() => {
    errors.push('freeCells must be an array');
    return [];
  })();
  const foundations = requireObject(record, 'foundations', errors);
  const normalized = {
    ...record,
    columns: columns.map((column) => (Array.isArray(column) ? column.map((card) => validateFreeCellCard(card, errors)) : [])),
    freeCells: freeCells.map((cell) => validateFreeCellCard(cell, errors)),
    foundations: {
      hearts: Array.isArray(foundations.hearts)
        ? foundations.hearts.map((card) => validateFreeCellCard(card, errors))
        : [],
      diamonds: Array.isArray(foundations.diamonds)
        ? foundations.diamonds.map((card) => validateFreeCellCard(card, errors))
        : [],
      clubs: Array.isArray(foundations.clubs)
        ? foundations.clubs.map((card) => validateFreeCellCard(card, errors))
        : [],
      spades: Array.isArray(foundations.spades)
        ? foundations.spades.map((card) => validateFreeCellCard(card, errors))
        : [],
    },
    moveCount: requireInteger(record, 'moveCount', errors),
    gameStatus: requireEnum(record, 'gameStatus', ['playing', 'won'] as const, errors),
    gameId: requireString(record, 'gameId', errors),
  };
  return { normalized, errors, warnings: [] };
}

function validateGenericState(record: JsonRecord, requiredKeys: Array<[string, 'string' | 'boolean' | 'number' | 'nullable-string']>) {
  const errors: string[] = [];
  const normalized: JsonRecord = { ...record };
  for (const [key, type] of requiredKeys) {
    if (type === 'string') normalized[key] = requireString(record, key, errors);
    else if (type === 'boolean') normalized[key] = requireBoolean(record, key, errors);
    else if (type === 'number') {
      const value = record[key];
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        errors.push(`${key} must be a number`);
        normalized[key] = 0;
      } else normalized[key] = value;
    } else {
      const value = record[key];
      if (!(typeof value === 'string' || value === null || value === undefined)) {
        errors.push(`${key} must be a string or null`);
        normalized[key] = null;
      } else normalized[key] = value ?? null;
    }
  }
  return { normalized, errors, warnings: [] };
}

const SCHEMAS: SchemaDefinition[] = [
  { schemaId: 'browser-bookmark', match: /^apps\/browser\/data\/bookmarks\/[^/]+\.json$/, validate: validateBrowserBookmark },
  { schemaId: 'browser-history', match: /^apps\/browser\/data\/history\/[^/]+\.json$/, validate: validateBrowserHistory },
  { schemaId: 'browser-state', match: /^apps\/browser\/data\/state\.json$/, validate: validateBrowserState },
  { schemaId: 'calendar-event', match: /^apps\/calendar\/data\/events\/[^/]+\.json$/, validate: validateCalendarEvent },
  { schemaId: 'calendar-state', match: /^apps\/calendar\/data\/state\.json$/, validate: validateCalendarState },
  { schemaId: 'diary-entry', match: /^apps\/diary\/data\/entries\/[^/]+\.json$/, validate: validateDiaryEntry },
  { schemaId: 'diary-state', match: /^apps\/diary\/data\/state\.json$/, validate: validateDiaryState },
  { schemaId: 'notes-note', match: /^apps\/notes\/data\/notes\/[^/]+\.json$/, validate: validateNotesNote },
  { schemaId: 'notes-state', match: /^apps\/notes\/data\/state\.json$/, validate: validateNotesState },
  { schemaId: 'email-email', match: /^apps\/email\/data\/emails\/[^/]+\.json$/, validate: validateEmail },
  { schemaId: 'email-state', match: /^apps\/email\/data\/state\.json$/, validate: validateEmailState },
  { schemaId: 'twitter-post', match: /^apps\/twitter\/data\/posts\/[^/]+\.json$/, validate: validateTwitterPost },
  { schemaId: 'twitter-state', match: /^apps\/twitter\/data\/state\.json$/, validate: validateTwitterState },
  { schemaId: 'kira-work', match: /^apps\/kira\/data\/works\/[^/]+\.json$/, validate: validateKiraWork },
  { schemaId: 'kira-comment', match: /^apps\/kira\/data\/comments\/[^/]+\.json$/, validate: validateKiraComment },
  { schemaId: 'kira-state', match: /^apps\/kira\/data\/state\.json$/, validate: validateKiraState },
  { schemaId: 'youtube-state', match: /^apps\/youtube\/data\/state\.json$/, validate: validateYouTubeState },
  { schemaId: 'album-image', match: /^apps\/album\/data\/images\/[^/]+\.json$/, validate: validateAlbumImage },
  { schemaId: 'evidencevault-file', match: /^apps\/evidencevault\/data\/files\/[^/]+\.json$/, validate: validateEvidenceVaultFile },
  { schemaId: 'chess-state', match: /^apps\/chess\/data\/state\.json$/, validate: validateChessState },
  { schemaId: 'gomoku-history', match: /^apps\/gomoku\/data\/history\/[^/]+\.json$/, validate: validateGomokuHistory },
  { schemaId: 'gomoku-state', match: /^apps\/gomoku\/data\/state\.json$/, validate: validateGomokuState },
  { schemaId: 'freecell-state', match: /^apps\/freecell\/data\/state\.json$/, validate: validateFreeCellState },
  { schemaId: 'cybernews-article', match: /^apps\/cyberNews\/data\/articles\/[^/]+\.json$/, validate: validateCyberNewsArticle },
  { schemaId: 'cybernews-case', match: /^apps\/cyberNews\/data\/cases\/[^/]+\.json$/, validate: validateCyberNewsCase },
  {
    schemaId: 'cybernews-state',
    match: /^apps\/cyberNews\/data\/state\.json$/,
    validate: (record) =>
      validateGenericState(record, [
        ['currentView', 'string'],
        ['selectedArticleId', 'nullable-string'],
        ['selectedCaseId', 'nullable-string'],
        ['newsFilter', 'nullable-string'],
      ]),
  },
];

export function validateAppDataWrite(filePath: string, rawJsonContent: string): AppDataValidationResult | null {
  const registrySchema = findAppSchemaByFilePath(filePath);
  if (registrySchema) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawJsonContent);
    } catch (error) {
      return {
        ok: false,
        schemaId: registrySchema.id,
        errors: [`JSON parse failed before schema validation: ${String(error)}`],
      };
    }

    if (!isObject(parsed)) {
      return {
        ok: false,
        schemaId: registrySchema.id,
        errors: ['Expected a JSON object for this schema'],
      };
    }

    const result = validateAgainstAppSchema(registrySchema, parsed, filePath);
    if (!result.ok) {
      return {
        ok: false,
        schemaId: registrySchema.id,
        errors: result.errors,
      };
    }

    return {
      ok: true,
      schemaId: registrySchema.id,
      normalizedContent: JSON.stringify(result.normalized, null, 2),
      warnings: result.warnings,
    };
  }

  const schema = SCHEMAS.find((entry) => entry.match.test(filePath));
  if (!schema) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJsonContent);
  } catch (error) {
    return {
      ok: false,
      schemaId: schema.schemaId,
      errors: [`JSON parse failed before schema validation: ${String(error)}`],
    };
  }

  if (!isObject(parsed)) {
    return {
      ok: false,
      schemaId: schema.schemaId,
      errors: ['Expected a JSON object for this schema'],
    };
  }

  const { normalized, errors, warnings } = schema.validate(parsed, filePath);
  if (errors.length > 0) {
    return { ok: false, schemaId: schema.schemaId, errors };
  }

  return {
    ok: true,
    schemaId: schema.schemaId,
    normalizedContent: JSON.stringify(normalized, null, 2),
    warnings,
  };
}
