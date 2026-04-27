import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  getTsSemanticDefinition,
  getTsSemanticReferences,
  getTsSemanticRenameLocations,
} from '../openVscodeTsLanguageService';

const tempDirs: string[] = [];

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/');
}

function makeTempWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openroom-ts-service-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('openVscodeTsLanguageService', () => {
  it('resolves semantic definition, references, and rename locations from a tsconfig project', () => {
    const rootDir = makeTempWorkspace();
    fs.mkdirSync(path.join(rootDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, 'tsconfig.json'),
      JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2020',
            module: 'ESNext',
            moduleResolution: 'node',
            strict: true,
          },
          include: ['src/**/*.ts'],
        },
        null,
        2,
      ),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(rootDir, 'src', 'a.ts'),
      [
        'export const OldName = 1;',
        'export function useOldName() {',
        '  return OldName;',
        '}',
      ].join('\n'),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(rootDir, 'src', 'b.ts'),
      ['import { OldName } from "./a";', 'console.log(OldName);'].join('\n'),
      'utf-8',
    );

    const definition = getTsSemanticDefinition({ rootDir, symbol: 'OldName' });
    const references = getTsSemanticReferences({ rootDir, symbol: 'OldName' });
    const renameLocations = getTsSemanticRenameLocations({ rootDir, symbol: 'OldName' });

    expect(definition ? normalizePath(definition.fileName).endsWith('src/a.ts') : false).toBe(true);
    expect(references?.length).toBeGreaterThanOrEqual(3);
    expect(renameLocations?.length).toBeGreaterThanOrEqual(3);
  });
});
