// Browser-drive page adapter (BU2): the two capabilities Playwright does not
// hand over as plain Page methods.
//
// Most of the drive vocabulary maps straight onto Playwright -- click, fill,
// hover, dragAndDrop, setInputFiles all exist with matching signatures, so the
// executor calls them directly. Two do not:
//
//   * DIALOGS. Playwright surfaces alert/confirm/prompt through an EVENT, and
//     auto-dismisses them when nothing is listening. So a drive could never
//     answer one: by the time a step ran, the dialog was already gone.
//   * TABS. `page` is one tab. A link with target=_blank, an OAuth popup or a
//     payment step opens another one, and nothing addressed the new page at all.
//
// This wraps a live Page with both. It is a thin, replaceable adapter so the
// executor keeps talking to one interface and stays testable against a fake.
//
// Server-only in practice (it wraps a CDP-connected Playwright page), but it
// takes its dependencies as arguments and performs no I/O of its own, so the
// behaviour below is unit-testable without a browser.

// The slice of Playwright's Dialog this needs.
export interface AoiBrowserDriveDialog {
  message(): string;
  type(): string;
  accept(promptText?: string): Promise<void>;
  dismiss(): Promise<void>;
}

// The slice of Playwright's Page this needs. Deliberately structural: anything
// with these members works, which is what keeps the tests honest.
export interface AoiBrowserDriveRawPage {
  url(): string;
  on(event: 'dialog', handler: (dialog: AoiBrowserDriveDialog) => void): void;
  bringToFront?(): Promise<void>;
  title?(): Promise<string>;
  // A real page's top frame: when it navigates, the dialogs its document
  // raised are gone with it.
  mainFrame?(): unknown;
}

export interface AoiBrowserDriveRawContext {
  pages(): AoiBrowserDriveRawPage[];
}

// The slice of Playwright's Download this needs.
export interface AoiBrowserDriveDownload {
  suggestedFilename(): string;
  saveAs(target: string): Promise<void>;
  failure?(): Promise<string | null>;
  cancel?(): Promise<void>;
}

// A page that can start a download and be told to wait for one.
export interface AoiBrowserDriveDownloadablePage extends AoiBrowserDriveRawPage {
  waitForEvent(event: 'download', options?: { timeout?: number }): Promise<AoiBrowserDriveDownload>;
  click(selector: string, options?: { timeout?: number }): Promise<void>;
}

// How long a queued dialog waits for an answer before being dismissed.
//
// This matters more than it looks. Attaching a listener at all CHANGES
// Playwright's default: with no listener a dialog is auto-dismissed, with one it
// blocks the page until somebody acts. So a queued dialog nobody answers would
// wedge the tab -- worse than not supporting dialogs at all. Falling back to
// dismiss restores the behaviour that existed before this adapter.
const DIALOG_ABANDON_MS = 30_000;

// What a dialog shows: its kind and its message -- and whether nothing over the
// browser connection can answer it, so only leaving the page closes it.
export interface AoiBrowserDriveDialogView {
  type: string;
  message: string;
  unanswerable?: true;
}

// What answering a dialog that cannot be answered says.
export const UNANSWERABLE_DIALOG =
  'the dialog the page shows cannot be answered over the browser connection -- the browser ' +
  'showed it in place of another, and that one closing left the connection nothing to ' +
  'answer; navigate or go back to close it';

// How a dialog is to be answered. `read` is the question the caller judged:
// only a dialog that asks it is answered, and none that appears later is
// waited for -- one that took its place (the page asked again once the one
// read was let go) was never read. `timeoutMs` bounds the wait for one to
// appear, and ends it: a wait given up on answers nothing that comes after.
export interface AoiBrowserDriveDialogAnswer {
  read?: string;
  timeoutMs?: number;
}

