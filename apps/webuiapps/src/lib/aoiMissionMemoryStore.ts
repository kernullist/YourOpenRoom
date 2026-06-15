import * as fs from 'fs';
import { dirname, join } from 'path';
import type { AoiMissionMemoryReport } from './aoiMissionMemory';
import { normalizeAoiSessionPathForStorage } from './aoiMemoryShared';

const AOI_MISSION_MEMORY_FILE = 'mission-memory.json';
const AOI_AUTONOMY_ROOT_DIR = 'aoi-autonomy';

function isMissionMemoryReport(value: unknown): value is AoiMissionMemoryReport {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const report = value as Partial<AoiMissionMemoryReport>;
  return (
    report.version === 1 &&
    typeof report.id === 'string' &&
    typeof report.sessionPath === 'string' &&
    typeof report.generatedAt === 'number' &&
    Array.isArray(report.snapshots) &&
    Array.isArray(report.evidenceRefs) &&
    Array.isArray(report.warnings) &&
    report.mutationCount === 0
  );
}

export function getAoiMissionMemoryReportPath(params: {
  sessionsDir: string;
  sessionPath: string;
}): string {
  return join(
    params.sessionsDir,
    normalizeAoiSessionPathForStorage(params.sessionPath),
    AOI_AUTONOMY_ROOT_DIR,
    AOI_MISSION_MEMORY_FILE,
  );
}

export function loadAoiMissionMemoryReport(params: {
  sessionsDir: string;
  sessionPath: string;
}): AoiMissionMemoryReport | null {
  const filePath = getAoiMissionMemoryReportPath(params);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return isMissionMemoryReport(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function saveAoiMissionMemoryReport(params: {
  sessionsDir: string;
  report: AoiMissionMemoryReport;
}): AoiMissionMemoryReport {
  const filePath = getAoiMissionMemoryReportPath({
    sessionsDir: params.sessionsDir,
    sessionPath: params.report.sessionPath,
  });
  fs.mkdirSync(dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(params.report, null, 2)}\n`, 'utf8');
  return params.report;
}
