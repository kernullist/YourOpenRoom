import * as fs from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { ActionTypes, DELIBERATELY_UNEXPOSED_ACTIONS } from '../actions/constants';

// This app can terminate processes on the real machine. Killing is irreversible
// and the execute path is fail-closed on a human-approved, single-use approval,
// so the agent surface is read and filter only.
//
// The kill switch is excluded for the mirrored reason: it is the operator's
// brake, and a brake the agent can release is not a brake.

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

const DESTRUCTIVE_CALLS = [
  'fetchAoiHostKillPreview',
  'runAoiHostKillExecute',
  'setAoiHostBridgeKillSwitch',
  'approveAoiHostApproval',
  'approveAndExecuteAoiHostApproval',
];

describe('HostSentinel agent action surface', () => {
  const indexSource = readSource('index.tsx');

  it('exposes only read and filter actions', () => {
    expect(Object.values(ActionTypes).sort()).toEqual(
      ['FILTER_HOST_PROCESSES', 'REFRESH_HOST_SENTINEL', 'SYNC_STATE'].sort(),
    );
  });

  it('never handles an action type that would kill or unbrake', () => {
    const handler = extractAgentHandler(indexSource);
    for (const forbidden of DELIBERATELY_UNEXPOSED_ACTIONS) {
      expect(handler).not.toContain(forbidden);
    }
  });

  it('keeps every destructive call out of the agent handler', () => {
    const handler = extractAgentHandler(indexSource);
    for (const call of DESTRUCTIVE_CALLS) {
      expect(
        handler.includes(call),
        `${call} must not be reachable from handleAgentAction -- killing is irreversible`,
      ).toBe(false);
    }
  });

  it('never approves on the operator behalf, anywhere in the app', () => {
    // The approval must happen in the Host Bridge inbox. Approving its own
    // preview would collapse the three-step loop into one.
    for (const call of ['approveAoiHostApproval', 'approveAndExecuteAoiHostApproval']) {
      expect(indexSource).not.toContain(call);
    }
  });

  it('never touches the kill switch, which is the operator brake', () => {
    expect(indexSource).not.toContain('setAoiHostBridgeKillSwitch');
  });

  it('still wires preview and execute to the component, so the guard is meaningful', () => {
    expect(indexSource).toContain('fetchAoiHostKillPreview');
    expect(indexSource).toContain('runAoiHostKillExecute');
    expect(indexSource).toContain('runKillPreview');
    expect(indexSource).toContain('runKillExecute');
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

  it('never imports a node-only host module into app code', () => {
    // The bridge plugin and its stores use node fs; importing one here would
    // break `pnpm build` while typecheck and vitest stayed green.
    for (const file of ['index.tsx', 'processView.ts']) {
      const source = readSource(file);
      expect(source).not.toContain('aoiHostBridgePlugin');
      expect(source).not.toContain('aoiHostProcessKill');
    }
  });
});