export interface AoiBrowserDriveDialogHandle {
  // Answer the dialog that is showing, or the next one to appear within the
  // caller's own timeout. Returns the message, which is the evidence of WHAT was
  // agreed to -- the caller chose a disposition before it could see this.
  answerDialog(
    disposition: 'accept' | 'dismiss',
    promptText?: string,
    options?: AoiBrowserDriveDialogAnswer,
  ): Promise<string>;
  // The dialog waiting for an answer, without answering it -- so the look after
  // an act can say the page is asking something rather than report silence.
  // The same object for as long as the same dialog waits; `unanswerable` when
  // the browser connection cannot answer it (see answerDialog).
  pendingDialog(): AoiBrowserDriveDialogView | null;
  // Dismiss anything still queued. Called on teardown so a page is never left
  // blocked by a dialog this adapter took responsibility for.
  releasePendingDialogs(): Promise<void>;
}

/**
 * Queue dialogs from a page and let a caller answer them.
 *
 * A dialog can arrive before the step that answers it runs (a click raises one
 * immediately), or after (the page is slow). Both are ordinary, so this holds a
 * one-slot queue AND a waiter: whichever comes first is matched with the other.
 */
// How long a tab's title is waited for in a listing.
const TAB_TITLE_DEADLINE_MS = 1_000;

