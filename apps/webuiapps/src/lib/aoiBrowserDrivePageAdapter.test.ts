import { describe, expect, it, vi } from 'vitest';
import {
  attachAoiBrowserDriveDialogs,
  attachAoiBrowserDriveTabs,
  type AoiBrowserDriveDialog,
  type AoiBrowserDriveRawPage,
} from './aoiBrowserDrivePageAdapter';

function fakeDialog(message: string): AoiBrowserDriveDialog & {
  accepted: string[];
  dismissed: number;
} {
  const state = { accepted: [] as string[], dismissed: 0 };
  return {
    message: () => message,
    type: () => 'confirm',
    accept: async (promptText?: string) => {
      state.accepted.push(promptText ?? '');
    },
    dismiss: async () => {
      state.dismissed += 1;
    },
    get accepted() {
      return state.accepted;
    },
    get dismissed() {
      return state.dismissed;
    },
  } as AoiBrowserDriveDialog & { accepted: string[]; dismissed: number };
}

function fakePage(url = 'https://example.com/'): AoiBrowserDriveRawPage & {
  fire(dialog: AoiBrowserDriveDialog): void;
  fronted: number;
} {
  let handler: ((dialog: AoiBrowserDriveDialog) => void) | null = null;
  let fronted = 0;
  return {
    url: () => url,
    on: (_event: 'dialog', next: (dialog: AoiBrowserDriveDialog) => void) => {
      handler = next;
    },
    title: async () => `title of ${url}`,
    bringToFront: async () => {
      fronted += 1;
    },
    fire: (dialog: AoiBrowserDriveDialog) => handler?.(dialog),
    get fronted() {
      return fronted;
    },
  } as AoiBrowserDriveRawPage & { fire(dialog: AoiBrowserDriveDialog): void; fronted: number };
}

describe('dialog handling', () => {
  it('answers a dialog that arrived before the step asking for it', async () => {
    // A click raises the dialog immediately; the step that answers runs after.
    const page = fakePage();
    const handle = attachAoiBrowserDriveDialogs(page);
    const dialog = fakeDialog('Delete this draft?');
    page.fire(dialog);

    const message = await handle.answerDialog('dismiss');
    expect(message).toBe('Delete this draft?');
    expect(dialog.dismissed).toBe(1);
  });

  it('waits for a dialog that has not appeared yet', async () => {
    const page = fakePage();
    const handle = attachAoiBrowserDriveDialogs(page);
    const pending = handle.answerDialog('accept', 'DELETE');
    const dialog = fakeDialog('Type DELETE to confirm');
    page.fire(dialog);

    expect(await pending).toBe('Type DELETE to confirm');
    expect(dialog.accepted).toEqual(['DELETE']);
  });

  it('reports the message even though the caller chose before seeing it', async () => {
    // The disposition is picked blind, so the message is the only evidence of
    // what was actually agreed to.
    const page = fakePage();
    const handle = attachAoiBrowserDriveDialogs(page);
    page.fire(fakeDialog('Permanently delete 412 files?'));
    await expect(handle.answerDialog('dismiss')).resolves.toContain('412 files');
  });

  it('dismisses a dialog nobody claimed, rather than leaving the page blocked', async () => {
    // Attaching a listener changes Playwright's default: with no listener a
    // dialog auto-dismisses, with one it blocks until somebody acts. An
    // unclaimed dialog must therefore fall back to dismissing.
    const timers: (() => void)[] = [];
    const page = fakePage();
    const handle = attachAoiBrowserDriveDialogs(page, {
      abandonAfterMs: 1,
      setTimer: ((fn: () => void) => {
        timers.push(fn);
        return 0;
      }) as unknown as typeof setTimeout,
    });
    const dialog = fakeDialog('Are you still there?');
    page.fire(dialog);
    expect(dialog.dismissed).toBe(0);

    timers.forEach((fn) => fn());
    await Promise.resolve();
    expect(dialog.dismissed).toBe(1);
    void handle;
  });

  it('does not dismiss a dialog that was already answered', async () => {
    const timers: (() => void)[] = [];
    const page = fakePage();
    const handle = attachAoiBrowserDriveDialogs(page, {
      abandonAfterMs: 1,
      setTimer: ((fn: () => void) => {
        timers.push(fn);
        return 0;
      }) as unknown as typeof setTimeout,
    });
    const dialog = fakeDialog('Save changes?');
    page.fire(dialog);
    await handle.answerDialog('accept');
    expect(dialog.accepted).toEqual(['']);

    // The abandon timer still fires; it must be a no-op now.
    timers.forEach((fn) => fn());
    await Promise.resolve();
    expect(dialog.dismissed).toBe(0);
  });

  it('releases anything still queued on teardown', async () => {
    const page = fakePage();
    const handle = attachAoiBrowserDriveDialogs(page);
    const dialog = fakeDialog('Leave site?');
    page.fire(dialog);
    await handle.releasePendingDialogs();
    expect(dialog.dismissed).toBe(1);
  });
});

describe('tab handling', () => {
  function fakeContext(pages: AoiBrowserDriveRawPage[]) {
    return { pages: () => pages };
  }

  it('lists every tab and marks the current one', async () => {
    const first = fakePage('https://example.com/a');
    const second = fakePage('https://example.com/b');
    const handle = attachAoiBrowserDriveTabs(fakeContext([first, second]), first);
    const tabs = await handle.listTabs();
    expect(tabs.map((tab) => tab.url)).toEqual(['https://example.com/a', 'https://example.com/b']);
    expect(tabs.map((tab) => tab.current)).toEqual([true, false]);
  });

  it('makes the selected tab the one later actions go to', async () => {
    // Selecting is only meaningful if everything AFTER it addresses that tab.
    const first = fakePage('https://example.com/a');
    const second = fakePage('https://example.com/b');
    const handle = attachAoiBrowserDriveTabs(fakeContext([first, second]), first);
    await handle.selectTab(1);
    expect(handle.currentPage()).toBe(second);
    const tabs = await handle.listTabs();
    expect(tabs.find((tab) => tab.current)?.index).toBe(1);
  });

  it('refuses an index with no tab behind it', async () => {
    const first = fakePage();
    const handle = attachAoiBrowserDriveTabs(fakeContext([first]), first);
    await expect(handle.selectTab(4)).rejects.toThrow('no tab at index 4');
    // And the current tab is unchanged.
    expect(handle.currentPage()).toBe(first);
  });

  it('still switches when the tab cannot be brought to front', async () => {
    // Fronting is a courtesy to the operator; delivery does not depend on it.
    const first = fakePage('https://example.com/a');
    const second = fakePage('https://example.com/b');
    (second as { bringToFront: () => Promise<void> }).bringToFront = vi.fn(async () => {
      throw new Error('window manager said no');
    });
    const handle = attachAoiBrowserDriveTabs(fakeContext([first, second]), first);
    await handle.selectTab(1);
    expect(handle.currentPage()).toBe(second);
  });

  it('lists a tab that cannot report its title', async () => {
    const first = fakePage('https://example.com/a');
    const second = fakePage('https://example.com/b');
    (second as { title: () => Promise<string> }).title = vi.fn(async () => {
      throw new Error('navigating');
    });
    const handle = attachAoiBrowserDriveTabs(fakeContext([first, second]), first);
    const tabs = await handle.listTabs();
    // A tab mid-navigation is still a tab.
    expect(tabs).toHaveLength(2);
    expect(tabs[1].title).toBe('');
  });
});
