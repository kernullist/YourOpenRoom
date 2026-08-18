import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appendAoiBrowserDriveAuditEntry,
  loadAoiBrowserDriveAuditEntries,
  normalizeAoiBrowserDriveAuditEntry,
  pruneAoiBrowserDriveAuditEntries,
  recordAoiBrowserDriveAuditEntry,
  resolveAoiBrowserDriveAuditStorePath,
  DEFAULT_AOI_BROWSER_DRIVE_AUDIT_STORE,
  type AoiBrowserDriveAuditEntry,
} from '../aoiBrowserDriveAuditStore';

const tempRoots: string[] = [];
function makeHome(): string {
  const home = fs.mkdtempSync(join(os.tmpdir(), 'aoi-bd-audit-'));
  tempRoots.push(home);
  return home;
}
afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

const ACT_INPUT = {
  runId: 'run-1',
  stepIndex: 1,
  actionKind: 'click',
  actionSummary: 'click #refresh on example.com',
  category: 'act' as const,
  ok: true,
  url: 'https://example.com/account',
  beforeScreenshotRef: 'run-1/step-1-before.png',
  afterScreenshotRef: 'run-1/step-1-after.png',
  beforeDomRef: 'run-1/step-1-before.html',
  afterDomRef: 'run-1/step-1-after.html',
};

describe('normalize + prune', () => {
  it('rejects malformed entries and keeps only valid ones', () => {
    expect(normalizeAoiBrowserDriveAuditEntry(null)).toBeNull();
    expect(normalizeAoiBrowserDriveAuditEntry({ version: 2, id: 'x' })).toBeNull();
    const good = normalizeAoiBrowserDriveAuditEntry({
      version: 1,
      id: 'a',
      runId: 'r',
      stepIndex: 0,
      actionKind: 'click',
      actionSummary: 'click',
      category: 'act',
      ok: true,
      url: 'https://example.com',
      recordedAt: 10,
    });
    expect(good?.category).toBe('act');
  });

  it('drops expired entries and caps chronologically', () => {
    const now = 1_000_000_000_000;
    const entries: AoiBrowserDriveAuditEntry[] = [
      // expired (older than 7 days)
      {
        version: 1,
        id: 'old',
        runId: 'r',
        stepIndex: 0,
        actionKind: 'click',
        actionSummary: 's',
        category: 'act',
        ok: true,
        url: 'u',
        recordedAt: now - 8 * 24 * 60 * 60 * 1000,
      },
      {
        version: 1,
        id: 'fresh',
        runId: 'r',
        stepIndex: 1,
        actionKind: 'click',
        actionSummary: 's',
        category: 'act',
        ok: true,
        url: 'u',
        recordedAt: now - 1000,
      },
    ];
    const pruned = pruneAoiBrowserDriveAuditEntries(entries, now);
    expect(pruned).toHaveLength(1);
    expect(pruned[0].id).toBe('fresh');
  });
});

describe('appendAoiBrowserDriveAuditEntry (pure)', () => {
  it('appends with generated id + recordedAt and keeps the refs', () => {
    const { store, entry } = appendAoiBrowserDriveAuditEntry(
      { ...DEFAULT_AOI_BROWSER_DRIVE_AUDIT_STORE, entries: [] },
      ACT_INPUT,
      2000,
      'abcd',
    );
    expect(entry.id).toContain('abcd');
    expect(entry.recordedAt).toBe(2000);
    expect(entry.beforeScreenshotRef).toBe('run-1/step-1-before.png');
    expect(store.entries).toHaveLength(1);
    expect(store.updatedAt).toBe(2000);
  });
});

describe('persistence round-trip', () => {
  it('records and reloads entries under host-bridge/', () => {
    const home = makeHome();
    const count = recordAoiBrowserDriveAuditEntry(home, ACT_INPUT, 3000);
    expect(count).toBe(1);
    expect(fs.existsSync(resolveAoiBrowserDriveAuditStorePath(home))).toBe(true);

    recordAoiBrowserDriveAuditEntry(
      home,
      { ...ACT_INPUT, stepIndex: 0, category: 'read', actionKind: 'navigate', ok: true },
      3100,
    );
    const entries = loadAoiBrowserDriveAuditEntries(home, 3200);
    expect(entries).toHaveLength(2);
    // chronological
    expect(entries[0].recordedAt).toBeLessThanOrEqual(entries[1].recordedAt);
    expect(entries.some((e) => e.category === 'read')).toBe(true);
  });

  it('returns an empty store when the file is missing or malformed', () => {
    const home = makeHome();
    expect(loadAoiBrowserDriveAuditEntries(home, 1)).toEqual([]);
    fs.mkdirSync(join(home, 'host-bridge'), { recursive: true });
    fs.writeFileSync(resolveAoiBrowserDriveAuditStorePath(home), 'not json', 'utf-8');
    expect(loadAoiBrowserDriveAuditEntries(home, 1)).toEqual([]);
  });
});

// An ok:true entry with effect:'unverifiable' is an act that ran with nothing
// proving it landed. If the ledger keeps only `ok`, an after-the-fact audit
// cannot tell a real change from a call that merely returned -- which is the
// whole question an audit exists to answer.
describe('audit records what was proven, not just that the call returned', () => {
  it('keeps the effect and the read-back verification', () => {
    const { entry } = appendAoiBrowserDriveAuditEntry(
      null,
      {
        runId: 'r1',
        stepIndex: 0,
        actionKind: 'type',
        actionSummary: 'type into #q',
        category: 'act',
        ok: true,
        effect: 'confirmed',
        verified: true,
        url: 'https://example.com/',
      },
      1,
      'a',
    );
    expect(entry.effect).toBe('confirmed');
    expect(entry.verified).toBe(true);
  });

  it('separates a delivered-but-unproven act from a proven one', () => {
    const { entry } = appendAoiBrowserDriveAuditEntry(
      null,
      {
        runId: 'r1',
        stepIndex: 0,
        actionKind: 'click',
        actionSummary: 'click #go',
        category: 'act',
        ok: true,
        effect: 'unverifiable',
        url: 'https://example.com/',
      },
      1,
      'b',
    );
    expect(entry.ok).toBe(true);
    expect(entry.effect).toBe('unverifiable');
    expect(entry.verified).toBeUndefined();
  });

  it('drops an unrecognized effect rather than storing it as evidence', () => {
    const { entry } = appendAoiBrowserDriveAuditEntry(
      null,
      {
        runId: 'r1',
        stepIndex: 0,
        actionKind: 'click',
        actionSummary: 'click #go',
        category: 'act',
        ok: true,
        effect: 'totally-fine' as never,
        verified: 'yes' as never,
        url: 'https://example.com/',
      },
      1,
      'c',
    );
    expect(entry.effect).toBeUndefined();
    expect(entry.verified).toBeUndefined();
  });

  it('survives a round trip through the entry normalizer', () => {
    const { entry } = appendAoiBrowserDriveAuditEntry(
      null,
      {
        runId: 'r1',
        stepIndex: 0,
        actionKind: 'type',
        actionSummary: 'type into #q',
        category: 'act',
        ok: true,
        effect: 'suspected_noop',
        url: 'https://example.com/',
      },
      1,
      'd',
    );
    const reloaded = normalizeAoiBrowserDriveAuditEntry(JSON.parse(JSON.stringify(entry)));
    expect(reloaded?.effect).toBe('suspected_noop');
  });
});
