import { describe, expect, it } from 'vitest';
import {
  classifyAoiBrowserDriveAction,
  normalizeAoiBrowserDriveActionKeys,
} from './aoiBrowserDriveAction';

// The browser vocabulary grew (tabs, dialogs, hover, drag, upload). Each new
// kind has to land on the right side of the read/act/forbidden split, because
// that split is what decides whether an approval is required at all.
describe('the expanded browser-drive vocabulary', () => {
  it('treats listing and switching tabs as observation', () => {
    expect(classifyAoiBrowserDriveAction({ kind: 'tabs' }).category).toBe('read');
    expect(classifyAoiBrowserDriveAction({ kind: 'tab', tabIndex: 1 }).category).toBe('read');
  });

  it('treats hover as an act, not a free look', () => {
    // Hover opens menus and fires the same handlers a click path does.
    const decision = classifyAoiBrowserDriveAction({ kind: 'hover', selector: '#menu' });
    expect(decision.category).toBe('act');
    expect(decision.requiresApproval).toBe(true);
  });

  it('treats drag, dialog and upload as acts', () => {
    for (const action of [
      { kind: 'drag' as const, selector: '#a', toSelector: '#b' },
      { kind: 'dialog' as const, disposition: 'accept' },
      { kind: 'upload' as const, selector: '#file', filePath: 'C:/work/a.pdf' },
    ]) {
      expect(classifyAoiBrowserDriveAction(action).category, action.kind).toBe('act');
    }
  });

  it('refuses to confirm a financial dialog', () => {
    // The page moved the commit into a confirm(); the answer is the same as for
    // clicking the button that raised it.
    const decision = classifyAoiBrowserDriveAction({
      kind: 'dialog',
      disposition: 'accept',
      targetText: 'Transfer $4,000 to this account?',
    });
    expect(decision.category).toBe('forbidden');
    expect(decision.forbidReason).toBe('financial_commit');
  });

  it('still allows DISMISSING a financial dialog', () => {
    // Backing out is how you decline; refusing that would trap the page.
    const decision = classifyAoiBrowserDriveAction({
      kind: 'dialog',
      disposition: 'dismiss',
      targetText: 'Transfer $4,000 to this account?',
    });
    expect(decision.category).toBe('act');
  });

  it('refuses a drag onto a commit control', () => {
    // Some UIs really are drag-to-confirm; a click by another route is still a
    // click.
    const decision = classifyAoiBrowserDriveAction({
      kind: 'drag',
      selector: '#slider',
      toSelector: '#pay',
      targetText: 'Slide to pay now',
    });
    expect(decision.forbidReason).toBe('financial_commit');
  });

  it('refuses attaching a file to a credential field', () => {
    const decision = classifyAoiBrowserDriveAction({
      kind: 'upload',
      selector: '#doc',
      filePath: 'C:/work/a.pdf',
      field: { type: 'password' },
    });
    expect(decision.forbidReason).toBe('sensitive_field');
  });

  it('refuses a captcha by any of the new routes', () => {
    for (const kind of ['hover', 'drag', 'upload'] as const) {
      const decision = classifyAoiBrowserDriveAction({
        kind,
        selector: '#c',
        targetText: "I'm not a robot",
      });
      expect(decision.forbidReason, kind).toBe('captcha');
    }
  });
});

describe('normalizeAoiBrowserDriveActionKeys', () => {
  it('accepts the snake_case names the tool schema advertises', () => {
    const action = normalizeAoiBrowserDriveActionKeys({
      kind: 'drag',
      selector: '#a',
      to_selector: '#b',
      to_element: 4,
      snapshot_id: 'bds-1',
      file_path: 'C:/work/a.pdf',
      tab_index: 2,
      prompt_text: 'hi',
    });
    expect(action).toMatchObject({
      toSelector: '#b',
      toElement: 4,
      snapshotId: 'bds-1',
      filePath: 'C:/work/a.pdf',
      tabIndex: 2,
      promptText: 'hi',
    });
  });

  it('leaves camelCase alone and prefers it when both are present', () => {
    const action = normalizeAoiBrowserDriveActionKeys({
      kind: 'upload',
      filePath: 'C:/work/right.pdf',
      file_path: 'C:/work/wrong.pdf',
    });
    expect(action.filePath).toBe('C:/work/right.pdf');
  });

  it('survives a malformed action instead of throwing', () => {
    expect(normalizeAoiBrowserDriveActionKeys(null).kind).toBe('wait');
    expect(normalizeAoiBrowserDriveActionKeys('nonsense').kind).toBe('wait');
  });

  it('carries the fields the forbidden checks read', () => {
    // A dropped key here is a check that silently does not run.
    const action = normalizeAoiBrowserDriveActionKeys({
      kind: 'dialog',
      disposition: 'accept',
      target_text: 'Place order',
    });
    expect(classifyAoiBrowserDriveAction(action).forbidReason).toBe('financial_commit');
  });
});
