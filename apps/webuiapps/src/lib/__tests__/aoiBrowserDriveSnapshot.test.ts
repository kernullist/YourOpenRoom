import { describe, expect, it } from 'vitest';

import {
  buildAoiBrowserDriveSnapshot,
  formatAoiBrowserDriveSnapshot,
  isAoiBrowserDriveSnapshotCurrent,
  resolveAoiBrowserDriveElementRef,
} from '../aoiBrowserDriveSnapshot';

const URL = 'https://example.com/form';

function snap(html: string, url = URL) {
  return buildAoiBrowserDriveSnapshot({ html, url, now: 1 });
}

describe('buildAoiBrowserDriveSnapshot', () => {
  it('indexes interactables in document order with their accessible names', () => {
    const snapshot = snap(`
      <a id="home" href="/home">Home</a>
      <button id="save">Save changes</button>
      <input name="q" placeholder="Search" />
      <select name="country"><option>KR</option></select>
    `);
    expect(snapshot.elements.map((element) => [element.ref, element.role, element.name])).toEqual([
      [1, 'link', 'Home'],
      [2, 'button', 'Save changes'],
      [3, 'textbox', 'Search'],
      [4, 'select', 'KR'],
    ]);
  });

  it('prefers a page-provided identifier over a positional selector', () => {
    const snapshot = snap(`
      <button id="save">A</button>
      <button data-testid="cancel">B</button>
      <input name="email" />
    `);
    expect(snapshot.elements.map((element) => element.selector)).toEqual([
      '#save',
      '[data-testid="cancel"]',
      'input[name="email"]',
    ]);
  });

  it('does not address an element it cannot address correctly', () => {
    // The obvious fallback, tag:nth-of-type(n) counted over this scan, is WRONG:
    // CSS counts nth-of-type among siblings inside one parent while the scan is
    // document-wide, so on a page whose controls are not siblings it would point
    // at a different element. A ref that clicks the wrong control is worse than
    // no ref, so these are dropped and counted.
    const snapshot = snap(`
      <div><button id="ok">A</button></div>
      <div><button>B</button><button>C</button></div>
    `);
    expect(snapshot.elements.map((element) => element.selector)).toEqual(['#ok']);
    expect(snapshot.unaddressable).toBe(2);
    expect(formatAoiBrowserDriveSnapshot(snapshot)).toContain('2 more not addressable by ref');
  });

  it('cannot be broken out of by a crafted attribute', () => {
    // The selector is built from page-controlled text, so the quoting has to hold.
    const snapshot = snap("<input name='x\" ] , [autofocus' />");
    expect(snapshot.elements[0].selector).toContain('\\"');
    expect(snapshot.elements[0].selector.endsWith('"]')).toBe(true);
  });

  it('marks credential and payment inputs as forbidden', () => {
    const snapshot = snap(`
      <input type="password" name="pw" />
      <input name="cardNumber" />
      <input id="otp" />
      <input name="비밀번호" />
      <input name="nickname" />
    `);
    expect(snapshot.elements.map((element) => element.sensitive === true)).toEqual([
      true,
      true,
      true,
      true,
      false,
    ]);
  });

  it('maps every input type to a usable role', () => {
    const snapshot = snap(`
      <input type="checkbox" name="a" />
      <input type="radio" name="b" />
      <input type="submit" name="c" />
      <input type="reset" name="d" />
      <input type="email" name="e" />
      <input name="f" />
    `);
    expect(snapshot.elements.map((element) => element.role)).toEqual([
      'checkbox',
      'radio',
      'button',
      'button',
      'textbox',
      'textbox',
    ]);
  });

  it('marks disabled controls', () => {
    const snapshot = snap('<button id="a" disabled>Nope</button><button id="b">Yes</button>');
    expect(snapshot.elements[0].disabled).toBe(true);
    expect(snapshot.elements[1].disabled).toBeUndefined();
  });

  it('does not read a look-alike attribute as disabled', () => {
    // A bare word-boundary match also hit data-disabled, aria-disabled="false"
    // and class="not-disabled", so ordinary controls were refused as disabled.
    const snapshot = snap(`
      <button id="a" data-disabled="false">A</button>
      <button id="b" aria-disabled="false">B</button>
      <button id="c" class="not-disabled">C</button>
      <button id="d" disabled>D</button>
    `);
    expect(snapshot.elements.map((element) => element.disabled === true)).toEqual([
      false,
      false,
      false,
      true,
    ]);
  });

  it('strips markup and bounds page-controlled names', () => {
    // Every name lands in the model's context and the page writes it.
    const snapshot = snap(`<button id="a"><span>Hello</span> <b>world</b></button>`);
    expect(snapshot.elements[0].name).toBe('Hello world');
    const long = snap(`<button id="a">${'x'.repeat(400)}</button>`);
    expect(long.elements[0].name.length).toBeLessThanOrEqual(83);
    expect(long.elements[0].name.endsWith('...')).toBe(true);
  });

  it('ignores script and style content', () => {
    const snapshot = snap(`
      <script><button id="ghost">nope</button></script>
      <style>button { color: red }</style>
      <button id="real">Real</button>
    `);
    expect(snapshot.elements).toHaveLength(1);
    expect(snapshot.elements[0].selector).toBe('#real');
  });

  it('mints a new id whenever the page changes, and repeats it when nothing did', () => {
    // Ref identity depends on this: a changed page must never keep old refs valid.
    const a = snap('<button id="a">A</button>');
    const b = snap('<button id="a">A</button>');
    const c = snap('<button id="a">A</button><button id="b">B</button>');
    expect(a.id).toBe(b.id);
    expect(c.id).not.toBe(a.id);
    expect(snap('<button id="a">A</button>', 'https://other.test/').id).not.toBe(a.id);
  });

  it('survives empty and malformed html without throwing', () => {
    expect(snap('').elements).toEqual([]);
    expect(snap('<button>unclosed').elements).toEqual([]);
    expect(
      buildAoiBrowserDriveSnapshot({ html: null as never, url: URL, now: 1 }).elements,
    ).toEqual([]);
  });

  it('bounds how many elements a hostile page can push into context', () => {
    const snapshot = snap('<button id="x">x</button>'.repeat(500));
    expect(snapshot.elements.length).toBeLessThanOrEqual(120);
  });
});

