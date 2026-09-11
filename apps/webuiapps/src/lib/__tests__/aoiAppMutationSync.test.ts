import { describe, expect, it } from 'vitest';
import type { AppActionDef } from '../appRegistry';
import {
  aoiAppSyncDispatchCoversWrite,
  buildAoiAppMutationSyncCorrectionPrompt,
  buildAoiAppMutationSyncFailureMessage,
  createAoiAppMutationSyncEvidence,
  formatAoiAppSyncNoteForModel,
  isAoiAppStateFile,
  isAoiAppSyncActionType,
  observeAoiAppDataWrite,
  observeAoiAppSyncDispatch,
  parseAoiAppDataPath,
  planAoiAppSyncDispatch,
  verifyAoiAppMutationSyncContract,
  type AoiAppDataWriteRecord,
} from '../aoiAppMutationSync';

const action = (
  name: string,
  params: Array<{ name: string; required?: boolean }> = [],
): AppActionDef => ({
  name,
  description: name,
  params: params.map((param) => ({ type: 'string', description: '', ...param })),
});

const DIARY = {
  appId: 4,
  appName: 'diary',
  actions: [
    action('CREATE_ENTRY', [{ name: 'filePath', required: true }]),
    action('UPDATE_ENTRY', [{ name: 'filePath', required: true }]),
    action('DELETE_ENTRY', [{ name: 'entryId', required: true }]),
    action('SELECT_ENTRY', [{ name: 'entryId', required: true }]),
    action('SELECT_DATE', [{ name: 'date', required: true }]),
    action('OPEN_APP_WINDOW'),
  ],
};
const NOTES = {
  appId: 12,
  appName: 'notes',
  actions: [
    action('CREATE_NOTE', [{ name: 'filePath', required: true }, { name: 'focusId' }]),
    action('REFRESH_NOTES'),
  ],
};
// An app whose only mutation action needs something the runtime cannot derive.
const OPAQUE = {
  appId: 30,
  appName: 'opaque',
  actions: [action('CREATE_THING', [{ name: 'payload', required: true }])],
};
const APPS = [DIARY, NOTES, OPAQUE, { appId: 3, appName: 'youtube', actions: [] }];

const WRITE: AoiAppDataWriteRecord = {
  tool: 'file_write',
  appId: 4,
  appName: 'diary',
  filePath: 'apps/diary/data/entries/mission-list-2026-09-11.json',
  appRelativePath: '/entries/mission-list-2026-09-11.json',
  appWindowOpenAtWrite: true,
};

function written(
  records: Array<{ tool?: string; filePath: string; result?: string; open?: boolean }>,
) {
  let evidence = createAoiAppMutationSyncEvidence();
  for (const record of records) {
    evidence = observeAoiAppDataWrite(
      evidence,
      {
        tool: record.tool ?? 'file_write',
        filePath: record.filePath,
        result: record.result ?? 'success',
        appWindowOpen: record.open ?? true,
      },
      APPS,
    );
  }
  return evidence;
}

describe('parseAoiAppDataPath', () => {
  it('splits an app data path and normalises slashes', () => {
    expect(parseAoiAppDataPath('apps/diary/data/entries/x.json')).toEqual({
      appName: 'diary',
      filePath: 'apps/diary/data/entries/x.json',
      appRelativePath: '/entries/x.json',
    });
    expect(parseAoiAppDataPath('/Apps\\Notes\\data\\notes\\a.json')?.appRelativePath).toBe(
      '/notes/a.json',
    );
    expect(parseAoiAppDataPath('apps/diary/meta.yaml')).toBeNull();
    expect(parseAoiAppDataPath('apps/diary/data/')).toBeNull();
    expect(parseAoiAppDataPath('apps/diary/data/entries/')).toBeNull();
    expect(parseAoiAppDataPath('src/lib/x.ts')).toBeNull();
    expect(parseAoiAppDataPath('')).toBeNull();
  });

  it('tells the app state file from a record', () => {
    expect(isAoiAppStateFile({ appRelativePath: '/state.json' })).toBe(true);
    expect(isAoiAppStateFile({ appRelativePath: '/entries/x.json' })).toBe(false);
  });
});