export function attachAoiBrowserDriveDialogs(
  page: AoiBrowserDriveRawPage,
  options: {
    abandonAfterMs?: number;
    setTimer?: typeof setTimeout;
    clearTimer?: typeof clearTimeout;
    // Whether a frame inside the page raised a dialog. One that did is not held
    // but dismissed at once: a page that removes such a frame while its dialog
    // waits crashes the whole browser at the next touch of the tab.
    fromAFrame?: (dialog: AoiBrowserDriveDialog) => Promise<boolean>;
    // Leave the page: what closes a frame's dialog no answer can reach (one
    // shown in place of another) -- before the page can remove the frame.
    leave?: () => Promise<unknown>;
  } = {},
): AoiBrowserDriveDialogHandle {
  const abandonAfterMs = options.abandonAfterMs ?? DIALOG_ABANDON_MS;
  const schedule = options.setTimer ?? setTimeout;
  const unschedule = options.clearTimer ?? clearTimeout;
  const queued: AoiBrowserDriveDialog[] = [];
  // Each queued dialog's abandon timer, gone once it is claimed or released:
  // a dialog answered, or a page closed, leaves no timer behind it.
  const timers = new Map<AoiBrowserDriveDialog, ReturnType<typeof setTimeout>>();
  const claim = (dialog: AoiBrowserDriveDialog) => {
    const timer = timers.get(dialog);
    if (timer !== undefined) {
      unschedule(timer);
      timers.delete(dialog);
    }
  };
  let waiting: ((dialog: AoiBrowserDriveDialog) => void) | null = null;
  // How many dialogs have come: an answer that failed puts its dialog back
  // only if no other has come since.
  let arrived = 0;
  // Dialogs that came while another was queued, and of those the ones the
  // browser connection could not answer. The browser shows the new dialog,
  // then closes the old one -- and that closing leaves the protocol with no
  // dialog to answer: "No dialog is showing", while the new one stays up.
  const inPlace = new WeakSet<AoiBrowserDriveDialog>();
  const unanswerable = new WeakSet<AoiBrowserDriveDialog>();

  // An answer names no dialog. The browser protocol answers the dialog the
  // tab shows -- one at a time -- and Playwright keeps a dialog the browser
  // has closed as one still to answer. So a dialog queued after the browser
  // closed it is not one to answer: its accept would go to whatever the tab
  // shows now, which nobody has read -- a "Pay $49.00 now?" the next page
  // raised, judged by the alert of the page before it.
  //
  // A dialog its page navigated away from is gone: the browser closed it with
  // the document that raised it -- and while it stayed queued, every act on
  // the new page was refused as waiting on it. The top frame also "navigates"
  // within its document (a route a script pushes), which closes nothing: a
  // dialog a frame inside it raised is still up. So what was queued when the
  // top frame last navigated is let go once a new document's content has
  // loaded after it, and until then it is not accepted: it may be gone, and
  // dismissing -- what backs out of anything shown -- is all it takes. It is
  // forgotten, never answered.
  let navigatedFrom = new Set<AoiBrowserDriveDialog>();
  const mainFrame = page.mainFrame?.bind(page);
  if (mainFrame) {
    const events = page as unknown as { on(event: string, handler: (arg: unknown) => void): void };
    events.on('framenavigated', (frame) => {
      if (frame === mainFrame()) {
        navigatedFrom = new Set(queued);
      }
    });
    events.on('domcontentloaded', () => {
      for (const dialog of navigatedFrom) {
        const index = queued.indexOf(dialog);
        if (index >= 0) {
          queued.splice(index, 1);
          claim(dialog);
        }
      }
      navigatedFrom = new Set();
    });
  }

  // Nobody is waiting for it. Give a step time to claim it, then put the page
  // back the way Playwright would have left it.
  const abandonLater = (dialog: AoiBrowserDriveDialog) => {
    timers.set(
      dialog,
      schedule(() => {
        timers.delete(dialog);
        const index = queued.indexOf(dialog);
        if (index >= 0) {
          queued.splice(index, 1);
          void dialog.dismiss().catch(() => {});
        }
      }, abandonAfterMs),
    );
  };

  page.on('dialog', (dialog) => {
    arrived += 1;
    // Shown in place of every dialog still queued: the browser closed those
    // -- with their document, or for this one -- so they are forgotten.
    if (queued.length > 0) {
      inPlace.add(dialog);
    }
    for (const earlier of queued.splice(0)) {
      claim(earlier);
    }
    // Which frame raised it is asked of every dialog, one a step waits for as
    // well: each takes the browser's report of itself, and no later dialog in
    // the same words takes that report in its place.
    const framed = Promise.resolve()
      .then(() => options.fromAFrame?.(dialog) ?? false)
      .catch(() => false);
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve(dialog);
      return;
    }
    queued.push(dialog);
    abandonLater(dialog);
    void framed
      .then(async (fromAFrame) => {
        const index = queued.indexOf(dialog);
        if (!fromAFrame || index < 0) {
          return;
        }
        queued.splice(index, 1);
        claim(dialog);
        try {
          // A frame that asks to stay as the page leaves would hold the tab on
          // it for good: no step's answer reaches its dialog, and every way
          // off the page asks it again. It is let go, as a page with no such
          // handler is left. Anything else a frame asks is backed out of.
          if (dialog.type() === 'beforeunload') {
            await dialog.accept();
          } else {
            await dialog.dismiss();
          }
        } catch (error) {
          // Shown in place of another, it stays up where no answer reaches
          // it -- until the page is left. Any other is gone already.
          if (
            inPlace.has(dialog) &&
            error instanceof Error &&
            /no dialog is showing/i.test(error.message)
          ) {
            await options.leave?.();
          }
        }
      })
      .catch(() => {});
  });

  // Each dialog's view, made once: what waits is told apart by it.
  const views = new WeakMap<AoiBrowserDriveDialog, AoiBrowserDriveDialogView>();
  const describe = (dialog: AoiBrowserDriveDialog): AoiBrowserDriveDialogView => {
    const known = views.get(dialog);
    if (known) {
      return known;
    }
    let view: AoiBrowserDriveDialogView;
    try {
      view = { type: dialog.type(), message: dialog.message() };
    } catch {
      // A dialog that cannot describe itself is still a dialog.
      view = { type: 'dialog', message: '' };
    }
    views.set(dialog, view);
    return view;
  };

  return {
    async answerDialog(disposition, promptText, answer = {}) {
      const showing = queued[0];
      if (answer.read !== undefined && (!showing || describe(showing).message !== answer.read)) {
        throw new Error(
          showing
            ? 'the dialog showing is not the one that was read; nothing was answered'
            : 'the dialog that was read is gone; nothing was answered',
        );
      }
      if (showing && unanswerable.has(showing)) {
        throw new Error(UNANSWERABLE_DIALOG);
      }
      if (disposition === 'accept' && showing && navigatedFrom.has(showing)) {
        throw new Error(
          'the page has navigated since this dialog was raised, and it may be gone: an answer now ' +
            'would go to whatever the page shows; nothing was accepted',
        );
      }
      const dialog =
        queued.shift() ??
        (await new Promise<AoiBrowserDriveDialog>((resolve, reject) => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const take = (next: AoiBrowserDriveDialog) => {
            if (timer !== undefined) {
              unschedule(timer);
            }
            resolve(next);
          };
          waiting = take;
          if (answer.timeoutMs !== undefined) {
            timer = schedule(() => {
              if (waiting === take) {
                waiting = null;
              }
              reject(new Error('no dialog appeared to answer'));
            }, answer.timeoutMs);
          }
        }));
      claim(dialog);
      // Read the message BEFORE answering: some implementations invalidate the
      // dialog once it is handled, and the message is the whole evidence.
      const message = dialog.message();
      const before = arrived;
      try {
        if (disposition === 'accept') {
          await dialog.accept(promptText);
        } else {
          await dialog.dismiss();
        }
      } catch (error) {
        // Not answered: still showing, unless another dialog took its place or
        // the browser says none shows -- and while it is, every act waits on
        // it, as it did before.
        const gone = error instanceof Error && /no dialog is showing/i.test(error.message);
        if (arrived === before && !queued.includes(dialog)) {
          if (!gone) {
            queued.unshift(dialog);
            abandonLater(dialog);
          } else if (inPlace.has(dialog)) {
            // None shows, the browser says, of one shown in place of another:
            // it is up, and nothing over this connection can answer it -- nor
            // dismiss it later. It stays, said to be so, until the page moves
            // away from it.
            unanswerable.add(dialog);
            views.set(dialog, { ...describe(dialog), unanswerable: true });
            queued.unshift(dialog);
            throw new Error(UNANSWERABLE_DIALOG);
          }
        }
        throw error;
      }
      return message;
    },
    pendingDialog() {
      const dialog = queued[0];
      return dialog ? describe(dialog) : null;
    },
    async releasePendingDialogs() {
      waiting = null;
      while (queued.length) {
        const dialog = queued.shift();
        if (dialog) {
          claim(dialog);
          await dialog.dismiss().catch(() => {});
        }
      }
    },
  };
}

