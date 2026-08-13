import * as fs from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { ActionTypes, DELIBERATELY_UNEXPOSED_ACTIONS } from '../actions/constants';

// This app DOES give the agent write access -- a check-in is the user's own
// record, and "I stretched this morning" is the most natural way to use it.
//
// What the agent must not touch is the two consent switches: one decides whether
// habit data reaches Aoi at all, the other repaints the user's desktop. An
// opt-in the agent can flip on for itself is not an opt-in, so the toggles are
// DOM-only and that separation is asserted against the source rather than left
// to review.

const APP_DIR = join(__dirname, '..');

/** Strip comments and string bodies: the guard is about reachable code, not prose. */
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

/**
 * Slice out the agent handler, bounded by the listener registration that follows
 * it so a rename cannot make the assertions vacuously true.
 */
function extractAgentHandler(source: string): string {
  const start = source.indexOf('const handleAgentAction = useCallback(');
  const end = source.indexOf('useAgentActionListener(');
  expect(start, 'handleAgentAction must exist in index.tsx').toBeGreaterThan(-1);
  expect(end, 'useAgentActionListener must follow handleAgentAction').toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('HabitGarden agent action surface', () => {
  const indexSource = readSource('index.tsx');

  it('exposes exactly the eight documented actions', () => {
    expect(Object.values(ActionTypes).sort()).toEqual(
      [
        'CHECK_IN_HABIT',
        'CREATE_HABIT',
        'DELETE_HABIT',
        'REFRESH_HABIT_GARDEN',
        'SELECT_HABIT',
        'SYNC_STATE',
        'UNDO_HABIT_CHECK_IN',
        'UPDATE_HABIT',
      ].sort(),
    );
  });

  it('never handles a settings action type', () => {
    const handler = extractAgentHandler(indexSource);
    for (const forbidden of DELIBERATELY_UNEXPOSED_ACTIONS) {
      expect(handler).not.toContain(forbidden);
    }
  });

  it('keeps the consent flags out of the agent handler entirely', () => {
    const handler = extractAgentHandler(indexSource);
    for (const flag of ['reflectWeatherInRoom', 'shareMomentumWithAoi', 'handleSettingsChange']) {
      expect(
        handler.includes(flag),
        `${flag} must not be reachable from handleAgentAction -- the agent cannot grant itself consent`,
      ).toBe(false);
    }
  });

  it('keeps room-theme writes out of the agent handler', () => {
    const handler = extractAgentHandler(indexSource);
    expect(handler).not.toContain('applyRoomItem');
    expect(handler).not.toContain('roomWeather');
  });

  it('still wires the settings path to the component, so the guard is meaningful', () => {
    // Without this the assertions above would pass on an app that simply dropped
    // the feature.
    expect(indexSource).toContain('handleSettingsChange');
    expect(indexSource).toContain('applyRoomItem');
  });

  it('suppresses duplicate reporting when an action comes from the agent', () => {
    // useAgentActionListener already returns a result via sendResult, so calling
    // reportAction inside a handler would deliver the agent two copies. The
    // business functions take a fromAgent flag instead of dropping reporting for
    // user clicks too.
    const handler = extractAgentHandler(indexSource);
    expect(handler).not.toContain('reportAction(');
    expect(indexSource).toContain('fromAgent');
    expect(indexSource).toContain('reportAction(APP_ID');
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

  it('never imports the server-only momentum reader into app code', () => {
    // habitGardenMomentum uses node fs. Importing it here would break `pnpm build`
    // while leaving typecheck and vitest green.
    for (const file of ['index.tsx', 'repository.ts', 'garden.ts', 'roomWeather.ts']) {
      expect(readSource(file)).not.toContain('habitGardenMomentum');
    }
  });
});
