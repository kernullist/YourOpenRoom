import { describe, expect, it, vi } from 'vitest';
import {
  attachAoiBrowserDriveDialogs,
  attachAoiBrowserDriveTabs,
  downloadAoiBrowserDriveFile,
  type AoiBrowserDriveDownloadablePage,
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

describe('saving a download', () => {
  function downloadablePage(
    options: {
      suggested?: string;
      failure?: string | null;
      resolveBeforeClick?: boolean;
    } = {},
  ) {
    const saved: string[] = [];
    const order: string[] = [];
    let releaseDownload: ((download: unknown) => void) | null = null;
    const page = {
      url: () => 'https://example.com/',
      on: () => {},
      waitForEvent: async () => {
        order.push('wait-armed');
        return new Promise((resolve) => {
          releaseDownload = resolve;
          if (options.resolveBeforeClick) {
            resolve(makeDownload());
          }
        });
      },
      click: async (selector: string) => {
        order.push(`click:${selector}`);
        // A real site starts the download as a result of the click.
        releaseDownload?.(makeDownload());
      },
    };
    function makeDownload() {
      return {
        suggestedFilename: () => options.suggested ?? 'report.pdf',
        saveAs: async (target: string) => {
          saved.push(target);
        },
        failure: async () => options.failure ?? null,
      };
    }
    return { page: page as unknown as AoiBrowserDriveDownloadablePage, saved, order };
  }

  it('saves the file into the given directory', async () => {
    const { page, saved } = downloadablePage();
    const result = await downloadAoiBrowserDriveFile(page, '#report', 'C:/work/out');
    expect(saved).toEqual(['C:/work/out/report.pdf']);
    expect(result.path).toBe('C:/work/out/report.pdf');
  });

  it('arms the wait BEFORE clicking', async () => {
    // Arming afterwards is a race the page usually wins on a fast connection,
    // and losing it looks exactly like a site that never offered a file.
    const { page, order } = downloadablePage();
    await downloadAoiBrowserDriveFile(page, '#report', 'C:/work/out');
    expect(order[0]).toBe('wait-armed');
    expect(order[1]).toBe('click:#report');
  });

  it('never lets the SITE choose where the file lands', async () => {
    // The filename comes from the page, so it is used as a name and never as a
    // path -- otherwise the directory bound means nothing.
    const { page, saved } = downloadablePage({ suggested: '../../Windows/System32/evil.dll' });
    await downloadAoiBrowserDriveFile(page, '#report', 'C:/work/out');
    expect(saved).toEqual(['C:/work/out/evil.dll']);
  });

  it('refuses a filename that is only a traversal', async () => {
    const { page, saved } = downloadablePage({ suggested: '..' });
    await downloadAoiBrowserDriveFile(page, '#report', 'C:/work/out');
    expect(saved).toEqual(['C:/work/out/download']);
  });

  it('does not double the separator when the directory ends in one', async () => {
    const { page, saved } = downloadablePage();
    await downloadAoiBrowserDriveFile(page, '#report', 'C:/work/out/');
    expect(saved).toEqual(['C:/work/out/report.pdf']);
  });

  it('reports a download that did not complete', async () => {
    // saveAs resolving is not proof the bytes arrived.
    const { page } = downloadablePage({ failure: 'net::ERR_ABORTED' });
    await expect(downloadAoiBrowserDriveFile(page, '#report', 'C:/work/out')).rejects.toThrow(
      'did not complete',
    );
  });
});
