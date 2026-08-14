import * as fs from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

// Desktop icons resolve through Shell's manual ICON_MAP with a silent
// `|| Circle` fallback, so a registry icon name missing from the map is
// invisible until someone squints at the desktop — it happened to five apps
// (Activity x2, MousePointerClick, Sprout, Video) before being noticed.
// Enforce the registry/map pairing by source scan, the same way the
// actionSafety tests pin their boundaries. A typo'd lucide name still fails
// at compile time via the import; this test covers the forgotten-entry case.

const SHELL_SOURCE = fs.readFileSync(join(__dirname, '..', 'index.tsx'), 'utf8');
const REGISTRY_SOURCE = fs.readFileSync(
  join(__dirname, '..', '..', '..', 'lib', 'appRegistry.ts'),
  'utf8',
);

function declaredRegistryIcons(): string[] {
  const matches = REGISTRY_SOURCE.matchAll(/icon:\s*'([A-Za-z0-9]+)'/g);
  return Array.from(new Set(Array.from(matches, (match) => match[1])));
}

function iconMapKeys(): Set<string> {
  const block = SHELL_SOURCE.match(/const ICON_MAP[^=]*=\s*\{([\s\S]*?)\};/);
  expect(block, 'ICON_MAP must exist in Shell/index.tsx').not.toBeNull();
  return new Set(block![1].match(/[A-Za-z0-9]+/g) ?? []);
}

describe('Shell ICON_MAP', () => {
  it('has at least the shape this scan expects', () => {
    expect(declaredRegistryIcons().length).toBeGreaterThan(10);
    expect(iconMapKeys().size).toBeGreaterThan(10);
  });

  it('resolves every icon declared in APP_STATIC_REGISTRY without falling back to Circle', () => {
    const keys = iconMapKeys();
    const missing = declaredRegistryIcons().filter((name) => !keys.has(name));
    expect(missing, `registry icons missing from ICON_MAP: ${missing.join(', ')}`).toEqual([]);
  });
});
