import { describe, expect, it } from 'vitest';
import {
  describeDesktopActVerdict,
  getDesktopInputToolDefinitions,
  isDesktopInputTool,
} from './aoiDesktopInputTools';

// What the model is TOLD about a result is load-bearing. These pin that no
// verdict shape can be read as a completion claim unless something proved it.
describe('describeDesktopActVerdict', () => {
  it('lets Aoi report a proven act', () => {
    const result = describeDesktopActVerdict({
      ok: true,
      effect: 'confirmed',
      verified: true,
      path: 'uia_value',
      detail: 'value read back and matches',
    });
    expect(result.status).toBe('done');
    expect(result.note).toContain('proven');
  });

  it('does not let transport success become a completion claim', () => {
    // The SendInput rung always lands here: delivered, unproven.
    const result = describeDesktopActVerdict({
      ok: true,
      effect: 'unverifiable',
      verified: false,
      path: 'sendinput',
      detail: 'clicked by synthetic mouse input at the element center',
    });
    expect(result.status).toBe('delivered_unverified');
    expect(result.note).toContain('Do NOT repeat');
    expect(result.note).toContain('nothing proves it landed');
  });

  it('calls a refusal what it is', () => {
    const result = describeDesktopActVerdict({
      ok: false,
      effect: 'suspected_noop',
      verified: false,
      code: 'element_forbidden',
      detail: 'credential fields are never driven by Aoi',
    });
    expect(result.status).toBe('not_performed');
    expect(result.note).toContain('Nothing happened');
    // And it must not invite a workaround.
    expect(result.note).toContain('do not try to work around the refusal');
  });

  it('turns a stale ref into re-look, not retry', () => {
    // Retrying a stale ref is the dangerous reading: the index may now point at
    // a different control entirely.
    const result = describeDesktopActVerdict({
      ok: false,
      effect: 'suspected_noop',
      verified: false,
      code: 'element_ref_stale',
      detail: 'the window changed since the snapshot',
    });
    expect(result.status).toBe('stale');
    expect(result.note).toContain('fresh desktop_snapshot');
    expect(result.note).toContain('Do not reuse the old ref');
  });

  it('never reports an unknown effect as done', () => {
    const result = describeDesktopActVerdict({
      ok: true,
      effect: 'totally-worked',
      verified: false,
      detail: '',
    });
    expect(result.status).toBe('not_performed');
  });

  it('trusts a read-back even if the effect string is unfamiliar', () => {
    // verified=true only ever comes from reading the value off the live element.
    const result = describeDesktopActVerdict({
      ok: true,
      effect: 'weird',
      verified: true,
      detail: '',
    });
    expect(result.status).toBe('done');
  });
});

describe('getDesktopInputToolDefinitions', () => {
  it('requires a snapshot id alongside the ref', () => {
    const act = getDesktopInputToolDefinitions().find((def) => def.function.name === 'desktop_act');
    expect(act).toBeTruthy();
    expect(act?.function.parameters.required).toEqual(['hwnd', 'ref', 'snapshot_id']);
  });

  it('tells the model that ok is not proof', () => {
    // The description is the only place the model learns this before it acts.
    const act = getDesktopInputToolDefinitions().find((def) => def.function.name === 'desktop_act');
    expect(act?.function.description).toContain('is NOT proof');
  });

  it('warns that a silent window is not an empty window', () => {
    const snapshot = getDesktopInputToolDefinitions().find(
      (def) => def.function.name === 'desktop_snapshot',
    );
    expect(snapshot?.function.description).toContain('no_automation_tree');
  });

  it('claims exactly the three tool names it handles', () => {
    const names = getDesktopInputToolDefinitions().map((def) => def.function.name);
    expect(names).toEqual(['desktop_windows', 'desktop_snapshot', 'desktop_act']);
    for (const name of names) {
      expect(isDesktopInputTool(name)).toBe(true);
    }
    expect(isDesktopInputTool('browser_drive_run')).toBe(false);
  });
});
