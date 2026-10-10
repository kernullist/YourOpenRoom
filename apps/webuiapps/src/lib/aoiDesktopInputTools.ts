// Desktop-input tools (DI4): the model-facing surface for driving real windows.
//
// The pattern is deliberately the same one browser-drive uses, because it is the
// pattern that survives contact with an unreliable world: look, address by ref,
// act, then READ THE VERDICT. What the model is told about a result matters as
// much as the result -- an act tool that says "ok" and nothing else teaches Aoi
// to report success whenever the call did not throw, which is the exact failure
// this whole contract exists to remove.
//
// So every act result carries an explicit `status` and a `note` telling Aoi what
// it may and may not say. There is no arrangement of these fields that reads as
// "it worked" unless something actually proved it did.
import type { ToolDef } from './llmClient';
import {
  AoiHostBridgeRequestError,
  AoiHostBridgeTimeoutError,
  actOnAoiHostDesktopElement,
  captureAoiHostDesktopWindow,
  clickAoiHostDesktopPoint,
  listAoiHostDesktopApps,
  listAoiHostDesktopWindows,
  sendAoiHostDesktopWindowInput,
  snapshotAoiHostDesktopWindow,
  type AoiHostDesktopActView,
  type AoiHostDesktopElementView,
  type AoiHostDesktopSnapshotView,
  type AoiHostDesktopWindowView,
} from './aoiHostBridgeClient';
import { defuseRoleMarkers } from './aoiUntrustedText';

// A refused call must not read as an ambiguous failure. "Nothing happened" is
// the fact that matters, and it belongs in the same shape as every other result.
function notPerformed(reason: string): Record<string, unknown> {
  return {
    ok: false,
    status: 'not_performed',
    error: reason,
    code: 'bad_request',
    note: 'Nothing was done. Fix the call and try again; do not describe this as done.',
  };
}

export const DESKTOP_WINDOWS_TOOL = 'desktop_windows';
export const DESKTOP_APPS_TOOL = 'desktop_apps';
export const DESKTOP_SNAPSHOT_TOOL = 'desktop_snapshot';
export const DESKTOP_ACT_TOOL = 'desktop_act';
export const DESKTOP_CLICK_TOOL = 'desktop_click';
export const DESKTOP_KEY_TOOL = 'desktop_key';
export const DESKTOP_TYPE_TOOL = 'desktop_type';
export const DESKTOP_SCROLL_TOOL = 'desktop_scroll';
export const DESKTOP_DRAG_TOOL = 'desktop_drag';
export const DESKTOP_FOCUS_TOOL = 'desktop_focus';
export const DESKTOP_SELECT_TOOL = 'desktop_select';
export const DESKTOP_TOGGLE_TOOL = 'desktop_toggle';
export const DESKTOP_CLICK_POINT_TOOL = 'desktop_click_point';
export const DESKTOP_CAPTURE_TOOL = 'desktop_capture';

const DESKTOP_INPUT_TOOLS: ReadonlySet<string> = new Set([
  DESKTOP_WINDOWS_TOOL,
  DESKTOP_APPS_TOOL,
  DESKTOP_SNAPSHOT_TOOL,
  DESKTOP_ACT_TOOL,
  DESKTOP_CLICK_TOOL,
  DESKTOP_KEY_TOOL,
  DESKTOP_TYPE_TOOL,
  DESKTOP_SCROLL_TOOL,
  DESKTOP_DRAG_TOOL,
  DESKTOP_FOCUS_TOOL,
  DESKTOP_SELECT_TOOL,
  DESKTOP_TOGGLE_TOOL,
  DESKTOP_CLICK_POINT_TOOL,
  DESKTOP_CAPTURE_TOOL,
]);

export function isDesktopInputTool(toolName: string): boolean {
  return DESKTOP_INPUT_TOOLS.has(toolName);
}

export function getDesktopInputToolPendingSummary(toolName: string): string {
  if (toolName === DESKTOP_WINDOWS_TOOL || toolName === DESKTOP_APPS_TOOL) {
    return 'listing desktop windows';
  }
  if (toolName === DESKTOP_SNAPSHOT_TOOL) {
    return 'reading a window';
  }
  if (toolName === DESKTOP_CAPTURE_TOOL) {
    return 'looking at a window';
  }
  if (toolName === DESKTOP_KEY_TOOL || toolName === DESKTOP_TYPE_TOOL) {
    return 'typing into a window';
  }
  if (toolName === DESKTOP_SCROLL_TOOL) {
    return 'scrolling a window';
  }
  if (toolName === DESKTOP_SELECT_TOOL || toolName === DESKTOP_TOGGLE_TOOL) {
    return 'setting a control';
  }
  if (toolName === DESKTOP_FOCUS_TOOL) {
    return 'bringing a window to the front';
  }
  return 'acting on a window';
}

/**
 * The desktop tools.
 *
 * `canSeeImages` decides whether the capture tool is offered at all. Attaching an
 * image to a request for a model that cannot take one does not degrade -- the
 * call THROWS, killing the whole turn. So a text-only model must never be handed
 * a tool whose entire output is a picture: it would call it, reasonably, and the
 * conversation would die instead of falling back to desktop_snapshot.
 *
 * Defaults to true so an unknown caller keeps the full set; the executor refuses
 * honestly if the image cannot actually be delivered.
 */
