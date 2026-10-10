import { describe, expect, it, vi } from 'vitest';

import {
  AOI_BROWSER_DRIVE_REACH_SELECTORS as REACH,
  computeAoiBrowserDriveActionFingerprint,
  executeAoiBrowserDriveStep,
  type AoiBrowserDriveActablePage,
  type AoiBrowserDriveApprovalGate,
  type AoiBrowserDriveUploadGate,
} from '../aoiBrowserDriveExecutor';
import {
  addAoiBrowserDriveAllowlistEntry,
  type AoiBrowserDriveAllowlist,
} from '../aoiBrowserDriveAllowlist';
import type { AoiBrowserDrivePlan } from '../aoiBrowserDrivePlan';
import type { AoiBrowserDriveActionRequest } from '../aoiBrowserDriveAction';

const ALLOWLIST: AoiBrowserDriveAllowlist = addAoiBrowserDriveAllowlistEntry(
  { version: 1, entries: [], updatedAt: 0 },
  { domain: 'evil.example' },
  1,
).allowlist;

const allowGate: AoiBrowserDriveApprovalGate = async () => ({ approved: true });

interface VocabPageOptions {
  domTextContent?: string;
  // Per-selector text, so a drag's SOURCE and DESTINATION can read differently.
  domTextBySelector?: Record<string, string>;
  domAttributes?: Record<string, string>;
  // Per-selector attributes, over `domAttributes`.
  domAttributesBySelector?: Record<string, Record<string, string>>;
  // A dialog the page is showing.
  pendingDialog?: { type: string; message: string };
  tabs?: { index: number; url: string; title: string; current: boolean }[];
  // What listTabs reports AFTER selectTab -- a session that ignores the switch
  // keeps reporting the old tab as current.
  tabsAfterSelect?: { index: number; url: string; title: string; current: boolean }[];
  dialogNeverResolves?: boolean;
  dialogMessage?: string;
  omit?: string[];
}

// One document, and a first match is the match: the live-DOM check's "first
// of" and "this document's root" steps fold away, so tests name elements plainly.
function normalize(selector: string): string {
  const rootStep = ' >> xpath=ancestor-or-self::*[last()] >> ';
  const atRoot = selector.lastIndexOf(rootStep);
  const scoped = atRoot >= 0 ? selector.slice(atRoot + rootStep.length) : selector;
  return scoped.split(' >> nth=0').join('');
}

function vocabPage(options: VocabPageOptions = {}) {
  let selectedTab = -1;
  const calls: string[] = [];
  const page: Record<string, unknown> = {
    url: () => 'https://example.com/app',
    goto: vi.fn(async () => {}),
    content: vi.fn(async () => '<html><body><div id="a"></div><div id="b"></div></body></html>'),
    title: vi.fn(async () => 'App'),
    click: vi.fn(async (selector: string) => calls.push(`click:${selector}`)),
    fill: vi.fn(async () => {}),
    selectOption: vi.fn(async () => []),
    press: vi.fn(async () => {}),
    goBack: vi.fn(async () => null),
    screenshot: vi.fn(async () => new Uint8Array([1])),
    mouse: { wheel: vi.fn(async () => {}) },
    textContent: vi.fn(async (selector: string) => {
      const key = normalize(selector);
      if (options.domTextBySelector && key in options.domTextBySelector) {
        return options.domTextBySelector[key];
      }
      return options.domTextContent ?? null;
    }),
    getAttribute: vi.fn(async (selector: string, name: string) => {
      return (
        options.domAttributesBySelector?.[normalize(selector)]?.[name] ??
        options.domAttributes?.[name] ??
        null
      );
    }),
    ...(options.pendingDialog ? { pendingDialog: () => options.pendingDialog } : {}),
    inputValue: vi.fn(async () => ''),
    hover: vi.fn(async (selector: string) => calls.push(`hover:${selector}`)),
    dragAndDrop: vi.fn(async (from: string, to: string) => calls.push(`drag:${from}->${to}`)),
    setInputFiles: vi.fn(async (selector: string, file: string) =>
      calls.push(`upload:${selector}=${file}`),
    ),
    downloadTo: vi.fn(async (selector: string, directory: string) => {
      calls.push(`download:${selector}->${directory}`);
      return { path: `${directory}/report.pdf`, suggestedFilename: 'report.pdf' };
    }),
    answerDialog: vi.fn(async (disposition: string) => {
      calls.push(`dialog:${disposition}`);
      if (options.dialogNeverResolves) {
        return new Promise<string>(() => {});
      }
      return options.dialogMessage ?? 'Are you sure?';
    }),
    listTabs: vi.fn(async () => {
      if (selectedTab >= 0 && options.tabsAfterSelect) {
        return options.tabsAfterSelect;
      }
      return (
        options.tabs ?? [
          { index: 0, url: 'https://example.com/app', title: 'App', current: selectedTab !== 1 },
          {
            index: 1,
            url: 'https://example.com/popup',
            title: 'Popup',
            current: selectedTab === 1,
          },
        ]
      );
    }),
    selectTab: vi.fn(async (index: number) => {
      calls.push(`selectTab:${index}`);
      selectedTab = index;
    }),
    returnToOwnTab: vi.fn(() => {
      calls.push('returnToOwnTab');
      selectedTab = -1;
    }),
  };
  for (const key of options.omit ?? []) {
    delete page[key];
  }
  return { page: page as unknown as AoiBrowserDriveActablePage, calls };
}

