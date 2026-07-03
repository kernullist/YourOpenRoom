import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildWrittenByMeConvertPrompt,
  deleteWrittenByMeProfile,
  listWrittenByMeProfiles,
  normalizeWrittenByMeConvertLanguage,
  normalizeWrittenByMeProfileName,
  readWrittenByMeProfile,
  saveWrittenByMeProfile,
} from '../writtenByMePlugin';

const tempRoots: string[] = [];

function makeProfilesDir(): string {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'wbm-profiles-'));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('normalizeWrittenByMeProfileName()', () => {
  it('collapses whitespace, trims, and caps length', () => {
    expect(normalizeWrittenByMeProfileName('  My   blog\n voice  ')).toBe('My blog voice');
    expect(normalizeWrittenByMeProfileName('a'.repeat(300)).length).toBe(120);
    expect(normalizeWrittenByMeProfileName(42)).toBe('');
    expect(normalizeWrittenByMeProfileName(undefined)).toBe('');
  });
});

describe('normalizeWrittenByMeConvertLanguage()', () => {
  it('accepts ko/en and defaults everything else to same', () => {
    expect(normalizeWrittenByMeConvertLanguage('ko')).toBe('ko');
    expect(normalizeWrittenByMeConvertLanguage('en')).toBe('en');
    expect(normalizeWrittenByMeConvertLanguage('same')).toBe('same');
    expect(normalizeWrittenByMeConvertLanguage('fr')).toBe('same');
    expect(normalizeWrittenByMeConvertLanguage(undefined)).toBe('same');
  });
});

describe('WrittenByMe profile store', () => {
  it('saves and reads back a profile with a generated id and timestamps', () => {
    const dir = makeProfilesDir();
    const saved = saveWrittenByMeProfile(dir, {
      name: '  My voice ',
      skillMd: '# Style\n- terse',
      now: 1000,
    });
    expect(saved.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(saved.name).toBe('My voice');
    expect(saved.createdAt).toBe(1000);
    expect(saved.updatedAt).toBe(1000);

    const read = readWrittenByMeProfile(dir, saved.id);
    expect(read).not.toBeNull();
    expect(read?.skillMd).toBe('# Style\n- terse');
    expect(read?.name).toBe('My voice');
  });

  it('throws when skillMd is empty', () => {
    const dir = makeProfilesDir();
    expect(() => saveWrittenByMeProfile(dir, { name: 'x', skillMd: '   ' })).toThrow();
    expect(() => saveWrittenByMeProfile(dir, { name: 'x', skillMd: 42 })).toThrow();
  });

  it('updates an existing profile in place, preserving createdAt', () => {
    const dir = makeProfilesDir();
    const first = saveWrittenByMeProfile(dir, { name: 'v1', skillMd: 'a', now: 1000 });
    const second = saveWrittenByMeProfile(dir, {
      id: first.id,
      name: 'v2',
      skillMd: 'b',
      now: 2000,
    });
    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(1000);
    expect(second.updatedAt).toBe(2000);
    expect(second.name).toBe('v2');
    expect(readWrittenByMeProfile(dir, first.id)?.skillMd).toBe('b');
    // Still a single profile file, not a duplicate.
    expect(listWrittenByMeProfiles(dir)).toHaveLength(1);
  });

  it('lists profiles newest-first and ignores non-json files', () => {
    const dir = makeProfilesDir();
    saveWrittenByMeProfile(dir, { name: 'older', skillMd: 'a', now: 1000 });
    const newer = saveWrittenByMeProfile(dir, { name: 'newer', skillMd: 'b', now: 5000 });
    fs.writeFileSync(join(dir, 'notes.txt'), 'ignore me', 'utf-8');

    const list = listWrittenByMeProfiles(dir);
    expect(list.map((p) => p.name)).toEqual(['newer', 'older']);
    expect(list[0].id).toBe(newer.id);
    expect(list[0]).not.toHaveProperty('skillMd');
  });

  it('returns null for an invalid id, a missing file, and an empty dir', () => {
    const dir = makeProfilesDir();
    expect(readWrittenByMeProfile(dir, 'not-a-uuid')).toBeNull();
    expect(readWrittenByMeProfile(dir, '11111111-2222-3333-4444-555555555555')).toBeNull();
    expect(listWrittenByMeProfiles(join(dir, 'missing'))).toEqual([]);
  });

  it('deletes an existing profile and reports false for missing/invalid ids', () => {
    const dir = makeProfilesDir();
    const saved = saveWrittenByMeProfile(dir, { name: 'x', skillMd: 'a' });
    expect(deleteWrittenByMeProfile(dir, saved.id)).toBe(true);
    expect(readWrittenByMeProfile(dir, saved.id)).toBeNull();
    expect(deleteWrittenByMeProfile(dir, saved.id)).toBe(false);
    expect(deleteWrittenByMeProfile(dir, 'not-a-uuid')).toBe(false);
  });
});

describe('buildWrittenByMeConvertPrompt()', () => {
  const skillMd = '# STYLE\n- short sentences';
  const text = 'Please rewrite this text for me.';

  it('embeds the style, the text, and a preserve-meaning instruction', () => {
    const prompt = buildWrittenByMeConvertPrompt(text, skillMd, 'same');
    expect(prompt).toContain(skillMd);
    expect(prompt).toContain(text);
    expect(prompt).toContain('Preserve the original meaning');
    expect(prompt).toContain('Return ONLY the rewritten text');
  });

  it('varies the language directive by target', () => {
    expect(buildWrittenByMeConvertPrompt(text, skillMd, 'same')).toContain(
      'same language as the source',
    );
    expect(buildWrittenByMeConvertPrompt(text, skillMd, 'ko')).toContain('in Korean');
    expect(buildWrittenByMeConvertPrompt(text, skillMd, 'en')).toContain('in English');
  });
});
