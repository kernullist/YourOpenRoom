export interface ParsedAppActionToolParams {
  appName: string;
  actionType: string;
  params: Record<string, string>;
}

export interface ParsedAppActionToolParamsWithValidation extends ParsedAppActionToolParams {
  parseErrors: string[];
  paramsMalformed: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringifyActionParam(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null || value === undefined) return '';
  return JSON.stringify(value);
}

export function normalizeAppActionParams(value: unknown): Record<string, string> {
  return normalizeAppActionParamsWithValidation(value).params;
}

export function normalizeAppActionParamsWithValidation(value: unknown): {
  params: Record<string, string>;
  parseErrors: string[];
  paramsMalformed: boolean;
} {
  let rawParams: unknown = value;
  const parseErrors: string[] = [];

  if (typeof rawParams === 'string') {
    const trimmed = rawParams.trim();
    if (!trimmed) {
      return { params: {}, parseErrors, paramsMalformed: false };
    }

    try {
      rawParams = JSON.parse(trimmed);
    } catch {
      parseErrors.push('params_malformed_json');
      return { params: {}, parseErrors, paramsMalformed: true };
    }
  }

  const record = asRecord(rawParams);
  if (!record) {
    if (rawParams !== undefined && rawParams !== null) {
      parseErrors.push('params_not_object');
    }
    return { params: {}, parseErrors, paramsMalformed: parseErrors.length > 0 };
  }

  return {
    params: Object.fromEntries(
      Object.entries(record)
        .filter(([, entryValue]) => entryValue !== undefined)
        .map(([entryKey, entryValue]) => [entryKey, stringifyActionParam(entryValue)]),
    ),
    parseErrors,
    paramsMalformed: parseErrors.length > 0,
  };
}

export function parseAppActionToolParams(
  params: Record<string, unknown>,
): ParsedAppActionToolParams {
  const parsed = parseAppActionToolParamsWithValidation(params);
  return {
    appName: parsed.appName,
    actionType: parsed.actionType,
    params: parsed.params,
  };
}

export function parseAppActionToolParamsWithValidation(
  params: Record<string, unknown>,
): ParsedAppActionToolParamsWithValidation {
  const normalizedParams = normalizeAppActionParamsWithValidation(params.params);
  const appName = stringifyActionParam(params.app_name).trim();
  const actionType = stringifyActionParam(params.action_type).trim();
  const parseErrors = [...normalizedParams.parseErrors];
  if (!appName) {
    parseErrors.push('app_name_missing');
  }
  if (!actionType) {
    parseErrors.push('action_type_missing');
  }
  return {
    appName,
    actionType,
    params: normalizedParams.params,
    parseErrors,
    paramsMalformed: parseErrors.length > 0,
  };
}