export interface AoiBrowserDriveTabView {
  index: number;
  url: string;
  title: string;
  current: boolean;
  // Stays with the tab for as long as this handle lives, where `index` shifts
  // whenever a tab before it opens or closes. Internal: tells which tabs an act
  // opened, and is not shown to the model.
  id: number;
}

export interface AoiBrowserDriveTabHandle {
  listTabs(): Promise<AoiBrowserDriveTabView[]>;
  selectTab(index: number): Promise<void>;
  // Which page subsequent actions should be delivered to.
  currentPage(): AoiBrowserDriveRawPage;
  // Go back to the tab Aoi itself opened.
  //
  // Containment blanks the page when an act drifts onto a denied domain. That
  // was written when the drive only ever had its own tab; once it can switch to
  // one of the OPERATOR'S tabs, blanking the current page would navigate their
  // real tab -- a half-written message, a filled-in form -- to about:blank.
  // Returning to Aoi's own tab achieves the same containment (the drive is no
  // longer parked on the denied page) and destroys nothing.
  returnToOwnTab(): void;
  isOnOwnTab(): boolean;
}

/**
 * Address the tabs of one browser context.
 *
 * Selecting a tab is only meaningful if everything AFTER it goes to that tab, so
 * this owns which page is current rather than merely reporting it. The executor
 * verifies the switch by reading the listing back, and this is what makes that
 * check able to fail honestly: `current` is derived from the page this handle
 * would actually act on, not from what was asked for.
 */
