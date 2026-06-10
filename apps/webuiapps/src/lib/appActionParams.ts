export interface ParsedAppActionToolParams {
  appName: string;
  actionType: string;
  params: Record<string, string>;
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
  let rawParams: unknown = value;

  if (typeof rawParams === 'string') {
    const trimmed = rawParams.trim();
    if (!trimmed) {
      return {};
    }

    try {
      rawParams = JSON.parse(trimmed);
    } catch {
      return {};
    }
  }

  const record = asRecord(rawParams);
  if (!record) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(record)
      .filter(([, entryValue]) => entryValue !== undefined)
      .map(([entryKey, entryValue]) => [entryKey, stringifyActionParam(entryValue)]),
  );
}

export function parseAppActionToolParams(
  params: Record<string, unknown>,
): ParsedAppActionToolParams {
  return {
    appName: stringifyActionParam(params.app_name).trim(),
    actionType: stringifyActionParam(params.action_type).trim(),
    params: normalizeAppActionParams(params.params),
  };
}