function runStep(
  page: AoiBrowserDriveActablePage,
  action: AoiBrowserDriveActionRequest,
  uploadGate?: AoiBrowserDriveUploadGate,
  downloadGate?: AoiBrowserDriveUploadGate,
) {
  const plan: AoiBrowserDrivePlan = {
    goal: 'do the thing',
    steps: [{ description: 'step', action }],
  };
  return executeAoiBrowserDriveStep({
    page,
    plan,
    stepIndex: 0,
    allowlist: ALLOWLIST,
    approvalGate: allowGate,
    now: 1_000,
    ...(uploadGate ? { uploadGate } : {}),
    ...(downloadGate ? { downloadGate } : {}),
  });
}

// The forbidden hard-blocks are re-derived from the LIVE DOM precisely so a
// model cannot dodge them by leaving a field out of its action. When the
// vocabulary grew, the new kinds initially read only model-supplied text --
// which put drag and upload back on the wrong side of that guarantee.
describe('the new act kinds cannot dodge a hard-block by omission', () => {
  it('blocks a drag whose DESTINATION is a commit control, with no targetText given', () => {
    // The model supplies no targetText at all; the block must come from the DOM.
    const { page } = vocabPage({
      domTextBySelector: { '#handle': 'slider', '#confirm': 'Place order' },
    });
    return runStep(page, { kind: 'drag', selector: '#handle', toSelector: '#confirm' }).then(
      (result) => {
        expect(result.ok).toBe(false);
        expect(result.stopReason).toBe('forbidden');
      },
    );
  });

  it('blocks an upload into a credential field with no field metadata given', async () => {
    const { page, calls } = vocabPage({ domAttributes: { type: 'password' } });
    const result = await runStep(page, {
      kind: 'upload',
      selector: '#secret',
      filePath: 'C:/work/a.pdf',
    });
    expect(result.ok).toBe(false);
    expect(result.stopReason).toBe('forbidden');
    // And nothing was attached.
    expect(calls.some((entry) => entry.startsWith('upload:'))).toBe(false);
  });

  it('blocks a hover on a captcha with no targetText given', async () => {
    const { page } = vocabPage({ domTextContent: "I'm not a robot" });
    const result = await runStep(page, { kind: 'hover', selector: '#cap' });
    expect(result.ok).toBe(false);
    expect(result.stopReason).toBe('forbidden');
  });

  it('still allows an ordinary drag', async () => {
    const { page, calls } = vocabPage({ domTextBySelector: { '#a': 'card', '#b': 'column two' } });
    const result = await runStep(page, { kind: 'drag', selector: '#a', toSelector: '#b' });
    expect(result.ok).toBe(true);
    expect(calls).toContain('drag:#a->#b');
  });
});

