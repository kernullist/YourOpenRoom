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
  actOnAoiHostDesktopElement,
  clickAoiHostDesktopPoint,
  listAoiHostDesktopApps,
  listAoiHostDesktopWindows,
  sendAoiHostDesktopWindowInput,
  snapshotAoiHostDesktopWindow,
} from './aoiHostBridgeClient';

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

export function getDesktopInputToolDefinitions(): ToolDef[] {
  return [
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
          '"delivered_unverified" (it was delivered but nothing proved it landed -- take a fresh ' +
          'desktop_snapshot and look before saying anything, and do NOT repeat the action or claim ' +
          'success); "not_performed" (nothing happened -- say so plainly and do not pretend otherwise). ' +
          'If `status` is "stale" the window changed: take a fresh snapshot and use the new refs.',
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
          'Nothing can prove the app acted on a keystroke, so this never reports "done": check the ' +
          'result with a fresh desktop_snapshot before saying what happened.',
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
          'LAST RESORT: click a raw point in a window, measured from its top-left corner. ' +
          'Use ONLY when desktop_snapshot returned note="no_automation_tree" -- that window tells ' +
          'Windows nothing about its controls, so there is no ref to click and this is the only ' +
          'way to reach it. If the snapshot listed elements, use desktop_act or desktop_click ' +
          'instead: a ref is checked against the window, a raw point is aimed at a guess. ' +
          'Credential fields are still refused by position, and nothing here can verify the click ' +
          'did anything.',
        parameters: {
          type: 'object',
          properties: {
            hwnd: { type: 'string', description: 'Window handle.' },
            x: { type: 'number', description: 'X from the window left edge, in pixels.' },
            y: { type: 'number', description: 'Y from the window top edge, in pixels.' },
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
          'Scrolling can reveal new controls, so take a fresh desktop_snapshot afterwards before ' +
          'addressing anything you can now see.',
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
          'the app accepted the drag; verify with a fresh desktop_snapshot.',
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
        name: DESKTOP_APPS_TOOL,
        description:
          'List the running desktop apps that have windows, grouped by program, with a window ' +
          'count each. Read-only. Use when the user names an app ("my editor", "Chrome") rather ' +
          'than a window, then desktop_windows to pick the specific window.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
  ];
}

export interface DesktopActToolResult {
  ok: boolean;
  status: 'done' | 'delivered_unverified' | 'not_performed' | 'stale';
  effect: string;
  verified: boolean;
  path?: string;
  code?: string;
  detail: string;
  note: string;
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
 * Execute one desktop-input tool call.
 *
 * Errors are returned as data rather than thrown: a thrown error becomes a bare
 * "error:" string in the transcript, which reads to the model as "something went
 * wrong" and leaves it free to guess. A structured not_performed says the one
 * thing that matters -- the window was not touched.
 */
export async function executeDesktopInputTool(
  toolName: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  if (toolName === DESKTOP_WINDOWS_TOOL) {
    const windows = await listAoiHostDesktopWindows();
    return { ok: true, windows };
  }
  if (toolName === DESKTOP_APPS_TOOL) {
    const apps = await listAoiHostDesktopApps();
    return { ok: true, apps };
  }

  const hwnd = typeof params.hwnd === 'string' ? params.hwnd.trim() : '';
  if (!hwnd) {
    return { ok: false, error: 'hwnd is required', code: 'bad_request' };
  }

  if (toolName === DESKTOP_SNAPSHOT_TOOL) {
    const snapshot = await snapshotAoiHostDesktopWindow(hwnd);
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
        name: element.name,
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
    return describeDesktopActVerdict(
      await sendAoiHostDesktopWindowInput({ op: 'key', hwnd, keys, delivery }),
    );
  }
  if (toolName === DESKTOP_TYPE_TOOL) {
    const text = typeof params.text === 'string' ? params.text : '';
    if (!text) {
      return notPerformed('text is required');
    }
    return describeDesktopActVerdict(
      await sendAoiHostDesktopWindowInput({ op: 'type', hwnd, text, delivery }),
    );
  }
  if (toolName === DESKTOP_FOCUS_TOOL) {
    return describeDesktopActVerdict(await sendAoiHostDesktopWindowInput({ op: 'focus', hwnd }));
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

  if (toolName === DESKTOP_CLICK_POINT_TOOL) {
    if (typeof params.x !== 'number' || typeof params.y !== 'number') {
      return notPerformed('x and y are required');
    }
    // No ref, so no snapshot to be stale against. The daemon still checks what
    // is under the point.
    return describeDesktopActVerdict(
      await clickAoiHostDesktopPoint({
        hwnd,
        x: params.x,
        y: params.y,
        ...(typeof params.button === 'string' ? { button: params.button } : {}),
        ...(typeof params.clicks === 'number' ? { clicks: params.clicks } : {}),
        ...(delivery ? { delivery } : {}),
      }),
    );
  }

  if (toolName === DESKTOP_CLICK_TOOL) {
    const modifiers = Array.isArray(params.modifiers)
      ? params.modifiers.filter((entry): entry is string => typeof entry === 'string')
      : typeof params.modifiers === 'string'
        ? [params.modifiers]
        : [];
    return describeDesktopActVerdict(
      await actOnAoiHostDesktopElement({
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
    return describeDesktopActVerdict(
      await actOnAoiHostDesktopElement({
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
    return describeDesktopActVerdict(
      await actOnAoiHostDesktopElement({ op: 'select', hwnd, ref, snapshotId, option }),
    );
  }

  if (toolName === DESKTOP_TOGGLE_TOOL) {
    const state = typeof params.state === 'string' ? params.state.trim() : '';
    if (state !== 'on' && state !== 'off' && state !== 'toggle') {
      return notPerformed('state must be on, off or toggle');
    }
    return describeDesktopActVerdict(
      await actOnAoiHostDesktopElement({ op: 'toggle', hwnd, ref, snapshotId, state }),
    );
  }

  if (toolName === DESKTOP_DRAG_TOOL) {
    const toRef = typeof params.to_ref === 'number' ? params.to_ref : Number.NaN;
    if (!Number.isInteger(toRef)) {
      return notPerformed('to_ref is required');
    }
    return describeDesktopActVerdict(
      await actOnAoiHostDesktopElement({ op: 'drag', hwnd, ref, snapshotId, toRef }),
    );
  }

  // desktop_act: invoke, or set_value when a value is supplied.
  const view = await actOnAoiHostDesktopElement({
    op: typeof params.value === 'string' ? 'set_value' : 'invoke',
    hwnd,
    ref,
    snapshotId,
    ...(typeof params.value === 'string' ? { value: params.value } : {}),
  });
  return describeDesktopActVerdict(view);
}