describe('resolveAoiBrowserDriveElementRef', () => {
  const snapshot = snap(`
    <button id="go">Go</button>
    <input type="password" name="pw" />
    <button id="off" disabled>Off</button>
  `);

  it('resolves a ref to the selector the executor will use', () => {
    const resolved = resolveAoiBrowserDriveElementRef({
      snapshot,
      ref: 1,
      snapshotId: snapshot.id,
    });
    expect(resolved.ok).toBe(true);
    expect(resolved.selector).toBe('#go');
  });

  it('refuses a ref minted by an older snapshot instead of rebinding it', () => {
    // Silently resolving against whatever snapshot is loaded would act on a
    // different element than the model chose -- the exact failure ref
    // addressing exists to remove.
    const resolved = resolveAoiBrowserDriveElementRef({
      snapshot,
      ref: 1,
      snapshotId: 'bds-stale',
    });
    expect(resolved.ok).toBe(false);
    expect(resolved.code).toBe('element_ref_stale');
  });

  it('refuses when no snapshot has been taken', () => {
    expect(resolveAoiBrowserDriveElementRef({ snapshot: null, ref: 1 }).code).toBe(
      'element_snapshot_missing',
    );
  });

  it('refuses an unknown or non-integer ref', () => {
    for (const ref of [0, -1, 99, 1.5, NaN]) {
      expect(resolveAoiBrowserDriveElementRef({ snapshot, ref }).code, String(ref)).toBe(
        'element_ref_unknown',
      );
    }
  });

  it('never resolves a credential field, even by a valid ref', () => {
    const resolved = resolveAoiBrowserDriveElementRef({ snapshot, ref: 2 });
    expect(resolved.ok).toBe(false);
    expect(resolved.code).toBe('element_forbidden');
    expect(resolved.selector).toBeUndefined();
  });

  it('refuses a disabled element rather than acting into a no-op', () => {
    const resolved = resolveAoiBrowserDriveElementRef({ snapshot, ref: 3 });
    expect(resolved.ok).toBe(false);
    expect(resolved.code).toBe('element_disabled');
  });
});

describe('snapshot currency', () => {
  it('is invalidated by navigation', () => {
    const snapshot = snap('<button id="a">A</button>');
    expect(isAoiBrowserDriveSnapshotCurrent(snapshot, URL)).toBe(true);
    expect(isAoiBrowserDriveSnapshotCurrent(snapshot, 'https://example.com/other')).toBe(false);
    expect(isAoiBrowserDriveSnapshotCurrent(null, URL)).toBe(false);
  });
});

describe('formatAoiBrowserDriveSnapshot', () => {
  it('lists refs with roles and flags, and states the ref lifetime', () => {
    const text = formatAoiBrowserDriveSnapshot(
      snap('<button id="go">Go</button><input type="password" name="pw" />'),
    );
    expect(text).toContain('#1 button "Go"');
    expect(text).toContain('FORBIDDEN');
    expect(text).toContain('any act invalidates them');
  });

  it('says so plainly when a page has nothing to drive', () => {
    expect(formatAoiBrowserDriveSnapshot(snap('<p>text only</p>'))).toContain(
      'no interactable elements found',
    );
  });
});
