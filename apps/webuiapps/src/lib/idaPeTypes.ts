export type PeAnalysisView =
  | 'overview'
  | 'findings'
  | 'imports'
  | 'sections'
  | 'strings'
  | 'functions';
export type PeFindingSeverity = 'low' | 'medium' | 'high';

export interface IdaPeHealth {
  status: 'ok' | 'degraded';
  backendMode: 'prescan-only' | 'mcp-http';
  backendFlavor?: 'ida-headless-mcp' | 'ida-pro-mcp' | null;
  backendConfigured: boolean;
  backendReachable: boolean;
  backendUrl: string | null;
  message: string;
  capabilities: {
    upload: boolean;
    quickTriage: boolean;
    idaMcp: boolean;
    currentIdb: boolean;
  };
}

export interface PeSectionSummary {
  name: string;
  virtualAddress: string;
  virtualSize: number;
  rawSize: number;
  rawOffset: number;
  entropy: number;
  permissions: string;
  characteristicsHex: string;
}

export interface PeImportModule {
  module: string;
  count: number;
  suspiciousCount: number;
  names: string[];
}

export interface PeExportSummary {
  count: number;
  names: string[];
}

export interface PeStringHit {
  value: string;
  kind: 'ascii' | 'utf16';
  offset: string;
  suspicious: boolean;
}

export interface PeDataDirectorySummary {
  name: string;
  rva: string;
  size: number;
  present: boolean;
}

export interface PeFinding {
  id: string;
  title: string;
  severity: PeFindingSeverity;
  category: 'packer' | 'imports' | 'strings' | 'entrypoint' | 'tls' | 'network' | 'anti-analysis';
  description: string;
  evidence: string[];
}

export interface PeBackendFunctionSummary {
  address: string;
  name: string;
}

export interface PeBackendFunctionInfo {
  address: string;
  name: string;
  start: string;
  end: string;
  size: number;
  frameSize: number;
  callingConvention: string;
  returnType: string;
  numArgs: number;
  flags: {
    isLibrary: boolean;
    isThunk: boolean;
    noReturn: boolean;
    hasFarseg: boolean;
    isStatic: boolean;
  };
}

export interface PeBackendFunctionDetail {
  sessionId: string;
  address: string;
  info: PeBackendFunctionInfo | null;
  decompiled: string | null;
  disassembly: string | null;
  xrefsTo: Array<{
    from: string;
    to: string;
    type: number;
  }>;
}

export interface PeMetadata {
  fileType: 'PE32' | 'PE32+' | 'unknown';
  machine: string;
  subsystem: string;
  imageBase: string;
  entryPointRva: string;
  imageSize: number;
  headersSize: number;
  sectionAlignment: number;
  fileAlignment: number;
  numberOfSections: number;
  numberOfDirectories: number;
  timestamp: number;
  timestampIso: string | null;
  characteristics: string[];
  dllCharacteristics: string[];
  importDirectoryPresent: boolean;
  exportDirectoryPresent: boolean;
  tlsDirectoryPresent: boolean;
}

export interface PeTriageSummary {
  importModuleCount: number;
  importFunctionCount: number;
  suspiciousImportCount: number;
  suspiciousStringCount: number;
  highEntropySectionCount: number;
  packedSectionCount: number;
  suspectedPacked: boolean;
}

export interface PeSampleRecord {
  id: string;
  fileName: string;
  sha256: string;
  size: number;
  diskPath: string;
  uploadedAt: number;
  machineType: string;
  isDll: boolean;
  sourceMode?: 'upload' | 'current-idb';
  lastAnalysisId: string | null;
  lastScannedAt: number | null;
}

export interface PeAnalysisRecord {
  id: string;
  sampleId: string;
  profile: 'quick-triage';
  backendMode: 'prescan-only' | 'mcp-http';
  status: 'completed' | 'failed';
  startedAt: number;
  finishedAt: number;
  hasDecompiler: boolean;
  artifactDir: string;
  backendSessionId?: string | null;
  summary: string;
  metadata: PeMetadata;
  triage: PeTriageSummary;
  sections: PeSectionSummary[];
  imports: PeImportModule[];
  exports: PeExportSummary;
  strings: PeStringHit[];
  dataDirectories: PeDataDirectorySummary[];
  findings: PeFinding[];
}

export interface PeAnalyzerState {
  activeSampleId: string | null;
  activeAnalysisId: string | null;
  selectedFindingId: string | null;
  selectedFunctionEa: string | null;
  activeView: PeAnalysisView;
  filterSeverity: PeFindingSeverity | null;
  sidebarOpen: boolean;
  showLibraryFunctions: boolean;
}

export interface IdaPeSampleResponse {
  sample: PeSampleRecord;
  analysis: PeAnalysisRecord;
}

export interface IdaPeAnalysisResponse {
  sample: PeSampleRecord;
  analysis: PeAnalysisRecord;
}

export interface IdaPeFunctionsResponse {
  sessionId: string;
  total: number;
  offset: number;
  count: number;
  limit: number;
  functions: PeBackendFunctionSummary[];
}
