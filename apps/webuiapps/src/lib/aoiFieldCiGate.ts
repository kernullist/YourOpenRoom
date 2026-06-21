import {
  AOI_FIELD_GROUNDED_JARVIS_ACCEPTANCE_NOW,
  AOI_FIELD_GROUNDED_JARVIS_ACCEPTANCE_SESSION_PATH,
  runAoiFieldGroundedJarvisAcceptancePack,
  type AoiFieldGroundedJarvisAcceptanceLiveOperationCounts,
  type AoiFieldGroundedJarvisAcceptanceReport,
} from './aoiFieldGroundedJarvisAcceptancePack';
import { normalizeAoiAutonomySessionPath } from './aoiAutonomySessionPath';

export type AoiFieldCiChangedFileClass =
  | 'autonomy_core'
  | 'client_api'
  | 'field_ci_gate'
  | 'field_feedback_learning'
  | 'field_grounded_acceptance'
  | 'local_docs_only'
  | 'non_autonomy'
  | 'operator_trace'
  | 'package_script'
  | 'proactive_autonomy'
  | 'readiness_gate'
  | 'test_only';

export type AoiFieldCiGateStatus = 'pass' | 'fail' | 'skipped';

export type AoiFieldCiGateCommandCapability = 'vitest' | 'lint' | 'build_test';

export interface AoiFieldCiChangedFileClassification {
  version: 1;
  path: string;
  classes: AoiFieldCiChangedFileClass[];
  gateRelevant: boolean;
  skippedReason?: string;
}

export interface AoiFieldCiChangedFileClassSummary {
  version: 1;
  className: AoiFieldCiChangedFileClass;
  files: string[];
}

export interface AoiFieldCiGateCommand {
  version: 1;
  id: string;
  runner: 'pnpm';
  args: string[];
  display: string;
  capability: AoiFieldCiGateCommandCapability;
  status: 'required' | 'skipped';
  reason: string;
  skippedReason?: string;
  evidenceRefs: string[];
}

export interface AoiFieldCiHardFailCounts {
  version: 1;
  privateLeakCount: number;
  unauthorizedMutationCount: number;
  staleCurrentClaimCount: number;
  mutationCount: number;
  failedMetricCount: number;
  observedHardFailCount: number;
}

export interface AoiFieldCiAcceptanceGateResult {
  version: 1;
  status: AoiFieldCiGateStatus;
  passed: boolean;
  scenarioCount: number;
  passedScenarioCount: number;
  failedScenarioCount: number;
  hardFailCounts: AoiFieldCiHardFailCounts;
  liveOperationCounts: AoiFieldGroundedJarvisAcceptanceLiveOperationCounts;
  syntheticBoundary: string;
  skippedReason?: string;
  evidenceRefs: string[];
}

export interface AoiFieldCiGateReport {
  version: 1;
  id: string;
  generatedAt: number;
  sessionPath: string;
  status: AoiFieldCiGateStatus;
  passed: boolean;
  gateRequired: boolean;
  skippedReason?: string;
  changedFiles: AoiFieldCiChangedFileClassification[];
  changedFileClasses: AoiFieldCiChangedFileClassSummary[];
  requiredTargetedTests: string[];
  requiredTestCommands: AoiFieldCiGateCommand[];
  fieldGroundedAcceptance: AoiFieldCiAcceptanceGateResult;
  privateLeakCount: number;
  unauthorizedMutationCount: number;
  staleCurrentClaimCount: number;
  liveOperationCounts: AoiFieldGroundedJarvisAcceptanceLiveOperationCounts;
  gateLiveOperationCounts: AoiFieldGroundedJarvisAcceptanceLiveOperationCounts;
  gateMutationCount: 0;
  evidenceRefs: string[];
}

export interface AoiFieldCiGateOptions {
  changedFiles: readonly string[];
  sessionPath?: string;
  now?: number;
  acceptanceReport?: AoiFieldGroundedJarvisAcceptanceReport | null;
  runAcceptancePack?: boolean;
  commandAvailability?: Partial<Record<AoiFieldCiGateCommandCapability, boolean>>;
}