export function attachAoiBrowserDriveTabs(
  context: AoiBrowserDriveRawContext,
  initialPage: AoiBrowserDriveRawPage,
): AoiBrowserDriveTabHandle {
  let current: AoiBrowserDriveRawPage = initialPage;
  const ids = new WeakMap<AoiBrowserDriveRawPage, number>();
  let nextId = 1;
  const idOf = (page: AoiBrowserDriveRawPage): number => {
    let id = ids.get(page);
    if (id === undefined) {
      id = nextId;
      nextId += 1;
      ids.set(page, id);
    }
    return id;
  };

  const readTitle = async (page: AoiBrowserDriveRawPage): Promise<string> => {
    if (typeof page.title !== 'function') {
      return '';
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // A tab whose page shows a dialog holds its title until the dialog goes:
      // it is listed without one.
      return await Promise.race([
        page.title(),
        new Promise<string>((resolve) => {
          timer = setTimeout(() => resolve(''), TAB_TITLE_DEADLINE_MS);
        }),
      ]);
    } catch {
      // A tab mid-navigation cannot report a title; that is not a failure of the
      // listing.
      return '';
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    async listTabs() {
      const pages = context.pages();
      const titles = await Promise.all(pages.map((page) => readTitle(page)));
      return pages.map(
        (page, index): AoiBrowserDriveTabView => ({
          index,
          url: (() => {
            try {
              return page.url();
            } catch {
              return '';
            }
          })(),
          title: titles[index],
          current: page === current,
          id: idOf(page),
        }),
      );
    },
    async selectTab(index: number) {
      const pages = context.pages();
      const target = pages[index];
      if (!target) {
        throw new Error(`no tab at index ${index}`);
      }
      current = target;
      // Best-effort: the page is current for Aoi either way, but a tab the
      // operator can also see is less confusing than one acting invisibly.
      if (typeof target.bringToFront === 'function') {
        try {
          await target.bringToFront();
        } catch {
          // Not fatal; delivery does not depend on it.
        }
      }
    },
    currentPage() {
      return current;
    },
    returnToOwnTab() {
      current = initialPage;
    },
    isOnOwnTab() {
      return current === initialPage;
    },
  };
}

/**
 * Click something that starts a download and save the file.
 *
 * Playwright does not expose this as a page method either: a download arrives as
 * an EVENT, and the file only exists in a temporary location until something
 * calls saveAs. So a drive that merely clicked would produce a file that is
 * silently discarded when the browser context closes -- an action that appears
 * to work and leaves nothing behind.
 *
 * The wait is armed BEFORE the click. Arming it afterwards is a race the page
 * usually wins on a fast connection, and losing it looks identical to a site
 * that never offered a file.
 *
 * The filename comes from the SITE, so it is used as a name and never as a path:
 * anything with a separator or a parent reference in it would otherwise let the
 * page choose where on disk its file lands, which is the whole point of bounding
 * the directory.
 */
export async function downloadAoiBrowserDriveFile(
  page: AoiBrowserDriveDownloadablePage,
  selector: string,
  directory: string,
  options: { timeout?: number } = {},
): Promise<{ path: string; suggestedFilename: string }> {
  const deadline = options.timeout ? Date.now() + options.timeout : null;
  const waiter = page.waitForEvent('download', {
    ...(options.timeout ? { timeout: options.timeout } : {}),
  });
  // A click that fails leaves the wait to run out with nobody to hear it.
  waiter.catch(() => undefined);
  await page.click(selector, { ...(options.timeout ? { timeout: options.timeout } : {}) });
  const download = await waiter;

  const suggested = (() => {
    try {
      return download.suggestedFilename();
    } catch {
      return '';
    }
  })();
  // Reduce whatever the site suggested to a bare filename.
  const bare = suggested.split(/[\\/]/).pop() ?? '';
  const safe = bare && bare !== '.' && bare !== '..' ? bare : 'download';

  const separator = directory.endsWith('/') || directory.endsWith('\\') ? '' : '/';
  const target = `${directory}${separator}${safe}`;
  // Saving waits for the download to finish, and a server that stalls it holds
  // the act for as long as it likes: within the act's time it lands, or it is
  // cancelled -- nothing of it is kept.
  const saving = download.saveAs(target);
  if (deadline !== null) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<'late'>((resolveLate) => {
      timer = setTimeout(() => resolveLate('late'), Math.max(1, deadline - Date.now()));
    });
    const settled = await Promise.race([saving.then(() => 'saved' as const), late]).finally(() =>
      clearTimeout(timer),
    );
    if (settled === 'late') {
      saving.catch(() => {});
      await download.cancel?.().catch(() => {});
      throw new Error('the download did not finish within the time the act had, and was cancelled');
    }
  } else {
    await saving;
  }

  if (typeof download.failure === 'function') {
    const failure = await download.failure();
    if (failure) {
      throw new Error(`the download did not complete: ${failure}`);
    }
  }
  return { path: target, suggestedFilename: safe };
}
