import { describe, expect, it } from 'vitest';
import {
  classifyResearchFailure,
  DEFAULT_SIGNAL_DESK_STATE,
  isCategoryFilter,
  isSignalDeskViewId,
  mergeSignalDeskState,
  SEEN_IDS_CAP,
} from '../types';

describe('guards', () => {
  it('accepts only known view ids', () => {
    expect(isSignalDeskViewId('inbox')).toBe(true);
    expect(isSignalDeskViewId('brief')).toBe(true);
    expect(isSignalDeskViewId('sources')).toBe(true);
    expect(isSignalDeskViewId('settings')).toBe(false);
    expect(isSignalDeskViewId(3)).toBe(false);
  });

  it('accepts all plus the seven categories as filters', () => {
    expect(isCategoryFilter('all')).toBe(true);
    expect(isCategoryFilter('vuln')).toBe(true);
    expect(isCategoryFilter('release')).toBe(true);
    expect(isCategoryFilter('ai')).toBe(true);
    expect(isCategoryFilter('harness')).toBe(true);
    expect(isCategoryFilter('news')).toBe(false);
    expect(isCategoryFilter(null)).toBe(false);
  });
});

describe('mergeSignalDeskState', () => {
  it('ignores non-object payloads entirely', () => {
    expect(mergeSignalDeskState(DEFAULT_SIGNAL_DESK_STATE, null)).toEqual(
      DEFAULT_SIGNAL_DESK_STATE,
    );
    expect(mergeSignalDeskState(DEFAULT_SIGNAL_DESK_STATE, [1, 2])).toEqual(
      DEFAULT_SIGNAL_DESK_STATE,
    );
    expect(mergeSignalDeskState(DEFAULT_SIGNAL_DESK_STATE, 'x')).toEqual(DEFAULT_SIGNAL_DESK_STATE);
  });

  it('applies only valid fields and leaves the rest untouched', () => {
    const merged = mergeSignalDeskState(DEFAULT_SIGNAL_DESK_STATE, {
      activeView: 'sources',
      category: 'nope',
      sessionPath: '  aoi/test  ',
      seenIds: ['a', 7, 'b', null],
    });
    expect(merged.activeView).toBe('sources');
    expect(merged.category).toBe('all');
    expect(merged.sessionPath).toBe('aoi/test');
    expect(merged.seenIds).toEqual(['a', 'b']);
  });

  it('caps seenIds keeping the newest tail', () => {
    const seenIds = Array.from({ length: SEEN_IDS_CAP + 10 }, (_, index) => `id-${index}`);
    const merged = mergeSignalDeskState(DEFAULT_SIGNAL_DESK_STATE, { seenIds });
    expect(merged.seenIds).toHaveLength(SEEN_IDS_CAP);
    expect(merged.seenIds[0]).toBe('id-10');
    expect(merged.seenIds[merged.seenIds.length - 1]).toBe(`id-${SEEN_IDS_CAP + 9}`);
  });
});

describe('classifyResearchFailure', () => {
  it('reads 409/duplicate/already-active answers as denied — the guard working', () => {
    expect(classifyResearchFailure('item-1', new Error('HTTP 409')).kind).toBe('denied');
    expect(
      classifyResearchFailure('item-1', new Error('An equivalent run is already active')).kind,
    ).toBe('denied');
    expect(classifyResearchFailure('item-1', new Error('duplicate request')).kind).toBe('denied');
  });

  it('keeps every other failure an error carrying the message', () => {
    const result = classifyResearchFailure('item-1', new Error('research engine offline'));
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.itemId).toBe('item-1');
      expect(result.message).toBe('research engine offline');
    }
  });

  it('stringifies non-Error throwables', () => {
    const result = classifyResearchFailure('item-1', 'boom');
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.message).toBe('boom');
    }
  });
});
