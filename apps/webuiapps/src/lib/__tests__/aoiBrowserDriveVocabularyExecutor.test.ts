import { describe, expect, it, vi } from 'vitest';

import {
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
  { domain: 'evil.test' },
  1,
).allowlist;

const allowGate: AoiBrowserDriveApprovalGate = async () => ({ approved: true });

interface VocabPageOptions {
  domTextContent?: string;
  // Per-selector text, so a drag's SOURCE and DESTINATION can read differently.
  domTextBySelector?: Record<string, string>;
  domAttributes?: Record<string, string>;
  tabs?: { index: number; url: string; title: string; current: boolean }[];
  // What listTabs reports AFTER selectTab -- a session that ignores the switch
  // keeps reporting the old tab as current.
  tabsAfterSelect?: { index: number; url: string; title: string; current: boolean }[];
  dialogNeverResolves?: boolean;
  dialogMessage?: string;
  omit?: string[];
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
      if (options.domTextBySelector && selector in options.domTextBySelector) {
        return options.domTextBySelector[selector];
      }
      return options.domTextContent ?? null;
    }),
    getAttribute: vi.fn(async (_selector: string, name: string) => {
      return options.domAttributes?.[name] ?? null;
    }),
    inputValue: vi.fn(async () => ''),
    hover: vi.fn(async (selector: string) => calls.push(`hover:${selector}`)),
    dragAndDrop: vi.fn(async (from: string, to: string) => calls.push(`drag:${from}->${to}`)),
    setInputFiles: vi.fn(async (selector: string, file: string) =>
      calls.push(`upload:${selector}=${file}`),
    ),
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

  it('does not hang forever when no dialog appears', async () => {
    // Without a bound this wedges the whole run: no step, no verdict, no way to
    // tell what happened.
    const { page } = vocabPage({ dialogNeverResolves: true });
    const result = await runStep(page, { kind: 'dialog', disposition: 'accept' });
    expect(result.ok).toBe(false);
    expect(result.detail ?? '').toContain('no dialog appeared');
  }, 20_000);
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