describe('observeAoiAppDataWrite', () => {
  it('records successful writes under a known app, with the window state, and ignores the rest', () => {
    const evidence = written([{ filePath: WRITE.filePath }]);
    expect(evidence.writes).toEqual([WRITE]);
    expect(
      written([{ filePath: WRITE.filePath, open: false }]).writes[0].appWindowOpenAtWrite,
    ).toBe(false);
    // Failed write, read tool, unknown app, non-data path: none count.
    for (const record of [
      { tool: 'file_write', filePath: WRITE.filePath, result: 'error: schema validation failed' },
      { tool: 'file_read', filePath: WRITE.filePath, result: '{...}' },
      { tool: 'file_write', filePath: 'apps/unknownapp/data/x.json', result: 'success' },
      { tool: 'file_write', filePath: 'apps/diary/guide.md', result: 'success' },
      { tool: 'file_delete', filePath: WRITE.filePath, result: 'timeout: no response' },
    ]) {
      expect(
        observeAoiAppDataWrite(evidence, { ...record, appWindowOpen: true }, APPS).writes,
      ).toHaveLength(1);
    }
  });
});

describe('isAoiAppSyncActionType', () => {
  it('recognises the mutation and refresh families only', () => {
    for (const name of [
      'CREATE_ENTRY',
      'update_note',
      'DELETE_TRACK',
      'REFRESH_TRACKS',
      'SYNC_STATE',
      'IMPORT_CARDS',
    ]) {
      expect(isAoiAppSyncActionType(name)).toBe(true);
    }
    for (const name of ['SELECT_ENTRY', 'OPEN_SEARCH', 'PLAY_TRACK', 'FOCUS_APP_WINDOW', '']) {
      expect(isAoiAppSyncActionType(name)).toBe(false);
    }
  });
});

describe('planAoiAppSyncDispatch', () => {
  it('picks the create action with the file path for a new file', () => {
    expect(planAoiAppSyncDispatch(WRITE, DIARY)).toEqual({
      actionType: 'CREATE_ENTRY',
      params: { filePath: '/entries/mission-list-2026-09-11.json' },
    });
  });

  it('prefers update for a patch and the id-based delete for a delete', () => {
    expect(planAoiAppSyncDispatch({ ...WRITE, tool: 'file_patch' }, DIARY)?.actionType).toBe(
      'UPDATE_ENTRY',
    );
    expect(planAoiAppSyncDispatch({ ...WRITE, tool: 'file_delete' }, DIARY)).toEqual({
      actionType: 'DELETE_ENTRY',
      params: { entryId: 'mission-list-2026-09-11' },
    });
  });

  it('fills only the params it can derive and falls back to a parameterless refresh', () => {
    const note = { ...WRITE, appId: 12, appName: 'notes', appRelativePath: '/notes/a.json' };
    // The optional focusId is an id too: the created note gets focused.
    expect(planAoiAppSyncDispatch(note, NOTES)).toEqual({
      actionType: 'CREATE_NOTE',
      params: { filePath: '/notes/a.json', focusId: 'a' },
    });
    expect(planAoiAppSyncDispatch({ ...note, tool: 'file_delete' }, NOTES)).toEqual({
      actionType: 'REFRESH_NOTES',
      params: {},
    });
  });

  it('never turns the app state file into a record action', () => {
    const state = {
      ...WRITE,
      appRelativePath: '/state.json',
      filePath: 'apps/diary/data/state.json',
    };
    // Diary has no whole-app refresh: nothing can be planned, nothing is owed.
    expect(planAoiAppSyncDispatch(state, DIARY)).toBeNull();
    const noteState = {
      ...state,
      appId: 12,
      appName: 'notes',
      filePath: 'apps/notes/data/state.json',
    };
    expect(planAoiAppSyncDispatch(noteState, NOTES)).toEqual({
      actionType: 'REFRESH_NOTES',
      params: {},
    });
  });

  it('returns null when nothing declared can be sent on the model behalf', () => {
    expect(planAoiAppSyncDispatch({ ...WRITE, appId: 30, appName: 'opaque' }, OPAQUE)).toBeNull();
    expect(planAoiAppSyncDispatch(WRITE, { actions: [] })).toBeNull();
    expect(planAoiAppSyncDispatch(WRITE, { actions: undefined })).toBeNull();
  });
});

