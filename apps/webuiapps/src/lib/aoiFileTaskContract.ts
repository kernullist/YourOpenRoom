import { classifyAoiToolResult } from './aoiToolResultOutcome';

export interface AoiFileTaskContract {
  version: 1;
  sourceMessage: string;
  targetPaths: string[];
  maxLines: number | null;
  requireReadBack: boolean;
  requireSha256: boolean;
  requireChangedFileList: boolean;
  explicitMutationRequested: boolean;
  previewRequired: boolean;
}

export interface AoiFileReadBackEvidence {
  path: string;
  source: string | null;
  lineCount: number | null;
  charCount: number | null;
  sha256: string | null;
  content: string;
  contentTruncated: boolean;
}

export interface AoiFileTaskEvidence {
  mutatedFiles: string[];
  readBackByPath: Record<string, AoiFileReadBackEvidence>;
}

export interface AoiFileTaskVerification {
  passed: boolean;
  enforced: boolean;
  issues: string[];
}

interface ConversationMessageLike {
  role: string;
  content: string;
}

const PATH_PATTERN = /(?:^|[\s`"'(])((?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_.-]+\.[A-Za-z0-9_.-]+)/g;
const TARGET_VERB_PATTERN =
  /(?:새로\s*)?(?:만들|작성|생성|저장|수정|덮어쓰|write|create|save|modify|update|overwrite)/i;
const NEGATED_MUTATION_PATTERN =
  /(?:(?:만들|작성|생성|저장|수정|변경|덮어쓰)(?:하지|지)\s*(?:말|마)|(?:do\s+not|don't|without)\s+(?:write|create|save|modify|modifying|update|overwrite|changing))/i;
const SOURCE_VERB_PATTERN = /(?:읽|참조|source|read|inspect|review)/i;

function normalizePath(path: string): string {
  return path
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/{2,}/g, '/');
}

function pathKey(path: string): string {
  return normalizePath(path).toLocaleLowerCase('en-US');
}

function dedupePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  return paths.filter((path) => {
    const key = pathKey(path);
    if (!key || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function parseMaxLines(message: string): number | null {
  const patterns = [
    /(?:전체\s*)?(\d{1,4})\s*줄\s*(?:이내|이하|미만|넘지|초과하지)/i,
    /(?:at\s+most|no\s+more\s+than|within)\s+(\d{1,4})\s+lines?/i,
    /(\d{1,4})\s+lines?\s+(?:or\s+fewer|max(?:imum)?)/i,
  ];
  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (match) {
      const parsed = Number.parseInt(match[1], 10);
      if (Number.isInteger(parsed) && parsed > 0) {
        return parsed;
      }
    }
  }
  return null;
}

function extractTargetPaths(message: string): string[] {
  const targets: string[] = [];
  for (const match of message.matchAll(PATH_PATTERN)) {
    const path = normalizePath(match[1]);
    const index = match.index ?? 0;
    const suffix = message.slice(index + match[0].length, index + match[0].length + 40);
    const prefix = message.slice(Math.max(0, index - 24), index);
    if (SOURCE_VERB_PATTERN.test(suffix.slice(0, 16))) {
      continue;
    }
    const localContext = `${prefix} ${suffix}`;
    if (!NEGATED_MUTATION_PATTERN.test(localContext) && TARGET_VERB_PATTERN.test(localContext)) {
      targets.push(path);
    }
  }
  return dedupePaths(targets);
}

function hasExplicitMutationRequest(message: string): boolean {
  let candidate = message;
  let previous = '';

  while (candidate !== previous) {
    previous = candidate;
    candidate = candidate.replace(NEGATED_MUTATION_PATTERN, '');
  }

  return TARGET_VERB_PATTERN.test(candidate);
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function includesPath(content: string, path: string): boolean {
  const normalizedContent = content.replace(/\\/g, '/').toLocaleLowerCase('en-US');
  return normalizedContent.includes(pathKey(path));
}

export function parseAoiFileTaskContract(message: string): AoiFileTaskContract | null {
  const sourceMessage = message.trim();
  if (!sourceMessage) {
    return null;
  }

  const maxLines = parseMaxLines(sourceMessage);
  const requireReadBack =
    /(?:다시\s*(?:읽|열)|재확인|검증|read[\s-]?back|re[\s-]?read|verify\s+(?:the\s+)?(?:written|saved|file))/i.test(
      sourceMessage,
    );
  const requireSha256 = /(?:sha[\s-]?256|checksum|체크섬|해시)/i.test(sourceMessage);
  const requireChangedFileList =
    /(?:실제\s*)?(?:변경(?:된)?\s*파일|changed\s+files?)(?:\s*목록|\s*list)?/i.test(sourceMessage);
  const explicitMutationRequested = hasExplicitMutationRequest(sourceMessage);
  const previewRequired =
    /(?:실행\s*전|미리\s*보|preview|승인(?:을)?\s*(?:기다|받)|wait\s+for\s+(?:my\s+)?approval)/i.test(
      sourceMessage,
    );
  const hasFileIntent =
    /(?:파일|문서|file|document|\.md\b|\.txt\b|\.json\b)/i.test(sourceMessage) &&
    explicitMutationRequested;
  const hasDeterministicConstraint =
    maxLines !== null || requireReadBack || requireSha256 || requireChangedFileList;
  if (!hasFileIntent || !hasDeterministicConstraint) {
    return null;
  }

  return {
    version: 1,
    sourceMessage,
    targetPaths: extractTargetPaths(sourceMessage),
    maxLines,
    requireReadBack,
    requireSha256,
    requireChangedFileList,
    explicitMutationRequested,
    previewRequired,
  };
}

export function resolveAoiFileTaskContract(params: {
  latestUserMessage: string;
  history: readonly ConversationMessageLike[];
  confirmedActionRequest: string | null;
}): AoiFileTaskContract | null {
  const direct = parseAoiFileTaskContract(params.latestUserMessage);
  if (direct) {
    return direct;
  }
  if (!params.confirmedActionRequest) {
    return null;
  }

  let userMessagesChecked = 0;
  for (let index = params.history.length - 2; index >= 0 && userMessagesChecked < 6; index--) {
    const message = params.history[index];
    if (message.role !== 'user') {
      continue;
    }
    userMessagesChecked += 1;
    const contract = parseAoiFileTaskContract(message.content);
    if (contract) {
      return contract;
    }
  }
  return parseAoiFileTaskContract(params.confirmedActionRequest);
}

export function buildAoiFileTaskContractPrompt(contract: AoiFileTaskContract): string {
  const requirements = [
    contract.targetPaths.length > 0
      ? `- Allowed mutation target(s): ${contract.targetPaths.join(', ')}. Do not mutate any other path.`
      : '- Record every successfully mutated path and do not claim a narrower change set than the tools prove.',
    contract.maxLines !== null
      ? `- Every target artifact must contain at most ${contract.maxLines} lines after the final write.`
      : null,
    contract.requireReadBack || contract.maxLines !== null || contract.requireSha256
      ? '- After the final mutation, call ide_read_file for every mutated IDE file. A read made before the final write does not count.'
      : null,
    contract.requireSha256
      ? '- Use the sha256 returned by ide_read_file. Do not use run_command, node -e, sha256sum, or invent a hash.'
      : null,
    contract.requireChangedFileList
      ? '- In the final response, list every path actually mutated in this run.'
      : null,
    contract.requireSha256
      ? '- In the final response, report the exact read-back SHA-256 for every mutated file.'
      : null,
    '- The runtime will reject respond_to_user until these postconditions are proven.',
  ].filter((line): line is string => Boolean(line));

  return ['', 'Deterministic file-task completion contract:', ...requirements].join('\n');
}

export function createAoiFileTaskEvidence(): AoiFileTaskEvidence {
  return {
    mutatedFiles: [],
    readBackByPath: {},
  };
}

export function observeAoiFileTaskToolResult(
  evidence: AoiFileTaskEvidence,
  toolName: string,
  params: Record<string, unknown>,
  result: string,
): AoiFileTaskEvidence {
  if (classifyAoiToolResult(result).failed) {
    return evidence;
  }
  const parsed = parseJsonObject(result);
  if (!parsed) {
    return evidence;
  }

  if (toolName === 'ide_write_file' || toolName === 'ide_patch_file') {
    const rawPath = typeof parsed.path === 'string' ? parsed.path : params.path;
    if (typeof rawPath !== 'string' || !rawPath.trim()) {
      return evidence;
    }
    const path = normalizePath(rawPath);
    const key = pathKey(path);
    const readBackByPath = { ...evidence.readBackByPath };
    delete readBackByPath[key];
    return {
      mutatedFiles: dedupePaths([...evidence.mutatedFiles, path]),
      readBackByPath,
    };
  }

  if (toolName === 'ide_read_file') {
    const rawPath = typeof parsed.path === 'string' ? parsed.path : params.path;
    if (typeof rawPath !== 'string' || !rawPath.trim()) {
      return evidence;
    }
    const path = normalizePath(rawPath);
    const key = pathKey(path);
    if (!evidence.mutatedFiles.some((item) => pathKey(item) === key)) {
      return evidence;
    }
    const sha256 =
      typeof parsed.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(parsed.sha256)
        ? parsed.sha256.toLowerCase()
        : null;
    return {
      ...evidence,
      readBackByPath: {
        ...evidence.readBackByPath,
        [key]: {
          path,
          source: typeof parsed.source === 'string' ? parsed.source : null,
          lineCount: typeof parsed.line_count === 'number' ? parsed.line_count : null,
          charCount: typeof parsed.char_count === 'number' ? parsed.char_count : null,
          sha256,
          content: typeof parsed.content === 'string' ? parsed.content : '',
          contentTruncated: parsed.content_truncated === true,
        },
      },
    };
  }

  return evidence;
}

export function shouldEnforceAoiFileTaskContract(
  contract: AoiFileTaskContract | null,
  evidence: AoiFileTaskEvidence,
  executionConfirmed: boolean,
): boolean {
  if (!contract) {
    return false;
  }
  if (evidence.mutatedFiles.length > 0 || executionConfirmed) {
    return true;
  }
  return false;
}

export function verifyAoiFileTaskContract(params: {
  contract: AoiFileTaskContract | null;
  evidence: AoiFileTaskEvidence;
  assistantContent: string;
  executionConfirmed: boolean;
  additionalArtifactIssues?: string[];
}): AoiFileTaskVerification {
  const { contract, evidence } = params;
  const enforced = shouldEnforceAoiFileTaskContract(contract, evidence, params.executionConfirmed);
  if (!contract || !enforced) {
    return { passed: true, enforced, issues: [] };
  }

  const issues: string[] = [];
  if (evidence.mutatedFiles.length === 0) {
    issues.push('no successful IDE file mutation was recorded in this execution run');
  }

  const expectedKeys = new Set(contract.targetPaths.map(pathKey));
  if (expectedKeys.size > 0) {
    contract.targetPaths.forEach((path) => {
      if (!evidence.mutatedFiles.some((item) => pathKey(item) === pathKey(path))) {
        issues.push(`required target was not mutated: ${path}`);
      }
    });
    evidence.mutatedFiles.forEach((path) => {
      if (!expectedKeys.has(pathKey(path))) {
        issues.push(`unexpected file was mutated outside the allowed target set: ${path}`);
      }
    });
  }

  evidence.mutatedFiles.forEach((path) => {
    const readBack = evidence.readBackByPath[pathKey(path)];
    const needsReadBack =
      contract.requireReadBack || contract.requireSha256 || contract.maxLines !== null;
    if (needsReadBack && !readBack) {
      issues.push(`missing post-mutation ide_read_file evidence for ${path}`);
      return;
    }
    if (!readBack) {
      return;
    }
    if (readBack.contentTruncated) {
      issues.push(`read-back content was truncated for ${path}`);
    }
    if (
      contract.maxLines !== null &&
      (readBack.lineCount === null || readBack.lineCount > contract.maxLines)
    ) {
      issues.push(
        readBack.lineCount === null
          ? `read-back line count is unavailable for ${path}`
          : `${path} has ${readBack.lineCount} lines; maximum is ${contract.maxLines}`,
      );
    }
    if (contract.requireSha256 && !readBack.sha256) {
      issues.push(`read-back SHA-256 is unavailable for ${path}`);
    }
    if (
      contract.requireSha256 &&
      readBack.sha256 &&
      !params.assistantContent.toLocaleLowerCase('en-US').includes(readBack.sha256)
    ) {
      issues.push(`final response does not report the verified SHA-256 for ${path}`);
    }
    if (contract.requireChangedFileList && !includesPath(params.assistantContent, path)) {
      issues.push(`final response does not list the actually changed file ${path}`);
    }
  });

  issues.push(...(params.additionalArtifactIssues ?? []));
  return {
    passed: issues.length === 0,
    enforced,
    issues: Array.from(new Set(issues)),
  };
}

export function buildAoiFileTaskCorrectionPrompt(
  verification: AoiFileTaskVerification,
  evidence: AoiFileTaskEvidence,
): string {
  return [
    'respond_to_user blocked: deterministic file-task postconditions are not satisfied.',
    ...verification.issues.map((issue) => `- ${issue}`),
    `- Successful mutations recorded by this run: ${evidence.mutatedFiles.join(', ') || 'none'}.`,
    '- Do not spend the next recovery iteration merely explaining what you will do.',
    '- If artifact content or line limits are wrong, the next action must be ide_write_file or ide_patch_file with corrected content.',
    '- After every write or patch, immediately call ide_read_file for the full changed file before responding.',
    '- Call respond_to_user only after the reread passes and include the exact returned SHA-256 plus every actually changed path.',
  ].join('\n');
}

export function buildAoiFileTaskFailureMessage(verification: AoiFileTaskVerification): string {
  return `Aoi file task failed its deterministic completion checks: ${verification.issues.join('; ')}`;
}

export function getAoiFileReadBack(
  evidence: AoiFileTaskEvidence,
  path: string,
): AoiFileReadBackEvidence | null {
  return evidence.readBackByPath[pathKey(path)] ?? null;
}
