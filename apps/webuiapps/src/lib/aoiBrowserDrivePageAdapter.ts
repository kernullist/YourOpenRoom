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
}

export interface AoiBrowserDriveRawContext {
  pages(): AoiBrowserDriveRawPage[];
}

// The slice of Playwright's Download this needs.
export interface AoiBrowserDriveDownload {
  suggestedFilename(): string;
  saveAs(target: string): Promise<void>;
  failure?(): Promise<string | null>;
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

export interface AoiBrowserDriveDialogHandle {
  // Answer the dialog that is showing, or the next one to appear within the
  // caller's own timeout. Returns the message, which is the evidence of WHAT was
  // agreed to -- the caller chose a disposition before it could see this.
  answerDialog(disposition: 'accept' | 'dismiss', promptText?: string): Promise<string>;
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
export function attachAoiBrowserDriveDialogs(
  page: AoiBrowserDriveRawPage,
  options: { abandonAfterMs?: number; setTimer?: typeof setTimeout } = {},
): AoiBrowserDriveDialogHandle {
  const abandonAfterMs = options.abandonAfterMs ?? DIALOG_ABANDON_MS;
  const schedule = options.setTimer ?? setTimeout;
  const queued: AoiBrowserDriveDialog[] = [];
  let waiting: ((dialog: AoiBrowserDriveDialog) => void) | null = null;

  page.on('dialog', (dialog) => {
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve(dialog);
      return;
    }
    queued.push(dialog);
    // Nobody is waiting yet. Give a step time to claim it, then put the page
    // back the way Playwright would have left it.
    schedule(() => {
      const index = queued.indexOf(dialog);
      if (index >= 0) {
        queued.splice(index, 1);
        void dialog.dismiss().catch(() => {});
      }
    }, abandonAfterMs);
  });

  return {
    async answerDialog(disposition, promptText) {
      const dialog =
        queued.shift() ??
        (await new Promise<AoiBrowserDriveDialog>((resolve) => {
          waiting = resolve;
        }));
      // Read the message BEFORE answering: some implementations invalidate the
      // dialog once it is handled, and the message is the whole evidence.
      const message = dialog.message();
      if (disposition === 'accept') {
        await dialog.accept(promptText);
      } else {
        await dialog.dismiss();
      }
      return message;
    },
    async releasePendingDialogs() {
      waiting = null;
      while (queued.length) {
        const dialog = queued.shift();
        if (dialog) {
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

  const readTitle = async (page: AoiBrowserDriveRawPage): Promise<string> => {
    if (typeof page.title !== 'function') {
      return '';
    }
    try {
      return await page.title();
    } catch {
      // A tab mid-navigation cannot report a title; that is not a failure of the
      // listing.
      return '';
    }
  };

  return {
    async listTabs() {
      const pages = context.pages();
      const views: AoiBrowserDriveTabView[] = [];
      for (let index = 0; index < pages.length; index += 1) {
        const page = pages[index];
        views.push({
          index,
          url: (() => {
            try {
              return page.url();
            } catch {
              return '';
            }
          })(),
          title: await readTitle(page),
          current: page === current,
        });
      }
      return views;
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
  const waiter = page.waitForEvent('download', {
    ...(options.timeout ? { timeout: options.timeout } : {}),
  });
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
  await download.saveAs(target);

  if (typeof download.failure === 'function') {
    const failure = await download.failure();
    if (failure) {
      throw new Error(`the download did not complete: ${failure}`);
    }
  }
  return { path: target, suggestedFilename: safe };
}
