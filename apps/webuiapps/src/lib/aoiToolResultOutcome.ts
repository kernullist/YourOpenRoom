export interface AoiToolResultOutcome {
  failed: boolean;
  message: string;
}

function compact(value: string, maxChars = 240): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

export function classifyAoiToolResult(result: string): AoiToolResultOutcome {
  const trimmed = result.trim();
  if (!trimmed) {
    return { failed: false, message: 'empty tool result' };
  }
  if (/^(?:error|failed|failure):/i.test(trimmed)) {
    return { failed: true, message: compact(trimmed) };
  }

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (parsed.error !== undefined && parsed.error !== null && parsed.error !== '') {
      return {
        failed: true,
        message: compact(
          typeof parsed.error === 'string' ? parsed.error : JSON.stringify(parsed.error),
        ),
      };
    }
    if (parsed.ok === false || parsed.success === false) {
      return {
        failed: true,
        message: compact(
          typeof parsed.message === 'string' && parsed.message.trim()
            ? parsed.message
            : 'tool returned an unsuccessful result',
        ),
      };
    }
    if (parsed.timedOut === true) {
      return { failed: true, message: 'tool execution timed out' };
    }
    if (
      typeof parsed.status === 'string' &&
      /^(?:failed|failure|error|cancelled|canceled)$/i.test(parsed.status.trim())
    ) {
      return {
        failed: true,
        message: compact(
          typeof parsed.message === 'string' && parsed.message.trim()
            ? parsed.message
            : `tool status=${parsed.status}`,
        ),
      };
    }
    if (typeof parsed.exitCode === 'number' && parsed.exitCode !== 0) {
      const stderr = typeof parsed.stderr === 'string' ? parsed.stderr : '';
      return {
        failed: true,
        message: compact(`exitCode=${parsed.exitCode}${stderr ? `: ${stderr}` : ''}`),
      };
    }
  } catch {
    // Plain-text success results are valid.
  }

  return { failed: false, message: compact(trimmed) };
}
