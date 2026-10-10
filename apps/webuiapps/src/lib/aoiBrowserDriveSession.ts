// Aoi browser-drive (BD) session manager (P0.2): launch a CDP-attachable instance
// of the operator's OWN Chrome/Edge, wait for the DevTools handshake, connect over
// CDP with Playwright, and open an Aoi-only page to drive. This is the runtime that
// realizes "act on my already-logged-in browser on my behalf".
//
// SERVER-ONLY (child_process / fs / net / lazy playwright-core). Every external
// effect is an injectable dependency so the whole flow is unit-testable WITHOUT a
// real browser or Playwright; production defaults resolve the real impls. Nothing
// here is wired to a route/tool yet -> importing this changes no runtime behavior.
//
// Safety posture (see JARVIS/05-browser-drive-roadmap.md):
//   - The caller enforces the os_browser_drive kill-switch + browser-drive consent
//     BEFORE starting a session; this module is the transport, not the gate.
//   - Teardown closes ONLY the page(s) Aoi opened. It never closes the shared
//     browser (that would kill the user's live session); the launcher owns the
//     browser process lifecycle.

import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import { resolve } from 'path';
import { join } from 'path';
import {
  type AoiBrowserDriveEngine,
  type AoiDevToolsActivePort,
  buildAoiBrowserDriveCdpHttpEndpoint,
  buildAoiBrowserDriveCdpWsEndpoint,
  buildAoiBrowserDriveLaunchArgs,
  parseAoiDevToolsActivePort,
  resolveAoiBrowserDriveDefaultUserDataDir,
} from './aoiBrowserDrive';
import { resolveAoiHostBrowserExecutable } from './aoiHostBrowserRead';

const DEFAULT_ATTACH_TIMEOUT_MS = 20_000;
const MAX_ATTACH_TIMEOUT_MS = 60_000;
const DEVTOOLS_POLL_INTERVAL_MS = 150;
const DEVTOOLS_ACTIVE_PORT_FILE = 'DevToolsActivePort';

export type AoiBrowserDriveStartDenyReason =
  | 'browser_not_found'
  | 'user_data_dir_unresolved'
  | 'port_unavailable'
  | 'spawn_failed'
  | 'attach_timeout'
  | 'connect_failed';

// Minimal structural surface of the Playwright objects we use -- avoids a static
// import of playwright-core (kept lazy + injectable) and keeps the client bundle
// free of it.
import {
  attachAoiBrowserDriveDialogs,
  attachAoiBrowserDriveTabs,
  downloadAoiBrowserDriveFile,
  type AoiBrowserDriveDialogAnswer,
  type AoiBrowserDriveDownloadablePage,
  type AoiBrowserDriveRawContext,
  type AoiBrowserDriveRawPage,
} from './aoiBrowserDrivePageAdapter';

export interface AoiBrowserDrivePage {
  url(): string;
  close(options?: { runBeforeUnload?: boolean }): Promise<void>;
}

export interface AoiBrowserDriveContext {
  newPage(): Promise<AoiBrowserDrivePage>;
}

export interface AoiBrowserDriveBrowser {
  contexts(): AoiBrowserDriveContext[];
  isConnected(): boolean;
  close(): Promise<void>;
}

export type AoiBrowserDriveConnect = (cdpHttpEndpoint: string) => Promise<AoiBrowserDriveBrowser>;

export interface AoiBrowserDriveStartOptions {
  userDataDir?: string;
  engine?: AoiBrowserDriveEngine;
  headless?: boolean;
  timeoutMs?: number;
  browserExecutablePath?: string;
}

export interface AoiBrowserDriveSessionDeps {
  spawnImpl?: typeof spawn;
  resolveExecutable?: (overridePath?: string) => { path: string; engine: string } | null;
  pickPort?: () => Promise<number>;
  resolveDefaultUserDataDir?: (engine: AoiBrowserDriveEngine) => string | null;
  readFile?: (path: string) => string;
  // Ask the browser's own DevTools HTTP endpoint who it is. See the handshake
  // below for why this exists at all.
  probeDevTools?: (port: number) => Promise<string | null>;
  fileExists?: (path: string) => boolean;
  // Records the port a launch used, so the next session can attach to it.
  writeFile?: (path: string, data: string) => void;
  connect?: AoiBrowserDriveConnect;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface AoiBrowserDriveSession {
  browser: AoiBrowserDriveBrowser;
  page: AoiBrowserDrivePage;
  port: number;
  cdpHttpEndpoint: string;
  engine: AoiBrowserDriveEngine;
  userDataDir: string;
  child: ChildProcess | null;
  close(): Promise<void>;
}

// The slice of Playwright's Locator the actionability wait reads through.
interface AoiWaitableLocator {
  first(): AoiWaitableLocator;
  waitFor(options: { state: 'attached' | 'visible'; timeout: number }): Promise<void>;
  isEnabled(options?: { timeout?: number }): Promise<boolean>;
  isEditable(options?: { timeout?: number }): Promise<boolean>;
  scrollIntoViewIfNeeded(options?: { timeout?: number }): Promise<void>;
  evaluate<R, A>(
    fn: (element: Element, arg: A) => R,
    arg: A,
    options?: { timeout?: number },
  ): Promise<R>;
}

/**
 * Whether a pointer would reach the element where Playwright aims it, asked of
 * the browser with elementFromPoint -- which dispatches nothing. Playwright's own
 * check waits for the same thing, but by then the element has been judged: a
 * "Continue" under a loading overlay is "Pay now" the moment the overlay goes.
 * Waiting for this first means the element is judged as it is uncovered.
 *
 * It asks what Playwright asks: the point is the middle of the element's first
 * box, as much of it as is in view (a link that wraps is aimed at its first
 * line, a box taller than the window at the part showing), and a hit counts
 * when it lands on the element or inside it -- or inside the button or link
 * around it, which Playwright aims for instead: an icon that lets the pointer
 * through is clicked through its button. Exported for its own tests; in use it
 * runs inside the page, by evaluate, so it calls nothing of this module's.
 */
export function reachedWherePlaywrightAims(element: Element): boolean {
  // A real page's nodes are read through their prototypes, never their own
  // properties: a form's named controls stand in for its own (<input
  // name="parentElement">, which would walk the hit in circles), and a
  // document's named elements for its (<img name="elementFromPoint">). A
  // stand-in for a node is read as it is.
  const page =
    typeof Element === 'function' &&
    Object.prototype.isPrototypeOf.call(Element.prototype, element);
  const inherited = (node: object, name: string): PropertyDescriptor | undefined => {
    for (let proto = Object.getPrototypeOf(node); proto; proto = Object.getPrototypeOf(proto)) {
      const found = Object.getOwnPropertyDescriptor(proto, name);
      if (found) {
        return found;
      }
    }
    return undefined;
  };
  const read = (node: object, name: string): unknown => {
    const found = page ? inherited(node, name) : undefined;
    return found?.get ? found.get.call(node) : (node as Record<string, unknown>)[name];
  };
  const call = (node: object, name: string, ...args: unknown[]): unknown => {
    const found = page ? inherited(node, name) : undefined;
    const method =
      typeof found?.value === 'function' ? found.value : (node as Record<string, unknown>)[name];
    return (method as (...inner: unknown[]) => unknown).apply(node, args);
  };
  const doc = read(element, 'ownerDocument') as Document;
  const view = read(doc, 'defaultView') as Window | null;
  const width = view ? view.innerWidth : 0;
  const height = view ? view.innerHeight : 0;
  let x = -1;
  let y = -1;
  const boxes = call(element, 'getClientRects') as ArrayLike<DOMRect>;
  for (let index = 0; index < boxes.length; index += 1) {
    const box = boxes[index];
    const left = Math.min(Math.max(box.left, 0), width);
    const right = Math.min(Math.max(box.right, 0), width);
    const top = Math.min(Math.max(box.top, 0), height);
    const bottom = Math.min(Math.max(box.bottom, 0), height);
    if ((right - left) * (bottom - top) > 0.99) {
      x = (left + right) / 2;
      y = (top + bottom) / 2;
      break;
    }
  }
  if (x < 0) {
    return false;
  }
  const aimed =
    call(element, 'matches', 'input, textarea, select') ||
    read(element, 'isContentEditable') === true
      ? element
      : ((call(element, 'closest', 'button, [role=button], a, [role=link]') as Element | null) ??
        element);
  let hit = call(doc, 'elementFromPoint', x, y) as Element | null;
  for (let depth = 0; hit && depth < 64; depth += 1) {
    const shadow = read(hit, 'shadowRoot') as ShadowRoot | null;
    if (!shadow) {
      break;
    }
    let inner = call(shadow, 'elementFromPoint', x, y) as Element | null;
    if (inner === hit) {
      // Over text a slot puts in the tree -- a component's button labelled by
      // what the page slots in -- the tree answers with its host; the first
      // of what lies under the point in it is what is hit, as Playwright
      // finds it.
      const under = call(shadow, 'elementsFromPoint', x, y) as ArrayLike<Element> | null;
      inner = under && under.length > 0 ? under[0] : inner;
    }
    if (!inner || inner === hit) {
      break;
    }
    hit = inner;
  }
  // Up from the hit, through slots and out of shadow trees -- never further than
  // a tree is deep.
  let node: object | null = hit;
  for (let step = 0; node && step < 10_000; step += 1) {
    if (node === aimed) {
      return true;
    }
    const parent = read(node, 'parentNode') as object | null;
    node = ((read(node, 'assignedSlot') as object | null) ??
      (read(node, 'parentElement') as object | null) ??
      (parent && read(parent, 'nodeType') === 11 ? read(parent, 'host') : null)) as object | null;
  }
  return false;
}

/**
 * What the button Enter in this field presses says: the default button of the
 * field's form owner -- the browser's own answer, which the parser can make a
 * form the field does not sit in, with that button anywhere -- by its text (its
 * shadow tree's too), value and names. A field in a component's shadow tree
 * has no form owner the browser knows of, yet the component submits a form all
 * the same, as a field would (Shoelace, FAST): the one around its host -- the
 * host's own when it is form-associated, the one its `form` attribute names, or
 * the one it sits in -- host by host up out of the trees. With no default
 * button there, Enter submits the form as it stands, and the form says what it
 * commits: what its buttons say first, then its names, and its text by its
 * start and its end, shadow trees' too. A form that holds more buttons, or
 * more in all, than are looked at throws: what Enter commits is not known.
 * (Its answer is the words themselves, so that a page answering for them with
 * a promise that never settles holds the read up, to be cut off and refused.)
 * Exported for its own tests; in use it runs inside the page, by evaluate, so
 * it calls nothing of this module's.
 */
export function formOwnerDefaultButtonWords(element: Element): string {
  // A real page's nodes are read through the prototypes: a form's named
  // controls stand in for its own properties (<input name="elements">,
  // <input name="childNodes">), and a document's named elements for its
  // (<img name="querySelectorAll">). A field, a button or a shadow root have no
  // such names. The stand-ins of this function's tests are read as they are.
  const page =
    typeof Node === 'function' && Object.prototype.isPrototypeOf.call(Node.prototype, element);
  const own = (proto: object, name: string, node: unknown): unknown =>
    Object.getOwnPropertyDescriptor(proto, name)?.get?.call(node);
  const typeOf = (node: Node): number =>
    page ? Number(own(Node.prototype, 'nodeType', node)) : node.nodeType;
  const rootOf = (node: Node): Document | ShadowRoot =>
    (page ? Node.prototype.getRootNode.call(node) : node.getRootNode()) as Document | ShadowRoot;
  const inTree = (root: Document | ShadowRoot): Document =>
    (page
      ? typeOf(root) === 9
        ? Document.prototype
        : DocumentFragment.prototype
      : root) as unknown as Document;
  const attributeOf = (node: Element, name: string): string | null =>
    page ? Element.prototype.getAttribute.call(node, name) : node.getAttribute(name);
  const isForm = (value: unknown): value is HTMLFormElement =>
    page
      ? typeof HTMLFormElement === 'function' &&
        Object.prototype.isPrototypeOf.call(HTMLFormElement.prototype, value as object)
      : typeof value === 'object' && value !== null;
  // What a node shows in text, its shadow tree's after its own, no scripts or
  // styles, no further than `limit` characters.
  const textOf = (start: Node, limit: number): string => {
    let text = '';
    const pending: Node[] = [start];
    while (pending.length > 0 && text.length < limit) {
      const node = pending.pop() as Node;
      const type = typeOf(node);
      // A text has no named properties to stand in for its own; a form's named
      // control standing in for its nodeName only has its text read.
      if (type === 3) {
        text += ` ${node.nodeValue ?? ''}`;
        continue;
      }
      if (/^(script|style|template|noscript)$/i.test(String(node.nodeName))) {
        continue;
      }
      const children: Node[] = Array.from(
        (page ? own(Node.prototype, 'childNodes', node) : node.childNodes) as ArrayLike<Node>,
      );
      const shadow = (
        type === 1
          ? page
            ? own(Element.prototype, 'shadowRoot', node)
            : (node as Element).shadowRoot
          : null
      ) as ShadowRoot | null;
      if (shadow) {
        children.push(
          ...Array.from(
            (page
              ? own(Node.prototype, 'childNodes', shadow)
              : shadow.childNodes) as ArrayLike<Node>,
          ),
        );
      }
      for (let child = children.length - 1; child >= 0; child -= 1) {
        pending.push(children[child]);
      }
    }
    return text.replace(/\s+/g, ' ').trim();
  };
  // What a node shows at its end, no further than `limit` characters back:
  // the same text, read from its last node.
  const tailOf = (start: Node, limit: number): string => {
    let text = '';
    const pending: Node[] = [start];
    while (pending.length > 0 && text.length < limit) {
      const node = pending.pop() as Node;
      const type = typeOf(node);
      if (type === 3) {
        text = `${node.nodeValue ?? ''} ${text}`;
        continue;
      }
      if (/^(script|style|template|noscript)$/i.test(String(node.nodeName))) {
        continue;
      }
      const children: Node[] = Array.from(
        (page ? own(Node.prototype, 'childNodes', node) : node.childNodes) as ArrayLike<Node>,
      );
      const shadow = (
        type === 1
          ? page
            ? own(Element.prototype, 'shadowRoot', node)
            : (node as Element).shadowRoot
          : null
      ) as ShadowRoot | null;
      if (shadow) {
        for (const child of Array.from(
          (page ? own(Node.prototype, 'childNodes', shadow) : shadow.childNodes) as ArrayLike<Node>,
        )) {
          children.push(child);
        }
      }
      for (const child of children) {
        pending.push(child);
      }
    }
    return text.replace(/\s+/g, ' ').trim();
  };

  const owner = (element as HTMLInputElement).form;
  let form: HTMLFormElement | null = isForm(owner) ? owner : null;
  for (let node: Node = element, steps = 0; !form && steps < 64; steps += 1) {
    const host = (rootOf(node) as ShadowRoot).host;
    if (!host) {
      break;
    }
    const hostForm = (host as unknown as { form?: unknown }).form;
    const named = attributeOf(host, 'form');
    if (isForm(hostForm)) {
      form = hostForm;
    } else if (named) {
      // A form attribute that names no form gives no form, as on a field.
      const byId = inTree(rootOf(host)).getElementById.call(rootOf(host), named);
      form = isForm(byId) ? byId : null;
      break;
    } else {
      const around = page ? Element.prototype.closest.call(host, 'form') : host.closest('form');
      form = isForm(around) ? around : null;
    }
    node = host;
  }
  if (!form) {
    return '';
  }
  // The tree's default submit controls, and of them the one the form owns. Not
  // through the form itself: form.elements leaves out an image button besides.
  const tree = rootOf(form);
  const defaults =
    ':is(button:not([type="button"]):not([type="reset"]), input[type="submit"], input[type="image"]):default';
  const controls = inTree(tree).querySelectorAll.call(tree, defaults);
  for (let index = 0; index < controls.length; index += 1) {
    const control = controls[index] as HTMLButtonElement;
    if (control.form !== form) {
      continue;
    }
    return [
      textOf(control, 600),
      attributeOf(control, 'value'),
      attributeOf(control, 'aria-label'),
      attributeOf(control, 'alt'),
      attributeOf(control, 'title'),
    ]
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 600);
  }
  // And what its buttons say, wherever in it they are: a component's button
  // among them, whose label its host holds (<x-button>Pay $49.00</x-button>,
  // a <button> in its shadow tree that submits the form), and what a script
  // makes one of -- a link to nowhere or to a script, an element that takes
  // clicks itself ("Donate $25 now" styled as a button). A link to a page goes
  // there; it submits nothing. Each is read by its start and its end, a card's
  // "Donate $25 now" after its description included, and on into it: a box
  // that takes clicks around the whole form holds the pay link all the same.
  // They are read in up to 20,000 nodes and 16,000 characters, and each is
  // its own line, judged on its own: "Check out" ends one.
  const buttonish =
    'button, input[type="submit"], input[type="image"], input[type="button"], [role="button"], ' +
    '[type="submit"], a:not([href]), a[href="#"], a[href^="#"], a[href^="javascript:"], ' +
    'a[href^="JavaScript:"], a[href^="Javascript:"], a[href^="JAVASCRIPT:"], [onclick], ' +
    '[role="link"]:not([href])';
  const matches = (node: Element, selector: string): boolean =>
    page ? Element.prototype.matches.call(node, selector) : node.matches?.(selector) === true;
  const buttons: string[] = [];
  let said = 0;
  const pending: Node[] = [form];
  for (let looked = 0; pending.length > 0 && looked < 20_000 && said <= 16_000; looked += 1) {
    const node = pending.pop() as Node;
    if (typeOf(node) !== 1) {
      continue;
    }
    const shadow = (
      page ? own(Element.prototype, 'shadowRoot', node) : (node as Element).shadowRoot
    ) as ShadowRoot | null;
    const holds =
      shadow !== null &&
      (page
        ? DocumentFragment.prototype.querySelector.call(shadow, buttonish)
        : (shadow.querySelector?.(buttonish) ?? null)) !== null;
    if (node !== form && (holds || matches(node as Element, buttonish))) {
      const head = textOf(node, 181);
      const words = [
        head.length <= 180 ? head : `${head.slice(0, 120)} ${tailOf(node, 60).slice(-60)}`,
        attributeOf(node as Element, 'aria-label'),
        attributeOf(node as Element, 'value'),
        attributeOf(node as Element, 'title'),
      ]
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 260);
      buttons.push(words);
      said += words.length + 1;
    }
    const children: Node[] = Array.from(
      (page ? own(Node.prototype, 'childNodes', node) : node.childNodes) as ArrayLike<Node>,
    );
    if (shadow) {
      children.push(
        ...Array.from(
          (page ? own(Node.prototype, 'childNodes', shadow) : shadow.childNodes) as ArrayLike<Node>,
        ),
      );
    }
    for (let child = children.length - 1; child >= 0; child -= 1) {
      pending.push(children[child]);
    }
  }
  if (pending.length > 0 || said > 16_000) {
    throw new Error('the form is too large to read through');
  }
  const text = textOf(form, 20_000);
  const name = (attribute: string) => (attributeOf(form as Element, attribute) ?? '').slice(0, 200);
  return [
    ...buttons,
    [
      name('aria-label'),
      name('name'),
      name('title'),
      text.length <= 600 ? text : `${text.slice(0, 300)} ${text.slice(-300)}`,
    ].join(' '),
  ]
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

/**
 * What an element shows: its text where it can be seen -- inside the element's
 * own box, inside every box around the text that clips what it holds, and
 * inside every box around the element that hides what overflows it (a card of
 * a set height); not under an opacity of 0, an old clip rectangle or a
 * clip-path that leaves nothing, nor in a colour that draws nothing -- counted
 * as far as `limit` and a little past it, with the words so counted. innerText
 * counts what is not seen as well: a description for screen readers, a tooltip
 * waiting at opacity 0, the clamped rest of a card's text, beside a box's "Buy
 * now $49.00". What open shadow trees and slots put in it is counted where
 * they draw it; what a list box or a text box holds is not. An element of no
 * size of its own -- display: contents, floats it does not clear, children
 * placed absolutely -- is measured by what it holds wherever on the page that
 * draws, as far as the page scrolls, unless it clips them to its nothing. The
 * words run on as they are drawn: "Pay" in a highlight and the "ment" after it
 * are "Payment"; blocks, and runs drawn apart, are set apart. Null when it
 * holds more than is walked, or sits deeper than the climb around it goes.
 * The slots of closed shadow trees the climb passes, which no script sees
 * (`closedSlots`: an element slotted, then its slot, as the browser's protocol
 * names them), are climbed through as an open tree's are.
 *
 * Exported for its own tests; in use it runs in the page or in the check's own
 * world, so it calls nothing of this module's -- and it reads through the
 * prototypes, whatever a form calls its controls.
 */
