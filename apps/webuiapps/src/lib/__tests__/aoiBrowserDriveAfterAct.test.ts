import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  diffAoiBrowserDriveVisibleText,
  executeAoiBrowserDriveStep,
  type AoiBrowserDriveActablePage,
} from '../aoiBrowserDriveExecutor';
import {
  addAoiBrowserDriveAllowlistEntry,
  type AoiBrowserDriveAllowlist,
} from '../aoiBrowserDriveAllowlist';
import type { AoiBrowserDriveActionRequest } from '../aoiBrowserDriveAction';

// evil.example is denied; everything public is allowed.
const DENYLIST: AoiBrowserDriveAllowlist = addAoiBrowserDriveAllowlistEntry(
  { version: 1, entries: [], updatedAt: 0 },
  { domain: 'evil.example' },
  1,
).allowlist;

const CART = 'https://shop.example/cart';

interface PageState {
  url: string;
  text: string;
  dialog: { type: string; message: string } | null;
  tabs: { index: number; url: string; title: string; current: boolean }[];
}

interface LookPageOptions {
  text?: string;
  onClick?: (state: PageState) => void;
  // Runs inside each wait after the act, numbered from 1: what the page does
  // while it is being given time.
  onSettle?: (state: PageState, look: number) => void;
  // Replaces the innerText read; numbered from 1, the first being the read
  // before the act.
  onRead?: (state: PageState, read: number) => Promise<string>;
  withoutInnerText?: boolean;
  tabs?: PageState['tabs'];
  // What a control shows when it is read on its own (the live-DOM check reads
  // the target's visible text); numbered from 1 per read.
  controlText?: (selector: string, read: number) => string;
}

function lookPage(options: LookPageOptions = {}) {
  const state: PageState = {
    url: CART,
    text: options.text ?? 'Shop\nYour cart is empty\nCheckout',
    dialog: null,
    tabs: options.tabs ?? [],
  };
  let reads = 0;
  let controlReads = 0;
  const sleeps: number[] = [];
  const page = {
    url: () => state.url,
    goto: vi.fn(async (target: string) => {
      state.url = target;
    }),
    content: vi.fn(async () => '<html><body></body></html>'),
    title: vi.fn(async () => 'Shop'),
    click: vi.fn(async () => {
      options.onClick?.(state);
    }),
    fill: vi.fn(async () => {}),
    selectOption: vi.fn(async () => []),
    press: vi.fn(async () => {}),
    goBack: vi.fn(async () => null),
    screenshot: vi.fn(async () => new Uint8Array([1])),
    mouse: { wheel: vi.fn(async () => {}) },
    textContent: vi.fn(async (): Promise<string | null> => null),
    getAttribute: vi.fn(async () => null),
    waitForLoadState: vi.fn(async () => {}),
    pendingDialog: () => state.dialog,
    ...(options.tabs ? { listTabs: vi.fn(async () => state.tabs) } : {}),
    ...(options.withoutInnerText
      ? {}
      : {
          innerText: vi.fn(async (selector: string) => {
            // The page's text is the body's; a control says only its own words.
            if (selector !== 'body') {
              controlReads += 1;
              return options.controlText ? options.controlText(selector, controlReads) : '';
            }
            reads += 1;
            return options.onRead ? options.onRead(state, reads) : state.text;
          }),
        }),
  };
  const sleep = async (ms: number) => {
    sleeps.push(ms);
    options.onSettle?.(state, sleeps.length);
  };
  return { page: page as unknown as AoiBrowserDriveActablePage, raw: page, state, sleeps, sleep };
}

function clickPlan(action: AoiBrowserDriveActionRequest = { kind: 'click', selector: '#add' }) {
  return { goal: 'add the item', steps: [{ description: 'click add', action }] };
}

