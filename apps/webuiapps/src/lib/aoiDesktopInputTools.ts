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
  listAoiHostDesktopWindows,
  snapshotAoiHostDesktopWindow,
} from './aoiHostBridgeClient';

export const DESKTOP_WINDOWS_TOOL = 'desktop_windows';
export const DESKTOP_SNAPSHOT_TOOL = 'desktop_snapshot';
export const DESKTOP_ACT_TOOL = 'desktop_act';

const DESKTOP_INPUT_TOOLS: ReadonlySet<string> = new Set([
  DESKTOP_WINDOWS_TOOL,
  DESKTOP_SNAPSHOT_TOOL,
  DESKTOP_ACT_TOOL,
]);

export function isDesktopInputTool(toolName: string): boolean {
  return DESKTOP_INPUT_TOOLS.has(toolName);
}

export function getDesktopInputToolPendingSummary(toolName: string): string {
  if (toolName === DESKTOP_WINDOWS_TOOL) {
    return 'listing desktop windows';
  }
  if (toolName === DESKTOP_SNAPSHOT_TOOL) {
    return 'reading a window';
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

  const ref = typeof params.ref === 'number' ? params.ref : Number.NaN;
  const snapshotId =
    typeof params.snapshot_id === 'string'
      ? params.snapshot_id.trim()
      : typeof params.snapshotId === 'string'
        ? params.snapshotId.trim()
        : '';
  if (!Number.isInteger(ref) || !snapshotId) {
    return {
      ok: false,
      status: 'not_performed',
      error: 'ref and snapshot_id are required together',
      code: 'bad_request',
      note: 'Nothing was done. Take a desktop_snapshot and use a ref from it with its snapshot_id.',
    };
  }

  const view = await actOnAoiHostDesktopElement({
    hwnd,
    ref,
    snapshotId,
    ...(typeof params.value === 'string' ? { value: params.value } : {}),
  });
  return describeDesktopActVerdict(view);
}
