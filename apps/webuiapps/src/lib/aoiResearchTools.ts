import type { ToolDef } from './llmClient';
import {
  isAoiResearchArtifactName,
  type AoiResearchArtifactName,
  type AoiResearchLanguage,
  type AoiResearchMode,
  type AoiResearchRecency,
} from './aoiResearchTypes';

export const AOI_RESEARCH_TOOL_NAMES = [
  'start_research',
  'get_research_status',
  'read_research_artifact',
  'cancel_research',
] as const;

export type AoiResearchToolName = (typeof AOI_RESEARCH_TOOL_NAMES)[number];

interface NormalizedStartResearchParams {
  request: string;
  mode: AoiResearchMode;
  language: AoiResearchLanguage;
  recency: AoiResearchRecency;
  maxSources: number;
}

const MODE_DEFAULT_MAX_SOURCES: Record<AoiResearchMode, number> = {
  quick: 5,
  standard: 12,
  deep: 24,
};

function getStringParam(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeAoiResearchMode(value: unknown): AoiResearchMode {
  return value === 'quick' || value === 'deep' ? value : 'standard';
}

export function normalizeAoiResearchLanguage(value: unknown): AoiResearchLanguage {
  return value === 'ko' || value === 'en' ? value : 'match-user';
}

export function normalizeAoiResearchRecency(value: unknown): AoiResearchRecency {
  if (value === 'day' || value === 'week' || value === 'month' || value === 'year') {
    return value;
  }
  return 'any';
}

export function normalizeAoiResearchMaxSources(value: unknown, mode: AoiResearchMode): number {
  const fallback = MODE_DEFAULT_MAX_SOURCES[mode];
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(40, Math.max(1, Math.trunc(parsed)));
}

export function normalizeAoiResearchRunId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeAoiResearchArtifact(value: unknown): AoiResearchArtifactName | null {
  const artifact = typeof value === 'string' ? value.trim() : '';
  return isAoiResearchArtifactName(artifact) ? artifact : null;
}

export function normalizeStartResearchParams(
  params: Record<string, unknown>,
): NormalizedStartResearchParams | string {
  const request = getStringParam(params, 'request');
  if (!request) {
    return 'error: request is required';
  }
  const mode = normalizeAoiResearchMode(params.mode);
  return {
    request,
    mode,
    language: normalizeAoiResearchLanguage(params.language),
    recency: normalizeAoiResearchRecency(params.recency),
    maxSources: normalizeAoiResearchMaxSources(params.max_sources, mode),
  };
}

export function getAoiResearchToolDefinitions(): ToolDef[] {
  return [
    {
      type: 'function',
      function: {
        name: 'start_research',
        description:
          'Start a structured Aoi research run that will create a cited Markdown report from web research artifacts.',
        parameters: {
          type: 'object',
          properties: {
            request: {
              type: 'string',
              description: 'The research question or investigation request to execute.',
            },
            mode: {
              type: 'string',
              description: 'Research depth and cost profile.',
              enum: ['quick', 'standard', 'deep'],
            },
            language: {
              type: 'string',
              description: 'Output language for the eventual report.',
              enum: ['match-user', 'ko', 'en'],
            },
            recency: {
              type: 'string',
              description: 'Optional recency preference for later web search phases.',
              enum: ['any', 'day', 'week', 'month', 'year'],
            },
            max_sources: {
              type: 'number',
              description: 'Maximum source target for the run, between 1 and 40.',
            },
          },
          required: ['request'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_research_status',
        description: 'Read the current status, phase, counts, and artifact availability for a run.',
        parameters: {
          type: 'object',
          properties: {
            run_id: {
              type: 'string',
              description: 'The research run id returned by start_research.',
            },
          },
          required: ['run_id'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_research_artifact',
        description:
          'Read a completed or partial research artifact by run id. Use report for the Markdown document.',
        parameters: {
          type: 'object',
          properties: {
            run_id: {
              type: 'string',
              description: 'The research run id returned by start_research.',
            },
            artifact: {
              type: 'string',
              description: 'Artifact to read.',
              enum: ['manifest', 'report', 'sources', 'evidence'],
            },
          },
          required: ['run_id', 'artifact'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'cancel_research',
        description: 'Cancel a queued or running research run.',
        parameters: {
          type: 'object',
          properties: {
            run_id: {
              type: 'string',
              description: 'The research run id returned by start_research.',
            },
            reason: {
              type: 'string',
              description: 'Optional short reason for cancellation.',
            },
          },
          required: ['run_id'],
        },
      },
    },
  ];
}

export function isAoiResearchTool(toolName: string): toolName is AoiResearchToolName {
  return AOI_RESEARCH_TOOL_NAMES.includes(toolName as AoiResearchToolName);
}

export function getAoiResearchToolPendingSummary(
  toolName: string,
  params: Record<string, unknown>,
): string {
  if (toolName === 'start_research') {
    return `start_research(${String(params.request || '').slice(0, 48)})`;
  }
  if (toolName === 'get_research_status') {
    return `get_research_status(${String(params.run_id || '').slice(0, 48)})`;
  }
  if (toolName === 'read_research_artifact') {
    const artifact = String(params.artifact || 'artifact').slice(0, 24);
    return `read_research_artifact(${artifact}:${String(params.run_id || '').slice(0, 40)})`;
  }
  if (toolName === 'cancel_research') {
    return `cancel_research(${String(params.run_id || '').slice(0, 48)})`;
  }
  return toolName;
}

async function readJsonToolResponse(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text.trim()) {
    return {};
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { error: text.slice(0, 500) };
  }
}

function buildErrorFromResponse(status: number, data: unknown): string {
  if (typeof data === 'object' && data !== null && 'error' in data) {
    const error = (data as { error?: unknown }).error;
    if (typeof error === 'string' && error.trim()) {
      return `error: ${error}`;
    }
  }
  return `error: Aoi research request failed (${status})`;
}

export async function executeAoiResearchTool(
  toolName: string,
  params: Record<string, unknown>,
  sessionPath: string,
): Promise<string> {
  if (!isAoiResearchTool(toolName)) {
    return `error: unknown Aoi research tool ${toolName}`;
  }

  const normalizedSessionPath = sessionPath.trim();
  if (!normalizedSessionPath) {
    return 'error: missing session path';
  }

  try {
    if (toolName === 'start_research') {
      const normalized = normalizeStartResearchParams(params);
      if (typeof normalized === 'string') {
        return normalized;
      }
      const res = await fetch('/api/aoi-research/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionPath: normalizedSessionPath,
          request: normalized.request,
          mode: normalized.mode,
          language: normalized.language,
          recency: normalized.recency,
          maxSources: normalized.maxSources,
        }),
      });
      const data = await readJsonToolResponse(res);
      if (!res.ok) {
        return buildErrorFromResponse(res.status, data);
      }
      return JSON.stringify(data);
    }

    const runId = normalizeAoiResearchRunId(params.run_id);
    if (!runId) {
      return 'error: run_id is required';
    }

    if (toolName === 'get_research_status') {
      const url = new URL('/api/aoi-research/status', window.location.origin);
      url.searchParams.set('sessionPath', normalizedSessionPath);
      url.searchParams.set('runId', runId);
      const res = await fetch(`${url.pathname}${url.search}`);
      const data = await readJsonToolResponse(res);
      if (!res.ok) {
        return buildErrorFromResponse(res.status, data);
      }
      return JSON.stringify(data);
    }

    if (toolName === 'read_research_artifact') {
      const artifact = normalizeAoiResearchArtifact(params.artifact);
      if (!artifact) {
        return 'error: artifact must be one of manifest, report, sources, evidence';
      }
      const url = new URL('/api/aoi-research/artifact', window.location.origin);
      url.searchParams.set('sessionPath', normalizedSessionPath);
      url.searchParams.set('runId', runId);
      url.searchParams.set('artifact', artifact);
      const res = await fetch(`${url.pathname}${url.search}`);
      const data = await readJsonToolResponse(res);
      if (!res.ok) {
        return buildErrorFromResponse(res.status, data);
      }
      return JSON.stringify(data);
    }

    const res = await fetch('/api/aoi-research/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionPath: normalizedSessionPath,
        runId,
        reason: getStringParam(params, 'reason'),
      }),
    });
    const data = await readJsonToolResponse(res);
    if (!res.ok) {
      return buildErrorFromResponse(res.status, data);
    }
    return JSON.stringify(data);
  } catch (error) {
    return `error: ${error instanceof Error ? error.message : String(error)}`;
  }
}