export function shownTextIn(
  element: Element,
  limit: number,
  closedSlots: unknown[] = [],
): { length: number; text: string } | null {
  type Box = { left: number; top: number; right: number; bottom: number };
  const getterOf = (prototype: object, name: string) =>
    Object.getOwnPropertyDescriptor(prototype, name)?.get;
  const nodeTypeOf = getterOf(Node.prototype, 'nodeType');
  const childNodesOf = getterOf(Node.prototype, 'childNodes');
  const parentElementOf = getterOf(Node.prototype, 'parentElement');
  const ownerDocumentOf = getterOf(Node.prototype, 'ownerDocument');
  const documentElementOf = getterOf(Document.prototype, 'documentElement');
  const bodyOf = getterOf(Document.prototype, 'body');
  const scrollingElementOf = getterOf(Document.prototype, 'scrollingElement');
  const dataOf = getterOf(CharacterData.prototype, 'data');
  const localNameOf = getterOf(Element.prototype, 'localName');
  const shadowRootOf = getterOf(Element.prototype, 'shadowRoot');
  const assignedSlotOf = getterOf(Element.prototype, 'assignedSlot');
  const hostOf =
    typeof ShadowRoot === 'function' ? getterOf(ShadowRoot.prototype, 'host') : undefined;
  const {
    getBoundingClientRect,
    checkVisibility,
    hasAttribute: hasAttributeOf,
  } = Element.prototype;
  const { getRootNode } = Node.prototype;
  const assignedNodesOf =
    typeof HTMLSlotElement === 'function' ? HTMLSlotElement.prototype.assignedNodes : undefined;
  if (
    !nodeTypeOf ||
    !childNodesOf ||
    !parentElementOf ||
    !ownerDocumentOf ||
    !dataOf ||
    !localNameOf
  ) {
    return null;
  }
  const meet = (a: Box, b: Box): Box => ({
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
  });
  const areaOf = (box: Box) =>
    Math.max(0, box.right - box.left) * Math.max(0, box.bottom - box.top);
  const shows = (value: string | undefined, none: string) => Boolean(value) && value !== none;
  const clips = (style: CSSStyleDeclaration) =>
    shows(style.overflowX, 'visible') ||
    shows(style.overflowY, 'visible') ||
    /paint|strict|content/.test(style.contain);
  const hides = (overflow: string | undefined) => /^(hidden|clip)$/.test(overflow ?? '');
  const owner = ownerDocumentOf.call(element) as Document;
  const root = (
    documentElementOf ? documentElementOf.call(owner) : owner.documentElement
  ) as Element | null;
  const body = (bodyOf ? bodyOf.call(owner) : owner.body) as Element | null;
  const rootStyle = root ? getComputedStyle(root) : null;
  // The window takes the body's overflow when the root leaves its own to it:
  // then neither one's box clips what it holds -- the window does.
  const bodyForWindow = Boolean(
    body && rootStyle && rootStyle.overflowX === 'visible' && rootStyle.overflowY === 'visible',
  );
  // A measure of a box and its scrolling, read through the prototype (an
  // element's, or an HTML element's for its laid-out size); 0 for one it has
  // none of.
  const metricOf = (box: Element, name: string): number => {
    const getter =
      getterOf(Element.prototype, name) ??
      (typeof HTMLElement === 'function' ? getterOf(HTMLElement.prototype, name) : undefined);
    try {
      return (
        Number(getter ? getter.call(box) : (box as unknown as Record<string, unknown>)[name]) || 0
      );
    } catch {
      return 0;
    }
  };
  // Which ways a box scrolls from its far side: to the left when it is written
  // right to left or its lines are set right to left (vertical-rl), or a
  // reversed flex row lays it out from the right; up when its text runs
  // upward, or a reversed flex column lays it out from the bottom (a chat's
  // newest message first) -- and the other way across a flex box's lines
  // when they wrap in reverse. A box scrolled from where it starts says so
  // itself.
  const reversedOf = (box: Element, style: CSSStyleDeclaration, flex: boolean) => {
    const mode = style.writingMode || '';
    const vertical = /^(vertical|sideways)/.test(mode);
    const rtl = style.direction === 'rtl';
    let leftward = vertical ? /-rl$/.test(mode) : rtl;
    let upward = vertical && rtl !== /^sideways-lr/.test(mode);
    if (flex && /flex$/.test(style.display || '')) {
      // Whether its main axis runs across the page.
      const mainAcross = /^column/.test(style.flexDirection || '') === vertical;
      if (/reverse$/.test(style.flexDirection || '')) {
        leftward = mainAcross ? !leftward : leftward;
        upward = mainAcross ? upward : !upward;
      }
      if (style.flexWrap === 'wrap-reverse') {
        leftward = mainAcross ? leftward : !leftward;
        upward = mainAcross ? !upward : upward;
      }
    }
    const left = metricOf(box, 'scrollLeft');
    const top = metricOf(box, 'scrollTop');
    return {
      leftward: left < 0 || (left === 0 && leftward),
      upward: top < 0 || (top === 0 && upward),
    };
  };
  // What a box that scrolls can bring into view: from where its scrolling
  // starts, as far as it scrolls, the ways it scrolls -- not what overflows it
  // the other way, which no scrolling reaches (a note set at left: -9999px).
  // Its measures of itself are taken before a zoom or a scale draws it larger
  // or smaller, where it is: they are scaled as it is drawn.
  const reachOf = (box: Element, style: CSSStyleDeclaration, rect: DOMRect): Box => {
    const { leftward, upward } = reversedOf(box, style, true);
    const laidWide = metricOf(box, 'offsetWidth');
    const laidTall = metricOf(box, 'offsetHeight');
    const scaleAcross = laidWide > 0 && rect.width > 0 ? rect.width / laidWide : 1;
    const scaleDown = laidTall > 0 && rect.height > 0 ? rect.height / laidTall : 1;
    const across = (name: string) => metricOf(box, name) * scaleAcross;
    const down = (name: string) => metricOf(box, name) * scaleDown;
    const fromLeft = rect.left + across('clientLeft');
    const fromTop = rect.top + down('clientTop');
    const wide = across('scrollWidth');
    const tall = down('scrollHeight');
    const left = leftward
      ? fromLeft + across('clientWidth') - across('scrollLeft') - wide
      : fromLeft - across('scrollLeft');
    const top = upward
      ? fromTop + down('clientHeight') - down('scrollTop') - tall
      : fromTop - down('scrollTop');
    return { left, top, right: left + wide, bottom: top + tall };
  };
  // Where on the page anything can be seen: as far down as the page goes --
  // what is below the window is out of view, not hidden, even while the page
  // keeps itself from scrolling (an open dialog does) -- and across as far as
  // it scrolls, or the window where it hides what overflows sideways (a menu
  // kept off to the side); the ways it scrolls from its start, as the body is
  // written (the root, without one). Null when that cannot be told.
  const pageArea = (): Box | null => {
    const scroller = ((scrollingElementOf
      ? scrollingElementOf.call(owner)
      : owner.scrollingElement) ?? root) as Element | null;
    if (!scroller || !rootStyle) {
      return null;
    }
    const view = bodyForWindow ? getComputedStyle(body as Element) : rootStyle;
    const { leftward, upward } = reversedOf(
      scroller,
      body ? getComputedStyle(body) : rootStyle,
      false,
    );
    const left = metricOf(scroller, 'scrollLeft');
    const top = metricOf(scroller, 'scrollTop');
    const width = metricOf(scroller, 'clientWidth');
    const height = metricOf(scroller, 'clientHeight');
    const wide = metricOf(scroller, 'scrollWidth');
    const tall = Math.max(metricOf(scroller, 'scrollHeight'), height);
    const across = hides(view.overflowX)
      ? [0, width]
      : leftward
        ? [width - wide - left, width - left]
        : [-left, wide - left];
    const down = upward ? [height - tall - top, height - top] : [-top, tall - top];
    const area = { left: across[0], top: down[0], right: across[1], bottom: down[1] };
    return areaOf(area) > 0 ? area : null;
  };
  // The window: where what is fixed to it can be seen. Null when it cannot be
  // told.
  const defaultViewOf = getterOf(Document.prototype, 'defaultView');
  const windowArea = (): Box | null => {
    const view = (defaultViewOf ? defaultViewOf.call(owner) : owner.defaultView) as Window | null;
    const width = view ? Number(view.innerWidth) || 0 : 0;
    const height = view ? Number(view.innerHeight) || 0 : 0;
    return width > 0 && height > 0 ? { left: 0, top: 0, right: width, bottom: height } : null;
  };
  // What the boxes around the element clip it to: each that hides what
  // overflows it, the way it hides it -- a card of a set height to its height
  // -- and each a clip-path or paint containment cuts to its box. One that
  // scrolls holds what it scrolls to, each way it scrolls: what it can bring
  // into view, and no more -- a long card scrolled out of a carousel is out of
  // view, not hidden -- and from it on the box stands for the element that
  // way: what is around clips the box, and the element is shown only as far
  // as the box's scrolling (`slack`, how far it reaches past its own sides,
  // and those of the boxes that scroll inside it) can bring it into what is
  // left of the box -- nothing, where nothing of the box is left, or past what
  // a box with nothing to scroll shows. Its own clip-path or containment cuts
  // only the ways it does not scroll. The root and a body the window takes the
  // overflow of clip nothing: at the top the page area clips, the box that
  // stands for the element or the element. Null when the climb goes deeper
  // than it is taken, or the page area is needed and cannot be told
  // (`needsPage`, for an element of no size of its own, the ways nothing on
  // the way scrolls).
  const clipAround = (box: Box, area: Box | null, needsPage: boolean): Box | null => {
    type Way = {
      shown: [number, number];
      holder: [number, number] | null;
      slack: [number, number];
    };
    const across: Way = { shown: [box.left, box.right], holder: null, slack: [0, 0] };
    const down: Way = { shown: [box.top, box.bottom], holder: null, slack: [0, 0] };
    const cutTo = (span: [number, number], from: number, to: number): [number, number] => [
      Math.max(span[0], from),
      Math.min(span[1], to),
    ];
    // The element as far as the box standing for it can bring it into view.
    const bound = (way: Way) => {
      if (way.holder) {
        way.shown = cutTo(way.shown, way.holder[0] - way.slack[0], way.holder[1] + way.slack[1]);
      }
    };
    // One way past one box: what hides clips the box standing for the element
    // or the element; what scrolls clips them to its reach, and stands for
    // the element from there on.
    const pass = (
      way: Way,
      hidden: boolean,
      own: [number, number],
      reach: [number, number] | null,
    ) => {
      if (hidden) {
        if (way.holder) {
          way.holder = cutTo(way.holder, own[0], own[1]);
          bound(way);
        } else {
          way.shown = cutTo(way.shown, own[0], own[1]);
        }
      }
      if (reach) {
        const slack: [number, number] = [
          Math.max(0, own[0] - reach[0]),
          Math.max(0, reach[1] - own[1]),
        ];
        if (way.holder) {
          way.holder = cutTo(way.holder, reach[0], reach[1]);
          bound(way);
          if (way.holder[1] > way.holder[0]) {
            way.holder = [own[0], own[1]];
            way.slack = [way.slack[0] + slack[0], way.slack[1] + slack[1]];
          }
        } else {
          way.shown = cutTo(way.shown, reach[0], reach[1]);
          way.holder = [own[0], own[1]];
          way.slack = slack;
        }
      }
    };
    const gone = (way: Way) => way.holder !== null && way.holder[1] <= way.holder[0];
    const nothing: Box = { left: 0, top: 0, right: 0, bottom: 0 };
    const slotOfClosed = new Map<unknown, Element>();
    for (let at = 0; at + 1 < closedSlots.length; at += 2) {
      slotOfClosed.set(closedSlots[at], closedSlots[at + 1] as Element);
    }
    // What is fixed to the window -- the element or a box around it -- does not
    // scroll with the page: the window, not the page, is where it is seen.
    let fixed = getComputedStyle(element).position === 'fixed';
    let node: Node = element;
    for (let level = 0; level < 1_000; level += 1) {
      const slot =
        (assignedSlotOf ? (assignedSlotOf.call(node) as Element | null) : null) ??
        slotOfClosed.get(node) ??
        null;
      const top = getRootNode.call(node);
      const parent =
        slot ??
        (parentElementOf.call(node) as Element | null) ??
        (hostOf && typeof ShadowRoot === 'function' && top instanceof ShadowRoot
          ? (hostOf.call(top) as Element)
          : null);
      if (!parent || parent === root || (parent === body && bodyForWindow)) {
        const view = (fixed ? windowArea() : null) ?? area;
        if (view === null) {
          return needsPage && !(across.holder && down.holder)
            ? null
            : {
                left: across.shown[0],
                right: across.shown[1],
                top: down.shown[0],
                bottom: down.shown[1],
              };
        }
        pass(across, true, [view.left, view.right], null);
        pass(down, true, [view.top, view.bottom], null);
        return gone(across) || gone(down)
          ? nothing
          : {
              left: across.shown[0],
              right: across.shown[1],
              top: down.shown[0],
              bottom: down.shown[1],
            };
      }
      node = parent;
      const style = getComputedStyle(parent);
      if (style.display === 'contents') {
        continue;
      }
      fixed ||= style.position === 'fixed';
      // An inline box scrolls nothing, whatever its overflow says.
      const scrolls = style.display !== 'inline';
      const scrollsAcross = scrolls && /^(auto|scroll)$/.test(style.overflowX ?? '');
      const scrollsDown = scrolls && /^(auto|scroll)$/.test(style.overflowY ?? '');
      const cut = shows(style.clipPath, 'none') || /paint|strict|content/.test(style.contain);
      const acrossHidden = (cut && !scrollsAcross) || hides(style.overflowX);
      const downHidden = (cut && !scrollsDown) || hides(style.overflowY);
      if (!acrossHidden && !downHidden && !scrollsAcross && !scrollsDown) {
        continue;
      }
      const rect = getBoundingClientRect.call(parent);
      const reach = scrollsAcross || scrollsDown ? reachOf(parent, style, rect) : null;
      pass(
        across,
        acrossHidden,
        [rect.left, rect.right],
        reach && scrollsAcross ? [reach.left, reach.right] : null,
      );
      pass(
        down,
        downHidden,
        [rect.top, rect.bottom],
        reach && scrollsDown ? [reach.top, reach.bottom] : null,
      );
      if (gone(across) || gone(down)) {
        return nothing;
      }
    }
    return null;
  };
  const whole = getBoundingClientRect.call(element);
  let start: Box = whole;
  const sized = whole.width > 0 && whole.height > 0;
  if (!sized) {
    const own = getComputedStyle(element);
    if (own.display !== 'contents' && clips(own)) {
      return { length: 0, text: '' };
    }
    start = { left: -Infinity, top: -Infinity, right: Infinity, bottom: Infinity };
  }
  const around = clipAround(start, pageArea(), !sized);
  if (around === null) {
    return null;
  }
  start = around;
  // A colour that draws nothing: transparent, or of no opacity.
  const clear = (color: string) => {
    if (color === 'transparent') {
      return true;
    }
    const rgba = /^rgba\(([^)]*)\)$/.exec(color);
    if (rgba) {
      const parts = rgba[1].split(',');
      return parts.length === 4 && parseFloat(parts[3]) === 0;
    }
    const alpha = /\/\s*([\d.]+)%?\s*\)$/.exec(color);
    return alpha !== null && parseFloat(alpha[1]) === 0;
  };
  // Text that draws nothing: in a colour of none, unless what fills it is a
  // background drawn through its letters (gradient text).
  const unseenInk = (style: CSSStyleDeclaration) =>
    clear(style.getPropertyValue('-webkit-text-fill-color') || style.color) &&
    !(
      /text/.test(
        `${style.getPropertyValue('background-clip')} ${style.getPropertyValue('-webkit-background-clip')}`,
      ) && shows(style.getPropertyValue('background-image'), 'none')
    );
  // A length of a clip-path, in pixels of `size`: a number of pixels or a
  // percentage; NaN for anything else (a calc()).
  const lengthOf = (value: string | undefined, size: number) => {
    const match = /^(-?[\d.]+)(px|%)?$/.exec(value ?? '0');
    return !match
      ? Number.NaN
      : match[2] === '%'
        ? (parseFloat(match[1]) * size) / 100
        : parseFloat(match[1]);
  };
  // A clip-path that leaves nothing: an inset whose sides meet -- inset(50%),
  // inset(0 50%), inset(0 0 100% 0) --, a polygon of no area, a circle or an
  // ellipse of no radius. Any other clips to the element's box (rounded or cut
  // corners).
  const clippedAway = (path: string, node: Element) => {
    if (/^(?:circle|ellipse)\(\s*0(?:px|%)?[\s)]/.test(path)) {
      return true;
    }
    const inset = /^inset\(([^)]*)\)$/.exec(path);
    if (inset) {
      const box = getBoundingClientRect.call(node);
      const [top, right = top, bottom = top, left = right] = inset[1]
        .split(/\s+round\s+/)[0]
        .trim()
        .split(/\s+/);
      const across = lengthOf(left, box.width) + lengthOf(right, box.width);
      const down = lengthOf(top, box.height) + lengthOf(bottom, box.height);
      return across >= box.width || down >= box.height;
    }
    const polygon = /^polygon\((?:\s*(?:nonzero|evenodd)\s*,)?([^)]*)\)$/.exec(path);
    if (polygon) {
      const box = getBoundingClientRect.call(node);
      const points = polygon[1].split(',').map((point) => {
        const [x, y] = point.trim().split(/\s+/);
        return [lengthOf(x, box.width), lengthOf(y, box.height)];
      });
      let twice = 0;
      for (let index = 0; index < points.length; index += 1) {
        const [x1, y1] = points[index];
        const [x2, y2] = points[(index + 1) % points.length];
        twice += x1 * y2 - x2 * y1;
      }
      return Math.abs(twice) / 2 === 0;
    }
    return false;
  };
  // Whether a run of text is drawn on from the one before it: on one line, by
  // no more than a sixth of the letters' size ("Pay" and "now" a margin apart
  // are two words; "Pay" and "Pal" in two colours of one wordmark are one). A
  // highlight drawn around a run -- a search's <mark> with a background and
  // padding -- ends where its box does (`beforeBox`, `afterBox`): "Pay" in it
  // and the "ment" that touches the box are one word. Its box counts as far as
  // a third of the letters' size past them.
  const touching = (
    before: DOMRect | null,
    after: DOMRect | undefined,
    style: CSSStyleDeclaration,
    tracking: number,
    beforeBox: DOMRect | null = null,
    afterBox: DOMRect | null = null,
  ) => {
    if (!before || !after) {
      return false;
    }
    const vertical = /^(vertical|sideways)/.test(style.writingMode || '');
    const sizeOf = (box: DOMRect) => (vertical ? box.right - box.left : box.bottom - box.top);
    const size = Math.min(sizeOf(before), sizeOf(after)) || parseFloat(style.fontSize) || 16;
    const across = vertical
      ? Math.abs(before.left + before.right - after.left - after.right) / 2
      : Math.abs(before.top + before.bottom - after.top - after.bottom) / 2;
    const alongOf = (one: DOMRect, next: DOMRect) =>
      vertical
        ? Math.max(next.top - one.bottom, one.top - next.bottom)
        : Math.max(next.left - one.right, one.left - next.right);
    const along = alongOf(before, after);
    const boxed = (gap: number | null) => (gap === null ? along : Math.max(gap, along - size / 3));
    const nearest = Math.min(
      along,
      boxed(beforeBox ? alongOf(beforeBox, after) : null),
      boxed(afterBox ? alongOf(before, afterBox) : null),
    );
    return across <= size / 2 && nearest + tracking <= size / 6;
  };
  // An inline box that draws a box around its text: a background or a border.
  const boxedIn = (style: CSSStyleDeclaration) =>
    !clear(style.backgroundColor || 'transparent') ||
    shows(style.backgroundImage, 'none') ||
    (['Top', 'Right', 'Bottom', 'Left'] as const).some(
      (side) =>
        parseFloat(style[`border${side}Width`]) > 0 &&
        !/^(none|hidden)$/.test(style[`border${side}Style`] || 'none') &&
        !clear(style[`border${side}Color`] || 'transparent'),
    );
  const { getClientRects } = Element.prototype;
  const edgeOf = (box: Element, end: boolean): DOMRect | null => {
    const rects = getClientRects.call(box);
    return rects.length > 0 ? rects[end ? rects.length - 1 : 0] : null;
  };
  // The highlight that ends between a run in the highlights `before` and the
  // next, in `after` -- where it ends -- and the one that begins there: one
  // that holds a piece of a word, letters alone ("Pay" of "Payment"), not a
  // chip of its own ("CHF 49.00", "NEW").
  const textOf = (node: Node, depth: number): string =>
    nodeTypeOf.call(node) === 3
      ? String(dataOf.call(node))
      : depth < 8
        ? Array.from(childNodesOf.call(node) as ArrayLike<Node>)
            .map((child) => textOf(child, depth + 1))
            .join('')
        : '';
  const pieceOfWord = (mark: Element) => {
    const text = textOf(mark, 0).trim();
    return /^\p{L}+$/u.test(text) && !/^\p{Lu}{2,}$/u.test(text);
  };
  const ended = (before: Element[], after: Element[]) => {
    const mark = before[before.length - 1];
    return mark && !after.includes(mark) && pieceOfWord(mark) ? edgeOf(mark, true) : null;
  };
  const begun = (before: Element[], after: Element[]) => {
    const mark = after[after.length - 1];
    return mark && !before.includes(mark) && pieceOfWord(mark) ? edgeOf(mark, false) : null;
  };
  const unread = new Set([
    'script',
    'style',
    'template',
    'noscript',
    'select',
    'textarea',
    'datalist',
  ]);
  const range = Document.prototype.createRange.call(owner);
  let shown = 0;
  const words: string[] = [];
  // The last piece of text counted: the block it is in, where it ends, and
  // whether a space -- in the text, or a cut it was shown to -- ends it; and
  // the highlights it is in.
  let last: {
    block: Node;
    end: DOMRect;
    spaced: boolean;
    tracking: number;
    marks: Element[];
  } | null = null;
  let visited = 0;
  // What is left to walk, each with the highlights it is in (`marks`, the
  // innermost last: the inline boxes around it, in its line, that draw a box
  // -- boxedIn).
  const pending: {
    node: Node;
    clip: Box;
    style: CSSStyleDeclaration | null;
    block: Node;
    marks: Element[];
  }[] = [{ node: element, clip: start, style: null, block: element, marks: [] }];
  while (pending.length > 0 && visited < 5_000) {
    const { node, clip, style, block, marks } = pending.pop() as (typeof pending)[number];
    visited += 1;
    const type = nodeTypeOf.call(node);
    if (type === 3) {
      const data = String(dataOf.call(node));
      const text = data.replace(/\s+/g, ' ').trim();
      if (!text || !style || style.visibility !== 'visible' || unseenInk(style)) {
        continue;
      }
      range.selectNodeContents(node);
      const rects = Array.from(range.getClientRects());
      let drawn = 0;
      let seen = 0;
      for (const rect of rects) {
        drawn += areaOf(rect);
        seen += areaOf(meet(clip, rect));
      }
      if (seen > 0) {
        const count = seen >= drawn ? text.length : Math.floor((text.length * seen) / drawn);
        shown += count;
        if (count > 0) {
          const piece = text.slice(0, count);
          // A highlight's box joins a word it splits -- a letter before, the
          // word going on in lower case after: "Pay" and "ment" -- not a word
          // and a chip beside it ("Buy" and a price chip's "49,00 €" or
          // "CHF 49.00").
          const inWord = /\p{L}$/u.test(words[words.length - 1] ?? '') && /^\p{Ll}/u.test(piece);
          if (
            last !== null &&
            last.block === block &&
            !last.spaced &&
            !/^\s/.test(data) &&
            touching(
              last.end,
              rects[0],
              style,
              last.tracking,
              // Where a highlight ends between the two, or one begins.
              inWord ? ended(last.marks, marks) : null,
              inWord ? begun(last.marks, marks) : null,
            )
          ) {
            words[words.length - 1] += piece;
          } else {
            words.push(piece);
          }
          last = {
            block,
            end: rects[rects.length - 1],
            spaced: count < text.length || /\s$/.test(data),
            tracking: Math.max(0, parseFloat(style.letterSpacing) || 0),
            marks,
          };
        }
        if (shown > limit) {
          return { length: shown, text: words.join(' ') };
        }
      }
      continue;
    }
    if (type !== 1) {
      continue;
    }
    const tag = String(localNameOf.call(node));
    const own = unread.has(tag) ? null : getComputedStyle(node as Element);
    if (!own || own.display === 'none') {
      continue;
    }
    let inner = clip;
    if (own.display !== 'contents') {
      const path = own.clipPath || 'none';
      if (
        (typeof checkVisibility === 'function' && !checkVisibility.call(node)) ||
        parseFloat(own.opacity) === 0 ||
        clippedAway(path, node as Element) ||
        (shows(own.clip, 'auto') && /^(absolute|fixed)$/.test(own.position))
      ) {
        continue;
      }
      if (node !== element && (clips(own) || path !== 'none')) {
        inner = meet(clip, getBoundingClientRect.call(node));
        if (areaOf(inner) <= 0) {
          continue;
        }
      }
    }
    // The text of a box set in a line -- inline, or an inline block, flex or
    // grid ("Pay" and "Pal" in two inline blocks of one wordmark) -- runs on
    // with what is around it as it is drawn; any other box's is a block of
    // its own. A highlight goes on through inline boxes, not into a box of
    // its own.
    const inLine = own.display === 'contents' || /^(inline|ruby)/.test(own.display);
    const within = node === element || inLine ? block : node;
    const marksWithin =
      node === element || !/^(inline|contents)$/.test(own.display)
        ? []
        : own.display === 'inline' && boxedIn(own)
          ? [...marks, node as Element]
          : marks;
    // What a box skips drawing (content-visibility: hidden, as a section
    // hidden until found is) shows nothing, nor does a closed <details> past
    // its summary.
    if (own.contentVisibility === 'hidden') {
      continue;
    }
    const shut =
      tag === 'details' &&
      !(typeof hasAttributeOf === 'function' ? hasAttributeOf.call(node as Element, 'open') : true);
    const shadow = shadowRootOf ? (shadowRootOf.call(node) as ShadowRoot | null) : null;
    const assigned = tag === 'slot' && assignedNodesOf ? assignedNodesOf.call(node) : [];
    const children = Array.from(
      (shadow
        ? childNodesOf.call(shadow)
        : assigned.length > 0
          ? assigned
          : childNodesOf.call(node)) as ArrayLike<Node>,
    ).filter(
      (child) =>
        !shut || (nodeTypeOf.call(child) === 1 && String(localNameOf.call(child)) === 'summary'),
    );
    for (let index = children.length - 1; index >= 0; index -= 1) {
      pending.push({
        node: children[index],
        clip: inner,
        style: own,
        block: within,
        marks: marksWithin,
      });
    }
  }
  // Past as many nodes as are walked, what is shown cannot be told.
  return pending.length > 0 ? null : { length: shown, text: words.join(' ') };
}

