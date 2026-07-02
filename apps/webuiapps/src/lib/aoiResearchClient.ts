import type { AoiResearchManifest, AoiResearchMode, AoiResearchRecency } from './aoiResearchTypes';

// Browser-side client for the Aoi Research app's run-creation path. The page
// component owns list/artifact/cancel via its own fetch helper; this module
// isolates the START call so its input normalization and error mapping are
// unit-testable without rendering the page. Server-safe imports only (types).

const START_ENDPOINT = '/api/aoi-research/start';

export interface StartAoiResearchRunParams {
  sessionPath: string;
  request: string;
  mode?: AoiResearchMode;
  recency?: AoiResearchRecency;
  maxSources?: number;
  allowDuplicate?: boolean;
}

export interface AoiResearchStartResponse {
  ok: boolean;
  run: AoiResearchManifest;
  background?: boolean;
}

interface AoiResearchStartErrorBody {
  error?: string;
  code?: string;
}

// Collapse internal whitespace and trim so the run request stored server-side
// matches what the operator sees, and the duplicate-active-run guard compares
// against a stable form.
export function normalizeAoiResearchRunRequest(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

// Starts a research run for the given session. Throws with a human-readable
// message on validation failure (empty session/request), on a non-2xx response
// (surfacing the server's 409 duplicate / 429 too-many message), or on a
// transport failure. Resolves with the created run manifest on success.
export async function startAoiResearchRun(
  params: StartAoiResearchRunParams,
): Promise<AoiResearchStartResponse> {
  const sessionPath = params.sessionPath.trim();
  if (!sessionPath) {
    throw new Error('Current session is not ready.');
  }
  const request = normalizeAoiResearchRunRequest(params.request);
  if (!request) {
    throw new Error('Enter a research request first.');
  }

  const body: Record<string, unknown> = { sessionPath, request };
  if (params.mode) {
    body.mode = params.mode;
  }
  if (params.recency) {
    body.recency = params.recency;
  }
  if (typeof params.maxSources === 'number') {
    body.maxSources = params.maxSources;
  }
  if (params.allowDuplicate) {
    body.allowDuplicate = true;
  }

  const response = await fetch(START_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  let data: (AoiResearchStartResponse & AoiResearchStartErrorBody) | null = null;
  try {
    data = (await response.json()) as AoiResearchStartResponse & AoiResearchStartErrorBody;
  } catch {
    data = null;
  }

  if (!response.ok || !data || data.ok !== true) {
    const message = (data && data.error) || `Failed to start research (status ${response.status}).`;
    throw new Error(message);
  }

  return { ok: true, run: data.run, background: data.background };
}

const DELETE_ENDPOINT = '/api/aoi-research/delete';

// Permanently deletes a single research run. Throws with a human-readable
// message on validation failure, on a non-2xx response (surfacing the server's
// 404 not-found / 409 still-active message), or on a transport failure.
export async function deleteAoiResearchRun(params: {
  sessionPath: string;
  runId: string;
}): Promise<void> {
  const sessionPath = params.sessionPath.trim();
  if (!sessionPath) {
    throw new Error('Current session is not ready.');
  }
  const runId = params.runId.trim();
  if (!runId) {
    throw new Error('No research run selected.');
  }

  const response = await fetch(DELETE_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionPath, runId }),
  });

  let data: (AoiResearchStartErrorBody & { ok?: boolean }) | null = null;
  try {
    data = (await response.json()) as AoiResearchStartErrorBody & { ok?: boolean };
  } catch {
    data = null;
  }

  if (!response.ok || !data || data.ok !== true) {
    const message =
      (data && data.error) || `Failed to delete research (status ${response.status}).`;
    throw new Error(message);
  }
}
