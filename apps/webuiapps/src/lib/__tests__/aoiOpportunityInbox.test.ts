import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  archiveAoiOpportunity,
  buildAoiAutonomyStatus,
  dismissAoiOpportunity,
  loadAoiActiveOpportunities,
  loadAoiArchivedOpportunities,
  resolveAoiAutonomyPaths,
  snoozeAoiOpportunity,
  upsertAoiOpportunity,
  type AoiOpportunityUpsertInput,
} from '../aoiAutonomyStore';
import { buildAoiOpportunityInboxPanelSummary } from '../aoiAutonomyUi';

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'aoi-opportunity-inbox-test-'));
  tempRoots.push(root);
  return root;
}

function makeOpportunityInput(
  partial: Partial<AoiOpportunityUpsertInput> = {},
): AoiOpportunityUpsertInput {
  return {
    sourceKind: 'interest',
    title: 'Track RE toolchain changes',
    curiosityQuestion: 'Did a fresh reverse engineering toolchain change affect current work?',
    whyNow: 'The current session keeps returning to reverse engineering research.',
    evidenceNeed: 'Need a cited public source or recent local research artifact.',
    suggestedNextAction: 'Keep this on the dashboard until evidence exists.',
    risk: 'low',
    confidence: 0.82,
    urgency: 0.64,
    novelty: 0.71,
    deliveryRecommendation: 'dashboard',
    evidenceRefs: ['memory:interest-re', 'workspace:current-session'],
    dedupeKey: 'interest:re-toolchain',
    ...partial,
  };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('Aoi Opportunity Inbox storage', () => {
  it('persists display-only opportunities and dedupes active items by key', () => {
    const root = makeTempRoot();
    const first = upsertAoiOpportunity(root, 'aoi/default', makeOpportunityInput(), 1000);
    const second = upsertAoiOpportunity(
      root,
      'aoi/default',
      makeOpportunityInput({
        title: 'Track RE toolchain changes with fresh evidence',
        confidence: 0.91,
      }),
      2000,
    );
    const active = loadAoiActiveOpportunities(root, 'aoi/default', 2000);
    const paths = resolveAoiAutonomyPaths(root, 'aoi/default');

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.opportunity.id).toBe(first.opportunity.id);
    expect(second.opportunity).toMatchObject({
      actionAuthority: 'display_only',
      mutationCount: 0,
      title: 'Track RE toolchain changes with fresh evidence',
      confidence: 0.91,
      status: 'active',
    });
    expect(active).toHaveLength(1);
    expect(fs.existsSync(paths.activeOpportunities)).toBe(true);
  });

  it('derives a stable fallback dedupe key when one is not supplied', () => {
    const root = makeTempRoot();
    const input = makeOpportunityInput({ dedupeKey: undefined });
    const first = upsertAoiOpportunity(root, 'aoi/default', input, 1000);
    const second = upsertAoiOpportunity(
      root,
      'aoi/default',
      {
        ...input,
        confidence: 0.87,
      },
      2000,
    );
    const active = loadAoiActiveOpportunities(root, 'aoi/default', 2000);

    expect(first.opportunity.dedupeKey).toBe(second.opportunity.dedupeKey);
    expect(second.created).toBe(false);
    expect(active).toHaveLength(1);
    expect(active[0].confidence).toBe(0.87);
  });

  it('moves expired active opportunities into the archived list', () => {
    const root = makeTempRoot();
    const stored = upsertAoiOpportunity(
      root,
      'aoi/default',
      makeOpportunityInput({
        dedupeKey: 'workspace:stale-validation',
        expiresAt: 1500,
      }),
      1000,
    );

    expect(stored.active).toHaveLength(1);
    expect(loadAoiActiveOpportunities(root, 'aoi/default', 2000)).toHaveLength(0);

    const archived = loadAoiArchivedOpportunities(root, 'aoi/default', 2000);
    const status = buildAoiAutonomyStatus(root, 'aoi/default', 2000);

    expect(archived).toHaveLength(1);
    expect(archived[0]).toMatchObject({
      id: stored.opportunity.id,
      status: 'expired',
      actionAuthority: 'display_only',
      mutationCount: 0,
    });
    expect(status.activeOpportunityCount).toBe(0);
    expect(status.archivedOpportunityCount).toBe(1);
    expect(status.expiredOpportunityCount).toBe(1);
  });

  it('supports snooze, dismiss, and archive transitions without granting authority', () => {
    const root = makeTempRoot();
    const first = upsertAoiOpportunity(root, 'aoi/default', makeOpportunityInput(), 1000);
    const snoozed = snoozeAoiOpportunity(root, 'aoi/default', first.opportunity.id, {
      now: 1200,
      snoozeMs: 3000,
    });

    expect(snoozed.opportunity).toMatchObject({
      status: 'snoozed',
      snoozedUntil: 4200,
      actionAuthority: 'display_only',
      mutationCount: 0,
    });
    expect(snoozed.active).toHaveLength(1);

    const dismissed = dismissAoiOpportunity(root, 'aoi/default', first.opportunity.id, 1300);

    expect(dismissed.active).toHaveLength(0);
    expect(dismissed.archived[0]).toMatchObject({
      status: 'dismissed',
      archivedAt: 1300,
      actionAuthority: 'display_only',
      mutationCount: 0,
    });

    const second = upsertAoiOpportunity(
      root,
      'aoi/default',
      makeOpportunityInput({
        dedupeKey: 'manual:review-release-note',
        sourceKind: 'manual',
        title: 'Review release-note drift',
      }),
      2000,
    );
    const archived = archiveAoiOpportunity(root, 'aoi/default', second.opportunity.id, 2200);

    expect(archived.active).toHaveLength(0);
    expect(archived.archived[0]).toMatchObject({
      status: 'archived',
      archivedAt: 2200,
      actionAuthority: 'display_only',
      mutationCount: 0,
    });
  });
});

describe('Aoi Opportunity Inbox UI summary', () => {
  it('summarizes active opportunities with evidence and display-only boundary', () => {
    const root = makeTempRoot();
    upsertAoiOpportunity(root, 'aoi/default', makeOpportunityInput({ urgency: 0.4 }), 1000);
    upsertAoiOpportunity(
      root,
      'aoi/default',
      makeOpportunityInput({
        dedupeKey: 'kira:validation-failure',
        sourceKind: 'kira',
        title: 'Inspect Kira validation failure',
        urgency: 0.9,
        deliveryRecommendation: 'inline_card',
        evidenceRefs: ['kira:validation-failure-001'],
      }),
      1100,
    );

    const active = loadAoiActiveOpportunities(root, 'aoi/default', 1200);
    const archived = loadAoiArchivedOpportunities(root, 'aoi/default', 1200);
    const status = buildAoiAutonomyStatus(root, 'aoi/default', 1200);
    const summary = buildAoiOpportunityInboxPanelSummary({
      active,
      archived,
      status,
      now: 1200,
    });

    expect(summary.visible).toBe(true);
    expect(summary.activeCount).toBe(2);
    expect(summary.countLabel).toContain('active 2');
    expect(summary.safetyBoundaryLabel).toContain('Display-only inbox');
    expect(summary.itemLabels[0]).toMatchObject({
      titleLabel: 'Inspect Kira validation failure',
      deliveryLabel: 'inline card / active',
    });
    expect(summary.itemLabels[0].evidenceRefs).toEqual(['kira:validation-failure-001']);
    expect(summary.evidenceRefs).toEqual(
      expect.arrayContaining(['kira:validation-failure-001', 'memory:interest-re']),
    );
  });
});