export function getDesktopInputToolDefinitions(
  options: { canSeeImages?: boolean } = {},
): ToolDef[] {
  const canSeeImages = options.canSeeImages !== false;
  const definitions: ToolDef[] = [
    {
      type: 'function',
      function: {
        name: DESKTOP_WINDOWS_TOOL,
        description:
          "List the user's open desktop windows (title + process). Read-only. Use this first when the " +
          'user asks you to do something in a real Windows app rather than in a web page. Returns a ' +
          'window handle (hwnd) to pass to desktop_snapshot. Requires the operator to have enabled ' +
          'Desktop input in Settings; it fails closed otherwise.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: DESKTOP_SNAPSHOT_TOOL,
        description:
          'List the interactable controls in ONE window, each with a numbered ref. Read-only. You MUST ' +
          'call this before desktop_act: a ref is only valid together with the snapshot_id returned ' +
          'here, and a snapshot goes stale the moment the window changes. ' +
          'Read `note`: "no_interactable_elements" means the window really has nothing to click; ' +
          '"no_automation_tree" means the window does not describe itself to Windows at all -- do NOT ' +
          'report that as an empty window, and do not guess at controls you cannot see. ' +
          'Controls marked sensitive (passwords, card numbers, OTPs) can never be driven.',
        parameters: {
          type: 'object',
          properties: {
            hwnd: {
              type: 'string',
              description: 'Window handle from desktop_windows, e.g. "0x1a2b".',
            },
          },
          required: ['hwnd'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: DESKTOP_ACT_TOOL,
        description:
          'Drive ONE control in a real window: click it, or set its text by passing `value`. Pass the ' +
          'ref AND the snapshot_id from the desktop_snapshot that produced it. ' +
          'READ THE RESULT BEFORE REPORTING: `ok` only means the call ran, it is NOT proof anything ' +
          'happened. Follow `status`: "done" (proven -- say it happened, never repeat it); ' +
          '"delivered_unverified" (it was delivered but nothing proved it landed -- read ' +
          '`observed_after` before saying anything, and do NOT repeat the action or claim a success ' +
          'it does not show); "not_performed" (nothing happened -- say so plainly and do not pretend ' +
          'otherwise); "outcome_unknown" (the helper stopped answering after it was sent -- it may ' +
          'or may not have happened: do NOT repeat it, look first, and tell the user it is ' +
          'unconfirmed). If `status` is "stale" the window changed: take a fresh snapshot and use ' +
          'the new refs. An act that ran comes back with `observed_after`: the window looked at ' +
          'again just after -- controls that appeared, went away or changed, and windows that ' +
          'opened or closed. When it says the refs moved, use the refs and snapshot_id it lists.',
        parameters: {
          type: 'object',
          properties: {
            hwnd: { type: 'string', description: 'Window handle, e.g. "0x1a2b".' },
            ref: {
              type: 'number',
              description: 'Element ref from the snapshot named by snapshot_id.',
            },
            snapshot_id: {
              type: 'string',
              description:
                'The snapshot_id that produced this ref. Required; a mismatch is refused.',
            },
            value: {
              type: 'string',
              description:
                'Text to put in the control. Omit to click/invoke it instead. Never send credentials.',
            },
          },
          required: ['hwnd', 'ref', 'snapshot_id'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: DESKTOP_KEY_TOOL,
        description:
          'Send a keystroke or key combo to a window: "ctrl+s", "tab", "escape", "f5", "enter". ' +
          'Keys go wherever focus already is inside that window, so there is no element to name. ' +
          'A plain key is delivered without taking focus; a MODIFIER COMBO cannot be, because the ' +
          'app reads modifier state from the real keyboard -- those need the synthetic-input path ' +
          'and are refused with modifiers_need_foreground when it is off. ' +
          'Nothing can prove the app acted on a keystroke, so this never reports "done": read ' +
          '`observed_after` in the result -- the window looked at again just after -- before saying ' +
          'what happened.',
        parameters: {
          type: 'object',
          properties: {
            hwnd: { type: 'string', description: 'Window handle from desktop_windows.' },
            keys: {
              type: 'string',
              description: 'Combo joined with "+", e.g. "ctrl+shift+s", "tab", "f5".',
            },
            delivery: {
              type: 'string',
              enum: ['auto', 'background', 'foreground'],
              description:
                'Which path to use. Omit for auto. "background" never takes focus and refuses if ' +
                'it cannot deliver; "foreground" takes focus and needs the operator to have ' +
                'enabled synthetic input.',
            },
          },
          required: ['hwnd', 'keys'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: DESKTOP_TYPE_TOOL,
        description:
          'Type text into whatever holds focus in a window. ' +
          'PREFER desktop_act with a `value` when a specific field is the target: that addresses ' +
          'the field, replaces its contents, and can PROVE the text landed. This cannot -- it has ' +
          'no element to read back, and the text goes in at the caret, wherever that happens to ' +
          'be (after a programmatic write the caret sits at the START, so typing prepends). ' +
          'Never send passwords, card numbers or one-time codes through this.',
        parameters: {
          type: 'object',
          properties: {
            hwnd: { type: 'string', description: 'Window handle from desktop_windows.' },
            text: { type: 'string', description: 'Text to type at the current caret.' },
            delivery: {
              type: 'string',
              enum: ['auto', 'background', 'foreground'],
              description: 'Which path to use. Omit for auto.',
            },
          },
          required: ['hwnd', 'text'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: DESKTOP_CLICK_TOOL,
        description:
          'Click a control with a specific button, count, or held modifiers -- right-click, ' +
          'double-click, ctrl+click. For an ordinary single left click use desktop_act instead: ' +
          'it goes through UI Automation, which can PROVE the click happened, while this cannot. ' +
          'Pass the ref AND the snapshot_id from the desktop_snapshot that produced it. ' +
          'Held modifiers need the synthetic-input path and are refused without it, rather than ' +
          'being dropped and delivered as a plain click.',
        parameters: {
          type: 'object',
          properties: {
            hwnd: { type: 'string', description: 'Window handle.' },
            ref: { type: 'number', description: 'Element ref from the snapshot.' },
            snapshot_id: { type: 'string', description: 'The snapshot that produced this ref.' },
            button: {
              type: 'string',
              enum: ['left', 'right', 'middle'],
              description: 'Mouse button. Defaults to left.',
            },
            clicks: {
              type: 'number',
              description: '1 (default), 2 for a double click, 3 for a triple click.',
            },
            modifiers: {
              type: 'array',
              items: { type: 'string', enum: ['ctrl', 'shift', 'alt', 'win'] },
              description: 'Modifier keys held during the click.',
            },
            delivery: {
              type: 'string',
              enum: ['auto', 'background', 'foreground'],
              description: 'Which path to use. Omit for auto.',
            },
          },
          required: ['hwnd', 'ref', 'snapshot_id'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: DESKTOP_CLICK_POINT_TOOL,
        description:
          'LAST RESORT: click a point you can SEE in a desktop_capture picture of the window. ' +
          'x and y are pixels in that picture (its size is in the capture result); call ' +
          'desktop_capture first -- without one this refuses, because a point you have not seen ' +
          'is a guess. Use it only for what has no ref: a window whose snapshot returned ' +
          'note="no_automation_tree", or something drawn in the picture that the snapshot did ' +
          'not list. If the control has a ref, use desktop_act or desktop_click instead: a ref is ' +
          'checked against the window, a point is not. Credential fields are still refused by ' +
          'position, the click is refused if the window was resized since the picture, and ' +
          'nothing here can verify the click did anything -- read `observed_after`, and when it ' +
          'says the window has no controls to compare, capture again to look.',
        parameters: {
          type: 'object',
          properties: {
            hwnd: { type: 'string', description: 'Window handle.' },
            x: {
              type: 'number',
              description: 'X in the latest desktop_capture picture of this window, in pixels.',
            },
            y: {
              type: 'number',
              description: 'Y in the latest desktop_capture picture of this window, in pixels.',
            },
            button: { type: 'string', enum: ['left', 'right', 'middle'] },
            clicks: { type: 'number', description: '1 (default) or 2 for a double click.' },
          },
          required: ['hwnd', 'x', 'y'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: DESKTOP_SCROLL_TOOL,
        description:
          'Scroll a control. This is the ONE input action that can prove itself: it reads the ' +
          'scroll position back, so status "done" here really means the view moved. ' +
          'A status of "not_performed" with a suspected no-op means the view was already at that ' +
          'end -- scrolling further will not help, so change approach instead of repeating. ' +
          'Scrolling can reveal new controls: `observed_after` in the result lists them, with refs ' +
          'that go with the snapshot_id it gives.',
        parameters: {
          type: 'object',
          properties: {
            hwnd: { type: 'string', description: 'Window handle.' },
            ref: { type: 'number', description: 'Ref of the control to scroll.' },
            snapshot_id: { type: 'string', description: 'The snapshot that produced this ref.' },
            direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
            amount: { type: 'number', description: 'Wheel ticks, 1-30. Defaults to 3.' },
          },
          required: ['hwnd', 'ref', 'snapshot_id', 'direction'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: DESKTOP_DRAG_TOOL,
        description:
          'Drag from one control to another within a window. Real pointer input only -- there is ' +
          'no way to deliver a drag without taking focus and moving the cursor, so this needs the ' +
          'operator to have enabled synthetic input and is refused otherwise. Nothing can prove ' +
          'the app accepted the drag; read `observed_after` in the result before saying it worked.',
        parameters: {
          type: 'object',
          properties: {
            hwnd: { type: 'string', description: 'Window handle.' },
            ref: { type: 'number', description: 'Ref to drag FROM.' },
            to_ref: { type: 'number', description: 'Ref to drag TO, from the same snapshot.' },
            snapshot_id: { type: 'string', description: 'The snapshot that produced both refs.' },
          },
          required: ['hwnd', 'ref', 'to_ref', 'snapshot_id'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: DESKTOP_FOCUS_TOOL,
        description:
          'Bring a window to the front. This CHANGES WHAT THE USER IS LOOKING AT and persists ' +
          'after the call, unlike the momentary focus other actions take -- so use it only when ' +
          'the user asked to see the window, not to make another action work. Most actions do not ' +
          'need it: they are delivered without disturbing what is in front.',
        parameters: {
          type: 'object',
          properties: {
            hwnd: { type: 'string', description: 'Window handle to raise.' },
          },
          required: ['hwnd'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: DESKTOP_SELECT_TOOL,
        description:
          'Choose an option in a dropdown or list BY ITS LABEL. Use this instead of clicking a ' +
          'dropdown and then clicking an option: the menu that opens did not exist when your ' +
          'snapshot was taken, so a follow-up click would be aimed at something you never saw. ' +
          'This reads the control back afterwards, so a status of "done" means the control really ' +
          'holds that option. If the label does not exist you get option_not_found -- take a ' +
          'fresh desktop_snapshot and read the options rather than guessing another spelling.',
        parameters: {
          type: 'object',
          properties: {
            hwnd: { type: 'string', description: 'Window handle.' },
            ref: { type: 'number', description: 'Ref of the dropdown or list.' },
            snapshot_id: { type: 'string', description: 'The snapshot that produced this ref.' },
            option: { type: 'string', description: 'Exact label of the option to choose.' },
          },
          required: ['hwnd', 'ref', 'snapshot_id', 'option'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: DESKTOP_TOGGLE_TOOL,
        description:
          'Set a checkbox to a STATE rather than clicking it. "Check this" and "click this" are ' +
          'different requests: clicking an already-checked box unchecks it. Pass state="on" or ' +
          '"off" and it is idempotent -- asking twice leaves it where you asked. The state is read ' +
          'back, so "done" here is proof. Use state="toggle" only when the user actually means ' +
          '"flip it, whatever it is".',
        parameters: {
          type: 'object',
          properties: {
            hwnd: { type: 'string', description: 'Window handle.' },
            ref: { type: 'number', description: 'Ref of the checkbox.' },
            snapshot_id: { type: 'string', description: 'The snapshot that produced this ref.' },
            state: {
              type: 'string',
              enum: ['on', 'off', 'toggle'],
              description: 'Desired state. Prefer on/off over toggle.',
            },
          },
          required: ['hwnd', 'ref', 'snapshot_id', 'state'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: DESKTOP_CAPTURE_TOOL,
        description:
          'SEE a window: returns a picture of it with its controls outlined and NUMBERED, and the ' +
          'numbers are the same refs you pass to desktop_act / desktop_click / desktop_select. ' +
          'Use it when the layout matters (which of several similar buttons, what a chart or ' +
          'document shows, why an action did not appear to work), or when desktop_snapshot ' +
          'returned note="no_automation_tree" and a picture is the only way to see anything. ' +
          'For simply finding a control by name, desktop_snapshot is cheaper and enough. ' +
          'It works on windows that are behind others, so it does not disturb what the user is ' +
          'looking at. Credential fields are outlined WITHOUT a number: you can see the field ' +
          'exists, and it cannot be driven. This sends an image of that window to the model, so ' +
          'do not call it on windows the user has not asked you to work with.',
        parameters: {
          type: 'object',
          properties: {
            hwnd: { type: 'string', description: 'Window handle from desktop_windows.' },
            mode: {
              type: 'string',
              enum: ['som', 'plain'],
              description:
                '"som" (default) numbers the controls. "plain" is the picture alone -- use it ' +
                'when the numbering would obscure what you need to read.',
            },
            max_long_side: {
              type: 'number',
              description:
                `Cap the longest edge in pixels (200-${DESKTOP_CAPTURE_MAX_LONG_SIDE}). ` +
                'Defaults to 1200. The short edge is always kept at or under ' +
                `${DESKTOP_CAPTURE_MAX_SHORT_SIDE} so you see the picture's real pixels.`,
            },
          },
          required: ['hwnd'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: DESKTOP_APPS_TOOL,
        description:
          'List the running desktop apps that have windows, grouped by program, with a window ' +
          'count each. Read-only. Use when the user names an app ("my editor", "Chrome") rather ' +
          'than a window, then desktop_windows to pick the specific window.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
  ];
  // desktop_click_point reads its x/y off a capture picture, so a model that
  // cannot be shown one has nothing to read them off: offered, it could only
  // guess -- or reuse geometry from a picture another model was shown.
  return definitions.filter(
    (definition) =>
      canSeeImages ||
      (definition.function.name !== DESKTOP_CAPTURE_TOOL &&
        definition.function.name !== DESKTOP_CLICK_POINT_TOOL),
  );
}

export interface DesktopActToolResult {
  ok: boolean;
  // outcome_unknown: the helper or the bridge stopped answering after the act
  // was sent, so it may or may not have happened.
  status: 'done' | 'delivered_unverified' | 'not_performed' | 'stale' | 'outcome_unknown';
  effect: string;
  verified: boolean;
  path?: string;
  code?: string;
  detail: string;
  note: string;
  // The window looked at again after an act that ran.
  observed_after?: DesktopObservedAfter;
}

// Desktop pictures ride on their own user message with an attachment id that
// starts with this, which is how the pruning below finds them.
export const DESKTOP_CAPTURE_ATTACHMENT_PREFIX = 'desktop-capture-';
// How many desktop pictures stay in a conversation turn. Each is up to a
// megabyte of image the model re-reads on every request; older ones are swapped
// for a line saying so, and the model can capture again if it needs to look.
export const DESKTOP_CAPTURES_KEPT = 3;
// Pruning rewrites an earlier message, which invalidates the provider's prompt
// cache from that point on. Doing it on every new picture would pay that on
// every capture, so it waits until this many extra pictures have piled up and
// then drops them together.
export const DESKTOP_CAPTURES_PRUNE_SLACK = 3;

/**
 * Drop all but the newest `keep` desktop pictures from a message list, once
 * more than `keep + slack` of them have accumulated. The messages stay (their
 * order is part of the conversation); only the picture is replaced by a
 * sentence. Other attachments are left alone.
 */
export function pruneDesktopCaptureImages<
  T extends { role: string; content: string; attachments?: { id: string }[] },
>(messages: T[], keep = DESKTOP_CAPTURES_KEPT, slack = DESKTOP_CAPTURES_PRUNE_SLACK): T[] {
  const isPicture = (message: T) =>
    (message.attachments ?? []).some((item) =>
      item.id.startsWith(DESKTOP_CAPTURE_ATTACHMENT_PREFIX),
    );
  if (messages.filter(isPicture).length <= keep + slack) {
    return messages;
  }
  let kept = 0;
  const pruned = [...messages];
  for (let index = pruned.length - 1; index >= 0; index -= 1) {
    const message = pruned[index];
    const attachments = message.attachments ?? [];
    if (!attachments.some((item) => item.id.startsWith(DESKTOP_CAPTURE_ATTACHMENT_PREFIX))) {
      continue;
    }
    kept += 1;
    if (kept <= keep) {
      continue;
    }
    const others = attachments.filter(
      (item) => !item.id.startsWith(DESKTOP_CAPTURE_ATTACHMENT_PREFIX),
    );
    const replacement: T = {
      ...message,
      content:
        'An earlier desktop_capture picture was removed to save space. Capture the window again ' +
        'if you need to look at it.',
    };
    if (others.length > 0) {
      replacement.attachments = others;
    } else {
      delete replacement.attachments;
    }
    pruned[index] = replacement;
  }
  return pruned;
}

// Below every provider's own resize threshold. A provider that shrinks the
// picture again (Anthropic past ~1568 px or ~1.15 MP, OpenAI past a 768 px short
// side) shows the model different pixels from the ones a point is read off, so
// a coordinate would land scaled wrong. 1366x768 stays under all of them.
export const DESKTOP_CAPTURE_MAX_LONG_SIDE = 1366;
export const DESKTOP_CAPTURE_MAX_SHORT_SIDE = 768;

export function clampDesktopCaptureLongSide(value: number): number {
  if (!Number.isFinite(value)) {
    return 1200;
  }
  return Math.max(200, Math.min(DESKTOP_CAPTURE_MAX_LONG_SIDE, Math.round(value)));
}

/**
 * Where a desktop_capture picture sits relative to the window it shows: the
 * picture is the window rectangle (frame included), shrunk by `scale`.
 */
export interface DesktopCaptureGeometry {
  scale: number;
  imageWidth: number;
  imageHeight: number;
  windowWidth: number;
  windowHeight: number;
}

// The last picture of each window. desktop_click_point takes its x/y from that
// picture -- the one thing the model has actually looked at -- so they are
// turned back into window pixels here with the scale it was shrunk by.
const latestDesktopCaptures = new Map<string, DesktopCaptureGeometry>();

export function rememberDesktopCaptureGeometry(
  hwnd: string,
  capture: {
    width: number;
    height: number;
    scale: number;
    windowWidth: number;
    windowHeight: number;
  },
): void {
  if (!(capture.width > 0) || !(capture.height > 0)) {
    return;
  }
  const scale = capture.scale > 0 ? capture.scale : 1;
  latestDesktopCaptures.set(hwnd, {
    scale,
    imageWidth: capture.width,
    imageHeight: capture.height,
    // A helper that predates windowWidth/Height: derive them from the scale.
    windowWidth: capture.windowWidth > 0 ? capture.windowWidth : Math.round(capture.width / scale),
    windowHeight:
      capture.windowHeight > 0 ? capture.windowHeight : Math.round(capture.height / scale),
  });
}

export function getDesktopCaptureGeometry(hwnd: string): DesktopCaptureGeometry | null {
  return latestDesktopCaptures.get(hwnd) ?? null;
}

export function forgetDesktopCaptureGeometry(): void {
  latestDesktopCaptures.clear();
}

/**
 * A point read off a capture picture, in the window's own pixels (measured from
 * the window rectangle's top-left, unscaled). Null when the point is not on the
 * picture at all.
 */
export function capturePointToWindowPoint(
  geometry: DesktopCaptureGeometry,
  x: number,
  y: number,
): { x: number; y: number } | null {
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    x < 0 ||
    y < 0 ||
    x >= geometry.imageWidth ||
    y >= geometry.imageHeight
  ) {
    return null;
  }
  return {
    x: Math.min(geometry.windowWidth - 1, Math.floor(x / geometry.scale)),
    y: Math.min(geometry.windowHeight - 1, Math.floor(y / geometry.scale)),
  };
}

// ---- After an act: look again ----
//
// An act that cannot be proven used to end with "take a fresh desktop_snapshot
// and look": one more model round trip on every step, to learn what the helper
// could read itself. So once an act has run, the window is read again after it
// has had a moment to answer, and the result says what changed -- controls that
// appeared, went away, or were renamed or enabled, and windows that opened or
// closed. It never upgrades the verdict: a changed window is something to read,
// not proof that the intended thing happened.
//
// What changed is measured against a snapshot taken just BEFORE the act, not
// against whatever the model last looked at: that could be minutes old, and
// every change since would have been reported as the act's doing.

// The snapshot id each window's refs were last handed out with -- the refs the
// model is holding. Only that tells whether they still work after the act.
const heldDesktopSnapshotIds = new Map<string, string>();

export function rememberDesktopSnapshot(hwnd: string, snapshot: { snapshotId: string }): void {
  if (snapshot.snapshotId) {
    heldDesktopSnapshotIds.set(hwnd, snapshot.snapshotId);
  }
}

/**
 * Forget every window's refs and pictures. Called when a conversation turn
 * starts: tool results and pictures are not carried into the next turn, so the
 * model no longer has any of them in front of it -- and a point read off a
 * picture it cannot see is a guess.
 */
export function forgetDesktopWindowMemory(): void {
  heldDesktopSnapshotIds.clear();
  latestDesktopCaptures.clear();
}

// How long the window is given before each look. Most windows answer within a
// frame or two; a dialog takes longer to build, which is what the second look is
// for -- and it is only taken when the first one saw nothing move.
const DESKTOP_OBSERVE_SETTLE_MS: readonly number[] = [300, 700];
let desktopObserveSettleMs: readonly number[] = DESKTOP_OBSERVE_SETTLE_MS;

/** Set the waits before each look after an act; [] turns the look off, null restores them. */
export function setDesktopObservationDelays(delays: readonly number[] | null): void {
  desktopObserveSettleMs = delays ?? DESKTOP_OBSERVE_SETTLE_MS;
}

// The looks are a convenience. A window busy after the act would otherwise hold
// each read until the helper's own 20 s limit, and a hung bridge would delay the
// act itself by the client's full 30 s.
const OBSERVE_READ_TIMEOUT_MS = 5_000;

// A whole control list only rides along when the refs moved, and even then
// within these bounds: the result is passed to the model as it is.
const OBSERVED_ELEMENTS_LIMIT = 60;
const OBSERVED_CHANGES_LIMIT = 12;
const OBSERVED_WINDOWS_LIMIT = 5;

export interface DesktopElementDiff {
  appeared: AoiHostDesktopElementView[];
  disappeared: AoiHostDesktopElementView[];
  // The same control with a new name or enabled state, and what it was.
  changed: { element: AoiHostDesktopElementView; wasName: string; wasEnabled: boolean }[];
}

// The identities the helper hashes into a snapshot id (AssignIdentities in
// aoi_desktop_input.cpp): a control's automation id when it has one, its name
// otherwise -- and both when several controls share one automation id, the way
// rows built from one template do. A rename of a control with a unique
// automation id keeps the snapshot (and every ref) valid, which is why it is
// reported as a change of that control rather than as a new one.
function desktopElementIdentities(
  elements: AoiHostDesktopElementView[],
): Map<AoiHostDesktopElementView, string> {
  const base = (element: AoiHostDesktopElementView) =>
    element.automationId
      ? `${element.role}:${element.automationId}`
      : `${element.role}::${element.name}`;
  const uses = new Map<string, number>();
  for (const element of elements) {
    uses.set(base(element), (uses.get(base(element)) ?? 0) + 1);
  }
  const identities = new Map<AoiHostDesktopElementView, string>();
  for (const element of elements) {
    const key = base(element);
    identities.set(
      element,
      element.automationId && (uses.get(key) ?? 0) > 1 ? `${key}::${element.name}` : key,
    );
  }
  return identities;
}

/**
 * What changed between two lists of one window's controls. Controls are matched
 * by identity in order, so two identical "OK" buttons count as two.
 */
export function diffDesktopElements(
  before: AoiHostDesktopElementView[],
  after: AoiHostDesktopElementView[],
): DesktopElementDiff {
  const beforeIds = desktopElementIdentities(before);
  const afterIds = desktopElementIdentities(after);
  const unmatched = new Map<string, AoiHostDesktopElementView[]>();
  for (const element of before) {
    const key = beforeIds.get(element) ?? '';
    const queue = unmatched.get(key);
    if (queue) {
      queue.push(element);
    } else {
      unmatched.set(key, [element]);
    }
  }
  const matched = new Set<AoiHostDesktopElementView>();
  const appeared: AoiHostDesktopElementView[] = [];
  const changed: DesktopElementDiff['changed'] = [];
  for (const element of after) {
    const match = unmatched.get(afterIds.get(element) ?? '')?.shift();
    if (!match) {
      appeared.push(element);
      continue;
    }
    matched.add(match);
    if (match.name !== element.name || match.enabled !== element.enabled) {
      changed.push({ element, wasName: match.name, wasEnabled: match.enabled });
    }
  }
  return {
    appeared,
    disappeared: before.filter((element) => !matched.has(element)),
    changed,
  };
}

export interface DesktopObservedElement {
  ref: number;
  role: string;
  name: string;
  enabled: boolean;
  drivable?: false;
  reason?: 'sensitive';
  new?: true;
  was_name?: string;
  was_enabled?: boolean;
}

export interface DesktopObservedWindow {
  hwnd: string;
  title: string;
  process: string;
  // A window of another program: maybe the act's doing (a link opening the
  // browser), maybe just something that happened to open meanwhile.
  other_app?: true;
}

export interface DesktopObservedAfter {
  waited_ms: number;
  summary: string;
  snapshot_id?: string;
  // Whether the refs the model holds still address the same controls.
  refs_still_valid?: boolean;
  total_elements?: number;
  // When the refs still hold: only what changed.
  changed?: DesktopObservedElement[];
  // When they moved: the window's controls, with what is new marked.
  elements?: DesktopObservedElement[];
  elements_omitted?: number;
  disappeared?: { role: string; name: string }[];
  disappeared_omitted?: number;
  windows_opened?: DesktopObservedWindow[];
  window_closed?: true;
}

function observedElement(
  element: AoiHostDesktopElementView,
  marks: { isNew?: boolean; wasName?: string; wasEnabled?: boolean },
): DesktopObservedElement {
  return {
    ref: element.ref,
    role: element.role,
    name: defuseRoleMarkers(element.name),
    enabled: element.enabled,
    ...(element.sensitive ? { drivable: false as const, reason: 'sensitive' as const } : {}),
    ...(marks.isNew ? { new: true as const } : {}),
    ...(marks.wasName !== undefined && marks.wasName !== element.name
      ? { was_name: defuseRoleMarkers(marks.wasName) }
      : {}),
    ...(marks.wasEnabled !== undefined && marks.wasEnabled !== element.enabled
      ? { was_enabled: marks.wasEnabled }
      : {}),
  };
}

// The windows in `after` that were not in `before`, the acted-on app's own
// first: those are the dialogs an act opens, and the cap must not drop them for
// a notification from something else. Titles are written by whoever made the
// window -- a browser popup's is its page's -- so they are defused.
function openedDesktopWindows(
  hwnd: string,
  before: AoiHostDesktopWindowView[] | null,
  after: AoiHostDesktopWindowView[] | null,
): DesktopObservedWindow[] {
  if (!before || !after) {
    return [];
  }
  const known = new Set(before.map((window) => window.hwnd));
  const ownProcess = before.find((window) => window.hwnd === hwnd)?.process;
  const opened = after.filter((window) => !known.has(window.hwnd));
  const describe = (window: AoiHostDesktopWindowView, ownApp: boolean): DesktopObservedWindow => ({
    hwnd: window.hwnd,
    title: defuseRoleMarkers(window.title),
    process: window.process,
    ...(ownApp ? {} : { other_app: true as const }),
  });
  return [
    ...opened
      .filter((window) => window.process === ownProcess)
      .map((window) => describe(window, true)),
    ...opened
      .filter((window) => window.process !== ownProcess)
      .map((window) => describe(window, false)),
  ];
}

interface DesktopLook {
  snapshot: AoiHostDesktopSnapshotView | null;
  windows: AoiHostDesktopWindowView[] | null;
}

// A snapshot that is not shaped like one is no reading at all.
function readableSnapshot(
  snapshot: AoiHostDesktopSnapshotView | null,
): AoiHostDesktopSnapshotView | null {
  return snapshot && Array.isArray(snapshot.elements) ? snapshot : null;
}

async function lookAtDesktopWindow(hwnd: string, withWindows: boolean): Promise<DesktopLook> {
  const [snapshot, windows] = await Promise.all([
    snapshotAoiHostDesktopWindow(hwnd, { timeoutMs: OBSERVE_READ_TIMEOUT_MS }).catch(() => null),
    withWindows
      ? listAoiHostDesktopWindows({ timeoutMs: OBSERVE_READ_TIMEOUT_MS }).catch(() => null)
      : Promise.resolve(null),
  ]);
  return { snapshot: readableSnapshot(snapshot), windows };
}

// Whether the window has visibly answered the act. A window of some OTHER
// program opening meanwhile is not an answer from this one: a toast elsewhere
// must not cut short the wait for this window's own dialog.
function desktopLookMoved(
  hwnd: string,
  baseline: AoiHostDesktopSnapshotView,
  windowsBefore: AoiHostDesktopWindowView[] | null,
  look: DesktopLook,
): boolean {
  if (!look.snapshot || look.snapshot.snapshotId !== baseline.snapshotId) {
    return true;
  }
  return (
    diffDesktopElements(baseline.elements, look.snapshot.elements).changed.length > 0 ||
    openedDesktopWindows(hwnd, windowsBefore, look.windows).some((window) => !window.other_app)
  );
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function describeDesktopLook(
  hwnd: string,
  baseline: AoiHostDesktopSnapshotView | null,
  held: string | null,
  windowsBefore: AoiHostDesktopWindowView[] | null,
  look: DesktopLook,
  waitedMs: number,
): DesktopObservedAfter | null {
  const opened = openedDesktopWindows(hwnd, windowsBefore, look.windows).slice(
    0,
    OBSERVED_WINDOWS_LIMIT,
  );
  const openedPart =
    opened.length > 0
      ? ` ${plural(opened.length, 'new window', 'new windows')} opened (windows_opened); ` +
        'one marked other_app belongs to another program, so the act may not have opened it. ' +
        'Snapshot one by its hwnd to work in it.'
      : '';
  const windowsPart = opened.length > 0 ? { windows_opened: opened } : {};

  const snapshot = look.snapshot;
  if (!snapshot) {
    const closed =
      !!windowsBefore?.some((window) => window.hwnd === hwnd) &&
      !!look.windows &&
      !look.windows.some((window) => window.hwnd === hwnd);
    if (closed) {
      // Nothing addressed to this window can land any more.
      heldDesktopSnapshotIds.delete(hwnd);
      latestDesktopCaptures.delete(hwnd);
      return {
        waited_ms: waitedMs,
        window_closed: true,
        summary: `The window closed.${openedPart}`,
        ...windowsPart,
      };
    }
    if (opened.length === 0) {
      return null;
    }
    return {
      waited_ms: waitedMs,
      summary: `The window could not be read again.${openedPart}`,
      ...windowsPart,
    };
  }

  // These are the refs the model is about to be given.
  rememberDesktopSnapshot(hwnd, snapshot);
  const refsStillValid = held !== null && snapshot.snapshotId === held;
  const common = {
    waited_ms: waitedMs,
    snapshot_id: snapshot.snapshotId,
    refs_still_valid: refsStillValid,
    total_elements: snapshot.totalElements,
    ...windowsPart,
  };

  if (snapshot.elements.length === 0 && snapshot.note === 'no_automation_tree') {
    return {
      ...common,
      summary:
        'This window does not describe its controls, so nothing in it could be compared. ' +
        `Take a desktop_capture to look.${openedPart}`,
    };
  }

  const diff = baseline ? diffDesktopElements(baseline.elements, snapshot.elements) : null;
  // A capped list keeps the first controls in tree order, and that order moves:
  // a control can drop off the end, or come back, without anything happening to it.
  const cutPart =
    (baseline?.truncated || snapshot.truncated) && diff
      ? ' This window has more controls than the list holds, so one can seem to appear or go ' +
        'away when it only moved past the end of the list.'
      : '';

  if (refsStillValid) {
    const changedEntries = diff?.changed ?? [];
    const changed = changedEntries
      .slice(0, OBSERVED_CHANGES_LIMIT)
      .map(({ element, wasName, wasEnabled }) => observedElement(element, { wasName, wasEnabled }));
    return {
      ...common,
      summary:
        (changed.length > 0
          ? `${plural(changedEntries.length, 'control', 'controls')} changed name or state (changed). `
          : diff
            ? `No control appeared, went away, or changed name or state in ${waitedMs} ms. ` +
              'That does not show whether text or other content changed. '
            : '') + `The refs you have still work.${cutPart}${openedPart}`,
      ...(changed.length > 0 ? { changed } : {}),
    };
  }

  // The refs moved (or there were none to begin with): hand back the list the
  // next act needs, keeping what changed if it has to be cut.
  const appeared = new Set(diff?.appeared ?? []);
  const changedBy = new Map(diff?.changed.map((entry) => [entry.element, entry]) ?? []);
  const isMarked = (element: AoiHostDesktopElementView) =>
    appeared.has(element) || changedBy.has(element);
  const marked = snapshot.elements.filter(isMarked).slice(0, OBSERVED_ELEMENTS_LIMIT);
  const rest = snapshot.elements
    .filter((element) => !isMarked(element))
    .slice(0, OBSERVED_ELEMENTS_LIMIT - marked.length);
  const keep = new Set([...marked, ...rest]);
  const elements = snapshot.elements
    .filter((element) => keep.has(element))
    .map((element) => {
      const change = changedBy.get(element);
      return observedElement(element, {
        isNew: appeared.has(element),
        ...(change ? { wasName: change.wasName, wasEnabled: change.wasEnabled } : {}),
      });
    });
  const omitted = snapshot.totalElements - elements.length;
  const disappeared = (diff?.disappeared ?? [])
    .slice(0, OBSERVED_CHANGES_LIMIT)
    .map((element) => ({ role: element.role, name: defuseRoleMarkers(element.name) }));

  let summary: string;
  if (!diff) {
    summary = `The window has ${plural(snapshot.totalElements, 'control', 'controls')}; use the refs below with this snapshot_id.`;
  } else {
    const counts = [
      diff.appeared.length > 0 ? `${diff.appeared.length} appeared (marked new)` : '',
      diff.disappeared.length > 0 ? `${diff.disappeared.length} went away` : '',
      diff.changed.length > 0 ? `${diff.changed.length} changed name or state` : '',
    ].filter(Boolean);
    summary =
      counts.length > 0
        ? `The window changed: controls ${counts.join(', ')}. `
        : baseline && snapshot.snapshotId !== baseline.snapshotId
          ? 'The window changed: its controls were reordered. '
          : held === null
            ? 'Nothing changed during the act. '
            : // Nothing moved during the act -- the refs had gone before it.
              'Nothing changed during the act, but the window is not the one your refs came from. ';
    summary +=
      held === null
        ? 'Use the refs below with this snapshot_id.'
        : 'Refs from before are retired; use the refs below with this snapshot_id.';
  }
  return {
    ...common,
    summary: `${summary}${omitted > 0 ? ` Only ${elements.length} of ${snapshot.totalElements} controls are listed; desktop_snapshot lists more.` : ''}${cutPart}${openedPart}`,
    elements,
    ...(omitted > 0 ? { elements_omitted: omitted } : {}),
    ...(disappeared.length > 0 ? { disappeared } : {}),
    ...(diff && diff.disappeared.length > disappeared.length
      ? { disappeared_omitted: diff.disappeared.length - disappeared.length }
      : {}),
  };
}

const settle = (ms: number) =>
  new Promise<void>((resolveSettle) => {
    setTimeout(resolveSettle, ms);
  });

/**
 * Look at a window again after an act ran in it. With a baseline, the first look
 * ends it if the window has visibly answered and a second, later one is taken if
 * not; without one, a first look could not tell, so the whole wait comes first
 * and there is one look. `quick` acts (typing, raising a window) rarely change
 * the controls, so they get only the first look. Best effort: null when there is
 * nothing useful to say.
 */
async function observeDesktopWindowAfterAct(params: {
  hwnd: string;
  baseline: AoiHostDesktopSnapshotView | null;
  held: string | null;
  windowsBefore: AoiHostDesktopWindowView[] | null;
  quick: boolean;
}): Promise<DesktopObservedAfter | null> {
  const { hwnd, baseline, windowsBefore } = params;
  const total = desktopObserveSettleMs.reduce((sum, delay) => sum + delay, 0);
  const schedule = params.quick
    ? [desktopObserveSettleMs[0] ?? 0]
    : baseline
      ? desktopObserveSettleMs
      : [total];
  let waitedMs = 0;
  let look: DesktopLook = { snapshot: null, windows: null };
  for (const delay of schedule) {
    await settle(delay);
    waitedMs += delay;
    look = await lookAtDesktopWindow(hwnd, windowsBefore !== null);
    if (!baseline || desktopLookMoved(hwnd, baseline, windowsBefore, look)) {
      break;
    }
  }
  return describeDesktopLook(hwnd, baseline, params.held, windowsBefore, look, waitedMs);
}

/**
 * Turn a verdict into what the model is allowed to say.
 *
 * The mapping is intentionally lossy in one direction only: nothing here can
 * turn an unproven act into a completion claim, and the note repeats the
 * constraint in words because a status string alone has proven easy to skim
 * past.
 */
export function describeDesktopActVerdict(view: {
  ok: boolean;
  effect: string;
  verified: boolean;
  path?: string;
  code?: string;
  detail: string;
}): DesktopActToolResult {
  const base = {
    ok: view.ok,
    effect: view.effect,
    verified: view.verified,
    ...(view.path ? { path: view.path } : {}),
    ...(view.code ? { code: view.code } : {}),
    detail: view.detail,
  };

  // A stale ref is its own instruction: re-look, do not retry blindly.
  if (view.code === 'element_ref_stale' || view.code === 'element_ref_unknown') {
    return {
      ...base,
      status: 'stale',
      note:
        'The window changed since your snapshot, so nothing was done. Take a fresh desktop_snapshot ' +
        'and use the new refs. Do not reuse the old ref.',
    };
  }
  // A terminal runs what is typed into it. The refusal has to say where the
  // approved path is, or the next attempt is the same thing by another route.
  if (view.code === 'terminal_input_refused') {
    return {
      ...base,
      status: 'not_performed',
      note:
        'Nothing was typed. That window is a terminal, where typed or pasted text runs as a ' +
        'command. To run a command, use host_process_spawn_preview and then ' +
        'host_process_spawn_run, which show it to the user for approval. Do not try to reach the ' +
        'terminal another way.',
    };
  }
  // Nothing ran, and nothing is wrong with the act itself: another one was
  // still in progress.
  if (view.code === 'desktop_busy') {
    return {
      ...base,
      status: 'not_performed',
      note:
        'Nothing was done: another desktop action was still running, so this one was not ' +
        'started. It is safe to try it once more.',
    };
  }
  // Same instruction for a point: the picture it was read off no longer fits.
  if (view.code === 'window_changed') {
    return {
      ...base,
      status: 'stale',
      note:
        'The window was resized since your desktop_capture, so nothing was done. Capture it again ' +
        'and read the point off the new picture. Do not reuse the old coordinates.',
    };
  }

  if (view.effect === 'confirmed' || view.verified) {
    return {
      ...base,
      status: 'done',
      note: 'This is proven. You may say it happened. Do not repeat it.',
    };
  }

  if (view.effect === 'unverifiable') {
    return {
      ...base,
      status: 'delivered_unverified',
      note:
        'It was delivered, but nothing proves it landed. Take a fresh desktop_snapshot and look before ' +
        'you say anything about it. Do NOT repeat the action and do NOT claim success.',
    };
  }

  return {
    ...base,
    status: 'not_performed',
    note:
      'Nothing happened. Say so plainly rather than describing it as done. If a control was refused ' +
      '(disabled, sensitive, obscured), do not try to work around the refusal.',
  };
}

/**
 * Run one act and, if it ran, look at the window again and attach what changed.
 * The look is best effort: when it fails the verdict goes back as it was, and it
 * never changes the status -- only the note, which points at what was seen.
 */
// The helper or the bridge went quiet after the act was sent: the act may have
// happened. Every other failure means it was never started, and the caller
// says so.
function isUnknownOutcome(error: unknown): boolean {
  return (
    error instanceof AoiHostBridgeTimeoutError ||
    (error instanceof AoiHostBridgeRequestError &&
      (error.code === 'helper_timeout' || error.code === 'helper_no_reply'))
  );
}

/**
 * Run one act and, if it ran, look at the window again and attach what changed.
 * The look is best effort: when it fails the verdict goes back as it was, and it
 * never changes the status -- only the note, which points at what was seen.
 */
async function actThenObserve(
  hwnd: string,
  addressedSnapshotId: string | null,
  perform: () => Promise<AoiHostDesktopActView>,
  options: { quick?: boolean } = {},
): Promise<DesktopActToolResult> {
  const observing = desktopObserveSettleMs.length > 0;
  // The refs the model is acting with: the snapshot a ref act names, otherwise
  // the last ones handed out for this window.
  const held = addressedSnapshotId ?? heldDesktopSnapshotIds.get(hwnd) ?? null;
  // The baseline is read now, so a change from before the act is not reported
  // as the act's.
  const [windowsBefore, baselineRead] = observing
    ? await Promise.all([
        listAoiHostDesktopWindows({ timeoutMs: OBSERVE_READ_TIMEOUT_MS }).catch(() => null),
        snapshotAoiHostDesktopWindow(hwnd, { timeoutMs: OBSERVE_READ_TIMEOUT_MS }).catch(
          () => null,
        ),
      ])
    : [null, null];
  const baseline = readableSnapshot(baselineRead);
  const look = () =>
    observeDesktopWindowAfterAct({
      hwnd,
      baseline,
      held,
      windowsBefore,
      quick: options.quick === true,
    }).catch(() => null);

  let view: AoiHostDesktopActView;
  try {
    view = await perform();
  } catch (error) {
    if (!isUnknownOutcome(error)) {
      throw error;
    }
    const observed = observing ? await look() : null;
    return {
      ok: false,
      status: 'outcome_unknown',
      effect: 'unverifiable',
      verified: false,
      ...(error instanceof AoiHostBridgeRequestError ? { code: error.code } : {}),
      detail: error instanceof Error ? error.message : String(error),
      note:
        'The helper stopped answering after this was sent, so whether it happened is unknown -- ' +
        'it may have. Do NOT repeat it. ' +
        (observed
          ? 'observed_after is the window looked at again afterwards: say only what it shows, ' +
            'and tell the user it may or may not have gone through.'
          : 'Take a fresh desktop_snapshot before saying anything about it, and tell the user it ' +
            'may or may not have gone through.'),
      ...(observed ? { observed_after: observed } : {}),
    };
  }
  const result = describeDesktopActVerdict(view);
  if (!observing || (result.status !== 'done' && result.status !== 'delivered_unverified')) {
    return result;
  }
  const observed = await look();
  if (!observed) {
    return result;
  }
  return {
    ...result,
    note:
      result.status === 'done'
        ? `${result.note} observed_after is the window looked at again afterwards.`
        : 'It was delivered, but nothing proves it landed. observed_after is the window looked at ' +
          'again just after: read it before you say anything about this, and say only what it ' +
          'shows. Do NOT repeat the action, and do NOT claim a success it does not show.',
    observed_after: observed,
  };
}

/**
 * Execute one desktop-input tool call.
 *
 * Errors are returned as data rather than thrown: a thrown error becomes a bare
 * "error:" string in the transcript, which reads to the model as "something went
 * wrong" and leaves it free to guess. A structured not_performed says the one
 * thing that matters -- the window was not touched.
 */
export async function executeDesktopInputTool(
  toolName: string,
  params: Record<string, unknown> & { canSeeImages?: boolean },
): Promise<unknown> {
  if (toolName === DESKTOP_WINDOWS_TOOL) {
    // A browser window's title is its page's title: written by whoever wrote
    // the page, so it is defused like any other page text.
    const windows = await listAoiHostDesktopWindows();
    return {
      ok: true,
      windows: windows.map((window) => ({ ...window, title: defuseRoleMarkers(window.title) })),
    };
  }
  if (toolName === DESKTOP_APPS_TOOL) {
    const apps = await listAoiHostDesktopApps();
    return {
      ok: true,
      apps: apps.map((app) => ({ ...app, sampleTitle: defuseRoleMarkers(app.sampleTitle) })),
    };
  }

  const hwnd = typeof params.hwnd === 'string' ? params.hwnd.trim() : '';
  if (!hwnd) {
    return { ok: false, error: 'hwnd is required', code: 'bad_request' };
  }

  if (toolName === DESKTOP_CAPTURE_TOOL) {
    const capture = await captureAoiHostDesktopWindow({
      hwnd,
      ...(params.mode === 'plain' || params.mode === 'som' ? { mode: params.mode } : {}),
      ...(typeof params.max_long_side === 'number'
        ? { maxLongSide: clampDesktopCaptureLongSide(params.max_long_side) }
        : {}),
      maxShortSide: DESKTOP_CAPTURE_MAX_SHORT_SIDE,
    });
    // The image travels beside the tool result, not inside it: a base64 PNG in
    // the transcript would be megabytes of text the model cannot look at.
    // __image is stripped by the dispatcher and attached to a following message.
    // An image the caller cannot deliver is worse than none: it would be
    // attached and then throw at the model boundary. Report the window in words
    // and say plainly that the picture is unavailable.
    const deliverable = params.canSeeImages !== false;
    if (deliverable && capture.dataUrl) {
      rememberDesktopCaptureGeometry(hwnd, capture);
    }
    // The control list goes back as text either way, so it is what was seen.
    rememberDesktopSnapshot(hwnd, capture);
    const pointHint =
      `To click something in this picture that has no number, call desktop_click_point with x/y ` +
      `measured in THIS image (0-${capture.width - 1} across, 0-${capture.height - 1} down).`;
    return {
      ok: true,
      __image:
        deliverable && capture.dataUrl
          ? { dataUrl: capture.dataUrl, name: 'desktop-capture.png' }
          : null,
      ...(deliverable
        ? {}
        : {
            image_unavailable:
              'this model cannot receive images, so only the control list below is available; ' +
              'desktop_snapshot gives the same list more cheaply',
          }),
      snapshot_id: capture.snapshotId,
      mode: capture.mode,
      size: `${capture.width}x${capture.height}`,
      ...(capture.scale < 1 ? { scaled_to: capture.scale } : {}),
      note:
        capture.mode === 'som'
          ? 'The numbers on the image are refs valid with this snapshot_id; prefer them. Outlined but UNNUMBERED controls are credential fields and cannot be driven. ' +
            pointHint
          : params.mode === 'plain'
            ? 'This is the picture without numbers, as asked; the elements list still has the refs. ' +
              pointHint
            : 'No controls could be numbered; this window does not describe its controls. ' +
              pointHint,
      elements: capture.elements.map((element) => ({
        ref: element.ref,
        role: element.role,
        name: defuseRoleMarkers(element.name),
        enabled: element.enabled,
        ...(element.sensitive ? { drivable: false, reason: 'sensitive' } : {}),
      })),
    };
  }

  if (toolName === DESKTOP_SNAPSHOT_TOOL) {
    const snapshot = await snapshotAoiHostDesktopWindow(hwnd);
    rememberDesktopSnapshot(hwnd, snapshot);
    return {
      ok: true,
      snapshot_id: snapshot.snapshotId,
      note: snapshot.note,
      // Never present a cut list as the whole window.
      total_elements: snapshot.totalElements,
      ...(snapshot.truncated
        ? {
            truncated: true,
            truncation_note: `Only ${snapshot.elements.length} of ${snapshot.totalElements} controls are listed. What you need may not be here.`,
          }
        : {}),
      // Sensitive controls are listed so Aoi knows they exist and does not keep
      // hunting for them, but they are marked as undrivable rather than hidden.
      elements: snapshot.elements.map((element) => ({
        ref: element.ref,
        role: element.role,
        name: defuseRoleMarkers(element.name),
        enabled: element.enabled,
        ...(element.sensitive ? { drivable: false, reason: 'sensitive' } : {}),
      })),
    };
  }

  const delivery =
    params.delivery === 'background' || params.delivery === 'foreground'
      ? params.delivery
      : undefined;

  // Window-scoped input: no element, because a keystroke goes wherever focus
  // already is and there is nothing to address.
  if (toolName === DESKTOP_KEY_TOOL) {
    const keys = typeof params.keys === 'string' ? params.keys.trim() : '';
    if (!keys) {
      return notPerformed('keys is required');
    }
    return actThenObserve(hwnd, null, () =>
      sendAoiHostDesktopWindowInput({ op: 'key', hwnd, keys, delivery }),
    );
  }
  if (toolName === DESKTOP_TYPE_TOOL) {
    const text = typeof params.text === 'string' ? params.text : '';
    if (!text) {
      return notPerformed('text is required');
    }
    // Typing rarely changes which controls a window has: one look is enough.
    return actThenObserve(
      hwnd,
      null,
      () => sendAoiHostDesktopWindowInput({ op: 'type', hwnd, text, delivery }),
      { quick: true },
    );
  }
  if (toolName === DESKTOP_FOCUS_TOOL) {
    return actThenObserve(hwnd, null, () => sendAoiHostDesktopWindowInput({ op: 'focus', hwnd }), {
      quick: true,
    });
  }

  // A point takes no ref, so it is handled before the ref check below -- which
  // used to refuse every point click for lacking a ref it never had.
  if (toolName === DESKTOP_CLICK_POINT_TOOL) {
    if (typeof params.x !== 'number' || typeof params.y !== 'number') {
      return notPerformed('x and y are required');
    }
    const geometry = getDesktopCaptureGeometry(hwnd);
    if (!geometry) {
      return notPerformed(
        'take a desktop_capture of this window first: x and y are pixels in that picture',
      );
    }
    const point = capturePointToWindowPoint(geometry, params.x, params.y);
    if (!point) {
      return notPerformed(
        `x and y must be inside the last desktop_capture of this window ` +
          `(${geometry.imageWidth}x${geometry.imageHeight})`,
      );
    }
    // The daemon still checks what is under the point, and refuses the click
    // if the window has been resized since the picture.
    return actThenObserve(hwnd, null, () =>
      clickAoiHostDesktopPoint({
        hwnd,
        x: point.x,
        y: point.y,
        space: 'window',
        windowWidth: geometry.windowWidth,
        windowHeight: geometry.windowHeight,
        ...(typeof params.button === 'string' ? { button: params.button } : {}),
        ...(typeof params.clicks === 'number' ? { clicks: params.clicks } : {}),
        ...(delivery ? { delivery } : {}),
      }),
    );
  }

  const ref = typeof params.ref === 'number' ? params.ref : Number.NaN;
  const snapshotId =
    typeof params.snapshot_id === 'string'
      ? params.snapshot_id.trim()
      : typeof params.snapshotId === 'string'
        ? params.snapshotId.trim()
        : '';
  if (!Number.isInteger(ref) || !snapshotId) {
    return notPerformed('ref and snapshot_id are required together');
  }

  if (toolName === DESKTOP_CLICK_TOOL) {
    const modifiers = Array.isArray(params.modifiers)
      ? params.modifiers.filter((entry): entry is string => typeof entry === 'string')
      : typeof params.modifiers === 'string'
        ? [params.modifiers]
        : [];
    return actThenObserve(hwnd, snapshotId, () =>
      actOnAoiHostDesktopElement({
        op: 'click',
        hwnd,
        ref,
        snapshotId,
        ...(typeof params.button === 'string' ? { button: params.button } : {}),
        ...(typeof params.clicks === 'number' ? { clicks: params.clicks } : {}),
        ...(modifiers.length ? { modifiers } : {}),
        ...(delivery ? { delivery } : {}),
      }),
    );
  }

  if (toolName === DESKTOP_SCROLL_TOOL) {
    const direction = typeof params.direction === 'string' ? params.direction.trim() : '';
    if (!direction) {
      return notPerformed('direction is required');
    }
    return actThenObserve(hwnd, snapshotId, () =>
      actOnAoiHostDesktopElement({
        op: 'scroll',
        hwnd,
        ref,
        snapshotId,
        direction,
        ...(typeof params.amount === 'number' ? { amount: params.amount } : {}),
        ...(delivery ? { delivery } : {}),
      }),
    );
  }

  if (toolName === DESKTOP_SELECT_TOOL) {
    const option = typeof params.option === 'string' ? params.option.trim() : '';
    if (!option) {
      return notPerformed('option is required');
    }
    return actThenObserve(hwnd, snapshotId, () =>
      actOnAoiHostDesktopElement({ op: 'select', hwnd, ref, snapshotId, option }),
    );
  }

  if (toolName === DESKTOP_TOGGLE_TOOL) {
    const state = typeof params.state === 'string' ? params.state.trim() : '';
    if (state !== 'on' && state !== 'off' && state !== 'toggle') {
      return notPerformed('state must be on, off or toggle');
    }
    return actThenObserve(hwnd, snapshotId, () =>
      actOnAoiHostDesktopElement({ op: 'toggle', hwnd, ref, snapshotId, state }),
    );
  }

  if (toolName === DESKTOP_DRAG_TOOL) {
    const toRef = typeof params.to_ref === 'number' ? params.to_ref : Number.NaN;
    if (!Number.isInteger(toRef)) {
      return notPerformed('to_ref is required');
    }
    return actThenObserve(hwnd, snapshotId, () =>
      actOnAoiHostDesktopElement({ op: 'drag', hwnd, ref, snapshotId, toRef }),
    );
  }

  // desktop_act: invoke, or set_value when a value is supplied.
  return actThenObserve(hwnd, snapshotId, () =>
    actOnAoiHostDesktopElement({
      op: typeof params.value === 'string' ? 'set_value' : 'invoke',
      hwnd,
      ref,
      snapshotId,
      ...(typeof params.value === 'string' ? { value: params.value } : {}),
    }),
  );
}

export interface DesktopToolImage {
  dataUrl: string;
  name: string;
}

/**
 * Split a capture result into the text the model reads and the image it looks at.
 *
 * They travel separately because a tool message is text: a base64 PNG inlined
 * there would be megabytes of characters the model cannot actually see. The
 * caller puts the text in the tool result and the image on a following message,
 * which is the only role images attach to.
 */
export function splitDesktopToolImage(result: unknown): {
  payload: unknown;
  image: DesktopToolImage | null;
} {
  if (!result || typeof result !== 'object') {
    return { payload: result, image: null };
  }
  const record = result as Record<string, unknown> & { __image?: unknown };
  if (!('__image' in record)) {
    return { payload: result, image: null };
  }
  const { __image: raw, ...payload } = record;
  if (!raw || typeof raw !== 'object') {
    return { payload, image: null };
  }
  const candidate = raw as Record<string, unknown>;
  const dataUrl = typeof candidate.dataUrl === 'string' ? candidate.dataUrl : '';
  if (!dataUrl.startsWith('data:image/')) {
    return { payload, image: null };
  }
  return {
    payload,
    image: {
      dataUrl,
      name: typeof candidate.name === 'string' ? candidate.name : 'capture.png',
    },
  };
}