describe('uploads are gated, not merely declared', () => {
  it('refuses when no gate is wired at all', async () => {
    // Fail-closed: a caller that forgets the gate uploads nothing.
    const { page, calls } = vocabPage();
    const result = await runStep(page, {
      kind: 'upload',
      selector: '#file',
      filePath: 'C:/work/a.pdf',
    });
    expect(result.ok).toBe(false);
    expect(calls.some((entry) => entry.startsWith('upload:'))).toBe(false);
  });

  it('refuses when the gate says no, and says why', async () => {
    const { page, calls } = vocabPage();
    const result = await runStep(
      page,
      { kind: 'upload', selector: '#file', filePath: 'C:/etc/x' },
      () => ({
        allowed: false,
        reason: 'outside every registered read root',
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.detail ?? '').toContain('outside every registered read root');
    expect(calls.some((entry) => entry.startsWith('upload:'))).toBe(false);
  });

  it('attaches the file when the gate allows it', async () => {
    const { page, calls } = vocabPage();
    const result = await runStep(
      page,
      { kind: 'upload', selector: '#file', filePath: 'C:/work/a.pdf' },
      () => ({ allowed: true, reason: 'inside a registered root' }),
    );
    expect(result.ok).toBe(true);
    expect(calls).toContain('upload:#file=C:/work/a.pdf');
  });
});

// The tool schema tells the model to send snake_case keys. The act used to read
// only the camelCase ones, so a model that followed the schema had every one of
// these fail -- and an upload's file was missing from the approval fingerprint.
describe('the snake_case keys the tool schema documents', () => {
  const snake = (action: Record<string, unknown>) =>
    action as unknown as AoiBrowserDriveActionRequest;

  it('switch tabs by tab_index', async () => {
    const { page } = vocabPage();
    const result = await runStep(page, snake({ kind: 'tab', tab_index: 1 }));
    expect(result.ok).toBe(true);
    expect(result.tabSwitched).toBe(true);
  });

  it('drag to to_selector', async () => {
    const { page, calls } = vocabPage({ domTextBySelector: { '#a': 'card', '#b': 'column two' } });
    const result = await runStep(page, snake({ kind: 'drag', selector: '#a', to_selector: '#b' }));
    expect(result.ok).toBe(true);
    expect(calls).toContain('drag:#a->#b');
  });

  it('upload the file named by file_path', async () => {
    const { page, calls } = vocabPage();
    const result = await runStep(
      page,
      snake({ kind: 'upload', selector: '#file', file_path: 'C:/work/a.pdf' }),
      () => ({ allowed: true, reason: 'inside a registered root' }),
    );
    expect(result.ok).toBe(true);
    expect(calls).toContain('upload:#file=C:/work/a.pdf');
  });

  it('bind file_path and prompt_text into the approval fingerprint', () => {
    const upload = (file: string) =>
      computeAoiBrowserDriveActionFingerprint(
        'goal',
        0,
        snake({ kind: 'upload', selector: '#file', file_path: file }),
        'example.com',
      );
    expect(upload('C:/work/a.pdf')).not.toBe(upload('C:/work/b.pdf'));
    // And a key's spelling is not part of what was approved.
    expect(upload('C:/work/a.pdf')).toBe(
      computeAoiBrowserDriveActionFingerprint(
        'goal',
        0,
        { kind: 'upload', selector: '#file', filePath: 'C:/work/a.pdf' },
        'example.com',
      ),
    );
    const prompt = (text: string) =>
      computeAoiBrowserDriveActionFingerprint(
        'goal',
        0,
        snake({ kind: 'dialog', disposition: 'accept', prompt_text: text }),
        'example.com',
      );
    expect(prompt('yes')).not.toBe(prompt('delete everything'));
  });
});

// The denylist used to stop at navigation: a plan could reach a denied host by
// switching to a tab the operator already had open on it, and the tab listing
// handed over every tab's address and title.
// The live-DOM re-check covers press and select now. The form a field sits in is
// what Enter submits, so its submit control's text is what the hard-block reads.
describe('press and select are re-checked against the live page', () => {
  // The button Enter in #card presses: its form's default button.
  const FORM = REACH.defaultInForm(`#card >> ${REACH.ANCESTOR_FORM}`);

  it('refuses Enter in a field whose form pays', async () => {
    const { page } = vocabPage({ domTextBySelector: { '#card': '', [FORM]: '결제하기' } });
    const result = await runStep(page, { kind: 'press', selector: '#card', key: 'Enter' });
    expect(result.ok).toBe(false);
    expect(result.stopReason).toBe('forbidden');
  });

  it('refuses a key in a field the page marks as a password', async () => {
    const { page } = vocabPage({ domAttributes: { type: 'password' } });
    const result = await runStep(page, { kind: 'press', selector: '#pw', key: 'Enter' });
    expect(result.stopReason).toBe('forbidden');
  });

  it('refuses choosing an option in a payment field the page describes', async () => {
    const { page } = vocabPage({ domAttributes: { autocomplete: 'cc-exp-year' } });
    const result = await runStep(page, { kind: 'select', selector: '#year', value: '2030' });
    expect(result.stopReason).toBe('forbidden');
  });

  it('still refuses a click on a pay button read from the page', async () => {
    const { page, calls } = vocabPage({ domTextBySelector: { '#go': 'Pay now' } });
    const result = await runStep(page, { kind: 'click', selector: '#go' });
    expect(result.stopReason).toBe('forbidden');
    expect(calls).not.toContain('click:#go');
  });

  it('finds the form of a field addressed by a Playwright selector', async () => {
    // `form:has(text=Card number)` is not CSS, so the old read failed quietly
    // and Enter went through unchecked.
    const field = 'text=Card number';
    const { page } = vocabPage({
      domTextBySelector: {
        [field]: '',
        [REACH.defaultInForm(`${field} >> ${REACH.ANCESTOR_FORM}`)]: 'Pay now',
      },
    });
    const result = await runStep(page, { kind: 'press', selector: field, key: 'Enter' });
    expect(result.stopReason).toBe('forbidden');
  });

  it('reads the button of a form the field only names', async () => {
    // <input form="checkout"> sits outside its form; <button form="checkout">
    // may too.
    const { page } = vocabPage({
      domTextBySelector: {
        '#qty': '',
        [normalize(REACH.defaultNamingForm('#qty', 'checkout'))]: 'Place order',
      },
      domAttributesBySelector: { '#qty': { form: 'checkout' } },
    });
    const result = await runStep(page, { kind: 'press', selector: '#qty', key: 'Enter' });
    expect(result.stopReason).toBe('forbidden');
  });

  it('refuses an act on a target it could not read to check', async () => {
    // The element was not there within the check's wait. One that turned up
    // after the check gave up would have been clicked unexamined.
    const { page, calls } = vocabPage();
    (page as unknown as { textContent: () => Promise<string> }).textContent = async () => {
      throw new Error('Timeout 3000ms exceeded');
    };
    const result = await runStep(page, { kind: 'click', selector: '#later' });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('target_unreadable');
    expect(calls).not.toContain('click:#later');
  });

  it('refuses a download whose control commits a payment', async () => {
    const { page, calls } = vocabPage({ domTextBySelector: { '#get': 'Buy now' } });
    const result = await runStep(
      page,
      { kind: 'download', selector: '#get', filePath: 'C:/Downloads' },
      undefined,
      () => ({ allowed: true, reason: '' }),
    );
    expect(result.stopReason).toBe('forbidden');
    expect(calls.some((entry) => entry.startsWith('download:'))).toBe(false);
  });

  it('lets an ordinary Enter through to approval', async () => {
    const { page } = vocabPage({
      domTextBySelector: {
        '#search': '',
        [REACH.defaultInForm(`#search >> ${REACH.ANCESTOR_FORM}`)]: 'Search',
      },
    });
    const result = await runStep(page, { kind: 'press', selector: '#search', key: 'Enter' });
    expect(result.ok).toBe(true);
  });
});

describe('tabs obey the denylist', () => {
  const tabsWithDeniedOne = (current: number) => [
    { index: 0, url: 'https://example.com/app', title: 'App', current: current === 0 },
    { index: 1, url: 'https://evil.example/inbox', title: 'Secret inbox', current: current === 1 },
    { index: 2, url: 'about:blank', title: '', current: current === 2 },
  ];

  it('lists a denylisted tab without its address or title', async () => {
    const { page } = vocabPage({ tabs: tabsWithDeniedOne(0) });
    const result = await runStep(page, { kind: 'tabs' });
    expect(result.ok).toBe(true);
    expect(result.tabs).toEqual([
      { index: 0, url: 'https://example.com/app', title: 'App', current: true },
      { index: 1, url: '', title: '', current: false, denylisted: true },
      { index: 2, url: 'about:blank', title: '', current: false },
    ]);
  });

  it('refuses to switch onto a denylisted tab and goes back to its own', async () => {
    const { page, calls } = vocabPage({
      tabs: tabsWithDeniedOne(0),
      tabsAfterSelect: tabsWithDeniedOne(1),
    });
    const result = await runStep(page, { kind: 'tab', tabIndex: 1 });
    expect(result.ok).toBe(false);
    expect(result.stopReason).toBe('host_denylisted');
    expect(calls).toContain('returnToOwnTab');
    expect(JSON.stringify(result)).not.toContain('Secret inbox');
  });

  it('still switches to a blank tab', async () => {
    const { page } = vocabPage({
      tabs: tabsWithDeniedOne(0),
      tabsAfterSelect: tabsWithDeniedOne(2),
    });
    const result = await runStep(page, { kind: 'tab', tabIndex: 2 });
    expect(result.ok).toBe(true);
    expect(result.tabSwitched).toBe(true);
  });
});

describe('tab switching is verified, not assumed', () => {
  it('reports the tabs it can see', async () => {
    const { page } = vocabPage();
    const result = await runStep(page, { kind: 'tabs' });
    expect(result.ok).toBe(true);
    expect(result.tabs?.length).toBe(2);
  });

  it('refuses when the switch did not actually take', async () => {
    // The dangerous case: every later step goes through this same page object,
    // so a switch that silently did nothing means acting on a tab nobody chose.
    const { page } = vocabPage({
      tabsAfterSelect: [
        { index: 0, url: 'https://example.com/app', title: 'App', current: true },
        { index: 1, url: 'https://example.com/popup', title: 'Popup', current: false },
      ],
    });
    const result = await runStep(page, { kind: 'tab', tabIndex: 1 });
    expect(result.ok).toBe(false);
    expect(result.detail ?? '').toContain('did not take effect');
  });

  it('confirms a switch that did take', async () => {
    const { page } = vocabPage();
    const result = await runStep(page, { kind: 'tab', tabIndex: 1 });
    expect(result.ok).toBe(true);
    expect(result.tabSwitched).toBe(true);
  });

  it('refuses a session that cannot switch tabs at all', async () => {
    const { page } = vocabPage({ omit: ['selectTab'] });
    const result = await runStep(page, { kind: 'tab', tabIndex: 1 });
    expect(result.ok).toBe(false);
    expect(result.detail ?? '').toContain('cannot switch tabs');
  });
});

describe('dialogs', () => {
  it('answers one and reports what it was asked', async () => {
    // The model chose a disposition before it could see the message, so the
    // message is the evidence of what was actually agreed to.
    const { page, calls } = vocabPage({ dialogMessage: 'Delete this draft?' });
    const result = await runStep(page, { kind: 'dialog', disposition: 'dismiss' });
    expect(result.ok).toBe(true);
    expect(calls).toContain('dialog:dismiss');
  });

  it('refuses a disposition it does not understand', async () => {
    const { page, calls } = vocabPage();
    const result = await runStep(page, { kind: 'dialog', disposition: 'maybe' });
    expect(result.ok).toBe(false);
    expect(calls.some((entry) => entry.startsWith('dialog:'))).toBe(false);
  });

  it('binds an approval to which tab the plan switched to', () => {
    const act: AoiBrowserDriveActionRequest = { kind: 'click', selector: '#send' };
    const withTab = (tabIndex: number) =>
      computeAoiBrowserDriveActionFingerprint('goal', 1, act, 'example.com', [
        { action: { kind: 'tab', tabIndex } },
      ]);
    // Shown one tab's page, approved there: that approval is not another tab's.
    expect(withTab(1)).not.toBe(withTab(2));
    expect(withTab(1)).toBe(withTab(1));
  });

  it('does not hang forever when no dialog appears', async () => {
    // Without a bound this wedges the whole run: no step, no verdict, no way to
    // tell what happened. (Dismissing may wait for one; accepting may not.)
    const { page } = vocabPage({ dialogNeverResolves: true });
    const result = await runStep(page, { kind: 'dialog', disposition: 'dismiss' });
    expect(result.ok).toBe(false);
    expect(result.detail ?? '').toContain('no dialog appeared');
  }, 20_000);

  it("never navigates one of the operator's own tabs away", async () => {
    // Their tab may hold a half-written message; navigating loses it.
    for (const action of [
      { kind: 'navigate', url: 'https://example.com/other' },
      { kind: 'back' },
    ] as AoiBrowserDriveActionRequest[]) {
      const { page } = vocabPage();
      (page as unknown as { isOnOwnTab: () => boolean }).isOnOwnTab = () => false;
      const result = await runStep(page, action);
      expect(result.ok, action.kind).toBe(false);
      expect(result.detail, action.kind).toContain('not_own_tab');
      expect((page as unknown as { goto: ReturnType<typeof vi.fn> }).goto).not.toHaveBeenCalled();
      expect(
        (page as unknown as { goBack: ReturnType<typeof vi.fn> }).goBack,
      ).not.toHaveBeenCalled();
    }
  });

  it('never accepts a dialog whose question nobody has read', async () => {
    const { page, calls } = vocabPage();
    const result = await runStep(page, { kind: 'dialog', disposition: 'accept' });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('no dialog is showing');
    expect(calls).not.toContain('dialog:accept');
  });

  it('reads the question off the page before accepting, and refuses a payment', async () => {
    // The plan said nothing about money; the dialog did.
    const { page, calls } = vocabPage({
      pendingDialog: { type: 'confirm', message: 'Confirm payment of $480?' },
    });
    const result = await runStep(page, { kind: 'dialog', disposition: 'accept' });
    expect(result.stopReason).toBe('forbidden');
    expect(calls).not.toContain('dialog:accept');

    const { page: harmless, calls: answered } = vocabPage({
      pendingDialog: { type: 'confirm', message: 'Leave this page?' },
    });
    const accepted = await runStep(harmless, { kind: 'dialog', disposition: 'accept' });
    expect(accepted.ok).toBe(true);
    expect(answered).toContain('dialog:accept');
  });
});

// An approval is bound to a fingerprint, so any field NOT in the fingerprint is
// a field the operator can be shown one value of while the run uses another.
describe('the approval fingerprint covers what the new actions actually do', () => {
  const fp = (action: AoiBrowserDriveActionRequest) =>
    computeAoiBrowserDriveActionFingerprint('goal', 0, action);

  it('distinguishes dismissing a dialog from accepting one', () => {
    // The worst case: approve "back out of this confirm", spend it on "yes".
    expect(fp({ kind: 'dialog', disposition: 'dismiss' })).not.toBe(
      fp({ kind: 'dialog', disposition: 'accept' }),
    );
  });

  it('distinguishes one uploaded file from another', () => {
    // Same kind, same input element -- only the path differs, and the path is
    // the whole point.
    expect(fp({ kind: 'upload', selector: '#f', filePath: 'C:/work/resume.pdf' })).not.toBe(
      fp({ kind: 'upload', selector: '#f', filePath: 'C:/work/id_rsa' }),
    );
  });

  it('distinguishes one drop target from another', () => {
    expect(fp({ kind: 'drag', selector: '#a', toSelector: '#column-b' })).not.toBe(
      fp({ kind: 'drag', selector: '#a', toSelector: '#place-order' }),
    );
  });

  it('distinguishes the text typed into a prompt', () => {
    expect(fp({ kind: 'dialog', disposition: 'accept', promptText: 'no' })).not.toBe(
      fp({ kind: 'dialog', disposition: 'accept', promptText: 'DELETE' }),
    );
  });

  it('is still stable for an identical action', () => {
    const action: AoiBrowserDriveActionRequest = {
      kind: 'upload',
      selector: '#f',
      filePath: 'C:/work/a.pdf',
    };
    expect(fp(action)).toBe(fp({ ...action }));
  });
});

// The refs an act can address are minted by an `elements` read step. If the
// snapshot that mints them never reaches the caller, `element` + `snapshot_id`
// is unusable and every act has to name a hand-written CSS selector instead --
// the weaker path the ref system exists to replace.
describe('a plan reports what its read steps saw', () => {
  it('returns the element snapshot from a prefix read', async () => {
    const { page } = vocabPage();
    const plan: AoiBrowserDrivePlan = {
      goal: 'find and click',
      steps: [
        { description: 'look', action: { kind: 'elements' } },
        { description: 'click', action: { kind: 'click', selector: '#a' } },
      ],
    };
    const result = await executeAoiBrowserDriveStep({
      page,
      plan,
      stepIndex: 0,
      allowlist: ALLOWLIST,
      approvalGate: allowGate,
      now: 1_000,
    });
    // The elements step itself carries the snapshot that mints refs.
    expect(result.ok).toBe(true);
    expect(result.snapshot?.id).toBeTruthy();
  });

  it('carries the tab listing on a tabs step', async () => {
    const { page } = vocabPage();
    const result = await runStep(page, { kind: 'tabs' });
    // A listing the caller never receives cannot inform which tab to switch to.
    expect(result.tabs?.map((tab) => tab.index)).toEqual([0, 1]);
  });
});

// A download is the reverse direction of an upload: bytes the PAGE chose,
// landing on the operator's disk. It gets the same shape of gate, bounded by
// write roots instead of read roots, and the same deny-by-default.
describe('downloads are gated like uploads, in the other direction', () => {
  it('refuses when no gate is wired at all', async () => {
    const { page, calls } = vocabPage();
    const result = await runStep(page, {
      kind: 'download',
      selector: '#report',
      filePath: 'C:/work/out',
    });
    expect(result.ok).toBe(false);
    expect(calls.some((entry) => entry.startsWith('download:'))).toBe(false);
  });

  it('refuses a destination the gate rejects', async () => {
    const { page, calls } = vocabPage();
    const result = await runStep(
      page,
      { kind: 'download', selector: '#report', filePath: 'C:/Windows' },
      undefined,
      () => ({ allowed: false, reason: 'outside every registered write root' }),
    );
    expect(result.ok).toBe(false);
    expect(result.detail ?? '').toContain('outside every registered write root');
    expect(calls.some((entry) => entry.startsWith('download:'))).toBe(false);
  });

  it('saves into an allowed directory and proves where it landed', async () => {
    // The saved path read back off the completed download is real evidence,
    // unlike a click that merely did not throw.
    const { page, calls } = vocabPage();
    const result = await runStep(
      page,
      { kind: 'download', selector: '#report', filePath: 'C:/work/out' },
      undefined,
      () => ({ allowed: true, reason: 'inside a registered write root' }),
    );
    expect(result.ok).toBe(true);
    expect(calls).toContain('download:#report->C:/work/out');
  });

  it('refuses a download with no destination', async () => {
    const { page, calls } = vocabPage();
    const result = await runStep(
      page,
      { kind: 'download', selector: '#report' },
      undefined,
      () => ({
        allowed: true,
        reason: 'ok',
      }),
    );
    expect(result.ok).toBe(false);
    expect(calls.some((entry) => entry.startsWith('download:'))).toBe(false);
  });

  it('refuses a session that cannot save downloads', async () => {
    const { page } = vocabPage({ omit: ['downloadTo'] });
    const result = await runStep(
      page,
      { kind: 'download', selector: '#report', filePath: 'C:/work/out' },
      undefined,
      () => ({ allowed: true, reason: 'ok' }),
    );
    expect(result.ok).toBe(false);
    expect(result.detail ?? '').toContain('cannot save downloads');
  });
});

// Containment blanks the page when an act drifts onto a denied domain. That was
// written when the drive only ever had its own tab.
describe('containment does not navigate a tab Aoi does not own', () => {
  it('returns to its own tab before blanking on drift', async () => {
    // Drift is the case that blanks: the act starts somewhere allowed and lands
    // on a denied domain. Containment then navigates the page to about:blank --
    // which, if the drive had switched to one of the operator's tabs, would be
    // THEIR page.
    const { page, calls } = vocabPage();
    let here = 'https://example.com/app';
    (page as unknown as { url: () => string }).url = () => here;
    (page as unknown as { click: (s: string) => Promise<void> }).click = async (selector) => {
      calls.push(`click:${selector}`);
      here = 'https://evil.example/landed';
    };

    const result = await runStep(page, { kind: 'click', selector: '#a' });
    expect(result.ok).toBe(false);
    expect(result.stopReason).toBe('drift_after_act');
    // Come back to Aoi's own tab BEFORE blanking anything.
    expect(calls).toContain('returnToOwnTab');
  });
});
