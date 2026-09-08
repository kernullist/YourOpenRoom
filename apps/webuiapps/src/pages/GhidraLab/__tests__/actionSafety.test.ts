import * as fs from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { ActionTypes, DELIBERATELY_UNEXPOSED_ACTIONS } from '../actions/constants';

// This app starts real processes (a JVM running Ghidra, sometimes capa) and can
// run for half an hour on one click. Both go through propose -> operator
// approval -> execute, and the approval click is the control. The agent surface
// here is navigate-and-read only: Aoi has its own tools for the effectful paths,
// and a second door through the app window would skip the approval those tools
// are gated by.
//
// The bootstrap path matters most of all: it installs software into a virtual
// environment. It must be reachable only from a button a human pressed.

const APP_DIR = join(__dirname, '..');

/** Strip comments and string bodies: the guard is about reachable code. */
function stripNonCode(source: string): string {
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
    const char = source[index];
    if (char === "'" || char === '"' || char === '`') {
      const quote = char;
      let cursor = index + 1;
      let body = '';
      while (cursor < source.length) {
        if (source[cursor] === '\\') {
          body += source.slice(cursor, cursor + 2);
          cursor += 2;
          continue;
        }
        if (source[cursor] === quote) {
          break;
        }
        body += source[cursor];
        cursor += 1;
      }
      output += quote + body + quote;
      index = cursor + 1;
      continue;
    }
    output += char;
    index += 1;
  }
  return output;
}

function readSource(relativePath: string): string {
  return stripNonCode(fs.readFileSync(join(APP_DIR, relativePath), 'utf8'));
}

function extractAgentHandler(source: string): string {
  const start = source.indexOf('const handleAgentAction = useCallback(');
  const end = source.indexOf('useAgentActionListener(');
  expect(start, 'handleAgentAction must exist in index.tsx').toBeGreaterThan(-1);
  expect(end, 'useAgentActionListener must follow handleAgentAction').toBeGreaterThan(start);
  return source.slice(start, end);
}

const EFFECTFUL_CALLS = [
  'previewGhidraSession',
  'previewGhidraReport',
  'runGhidraApproval',
  'stopGhidraSession',
  'cancelGhidraRun',
  'saveGhidraLabConfigRemote',
  'bootstrapGhidraPython',
];

describe('GhidraLab agent action surface', () => {
  const indexSource = readSource('index.tsx');

  it('exposes only navigation and read actions', () => {
    expect(Object.values(ActionTypes).sort()).toEqual(
      [
        'SELECT_GHIDRA_SESSION',
        'SELECT_GHIDRA_RUN',
        'BROWSE_GHIDRA_BINARIES',
        'SET_GHIDRA_TAB',
        'REFRESH_GHIDRA_LAB',
        'SYNC_STATE',
      ].sort(),
    );
  });

  it('never handles an action type that would start, sweep, approve or install', () => {
    const handler = extractAgentHandler(indexSource);
    for (const forbidden of DELIBERATELY_UNEXPOSED_ACTIONS) {
      expect(handler).not.toContain(forbidden);
    }
  });

  it('keeps every effectful call out of the agent handler', () => {
    const handler = extractAgentHandler(indexSource);
    for (const call of EFFECTFUL_CALLS) {
      expect(
        handler.includes(call),
        `${call} must not be reachable from handleAgentAction -- the approval click is the control`,
      ).toBe(false);
    }
  });

  it('still wires preview, approve and bootstrap to the component, so the guard is meaningful', () => {
    for (const call of ['previewGhidraSession', 'runGhidraApproval', 'bootstrapGhidraPython']) {
      expect(indexSource).toContain(call);
    }
  });

  it('does not call reportAction, avoiding duplicate action results', () => {
    expect(indexSource).not.toContain('reportAction');
  });

  it('reports lifecycle from the entry file only', () => {
    expect(indexSource).toContain('reportLifecycle(AppLifecycle.LOADED)');
    const labView = readSource('labView.ts');
    expect(labView).not.toContain('reportLifecycle');
  });
});
