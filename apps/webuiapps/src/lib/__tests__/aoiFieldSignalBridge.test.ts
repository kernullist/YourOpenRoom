import { describe, expect, it } from 'vitest';
import {
  buildAoiFieldSignalFromWorkspaceSnapshot,
  buildAoiKiraOutcomeFieldSignal,
  buildAoiPersonalMetadataFieldSignal,
  buildAoiResearchFieldSignal,
  buildAoiFieldSignalPacket,
} from '../aoiFieldSignalBridge';
import type { AoiWorkspaceSnapshot } from '../aoiAutonomyTypes';

const SESSION_PATH = 'aoi/default';
const NOW = 1_800_000_000_000;

function makeWorkspaceSnapshot(): AoiWorkspaceSnapshot {
  return {
    version: 1,
    sessionPath: SESSION_PATH,
    collectedAt: NOW,
    workspaceLabel: 'YourOpenRoom',
    sourceIds: ['workspace-git', 'workspace-build'],
    git: {
      version: 1,
      branchName: 'main',
      branchChanged: false,
      isDirty: true,
      changedFileCount: 2,
      stagedFileCount: 0,
      unstagedFileCount: 2,
      untrackedFileCount: 0,
      statusSummary: '2 changed files',
      changedFiles: [
        {
          version: 1,
          pathLabel: 'apps/webuiapps/src/lib/aoiAutonomyStore.ts',
          pathHash: 'abc123',
          status: 'modified',
          staged: false,
          unstaged: true,
          untracked: false,
        },
      ],
    },
    validation: {
      version: 1,
      command: 'pnpm test',
      result: 'passed',
      completedAt: NOW,
      touchedFileScopes: ['apps/webuiapps/src/lib'],
      freshness: 'fresh',
      evidenceRefs: ['validation:pnpm-test'],
    },
    freshness: 'fresh',
    evidenceRefs: ['workspace:git-status'],
    warnings: [],
  };
}

describe('Aoi Field Signal Bridge', () => {
  it('creates a fresh workspace signal packet without granting mutation authority', () => {
    const signal = buildAoiFieldSignalFromWorkspaceSnapshot(makeWorkspaceSnapshot(), NOW);

    expect(signal).toMatchObject({
      version: 1,
      sessionPath: SESSION_PATH,
      sourceKind: 'workspace',
      freshness: 'fresh',
      consentState: 'allowed',
      bodyAccess: 'metadata_only',
      risk: 'low',
      actionAuthority: 'display_only',
      mutationCount: 0,
      observedAt: NOW,
    });
    expect(signal.summary).toContain('2 changed files');
    expect(signal.evidenceRefs).toContain('validation:pnpm-test');
    expect(signal.cannotKnow).toEqual([]);
  });

  it('records stale research as cannotKnow instead of a current claim', () => {
    const signal = buildAoiResearchFieldSignal(
      {
        sessionPath: SESSION_PATH,
        runId: 'run-stale-re',
        title: 'RE trend scan',
        summary: 'The old report mentioned a debugger release.',
        freshness: 'stale',
        completedAt: NOW - 10_000,
        evidenceRefs: ['research:run-stale-re'],
      },
      NOW,
    );

    expect(signal.sourceKind).toBe('research');
    expect(signal.freshness).toBe('stale');
    expect(signal.summary).toContain('old report');
    expect(signal.cannotKnow.join(' ')).toContain('Current state cannot be claimed');
    expect(signal.mutationCount).toBe(0);
  });

  it('records Kira validation outcome as a zero-mutation field signal', () => {
    const signal = buildAoiKiraOutcomeFieldSignal(
      {
        sessionPath: SESSION_PATH,
        outcomeId: 'validation-001',
        status: 'failed',
        summary: 'Kira validation failed on targeted tests.',
        validatedAt: NOW,
        evidenceRefs: ['kira:validation-001'],
      },
      NOW,
    );

    expect(signal.sourceKind).toBe('kira');
    expect(signal.freshness).toBe('failed');
    expect(signal.summary).toContain('Kira failed');
    expect(signal.actionAuthority).toBe('display_only');
    expect(signal.mutationCount).toBe(0);
  });

  it('records disconnected personal metadata as a body-free blind spot', () => {
    const signal = buildAoiPersonalMetadataFieldSignal(
      {
        sessionPath: SESSION_PATH,
        sourceId: 'gmail-primary',
        label: 'Gmail primary',
        kind: 'gmail_metadata',
        consentState: 'disconnected',
        freshness: 'unknown',
        metadataSummary: 'Inbox metadata cannot be reached.',
        bodyPreview: 'body: private mail from honey@example.com',
        evidenceRefs: ['personal-metadata:gmail-primary'],
      },
      NOW,
    );

    expect(signal.sourceKind).toBe('personal_metadata');
    expect(signal.consentState).toBe('disconnected');
    expect(signal.bodyAccess).toBe('none');
    expect(signal.summary).not.toContain('honey@example.com');
    expect(signal.summary).not.toContain('private mail');
    expect(signal.cannotKnow.join(' ')).toContain('Private personal source body was not read');
    expect(signal.mutationCount).toBe(0);
  });

  it('redacts private paths, email addresses, and token-like values', () => {
    const signal = buildAoiFieldSignalPacket(
      {
        sessionPath: SESSION_PATH,
        sourceKind: 'manual',
        summary:
          'Check C:\\Users\\secret\\notes.txt for honey@example.com with token abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN',
        freshness: 'fresh',
        consentState: 'allowed',
        bodyAccess: 'metadata_only',
        evidenceRefs: [
          'file:C:\\Users\\secret\\notes.txt',
          'mail:honey@example.com',
          'token:abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN',
        ],
      },
      NOW,
    );

    const joined = [signal.summary, ...signal.evidenceRefs].join(' ');
    expect(joined).toContain('[redacted-path]');
    expect(joined).toContain('[redacted-email]');
    expect(joined).toContain('[redacted-token]');
    expect(joined).not.toContain('C:\\Users\\secret');
    expect(joined).not.toContain('honey@example.com');
    expect(joined).not.toContain('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN');
  });
});