describe('aoiAppSyncDispatchCoversWrite', () => {
  const dispatch = (actionType: string, params?: Record<string, string>, appId = 4) => ({
    appId,
    actionType,
    params,
    result: 'success',
    source: 'model' as const,
  });

  it('matches the file by app-relative path, tool path, or stem, and refreshes cover all', () => {
    expect(
      aoiAppSyncDispatchCoversWrite(
        dispatch('CREATE_ENTRY', { filePath: WRITE.appRelativePath }),
        WRITE,
      ),
    ).toBe(true);
    expect(
      aoiAppSyncDispatchCoversWrite(
        dispatch('UPDATE_ENTRY', { filePath: 'entries/mission-list-2026-09-11.json' }),
        WRITE,
      ),
    ).toBe(true);
    expect(
      aoiAppSyncDispatchCoversWrite(dispatch('UPDATE_ENTRY', { filePath: WRITE.filePath }), WRITE),
    ).toBe(true);
    expect(
      aoiAppSyncDispatchCoversWrite(
        dispatch('DELETE_ENTRY', { entryId: 'mission-list-2026-09-11' }),
        WRITE,
      ),
    ).toBe(true);
    expect(aoiAppSyncDispatchCoversWrite(dispatch('REFRESH_ENTRIES', {}), WRITE)).toBe(true);
    expect(aoiAppSyncDispatchCoversWrite(dispatch('SYNC_STATE'), WRITE)).toBe(true);
  });

  it('does not let a sync for another file, another app, or a navigation action count', () => {
    expect(
      aoiAppSyncDispatchCoversWrite(
        dispatch('CREATE_ENTRY', { filePath: '/entries/other.json' }),
        WRITE,
      ),
    ).toBe(false);
    expect(
      aoiAppSyncDispatchCoversWrite(
        dispatch('CREATE_ENTRY', { filePath: WRITE.appRelativePath }, 12),
        WRITE,
      ),
    ).toBe(false);
    expect(
      aoiAppSyncDispatchCoversWrite(
        dispatch('SELECT_ENTRY', { entryId: 'mission-list-2026-09-11' }),
        WRITE,
      ),
    ).toBe(false);
  });
});

