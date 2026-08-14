import * as fs from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { ActionTypes, DELIBERATELY_UNEXPOSED_ACTIONS } from '../actions/constants';

// This desk can spawn AoiResearch runs (LLM + web pipeline) and triggers
// server-side external fetches. The safety boundary decided for it:
// - REFRESH_SIGNALS is agent-exposed: read-only idempotent GETs against a
//   fixed in-plugin registry, no parameter can shape an outbound URL.
// - START_RESEARCH (anything reaching startAoiResearchRun) is operator-click
//   only: a research run consumes real budget and network, and Aoi already
//   has its own gated research tool path.
// Enforced here by scanning the source, not by memory.

const APP_DIR = join(__dirname, '..');

/** Strip comments; string literals stay (the guard is about reachable code). */
function stripComments(source: string): string {
  let output = '';
  let index = 0;
  while (index < source.length) {
    const two = source.slice(index, index + 2);
    if (two === '//') {
      const end = source.indexOf('\n', index);
      index = end === -1 ? source.length : end;
      continue;
    }
    if (two === '/*') {
      const end = source.indexOf('*/', index + 2);
      index = end === -1 ? source.length : end + 2;
      continue;
    }
    output += source[index];
    index += 1;
  }
  return output;
}

function readSource(relativePath: string): string {
  return stripComments(fs.readFileSync(join(APP_DIR, relativePath), 'utf8'));
}

function extractAgentHandler(source: string): string {
  const start = source.indexOf('const handleAgentAction = useCallback(');
  const end = source.indexOf('useAgentActionListener(');
  expect(start, 'handleAgentAction must exist in index.tsx').toBeGreaterThan(-1);
  expect(end, 'useAgentActionListener must follow handleAgentAction').toBeGreaterThan(start);
  return source.slice(start, end);
}

/** Module specifiers imported by a file (import ... from '...'). */
function importSpecifiers(source: string): string[] {
  const matches = source.matchAll(/from\s+['"]([^'"]+)['"]/g);
  return Array.from(matches, (match) => match[1]);
}

const RESEARCH_CALLS = ['startAoiResearchRun', 'runHandoff', 'saveBrief', 'window.open'];

/**
 * Modules whose import chain reaches node built-ins (crypto/fs). Importing one
 * from app code breaks `pnpm build` while typecheck and vitest stay green —
 * this happened before in this repo. Only signalDeskShared is the sanctioned
 * client surface for the desk's wire types.
 */
const NODE_ONLY_LIB_MODULES = [
  'aoiInterestProfile',
  'aoiProactiveBriefStore',
  'signalDeskPlugin',
  'signalDeskCore',
];

const APP_SOURCE_FILES = [
  'index.tsx',
  'types.ts',
  'api.ts',
  'signalView.ts',
  'actions/constants.ts',
  'components/StatePanel.tsx',
];

describe('SignalDesk agent action surface', () => {
  const indexSource = readSource('index.tsx');

  it('exposes only view/refresh/sync actions', () => {
    expect(Object.values(ActionTypes).sort()).toEqual(
      ['REFRESH_SIGNALS', 'SELECT_SIGNAL_DESK_VIEW', 'SYNC_STATE'].sort(),
    );
  });

  it('never handles a deliberately unexposed action type', () => {
    const handler = extractAgentHandler(indexSource);
    for (const forbidden of DELIBERATELY_UNEXPOSED_ACTIONS) {
      expect(handler).not.toContain(forbidden);
    }
  });

  it('keeps every research-spawning call out of the agent handler', () => {
    const handler = extractAgentHandler(indexSource);
    for (const call of RESEARCH_CALLS) {
      expect(
        handler.includes(call),
        `${call} must not be reachable from handleAgentAction — the agent must not spawn research runs or side effects through this desk`,
      ).toBe(false);
    }
  });

  it('still wires the handoff to the component, so the guard is meaningful', () => {
    expect(indexSource).toContain('startAoiResearchRun');
    expect(indexSource).toContain('runHandoff');
  });

  it('does not call reportAction, avoiding duplicate action results', () => {
    expect(indexSource).not.toContain('reportAction');
  });

  it('reports lifecycle from the entry point only', () => {
    expect(indexSource).toContain('reportLifecycle');
    const componentsDir = join(APP_DIR, 'components');
    for (const name of fs.readdirSync(componentsDir)) {
      if (!name.endsWith('.tsx')) {
        continue;
      }
      expect(readSource(join('components', name))).not.toContain('reportLifecycle');
    }
  });

  it('passes APP_ID to the action listener', () => {
    expect(indexSource).toContain('useAgentActionListener(APP_ID');
  });
});

describe('SignalDesk client bundle safety', () => {
  it('never imports a node-backed module from app code', () => {
    for (const file of APP_SOURCE_FILES) {
      const specifiers = importSpecifiers(readSource(file));
      for (const specifier of specifiers) {
        for (const forbidden of NODE_ONLY_LIB_MODULES) {
          expect(
            specifier.includes(forbidden),
            `${file} imports ${specifier} — ${forbidden} reaches node built-ins and breaks pnpm build only`,
          ).toBe(false);
        }
      }
    }
  });

  it('takes wire types from signalDeskShared only', () => {
    const specifiers = APP_SOURCE_FILES.flatMap((file) => importSpecifiers(readSource(file)));
    const signalLibImports = specifiers.filter((specifier) => specifier.includes('signalDesk'));
    expect(signalLibImports.length).toBeGreaterThan(0);
    for (const specifier of signalLibImports) {
      expect(specifier).toBe('@/lib/signalDeskShared');
    }
  });
});
