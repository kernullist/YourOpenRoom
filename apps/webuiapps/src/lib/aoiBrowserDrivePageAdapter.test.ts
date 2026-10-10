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

  it('leaves no abandon timer behind a dialog answered or released', async () => {
    const cleared: unknown[] = [];
    let next = 0;
    const page = fakePage();
    const handle = attachAoiBrowserDriveDialogs(page, {
      abandonAfterMs: 1,
      setTimer: (() => {
        next += 1;
        return next;
      }) as unknown as typeof setTimeout,
      clearTimer: ((id: unknown) => {
        cleared.push(id);
      }) as unknown as typeof clearTimeout,
    });
    page.fire(fakeDialog('Save changes?'));
    await handle.answerDialog('accept');
    expect(cleared).toEqual([1]);
    page.fire(fakeDialog('Leave site?'));
    await handle.releasePendingDialogs();
    expect(cleared).toEqual([1, 2]);
    // One answered as it arrives was never queued, and has no timer.
    const pending = handle.answerDialog('dismiss');
    page.fire(fakeDialog('Really?'));
    await pending;
    expect(cleared).toEqual([1, 2]);
    expect(next).toBe(2);
  });

  describe('the question read', () => {
    it('answers only a dialog that asks what was read', async () => {
      const page = fakePage();
      const handle = attachAoiBrowserDriveDialogs(page);
      const pay = fakeDialog('Pay $49.00 now?');
      page.fire(pay);
      // Read as "Leave this page?", which the page let go and asked again in
      // its place: nothing is answered, and the new one is still showing.
      await expect(
        handle.answerDialog('accept', undefined, { read: 'Leave this page?' }),
      ).rejects.toThrow('not the one that was read');
      expect(pay.accepted).toEqual([]);
      expect(handle.pendingDialog()).toMatchObject({ message: 'Pay $49.00 now?' });
      await expect(
        handle.answerDialog('accept', undefined, { read: 'Pay $49.00 now?' }),
      ).resolves.toBe('Pay $49.00 now?');
      expect(pay.accepted).toEqual(['']);
    });

    it('waits for no later dialog in place of one that was read and is gone', async () => {
      const page = fakePage();
      const handle = attachAoiBrowserDriveDialogs(page);
      await expect(
        handle.answerDialog('accept', undefined, { read: 'Leave this page?' }),
      ).rejects.toThrow('is gone');
      // The next one the page raises is queued for reading, not answered.
      const next = fakeDialog('Pay $49.00 now?');
      page.fire(next);
      expect(next.accepted).toEqual([]);
      expect(handle.pendingDialog()).toMatchObject({ message: 'Pay $49.00 now?' });
    });

    it('answers nothing that comes after a wait given up on', async () => {
      const page = fakePage();
      const handle = attachAoiBrowserDriveDialogs(page);
      await expect(handle.answerDialog('dismiss', undefined, { timeoutMs: 20 })).rejects.toThrow(
        'no dialog appeared to answer',
      );
      const later = fakeDialog('Delete your account?');
      page.fire(later);
      expect(later.dismissed).toBe(0);
      expect(handle.pendingDialog()).toMatchObject({ message: 'Delete your account?' });
    });

    it('answers one that comes within the wait, and lets the wait go', async () => {
      const page = fakePage();
      const clearTimer = vi.fn();
      const handle = attachAoiBrowserDriveDialogs(page, {
        setTimer: (() => 7) as unknown as typeof setTimeout,
        clearTimer: clearTimer as unknown as typeof clearTimeout,
      });
      const answered = handle.answerDialog('dismiss', undefined, { timeoutMs: 5_000 });
      const raised = fakeDialog('Leave site?');
      page.fire(raised);
      await expect(answered).resolves.toBe('Leave site?');
      expect(raised.dismissed).toBe(1);
      expect(clearTimer).toHaveBeenCalledWith(7);
    });
  });

  describe('one dialog shown at a time', () => {
    it('forgets a dialog still queued when another is shown, and never answers it', async () => {
      const page = fakePage();
      const handle = attachAoiBrowserDriveDialogs(page);
      // The alert of the page before, closed by the browser, and the confirm
      // the next page raised: an accept of the first would answer the second.
      const closed = fakeDialog('Your cart was updated');
      const live = fakeDialog('Pay $49.00 now?');
      page.fire(closed);
      page.fire(live);
      expect(handle.pendingDialog()).toMatchObject({ message: 'Pay $49.00 now?' });
      await expect(
        handle.answerDialog('accept', undefined, { read: 'Your cart was updated' }),
      ).rejects.toThrow('not the one that was read');
      expect(closed.accepted).toEqual([]);
      expect(closed.dismissed).toBe(0);
      expect(live.accepted).toEqual([]);
      await handle.releasePendingDialogs();
      expect(closed.dismissed).toBe(0);
      expect(live.dismissed).toBe(1);
    });

    it('puts back a dialog an answer failed on, unless another took its place', async () => {
      const page = fakePage();
      const handle = attachAoiBrowserDriveDialogs(page);
      const stuck = fakeDialog('Leave this page?');
      stuck.accept = async () => {
        throw new Error(
          'Protocol error (Page.handleJavaScriptDialog): Not attached to an active page',
        );
      };
      page.fire(stuck);
      await expect(handle.answerDialog('accept')).rejects.toThrow('Not attached');
      // Still showing, so still what every act waits on.
      expect(handle.pendingDialog()).toMatchObject({ message: 'Leave this page?' });
      // One whose answer failed because another was shown in its place is gone.
      const other = fakePage();
      const second = attachAoiBrowserDriveDialogs(other);
      const replaced = fakeDialog('Leave this page?');
      replaced.accept = async () => {
        other.fire(fakeDialog('Stay on this page?'));
        throw new Error('No dialog is showing');
      };
      other.fire(replaced);
      await expect(second.answerDialog('accept')).rejects.toThrow('No dialog is showing');
      expect(second.pendingDialog()).toMatchObject({ message: 'Stay on this page?' });
      // And one the browser says is not showing is gone too.
      const third = fakePage();
      const thirdHandle = attachAoiBrowserDriveDialogs(third);
      const closed = fakeDialog('Your cart was updated');
      closed.dismiss = async () => {
        throw new Error('Protocol error (Page.handleJavaScriptDialog): No dialog is showing');
      };
      third.fire(closed);
      await expect(thirdHandle.answerDialog('dismiss')).rejects.toThrow('No dialog is showing');
      expect(thirdHandle.pendingDialog()).toBeNull();
    });
  });

  describe('a page navigated away from', () => {
    function navigablePage() {
      const handlers = new Map<string, (arg?: unknown) => void>();
      const top = { name: 'top' };
      const page = {
        url: () => 'https://example.com/',
        on: (event: string, handler: (arg?: unknown) => void) => {
          handlers.set(event, handler);
        },
        mainFrame: () => top,
      } as unknown as AoiBrowserDriveRawPage;
      const cleared: unknown[] = [];
      let next = 0;
      const handle = attachAoiBrowserDriveDialogs(page, {
        setTimer: (() => (next += 1)) as unknown as typeof setTimeout,
        clearTimer: ((id: unknown) => cleared.push(id)) as unknown as typeof clearTimeout,
      });
      const emit = (event: string, arg?: unknown) => handlers.get(event)?.(arg);
      return { handle, emit, top, cleared };
    }

    it('lets a dialog go once the next document has loaded, without answering it', () => {
      const { handle, emit, top, cleared } = navigablePage();
      const old = fakeDialog('Your session has expired');
      emit('dialog', old);
      emit('framenavigated', top);
      emit('domcontentloaded');
      expect(handle.pendingDialog()).toBeNull();
      // Forgotten, not dismissed: a dismiss now would answer the new page's.
      expect(old.dismissed).toBe(0);
      expect(cleared).toEqual([1]);
    });

    it('keeps a dialog the new page raised before its content loaded', () => {
      const { handle, emit, top } = navigablePage();
      emit('dialog', fakeDialog('Your session has expired'));
      emit('framenavigated', top);
      emit('dialog', fakeDialog('Allow notifications?'));
      emit('domcontentloaded');
      expect(handle.pendingDialog()).toMatchObject({ message: 'Allow notifications?' });
    });

    it('keeps a dialog through a route the page pushes, and a frame inside navigating', () => {
      const { handle, emit, top } = navigablePage();
      emit('dialog', fakeDialog('Your session has expired'));
      // The top frame navigating within its document: no content loads after.
      emit('framenavigated', top);
      expect(handle.pendingDialog()).toMatchObject({ message: 'Your session has expired' });
      // A frame inside the page navigating, then loading, closes nothing.
      emit('framenavigated', { name: 'ad' });
      expect(handle.pendingDialog()).toMatchObject({ message: 'Your session has expired' });
    });

    it('does not accept a dialog raised before the page navigated, and dismisses it', async () => {
      const { handle, emit, top } = navigablePage();
      const old = fakeDialog('Your session has expired');
      emit('dialog', old);
      emit('framenavigated', top);
      // It may be gone, and an accept would answer whatever the page shows.
      await expect(handle.answerDialog('accept')).rejects.toThrow('nothing was accepted');
      expect(old.accepted).toEqual([]);
      await expect(handle.answerDialog('dismiss')).resolves.toBe('Your session has expired');
      expect(old.dismissed).toBe(1);
      // Answered before the new document loaded: nothing is left to let go.
      emit('domcontentloaded');
      expect(handle.pendingDialog()).toBeNull();
      // One raised after the navigation is the new page's own.
      const fresh = fakeDialog('Keep shopping?');
      emit('dialog', fresh);
      await expect(handle.answerDialog('accept')).resolves.toBe('Keep shopping?');
    });

    it('keeps a dialog shown in place of another that the connection cannot answer, until the page moves', async () => {
      const { handle, emit, top } = navigablePage();
      // The page's alert, then a frame's confirm: the browser shows the new one,
      // then closes the old -- and leaves the protocol none to answer.
      emit('dialog', fakeDialog('Your cart was saved'));
      const confirm = fakeDialog('Pay $49.00 now?');
      let tries = 0;
      confirm.dismiss = async () => {
        tries += 1;
        throw new Error('Protocol error (Page.handleJavaScriptDialog): No dialog is showing');
      };
      emit('dialog', confirm);
      await expect(handle.answerDialog('dismiss')).rejects.toThrow('cannot be answered');
      const view = handle.pendingDialog();
      expect(view).toEqual({ type: 'confirm', message: 'Pay $49.00 now?', unanswerable: true });
      // Asked again, nothing is tried: nothing can answer it.
      await expect(handle.answerDialog('accept')).rejects.toThrow('navigate or go back');
      expect(tries).toBe(1);
      expect(confirm.accepted).toEqual([]);
      expect(handle.pendingDialog()).toBe(view);
      // Leaving the page closes it.
      emit('framenavigated', top);
      emit('domcontentloaded');
      expect(handle.pendingDialog()).toBeNull();
    });
  });

  describe('a dialog a frame inside the page raised', () => {
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

    it('is dismissed at once, not held for a page to remove its frame under it', async () => {
      const page = fakePage();
      const fromAFrame = vi.fn(async (dialog: AoiBrowserDriveDialog) =>
        dialog.message().startsWith('Widget'),
      );
      const leave = vi.fn(async () => {});
      const handle = attachAoiBrowserDriveDialogs(page, { fromAFrame, leave });
      const widget = fakeDialog('Widget says hi');
      page.fire(widget);
      await settle();
      expect(widget.dismissed).toBe(1);
      expect(handle.pendingDialog()).toBeNull();
      expect(leave).not.toHaveBeenCalled();
      // The top frame's own is held for a step to answer.
      const own = fakeDialog('Discard draft?');
      page.fire(own);
      await settle();
      expect(own.dismissed).toBe(0);
      expect(handle.pendingDialog()).toMatchObject({ message: 'Discard draft?' });
      await handle.answerDialog('dismiss');
      expect(own.dismissed).toBe(1);
      // One a step was waiting for is the step's: answered once, by the step --
      // and asked about all the same, so that the browser's report of it is
      // its own and no later dialog's.
      const answering = handle.answerDialog('dismiss');
      const taken = fakeDialog('Widget again');
      page.fire(taken);
      await answering;
      await settle();
      expect(taken.dismissed).toBe(1);
      expect(fromAFrame).toHaveBeenCalledWith(taken);
    });

    it("lets a frame's ask to stay go, so the page can be left", async () => {
      const page = fakePage();
      const handle = attachAoiBrowserDriveDialogs(page, { fromAFrame: async () => true });
      const stay = Object.assign(fakeDialog(''), { type: () => 'beforeunload' });
      page.fire(stay);
      await settle();
      expect(stay.accepted).toEqual(['']);
      expect(stay.dismissed).toBe(0);
      expect(handle.pendingDialog()).toBeNull();
      // A frame that cannot be told apart from the top is held, as before; and
      // one that fails to say which it is, too.
      const failing = attachAoiBrowserDriveDialogs(fakePage(), {
        fromAFrame: () => {
          throw new Error('no session');
        },
      });
      const page2 = fakePage();
      const held = attachAoiBrowserDriveDialogs(page2, {
        fromAFrame: async () => {
          throw new Error('Target closed');
        },
      });
      const own = fakeDialog('Discard draft?');
      page2.fire(own);
      await settle();
      expect(own.dismissed).toBe(0);
      expect(held.pendingDialog()).toMatchObject({ message: 'Discard draft?' });
      expect(failing.pendingDialog()).toBeNull();
    });

    it('leaves the page when no answer reaches it, before its frame can be removed', async () => {
      const page = fakePage();
      const leave = vi.fn(async () => {});
      const handle = attachAoiBrowserDriveDialogs(page, {
        fromAFrame: async (dialog) => dialog.message().startsWith('Widget'),
        leave,
      });
      const noneShowing = async () => {
        throw new Error('Protocol error (Page.handleJavaScriptDialog): No dialog is showing');
      };
      // The top frame's, held -- and a frame's shown in its place, which no
      // answer reaches.
      page.fire(fakeDialog('Your session will expire soon'));
      const stuck = fakeDialog('Widget says hi');
      stuck.dismiss = noneShowing;
      page.fire(stuck);
      await settle();
      expect(leave).toHaveBeenCalledTimes(1);
      expect(handle.pendingDialog()).toBeNull();
      // One shown in place of none that is not showing is gone already: the
      // page is not left for it -- nor for one that fails for another reason.
      const gone = fakeDialog('Widget gone');
      gone.dismiss = noneShowing;
      page.fire(gone);
      await settle();
      const closed = fakeDialog('Widget closed');
      closed.dismiss = async () => {
        throw new Error('Target closed');
      };
      page.fire(closed);
      await settle();
      expect(leave).toHaveBeenCalledTimes(1);
    });
  });

  it('releases anything still queued on teardown', async () => {
    const page = fakePage();
    const handle = attachAoiBrowserDriveDialogs(page);
    const dialog = fakeDialog('Leave site?');
    page.fire(dialog);
    await handle.releasePendingDialogs();
    expect(dialog.dismissed).toBe(1);
  });

  it('shows the waiting dialog without answering it', async () => {
    const page = fakePage();
    const handle = attachAoiBrowserDriveDialogs(page);
    expect(handle.pendingDialog()).toBeNull();

    const dialog = fakeDialog('Empty the cart?');
    page.fire(dialog);
    expect(handle.pendingDialog()).toEqual({ type: 'confirm', message: 'Empty the cart?' });
    // The same view for as long as the same dialog waits.
    expect(handle.pendingDialog()).toBe(handle.pendingDialog());
    // Looking is not answering.
    expect(dialog.dismissed).toBe(0);
    expect(dialog.accepted).toEqual([]);

    await handle.answerDialog('dismiss');
    expect(handle.pendingDialog()).toBeNull();
  });

  it('still reports a dialog that cannot describe itself', () => {
    const page = fakePage();
    const handle = attachAoiBrowserDriveDialogs(page);
    page.fire({
      ...fakeDialog(''),
      message: () => {
        throw new Error('dialog already handled');
      },
    });
    expect(handle.pendingDialog()).toEqual({ type: 'dialog', message: '' });
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

  it('lists a tab whose page holds its title -- a dialog showing -- without one, in time', async () => {
    vi.useFakeTimers();
    try {
      const held = Object.assign(fakePage('https://example.com/held'), {
        title: () => new Promise<string>(() => {}),
      });
      const failing = Object.assign(fakePage('https://example.com/gone'), {
        title: async () => {
          throw new Error('Execution context was destroyed');
        },
      });
      const other = fakePage('https://example.com/b');
      const handle = attachAoiBrowserDriveTabs(fakeContext([held, failing, other]), held);
      const listing = handle.listTabs();
      await vi.advanceTimersByTimeAsync(1_000);
      const tabs = await listing;
      expect(tabs.map((tab) => tab.title)).toEqual(['', '', 'title of https://example.com/b']);
    } finally {
      vi.useRealTimers();
    }
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

  it('can return to the tab Aoi opened', async () => {
    // Containment blanks the page when a drive drifts onto a denied domain. If
    // the drive had switched to one of the OPERATOR's tabs, blanking the current
    // page would navigate their real tab to about:blank and lose what was on it.
    const own = fakePage('https://example.com/aoi');
    const theirs = fakePage('https://mail.example.com/compose');
    const handle = attachAoiBrowserDriveTabs(fakeContext([own, theirs]), own);
    await handle.selectTab(1);
    expect(handle.isOnOwnTab()).toBe(false);

    handle.returnToOwnTab();
    expect(handle.currentPage()).toBe(own);
    expect(handle.isOnOwnTab()).toBe(true);
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
      // A server that sends part of the file, then nothing.
      stalls?: boolean;
    } = {},
  ) {
    const saved: string[] = [];
    const order: string[] = [];
    const cancel = vi.fn(async () => {});
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
        saveAs: (target: string) =>
          options.stalls
            ? new Promise<void>((_resolve, reject) => {
                cancel.mockImplementation(async () => reject(new Error('canceled')));
              })
            : Promise.resolve(void saved.push(target)),
        failure: async () => options.failure ?? null,
        cancel,
      };
    }
    return { page: page as unknown as AoiBrowserDriveDownloadablePage, saved, order, cancel };
  }

  it('saves the file into the given directory', async () => {
    const { page, saved } = downloadablePage();
    const result = await downloadAoiBrowserDriveFile(page, '#report', 'C:/work/out');
    expect(saved).toEqual(['C:/work/out/report.pdf']);
    expect(result.path).toBe('C:/work/out/report.pdf');
  });

  it('leaves no wait unheard when the click fails', async () => {
    const unheard: unknown[] = [];
    const listen = (reason: unknown) => unheard.push(reason);
    process.on('unhandledRejection', listen);
    try {
      const page = {
        url: () => 'https://example.com/',
        on: () => {},
        waitForEvent: () =>
          new Promise((_resolve, reject) => {
            setTimeout(
              () => reject(new Error('Timeout 10ms exceeded while waiting for event')),
              10,
            );
          }),
        click: async () => {
          throw new Error('page.click: Timeout 5ms exceeded.');
        },
      } as unknown as AoiBrowserDriveDownloadablePage;
      await expect(downloadAoiBrowserDriveFile(page, '#dl', 'C:/work/out')).rejects.toThrow(
        'page.click',
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(unheard).toEqual([]);
    } finally {
      process.off('unhandledRejection', listen);
    }
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

  it("cancels a download that does not finish within the act's time", async () => {
    // Saving waits for the whole file; a server that stalls it would hold the
    // act until it gave up.
    const { page, saved, cancel } = downloadablePage({ stalls: true });
    const started = Date.now();
    await expect(
      downloadAoiBrowserDriveFile(page, '#report', 'C:/work/out', { timeout: 200 }),
    ).rejects.toThrow('did not finish within the time');
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(saved).toEqual([]);
    // In time, it lands.
    const { page: quick, saved: landed } = downloadablePage();
    await downloadAoiBrowserDriveFile(quick, '#report', 'C:/work/out', { timeout: 5_000 });
    expect(landed).toEqual(['C:/work/out/report.pdf']);
  });

  it('reports a download that did not complete', async () => {
    // saveAs resolving is not proof the bytes arrived.
    const { page } = downloadablePage({ failure: 'net::ERR_ABORTED' });
    await expect(downloadAoiBrowserDriveFile(page, '#report', 'C:/work/out')).rejects.toThrow(
      'did not complete',
    );
  });
});
