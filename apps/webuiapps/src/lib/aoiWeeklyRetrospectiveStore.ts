// Retrospective persistence + relation registration (R4.1).
//
// Kept apart from aoiWeeklyRetrospective so the composition core stays pure and
// browser-safe; this half touches node fs and registers the relation node that
// makes a retrospective reachable from the graph -- the first real producer of
// the 'reflection' node kind, which until now existed only as a type slot.

import * as fs from 'fs';
import { randomUUID } from 'crypto';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import { normalizeAoiAutonomySessionPath, resolveAoiAutonomyPaths } from './aoiAutonomyStore';
import { makeAoiRelationNode, upsertAoiRelations } from './aoiAutonomyRelations';
import type { AoiWeeklyRetrospective } from './aoiWeeklyRetrospective';

const RETROSPECTIVE_DIR = 'retrospective';
const RETROSPECTIVE_LATEST_FILE = 'latest.json';
const RETROSPECTIVE_HISTORY_FILE = 'history.jsonl';
const MAX_HISTORY_ENTRIES = 60;

function isPathInsideRoot(root: string, candidate: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  const rel = relative(resolvedRoot, resolvedCandidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function resolveAoiWeeklyRetrospectivePaths(
  sessionsDir: string,
  sessionPath: string,
): { latest: string; history: string } {
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const paths = resolveAoiAutonomyPaths(sessionsDir, normalizedSessionPath);
  const latest = join(paths.root, RETROSPECTIVE_DIR, RETROSPECTIVE_LATEST_FILE);
  const history = join(paths.root, RETROSPECTIVE_DIR, RETROSPECTIVE_HISTORY_FILE);
  if (!isPathInsideRoot(paths.root, latest) || !isPathInsideRoot(paths.root, history)) {
    throw new Error('Resolved Aoi retrospective path escaped the autonomy root.');
  }
  return { latest, history };
}

export function saveAoiWeeklyRetrospective(
  sessionsDir: string,
  retrospective: AoiWeeklyRetrospective,
): AoiWeeklyRetrospective {
  const paths = resolveAoiWeeklyRetrospectivePaths(sessionsDir, retrospective.sessionPath);
  fs.mkdirSync(dirname(paths.latest), { recursive: true });
  const tmpPath = `${paths.latest}.${process.pid}.${retrospective.createdAt}.${randomUUID().slice(
    0,
    8,
  )}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(retrospective, null, 2)}\n`, 'utf-8');
  fs.renameSync(tmpPath, paths.latest);
  fs.appendFileSync(paths.history, `${JSON.stringify(retrospective)}\n`, 'utf-8');
  try {
    const lines = fs.readFileSync(paths.history, 'utf-8').split(/\r?\n/).filter(Boolean);
    if (lines.length > MAX_HISTORY_ENTRIES) {
      const retained = lines.slice(-MAX_HISTORY_ENTRIES);
      const historyTmp = `${paths.history}.${process.pid}.${retrospective.createdAt}.tmp`;
      fs.writeFileSync(historyTmp, `${retained.join('\n')}\n`, 'utf-8');
      fs.renameSync(historyTmp, paths.history);
    }
  } catch {
    // History compaction is best-effort; the latest write is what matters.
  }
  // Register the reflection node (and its evidence links) so the retrospective
  // is reachable from the relation graph like any other artifact.
  try {
    upsertAoiRelations(sessionsDir, retrospective.sessionPath, {
      nodes: [
        makeAoiRelationNode({
          ref: retrospective.relationRef,
          kind: 'reflection',
          label: retrospective.narrative,
          now: retrospective.createdAt,
        }),
        ...retrospective.evidenceRefs.map((ref) =>
          makeAoiRelationNode({ ref, now: retrospective.createdAt }),
        ),
      ],
      now: retrospective.createdAt,
    });
  } catch {
    // Graph registration is best-effort: a retrospective that is stored but
    // unlinked is still readable, and failing the write would lose it entirely.
  }
  return retrospective;
}

export function loadAoiWeeklyRetrospective(
  sessionsDir: string,
  sessionPath: string,
): AoiWeeklyRetrospective | null {
  try {
    const paths = resolveAoiWeeklyRetrospectivePaths(sessionsDir, sessionPath);
    if (!fs.existsSync(paths.latest)) {
      return null;
    }
    const raw = JSON.parse(
      fs.readFileSync(paths.latest, 'utf-8'),
    ) as Partial<AoiWeeklyRetrospective>;
    // Fail-closed: anything that is not a recognizable display-only record reads
    // as absent rather than as a partly-trusted narrative.
    if (
      !raw ||
      raw.version !== 1 ||
      typeof raw.narrative !== 'string' ||
      typeof raw.periodStart !== 'number' ||
      typeof raw.periodEnd !== 'number' ||
      raw.actionAuthority !== 'display_only' ||
      raw.mutationCount !== 0
    ) {
      return null;
    }
    return raw as AoiWeeklyRetrospective;
  } catch {
    return null;
  }
}

export function loadAoiWeeklyRetrospectiveHistory(
  sessionsDir: string,
  sessionPath: string,
  limit = 12,
): AoiWeeklyRetrospective[] {
  try {
    const paths = resolveAoiWeeklyRetrospectivePaths(sessionsDir, sessionPath);
    if (!fs.existsSync(paths.history)) {
      return [];
    }
    const lines = fs.readFileSync(paths.history, 'utf-8').split(/\r?\n/).filter(Boolean);
    const parsed: AoiWeeklyRetrospective[] = [];
    for (const line of lines.slice(-Math.max(1, limit))) {
      try {
        const record = JSON.parse(line) as Partial<AoiWeeklyRetrospective>;
        if (record && record.version === 1 && typeof record.narrative === 'string') {
          parsed.push(record as AoiWeeklyRetrospective);
        }
      } catch {
        // Skip a corrupt line rather than dropping the whole history.
      }
    }
    return parsed.reverse();
  } catch {
    return [];
  }
}