const ZERO_LIVE_OPERATION_COUNTS: AoiFieldGroundedJarvisAcceptanceLiveOperationCounts = {
  shell: 0,
  network: 0,
  gmail: 0,
  calendar: 0,
  kiraMutation: 0,
};

const LOCAL_DOCS_ONLY_REASON =
  'No autonomy-relevant files changed; docs/*.local.md or AGENTS.md-only changes do not require the heavy autonomy field gate.';

const FIELD_CI_SELF_TEST = 'src/lib/__tests__/aoiFieldCiGate.test.ts';
const FIELD_GROUNDED_ACCEPTANCE_TEST =
  'src/lib/__tests__/aoiFieldGroundedJarvisAcceptancePack.test.ts';
const REAL_FIELD_OPERATIONS_ACCEPTANCE_TEST =
  'src/lib/__tests__/aoiRealFieldOperationsAcceptancePack.test.ts';
const OPERATOR_FLIGHT_RECORDER_TEST = 'src/lib/__tests__/aoiOperatorFlightRecorder.test.ts';

const TESTS_BY_CLASS: Record<AoiFieldCiChangedFileClass, readonly string[]> = {
  autonomy_core: [
    'src/lib/__tests__/aoiAutonomyEvaluation.test.ts',
    'src/lib/__tests__/aoiJarvisReadinessScorecard.test.ts',
  ],
  client_api: [
    'src/lib/__tests__/aoiAutonomyClient.test.ts',
    'src/lib/__tests__/aoiAutonomyPlugin.test.ts',
  ],
  field_ci_gate: [FIELD_CI_SELF_TEST, FIELD_GROUNDED_ACCEPTANCE_TEST],
  field_feedback_learning: [
    'src/lib/__tests__/aoiAutonomyStore.test.ts',
    'src/lib/__tests__/aoiFieldFeedbackLearning.test.ts',
    'src/lib/__tests__/aoiFollowThroughLearning.test.ts',
    'src/lib/__tests__/aoiOutcomeLearning.test.ts',
  ],
  field_grounded_acceptance: [
    FIELD_GROUNDED_ACCEPTANCE_TEST,
    REAL_FIELD_OPERATIONS_ACCEPTANCE_TEST,
    'src/lib/__tests__/aoiRealFieldCapture.test.ts',
  ],
  local_docs_only: [],
  non_autonomy: [],
  operator_trace: [
    FIELD_GROUNDED_ACCEPTANCE_TEST,
    OPERATOR_FLIGHT_RECORDER_TEST,
    'src/lib/__tests__/aoiRealFieldCapture.test.ts',
  ],
  package_script: [FIELD_CI_SELF_TEST],
  proactive_autonomy: [
    'src/lib/__tests__/aoiProactiveBriefDelivery.test.ts',
    'src/lib/__tests__/aoiProactiveBriefReplay.test.ts',
    'src/lib/__tests__/aoiProactiveTrendAdvisor.test.ts',
  ],
  readiness_gate: [
    'src/lib/__tests__/aoiAutonomyEvaluation.test.ts',
    'src/lib/__tests__/aoiJarvisReadinessScorecard.test.ts',
  ],
  test_only: [],
};

function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function normalizeRepoPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//u, '').trim();
}

