import { describe, expect, it } from 'vitest';
import {
  describeDesktopActVerdict,
  splitDesktopToolImage,
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

  it('claims exactly the tool names it handles', () => {
    const names = getDesktopInputToolDefinitions().map((def) => def.function.name);
    expect(names).toEqual([
      'desktop_windows',
      'desktop_snapshot',
      'desktop_act',
      'desktop_key',
      'desktop_type',
      'desktop_click',
      'desktop_click_point',
      'desktop_scroll',
      'desktop_drag',
      'desktop_focus',
      'desktop_select',
      'desktop_toggle',
      'desktop_capture',
      'desktop_apps',
    ]);
    for (const name of names) {
      expect(isDesktopInputTool(name)).toBe(true);
    }
    expect(isDesktopInputTool('browser_drive_run')).toBe(false);
  });

  it('every tool declares the arguments it cannot work without', () => {
    // A tool that lets the model omit the snapshot id would let it address an
    // element by a bare index, which is the thing refs exist to prevent.
    const byName = new Map(
      getDesktopInputToolDefinitions().map((def) => [def.function.name, def.function]),
    );
    for (const name of ['desktop_click', 'desktop_scroll', 'desktop_drag']) {
      expect(byName.get(name)?.parameters.required, name).toContain('snapshot_id');
      expect(byName.get(name)?.parameters.required, name).toContain('ref');
    }
    // These act on the window, not an element -- demanding a ref would be theatre.
    for (const name of ['desktop_key', 'desktop_type', 'desktop_focus']) {
      expect(byName.get(name)?.parameters.required, name).not.toContain('ref');
    }
  });

  it('points the model at the provable tool instead of the loose one', () => {
    const byName = new Map(
      getDesktopInputToolDefinitions().map((def) => [def.function.name, def.function]),
    );
    // desktop_type cannot verify anything; desktop_act with a value can.
    expect(byName.get('desktop_type')?.description).toContain('desktop_act');
    // A single left click is provable through UIA; desktop_click is not.
    expect(byName.get('desktop_click')?.description).toContain('desktop_act');
  });

  it('marks the raw-point click as a last resort and says when it applies', () => {
    // A point is aimed at a guess; a ref is checked against the window. The
    // model needs to know which situation it is in.
    const point = getDesktopInputToolDefinitions().find(
      (def) => def.function.name === 'desktop_click_point',
    );
    expect(point?.function.description).toContain('LAST RESORT');
    expect(point?.function.description).toContain('no_automation_tree');
    expect(point?.function.parameters.required).toEqual(['hwnd', 'x', 'y']);
  });

  it('steers the model away from click-then-click on a dropdown', () => {
    // The menu a click opens did not exist at snapshot time, so a follow-up
    // click is aimed at something the model never saw.
    const select = getDesktopInputToolDefinitions().find(
      (def) => def.function.name === 'desktop_select',
    );
    expect(select?.function.description).toContain('did not exist when your snapshot was taken');
  });

  it('explains why setting a state beats clicking a checkbox', () => {
    const toggle = getDesktopInputToolDefinitions().find(
      (def) => def.function.name === 'desktop_toggle',
    );
    expect(toggle?.function.description).toContain('idempotent');
  });

  it('tells the model the capture numbers ARE the refs', () => {
    // A picture with numbers that mean nothing elsewhere would make the model
    // guess at a second lookup.
    const capture = getDesktopInputToolDefinitions().find(
      (def) => def.function.name === 'desktop_capture',
    );
    expect(capture?.function.description).toContain('same refs');
    // And that an unnumbered outline is deliberate, not a rendering glitch.
    expect(capture?.function.description).toContain('WITHOUT a number');
  });

  it('warns that raising a window is not free', () => {
    const focus = getDesktopInputToolDefinitions().find(
      (def) => def.function.name === 'desktop_focus',
    );
    // Focus is the one action whose side effect outlives the call.
    expect(focus?.function.description).toContain('CHANGES WHAT THE USER IS LOOKING AT');
  });

  it('tells the model a dropped modifier is refused, not silently ignored', () => {
    const click = getDesktopInputToolDefinitions().find(
      (def) => def.function.name === 'desktop_click',
    );
    expect(click?.function.description).toContain('refused');
  });
});

describe('splitDesktopToolImage', () => {
  it('moves the image out of the tool result', () => {
    // A base64 PNG left in the tool message would be megabytes of text the
    // model cannot look at.
    const { payload, image } = splitDesktopToolImage({
      ok: true,
      snapshot_id: 'dis-00000000',
      __image: { dataUrl: 'data:image/png;base64,AAAA', name: 'shot.png' },
    });
    expect(image).toEqual({ dataUrl: 'data:image/png;base64,AAAA', name: 'shot.png' });
    expect(payload).toEqual({ ok: true, snapshot_id: 'dis-00000000' });
    expect(payload).not.toHaveProperty('__image');
  });

  it('leaves a result with no image alone', () => {
    const result = { ok: true, elements: [] };
    expect(splitDesktopToolImage(result)).toEqual({ payload: result, image: null });
  });

  it('refuses anything that is not an image data URL', () => {
    // The field ends up in a message attachment; a URL here would make the
    // client fetch whatever it points at.
    const { payload, image } = splitDesktopToolImage({
      ok: true,
      __image: { dataUrl: 'https://example.com/tracker.png', name: 'x.png' },
    });
    expect(image).toBeNull();
    expect(payload).not.toHaveProperty('__image');
  });

  it('drops a capture whose image never arrived', () => {
    const { image } = splitDesktopToolImage({ ok: true, __image: null });
    expect(image).toBeNull();
  });
});
