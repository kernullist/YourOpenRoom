import * as fs from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { ActionTypes, DELIBERATELY_UNEXPOSED_ACTIONS } from '../actions/constants';

// This app starts real processes (IDA / idasql) and can write to an IDA database.
// Both go through propose -> operator approval -> execute, and the approval click
// is the control. The agent surface here is navigate-and-read only: Aoi has its
// own tools for the effectful paths, and a second door through the app window
// would skip the popup those tools are gated by.

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
  'previewIdaSqlSession',
  'runIdaSqlApproval',
  'runIdaSqlQuery',
  'stopIdaSqlSession',
  'attachIdaSqlGuiSession',
  'saveIdaSqlConfigPatch',
  'createIdaSqlGrant',
  'deleteIdaSqlGrant',
];

describe('IdaLab agent action surface', () => {
  const indexSource = readSource('index.tsx');

  it('exposes only navigation and read actions', () => {
    expect(Object.values(ActionTypes).sort()).toEqual(
      [
        'SELECT_IDA_SESSION',
        'SET_IDA_SQL_DRAFT',
        'BROWSE_IDA_BINARIES',
        'REFRESH_IDA_LAB',
        'SYNC_STATE',
      ].sort(),
    );
  });

  it('never handles an action type that would start, write, or approve', () => {
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

  it('still wires preview, approve and query to the component, so the guard is meaningful', () => {
    expect(indexSource).toContain('previewIdaSqlSession');
    expect(indexSource).toContain('runIdaSqlApproval');
    expect(indexSource).toContain('runIdaSqlQuery');
  });

  it('does not call reportAction, avoiding duplicate action results', () => {
    expect(indexSource).not.toContain('reportAction');
  });

  it('reports lifecycle from the entry point only', () => {
    expect(indexSource).toContain('reportLifecycle');
  });

  it('passes APP_ID to the action listener', () => {
    expect(indexSource).toContain('useAgentActionListener(APP_ID');
  });

  it('never imports a node-only module into app code', () => {
    // idaSqlPlugin / idaSqlSession / idaSqlConfig / idaSqlStandingGrant all reach
    // for node fs, path or child_process. Importing one here would break
    // `pnpm build` while typecheck and vitest stayed green.
    for (const file of ['index.tsx', 'labView.ts']) {
      const source = readSource(file);
      for (const nodeOnly of [
        'idaSqlPlugin',
        'idaSqlSession',
        'idaSqlConfig',
        'idaSqlStandingGrant',
      ]) {
        expect(source, `${file} must not import ${nodeOnly}`).not.toContain(nodeOnly);
      }
    }
  });
});