describe('verifyAoiAppMutationSyncContract', () => {
  it('blocks a file written to an open app that nobody told, naming the action', () => {
    const verification = verifyAoiAppMutationSyncContract({
      evidence: written([{ filePath: WRITE.filePath }]),
      apps: APPS,
    });
    expect(verification.passed).toBe(false);
    expect(verification.enforced).toBe(true);
    expect(verification.issues[0]).toContain('CREATE_ENTRY');
    expect(verification.pending[0].appName).toBe('diary');
    expect(verification.pending[0].writes[0]).toMatchObject({
      plan: { actionType: 'CREATE_ENTRY' },
      attemptedButFailed: false,
    });
  });

  it('passes once a covering sync succeeded, from the runtime or the model', () => {
    for (const source of ['runtime', 'model'] as const) {
      const synced = observeAoiAppSyncDispatch(written([{ filePath: WRITE.filePath }]), {
        appId: 4,
        actionType: 'CREATE_ENTRY',
        params: { filePath: WRITE.appRelativePath },
        result: 'success',
        source,
      });
      expect(verifyAoiAppMutationSyncContract({ evidence: synced, apps: APPS }).passed).toBe(true);
    }
  });

  it('checks every file, not the app as a whole', () => {
    const two = written([
      { filePath: WRITE.filePath },
      { filePath: 'apps/diary/data/entries/second.json' },
    ]);
    const oneSynced = observeAoiAppSyncDispatch(two, {
      appId: 4,
      actionType: 'CREATE_ENTRY',
      params: { filePath: WRITE.appRelativePath },
      result: 'success',
      source: 'runtime',
    });
    const verification = verifyAoiAppMutationSyncContract({ evidence: oneSynced, apps: APPS });
    expect(verification.passed).toBe(false);
    expect(verification.pending[0].writes.map((item) => item.write.appRelativePath)).toEqual([
      '/entries/second.json',
    ]);
    // A navigation action is not a sync.
    const navigated = observeAoiAppSyncDispatch(written([{ filePath: WRITE.filePath }]), {
      appId: 4,
      actionType: 'SELECT_DATE',
      params: { date: '2026-09-11' },
      result: 'success',
      source: 'model',
    });
    expect(verifyAoiAppMutationSyncContract({ evidence: navigated, apps: APPS }).passed).toBe(
      false,
    );
  });

  it('owes nothing for a file written while the app was closed, even if it is open at reply time', () => {
    // The app re-read its data when it opened; the obligation is decided at
    // write time, not at respond_to_user time.
    expect(
      verifyAoiAppMutationSyncContract({
        evidence: written([{ filePath: WRITE.filePath, open: false }]),
        apps: APPS,
      }),
    ).toMatchObject({ passed: true, enforced: false, pending: [] });
  });

  it('does not re-demand a failed attempt, and cannot block without a plan', () => {
    const failed = observeAoiAppSyncDispatch(written([{ filePath: WRITE.filePath }]), {
      appId: 4,
      actionType: 'CREATE_ENTRY',
      params: { filePath: WRITE.appRelativePath },
      result: 'timeout: no response from app',
      source: 'runtime',
    });
    const verification = verifyAoiAppMutationSyncContract({ evidence: failed, apps: APPS });
    expect(verification.passed).toBe(true);
    expect(verification.enforced).toBe(true);
    expect(verification.pending[0].writes[0].attemptedButFailed).toBe(true);

    // The Diary state file has no plan (no whole-app refresh declared) and a
    // YouTube state write has no sync action at all: pending, not blocking.
    const unplannable = verifyAoiAppMutationSyncContract({
      evidence: written([
        { filePath: 'apps/diary/data/state.json' },
        { filePath: 'apps/youtube/data/state.json' },
      ]),
      apps: APPS,
    });
    expect(unplannable.passed).toBe(true);
    expect(unplannable.enforced).toBe(true);
    expect(unplannable.pending.map((entry) => entry.writes[0].plan)).toEqual([null, null]);
  });
});

describe('prompts and notes', () => {
  it('writes a correction that names the exact call, and skips files it cannot plan', () => {
    const verification = verifyAoiAppMutationSyncContract({
      evidence: written([{ filePath: WRITE.filePath }, { filePath: 'apps/diary/data/state.json' }]),
      apps: APPS,
    });
    const prompt = buildAoiAppMutationSyncCorrectionPrompt(verification);
    expect(prompt).toContain('Postcondition failed');
    expect(prompt).toContain(
      'app_action(app_name="diary", action_type="CREATE_ENTRY", params={"filePath":"/entries/mission-list-2026-09-11.json"})',
    );
    expect(prompt).not.toContain('state.json');
    expect(prompt).toContain('do not say the change is showing');
    expect(buildAoiAppMutationSyncFailureMessage(verification)).toContain('diary');
    expect(buildAoiAppMutationSyncFailureMessage({ ...verification, passed: true })).toBe('');
  });

  it('tells the model what the runtime dispatched, and when it failed', () => {
    const plan = { actionType: 'CREATE_ENTRY', params: { filePath: WRITE.appRelativePath } };
    expect(formatAoiAppSyncNoteForModel('diary', plan, WRITE, 'success')).toContain(
      'no further app_action is needed',
    );
    expect(formatAoiAppSyncNoteForModel('diary', plan, WRITE, 'timeout: no response')).toContain(
      'has NOT refreshed',
    );
  });
});
