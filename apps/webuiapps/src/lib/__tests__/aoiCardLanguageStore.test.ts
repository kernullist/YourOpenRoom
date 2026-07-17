import * as fs from 'fs';
import * as os from 'os';
import { dirname, join } from 'path';
import { afterAll, describe, expect, it } from 'vitest';

import { loadAoiCardLanguage, saveAoiCardLanguage } from '../aoiCardLanguageStore';

const SESSION_PATH = 'aoi/default';
const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'aoi-card-language-test-'));
  tempRoots.push(root);
  return root;
}

function cardLanguageFile(root: string): string {
  return join(root, SESSION_PATH, 'aoi-autonomy', 'card-language.json');
}

afterAll(() => {
  for (const root of tempRoots) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // Best-effort temp cleanup.
    }
  }
});

describe('aoiCardLanguageStore', () => {
  it('round-trips the persisted language', () => {
    const root = makeTempRoot();
    expect(loadAoiCardLanguage(root, SESSION_PATH)).toBeNull();

    saveAoiCardLanguage(root, SESSION_PATH, 'ko', 1_000);
    expect(loadAoiCardLanguage(root, SESSION_PATH)).toBe('ko');

    saveAoiCardLanguage(root, SESSION_PATH, 'ja', 2_000);
    expect(loadAoiCardLanguage(root, SESSION_PATH)).toBe('ja');
  });

  it('fails closed to null on malformed or unknown-language records', () => {
    const root = makeTempRoot();
    const filePath = cardLanguageFile(root);
    fs.mkdirSync(dirname(filePath), { recursive: true });

    fs.writeFileSync(filePath, 'not json', 'utf-8');
    expect(loadAoiCardLanguage(root, SESSION_PATH)).toBeNull();

    fs.writeFileSync(filePath, JSON.stringify({ version: 1, language: 'fr' }), 'utf-8');
    expect(loadAoiCardLanguage(root, SESSION_PATH)).toBeNull();

    fs.writeFileSync(filePath, JSON.stringify({ version: 2, language: 'ko' }), 'utf-8');
    expect(loadAoiCardLanguage(root, SESSION_PATH)).toBeNull();
  });

  it('rejects an invalid session path', () => {
    const root = makeTempRoot();
    expect(() => saveAoiCardLanguage(root, '../escape', 'ko')).toThrow();
    expect(loadAoiCardLanguage(root, '../escape')).toBeNull();
  });
});
