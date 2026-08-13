import * as fs from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { ActionTypes, DELIBERATELY_UNEXPOSED_ACTIONS } from '../actions/constants';

// Structural guard for the one invariant this app could quietly break.
//
// Mission Control renders Aoi's own proposal queue AND is reachable by Aoi
// through the agent action bus. If any agent action branch could reach the
// decision endpoint, Aoi would be able to accept its own proposals -- the exact
// self-approval the autonomy model forbids structurally (L5 is unreachable by
// auto-promotion; promotion writes throw for any actor other than 'user').
//
// A comment cannot enforce that, and a future refactor that "helpfully" lets the
// agent refresh-and-approve would look perfectly reasonable in review. So the
// separation is asserted against the source text: the agent handler must not
// mention the mutating functions at all.

const APP_DIR = join(__dirname, '..');

/**
 * Strip comments and string literals before scanning.
 *
 * The guard is about reachable CODE. Without this it also trips on the prose
 * that explains the rule -- the doc comment above ProposalInspector names
 * `decideProposal` precisely to say it must not be called there. A guard that
 * fails when you document it teaches people to delete the documentation.
 */
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
      // Keep the quotes so assertions like "actor: 'user'" can still match on a
      // normalized placeholder, but drop the body so prose inside strings does
      // not count as a call site.
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

/**
 * Slice out the agent action handler.
 *
 * Bounded by the `useAgentActionListener` registration that immediately follows
 * it, so the slice cannot silently swallow the whole file if the handler is
 * renamed -- the assertions below would then be vacuously true.
 */
function extractAgentHandler(source: string): string {
  const start = source.indexOf('const handleAgentAction = useCallback(');
  const end = source.indexOf('useAgentActionListener(');
  expect(start, 'handleAgentAction must exist in index.tsx').toBeGreaterThan(-1);
  expect(end, 'useAgentActionListener must follow handleAgentAction').toBeGreaterThan(start);
  return source.slice(start, end);
}

const MUTATING_FUNCTIONS = ['decideProposal', 'runManualTick'];

describe('agent action surface', () => {
  const indexSource = readSource('index.tsx');

  it('exposes only read and navigation actions', () => {
    expect(Object.values(ActionTypes).sort()).toEqual(
      [
        'REFRESH_MISSION_CONTROL',
        'SELECT_MISSION_CONTROL_SESSION',
        'SELECT_MISSION_CONTROL_VIEW',
        'SYNC_STATE',
      ].sort(),
    );
  });

  it('never handles an action type that would mutate autonomy state', () => {
    const handler = extractAgentHandler(indexSource);
    for (const forbidden of DELIBERATELY_UNEXPOSED_ACTIONS) {
      expect(handler).not.toContain(forbidden);
    }
  });

  it('keeps the mutating API calls out of the agent handler entirely', () => {
    const handler = extractAgentHandler(indexSource);
    for (const fn of MUTATING_FUNCTIONS) {
      expect(
        handler.includes(fn),
        `${fn} must not be reachable from handleAgentAction -- that would let Aoi drive its own approvals`,
      ).toBe(false);
    }
  });

  it('does not let the agent handler write the autonomy policy', () => {
    const handler = extractAgentHandler(indexSource);
    expect(handler).not.toContain('/policy');
    expect(handler).not.toContain('policy');
  });

  it('still wires the mutating calls to the component, so the guard is meaningful', () => {
    // Without this, the assertions above would pass trivially on an app that
    // simply dropped the operator controls.
    for (const fn of MUTATING_FUNCTIONS) {
      expect(indexSource).toContain(fn);
    }
    expect(indexSource).toContain('handleDecide');
    expect(indexSource).toContain('handleManualTick');
  });

  it('routes decisions through the inspector buttons only', () => {
    const inspector = readSource('components/ProposalInspector.tsx');
    // The inspector raises an intent; it never calls the API itself, so there is
    // exactly one place (index.tsx) where a decision can be issued.
    expect(inspector).not.toContain('decideProposal');
    expect(inspector).toContain("onDecide('accept')");
    expect(inspector).toContain("onDecide('dismiss')");
  });

  it('sends every decision as an explicit user actor', () => {
    const apiSource = readSource('api.ts');
    expect(apiSource).toContain("actor: 'user'");
    expect(apiSource).not.toContain("actor: 'system'");
  });

  it('does not call reportAction anywhere, avoiding duplicate action results', () => {
    // useAgentActionListener already returns an action_result via sendResult.
    // Calling reportAction from a handler would deliver the agent two copies of
    // every action.
    for (const file of ['index.tsx', 'api.ts']) {
      expect(readSource(file)).not.toContain('reportAction');
    }
  });

  it('reports lifecycle from the entry point only', () => {
    expect(indexSource).toContain('reportLifecycle');
    const componentsDir = join(APP_DIR, 'components');
    for (const name of fs.readdirSync(componentsDir)) {
      if (!name.endsWith('.tsx')) {
        continue;
      }
      expect(
        readSource(join('components', name)),
        `${name} must not report lifecycle -- only index.tsx may`,
      ).not.toContain('reportLifecycle');
    }
  });

  it('passes APP_ID to the action listener', () => {
    expect(indexSource).toContain('useAgentActionListener(APP_ID');
  });
});
