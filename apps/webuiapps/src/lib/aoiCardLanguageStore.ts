// Persisted per-session operator card language.
//
// ChatPanel forwards an explicit card language (derived from the conversation,
// the response-language preference, and the app language) on its wakeups. Idle
// background/daemon ticks have neither that signal nor a latest user message,
// and used to silently drop to English proposals. The engine persists the last
// explicit language here and reuses it as the fallback for signal-less ticks,
// so a Korean operator keeps Korean research/review proposals around the clock.
//
// Server-only (fs). Fail-closed: an unreadable or malformed record reads as
// "no persisted language" and the caller falls back to English.
import * as fs from 'fs';
import { dirname, isAbsolute, relative, resolve } from 'path';
import { randomUUID } from 'crypto';
import { normalizeAoiAutonomySessionPath } from './aoiAutonomyStore';
import type { AoiCardLang } from './aoiAutonomyCardI18n';

const AUTONOMY_ROOT_DIR = 'aoi-autonomy';
const CARD_LANGUAGE_FILE_NAME = 'card-language.json';

const CARD_LANGS: ReadonlySet<string> = new Set(['ko', 'ja', 'zh', 'en']);

interface AoiCardLanguageRecord {
  version: 1;
  sessionPath: string;
  language: AoiCardLang;
  updatedAt: number;
}

function isPathInsideRoot(root: string, target: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  const diff = relative(resolvedRoot, resolvedTarget);
  return diff === '' || (!diff.startsWith('..') && !isAbsolute(diff));
}

function resolveCardLanguageFile(
  sessionsDir: string,
  sessionPath: string,
): { sessionPath: string; filePath: string } {
  const normalizedSessionPath = normalizeAoiAutonomySessionPath(sessionPath);
  if (!normalizedSessionPath) {
    throw new Error('Invalid or missing sessionPath.');
  }
  const sessionsRoot = resolve(sessionsDir);
  const filePath = resolve(
    sessionsRoot,
    normalizedSessionPath,
    AUTONOMY_ROOT_DIR,
    CARD_LANGUAGE_FILE_NAME,
  );
  if (!isPathInsideRoot(sessionsRoot, filePath)) {
    throw new Error('Resolved Aoi card language path escaped the sessions directory.');
  }
  return { sessionPath: normalizedSessionPath, filePath };
}

// Strict validation instead of normalizeAoiCardLang: normalization would turn a
// corrupted value into 'en', which is exactly the silent English drop this
// store exists to prevent. Garbage must read as "unknown" (null).
export function loadAoiCardLanguage(sessionsDir: string, sessionPath: string): AoiCardLang | null {
  try {
    const resolved = resolveCardLanguageFile(sessionsDir, sessionPath);
    if (!fs.existsSync(resolved.filePath)) {
      return null;
    }
    const raw = JSON.parse(
      fs.readFileSync(resolved.filePath, 'utf-8'),
    ) as Partial<AoiCardLanguageRecord> | null;
    if (
      raw &&
      raw.version === 1 &&
      typeof raw.language === 'string' &&
      CARD_LANGS.has(raw.language)
    ) {
      return raw.language as AoiCardLang;
    }
    return null;
  } catch {
    return null;
  }
}

export function saveAoiCardLanguage(
  sessionsDir: string,
  sessionPath: string,
  language: AoiCardLang,
  now = Date.now(),
): void {
  const resolved = resolveCardLanguageFile(sessionsDir, sessionPath);
  const record: AoiCardLanguageRecord = {
    version: 1,
    sessionPath: resolved.sessionPath,
    language,
    updatedAt: now,
  };
  fs.mkdirSync(dirname(resolved.filePath), { recursive: true });
  const tmpPath = `${resolved.filePath}.${process.pid}.${Date.now()}.${randomUUID().slice(0, 8)}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(record, null, 2)}\n`, 'utf-8');
  fs.renameSync(tmpPath, resolved.filePath);
}