/**
 * What is around an element once its events leave the shadow trees it sits in,
 * climbing as they bubble: parent by parent, from a slotted element to its
 * slot, from a shadow tree's top to its host.
 *
 * Read for what a click on a control that says what it is goes on to
 * (`onward`): only what is outside the control's own tree -- XPath reads that
 * -- and of that only what takes the click: the controls met, and the boxes
 * with a pointer handler that draw 80 characters or fewer ("Buy now $49.00" on
 * a component that buys on a click, or on the box a slot puts the control in).
 * Otherwise, for an element that says nothing: the words of the first control
 * met, and of the largest wrapper short enough to be a label (80 characters),
 * with the name of the first one past that.
 *
 * What a wrapper draws is its text and that of the shadow trees in it -- open
 * ones read through, closed ones it was climbed out of -- which no host's text
 * holds, without the style sheets and scripts a component keeps. A wrapper is
 * short when that text is, or when what it shows where it can be seen is
 * (`shownIn`: a box's "Buy now $49.00" beside a description for screen
 * readers) -- and then what it shows is read first. From a slot (`fromSlot`)
 * the read goes on through the slot's own tree, which the element slotted
 * into it is not in. Exported for its own tests; in use it runs inside the
 * page, by evaluate (wordsAroundInPage), or in the check's own world from a
 * slot of a closed tree, so it calls nothing of this module's.
 */
export function wordsAroundAcrossShadowTrees(
  element: Element,
  onward = false,
  shownIn: (node: Element, limit: number) => { length: number; text: string } | null = shownTextIn,
  fromSlot = false,
): string {
  const control =
    'button, a[href], label, summary, select, option, input[type="submit"], input[type="image"], ' +
    'input[type="button"], input[type="reset"], input[type="checkbox"], input[type="radio"], ' +
    '[role="button"], [role="link"], [role="menuitem"], [role="option"], [role="tab"], ' +
    '[role="checkbox"], [role="radio"], [role="switch"]';
  const pointer =
    '[onclick], [onmousedown], [onmouseup], [onpointerdown], [onpointerup], [ontouchstart], ' +
    '[ontouchend]';
  // Every read goes through the prototypes. The climb passes forms -- a page
  // wrapped in one, as ASP.NET builds them -- and a form's named controls
  // stand in for its own properties: <img name="matches"> would be its
  // "matches". Markup cannot change a prototype.
  const parentNodeOf = Object.getOwnPropertyDescriptor(Node.prototype, 'parentNode')?.get;
  const parentElementOf = Object.getOwnPropertyDescriptor(Node.prototype, 'parentElement')?.get;
  const nodeTypeOf = Object.getOwnPropertyDescriptor(Node.prototype, 'nodeType')?.get;
  const textContentOf = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent')?.get;
  const hostOf = Object.getOwnPropertyDescriptor(ShadowRoot.prototype, 'host')?.get;
  const innerTextOf = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'innerText')?.get;
  const childNodesOf = Object.getOwnPropertyDescriptor(Node.prototype, 'childNodes')?.get;
  const localNameOf = Object.getOwnPropertyDescriptor(Element.prototype, 'localName')?.get;
  const shadowRootOf = Object.getOwnPropertyDescriptor(Element.prototype, 'shadowRoot')?.get;
  const assignedSlotOf = Object.getOwnPropertyDescriptor(Element.prototype, 'assignedSlot')?.get;
  const assignedNodesOf =
    typeof HTMLSlotElement === 'function' ? HTMLSlotElement.prototype.assignedNodes : undefined;
  const { getAttribute, matches } = Element.prototype;
  const { getRootNode } = Node.prototype;
  if (
    !parentNodeOf ||
    !parentElementOf ||
    !nodeTypeOf ||
    !textContentOf ||
    !hostOf ||
    !childNodesOf ||
    !localNameOf
  ) {
    return '';
  }
  const shownBy = (node: Node): string =>
    String(
      (innerTextOf && Object.prototype.isPrototypeOf.call(HTMLElement.prototype, node)
        ? innerTextOf.call(node)
        : textContentOf.call(node)) ?? '',
    );
  const unseen = new Set(['style', 'script', 'template', 'noscript', 'link', 'meta']);
  const childrenOf = (node: Node): Node[] =>
    Array.from(childNodesOf.call(node) as NodeListOf<ChildNode>);
  // An element the browser does not draw, nor anything in it: innerText of
  // one is all of its text -- a submenu a component keeps in a hidden panel,
  // a tooltip's content waiting in a slot of a hidden box. One of no box of
  // its own (display: contents, a slot) is drawn where what it holds is.
  const { checkVisibility } = Element.prototype;
  const undrawn = (node: Element): boolean =>
    typeof checkVisibility === 'function' &&
    !checkVisibility.call(node) &&
    getComputedStyle(node).display !== 'contents';
  // What a node draws: a text where it sits, an element of no box of its own
  // by what its children draw.
  const drawnTextOf = (node: Node, depth: number): string => {
    const type = nodeTypeOf.call(node);
    if (type === 3) {
      return String(textContentOf.call(node) ?? '');
    }
    if (type !== 1 || unseen.has(String(localNameOf.call(node))) || undrawn(node as Element)) {
      return '';
    }
    if (getComputedStyle(node as Element).display === 'contents') {
      return depth < 16
        ? childrenOf(node)
            .map((child) => drawnTextOf(child, depth + 1))
            .join(' ')
        : '';
    }
    return shownBy(node);
  };
  // What the open shadow trees in a node draw, nested ones too, and what its
  // slots draw of what the page puts in them (a "Buy now $49.00" a component
  // slots in beside a field) -- as far as a walk of so many nodes reaches, and
  // not into what is not drawn.
  const shadowsIn = (node: Node, parts: string[], budget: { left: number }): void => {
    const pending: Node[] = [node];
    while (pending.length > 0 && budget.left > 0) {
      const next = pending.pop() as Node;
      budget.left -= 1;
      if (nodeTypeOf.call(next) !== 1 || undrawn(next as Element)) {
        continue;
      }
      if (assignedNodesOf && String(localNameOf.call(next)) === 'slot') {
        const assigned = assignedNodesOf.call(next as HTMLSlotElement, { flatten: true });
        for (const one of Array.from(assigned).slice(0, 64)) {
          parts.push(drawnTextOf(one, 0).slice(0, 2_000));
        }
      }
      const shadow = shadowRootOf ? (shadowRootOf.call(next) as ShadowRoot | null) : null;
      if (shadow) {
        parts.push(drawnIn(shadow, budget));
      }
      for (const child of childrenOf(next)) {
        if (nodeTypeOf.call(child) === 1) {
          pending.push(child);
        }
      }
    }
  };
  // What a shadow tree draws: its text, its elements', and the trees in them.
  const drawnIn = (root: Node, budget: { left: number }): string => {
    const parts: string[] = [];
    for (const child of childrenOf(root)) {
      const type = nodeTypeOf.call(child);
      if (type === 3) {
        parts.push(String(textContentOf.call(child) ?? ''));
      } else if (
        type === 1 &&
        !unseen.has(String(localNameOf.call(child))) &&
        !undrawn(child as Element)
      ) {
        parts.push(drawnTextOf(child, 0));
        shadowsIn(child, parts, budget);
      }
    }
    return parts.join(' ');
  };
  // What a wrapper draws, the closed trees it was climbed out of included.
  let closedBelow = '';
  const drawnBy = (node: Node): string => {
    const parts = [shownBy(node)];
    shadowsIn(node, parts, { left: 2_000 });
    return `${parts.join(' ')} ${closedBelow}`.replace(/\s+/g, ' ').trim();
  };
  // What a wrapper draws, if 80 characters or fewer: by its text, or by what
  // it shows where it can be seen -- read first, as a long text's head and
  // tail may leave it out, and as it is drawn: words the page sets apart that
  // its text runs on ("Buy" and "49,00 €" in two inline boxes a margin apart)
  // are read apart. Null for a wrapper longer than that.
  const short = (node: Element, text: string): string | null => {
    let shown: { length: number; text: string } | null = null;
    try {
      shown = shownIn(node, 80);
    } catch {
      shown = null;
    }
    const drawn = shown !== null && shown.length <= 80 ? shown.text : null;
    if (text.length <= 80) {
      return drawn ? `${drawn} ${text}` : text;
    }
    return drawn !== null ? `${drawn} ${text}` : null;
  };
  const own = getRootNode.call(element);
  const words: string[] = [];
  let label = '';
  let controlRead = false;
  let node: Element = element;
  for (let level = 0; level < 64; level += 1) {
    const slot = assignedSlotOf ? (assignedSlotOf.call(node) as Element | null) : null;
    const parent = parentNodeOf.call(node) as Node | null;
    const root = !slot && parent && nodeTypeOf.call(parent) === 11 ? parent : null;
    const next =
      slot ??
      (parentElementOf.call(node) as Element | null) ??
      (root ? (hostOf.call(root) as Element) : null);
    if (!next) {
      break;
    }
    if (root && (!shadowRootOf || shadowRootOf.call(next) !== root)) {
      // A closed tree: no read from its host goes into it.
      closedBelow = `${drawnIn(root, { left: 2_000 })} ${closedBelow}`;
    }
    node = next;
    const name = [getAttribute.call(node, 'aria-label'), getAttribute.call(node, 'title')]
      .filter(Boolean)
      .join(' ');
    if (onward) {
      if (getRootNode.call(node) === own && !fromSlot) {
        continue;
      }
      const isControl = matches.call(node, control);
      const takesClicks =
        matches.call(node, pointer) && !['body', 'html'].includes(String(localNameOf.call(node)));
      if (!isControl && !takesClicks) {
        continue;
      }
      const text = drawnBy(node);
      const box = takesClicks ? short(node, text) : null;
      if (isControl && !controlRead) {
        controlRead = true;
        words.push(text.slice(0, 300), name);
      } else if (box !== null) {
        words.push(box, name);
      }
      continue;
    }
    const text = drawnBy(node);
    if (!controlRead && matches.call(node, control)) {
      controlRead = true;
      words.push(text.slice(0, 300), name);
    }
    const labelled = short(node, text);
    if (labelled === null) {
      words.push(name);
      break;
    }
    label = `${labelled} ${name}`;
  }
  words.push(label);
  return words.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().slice(0, 600);
}

// The read above and the measure it takes of what a wrapper shows, as one
// function for the page to run: evaluate sends a function's own text, and
// nothing of what it calls.
export const wordsAroundInPage = new Function(
  'element',
  'onward',
  `return (${wordsAroundAcrossShadowTrees})(element, onward, ${shownTextIn});`,
) as (element: Element, onward: boolean) => string;

// How long anything the page itself runs is waited for. Playwright's timeout
// for an evaluation covers finding the element, not the call: a page can make
// one never return -- answer it with a promise that never settles, or keep its
// thread busy -- and the act would wait with it, unbounded.
const PAGE_CALL_DEADLINE_MS = 3_000;

function withinDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          Object.assign(new Error('the page did not answer in time'), { name: 'TimeoutError' }),
        ),
      ms,
    );
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

// The roles of what a click on something inside goes on to: a control, a link,
// an item of a menu or a list.
const ACTIVATED_ROLES: ReadonlySet<string> = new Set([
  'button',
  'link',
  'checkbox',
  'radio',
  'switch',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'option',
  'treeitem',
  'gridcell',
  'combobox',
  'listbox',
  'slider',
  'spinbutton',
]);
// What the hit node says of itself in its attributes: an image map area's or an
// image's alt, a title, a name.
const AIMED_ATTRIBUTES: readonly string[] = ['alt', 'title', 'aria-label'];
// How much of one name is read, at each end -- a link around a whole card is
// named by all of it -- and of all the words.
const MAX_AIMED_NAME_CHARS = 300;
const MAX_AIMED_WORDS_CHARS = 4_000;
// How many frames deep a hit is followed back out to the top document.
const MAX_AIM_FRAME_DEPTH = 4;
// A hit holding more than this many children is a container the click lands on
// the bare face of: what is in it is not where the click lands.
const MAX_AIMED_CHILDREN = 50;
const AIM_OBJECT_GROUP = 'aoi-aim-point';
// The pieces of a text line by line, which say again what the text says.
const INLINE_TEXT_BOX = 'InlineTextBox';

interface AoiAxNode {
  nodeId: string;
  ignored?: boolean;
  role?: { value?: unknown };
  name?: { value?: unknown };
  parentId?: string;
  childIds?: string[];
  backendDOMNodeId?: number;
}

interface AoiAxTree {
  nodes?: AoiAxNode[];
}

interface AoiCdpSession {
  send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  detach?(): Promise<void>;
}

// A node of the tree and those around it, nearest first: never more than the
// tree holds, however its parents point.
function axNodeAndAncestors(tree: AoiAxTree, backendNodeId: number): AoiAxNode[] {
  const nodes = Array.isArray(tree.nodes) ? tree.nodes : [];
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const chain: AoiAxNode[] = [];
  let node = nodes.find((candidate) => candidate.backendDOMNodeId === backendNodeId);
  while (node && !chain.includes(node)) {
    chain.push(node);
    node = node.parentId ? byId.get(node.parentId) : undefined;
  }
  return chain;
}

function axNameOf(node: AoiAxNode | undefined): string {
  return node && !node.ignored && typeof node.name?.value === 'string' ? node.name.value : '';
}

/**
 * Words for what the browser says is where a click lands, from the hit node and
 * the accessibility tree around it: the node's own name, what the tree under
 * it holds (`held`: its text and whatever in it has a name -- images, controls,
 * a box an aria-label names), every control around it a click on it goes on
 * to, and what its attributes say. Exported for its own tests.
 */
// The letters of words, without their spacing or case.
function lettersOf(words: string): string {
  return words.replace(/\s+/g, '').toLowerCase();
}

// What the browser names at a click's point, and what the hit draws -- unless
// the names already hold every letter of it: then it is a part of them, read
// in them.
export function aimedWordsWith(named: string, drawn: string): string {
  const own = lettersOf(drawn);
  return [named, own !== '' && lettersOf(named).includes(own) ? '' : drawn]
    .filter(Boolean)
    .join(' ');
}

