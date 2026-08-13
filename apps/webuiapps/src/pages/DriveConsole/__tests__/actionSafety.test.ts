import * as fs from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { ActionTypes, DELIBERATELY_UNEXPOSED_ACTIONS } from '../actions/constants';

// This console can drive the user's real, logged-in browser. Everything that
// does so stays behind an operator click, and the agent surface is read and
// navigation only.
//
// The execute path is fail-closed on a human-approved, single-use approval. An
// agent action that could reach preview -> approve -> execute would let Aoi
// authorize its own plan and act in that browser, which is the one thing the
// whole gate chain exists to prevent.

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

const DRIVING_CALLS = [
  'fetchAoiHostBrowserDriveActPreview',
  'runAoiHostBrowserDriveActExecute',
  'runAoiHostBrowserDriveTask',
  'fetchAoiHostBrowserDriveRead',
  'approveAoiHostApproval',
  'approveAndExecuteAoiHostApproval',
];

describe('DriveConsole agent action surface', () => {
  const indexSource = readSource('index.tsx');

  it('exposes only read and navigation actions', () => {
    expect(Object.values(ActionTypes).sort()).toEqual(
      ['REFRESH_DRIVE_CONSOLE', 'SELECT_DRIVE_CONSOLE_VIEW', 'SYNC_STATE'].sort(),
    );
  });

  it('never handles an action type that would drive the browser', () => {
    const handler = extractAgentHandler(indexSource);
    for (const forbidden of DELIBERATELY_UNEXPOSED_ACTIONS) {
      expect(handler).not.toContain(forbidden);
    }
  });

  it('keeps every driving call out of the agent handler', () => {
    const handler = extractAgentHandler(indexSource);
    for (const call of DRIVING_CALLS) {
      expect(
        handler.includes(call),
        `${call} must not be reachable from handleAgentAction -- Aoi cannot authorize its own plan`,
      ).toBe(false);
    }
  });

  it('never approves on the operator behalf, anywhere in the app', () => {
    // The approval must happen in the Host Bridge inbox. A console that could
    // approve its own preview would collapse the three-step loop into one.
    for (const call of ['approveAoiHostApproval', 'approveAndExecuteAoiHostApproval']) {
      expect(indexSource).not.toContain(call);
    }
  });

  it('still wires preview and execute to the component, so the guard is meaningful', () => {
    expect(indexSource).toContain('fetchAoiHostBrowserDriveActPreview');
    expect(indexSource).toContain('runAoiHostBrowserDriveActExecute');
    expect(indexSource).toContain('runPreview');
    expect(indexSource).toContain('runExecute');
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

  it('never imports the fs-backed allowlist module into app code', () => {
    // aoiBrowserDriveAllowlist uses node fs; importing it here would break
    // `pnpm build` while typecheck and vitest stayed green.
    for (const file of ['index.tsx', 'planDraft.ts', 'types.ts']) {
      expect(readSource(file)).not.toContain('aoiBrowserDriveAllowlist');
    }
  });
});