function baseName(path: string): string {
  const normalized = normalizeRepoPath(path);
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

function isLocalDocsOnlyPath(path: string): boolean {
  const normalized = normalizeRepoPath(path);
  return (
    normalized === 'AGENTS.md' ||
    (normalized.startsWith('docs/') && normalized.endsWith('.local.md'))
  );
}

function addClass(
  classes: Set<AoiFieldCiChangedFileClass>,
  className: AoiFieldCiChangedFileClass,
): void {
  classes.add(className);
}

function hasAoiStem(fileName: string, stems: readonly string[]): boolean {
  return stems.some((stem) => fileName.includes(stem.toLowerCase()));
}

export function classifyAoiFieldCiChangedFile(path: string): AoiFieldCiChangedFileClassification {
  const normalized = normalizeRepoPath(path);
  const lowerPath = normalized.toLowerCase();
  const lowerName = baseName(normalized).toLowerCase();
  const classes = new Set<AoiFieldCiChangedFileClass>();

  if (!normalized) {
    addClass(classes, 'non_autonomy');
  } else if (isLocalDocsOnlyPath(normalized)) {
    addClass(classes, 'local_docs_only');
  } else if (normalized === 'package.json' || normalized === 'apps/webuiapps/package.json') {
    addClass(classes, 'package_script');
  } else if (!lowerPath.startsWith('apps/webuiapps/src/')) {
    addClass(classes, 'non_autonomy');
  } else {
    if (lowerPath.includes('/__tests__/')) {
      addClass(classes, 'test_only');
    }

    if (hasAoiStem(lowerName, ['aoiFieldCiGate'])) {
      addClass(classes, 'field_ci_gate');
    }

    if (
      hasAoiStem(lowerName, [
        'aoiFieldFeedbackLearning',
        'aoiFieldEvent',
        'aoiFieldShadow',
        'aoiFieldSignal',
        'aoiFollowThroughLearning',
        'aoiOperatorFeedbackInbox',
        'aoiOutcomeLearning',
      ])
    ) {
      addClass(classes, 'field_feedback_learning');
    }

    if (
      hasAoiStem(lowerName, [
        'aoiFieldGroundedJarvisAcceptancePack',
        'aoiRealFieldCapture',
        'aoiRealFieldOperationsAcceptancePack',
        'aoiShadowMode',
        'aoiTracePromotion',
      ])
    ) {
      addClass(classes, 'field_grounded_acceptance');
    }

    if (
      hasAoiStem(lowerName, ['aoiAutonomyClient', 'aoiAutonomyPlugin', 'aoiAutonomyUi']) ||
      lowerPath.includes('components/chatpanel/')
    ) {
      addClass(classes, 'client_api');
    }

    if (
      hasAoiStem(lowerName, [
        'aoiAutonomyEvaluation',
        'aoiJarvisAcceptanceTrial',
        'aoiJarvisReadinessScorecard',
        'aoiOperatorReplay',
      ])
    ) {
      addClass(classes, 'readiness_gate');
    }

    if (
      hasAoiStem(lowerName, [
        'aoiMissionMemory',
        'aoiOperatorFlightRecorder',
        'aoiOperatorTimeline',
        'aoiContextRouter',
      ])
    ) {
      addClass(classes, 'operator_trace');
    }

    if (
      hasAoiStem(lowerName, [
        'aoiAttentionBroker',
        'aoiProactiveBrief',
        'aoiProactiveResearch',
        'aoiProactiveTrend',
      ])
    ) {
      addClass(classes, 'proactive_autonomy');
    }

    if (
      lowerName.startsWith('aoiautonomy') ||
      hasAoiStem(lowerName, [
        'aoiActionLadder',
        'aoiApprovedCommand',
        'aoiBoundedWorkOrder',
        'aoiInterruptionGovernor',
        'aoiJarvisAutonomyGovernor',
        'aoiKiraHandoff',
        'aoiSafeActionPlan',
      ])
    ) {
      addClass(classes, 'autonomy_core');
    }

    if (classes.size === 0 || (classes.size === 1 && classes.has('test_only'))) {
      addClass(classes, 'non_autonomy');
    }
  }

  const classList = [...classes].sort();
  const gateRelevant = classList.some(
    (className) =>
      className !== 'local_docs_only' && className !== 'non_autonomy' && className !== 'test_only',
  );

  return {
    version: 1,
    path: normalized,
    classes: classList,
    gateRelevant,
    ...(classList.length === 1 && classList[0] === 'local_docs_only'
      ? { skippedReason: LOCAL_DOCS_ONLY_REASON }
      : {}),
  };
}

function summarizeChangedFileClasses(
  files: readonly AoiFieldCiChangedFileClassification[],
): AoiFieldCiChangedFileClassSummary[] {
  const grouped = new Map<AoiFieldCiChangedFileClass, string[]>();
  for (const file of files) {
    for (const className of file.classes) {
      grouped.set(className, [...(grouped.get(className) ?? []), file.path]);
    }
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([className, classFiles]) => ({
      version: 1,
      className,
      files: uniqueStrings(classFiles).sort(),
    }));
}

function isGateRelevantClass(className: AoiFieldCiChangedFileClass): boolean {
  return (
    className !== 'local_docs_only' && className !== 'non_autonomy' && className !== 'test_only'
  );
}

function requiredTestsForClasses(classes: readonly AoiFieldCiChangedFileClass[]): string[] {
  const gateClasses = classes.filter(isGateRelevantClass);
  if (gateClasses.length <= 0) {
    return [];
  }
  return uniqueStrings([
    FIELD_CI_SELF_TEST,
    FIELD_GROUNDED_ACCEPTANCE_TEST,
    ...gateClasses.flatMap((className) => [...TESTS_BY_CLASS[className]]),
  ]).sort();
}

function formatCommand(runner: 'pnpm', args: readonly string[]): string {
  return [runner, ...args]
    .map((part) => (/^[A-Za-z0-9_@./:=+-]+$/u.test(part) ? part : JSON.stringify(part)))
    .join(' ');
}

function buildCommand(params: {
  id: string;
  capability: AoiFieldCiGateCommandCapability;
  args: string[];
  reason: string;
  evidenceRefs: string[];
  available: boolean;
  skippedReason: string;
}): AoiFieldCiGateCommand {
  return {
    version: 1,
    id: params.id,
    runner: 'pnpm',
    args: params.args,
    display: formatCommand('pnpm', params.args),
    capability: params.capability,
    status: params.available ? 'required' : 'skipped',
    reason: params.reason,
    ...(params.available ? {} : { skippedReason: params.skippedReason }),
    evidenceRefs: params.evidenceRefs,
  };
}

function buildRequiredCommands(params: {
  gateRequired: boolean;
  requiredTargetedTests: readonly string[];
  commandAvailability: Partial<Record<AoiFieldCiGateCommandCapability, boolean>>;
}): AoiFieldCiGateCommand[] {
  if (!params.gateRequired) {
    return [];
  }
  const isAvailable = (capability: AoiFieldCiGateCommandCapability) =>
    params.commandAvailability[capability] !== false;
  return [
    buildCommand({
      id: 'field-ci.targeted-vitest',
      capability: 'vitest',
      args: ['--filter', '@openroom/webuiapps', 'test', '--', ...params.requiredTargetedTests],
      reason: 'Run the touched autonomy targeted test matrix plus the field-grounded pack.',
      evidenceRefs: params.requiredTargetedTests.map((testPath) => `test:${testPath}`),
      available: isAvailable('vitest'),
      skippedReason: 'Vitest command is unavailable in this environment.',
    }),
    buildCommand({
      id: 'field-ci.touched-eslint',
      capability: 'lint',
      args: ['run', 'lint'],
      reason: 'Run the repo eslint script for touched autonomy code before commit.',
      evidenceRefs: ['script:lint'],
      available: isAvailable('lint'),
      skippedReason: 'Lint command is unavailable in this environment.',
    }),
    buildCommand({
      id: 'field-ci.build-test',
      capability: 'build_test',
      args: ['--filter', '@openroom/webuiapps', 'build:test'],
      reason: 'Build the webuiapps test bundle after autonomy gate changes.',
      evidenceRefs: ['script:@openroom/webuiapps:build:test'],
      available: isAvailable('build_test'),
      skippedReason: 'build:test command is unavailable in this environment.',
    }),
  ];
}

function hardFailCountsFromAcceptance(
  acceptanceReport: AoiFieldGroundedJarvisAcceptanceReport | null,
): AoiFieldCiHardFailCounts {
  if (!acceptanceReport) {
    return {
      version: 1,
      privateLeakCount: 0,
      unauthorizedMutationCount: 0,
      staleCurrentClaimCount: 0,
      mutationCount: 0,
      failedMetricCount: 0,
      observedHardFailCount: 0,
    };
  }
  const observedHardFailCount =
    acceptanceReport.privateLeakCount +
    acceptanceReport.unauthorizedMutationCount +
    acceptanceReport.staleCurrentClaimCount +
    acceptanceReport.mutationCount +
    acceptanceReport.failedMetricCount;
  return {
    version: 1,
    privateLeakCount: acceptanceReport.privateLeakCount,
    unauthorizedMutationCount: acceptanceReport.unauthorizedMutationCount,
    staleCurrentClaimCount: acceptanceReport.staleCurrentClaimCount,
    mutationCount: acceptanceReport.mutationCount,
    failedMetricCount: acceptanceReport.failedMetricCount,
    observedHardFailCount,
  };
}

function acceptanceGateResult(params: {
  gateRequired: boolean;
  acceptanceReport: AoiFieldGroundedJarvisAcceptanceReport | null;
  skippedReason?: string;
}): AoiFieldCiAcceptanceGateResult {
  const hardFailCounts = hardFailCountsFromAcceptance(params.acceptanceReport);
  if (!params.gateRequired) {
    return {
      version: 1,
      status: 'skipped',
      passed: true,
      scenarioCount: 0,
      passedScenarioCount: 0,
      failedScenarioCount: 0,
      hardFailCounts,
      liveOperationCounts: { ...ZERO_LIVE_OPERATION_COUNTS },
      syntheticBoundary:
        'Field CI acceptance pack was skipped because no autonomy gate was required.',
      skippedReason: params.skippedReason ?? LOCAL_DOCS_ONLY_REASON,
      evidenceRefs: ['field-ci:acceptance-skipped'],
    };
  }
  if (!params.acceptanceReport) {
    return {
      version: 1,
      status: 'skipped',
      passed: false,
      scenarioCount: 0,
      passedScenarioCount: 0,
      failedScenarioCount: 0,
      hardFailCounts,
      liveOperationCounts: { ...ZERO_LIVE_OPERATION_COUNTS },
      syntheticBoundary: 'Field CI acceptance pack did not run.',
      skippedReason: params.skippedReason ?? 'Field-grounded acceptance pack was not executed.',
      evidenceRefs: ['field-ci:acceptance-not-run'],
    };
  }
  const liveOperationCount = Object.values(params.acceptanceReport.liveOperationCounts).reduce(
    (total, count) => total + count,
    0,
  );
  const passed =
    params.acceptanceReport.passed &&
    hardFailCounts.observedHardFailCount === 0 &&
    liveOperationCount === 0;
  return {
    version: 1,
    status: passed ? 'pass' : 'fail',
    passed,
    scenarioCount: params.acceptanceReport.scenarioCount,
    passedScenarioCount: params.acceptanceReport.passedScenarioCount,
    failedScenarioCount: params.acceptanceReport.failedScenarioCount,
    hardFailCounts,
    liveOperationCounts: { ...params.acceptanceReport.liveOperationCounts },
    syntheticBoundary: params.acceptanceReport.syntheticBoundary,
    evidenceRefs: uniqueStrings([
      `field-grounded-acceptance:${params.acceptanceReport.id}`,
      ...params.acceptanceReport.evidenceRefs.slice(0, 24),
    ]),
  };
}

export function runAoiFieldCiGate(options: AoiFieldCiGateOptions): AoiFieldCiGateReport {
  const now = options.now ?? AOI_FIELD_GROUNDED_JARVIS_ACCEPTANCE_NOW;
  const sessionPath = normalizeAoiAutonomySessionPath(
    options.sessionPath ?? AOI_FIELD_GROUNDED_JARVIS_ACCEPTANCE_SESSION_PATH,
  );
  if (!sessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }

  const changedFiles = options.changedFiles.map(classifyAoiFieldCiChangedFile);
  const changedFileClasses = summarizeChangedFileClasses(changedFiles);
  const classNames = changedFileClasses.map((item) => item.className);
  const gateRequired = changedFiles.some((file) => file.gateRelevant);
  const skippedReason = gateRequired ? undefined : LOCAL_DOCS_ONLY_REASON;
  const requiredTargetedTests = requiredTestsForClasses(classNames);
  const requiredTestCommands = buildRequiredCommands({
    gateRequired,
    requiredTargetedTests,
    commandAvailability: options.commandAvailability ?? {},
  });
  const acceptanceReport =
    gateRequired && options.runAcceptancePack !== false
      ? (options.acceptanceReport ?? runAoiFieldGroundedJarvisAcceptancePack({ sessionPath, now }))
      : (options.acceptanceReport ?? null);
  const fieldGroundedAcceptance = acceptanceGateResult({
    gateRequired,
    acceptanceReport,
    skippedReason: gateRequired ? undefined : skippedReason,
  });
  const skippedCommandCount = requiredTestCommands.filter(
    (command) => command.status === 'skipped',
  ).length;
  const passed =
    gateRequired === false
      ? true
      : fieldGroundedAcceptance.status === 'pass' && skippedCommandCount === 0;

  return {
    version: 1,
    id: `aoi-field-ci-gate-${sessionPath.replace(/[^A-Za-z0-9_-]/gu, '-')}-${now}`,
    generatedAt: now,
    sessionPath,
    status: gateRequired ? (passed ? 'pass' : 'fail') : 'skipped',
    passed,
    gateRequired,
    ...(skippedReason ? { skippedReason } : {}),
    changedFiles,
    changedFileClasses,
    requiredTargetedTests,
    requiredTestCommands,
    fieldGroundedAcceptance,
    privateLeakCount: fieldGroundedAcceptance.hardFailCounts.privateLeakCount,
    unauthorizedMutationCount: fieldGroundedAcceptance.hardFailCounts.unauthorizedMutationCount,
    staleCurrentClaimCount: fieldGroundedAcceptance.hardFailCounts.staleCurrentClaimCount,
    liveOperationCounts: { ...fieldGroundedAcceptance.liveOperationCounts },
    gateLiveOperationCounts: { ...ZERO_LIVE_OPERATION_COUNTS },
    gateMutationCount: 0,
    evidenceRefs: uniqueStrings([
      'field-ci:gate:v1',
      ...changedFileClasses.map((item) => `field-ci:class:${item.className}`),
      ...requiredTargetedTests.map((testPath) => `test:${testPath}`),
      ...fieldGroundedAcceptance.evidenceRefs,
    ]),
  };
}

export function formatAoiFieldCiGateReport(report: AoiFieldCiGateReport): string {
  const classes = report.changedFileClasses
    .map((item) => `${item.className}=${item.files.length}`)
    .join(', ');
  const commands = report.requiredTestCommands.map((command) => {
    const suffix =
      command.status === 'skipped' && command.skippedReason
        ? ` [skipped: ${command.skippedReason}]`
        : '';
    return `- ${command.display}${suffix}`;
  });
  return [
    `Aoi Field CI Gate: ${report.status.toUpperCase()}`,
    `changed_file_classes: ${classes || 'none'}`,
    `required_targeted_tests: ${report.requiredTargetedTests.length}`,
    `field_grounded_acceptance: ${report.fieldGroundedAcceptance.status} (${report.fieldGroundedAcceptance.passedScenarioCount}/${report.fieldGroundedAcceptance.scenarioCount})`,
    `hard_fail_counts private=${report.privateLeakCount} unauthorized_mutation=${report.unauthorizedMutationCount} stale_current=${report.staleCurrentClaimCount} observed=${report.fieldGroundedAcceptance.hardFailCounts.observedHardFailCount}`,
    `live_ops shell=${report.liveOperationCounts.shell} network=${report.liveOperationCounts.network} gmail=${report.liveOperationCounts.gmail} calendar=${report.liveOperationCounts.calendar} kira_mutation=${report.liveOperationCounts.kiraMutation}`,
    ...(report.skippedReason ? [`skipped_reason: ${report.skippedReason}`] : []),
    ...(commands.length > 0 ? ['required_commands:', ...commands] : []),
  ].join('\n');
}
