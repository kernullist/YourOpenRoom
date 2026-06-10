export type AoiResearchMode = 'quick' | 'standard' | 'deep';

export type AoiResearchStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export type AoiResearchArtifactName = 'manifest' | 'report' | 'sources' | 'evidence';

export type AoiResearchProgressPhase =
  | 'queued'
  | 'planning'
  | 'searching'
  | 'reading_sources'
  | 'extracting_evidence'
  | 'drafting_report'
  | 'verifying_report'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'engine_not_implemented';

export type AoiResearchLanguage = 'match-user' | 'ko' | 'en';

export type AoiResearchRecency = 'any' | 'day' | 'week' | 'month' | 'year';

export const AOI_RESEARCH_ARTIFACT_NAMES = [
  'manifest',
  'report',
  'sources',
  'evidence',
] as const satisfies readonly AoiResearchArtifactName[];

export interface AoiResearchArtifactPaths {
  manifest: string;
  report: string;
  sources: string;
  evidence: string;
}

export interface AoiResearchErrorDetail {
  code: string;
  message: string;
  phase?: AoiResearchProgressPhase;
  detail?: string;
  createdAt: number;
}

export interface AoiResearchSourceCounts {
  planned: number;
  candidates: number;
  accepted: number;
  failed: number;
}

export interface AoiResearchRun {
  version: 1;
  id: string;
  sessionPath: string;
  request: string;
  mode: AoiResearchMode;
  language: AoiResearchLanguage;
  recency: AoiResearchRecency;
  maxSources: number;
  createdAt: number;
  updatedAt: number;
  status: AoiResearchStatus;
  phase: AoiResearchProgressPhase;
  statusMessage: string;
  sourceCounts: AoiResearchSourceCounts;
  artifactPaths: AoiResearchArtifactPaths;
  artifactAvailability?: Record<AoiResearchArtifactName, boolean>;
  warnings?: AoiResearchErrorDetail[];
  error?: AoiResearchErrorDetail;
}

export interface AoiResearchPlan {
  version: 1;
  title: string;
  createdAt: number;
  researchQuestions: string[];
  searchQueries: string[];
  sourcePriorityRules: string[];
  exclusionRules: string[];
}

export interface AoiResearchSourceBlock {
  type: 'heading' | 'paragraph' | 'quote' | 'list';
  text: string;
}

export interface AoiResearchSource {
  version: 1;
  id: string;
  url: string;
  finalUrl?: string;
  title: string;
  siteName?: string;
  excerpt?: string;
  searchQuery?: string;
  searchScore?: number;
  blocks: AoiResearchSourceBlock[];
  retrievedAt?: number;
  status: 'pending' | 'accepted' | 'failed';
  error?: AoiResearchErrorDetail;
}

export interface AoiResearchEvidenceClaim {
  version: 1;
  id: string;
  sourceId: string;
  claim: string;
  supportText: string;
  topicTags: string[];
  confidence: number;
  caveats: string[];
  createdAt: number;
}

export interface AoiResearchManifest extends AoiResearchRun {
  plan?: AoiResearchPlan;
  completedAt?: number;
}

export interface AoiResearchStartRequest {
  sessionPath: string;
  request: string;
  mode?: AoiResearchMode;
  language?: AoiResearchLanguage;
  recency?: AoiResearchRecency;
  maxSources?: number;
}

export interface AoiResearchStatusResponse {
  ok: boolean;
  run: AoiResearchManifest;
}

export interface AoiResearchArtifactResponse {
  ok: boolean;
  runId: string;
  artifact: AoiResearchArtifactName;
  contentType: 'application/json' | 'text/markdown';
  content: unknown;
}

export interface AoiResearchCancelResponse {
  ok: boolean;
  run: AoiResearchManifest;
}

export function buildAoiResearchArtifactPaths(runId: string): AoiResearchArtifactPaths {
  const basePath = `aoi-research/runs/${runId}`;
  return {
    manifest: `${basePath}/manifest.json`,
    report: `${basePath}/report.md`,
    sources: `${basePath}/sources.json`,
    evidence: `${basePath}/evidence.json`,
  };
}

export function isAoiResearchArtifactName(value: string): value is AoiResearchArtifactName {
  return AOI_RESEARCH_ARTIFACT_NAMES.includes(value as AoiResearchArtifactName);
}