export function wordsOfAimedNode(
  tree: AoiAxTree,
  backendNodeId: number,
  attributes: string[],
  held: AoiAxTree = {},
  runsOn = '',
): string {
  const [self, ...around] = axNodeAndAncestors(tree, backendNodeId);
  // The names of the hit and of the controls around it. What the hit holds,
  // taken whole, that one of them already says -- a wordmark's "Pay" and
  // "Pal" in the button named "Log in with PayPal", the "Pay" a search
  // highlights in the link "Payment methods we accept" -- is read there, run
  // on as the browser names it, and not again in pieces; and so is the hit's
  // own name, when it is part of a control's around it. Only whole: a piece
  // that a name holds by chance ("now" of "Pay now" in "Buy now") still
  // stands beside the others it is read with. Its text is what is held
  // whole: what in it has a name of its own -- a heading the text is in, an
  // image -- says it beside. A hit that is a piece of text and nothing else
  // -- no name, nothing named in it: the "pay" a search highlights in "My
  // payments" -- says the word it runs on into as it is drawn (`runsOn`).
  const selfName = self ? axNameOf(self) : '';
  const aroundNames = self
    ? around
        .filter(
          (node) => typeof node.role?.value === 'string' && ACTIVATED_ROLES.has(node.role.value),
        )
        .map(axNameOf)
    : [];
  const holds: string[] = [];
  const texts: string[] = [];
  const names: string[] = [];
  for (const node of Array.isArray(held.nodes) ? held.nodes : []) {
    if (node.backendDOMNodeId === backendNodeId) {
      // Its own name is read once, off the tree around it.
      continue;
    }
    const role = typeof node.role?.value === 'string' ? node.role.value : '';
    if (role === 'StaticText' && typeof node.name?.value === 'string') {
      holds.push(node.name.value);
      texts.push(node.name.value);
    } else if (role !== INLINE_TEXT_BOX) {
      const name = axNameOf(node);
      holds.push(name);
      names.push(name);
    }
  }
  const aroundLetters = aroundNames.map(lettersOf).filter(Boolean);
  const inANameOf = (letters: string, names: string[]) =>
    letters !== '' && names.some((name) => name.includes(letters));
  const piece = runsOn !== '' && selfName === '' && names.every((name) => name.trim() === '');
  const words = inANameOf(lettersOf(texts.join('')), [lettersOf(selfName), ...aroundLetters])
    ? names
    : piece
      ? [runsOn]
      : holds;
  if (self) {
    words.unshift(inANameOf(lettersOf(selfName), aroundLetters) ? '' : selfName);
    words.push(...aroundNames);
  }
  const named = new Map<string, string>();
  for (let index = 0; index + 1 < attributes.length; index += 2) {
    named.set(String(attributes[index]).toLowerCase(), String(attributes[index + 1]));
  }
  words.push(...AIMED_ATTRIBUTES.map((name) => named.get(name) ?? ''));
  return words
    .map((word) => word.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map((word) =>
      word.length <= 2 * MAX_AIMED_NAME_CHARS
        ? word
        : `${word.slice(0, MAX_AIMED_NAME_CHARS)} ${word.slice(-MAX_AIMED_NAME_CHARS)}`,
    )
    .join(' ')
    .slice(0, MAX_AIMED_WORDS_CHARS);
}

/**
 * What the browser's accessibility tree says is under a node: its text and the
 * names of what in it has one -- images, controls, a box an aria-label names --
 * closed shadow trees included; not the node's own name (the browser makes one
 * up for a nameless submit button) -- and of those, its text alone and the
 * names alone. With how many frames it holds, whose documents are not in that
 * tree. Exported for its own tests.
 */
export function wordsHeldBy(
  tree: AoiAxTree,
  backendNodeId: number,
): { words: string; text: string; names: string; frames: number } {
  const words: string[] = [];
  const texts: string[] = [];
  const names: string[] = [];
  let frames = 0;
  for (const node of Array.isArray(tree.nodes) ? tree.nodes : []) {
    const role = typeof node.role?.value === 'string' ? node.role.value : '';
    if (/iframe|embeddedobject|pluginobject/i.test(role)) {
      frames += 1;
    }
    if (node.backendDOMNodeId === backendNodeId) {
      continue;
    }
    if (role === 'StaticText' && typeof node.name?.value === 'string') {
      words.push(node.name.value);
      texts.push(node.name.value);
    } else if (role !== INLINE_TEXT_BOX) {
      // Whatever else in it has a name says it: an image, a control, a box an
      // aria-label names (the way text split letter by letter is named).
      const name = axNameOf(node);
      words.push(name);
      names.push(name);
    }
  }
  const tidy = (parts: string[]) =>
    parts
      .map((word) => word.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .map((word) =>
        word.length <= 2 * MAX_AIMED_NAME_CHARS
          ? word
          : `${word.slice(0, MAX_AIMED_NAME_CHARS)} ${word.slice(-MAX_AIMED_NAME_CHARS)}`,
      )
      .join(' ')
      .slice(0, MAX_AIMED_WORDS_CHARS);
  return { words: tidy(words), text: tidy(texts), names: tidy(names), frames };
}

const FRAME_NODES: ReadonlySet<string> = new Set(['IFRAME', 'FRAME']);
const EMBEDDED_NODES: ReadonlySet<string> = new Set(['OBJECT', 'EMBED', 'FENCEDFRAME', 'PORTAL']);
// A node as the DevTools protocol describes it, shadow trees and all.
interface AoiDomNode {
  nodeType?: number;
  nodeName?: string;
  backendNodeId?: number;
  // A frame element's frame, whose document the description holds when it is
  // one of the page's own process.
  frameId?: string;
  children?: AoiDomNode[];
  shadowRoots?: (AoiDomNode & { shadowRootType?: string })[];
  contentDocument?: AoiDomNode;
}

// How long the accessibility tree's read-out of an element is waited for.
const AX_READ_DEADLINE_MS = 1_000;

// An element among more children than this makes the browser take seconds over
// its accessibility tree -- every time it is asked, with the page frozen
// meanwhile (a hundred thousand elements side by side in a body: 7.5 s a
// read). There, what is drawn is read off the DOM alone.
const MAX_AX_CHILDREN = 2_000;

// Whether the element `selector` names, or one around it, holds that many
// children: counted in Playwright's isolated world, out of the page's reach.
async function axIsSlowFor(
  tab: Record<string, unknown>,
  selector: string,
  timeout: number,
): Promise<boolean> {
  const locate = tab.locator as (s: string) => { count(): Promise<number> };
  try {
    const crowded = await withinDeadline(
      locate
        .call(tab, `${selector} >> xpath=ancestor-or-self::*[count(*) > ${MAX_AX_CHILDREN}]`)
        .count(),
      timeout,
    );
    return crowded > 0;
  } catch {
    return true;
  }
}

// A read of the accessibility tree: on a protocol session of its own and soon,
// or not at all. A page can make the browser take seconds over that tree (a
// hundred thousand elements side by side), and every other read on the session
// it is asked on waits behind it.
function axRead(
  ax: AoiCdpSession,
  method: string,
  params: Record<string, unknown>,
): Promise<AoiAxTree> {
  return withinDeadline(ax.send(method, params), AX_READ_DEADLINE_MS).then(
    (tree) => tree as AoiAxTree,
    () => ({}),
  );
}

// The isolated world of the check's own in a session's top frame: no page script
// reaches it, so what it asks is answered by the browser itself -- prototypes
// and all as the browser made them, whatever the page did to its own. It may
// read a frame of the page's own process from another origin of the same site.
const CHECK_WORLD = '__aoi_drawn_check__';
const CHECK_OBJECT_GROUP = 'aoi-check-world';

// The check's own world in a frame of a session -- its top frame unless one is
// named -- or null when there is none.
async function checkWorldOf(cdp: AoiCdpSession, frame?: string): Promise<number | null> {
  try {
    const { frameTree } = frame
      ? { frameTree: { frame: { id: frame as unknown } } }
      : ((await cdp.send('Page.getFrameTree')) as {
          frameTree?: { frame?: { id?: unknown } };
        });
    const frameId = frameTree?.frame?.id;
    if (typeof frameId !== 'string') {
      return null;
    }
    const { executionContextId } = (await cdp.send('Page.createIsolatedWorld', {
      frameId,
      worldName: CHECK_WORLD,
      grantUniveralAccess: true,
    })) as { executionContextId?: unknown };
    return typeof executionContextId === 'number' ? executionContextId : null;
  } catch {
    return null;
  }
}

// How wide and tall a session's top frame's window is, as its own world says.
async function windowSizeOf(cdp: AoiCdpSession): Promise<{ width: number; height: number } | null> {
  const contextId = await checkWorldOf(cdp);
  if (contextId === null) {
    return null;
  }
  try {
    const answer = (await cdp.send('Runtime.evaluate', {
      expression: '[innerWidth, innerHeight]',
      contextId,
      returnByValue: true,
    })) as { result?: { value?: unknown } };
    const size = answer.result?.value;
    return Array.isArray(size) &&
      size.length === 2 &&
      size.every((side) => typeof side === 'number' && side > 0)
      ? { width: size[0] as number, height: size[1] as number }
      : null;
  } catch {
    return null;
  }
}

/**
 * Runs `functionDeclaration` in the check's own world on the node `self`, with
 * the nodes `args` as its arguments -- in the frame `frame`, when the nodes are
 * in a frame of the page's own -- and gives back what it returns. Undefined
 * when it cannot: no top frame or world to run it in, a node that cannot be
 * had there, a call that fails.
 */
async function inCheckWorld(
  cdp: AoiCdpSession,
  self: number,
  args: number[],
  functionDeclaration: string,
  frame?: string,
): Promise<unknown> {
  const executionContextId = await checkWorldOf(cdp, frame);
  if (executionContextId === null) {
    return undefined;
  }
  const group = `${CHECK_OBJECT_GROUP}-${Math.random().toString(36).slice(2)}`;
  try {
    const objects = await Promise.all(
      [self, ...args].map((backendNodeId) =>
        cdp.send('DOM.resolveNode', { backendNodeId, executionContextId, objectGroup: group }).then(
          (resolved) => (resolved as { object?: { objectId?: unknown } }).object?.objectId,
          () => undefined,
        ),
      ),
    );
    if (objects.some((objectId) => typeof objectId !== 'string')) {
      return undefined;
    }
    const [own, ...rest] = objects as string[];
    const answer = (await cdp.send('Runtime.callFunctionOn', {
      objectId: own,
      functionDeclaration,
      arguments: rest.map((objectId) => ({ objectId })),
      returnByValue: true,
    })) as { result?: { value?: unknown }; exceptionDetails?: unknown };
    return answer.exceptionDetails ? undefined : answer.result?.value;
  } catch {
    return undefined;
  } finally {
    cdp.send('Runtime.releaseObjectGroup', { objectGroup: group }).catch(() => {});
  }
}

// How many nodes under an element are read for what it draws, and how many
// closed shadow trees it may hold: past those, all it draws cannot be told.
const MAX_DRAWN_NODES = 20_000;
const MAX_CLOSED_ROOTS = 1_000;
// How much of what an element draws is read, at its start and at its end, and
// of what its elements say in their attributes.
const MAX_DRAWN_CHARS = 2_000;
const MAX_DRAWN_SAID_CHARS = 1_000;

// How many frames' documents under an element are read for what they draw.
const MAX_FRAMES_DRAWN = 5;
// More than what a form's owner read ever gives: its buttons' few words (16,000
// characters of them), its names, and its text by its start and its end. And
// what it throws when the form holds more than it reads.
const MAX_FORM_OWNER_WORDS_CHARS = 24_000;
const FORM_TOO_LARGE = 'the form is too large to read through';

/**
 * The closed shadow trees under a node as the protocol describes it -- the only
 * way to them a script has, since none can open one -- and how many nodes it
 * holds, counted no further than MAX_DRAWN_NODES; and the documents of the
 * page's own frames under it (as many as are read), each with its frame and
 * its own closed shadow trees: a frame of another origin of the same site is
 * one of the page's own process, read in its own world. The node's own tree
 * is walked whole first, and each frame's after it on a budget of its own: a
 * large frame beside a pay button in a closed tree does not use up the walk
 * before the button's tree is reached. Exported for its own tests.
 */
export function closedRootsUnder(root: AoiDomNode | undefined): {
  closed: number[];
  nodes: number;
  frames: { frameId: string; root: number; closed: number[] }[];
} {
  const frames: { frameId: string; root: number; closed: number[] }[] = [];
  const documents: { document: AoiDomNode; closed: number[] }[] = [];
  // How many nodes a walk counts; past MAX_DRAWN_NODES the read is not whole.
  const walk = (start: AoiDomNode | undefined, closed: number[]): number => {
    let nodes = 0;
    const pending: (AoiDomNode | undefined)[] = [start];
    while (pending.length > 0 && nodes <= MAX_DRAWN_NODES) {
      const node = pending.pop();
      if (!node || typeof node !== 'object') {
        continue;
      }
      nodes += 1;
      for (const shadowRoot of Array.isArray(node.shadowRoots) ? node.shadowRoots : []) {
        if (
          shadowRoot?.shadowRootType === 'closed' &&
          typeof shadowRoot.backendNodeId === 'number'
        ) {
          closed.push(shadowRoot.backendNodeId);
        }
        pending.push(shadowRoot);
      }
      for (const child of Array.isArray(node.children) ? node.children : []) {
        pending.push(child);
      }
      const document = node.contentDocument;
      if (document && typeof node.frameId === 'string' && frames.length < MAX_FRAMES_DRAWN) {
        const element = (Array.isArray(document.children) ? document.children : []).find(
          (child) => child?.nodeType === 1 && typeof child.backendNodeId === 'number',
        );
        if (element) {
          const frame = {
            frameId: node.frameId,
            root: element.backendNodeId as number,
            closed: [],
          };
          frames.push(frame);
          documents.push({ document, closed: frame.closed });
        }
      }
    }
    return nodes;
  };
  const closed: number[] = [];
  const nodes = walk(root, closed);
  // Frames found in frames are read in theirs as well, up to as many as are.
  for (let index = 0; index < documents.length; index += 1) {
    walk(documents[index].document, documents[index].closed);
  }
  return { closed, nodes, frames };
}

// What the browser draws under the element it runs on, read in the check's own
// world the way the browser lays it out: through shadow trees (the closed ones
// it is handed) and slots, with what CSS draws before and after an element --
// its strings, not its images' addresses -- and every frame counted (what a
// frame of the page's own holds is read in that frame's own world); not what is not drawn at all -- display:none, a
// skipped section (content-visibility, hidden=until-found, a closed
// <details>), visibility:hidden -- and aria-hidden or not, since what a page
// hides from a screen reader is drawn, and clicked, all the same. Inline text
// runs on as it is drawn ("B"+"uy" is "Buy"); blocks and lines are set apart,
// and inline boxes too in a second reading ("Pay" and "now" a margin apart). An
// <object> or <embed> of an image is an image. What
// elements say in their attributes is read too: an alt, an aria-label, a
// title, a button input's value, a select's choice.
const DRAWN_TEXT = `function (...closedRoots) {
  const shadowOf = new Map();
  for (const root of closedRoots) {
    if (root && root.host) {
      shadowOf.set(root.host, root);
    }
  }
  // The text as it is drawn -- inline runs on, blocks and lines set apart --
  // and again with a run of text set apart from the run before it wherever the
  // browser draws the two apart: on two lines, or on one by more than a sixth
  // of the letters' size -- "Pay" and "now" in two boxes a margin, a width, a
  // shift or an icon apart read "Paynow" the first way. Runs that touch draw
  // one word ("Pay" and "Pal" in two colours of one wordmark), and runs a space
  // apart say so themselves.
  const parts = [];
  const spaced = [];
  const both = (text) => {
    parts.push(text);
    spaced.push(text);
  };
  // The last text drawn, while only inline runs have come after it, and how
  // many pairs of runs have been measured: each is a look at the page's
  // layout, and past 2,000 the rest are read as they run on.
  let lastRun = null;
  let lastMarks = [];
  let measured = 0;
  // A run's box ends past the spacing its last letter is set with: "Pay" set
  // 4px apart letter by letter ends 4px past its "y", and that much apart from
  // a "now" that touches its box.
  let lastTracking = 0;
  const boxOf = (text, last) => {
    const range = document.createRange();
    range.selectNodeContents(text);
    const rects = range.getClientRects();
    return rects.length > 0 ? rects[last ? rects.length - 1 : 0] : null;
  };
  const edgeOf = (box, last) => {
    const rects = box.getClientRects();
    return rects.length > 0 ? rects[last ? rects.length - 1 : 0] : null;
  };
  // An inline box that draws a box around its text: a background or a border.
  const clear = (color) =>
    !color || color === 'transparent' || /^rgba\\(.*,\\s*0\\)$/.test(color);
  const boxedIn = (style) =>
    !clear(style.backgroundColor) ||
    (style.backgroundImage && style.backgroundImage !== 'none') ||
    ['Top', 'Right', 'Bottom', 'Left'].some(
      (side) =>
        parseFloat(style['border' + side + 'Width']) > 0 &&
        !/^(none|hidden)$/.test(style['border' + side + 'Style'] || 'none') &&
        !clear(style['border' + side + 'Color']),
    );
  // A run of text drawn, with the highlights it is in (\`marks\`, the
  // innermost last: the inline boxes around it, in its line, that draw a box).
  const drawn = (text, style, marks) => {
    if (
      lastRun &&
      measured < 2000 &&
      lastRun.data.slice(-1).trim() !== '' &&
      text.data.slice(0, 1).trim() !== ''
    ) {
      measured += 1;
      const before = boxOf(lastRun, true);
      const after = boxOf(text, false);
      if (before && after) {
        // Along the line and across it, by how the runs are written: on two
        // lines when their middles are further apart than half the smaller
        // run's size -- line boxes overlap at a tight line height -- and apart
        // on one by more than a sixth of it: the size drawn, scaled or not,
        // the smaller of two sizes. A highlight around a run -- a search's
        // <mark> with a background and padding -- ends where its box does, as
        // far as a third of the letters' size past them: "Pay" in it and the
        // "ment" that touches the box are one word.
        const vertical = /^(vertical|sideways)/.test((style && style.writingMode) || '');
        const sizeOf = (box) => (vertical ? box.right - box.left : box.bottom - box.top);
        const size =
          Math.min(sizeOf(before), sizeOf(after)) || parseFloat(style && style.fontSize) || 16;
        const across = vertical
          ? Math.abs(before.left + before.right - after.left - after.right) / 2
          : Math.abs(before.top + before.bottom - after.top - after.bottom) / 2;
        const alongOf = (one, next) =>
          vertical
            ? Math.max(next.top - one.bottom, one.top - next.bottom)
            : Math.max(next.left - one.right, one.left - next.right);
        const along = alongOf(before, after);
        // Only in a word: a letter before, the word going on in lower case
        // after ("Pay" and "ment", not "Buy" and a price chip's "49,00 €" or
        // "CHF 49.00"), at a highlight that holds a piece of a word -- letters
        // alone, not a chip of its own ("NEW").
        const inWord = /\\p{L}$/u.test(lastRun.data) && /^\\p{Ll}/u.test(text.data);
        const pieceOfWord = (mark) => {
          const held = (mark.textContent || '').trim();
          return /^\\p{L}+$/u.test(held) && !/^\\p{Lu}{2,}$/u.test(held);
        };
        const ended = inWord ? lastMarks[lastMarks.length - 1] : null;
        const begun = inWord ? marks[marks.length - 1] : null;
        const beforeBox =
          ended && !marks.includes(ended) && pieceOfWord(ended) ? edgeOf(ended, true) : null;
        const afterBox =
          begun && !lastMarks.includes(begun) && pieceOfWord(begun) ? edgeOf(begun, false) : null;
        const boxed = (box, gap) => (box ? Math.max(gap, along - size / 3) : along);
        const nearest = Math.min(
          along,
          boxed(beforeBox, beforeBox && alongOf(beforeBox, after)),
          boxed(afterBox, afterBox && alongOf(before, afterBox)),
        );
        if (across > size / 2 || nearest + lastTracking > size / 6) {
          spaced.push(' ');
        }
      }
    }
    lastRun = text;
    lastMarks = marks;
    lastTracking = Math.max(0, parseFloat(style && style.letterSpacing) || 0);
    both(text.data);
  };
  const said = [];
  let frames = 0;
  let visited = 0;
  let whole = true;
  // An <object> or <embed> of an image is an image.
  const IMAGE_FILE = /\\.(svg|png|gif|jpe?g|webp|avif|bmp|ico)(?:[?#]|$)/i;
  const isImage = (node) =>
    /^image\\//i.test(node.getAttribute('type') || '') ||
    IMAGE_FILE.test(node.getAttribute('data') || node.getAttribute('src') || '');
  // What CSS draws as text is its strings -- not the addresses of the images it
  // draws ("checkout-bag.svg").
  const IMAGES =
    /(?:-webkit-)?(?:url|image-set|image|cross-fade|element|paint|(?:repeating-)?(?:linear|radial|conic)-gradient)\\((?:"(?:[^"\\\\]|\\\\[\\s\\S])*"|'(?:[^'\\\\]|\\\\[\\s\\S])*'|[^()"']|\\((?:"(?:[^"\\\\]|\\\\[\\s\\S])*"|'(?:[^'\\\\]|\\\\[\\s\\S])*'|[^()"'])*\\))*\\)/gi;
  const quoted = (content) => {
    const strings = [];
    const pattern = /"((?:[^"\\\\]|\\\\[\\s\\S])*)"|'((?:[^'\\\\]|\\\\[\\s\\S])*)'/g;
    const text = content.replace(IMAGES, ' ');
    let match;
    while ((match = pattern.exec(text))) {
      const raw = match[1] !== undefined ? match[1] : match[2];
      strings.push(
        raw.replace(/\\\\([0-9a-fA-F]{1,6}) ?|\\\\([\\s\\S])/g, (_, hex, char) =>
          hex ? String.fromCodePoint(parseInt(hex, 16)) : char,
        ),
      );
    }
    return strings.join('');
  };
  const pseudo = (element, which) => {
    const style = getComputedStyle(element, which);
    if (style.display === 'none' || style.visibility !== 'visible') {
      return;
    }
    const content = style.content;
    if (content && content !== 'none' && content !== 'normal') {
      const strings = quoted(content);
      if (strings) {
        // What CSS writes is no run to measure from: what comes next is read
        // as it runs on from it.
        lastRun = null;
        both(strings);
      }
    }
  };
  const walk = (node, styled, depth, marks) => {
    visited += 1;
    if (visited > ${MAX_DRAWN_NODES} || depth > 512) {
      whole = false;
      return;
    }
    if (node.nodeType === 3) {
      const around = styled ? getComputedStyle(styled) : null;
      if (!around || around.visibility === 'visible') {
        drawn(node, around, marks);
      }
      return;
    }
    if (node.nodeType === 9 || node.nodeType === 11) {
      for (const child of node.childNodes) {
        walk(child, node.nodeType === 11 ? node.host : null, depth + 1, []);
      }
      return;
    }
    if (node.nodeType !== 1) {
      return;
    }
    const tag = node.localName;
    if (tag === 'script' || tag === 'style' || tag === 'template' || tag === 'noscript') {
      return;
    }
    if (tag === 'br') {
      lastRun = null;
      both('\\n');
      return;
    }
    const style = getComputedStyle(node);
    if (style.display === 'none') {
      return;
    }
    const contents = style.display === 'contents';
    if (!contents && typeof node.checkVisibility === 'function' && !node.checkVisibility()) {
      return;
    }
    const block = !contents && !/^(inline|ruby)/.test(style.display);
    if (block) {
      lastRun = null;
      both('\\n');
    }
    const image = (tag === 'object' || tag === 'embed') && isImage(node);
    if (style.visibility === 'visible') {
      for (const name of ['alt', 'aria-label', 'title']) {
        const value = node.getAttribute(name);
        if (value && value.trim()) {
          said.push(value);
        }
      }
      if (tag === 'input' && /^(submit|button|reset)$/i.test(node.type) && node.value) {
        said.push(node.value);
      }
      if (tag === 'select' && node.selectedOptions) {
        for (const option of node.selectedOptions) {
          said.push(option.text);
        }
      }
    }
    if (style.contentVisibility === 'hidden' || image) {
      // What it holds is not drawn -- or it is an image.
    } else if (/^(iframe|frame|object|embed|fencedframe|portal)$/.test(tag)) {
      // Counted -- what a frame holds is read in the frame's own world -- but
      // not the element the walk starts from: a frame is not in itself.
      if (depth > 0) {
        frames += 1;
      }
    } else {
      pseudo(node, '::before');
      const root = node.shadowRoot || shadowOf.get(node);
      const assigned =
        tag === 'slot' && typeof node.assignedNodes === 'function' ? node.assignedNodes() : [];
      const children = root ? root.childNodes : assigned.length > 0 ? assigned : node.childNodes;
      // A highlight goes on through inline boxes, not into a box of its own.
      const within =
        depth === 0 || !(contents || style.display === 'inline')
          ? []
          : style.display === 'inline' && boxedIn(style)
            ? [...marks, node]
            : marks;
      for (const child of children) {
        walk(child, node, depth + 1, within);
      }
      pseudo(node, '::after');
    }
    if (block) {
      lastRun = null;
      both('\\n');
    }
  };
  if (this && this.nodeType === undefined && this.element && this.type) {
    // A pseudo-element: what CSS draws there.
    pseudo(this.element, this.type);
  } else {
    walk(this, null, 0, []);
  }
  return {
    text: parts.join(''),
    spaced: spaced.join(''),
    said: said.join('\\n'),
    frames,
    whole,
  };
}`;

// Words out of the walk's text: its lines and runs of space as single spaces.
function drawnWordsOf(text: unknown): string {
  return typeof text === 'string'
    ? text
        .split('\n')
        .map((line) => line.replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .join(' ')
    : '';
}

/**
 * What the browser draws under a node, read in the check's own world (see
 * DRAWN_TEXT): its words -- a long text by its start and its end -- and how
 * many frames and embedded documents it holds. Not `whole` when not all of it
 * could be read: more nodes or closed shadow trees than are read, or no world
 * to read it in.
 */
async function drawnUnder(
  cdp: AoiCdpSession,
  backendNodeId: number,
  frame?: string,
): Promise<{ words: string; frames: number; whole: boolean; plain: string; sealed: boolean }> {
  const described = (await cdp.send('DOM.describeNode', {
    backendNodeId,
    depth: -1,
    pierce: true,
  })) as { node?: AoiDomNode };
  const { closed, nodes, frames } = closedRootsUnder(described.node);
  // The element, in its own frame's world, and what the frames of the page's
  // own in it draw, each in its frame's: what one of those holds past what is
  // read is read through the frame, and leaves the element whole.
  const [value, ...framed] = (await Promise.all([
    inCheckWorld(cdp, backendNodeId, closed.slice(0, MAX_CLOSED_ROOTS), DRAWN_TEXT, frame),
    ...frames.map((inner) =>
      inCheckWorld(
        cdp,
        inner.root,
        inner.closed.slice(0, MAX_CLOSED_ROOTS),
        DRAWN_TEXT,
        inner.frameId,
      ),
    ),
  ])) as (
    | { text?: unknown; spaced?: unknown; said?: unknown; frames?: unknown; whole?: unknown }
    | undefined
  )[];
  if (!value || typeof value !== 'object') {
    return { words: '', frames: 0, whole: false, plain: '', sealed: closed.length > 0 };
  }
  const bounded = (words: string) =>
    words.length <= 2 * MAX_DRAWN_CHARS
      ? words
      : `${words.slice(0, MAX_DRAWN_CHARS)} ${words.slice(-MAX_DRAWN_CHARS)}`;
  const wordsOf = (read: { text?: unknown; spaced?: unknown; said?: unknown }) => {
    const text = drawnWordsOf(read.text);
    const spaced = drawnWordsOf(read.spaced);
    return [
      bounded(text),
      spaced !== text ? bounded(spaced) : '',
      drawnWordsOf(read.said).slice(0, MAX_DRAWN_SAID_CHARS),
    ]
      .filter(Boolean)
      .join(' ');
  };
  return {
    words: [value, ...framed]
      .map((read) => (read && typeof read === 'object' ? wordsOf(read) : ''))
      .filter(Boolean)
      .join(' '),
    frames: Number(value.frames) || 0,
    whole: value.whole === true && nodes <= MAX_DRAWN_NODES && closed.length <= MAX_CLOSED_ROOTS,
    // The element's own text as drawn, run on; and whether a closed shadow
    // tree is in it, which no selector sees.
    plain: drawnWordsOf(value.text),
    sealed: closed.length > 0,
  };
}

// Whether the node it runs on is `target` or inside it, by the DOM: climbing
// parents, from a shadow tree's top to its host, from a pseudo-element to the
// element it is drawn for.
const HOLDS = `function (target) {
  for (let node = this, steps = 0; node && steps < 100000; steps += 1) {
    if (node === target) {
      return true;
    }
    node = node.parentNode || node.host || node.element || null;
  }
  return false;
}`;

/**
 * Whether `target` is the node or around it in the accessibility tree -- which
 * follows shadow trees, closed ones too, and the element a pseudo-element is
 * drawn for. Exported for its own tests.
 */
export function axChainHolds(tree: AoiAxTree, backendNodeId: number, target: number): boolean {
  return axNodeAndAncestors(tree, backendNodeId).some((node) => node.backendDOMNodeId === target);
}

/**
 * Where Playwright aims a click: the middle of the element's first box that
 * shows in the window, as much of it as does (a link that wraps is aimed at its
 * first line). The protocol's hit test takes whole pixels: the nearest whole
 * point, which for a box a pixel wide or more is still in it. Exported for its
 * own tests.
 */
export function aimPointOfQuads(
  quads: unknown,
  width: number,
  height: number,
): { x: number; y: number } | null {
  if (!Array.isArray(quads)) {
    return null;
  }
  for (const quad of quads) {
    if (
      !Array.isArray(quad) ||
      quad.length !== 8 ||
      !quad.every((n) => typeof n === 'number' && Number.isFinite(n))
    ) {
      continue;
    }
    const points = [0, 2, 4, 6].map((i) => ({
      x: Math.min(Math.max(quad[i] as number, 0), width),
      y: Math.min(Math.max(quad[i + 1] as number, 0), height),
    }));
    let area = 0;
    for (let i = 0; i < 4; i += 1) {
      const a = points[i];
      const b = points[(i + 1) % 4];
      area += (a.x * b.y - b.x * a.y) / 2;
    }
    if (Math.abs(area) > 0.99) {
      const x = points.reduce((sum, point) => sum + point.x, 0) / 4;
      const y = points.reduce((sum, point) => sum + point.y, 0) / 4;
      return { x: Math.ceil(x - 0.5), y: Math.ceil(y - 0.5) };
    }
  }
  return null;
}

/**
 * Puts the element where the DevTools protocol can take it: on the window,
 * under a name nobody else knows -- and only in the top document, the one the
 * protocol's read is of. Exported for its own tests; in use it runs inside the
 * page, by evaluate, so it calls nothing of this module's.
 */
export function handOverToProtocol(element: Element, name: string): boolean {
  if (window !== window.top) {
    return false;
  }
  (window as unknown as Record<string, unknown>)[name] = element;
  return true;
}

interface AoiAimPoint {
  words: string;
  frame: boolean;
  embedded: boolean;
  inside: boolean;
  // The click lands in a frame still on the empty document a frame starts with.
  blank: boolean;
  // The click was followed into a frame, and lost in a frame inside it.
  lost: boolean;
}

interface AoiFrameTreeNode {
  frame?: { id?: string; url?: string };
  childFrames?: AoiFrameTreeNode[];
}

// The address a frame of the tree shows, or null when it is not in the tree.
function frameUrlIn(tree: AoiFrameTreeNode | undefined, frameId: string): string | null {
  const pending: (AoiFrameTreeNode | undefined)[] = [tree];
  for (let looked = 0; pending.length > 0 && looked < 1_000; looked += 1) {
    const node = pending.pop();
    if (node?.frame?.id === frameId) {
      return typeof node.frame.url === 'string' ? node.frame.url : '';
    }
    pending.push(...(Array.isArray(node?.childFrames) ? node.childFrames : []));
  }
  return null;
}

// Whether the hit is the target or inside it. A hit in a frame of the page's
// own is followed back out through the frames' elements to the top document.
// The accessibility tree says so (it follows closed shadow trees, and the
// element a pseudo-element is drawn for); when it does not -- skipped on a
// crowded page, slow, or leaving the node out -- the DOM does, in the check's
// own world. Null when neither can say: the words found there are then read,
// since they can only add to what is refused.
async function aimedInside(
  cdp: AoiCdpSession,
  ax: AoiCdpSession | null,
  frameTree: AoiFrameTreeNode | undefined,
  hit: { backendNodeId: number; frameId?: string },
  tree: AoiAxTree,
  target: number,
): Promise<boolean | null> {
  const top = frameTree?.frame?.id;
  const parents = new Map<string, string>();
  const walk = (node: AoiFrameTreeNode, depth: number) => {
    for (const child of Array.isArray(node.childFrames) ? node.childFrames : []) {
      if (child.frame?.id && node.frame?.id && depth < 16) {
        parents.set(child.frame.id, node.frame.id);
        walk(child, depth + 1);
      }
    }
  };
  if (frameTree) {
    walk(frameTree, 0);
  }
  let probe = hit.backendNodeId;
  let probeTree: AoiAxTree | null = tree;
  let frameId = hit.frameId ?? top;
  for (let depth = 0; frameId !== top; depth += 1) {
    const parent = frameId ? parents.get(frameId) : undefined;
    if (!frameId || !parent || depth >= MAX_AIM_FRAME_DEPTH) {
      return null;
    }
    const owner = (await cdp.send('DOM.getFrameOwner', { frameId })) as { backendNodeId?: number };
    if (typeof owner.backendNodeId !== 'number') {
      return null;
    }
    probe = owner.backendNodeId;
    probeTree = null;
    frameId = parent;
  }
  if (probe === target) {
    return true;
  }
  const chain =
    probeTree ??
    (ax
      ? await axRead(ax, 'Accessibility.getPartialAXTree', {
          backendNodeId: probe,
          fetchRelatives: true,
        })
      : {});
  if (axChainHolds(chain, probe, target)) {
    return true;
  }
  const held = await inCheckWorld(cdp, probe, [target], HOLDS);
  return typeof held === 'boolean' ? held : null;
}

interface AoiPointRead {
  backendNodeId: number;
  frameId?: string;
  nodeName: string;
  // How many elements the hit holds, and whether it is an <object> or <embed>
  // of an image -- an image, like an <img>.
  elements: number;
  image: boolean;
  words: string;
  tree: AoiAxTree;
}

// Whether a hit is in a frame of the tree still on the empty document a frame
// starts with: no address of its own yet (or about:blank), and nothing in it --
// the hit is its document's root, or its body with no element in it. A frame
// a script has written into is read where the click lands.
function blankAt(tree: AoiFrameTreeNode | undefined, at: AoiPointRead): boolean {
  if (!at.frameId || at.frameId === tree?.frame?.id) {
    return false;
  }
  const url = frameUrlIn(tree, at.frameId);
  return (
    (url === '' || url === 'about:blank') &&
    (at.nodeName === 'HTML' || (at.nodeName === 'BODY' && at.elements === 0))
  );
}

// An <object> or <embed> of an image, by its type or its file.
function imageEmbed(nodeName: string, attributes: string[]): boolean {
  if (nodeName !== 'OBJECT' && nodeName !== 'EMBED') {
    return false;
  }
  const named = new Map<string, string>();
  for (let index = 0; index + 1 < attributes.length; index += 2) {
    named.set(String(attributes[index]).toLowerCase(), String(attributes[index + 1]));
  }
  return (
    /^image\//i.test(named.get('type') ?? '') ||
    /\.(svg|png|gif|jpe?g|webp|avif|bmp|ico)(?:[?#]|$)/i.test(
      named.get('data') ?? named.get('src') ?? '',
    )
  );
}

interface AoiLayoutMetrics {
  cssLayoutViewport?: {
    clientWidth?: number;
    clientHeight?: number;
    pageX?: number;
    pageY?: number;
  };
  cssVisualViewport?: { pageX?: number; pageY?: number };
}

// Where a document is scrolled to: the hit test takes a point of the document,
// where a click's point -- and every box the protocol gives -- is one of the
// window.
function scrolledBy(metrics: AoiLayoutMetrics): { x: number; y: number } {
  const view = metrics.cssVisualViewport ?? metrics.cssLayoutViewport;
  return { x: Number(view?.pageX) || 0, y: Number(view?.pageY) || 0 };
}

// What one DevTools session's own hit test finds at a point of its window, and
// what the browser says of it.
async function readAtPoint(
  cdp: AoiCdpSession,
  ax: AoiCdpSession | null,
  point: { x: number; y: number },
  scroll: { x: number; y: number },
): Promise<AoiPointRead | null> {
  // Hit as a click is: through what lets the pointer through (pointer-events:
  // none), as Playwright's own check and the browser's events go.
  const hit = (await cdp.send('DOM.getNodeForLocation', {
    x: Math.round(point.x + scroll.x),
    y: Math.round(point.y + scroll.y),
    includeUserAgentShadowDOM: false,
    ignorePointerEventsNone: false,
  })) as { backendNodeId?: number; frameId?: string };
  if (typeof hit.backendNodeId !== 'number') {
    return null;
  }
  const [node, tree] = (await Promise.all([
    cdp.send('DOM.describeNode', { backendNodeId: hit.backendNodeId, depth: 1 }),
    ax
      ? axRead(ax, 'Accessibility.getPartialAXTree', {
          backendNodeId: hit.backendNodeId,
          fetchRelatives: true,
        })
      : Promise.resolve({}),
  ])) as [
    {
      node?: {
        nodeName?: unknown;
        attributes?: unknown;
        childNodeCount?: unknown;
        children?: { nodeType?: unknown }[];
      };
    },
    AoiAxTree,
  ];
  const attributes = Array.isArray(node.node?.attributes)
    ? (node.node.attributes as unknown[]).map(String)
    : [];
  // What the hit holds, closed shadow trees included, as it is read out and as
  // it is drawn (what is drawn but hidden from the read-out too) -- unless it
  // is a container the click lands on the bare face of.
  const small = Number(node.node?.childNodeCount ?? 0) <= MAX_AIMED_CHILDREN;
  const held =
    small && ax
      ? await axRead(ax, 'Accessibility.queryAXTree', { backendNodeId: hit.backendNodeId })
      : {};
  const [drawn, runsOn] = small
    ? await Promise.all([
        drawnUnder(cdp, hit.backendNodeId, hit.frameId).then((read) => read.words),
        runsOnAt(cdp, hit.backendNodeId, hit.frameId),
      ])
    : ['', ''];
  const nodeName = String(node.node?.nodeName ?? '').toUpperCase();
  return {
    backendNodeId: hit.backendNodeId,
    ...(hit.frameId ? { frameId: hit.frameId } : {}),
    nodeName,
    elements: (Array.isArray(node.node?.children) ? node.node.children : []).filter(
      (child) => child?.nodeType === 1,
    ).length,
    image: imageEmbed(nodeName, attributes),
    // Each read is bounded by itself: one does not push the other out. What
    // the hit draws that the names read already hold is read in them.
    words: aimedWordsWith(
      wordsOfAimedNode(tree, hit.backendNodeId, attributes, held, runsOn),
      drawn,
    ),
    tree,
  };
}

// The word the text of an element set inline runs on into as it is drawn: its
// text, with the runs of text of its block before and after it that touch it
// -- no space between them, drawn on one line with no more than a sixth of the
// letters' size apart (DRAWN_TEXT's measure) -- as far as a space. The "pay" a
// search highlights in "My payments" is drawn as "payments". '' when nothing
// runs on into it, or it is no element set inline.
const RUNS_ON = `function () {
  const parentOf = Object.getOwnPropertyDescriptor(Node.prototype, 'parentElement').get;
  const childNodesOf = Object.getOwnPropertyDescriptor(Node.prototype, 'childNodes').get;
  const nodeTypeOf = Object.getOwnPropertyDescriptor(Node.prototype, 'nodeType').get;
  const { contains } = Node.prototype;
  const inline = (element) => /^(inline|contents)$/.test(getComputedStyle(element).display);
  const blockOf = (node) => {
    let element = parentOf.call(node);
    while (element && inline(element)) {
      element = parentOf.call(element);
    }
    return element;
  };
  if (!inline(this)) {
    return '';
  }
  const block = blockOf(this);
  if (!block) {
    return '';
  }
  // The runs of text of its block, spaces between elements among them, in
  // order, as far as so many nodes.
  const runs = [];
  const pending = [block];
  for (let visited = 0; pending.length > 0 && visited < 5000; visited += 1) {
    const node = pending.pop();
    if (nodeTypeOf.call(node) === 3) {
      runs.push(node);
      continue;
    }
    const children = childNodesOf.call(node);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      pending.push(children[index]);
    }
  }
  const first = runs.findIndex((node) => contains.call(this, node));
  if (first < 0) {
    return '';
  }
  let last = first;
  while (last + 1 < runs.length && contains.call(this, runs[last + 1])) {
    last += 1;
  }
  const own = runs.slice(first, last + 1).map((node) => node.data).join('');
  const boxOf = (node, end) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    const rects = range.getClientRects();
    return rects.length > 0 ? rects[end ? rects.length - 1 : 0] : null;
  };
  const vertical = /^(vertical|sideways)/.test(getComputedStyle(block).writingMode || '');
  const touching = (before, after) => {
    const one = boxOf(before, true);
    const two = boxOf(after, false);
    if (!one || !two) {
      return false;
    }
    const sizeOf = (box) => (vertical ? box.right - box.left : box.bottom - box.top);
    const size = Math.min(sizeOf(one), sizeOf(two)) || 16;
    const across = vertical
      ? Math.abs(one.left + one.right - two.left - two.right) / 2
      : Math.abs(one.top + one.bottom - two.top - two.bottom) / 2;
    const along = vertical
      ? Math.max(two.top - one.bottom, one.top - two.bottom)
      : Math.max(two.left - one.right, one.left - two.right);
    return across <= size / 2 && along <= size / 6;
  };
  const runsInto = (before, after) =>
    blockOf(before) === block &&
    blockOf(after) === block &&
    /\\S$/.test(before.data) &&
    /^\\S/.test(after.data) &&
    touching(before, after);
  let head = '';
  for (let at = first; at > 0 && first - at < 20 && runsInto(runs[at - 1], runs[at]); at -= 1) {
    const piece = /\\S*$/.exec(runs[at - 1].data)[0];
    head = piece + head;
    if (piece.length < runs[at - 1].data.length) {
      break;
    }
  }
  let tail = '';
  for (let at = last; at + 1 < runs.length && at - last < 20 && runsInto(runs[at], runs[at + 1]); at += 1) {
    const piece = /^\\S*/.exec(runs[at + 1].data)[0];
    tail += piece;
    if (piece.length < runs[at + 1].data.length) {
      break;
    }
  }
  return head || tail ? (head + own + tail).replace(/\\s+/g, ' ').trim() : '';
}`;

// RUNS_ON for the node `backendNodeId`, in the check's own world of its frame.
async function runsOnAt(
  cdp: AoiCdpSession,
  backendNodeId: number,
  frame?: string,
): Promise<string> {
  const value = await inCheckWorld(cdp, backendNodeId, [], RUNS_ON, frame);
  return typeof value === 'string' ? value.slice(0, MAX_AIMED_NAME_CHARS) : '';
}

// The DevTools session of each frame of a tab that has one of its own -- a
// frame from another site -- with the frame's id; kept per frame while it
// answers. A frame with none (still in the page's process: blank, lazy, not yet
// given its address) is asked again next time -- it can go to another site --
// and so is one whose session no longer answers (it went to another process).
const frameSessions = new WeakMap<object, Promise<{ cdp: AoiCdpSession; id: string } | null>>();

// A protocol session of its own for one read of an accessibility tree -- of a
// tab, or of a frame of one -- let go once the read is done. What the browser's
// accessibility agent keeps of a document on a session it was asked on brings
// the renderer down, an access violation, once the document has been left and
// what it kept is collected (Chrome 153: the next page of a run, under memory
// pressure). Null when none can be opened.
async function accessibilitySessionOf(
  tab: Record<string, unknown>,
  target: object,
): Promise<AoiCdpSession | null> {
  const context = (
    tab.context as (() => { newCDPSession(p: unknown): Promise<AoiCdpSession> }) | undefined
  )?.call(tab);
  if (!context) {
    return null;
  }
  try {
    return await context.newCDPSession(target);
  } catch {
    return null;
  }
}

async function frameIdOver(cdp: AoiCdpSession): Promise<string | null> {
  const tree = (await cdp.send('Page.getFrameTree')) as { frameTree?: AoiFrameTreeNode };
  const id = tree.frameTree?.frame?.id;
  return typeof id === 'string' ? id : null;
}

async function frameSessionFor(
  tab: Record<string, unknown>,
  frameId: string,
): Promise<{ cdp: AoiCdpSession; frame: object } | null> {
  const frames = typeof tab.frames === 'function' ? (tab.frames as () => unknown[]).call(tab) : [];
  const context = (
    tab.context as (() => { newCDPSession(p: unknown): Promise<AoiCdpSession> }) | undefined
  )?.call(tab);
  if (!context || !Array.isArray(frames)) {
    return null;
  }
  const open = (frame: object) => {
    const entry = context
      .newCDPSession(frame)
      .then(async (cdp) => {
        const id = await frameIdOver(cdp);
        return id === null ? null : { cdp, id };
      })
      // A frame of the page's own process has no session of its own.
      .catch(() => null);
    frameSessions.set(frame, entry);
    void entry.then((found) => {
      if (found === null && frameSessions.get(frame) === entry) {
        frameSessions.delete(frame);
      }
    });
    return entry;
  };
  // Every frame is asked at once: one whose page is busy answers its
  // session's first question late, and the frame looked for does not wait
  // behind it.
  const candidates = frames.filter(
    (frame): frame is object => Boolean(frame) && typeof frame === 'object',
  );
  const sessionOf = async (
    frame: object,
  ): Promise<{ cdp: AoiCdpSession; frame: object } | null> => {
    const kept = frameSessions.get(frame);
    let found = await (kept ?? open(frame));
    if (
      kept &&
      found?.id === frameId &&
      (await frameIdOver(found.cdp).catch(() => null)) !== frameId
    ) {
      // Kept, and gone: the frame is in another process now.
      found = await open(frame);
    }
    return found?.id === frameId ? { cdp: found.cdp, frame } : null;
  };
  return new Promise((resolve) => {
    let left = candidates.length;
    if (left === 0) {
      resolve(null);
      return;
    }
    for (const frame of candidates) {
      void sessionOf(frame)
        .then(
          (reached) => {
            if (reached) {
              resolve(reached);
            }
          },
          () => {},
        )
        .finally(() => {
          left -= 1;
          if (left === 0) {
            resolve(null);
          }
        });
    }
  });
}

/**
 * A frame from another site is a document of its own, which the page's hit test
 * does not go into: the click is followed in, through that frame's own session
 * -- from its element's content box to the point inside -- as many frames deep
 * as there are, to MAX_AIM_FRAME_DEPTH. Null when it cannot be followed into
 * the first frame (the caller reads that frame through); `lost` when it was,
 * and could not be followed on into a frame inside it -- turned, scaled
 * unevenly, past the depth -- where no read of the first frame reaches.
 */
async function readInsideFrames(
  tab: Record<string, unknown>,
  cdp: AoiCdpSession,
  frameNode: number,
  point: { x: number; y: number },
): Promise<{ words: string; embedded: boolean; blank: boolean; lost?: boolean } | null> {
  let followed = 0;
  const words: string[] = [];
  const lost = () =>
    followed > 0
      ? { words: words.filter(Boolean).join(' '), embedded: false, blank: false, lost: true }
      : null;
  try {
    return (await followInto(tab, cdp, frameNode, point, words, () => (followed += 1))) ?? lost();
  } catch {
    return lost();
  }
}

async function followInto(
  tab: Record<string, unknown>,
  cdp: AoiCdpSession,
  frameNode: number,
  point: { x: number; y: number },
  words: string[],
  entered: () => void,
): Promise<{ words: string; embedded: boolean; blank: boolean } | null> {
  let session = cdp;
  let node = frameNode;
  let { x, y } = point;
  for (let depth = 0; depth < MAX_AIM_FRAME_DEPTH; depth += 1) {
    const [box, described] = (await Promise.all([
      session.send('DOM.getBoxModel', { backendNodeId: node }),
      session.send('DOM.describeNode', { backendNodeId: node }),
    ])) as [{ model?: { content?: unknown } }, { node?: { frameId?: unknown } }];
    // The box is one of this window; the point inside, one of the frame's.
    const content = box.model?.content;
    const childFrame = described.node?.frameId;
    if (
      typeof childFrame !== 'string' ||
      !Array.isArray(content) ||
      content.length !== 8 ||
      // A frame turned or skewed is no box to map a point into.
      content[1] !== content[3] ||
      content[0] !== content[6]
    ) {
      return null;
    }
    const reached = await frameSessionFor(tab, childFrame);
    if (!reached) {
      return null;
    }
    const inner = reached.cdp;
    // A frame scaled or zoomed on the page draws its window smaller or larger
    // than that: a point in its box is a point in its window in that
    // proportion. One scaled unevenly is no box to map a point into.
    const size = await windowSizeOf(inner);
    const width = Number(content[2]) - Number(content[0]);
    const height = Number(content[7]) - Number(content[1]);
    if (!size || !(width > 0) || !(height > 0)) {
      return null;
    }
    const scaleX = size.width / width;
    const scaleY = size.height / height;
    if (Math.abs(scaleX - scaleY) > 0.05 * Math.max(scaleX, scaleY)) {
      return null;
    }
    x = (x - Number(content[0])) * scaleX;
    y = (y - Number(content[1])) * scaleY;
    const [metrics, frames] = (await Promise.all([
      inner.send('Page.getLayoutMetrics'),
      inner.send('Page.getFrameTree'),
    ])) as [AoiLayoutMetrics, { frameTree?: AoiFrameTreeNode }];
    const ax = await accessibilitySessionOf(tab, reached.frame);
    let at: Awaited<ReturnType<typeof readAtPoint>>;
    try {
      at = await readAtPoint(inner, ax ?? inner, { x, y }, scrolledBy(metrics));
    } finally {
      ax?.detach?.().catch(() => {});
    }
    if (!at) {
      return null;
    }
    entered();
    words.push(at.words);
    if (blankAt(frames.frameTree, at)) {
      return { words: words.filter(Boolean).join(' '), embedded: false, blank: true };
    }
    if (!FRAME_NODES.has(at.nodeName)) {
      return {
        words: words.filter(Boolean).join(' '),
        embedded: EMBEDDED_NODES.has(at.nodeName) && !at.image,
        blank: false,
      };
    }
    session = inner;
    node = at.backendNodeId;
  }
  return null;
}

/**
 * What the browser says is where a click on `selector` lands. Null when it
 * cannot say: the element is not in the top document, or nothing of it is in
 * view.
 */
// The element `selector` names, as a node the DevTools protocol knows: handed
// over from the page's world under a name nobody else knows, and taken at once
// -- in the top document only, the one the protocol's read is of. Null when it
// cannot be.
async function protocolNodeOf(
  tab: Record<string, unknown>,
  cdp: AoiCdpSession,
  selector: string,
  timeout: number,
): Promise<number | null> {
  const name = `__aoiAim${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const group = `${AIM_OBJECT_GROUP}-${name}`;
  const locate = tab.locator as (s: string) => AoiWaitableLocator;
  const placed: unknown = await locate
    .call(tab, selector)
    .evaluate(handOverToProtocol, name, { timeout });
  if (placed !== true) {
    return null;
  }
  try {
    const taken = (await cdp.send('Runtime.evaluate', {
      expression: `(() => { const name = ${JSON.stringify(name)}; const element = window[name]; delete window[name]; return element; })()`,
      objectGroup: group,
    })) as { result?: { objectId?: string; subtype?: string } };
    if (!taken.result?.objectId || taken.result.subtype !== 'node') {
      return null;
    }
    const described = (await cdp.send('DOM.describeNode', {
      objectId: taken.result.objectId,
    })) as { node?: { backendNodeId?: number } };
    return typeof described.node?.backendNodeId === 'number' ? described.node.backendNodeId : null;
  } finally {
    cdp.send('Runtime.releaseObjectGroup', { objectGroup: group }).catch(() => {});
  }
}

async function readAimPoint(
  tab: Record<string, unknown>,
  cdp: AoiCdpSession,
  ax: AoiCdpSession,
  selector: string,
  timeout: number,
): Promise<AoiAimPoint | null> {
  const [target, slow] = await Promise.all([
    protocolNodeOf(tab, cdp, selector, timeout),
    axIsSlowFor(tab, selector, timeout),
  ]);
  if (target === null) {
    return null;
  }
  const tree = slow ? null : ax;
  const [quads, metrics, frames] = (await Promise.all([
    cdp.send('DOM.getContentQuads', { backendNodeId: target }),
    cdp.send('Page.getLayoutMetrics'),
    cdp.send('Page.getFrameTree'),
  ])) as [{ quads?: unknown }, AoiLayoutMetrics, { frameTree?: AoiFrameTreeNode }];
  const point = aimPointOfQuads(
    quads.quads,
    Number(metrics.cssLayoutViewport?.clientWidth) || 0,
    Number(metrics.cssLayoutViewport?.clientHeight) || 0,
  );
  if (!point) {
    return null;
  }
  const at = await readAtPoint(cdp, tree, point, scrolledBy(metrics));
  if (!at) {
    return null;
  }
  const isFrame = FRAME_NODES.has(at.nodeName);
  const inner = isFrame ? await readInsideFrames(tab, cdp, at.backendNodeId, point) : null;
  return {
    words: [at.words, inner?.words ?? ''].filter(Boolean).join(' '),
    // A frame it could not follow the click into is for the caller to read.
    frame: isFrame && inner === null,
    embedded: (EMBEDDED_NODES.has(at.nodeName) && !at.image) || inner?.embedded === true,
    // A frame of the page's own -- here, or in a frame from another site --
    // still on the empty document a frame starts with: what arrives in it has
    // not been read.
    blank: blankAt(frames.frameTree, at) || inner?.blank === true,
    lost: inner?.lost === true,
    // An image map's area is clicked through its image, though the tree does
    // not put it there.
    inside:
      at.nodeName === 'AREA' ||
      (await aimedInside(
        cdp,
        tree,
        frames.frameTree,
        { backendNodeId: at.backendNodeId, frameId: at.frameId },
        at.tree,
        target,
      )) !== false,
  };
}

// What the browser draws in the element `selector` names, as its accessibility
// tree reads it out and as it is drawn, closed shadow trees included. Null when
// it cannot say; not `whole` when not all of what it draws could be read.
async function readOutOfElement(
  tab: Record<string, unknown>,
  cdp: AoiCdpSession,
  ax: AoiCdpSession,
  selector: string,
  timeout: number,
): Promise<{
  words: string;
  frames: number;
  drawnFrames: number;
  whole: boolean;
  sealed: boolean;
} | null> {
  const [node, slow] = await Promise.all([
    protocolNodeOf(tab, cdp, selector, timeout),
    axIsSlowFor(tab, selector, timeout),
  ]);
  if (node === null) {
    return null;
  }
  // As it is read out, and as it is drawn: what aria-hidden takes out of the
  // read-out is drawn, and clicked, all the same. The read-out is the
  // accessibility tree, which a page of a hundred thousand elements takes
  // seconds to build: on such a page, and when it does not come soon, what is
  // drawn says it alone.
  const tree = slow ? {} : await axRead(ax, 'Accessibility.queryAXTree', { backendNodeId: node });
  const read = wordsHeldBy(tree, node);
  const drawn = await drawnUnder(cdp, node);
  // The read-out sets every run of text apart -- "Pay" and "Pal" of one
  // wordmark, the "Pay" a search highlights in "Payment" -- where the drawing
  // tells which touch. Where its text holds the same letters as the drawing,
  // the drawing's spacing is the one taken; what has a name in it -- a heading
  // the text is in, an image -- still says it.
  const sameLetters = drawn.plain !== '' && lettersOf(read.text) === lettersOf(drawn.plain);
  return {
    // Each read is bounded by itself: one does not push the other out.
    words: (sameLetters ? [read.names, drawn.words] : [read.words, drawn.words])
      .filter(Boolean)
      .join(' '),
    frames: Math.max(read.frames, drawn.frames),
    // The frames the walk counts in its own document -- in closed shadow trees
    // too, where no selector finds them.
    drawnFrames: drawn.frames,
    whole: drawn.whole,
    sealed: drawn.sealed,
  };
}

// What the element `selector` names shows where it can be seen, measured in the
// check's own world as far as `limit` (shownTextIn). A box of a closed shadow
// tree that hides what overflows it -- a card of a set height a component
// slots a row into -- is met only through the slot, which no script sees:
// where the element shows more than the limit, the slots of closed trees its
// climb passes are had from the browser's protocol and it is measured again
// through them. The climb is had from `from` when given -- the element inside
// it whose boxes one check measures together, and whose climb passes all of
// theirs -- once for them all (`kept`, the check's own), and within half the
// time: past that, the first measure stands. Null when it cannot be told.
async function shownTextOfElement(
  tab: Record<string, unknown>,
  cdp: AoiCdpSession,
  selector: string,
  timeout: number,
  limit: number,
  kept: KeptClimbs = new Map(),
  from?: string,
): Promise<{ length: number; text: string } | null> {
  const node = await protocolNodeOf(tab, cdp, selector, timeout);
  if (node === null) {
    return null;
  }
  const measure = async (closedSlots: number[]) => {
    const shown = (await inCheckWorld(
      cdp,
      node,
      closedSlots,
      `function (...closedSlots) { return (${shownTextIn})(this, ${limit}, closedSlots); }`,
    )) as { length?: unknown; text?: unknown } | null | undefined;
    return shown && typeof shown.length === 'number' && typeof shown.text === 'string'
      ? { length: shown.length, text: shown.text }
      : null;
  };
  const shown = await measure([]);
  if (shown === null || shown.length <= limit) {
    return shown;
  }
  const start = (from ? await protocolNodeOf(tab, cdp, from, timeout) : null) ?? node;
  const closedSlots = await withinDeadline(
    keptClimbOf(cdp, start, kept),
    Math.max(100, Math.floor(timeout / 2)),
  ).catch(() => [] as number[]);
  return closedSlots.length > 0 ? ((await measure(closedSlots)) ?? shown) : shown;
}

// How many elements on the way an element's events climb -- its own first,
// then on through the slots and hosts they pass -- are asked whether a closed
// shadow tree's slot takes them in, and how many such trees are read: past
// those, what the climb meets cannot be told.
const MAX_SLOT_CLIMB = 1_024;
const MAX_CLOSED_SLOTS = 4;
// How many elements of a climb are described at once.
const SLOT_DESCRIBE_BATCH = 64;

// The way an element's events climb, as a script in the check's own world sees
// it: into an open tree's slot, to the parent, from a shadow tree's top to its
// host -- one element more than `most` when it goes on past that many. The slot
// of a closed tree, or of one of the browser's own (a <details>'s, a <select>'s),
// it does not see: from an element slotted there it climbs to the host instead.
const SLOT_CLIMB =
  'function (most) { const slotOf = Object.getOwnPropertyDescriptor(Element.prototype, ' +
  "'assignedSlot').get; const parentOf = Object.getOwnPropertyDescriptor(Node.prototype, " +
  "'parentElement').get; const hostOf = Object.getOwnPropertyDescriptor(ShadowRoot.prototype, " +
  "'host').get; const { getRootNode } = Node.prototype; const path = []; " +
  'for (let node = this; node && path.length <= most; ) { path.push(node); ' +
  'const root = getRootNode.call(node); node = slotOf.call(node) || parentOf.call(node) || ' +
  '(root instanceof ShadowRoot ? hostOf.call(root) : null); } return path; }';

// The elements of the way `from`'s events climb, as objects of `group`; null
// when it goes on past as many as are asked about, or cannot be had.
async function slotClimbOf(
  cdp: AoiCdpSession,
  from: string,
  group: string,
): Promise<string[] | null> {
  const listed = (await cdp.send('Runtime.callFunctionOn', {
    objectId: from,
    functionDeclaration: SLOT_CLIMB,
    arguments: [{ value: MAX_SLOT_CLIMB }],
    objectGroup: group,
  })) as { result?: { objectId?: unknown } };
  const array = listed.result?.objectId;
  if (typeof array !== 'string') {
    return null;
  }
  const properties = (await cdp.send('Runtime.getProperties', {
    objectId: array,
    ownProperties: true,
  })) as { result?: { name?: unknown; value?: { objectId?: unknown } }[] };
  const path = (Array.isArray(properties.result) ? properties.result : [])
    .filter((property) => /^\d+$/.test(String(property.name)))
    .sort((a, b) => Number(a.name) - Number(b.name))
    .map((property) => property.value?.objectId)
    .filter((objectId): objectId is string => typeof objectId === 'string');
  return path.length === 0 || path.length > MAX_SLOT_CLIMB ? null : path;
}

// The first slot of a closed tree on a climb, from what the browser says of
// each element on it: the slot it is in -- which the climb went on into when a
// script could see it -- and, for the host the climb went to instead, the kind
// of tree it holds. Whether the tree is closed is never asked of the tree in a
// script: asking a tree of the browser's own its mode brings the tab down.
// Null when the climb meets none; undefined when what it meets cannot be told.
// With the element slotted there (`slotted`).
function closedSlotStepOnClimb(
  described: { node?: AoiDomNode & { assignedSlot?: { backendNodeId?: unknown } } }[],
): { slotted: number | undefined; slot: number } | null | undefined {
  for (let at = 0; at < described.length; at += 1) {
    const slot = described[at].node?.assignedSlot?.backendNodeId;
    if (typeof slot !== 'number') {
      continue;
    }
    const next = described[at + 1]?.node;
    if (next?.backendNodeId === slot) {
      continue;
    }
    const kind = next?.shadowRoots?.[0]?.shadowRootType;
    if (kind === 'closed') {
      const slotted = described[at].node?.backendNodeId;
      return { slotted: typeof slotted === 'number' ? slotted : undefined, slot };
    }
    if (kind !== 'user-agent') {
      return undefined;
    }
  }
  return null;
}

function closedSlotOnClimb(
  described: { node?: AoiDomNode & { assignedSlot?: { backendNodeId?: unknown } } }[],
): number | null | undefined {
  const step = closedSlotStepOnClimb(described);
  return step ? step.slot : step;
}

// What the browser says of each element of a climb, a batch at a time.
async function describeClimb(
  cdp: AoiCdpSession,
  path: string[],
): Promise<{ node?: AoiDomNode & { assignedSlot?: { backendNodeId?: unknown } } }[]> {
  const described: { node?: AoiDomNode & { assignedSlot?: { backendNodeId?: unknown } } }[] = [];
  for (let first = 0; first < path.length; first += SLOT_DESCRIBE_BATCH) {
    const batch = (await Promise.all(
      path
        .slice(first, first + SLOT_DESCRIBE_BATCH)
        .map((objectId) => cdp.send('DOM.describeNode', { objectId, depth: 0 })),
    )) as { node?: AoiDomNode & { assignedSlot?: { backendNodeId?: unknown } } }[];
    for (const one of batch) {
      described.push(one);
    }
  }
  return described;
}

// What the browser says of a climb from a slot of a closed tree, as far as
// that tree's host: from the host on, the way is the one a climb before it
// described (`known`, the host first), which is not asked about again.
async function describeClimbInTree(
  cdp: AoiCdpSession,
  path: string[],
  known: { node?: AoiDomNode & { assignedSlot?: { backendNodeId?: unknown } } }[],
): Promise<{ node?: AoiDomNode & { assignedSlot?: { backendNodeId?: unknown } } }[]> {
  const host = known[0]?.node?.backendNodeId;
  const described: { node?: AoiDomNode & { assignedSlot?: { backendNodeId?: unknown } } }[] = [];
  for (let first = 0; first < path.length; first += SLOT_DESCRIBE_BATCH) {
    const batch = (await Promise.all(
      path
        .slice(first, first + SLOT_DESCRIBE_BATCH)
        .map((objectId) => cdp.send('DOM.describeNode', { objectId, depth: 0 })),
    )) as { node?: AoiDomNode & { assignedSlot?: { backendNodeId?: unknown } } }[];
    for (const one of batch) {
      if (host !== undefined && one.node?.backendNodeId === host) {
        return [...described, ...known];
      }
      described.push(one);
    }
  }
  return described;
}

// The slots of closed trees the way an element's events climb passes, each
// after the element slotted there -- backend node ids, in pairs -- as many as
// are read (MAX_CLOSED_SLOTS) and as far as a climb is asked about. Each climb
// from a slot found asks only about what is inside that slot's tree again.
// What is found before the rest cannot be told is kept: what it leaves out is
// only not climbed through.
async function closedSlotsOnClimbOf(cdp: AoiCdpSession, node: number): Promise<number[]> {
  const executionContextId = await checkWorldOf(cdp);
  if (executionContextId === null) {
    return [];
  }
  const group = `${CHECK_OBJECT_GROUP}-${Math.random().toString(36).slice(2)}`;
  const pairs: number[] = [];
  try {
    let at = node;
    let known: { node?: AoiDomNode & { assignedSlot?: { backendNodeId?: unknown } } }[] | null =
      null;
    for (let read = 0; read < MAX_CLOSED_SLOTS; read += 1) {
      const resolved = (await cdp.send('DOM.resolveNode', {
        backendNodeId: at,
        executionContextId,
        objectGroup: group,
      })) as { object?: { objectId?: unknown } };
      const from = resolved.object?.objectId;
      const path = typeof from === 'string' ? await slotClimbOf(cdp, from, group) : null;
      const described:
        | { node?: AoiDomNode & { assignedSlot?: { backendNodeId?: unknown } } }[]
        | null =
        path === null
          ? null
          : known
            ? await describeClimbInTree(cdp, path, known)
            : await describeClimb(cdp, path);
      const step = described === null ? undefined : closedSlotStepOnClimb(described);
      if (!described || !step || step.slotted === undefined) {
        break;
      }
      pairs.push(step.slotted, step.slot);
      const slotted = step.slotted;
      known = described.slice(
        described.findIndex((one) => one.node?.backendNodeId === slotted) + 1,
      );
      at = step.slot;
    }
  } catch {
    // What was found stands.
  } finally {
    cdp.send('Runtime.releaseObjectGroup', { objectGroup: group }).catch(() => {});
  }
  return pairs;
}

// The closed slots of the climbs had for the boxes one check measures
// together, by the element each climb is from: each box would climb the same
// way again. Another check -- later, when the page may have changed, or on
// another page, whose elements the browser may number the same -- climbs anew.
type KeptClimbs = Map<number, Promise<number[]>>;

// The closed slots on the climb from `node`, had once for a check (`kept`).
function keptClimbOf(cdp: AoiCdpSession, node: number, kept: KeptClimbs): Promise<number[]> {
  const known = kept.get(node);
  if (known) {
    return known;
  }
  const pairs = closedSlotsOnClimbOf(cdp, node);
  kept.set(node, pairs);
  return pairs;
}

// What is around an element the page slots into a closed shadow tree, read from
// the slot it is in: the boxes and controls of that tree a click on it goes on
// to (wordsAroundAcrossShadowTrees from the slot, its own tree included) --
// every such slot its events climb through, a slot within a slot, a closed tree
// within an open one. No selector reaches into a closed tree, and neither does
// the page's own assignedSlot -- the browser's protocol names the slot. '' when
// the element and those around it are slotted into no closed tree, or it is
// not one of the top document's; null when that cannot be told -- unless some
// of it was read before the rest could not be: then what was read.
async function closedSlotWordsOfElement(
  tab: Record<string, unknown>,
  cdp: AoiCdpSession,
  selector: string,
  timeout: number,
): Promise<string | null> {
  const node = await protocolNodeOf(tab, cdp, selector, timeout);
  if (node === null) {
    return '';
  }
  const executionContextId = await checkWorldOf(cdp);
  if (executionContextId === null) {
    return null;
  }
  const group = `${CHECK_OBJECT_GROUP}-${Math.random().toString(36).slice(2)}`;
  const objectOf = async (backendNodeId: number): Promise<string | null> => {
    const resolved = (await cdp.send('DOM.resolveNode', {
      backendNodeId,
      executionContextId,
      objectGroup: group,
    })) as { object?: { objectId?: unknown } };
    return typeof resolved.object?.objectId === 'string' ? resolved.object.objectId : null;
  };
  const words: string[] = [];
  const told = () => (words.length > 0 ? words.join(' ') : null);
  try {
    let from = await objectOf(node);
    for (let read = 0; from !== null; read += 1) {
      const path = await slotClimbOf(cdp, from, group);
      if (path === null) {
        return told();
      }
      const slot = closedSlotOnClimb(await describeClimb(cdp, path));
      if (slot === null) {
        return words.join(' ');
      }
      if (slot === undefined || read === MAX_CLOSED_SLOTS) {
        return told();
      }
      from = await objectOf(slot);
      if (from === null) {
        return told();
      }
      const around = (await cdp.send('Runtime.callFunctionOn', {
        objectId: from,
        functionDeclaration: `function () { return (${wordsAroundAcrossShadowTrees})(this, true, ${shownTextIn}, true); }`,
        returnByValue: true,
      })) as { result?: { value?: unknown }; exceptionDetails?: unknown };
      const value = around.exceptionDetails ? undefined : around.result?.value;
      if (typeof value !== 'string') {
        return told();
      }
      if (value) {
        words.push(value);
      }
    }
    return null;
  } catch {
    return told();
  } finally {
    cdp.send('Runtime.releaseObjectGroup', { objectGroup: group }).catch(() => {});
  }
}

// How long a dialog waits for the browser's report of the frame that raised it,
// which comes within moments of Playwright's.
const FRAME_DIALOG_WAIT_MS = 300;
// A report from longer before its dialog came than this is not that dialog's:
// each comes within moments of its own. One its dialog never took -- one that
// came after the wait for it -- is let go.
const FRAME_DIALOG_STALE_MS = 1_000;

/**
 * Whether a dialog was raised in a frame inside the page rather than its top
 * frame -- as the browser reports it, frame and all, on a session of the
 * check's own. Holding such a dialog is what lets a page crash the whole
 * browser: it removes the frame while the dialog waits, and whatever touches
 * the tab next brings the browser down. So it is not held: it is dismissed at
 * once, as Playwright dismisses one nobody listens for. Undefined when there is
 * no session to watch on; false -- held, as before -- when the report cannot be
 * had. Exported for its own tests.
 */
export function watchTopFrameDialogs(
  page: unknown,
): ((dialog: { type(): string; message(): string }) => Promise<boolean>) | undefined {
  const context = (page as { context?: () => unknown }).context?.call(page) as
    | { newCDPSession?: (p: unknown) => Promise<unknown> }
    | undefined;
  if (typeof context?.newCDPSession !== 'function') {
    return undefined;
  }
  const reported: { type: string; message: string; frameId: string; at: number }[] = [];
  const listeners = new Set<() => void>();
  let topFrame: string | null = null;
  const watching = context
    .newCDPSession(page)
    .then(async (session) => {
      const cdp = session as AoiCdpSession & {
        on?(event: string, handler: (params: Record<string, unknown>) => void): void;
      };
      if (typeof cdp.on !== 'function') {
        return;
      }
      cdp.on('Page.javascriptDialogOpening', (params) => {
        reported.push({
          type: String(params.type),
          message: String(params.message),
          frameId: String(params.frameId ?? ''),
          at: Date.now(),
        });
        if (reported.length > 32) {
          reported.shift();
        }
        for (const listener of Array.from(listeners)) {
          listener();
        }
      });
      await cdp.send('Page.enable');
      const { frameTree } = (await cdp.send('Page.getFrameTree')) as {
        frameTree?: { frame?: { id?: unknown } };
      };
      topFrame = typeof frameTree?.frame?.id === 'string' ? frameTree.frame.id : null;
    })
    .catch(() => undefined);
  return async (dialog) => {
    const asked = Date.now();
    await watching;
    if (topFrame === null) {
      return false;
    }
    const take = () => {
      while (reported.length > 0 && reported[0].at < asked - FRAME_DIALOG_STALE_MS) {
        reported.shift();
      }
      const at = reported.findIndex(
        (one) => one.type === dialog.type() && one.message === dialog.message(),
      );
      return at < 0 ? undefined : reported.splice(at, 1)[0];
    };
    const report =
      take() ??
      (await new Promise<(typeof reported)[number] | undefined>((resolve) => {
        const listener = () => {
          const found = take();
          if (found) {
            clearTimeout(timer);
            listeners.delete(listener);
            resolve(found);
          }
        };
        const timer = setTimeout(() => {
          listeners.delete(listener);
          resolve(undefined);
        }, FRAME_DIALOG_WAIT_MS);
        listeners.add(listener);
      }));
    return report !== undefined && report.frameId !== '' && report.frameId !== topFrame;
  };
}

const ACTIONABLE_POLL_MS = 100;
// How Playwright scrolls a target it cannot reach, attempt after attempt: only
// as far as needed, then to the end, the centre and the start of the view -- out
// from under a header or a bar that covers it where it first lands.
const SCROLL_ALIGNMENTS: (ScrollIntoViewOptions | null)[] = [
  null,
  { block: 'end', inline: 'end' },
  { block: 'center', inline: 'center' },
  { block: 'start', inline: 'start' },
];
// What the wait for an uncovered target leaves of the act's time. A target
// still covered then is acted on all the same: Playwright's own check -- which
// never clicks whatever is in the way -- has its turn, and says what covers it.
const UNCOVER_RESERVE_MS = 1_500;

// Closing a page is a CDP round trip; a browser that never answers must not
// hold the session open with it.
const PAGE_CLOSE_DEADLINE_MS = 5_000;

function withCloseDeadline(work: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('page close timed out')), PAGE_CLOSE_DEADLINE_MS);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

export class AoiBrowserDriveStartError extends Error {
  readonly reason: AoiBrowserDriveStartDenyReason;

  constructor(reason: AoiBrowserDriveStartDenyReason, detail?: string) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'AoiBrowserDriveStartError';
    this.reason = reason;
  }
}

/** Bind an ephemeral loopback TCP port, then release it so Chrome can claim it. */
export function pickFreeLoopbackPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        const port = address.port;
        server.close(() => resolve(port));
        return;
      }
      server.close(() => reject(new Error('could not resolve an ephemeral port')));
    });
  });
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll `<userDataDir>/DevToolsActivePort` until Chrome writes the port/ws handshake
 * (proving the debug endpoint is live), or the deadline passes. If the file never
 * appears, the profile was likely already locked by a running browser without the
 * debug flag -> attach_timeout.
 */
export async function pollForAoiDevToolsActivePort(params: {
  userDataDir: string;
  timeoutMs: number;
  fileExists: (path: string) => boolean;
  readFile: (path: string) => string;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}): Promise<AoiDevToolsActivePort> {
  const filePath = join(params.userDataDir, DEVTOOLS_ACTIVE_PORT_FILE);
  const deadline = params.now() + Math.max(1, params.timeoutMs);
  // Bounded by a count as well as the clock: a clock that does not move would
  // otherwise hold this loop forever.
  const maxPolls = Math.ceil(Math.max(1, params.timeoutMs) / DEVTOOLS_POLL_INTERVAL_MS) + 1;
  // Try immediately, then poll until the deadline.
  for (let poll = 0; ; poll += 1) {
    if (params.fileExists(filePath)) {
      try {
        const parsed = parseAoiDevToolsActivePort(params.readFile(filePath));
        if (parsed) {
          return parsed;
        }
      } catch {
        // File may be mid-write; fall through and retry.
      }
    }
    if (params.now() >= deadline || poll >= maxPolls) {
      throw new AoiBrowserDriveStartError('attach_timeout', 'DevToolsActivePort never appeared');
    }
    await params.sleep(DEVTOOLS_POLL_INTERVAL_MS);
  }
}

const lazyConnect: AoiBrowserDriveConnect = async (cdpHttpEndpoint) => {
  // Lazy runtime import so the client bundle never pulls playwright-core and the
  // daemon externalizes it. Structurally typed to our minimal surface.
  const mod = (await import('playwright-core')) as unknown as {
    chromium: { connectOverCDP: (endpoint: string) => Promise<AoiBrowserDriveBrowser> };
  };
  return mod.chromium.connectOverCDP(cdpHttpEndpoint);
};

/**
 * Launch + attach + open an Aoi-only page. Returns a session handle whose close()
 * tears down ONLY the Aoi page (never the shared browser).
 */
/**
 * Ask http://127.0.0.1:<port>/json/version for the browser WebSocket URL.
 *
 * This replaced waiting for a DevToolsActivePort FILE, which current Chrome no
 * longer writes. Verified against Chrome 151: the browser starts, DevTools
 * listens, and that file appears nowhere -- not in the profile, not in temp --
 * so the wait could only ever time out. Worse, it timed out as "attach_timeout:
 * DevToolsActivePort never appeared", which reads as "the browser did not
 * start" when the browser had started perfectly well.
 *
 * The HTTP endpoint is the documented way to discover this and answered in
 * ~400ms on the same machine. The port is ours -- we pass it on the command
 * line -- so nothing is being guessed here.
 */
async function probeAoiDevToolsEndpoint(port: number): Promise<string | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      // The endpoint is loopback and answers instantly when it is up; a long
      // wait here would just delay the retry.
      signal: AbortSignal.timeout(1_500),
    });
    if (!response.ok) {
      return null;
    }
    const payload = (await response.json()) as { webSocketDebuggerUrl?: unknown };
    const url = payload?.webSocketDebuggerUrl;
    return typeof url === 'string' && url.startsWith('ws://') ? url : null;
  } catch {
    // Not up yet, or not answering. The caller retries.
    return null;
  }
}

export async function startAoiBrowserDriveSession(
  options: AoiBrowserDriveStartOptions = {},
  deps: AoiBrowserDriveSessionDeps = {},
): Promise<AoiBrowserDriveSession> {
  const spawnImpl = deps.spawnImpl ?? spawn;
  const resolveExecutable =
    deps.resolveExecutable ??
    ((overridePath?: string) => resolveAoiHostBrowserExecutable({ overridePath }));
  const pickPort = deps.pickPort ?? pickFreeLoopbackPort;
  const readFile = deps.readFile ?? ((path: string) => fs.readFileSync(path, 'utf8'));
  // lstat, not exists: on macOS and Linux Chrome's SingletonLock is a symlink to
  // nothing, which existsSync follows and calls missing -- so a running profile
  // read as idle there, and every second session timed out launching again.
  const fileExists =
    deps.fileExists ??
    ((path: string) => {
      try {
        fs.lstatSync(path);
        return true;
      } catch {
        return false;
      }
    });
  const writeFile =
    deps.writeFile ?? ((path: string, data: string) => fs.writeFileSync(path, data, 'utf8'));
  const connect = deps.connect ?? lazyConnect;
  const probeDevTools = deps.probeDevTools ?? probeAoiDevToolsEndpoint;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? realSleep;

  const engine: AoiBrowserDriveEngine = options.engine === 'edge' ? 'edge' : 'chrome';
  const executable = resolveExecutable(options.browserExecutablePath);
  if (!executable) {
    throw new AoiBrowserDriveStartError('browser_not_found', 'no Chrome/Edge executable resolved');
  }

  const resolveDefaultUserDataDir =
    deps.resolveDefaultUserDataDir ??
    ((engineKind: AoiBrowserDriveEngine) => resolveAoiBrowserDriveDefaultUserDataDir(engineKind));
  // The profile is REQUIRED; there is deliberately no fallback.
  //
  // The obvious fallback -- the browser's own default profile -- is the one
  // directory that can never work: Chrome 136+ refuses remote debugging there.
  // Falling back to it produced an attempt that looked reasonable and then
  // failed seconds later complaining about a missing DevTools port, which is a
  // symptom of an entirely different problem and sends you looking in the wrong
  // place. A caller with no profile has not been configured yet, and hearing
  // that immediately is more useful than a plausible-looking failure.
  const userDataDir = typeof options.userDataDir === 'string' ? options.userDataDir.trim() : '';
  if (!userDataDir) {
    throw new AoiBrowserDriveStartError(
      'user_data_dir_unresolved',
      'no browser profile is configured. Chrome refuses remote debugging on its own default ' +
        'profile, so this needs a separate signed-in profile directory: set it in Settings > ' +
        'Advanced > Host bridge > Browser profile.',
    );
  }

  // And refuse the default profile even when it is named explicitly, so the same
  // impossible configuration cannot be reached the long way round.
  //
  // BOTH engines, not just the one being launched. The settings route validates
  // against both, but a hand-edited config never passes through it, and pointing
  // Chrome at Edge's default directory is just as unusable as pointing it at its
  // own -- checking only the launching engine would let exactly that through.
  const requestedDir = resolve(userDataDir).toLowerCase();
  const browserDefault = (['chrome', 'edge'] as const)
    .map((kind) => resolveDefaultUserDataDir(kind))
    .find((dir) => Boolean(dir) && resolve(dir as string).toLowerCase() === requestedDir);
  if (browserDefault) {
    throw new AoiBrowserDriveStartError(
      'user_data_dir_unresolved',
      'that is the browser default profile, which refuses remote debugging. Use a separate ' +
        'signed-in profile directory.',
    );
  }

  let child: ChildProcess | null = null;
  let handshake: AoiDevToolsActivePort;
  // A browser launched on this profile by an earlier session is still running --
  // close() leaves it up on purpose. Launching again handed the command line to
  // that instance and exited, so the new debug port never opened and every
  // second session (an approved execute right after its preview) timed out.
  const reattached = await findRunningAoiBrowserDriveProfile(userDataDir, {
    fileExists,
    readFile,
    probeDevTools,
  });
  if (reattached) {
    handshake = reattached;
  } else {
    const launched = await launchAoiBrowserDriveProfile({
      executablePath: executable.path,
      userDataDir,
      headless: options.headless === true,
      requestedTimeoutMs: options.timeoutMs,
      spawnImpl,
      pickPort,
      probeDevTools,
      fileExists,
      readFile,
      now,
      sleep,
    });
    child = launched.child;
    handshake = launched.handshake;
    recordAoiBrowserDriveProfilePort(userDataDir, handshake, writeFile);
  }

  // Chrome may pick its own port (we passed a concrete one, but honor the handshake).
  const cdpHttpEndpoint = buildAoiBrowserDriveCdpHttpEndpoint(handshake.port);
  // Straight to the browser's own socket when its path is known. Given the HTTP
  // endpoint, Playwright asks it where the socket is and goes wherever the
  // answer says -- and the answer is only as trustworthy as whatever holds the
  // port.
  // (Both ways of learning the path -- the probe and the port file -- only
  // ever yield one that starts with '/'.)
  const endpoint = handshake.wsPath
    ? buildAoiBrowserDriveCdpWsEndpoint(handshake.port, handshake.wsPath)
    : cdpHttpEndpoint;

  let browser: AoiBrowserDriveBrowser;
  try {
    browser = await connect(endpoint);
  } catch (error) {
    safeKill(child);
    throw new AoiBrowserDriveStartError(
      'connect_failed',
      error instanceof Error ? error.message : String(error),
    );
  }

  let page: AoiBrowserDrivePage;
  try {
    const context = browser.contexts()[0];
    if (!context) {
      throw new Error('no browser context available over CDP');
    }
    page = await context.newPage();
  } catch (error) {
    // Do NOT kill the shared browser on a page-open failure; just drop the connection.
    await safeCloseBrowser(browser);
    throw new AoiBrowserDriveStartError(
      'connect_failed',
      error instanceof Error ? error.message : String(error),
    );
  }

  // Playwright's Page covers click/fill/hover/dragAndDrop/setInputFiles
  // directly, but dialogs arrive as an EVENT and tabs live on the context, so
  // neither is reachable through the page alone. Attach both and expose them as
  // ordinary methods, which is what the executor's capability checks look for.
  //
  // Tab selection has to REDIRECT the page, not merely record a choice: every
  // later step goes through this same object, so a switch that did not redirect
  // would leave the caller acting on a tab nobody chose. Delivery is forwarded
  // to whichever page the tab handle says is current.
  // Detect, do not assume. The page contract this module declares is url() +
  // close(); everything else is a Playwright extra. A session factory that
  // satisfies the declared contract must not crash here, so each capability is
  // attached only if the underlying object really provides what it needs -- and
  // when it does not, the executor reports "this session cannot ..." , which is
  // the honest fail-closed answer rather than a TypeError mid-run.
  const rawPage = page as unknown as AoiBrowserDriveRawPage;
  const rawContext = browser.contexts()[0] as unknown as AoiBrowserDriveRawContext;
  // Aoi's own tab's goto, kept before the tab forwarders replace it: what a
  // dialog of this tab's makes leave is this tab, whichever one the drive has
  // gone on to -- another tab's page is someone else's work.
  const ownGoto = (rawPage as unknown as { goto?: unknown }).goto;
  const leaveOwnTab =
    typeof ownGoto === 'function'
      ? () =>
          Promise.resolve()
            .then(() =>
              (ownGoto as (url: string, o?: object) => Promise<unknown>).call(
                rawPage,
                'about:blank',
                { timeout: PAGE_CLOSE_DEADLINE_MS },
              ),
            )
            .catch(() => undefined)
      : undefined;
  const dialogs =
    typeof rawPage?.on === 'function'
      ? attachAoiBrowserDriveDialogs(rawPage, {
          fromAFrame: watchTopFrameDialogs(rawPage),
          leave: leaveOwnTab,
        })
      : null;
  const tabs =
    typeof rawContext?.pages === 'function' ? attachAoiBrowserDriveTabs(rawContext, rawPage) : null;

  const target = () => (tabs ? tabs.currentPage() : rawPage) as unknown as Record<string, unknown>;
  const own = page as unknown as Record<string, unknown>;

  // Keep the ORIGINAL methods before any of them are replaced.
  //
  // Forwarding cannot simply look the method up on the current page, because
  // when the current page is Aoi's own tab that IS the object whose methods were
  // replaced -- so the lookup finds the forwarder and calls itself until the
  // stack runs out. That is not an exotic case: it is every ordinary act, since
  // most drives never switch tabs at all.
  const originals = new Map<string, (...args: unknown[]) => unknown>();

  const forward =
    (method: string) =>
    (...args: unknown[]): unknown => {
      const current = target();
      // Own tab: use the method we saved, not the one we overwrote.
      const fn = current === own ? originals.get(method) : (current[method] as unknown);
      if (typeof fn !== 'function') {
        throw new Error(`the current tab cannot ${method}`);
      }
      return (fn as (...inner: unknown[]) => unknown).apply(current, args);
    };

  // Only the members the executor actually calls are forwarded; anything else
  // keeps pointing at the page this session opened.
  const FORWARDED = [
    'click',
    'fill',
    'selectOption',
    'press',
    'hover',
    'dragAndDrop',
    'setInputFiles',
    'goto',
    'goBack',
    'content',
    'title',
    'screenshot',
    'textContent',
    'getAttribute',
    'inputValue',
    'innerText',
    'waitForLoadState',
    'focus',
  ];
  const drivable = page as unknown as Record<string, unknown>;
  // Forwarding only matters when tabs can actually change which page is current.
  // Without that, rewriting these members would be pure indirection over the
  // same object -- and one more place for a mistake to hide.
  if (tabs) {
    for (const method of FORWARDED) {
      const existing = drivable[method];
      if (typeof existing === 'function') {
        // Bind to the page it came from: Playwright methods carry internal
        // state through `this`, and a detached reference would lose it.
        originals.set(method, (existing as (...args: unknown[]) => unknown).bind(page));
        drivable[method] = forward(method);
      }
    }
    const ownUrl = drivable.url;
    if (typeof ownUrl === 'function') {
      originals.set('url', (ownUrl as (...args: unknown[]) => unknown).bind(page));
    }
    drivable.url = () => {
      const current = target();
      const fn = current === own ? originals.get('url') : current.url;
      return typeof fn === 'function' ? (fn as () => string).call(current) : '';
    };
    drivable.listTabs = tabs.listTabs;
    drivable.selectTab = tabs.selectTab;
    drivable.returnToOwnTab = () => {
      tabs.returnToOwnTab();
    };
    drivable.isOnOwnTab = () => tabs.isOnOwnTab();
  }
  // What the live-DOM check needs to find the element an act really reaches,
  // and to judge it only once it could take the act. Through whichever tab is
  // current; both read in Playwright's isolated world, out of the page's reach.
  const current = () => target() as unknown as Record<string, (...args: unknown[]) => unknown>;
  // A key pressed wherever focus is, on whichever tab is current.
  if (typeof (page as unknown as { keyboard?: unknown }).keyboard === 'object') {
    drivable.keyboardPress = async (key: string) => {
      const keyboard = current().keyboard as unknown as { press(k: string): Promise<void> };
      await keyboard.press(key);
    };
  }
  if (typeof (page as unknown as { locator?: unknown }).locator === 'function') {
    // A count has no timeout of its own in Playwright: one is put on it here.
    drivable.countMatches = async (selector: string) => {
      const locate = current().locator as (s: string) => { count(): Promise<number> };
      return withinDeadline(locate.call(current(), selector).count(), PAGE_CALL_DEADLINE_MS);
    };
    drivable.ariaSnapshot = async (selector: string, options?: { timeout?: number }) => {
      const locate = current().locator as (s: string) => {
        ariaSnapshot(o?: { timeout?: number }): Promise<string>;
      };
      return locate.call(current(), selector).ariaSnapshot(options);
    };
    // Both run in the page's own world: bounded here, and whatever comes back
    // that is not a string is no answer. A form too large to read through is
    // not one with nothing to commit.
    drivable.formOwnerDefaultWords = async (selector: string, options?: { timeout?: number }) => {
      const locate = current().locator as (s: string) => AoiWaitableLocator;
      const timeout = options?.timeout ?? PAGE_CALL_DEADLINE_MS;
      let words: unknown;
      try {
        words = await withinDeadline(
          locate
            .call(current(), selector)
            .evaluate(formOwnerDefaultButtonWords, undefined, { timeout }),
          timeout,
        );
      } catch (error) {
        if (error instanceof Error && error.message.includes(FORM_TOO_LARGE)) {
          throw Object.assign(new Error('the form Enter would submit is too large to read'), {
            name: 'TooMuchToReadError',
          });
        }
        throw error;
      }
      return typeof words === 'string' ? words.slice(0, MAX_FORM_OWNER_WORDS_CHARS) : '';
    };
    drivable.wordsOutsideShadow = async (
      selector: string,
      options?: { timeout?: number; onward?: boolean },
    ) => {
      const locate = current().locator as (s: string) => AoiWaitableLocator;
      const timeout = options?.timeout ?? PAGE_CALL_DEADLINE_MS;
      const words: unknown = await withinDeadline(
        locate
          .call(current(), selector)
          .evaluate(wordsAroundInPage, options?.onward === true, { timeout }),
        timeout,
      );
      return typeof words === 'string' ? words.slice(0, 600) : '';
    };
  }
  // The wait dispatches nothing. A trial click was not inert: it still sent a
  // real click event that a window-level listener sees, before the act had
  // been judged at all. So: visible, then enabled (or editable, for typing) --
  // read, never pressed.
  drivable.waitForActionable = async (
    selector: string,
    kind: string,
    options: { timeout: number; toSelector?: string },
  ) => {
    const locate = current().locator as ((s: string) => AoiWaitableLocator) | undefined;
    if (typeof locate !== 'function') {
      return;
    }
    const first = (s: string) => locate.call(current(), s).first();
    const deadline = Date.now() + options.timeout;
    const left = () => Math.max(1, deadline - Date.now());
    // A target that cannot answer yet is waited for; one that answers it can
    // never be (not a field, for typing) fails now, as the act would.
    const until = async (check: () => Promise<boolean>, what: string) => {
      for (;;) {
        const answered = await check().catch((error: unknown) => {
          if (error instanceof Error && error.name === 'TimeoutError') {
            return false;
          }
          throw error;
        });
        if (answered) {
          return;
        }
        if (Date.now() >= deadline) {
          throw new Error(`the target did not become ${what} within ${options.timeout} ms`);
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, ACTIONABLE_POLL_MS));
      }
    };
    const target = first(selector);
    // A file input or a key press only needs the element to be there.
    if (kind === 'upload' || kind === 'press') {
      await target.waitFor({ state: 'attached', timeout: options.timeout });
      return;
    }
    await target.waitFor({ state: 'visible', timeout: options.timeout });
    if (kind === 'type') {
      await until(() => target.isEditable({ timeout: left() }), 'editable');
    } else if (kind !== 'hover') {
      await until(() => target.isEnabled({ timeout: left() }), 'enabled');
    }
    if (kind === 'drag' && options.toSelector) {
      await first(options.toSelector).waitFor({ state: 'visible', timeout: left() });
    }
    // And uncovered, for what a pointer does: scrolled the ways Playwright would,
    // for as long as the act's time allows.
    if (kind !== 'type' && kind !== 'select') {
      const giveUpAt = deadline - UNCOVER_RESERVE_MS;
      const untilGiveUp = () => Math.max(1, giveUpAt - Date.now());
      for (let attempt = 0; ; attempt += 1) {
        const alignment = SCROLL_ALIGNMENTS[attempt % SCROLL_ALIGNMENTS.length];
        // The scroll and the look run in the page's world, which can make either
        // hang: each is bounded here too.
        await withinDeadline(
          alignment
            ? target.evaluate(
                (element, options) => {
                  Element.prototype.scrollIntoView.call(element, options);
                },
                alignment,
                { timeout: untilGiveUp() },
              )
            : target.scrollIntoViewIfNeeded({ timeout: untilGiveUp() }),
          untilGiveUp(),
        ).catch(() => undefined);
        const reached =
          (await withinDeadline(
            target.evaluate(reachedWherePlaywrightAims, undefined, { timeout: untilGiveUp() }),
            untilGiveUp(),
          ).catch(() => false)) === true;
        if (reached || Date.now() >= giveUpAt) {
          return;
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, ACTIONABLE_POLL_MS));
      }
    }
  };
  // Where a click on an element lands, as the browser has it: Playwright's aim
  // point, the browser's own hit test there, and its accessibility tree's names
  // for what is there -- over the DevTools protocol, which sees into closed
  // shadow trees and which no page script reaches. One protocol session per
  // tab, kept until it fails. And one for each read for the accessibility
  // tree (accessibilitySessionOf), whose reads can be slow: nothing else waits
  // behind them.
  const cdpSessions = new WeakMap<object, Promise<AoiCdpSession | null>>();
  const sessionFor = (
    sessions: WeakMap<object, Promise<AoiCdpSession | null>>,
    tab: Record<string, unknown>,
  ): Promise<AoiCdpSession | null> => {
    let session = sessions.get(tab);
    if (!session) {
      const context = (
        tab.context as (() => { newCDPSession(p: unknown): Promise<AoiCdpSession> }) | undefined
      )?.call(tab);
      const opening = context
        ? context.newCDPSession(tab).catch(() => null)
        : Promise.resolve(null);
      // One that could not be opened is opened again next time.
      session = opening.then((opened) => {
        if (opened === null && sessions.get(tab) === session) {
          sessions.delete(tab);
        }
        return opened;
      });
      sessions.set(tab, session);
    }
    return session;
  };
  if (
    typeof (page as unknown as { context?: unknown }).context === 'function' &&
    typeof (page as unknown as { locator?: unknown }).locator === 'function'
  ) {
    // A read over the current tab's protocol session, bounded; a session that
    // failed is not asked again -- the next read opens one.
    const overProtocol = async <T>(
      timeout: number,
      read: (
        tab: Record<string, unknown>,
        cdp: AoiCdpSession,
        ax: AoiCdpSession,
      ) => Promise<T | null>,
      // Whether the read asks the accessibility tree: then on a session of its
      // own for this read.
      accessibility = false,
    ): Promise<T | null> => {
      const tab = current();
      const opened: { cdp: AoiCdpSession | null; ax: AoiCdpSession | null } = {
        cdp: null,
        ax: null,
      };
      try {
        return await withinDeadline(
          (async () => {
            [opened.cdp, opened.ax] = await Promise.all([
              sessionFor(cdpSessions, tab),
              accessibility ? accessibilitySessionOf(tab, tab) : Promise.resolve(null),
            ]);
            try {
              return opened.cdp ? await read(tab, opened.cdp, opened.ax ?? opened.cdp) : null;
            } finally {
              opened.ax?.detach?.().catch(() => {});
            }
          })(),
          timeout,
        );
      } catch (error) {
        if (opened.cdp && !(error instanceof Error && error.name === 'TimeoutError')) {
          cdpSessions.delete(tab);
          opened.cdp.detach?.().catch(() => {});
        }
        throw error;
      }
    };
    drivable.aimPointReadOut = (selector: string, options?: { timeout?: number }) => {
      const timeout = options?.timeout ?? PAGE_CALL_DEADLINE_MS;
      return overProtocol(
        timeout,
        (tab, cdp, ax) => readAimPoint(tab, cdp, ax, selector, timeout),
        true,
      );
    };
    drivable.readOutOf = (selector: string, options?: { timeout?: number }) => {
      const timeout = options?.timeout ?? PAGE_CALL_DEADLINE_MS;
      return overProtocol(
        timeout,
        (tab, cdp, ax) => readOutOfElement(tab, cdp, ax, selector, timeout),
        true,
      );
    };
    drivable.closedSlotWordsOf = (selector: string, options?: { timeout?: number }) => {
      const timeout = options?.timeout ?? PAGE_CALL_DEADLINE_MS;
      return overProtocol(timeout, (tab, cdp) =>
        closedSlotWordsOfElement(tab, cdp, selector, timeout),
      );
    };
    // The closed slots of climbs had for a check's boxes, kept by what the
    // check hands each of their measures (`together`) for as long as it holds
    // that, and for no other check.
    const keptClimbs = new WeakMap<object, KeptClimbs>();
    drivable.shownTextOf = (
      selector: string,
      options?: { timeout?: number; limit?: number; from?: string; together?: object },
    ) => {
      const timeout = options?.timeout ?? PAGE_CALL_DEADLINE_MS;
      const limit = Math.max(0, Math.min(Math.floor(options?.limit ?? 80), 10_000));
      const together = options?.together;
      let kept: KeptClimbs | undefined;
      if (typeof together === 'object' && together !== null) {
        kept = keptClimbs.get(together) ?? new Map();
        keptClimbs.set(together, kept);
      }
      return overProtocol(timeout, (tab, cdp) =>
        shownTextOfElement(tab, cdp, selector, timeout, limit, kept, options?.from),
      );
    };
  }
  // Focus where Playwright's fill puts it -- a label's control, the field around
  // what is named -- with its text selected, as fill does, and nothing typed:
  // the field is judged as focus leaves it before the text goes in.
  if (typeof (page as unknown as { locator?: unknown }).locator === 'function') {
    drivable.focusToFill = async (selector: string, options?: { timeout?: number }) => {
      const locate = current().locator as (s: string) => {
        selectText(o?: { timeout?: number }): Promise<void>;
      };
      await locate.call(current(), selector).selectText(options);
    };
  }
  // The rest of a wait a click's own call ran out of time for: the next frame
  // to navigate, on whichever tab is current.
  if (typeof (page as unknown as { waitForEvent?: unknown }).waitForEvent === 'function') {
    drivable.waitForFrameNavigation = async (options: { timeout: number }) => {
      const waitForEvent = current().waitForEvent as (
        event: string,
        options: { timeout: number },
      ) => Promise<unknown>;
      await waitForEvent.call(current(), 'framenavigated', { timeout: options.timeout });
    };
  }
  if (dialogs) {
    // Dialogs are only held on Aoi's own tab. Another tab has no listener, so
    // the browser connection dismisses its dialogs itself; a dialog queued on
    // Aoi's tab says nothing about the tab the drive is acting on, and must not
    // be answered from there.
    const onOwnTab = () => !tabs || tabs.isOnOwnTab();
    drivable.answerDialog = (
      disposition: 'accept' | 'dismiss',
      promptText?: string,
      answer?: AoiBrowserDriveDialogAnswer,
    ) =>
      onOwnTab()
        ? dialogs.answerDialog(disposition, promptText, answer)
        : Promise.reject(
            new Error(
              "dialogs are only answered on the tab Aoi opened; this tab's are dismissed by the browser",
            ),
          );
    drivable.pendingDialog = () => (onOwnTab() ? dialogs.pendingDialog() : null);
  }
  // Saving a download is the same story as dialogs: the file arrives as an event
  // and is discarded unless something writes it out, so a plain Page cannot do
  // it. Attached only when the page can actually wait for one.
  if (typeof (page as unknown as { waitForEvent?: unknown }).waitForEvent === 'function') {
    drivable.downloadTo = (selector: string, directory: string, opts?: { timeout?: number }) =>
      downloadAoiBrowserDriveFile(
        target() as unknown as AoiBrowserDriveDownloadablePage,
        selector,
        directory,
        opts ?? {},
      );
  }

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) {
      return;
    }
    closed = true;
    // Close ONLY Aoi's page; the shared browser stays up (the user is using it).
    //
    // The page goes BEFORE its dialogs are answered. An act can still be
    // waiting behind a dialog -- the call stopped waiting for it when the dialog
    // showed -- and dismissing the dialog first would let that act through, to
    // a page nobody is looking at any more. Closing first means it never lands.
    try {
      await withCloseDeadline(page.close());
    } catch {
      // best-effort teardown
    }
    // Then anything still queued: if the close failed, a dialog this session
    // took responsibility for would otherwise keep the tab blocked after Aoi
    // has gone.
    if (dialogs) {
      await dialogs.releasePendingDialogs().catch(() => {});
    }
    // Then release the CDP client. Over connectOverCDP, close() DISCONNECTS --
    // measured against Chrome 151: the browser stays running, the operator's
    // tabs survive, and a later attach reconnects fine. Leaving it out did not
    // keep anything safe; it just leaked one websocket and one Playwright
    // browser object per act, for the whole life of the daemon.
    await safeCloseBrowser(browser);
  };

  return {
    browser,
    page,
    port: handshake.port,
    cdpHttpEndpoint,
    engine,
    userDataDir,
    child,
    close,
  };
}

// Launch a browser on the profile with a fresh debug port and wait for it to
// answer. Kept apart from the session setup so a running instance can be
// attached to instead.
async function launchAoiBrowserDriveProfile(params: {
  executablePath: string;
  userDataDir: string;
  headless: boolean;
  requestedTimeoutMs: number | undefined;
  spawnImpl: typeof spawn;
  pickPort: () => Promise<number>;
  probeDevTools: (port: number) => Promise<string | null>;
  fileExists: (path: string) => boolean;
  readFile: (path: string) => string;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}): Promise<{ child: ChildProcess; handshake: AoiDevToolsActivePort }> {
  const {
    executablePath,
    userDataDir,
    headless,
    requestedTimeoutMs,
    spawnImpl,
    pickPort,
    probeDevTools,
    fileExists,
    readFile,
    now,
    sleep,
  } = params;
  let port: number;
  try {
    port = await pickPort();
  } catch (error) {
    throw new AoiBrowserDriveStartError(
      'port_unavailable',
      error instanceof Error ? error.message : String(error),
    );
  }

  const args = buildAoiBrowserDriveLaunchArgs({
    port,
    userDataDir,
    headless,
  });

  let child: ChildProcess;
  try {
    child = spawnImpl(executablePath, args, {
      shell: false,
      windowsHide: false,
      stdio: ['ignore', 'ignore', 'ignore'],
      detached: false,
    });
  } catch (error) {
    throw new AoiBrowserDriveStartError(
      'spawn_failed',
      error instanceof Error ? error.message : String(error),
    );
  }

  const timeoutMs = Math.min(
    MAX_ATTACH_TIMEOUT_MS,
    Math.max(1_000, requestedTimeoutMs ?? DEFAULT_ATTACH_TIMEOUT_MS),
  );

  let handshake: AoiDevToolsActivePort;
  try {
    // Ask the browser directly first. The DevToolsActivePort file is a legacy
    // signal that current Chrome does not write at all, so the file poll is kept
    // only as a fallback for older builds -- it can no longer be the primary
    // path without the attach failing on every modern browser.
    const deadline = now() + timeoutMs;
    const probeIntervalMs = 200;
    // Bounded by BOTH the clock and a count. The clock is injected, so a caller
    // that holds it still -- every test harness does -- would otherwise turn
    // this into a tight loop that never ends and never reports anything.
    const maxProbes = Math.max(1, Math.ceil(timeoutMs / probeIntervalMs));
    let socketUrl: string | null = null;
    for (let attempt = 0; attempt < maxProbes && now() < deadline; attempt += 1) {
      socketUrl = await probeDevTools(port);
      if (loopbackSocketPath(socketUrl, port)) {
        break;
      }
      await sleep(probeIntervalMs);
    }
    // An answer whose socket is not on this port of this machine did not come
    // from the browser just started here, and nothing connects to it: Playwright
    // would go wherever it points. Only the profile's own port file is left then.
    const socketPath = loopbackSocketPath(socketUrl, port);
    if (socketPath) {
      handshake = { port, wsPath: socketPath };
    } else {
      handshake = await pollForAoiDevToolsActivePort({
        userDataDir,
        // Whatever is left of the budget; the probe already spent most of it.
        timeoutMs: Math.max(1_000, deadline - now()),
        fileExists,
        readFile,
        now,
        sleep,
      });
    }
  } catch (error) {
    safeKill(child);
    if (error instanceof AoiBrowserDriveStartError && error.reason === 'attach_timeout') {
      // A browser already running on this profile is the usual cause, and it
      // fails in the least helpful way: the second launch hands its command line
      // to the running instance and exits, so no debug port ever opens and the
      // wait times out talking about DevTools. Chrome keeps a `lockfile` in the
      // profile while it is running, so say what is actually in the way.
      //
      // Reported, not enforced: a crashed browser can leave the file behind, and
      // refusing on a stale marker would block a profile that is perfectly free.
      let profileBusy = false;
      try {
        profileBusy =
          fileExists(`${userDataDir}\\lockfile`) || fileExists(`${userDataDir}/lockfile`);
      } catch {
        profileBusy = false;
      }
      if (profileBusy) {
        throw new AoiBrowserDriveStartError(
          'attach_timeout',
          'the debug port never opened, and this profile has a lockfile. That usually means a ' +
            'browser window is open on it -- close the window and try again. If none is open, a ' +
            'previous browser was killed and left the file behind; deleting it is safe.',
        );
      }
    }
    if (error instanceof AoiBrowserDriveStartError) {
      throw error;
    }
    throw new AoiBrowserDriveStartError(
      'attach_timeout',
      error instanceof Error ? error.message : String(error),
    );
  }

  return { child, handshake };
}

// The port this module last launched the profile's browser on, kept in the
// profile itself. JSON with its own key, so nothing else in the directory can
// be misread as one.
const AOI_BROWSER_DRIVE_PORT_RECORD = 'aoi-drive-port.json';

// The port AND the browser's own socket path, which is unique to that run of
// the browser: a port can be taken by something else once the browser is gone,
// the path cannot.
function recordAoiBrowserDriveProfilePort(
  userDataDir: string,
  handshake: AoiDevToolsActivePort,
  writeFile: (path: string, data: string) => void,
): void {
  try {
    writeFile(
      join(userDataDir, AOI_BROWSER_DRIVE_PORT_RECORD),
      JSON.stringify({ aoiDrivePort: handshake.port, aoiDriveWsPath: handshake.wsPath }),
    );
  } catch {
    // Best-effort: without the record the next session simply launches.
  }
}

// The path of a browser DevTools socket on THIS port of this machine, or null.
// A DevTools answer names its own socket; one that points anywhere else -- off
// loopback, or at another port -- did not come from the browser on this port.
function loopbackSocketPath(socketUrl: string | null, port: number): string | null {
  if (!socketUrl) {
    return null;
  }
  try {
    const parsed = new URL(socketUrl);
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
    return parsed.protocol === 'ws:' &&
      loopback &&
      Number(parsed.port) === port &&
      /^\/devtools\/browser\/[\w-]+$/.test(parsed.pathname)
      ? parsed.pathname
      : null;
  } catch {
    return null;
  }
}

/**
 * The browser already running on this profile, if it is one this module
 * launched and it still answers on the port recorded for it. The profile must
 * be in use (Chrome keeps a lock file in it while it runs), and the recorded
 * port must answer with the very socket recorded for it: a port says nothing
 * about who holds it now, and attaching to whatever does would hand the drive
 * to another browser -- the operator's own, signed in everywhere. Anything less
 * and the caller launches as before.
 */
export async function findRunningAoiBrowserDriveProfile(
  userDataDir: string,
  deps: {
    fileExists: (path: string) => boolean;
    readFile: (path: string) => string;
    probeDevTools: (port: number) => Promise<string | null>;
  },
): Promise<AoiDevToolsActivePort | null> {
  let inUse = false;
  try {
    inUse = ['lockfile', 'SingletonLock'].some((name) => deps.fileExists(join(userDataDir, name)));
  } catch {
    inUse = false;
  }
  if (!inUse) {
    return null;
  }
  let port: unknown;
  let recordedPath: unknown;
  try {
    const record = JSON.parse(deps.readFile(join(userDataDir, AOI_BROWSER_DRIVE_PORT_RECORD))) as {
      aoiDrivePort?: unknown;
      aoiDriveWsPath?: unknown;
    } | null;
    port = record?.aoiDrivePort;
    recordedPath = record?.aoiDriveWsPath;
  } catch {
    return null;
  }
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1024 || port > 65_535) {
    return null;
  }
  // A record from before the path was kept cannot be checked, so it is not used.
  if (typeof recordedPath !== 'string' || !recordedPath) {
    return null;
  }
  const wsPath = loopbackSocketPath(await deps.probeDevTools(port), port);
  if (!wsPath || wsPath !== recordedPath) {
    return null;
  }
  return { port, wsPath };
}

function safeKill(child: ChildProcess | null): void {
  if (!child) {
    return;
  }
  try {
    child.kill();
  } catch {
    // best-effort
  }
}

async function safeCloseBrowser(browser: AoiBrowserDriveBrowser): Promise<void> {
  try {
    await browser.close();
  } catch {
    // best-effort
  }
}