async function act(fixture: ReturnType<typeof lookPage>, action?: AoiBrowserDriveActionRequest) {
  return executeAoiBrowserDriveStep({
    page: fixture.page,
    plan: clickPlan(action),
    stepIndex: 0,
    allowlist: DENYLIST,
    approvalGate: async () => ({ approved: true }),
    now: 1_000,
    sleep: fixture.sleep,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('diffAoiBrowserDriveVisibleText', () => {
  it('counts repeated lines and ignores spacing', () => {
    const diff = diffAoiBrowserDriveVisibleText(
      'Item\n  Item  \nTotal: 1',
      'Item\nItem\nItem\nTotal:   2\n\n',
    );
    expect(diff.appeared).toEqual(['Item', 'Total: 2']);
    expect(diff.gone).toEqual(['Total: 1']);
    expect(diff.reordered).toBe(false);
  });

  it('tells lines that only moved from lines that did not change at all', () => {
    expect(diffAoiBrowserDriveVisibleText('A\nB\nC', 'C\nA\nB')).toEqual({
      appeared: [],
      gone: [],
      reordered: true,
    });
    // Spacing and blank lines are not order.
    expect(diffAoiBrowserDriveVisibleText('A  B\nC', '\nA B\n\nC\n').reordered).toBe(false);
  });
});

describe('looking at the page again after an act', () => {
  it('says what text the act put on the page and what it took away', async () => {
    const fixture = lookPage({
      onClick: (state) => {
        state.text = 'Shop\nAdded to cart\nCheckout';
      },
    });
    const result = await act(fixture);

    expect(result.ok).toBe(true);
    expect(result.afterAct).toEqual({
      waitedMs: 300,
      url: CART,
      urlChanged: false,
      textRead: true,
      textAppeared: ['Added to cart'],
      textGone: ['Your cart is empty'],
    });
    // The page had answered by the first look.
    expect(fixture.sleeps).toEqual([300]);
    // Evidence to read, not proof: the verdict is unchanged by it.
    expect(result.verdict?.effect).toBe('unverifiable');
  });

  it('says when the page had more text than it compares, without a half line', async () => {
    // Over 200,000 characters: the end is cut at a line, and the look says so.
    const filler = `${'Row of the long table\n'.repeat(9_500)}`;
    const fixture = lookPage({
      text: `${filler}Your cart is empty\nFooter`,
      onClick: (state) => {
        state.text = `Added to cart\n${filler}Your cart is empty\nFooter`;
      },
    });
    const result = await act(fixture);

    expect(result.afterAct?.textTruncated).toBe(true);
    expect(result.afterAct?.textAppeared).toEqual(['Added to cart']);
    // The line pushed past the cut does not read as gone, and no half line
    // reads as changed.
    expect(result.afterAct?.textGone).toEqual([]);
  });

  it('reports a list the act only put in a different order', async () => {
    const fixture = lookPage({
      text: 'Orders\nApple\nBanana\nCherry',
      onClick: (state) => {
        state.text = 'Orders\nCherry\nBanana\nApple';
      },
    });
    const result = await act(fixture);

    expect(result.afterAct?.textAppeared).toEqual([]);
    expect(result.afterAct?.textGone).toEqual([]);
    expect(result.afterAct?.textReordered).toBe(true);
  });

  it('looks a second time when the first look saw nothing change', async () => {
    const fixture = lookPage({
      onSettle: (state, look) => {
        if (look === 2) {
          state.text = 'Shop\nYour cart is empty\nCheckout\nSaved';
        }
      },
    });
    const result = await act(fixture);

    expect(fixture.sleeps).toEqual([300, 700]);
    expect(result.afterAct?.waitedMs).toBe(1000);
    expect(result.afterAct?.textAppeared).toEqual(['Saved']);
  });

  it('waits for a navigation the act started, and the verdict counts it', async () => {
    const fixture = lookPage({
      onClick: (state) => {
        state.url = 'https://shop.example/checkout';
        state.text = 'Checkout\nPay now';
      },
    });
    const result = await act(fixture);

    expect(fixture.raw.waitForLoadState).toHaveBeenCalledWith('domcontentloaded', {
      timeout: 3_000,
    });
    expect(result.afterAct?.urlChanged).toBe(true);
    expect(result.finalUrl).toBe('https://shop.example/checkout');
    expect(result.verdict?.effect).toBe('confirmed');
  });

  it('sees a navigation that only starts while the page is given time, without crediting the act', async () => {
    // A single-page app routes a moment after the click, and the look reports
    // it. The verdict does not count it: a page routes on its own too, and only
    // a navigation already there when the act returns is the act's.
    const fixture = lookPage({
      onSettle: (state) => {
        state.url = 'https://shop.example/cart/added';
      },
    });
    const result = await act(fixture);

    expect(result.afterAct?.urlChanged).toBe(true);
    expect(result.finalUrl).toBe('https://shop.example/cart/added');
    expect(result.verdict?.effect).toBe('unverifiable');
  });

  it('treats a redirect onto a denied site during the wait as drift, and never reads it', async () => {
    const fixture = lookPage({
      onSettle: (state) => {
        state.url = 'https://evil.example/phish';
        state.text = 'Enter your password';
      },
    });
    const result = await act(fixture);

    expect(result.ok).toBe(false);
    // The act ran before the page left: contained, and not to be repeated.
    expect(result.stopReason).toBe('drift_after_act');
    expect(result.verdict).toMatchObject({ effect: 'unverifiable', code: 'drift_after_act' });
    expect(result.afterAct).toBeUndefined();
    expect(fixture.raw.goto).toHaveBeenCalledWith('about:blank', expect.anything());
    // Read once, before the act. The denied page was never read.
    expect(
      (fixture.raw.innerText?.mock.calls ?? []).filter(([selector]) => selector === 'body'),
    ).toHaveLength(1);
  });

  it('drops text read while a redirect landed on a denied site', async () => {
    const fixture = lookPage({
      onRead: async (state, read) => {
        if (read === 2) {
          state.url = 'https://evil.example/landing';
          return 'Enter your password';
        }
        return state.text;
      },
    });
    const result = await act(fixture);

    // The act ran before the page left: contained, and not to be repeated.
    expect(result.stopReason).toBe('drift_after_act');
    expect(result.verdict).toMatchObject({ effect: 'unverifiable', code: 'drift_after_act' });
    // Only the origin of a denied page's address is kept.
    expect(result.finalUrl).toBe('https://evil.example');
    expect(JSON.stringify(result)).not.toContain('Enter your password');
  });

  it('reports a dialog the act raised instead of reading through it', async () => {
    const fixture = lookPage({
      onClick: (state) => {
        state.dialog = { type: 'confirm', message: 'Empty the cart?' };
      },
    });
    const result = await act(fixture, { kind: 'click', selector: '#empty' });

    expect(result.afterAct).toMatchObject({
      textRead: false,
      dialog: { type: 'confirm', message: 'Empty the cart?' },
    });
    // The dialog is an answer: one look, and no read that would wait on it.
    expect(fixture.sleeps).toEqual([300]);
    expect(
      (fixture.raw.innerText?.mock.calls ?? []).filter(([selector]) => selector === 'body'),
    ).toHaveLength(1);
  });

  it('stops waiting on a click once the dialog it raised is showing', async () => {
    // A real browser does not let the click finish while the dialog is up: it
    // used to sit out the whole act timeout and come back as a failed click.
    const fixture = lookPage({
      onClick: (state) => {
        state.dialog = { type: 'confirm', message: 'Empty the cart?' };
      },
    });
    fixture.raw.click.mockImplementation(async () => {
      fixture.state.dialog = { type: 'confirm', message: 'Empty the cart?' };
      await new Promise(() => {});
    });
    const started = Date.now();
    const result = await act(fixture, { kind: 'click', selector: '#empty' });

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.ok).toBe(true);
    expect(result.verdict?.effect).toBe('unverifiable');
    expect(result.afterAct?.dialog).toEqual({ type: 'confirm', message: 'Empty the cart?' });
  });

  it('still reports a click that failed outright while it watched for a dialog', async () => {
    const fixture = lookPage();
    fixture.raw.click.mockImplementation(async () => {
      await new Promise((resolveLater) => setTimeout(resolveLater, 80));
      throw new Error('element is detached');
    });
    const result = await act(fixture);

    expect(result.ok).toBe(false);
    expect(result.stopReason).toBe('action_failed');
    expect(result.detail).toContain('element is detached');
  });

  it('does not send an act while a dialog nobody answered holds the page', async () => {
    // Sent now, the click would queue behind the dialog and land whenever the
    // dialog went -- after this call, with nobody looking.
    const fixture = lookPage();
    fixture.state.dialog = { type: 'alert', message: 'Welcome back' };
    const result = await act(fixture);

    expect(fixture.raw.click).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('dialog_pending');
    expect(result.verdict?.effect).toBe('suspected_noop');
  });

  it('says whether the act went through is unknown when a dialog beat it back', async () => {
    // The click is still waiting when the dialog shows: the page may have
    // raised it first, with the click never delivered.
    const fixture = lookPage();
    fixture.raw.click.mockImplementation(() => {
      fixture.state.dialog = { type: 'alert', message: 'Session expiring' };
      return new Promise<void>(() => {});
    });
    const result = await act(fixture);

    expect(result.ok).toBe(true);
    expect(result.afterAct?.actInterrupted).toBe(true);
    expect(result.afterAct?.dialog).toEqual({ type: 'alert', message: 'Session expiring' });
    expect(result.verdict?.effect).toBe('unverifiable');
  });

  it('does not credit an act a dialog beat back with a navigation that happened meanwhile', async () => {
    // The page routed and alerted on its own while the click still waited.
    const fixture = lookPage();
    fixture.raw.click.mockImplementation(() => {
      fixture.state.url = 'https://shop.example/login?expired=1';
      fixture.state.dialog = { type: 'alert', message: 'Session expired' };
      return new Promise<void>(() => {});
    });
    const result = await act(fixture);

    expect(result.afterAct?.actInterrupted).toBe(true);
    expect(result.verdict?.effect).toBe('unverifiable');
  });

  it('refuses the act when the page moved to another site during the approval', async () => {
    const fixture = lookPage();
    const result = await executeAoiBrowserDriveStep({
      page: fixture.page,
      plan: clickPlan(),
      stepIndex: 0,
      allowlist: DENYLIST,
      approvalGate: async () => {
        fixture.state.url = 'https://other.example/landing';
        return { approved: true };
      },
      now: 1_000,
      sleep: fixture.sleep,
    });

    expect(fixture.raw.click).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.stopReason).toBe('approval_denied');
    expect(result.detail).toContain('shop.example to other.example');
  });

  it('refuses the act when the page moved onto a denied site during the approval', async () => {
    const fixture = lookPage();
    const result = await executeAoiBrowserDriveStep({
      page: fixture.page,
      plan: clickPlan(),
      stepIndex: 0,
      allowlist: DENYLIST,
      approvalGate: async () => {
        fixture.state.url = 'https://evil.example/account?token=s3cret';
        return { approved: true };
      },
      now: 1_000,
      sleep: fixture.sleep,
    });

    expect(fixture.raw.click).not.toHaveBeenCalled();
    expect(result.stopReason).toBe('drift_to_denylist');
    // Contained like any drift, and its address goes no further than its origin.
    expect(fixture.raw.goto).toHaveBeenCalledWith('about:blank', expect.anything());
    expect(result.finalUrl).toBe('https://evil.example');
  });

  it('checks the target again after the approval, right before touching it', async () => {
    // Harmless when the approval was asked for; a pay button by the time the
    // act would run.
    const fixture = lookPage({ controlText: (_selector, read) => (read > 1 ? 'Pay now' : 'Add') });
    const result = await act(fixture);

    expect(fixture.raw.click).not.toHaveBeenCalled();
    expect(result.stopReason).toBe('forbidden');
  });

  it('answers a dialog without mistaking it for one the act raised', async () => {
    const fixture = lookPage();
    fixture.state.dialog = { type: 'confirm', message: 'Leave this page?' };
    const answerDialog = vi.fn(async () => {
      fixture.state.dialog = null;
      return 'Leave this page?';
    });
    (fixture.page as unknown as Record<string, unknown>).answerDialog = answerDialog;
    const result = await act(fixture, { kind: 'dialog', disposition: 'dismiss' });

    // A dismiss names no question it read; its wait ends with the act's.
    expect(answerDialog).toHaveBeenCalledWith('dismiss', undefined, {
      timeoutMs: expect.any(Number),
    });
    expect(result.ok).toBe(true);
    expect(result.afterAct?.dialog).toBeUndefined();
  });

  it('accepts only the dialog whose question it judged as it answers', async () => {
    const fixture = lookPage();
    fixture.state.dialog = { type: 'confirm', message: 'Leave this page?' };
    const answerDialog = vi.fn(async () => {
      fixture.state.dialog = null;
      return 'Leave this page?';
    });
    (fixture.page as unknown as Record<string, unknown>).answerDialog = answerDialog;
    const accepted = await act(fixture, { kind: 'dialog', disposition: 'accept' });
    expect(accepted.ok).toBe(true);
    expect(answerDialog).toHaveBeenCalledWith('accept', undefined, {
      read: 'Leave this page?',
      timeoutMs: expect.any(Number),
    });
  });

  it('does not accept a dialog the page raised in place of the one judged', async () => {
    const leave = { type: 'confirm', message: 'Leave this page?' };
    // How often the page is asked what dialog it shows, up to the answer: the
    // last of those reads is the one the answer goes by.
    const counted = lookPage();
    let counting = 0;
    let readsAtAnswer = 0;
    Object.assign(counted.page, {
      pendingDialog: () => {
        counting += 1;
        return leave;
      },
      answerDialog: vi.fn(async () => {
        readsAtAnswer = counting;
        return leave.message;
      }),
    });
    await act(counted, { kind: 'dialog', disposition: 'accept' });
    expect(readsAtAnswer).toBeGreaterThan(1);
    // Read and found harmless before the act; by the time it is answered, a
    // pay confirm in its place -- or none at all.
    for (const [later, detail] of [
      [{ type: 'confirm', message: 'Pay $49.00 now?' }, 'never permitted'],
      [null, 'no dialog is showing'],
    ] as const) {
      const fixture = lookPage();
      let reads = 0;
      const answerDialog = vi.fn(async () => '');
      Object.assign(fixture.page, {
        pendingDialog: () => {
          reads += 1;
          return reads >= readsAtAnswer ? later : leave;
        },
        answerDialog,
      });
      const result = await act(fixture, { kind: 'dialog', disposition: 'accept' });
      expect(result.ok, JSON.stringify(later)).toBe(false);
      expect(result.detail).toContain(detail);
      expect(answerDialog).not.toHaveBeenCalled();
    }
  });

  it('does not list tabs while a dialog holds the page', async () => {
    // Listing reads each tab's title, which a dialog-held tab cannot give until
    // the dialog is gone: in Chrome that waited out the 30 s dismissal.
    const fixture = lookPage({
      tabs: [{ index: 0, url: CART, title: 'Shop', current: true }],
      onClick: (state) => {
        state.dialog = { type: 'alert', message: 'Saved' };
      },
    });
    const result = await act(fixture);

    expect(result.afterAct?.dialog).toEqual({ type: 'alert', message: 'Saved' });
    expect(result.afterAct?.tabsOpened).toBeUndefined();
    // Listed once, before the act; not again while the dialog is up.
    expect(
      (fixture.raw as unknown as { listTabs: ReturnType<typeof vi.fn> }).listTabs,
    ).toHaveBeenCalledTimes(1);
  });

  it('treats a dialog check that fails as no dialog', async () => {
    const fixture = lookPage({
      onClick: (state) => {
        state.text = 'Shop\nAdded to cart\nCheckout';
      },
    });
    (fixture.page as unknown as Record<string, unknown>).pendingDialog = () => {
      throw new Error('page closed');
    };
    const result = await act(fixture);

    expect(result.ok).toBe(true);
    expect(result.afterAct?.dialog).toBeUndefined();
    expect(result.afterAct?.textAppeared).toEqual(['Added to cart']);
  });

  it('carries on when the navigation it waited for does not finish', async () => {
    const fixture = lookPage({
      onClick: (state) => {
        state.url = 'https://shop.example/slow';
      },
    });
    fixture.raw.waitForLoadState.mockRejectedValue(new Error('Timeout 3000ms exceeded'));
    const result = await act(fixture);

    expect(result.ok).toBe(true);
    expect(result.afterAct?.urlChanged).toBe(true);
  });

  it('keeps the look to its budget when the page never finishes loading', async () => {
    // A navigation that never loads, and a page whose text takes its time: the
    // look waits on neither past its own few seconds, and gives each wait only
    // what is left.
    const fixture = lookPage({
      onClick: (state) => {
        state.url = 'https://shop.example/never';
      },
      onRead: (state, read) =>
        read === 1
          ? Promise.resolve(state.text)
          : new Promise((resolveRead) => setTimeout(() => resolveRead(state.text), 1_800)),
    });
    const loadTimeouts: number[] = [];
    const waitForLoadState = fixture.raw.waitForLoadState as unknown as {
      mockImplementation(
        implementation: (state: string, options: { timeout: number }) => Promise<void>,
      ): void;
    };
    waitForLoadState.mockImplementation(async (_state: string, options: { timeout: number }) => {
      loadTimeouts.push(options.timeout);
      await new Promise((resolveWait) => setTimeout(resolveWait, 1_500));
      throw new Error(`Timeout ${options.timeout}ms exceeded`);
    });
    const started = Date.now();
    const result = await act(fixture);
    expect(Date.now() - started).toBeLessThan(4_500);
    expect(result.afterAct?.urlChanged).toBe(true);
    expect(Math.max(...loadTimeouts)).toBeLessThanOrEqual(3_000);
    // One look, not two: the budget was spent.
    expect(fixture.sleeps).toEqual([300]);
  }, 10_000);

  it('names no tabs when the tab listing fails after the act', async () => {
    const own = { index: 0, url: CART, title: 'Shop', current: true };
    const fixture = lookPage({ tabs: [own] });
    const listTabs = (fixture.raw as unknown as { listTabs: ReturnType<typeof vi.fn> }).listTabs;
    listTabs.mockResolvedValueOnce([own]).mockRejectedValueOnce(new Error('target closed'));
    const result = await act(fixture);

    expect(result.ok).toBe(true);
    expect(result.afterAct?.tabsOpened).toBeUndefined();
  });

  it('tells which tab is new by identity, not by how many there are', async () => {
    // One tab closed while the act opened another: the count stayed the same,
    // and counting positions missed the new tab entirely.
    const fixture = lookPage({
      tabs: [
        { index: 0, url: CART, title: 'Shop', current: true, id: 1 },
        { index: 1, url: 'https://news.example/', title: 'News', current: false, id: 2 },
      ] as never,
      onClick: (state) => {
        state.tabs = [
          { index: 0, url: CART, title: 'Shop', current: true, id: 1 },
          { index: 1, url: 'https://pay.example/help', title: 'Help', current: false, id: 3 },
        ] as never;
      },
    });
    const result = await act(fixture);

    expect(result.afterAct?.tabsOpened).toEqual([
      { index: 1, url: 'https://pay.example/help', title: 'Help' },
    ]);
  });

  it('names tabs the act opened, without describing denied ones', async () => {
    const own = { index: 0, url: CART, title: 'Shop', current: true };
    const fixture = lookPage({
      tabs: [own],
      onClick: (state) => {
        state.tabs = [
          own,
          { index: 1, url: 'https://pay.example/', title: 'Pay', current: false },
          { index: 2, url: 'https://evil.example/', title: 'Win a prize', current: false },
        ];
        state.text = 'Shop\nOpened in a new tab\nCheckout';
      },
    });
    const result = await act(fixture);

    expect(result.afterAct?.tabsOpened).toEqual([
      { index: 1, url: 'https://pay.example/', title: 'Pay' },
      { index: 2, url: '', title: '', denylisted: true },
    ]);
  });

  it('leaves a page that cannot show its text exactly as before', async () => {
    const fixture = lookPage({ withoutInnerText: true });
    const result = await act(fixture);

    expect(result.ok).toBe(true);
    expect(result.afterAct).toBeUndefined();
    expect(fixture.sleeps).toEqual([]);
  });

  it('cannot compare text it could not read before the act', async () => {
    const fixture = lookPage({
      onRead: async (state, read) => {
        if (read === 1) {
          throw new Error('Execution context was destroyed');
        }
        return state.text;
      },
    });
    const result = await act(fixture);

    expect(result.afterAct).toMatchObject({ textRead: false, textAppeared: [], textGone: [] });
    // Nothing to compare with, so no look could tell the page had answered.
    expect(fixture.sleeps).toEqual([300, 700]);
  });

  it('keeps the look short', async () => {
    const before = Array.from({ length: 15 }, (_, index) => `Old row ${index + 1}`).join('\n');
    const fixture = lookPage({
      text: before,
      onClick: (state) => {
        state.text = [
          'x'.repeat(500),
          ...Array.from({ length: 19 }, (_, index) => `New row ${index + 1}`),
        ].join('\n');
      },
    });
    const result = await act(fixture);

    expect(result.afterAct?.textAppeared).toHaveLength(12);
    expect(result.afterAct?.textAppeared[0]).toBe(`${'x'.repeat(200)}...`);
    expect(result.afterAct?.textAppearedOmitted).toBe(8);
    expect(result.afterAct?.textGone).toHaveLength(12);
    expect(result.afterAct?.textGoneOmitted).toBe(3);
  });

  it('does not hang on a read that never answers', async () => {
    vi.useFakeTimers();
    const fixture = lookPage({
      onRead: (state, read) =>
        read === 1 ? Promise.resolve(state.text) : new Promise<string>(() => {}),
    });
    const pending = act(fixture);
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await pending;

    expect(result.ok).toBe(true);
    expect(result.afterAct?.textRead).toBe(false);
  });
});
