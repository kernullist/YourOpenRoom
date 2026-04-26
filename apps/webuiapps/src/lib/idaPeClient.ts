import type {
  IdaPeAnalysisResponse,
  IdaPeFunctionsResponse,
  IdaPeHealth,
  IdaPeSampleResponse,
  PeBackendFunctionDetail,
} from './idaPeTypes';

const API_BASE = '/api/ida-pe';

async function parseJsonOrThrow<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let detail = `IDA PE API error ${response.status}`;
    try {
      const payload = (await response.json()) as { error?: string };
      if (payload?.error) detail = payload.error;
    } catch {
      // Ignore JSON parse failure and keep generic error.
    }
    throw new Error(detail);
  }
  return (await response.json()) as T;
}

export async function getIdaPeHealth(): Promise<IdaPeHealth> {
  const response = await fetch(`${API_BASE}/health`);
  return parseJsonOrThrow<IdaPeHealth>(response);
}

export async function uploadPeSample(file: File): Promise<IdaPeSampleResponse> {
  const response = await fetch(`${API_BASE}/samples`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-File-Name': encodeURIComponent(file.name),
    },
    body: await file.arrayBuffer(),
  });
  return parseJsonOrThrow<IdaPeSampleResponse>(response);
}

export async function runQuickPeAnalysis(
  samplePath: string,
  sampleId: string,
): Promise<IdaPeAnalysisResponse> {
  const response = await fetch(`${API_BASE}/analyses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      samplePath,
      sampleId,
      profile: 'quick-triage',
    }),
  });
  return parseJsonOrThrow<IdaPeAnalysisResponse>(response);
}

export async function useCurrentIdbAnalysis(): Promise<IdaPeAnalysisResponse> {
  const response = await fetch(`${API_BASE}/current-idb`, {
    method: 'POST',
  });
  return parseJsonOrThrow<IdaPeAnalysisResponse>(response);
}

export async function getPeFunctions(params: {
  samplePath: string;
  offset?: number;
  limit?: number;
  regex?: string;
}): Promise<IdaPeFunctionsResponse> {
  const search = new URLSearchParams({
    samplePath: params.samplePath,
    ...(typeof params.offset === 'number' ? { offset: String(params.offset) } : {}),
    ...(typeof params.limit === 'number' ? { limit: String(params.limit) } : {}),
    ...(params.regex ? { regex: params.regex } : {}),
  });
  const response = await fetch(`${API_BASE}/functions?${search.toString()}`);
  return parseJsonOrThrow<IdaPeFunctionsResponse>(response);
}

export async function getPeFunctionDetail(params: {
  samplePath: string;
  address: string;
}): Promise<PeBackendFunctionDetail> {
  const search = new URLSearchParams({
    samplePath: params.samplePath,
    address: params.address,
  });
  const response = await fetch(`${API_BASE}/function-detail?${search.toString()}`);
  return parseJsonOrThrow<PeBackendFunctionDetail>(response);
}
