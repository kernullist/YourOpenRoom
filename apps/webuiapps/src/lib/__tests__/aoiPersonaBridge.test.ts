import { describe, expect, it } from 'vitest';

import { buildAoiPersonaBridgeBlock } from '../aoiPersonaBridge';

const NOW = Date.UTC(2026, 6, 30);
const DAY = 24 * 60 * 60 * 1000;

describe('buildAoiPersonaBridgeBlock', () => {
  it('is empty without a stored relationship, leaving the persona untouched', () => {
    // A first-ever run must produce byte-identical prompt output to before this
    // block existed.
    expect(buildAoiPersonaBridgeBlock({ characterName: 'Aoi' })).toBe('');
    expect(buildAoiPersonaBridgeBlock({ characterName: 'Aoi', sessionCount: 1 })).toBe('');
    expect(
      buildAoiPersonaBridgeBlock({ characterName: 'Aoi', sessionCount: 0, milestones: [] }),
    ).toBe('');
  });

  it('states the reconciliation and the register note', () => {
    const block = buildAoiPersonaBridgeBlock({ characterName: 'Aoi', sessionCount: 12 });

    expect(block).toContain('## Who you are in this work');
    expect(block).toContain('You are Aoi.');
    // The reconciliation: the operator work is hers, not a role she switches into.
    expect(block).toContain('is YOUR work, not a separate role');
    // The register note: policy governs what is allowed, not how she speaks.
    expect(block).toContain('define what is ALLOWED, not how you talk');
    expect(block).toContain('Follow them exactly');
  });

  it('summarizes only what is on record and forbids going beyond it', () => {
    const block = buildAoiPersonaBridgeBlock({
      characterName: 'Aoi',
      sessionCount: 42,
      firstMetAt: NOW - 200 * DAY,
      milestones: [
        { label: 'We started working together.', occurredAt: NOW - 200 * DAY },
        { label: 'Trust was raised to L4.', occurredAt: NOW - DAY },
      ],
      mood: 'proud',
      openThreadTitles: ['Daemon restart soak'],
      arc: { arcName: 'Bounty Hunter Fugue' },
    });

    expect(block).toContain('never invent beyond this');
    expect(block).toContain('42 sessions since 2026-01-11');
    expect(block).toContain('You finished "Bounty Hunter Fugue" together.');
    // Only the newest milestone, not the whole history.
    expect(block).toContain('Trust was raised to L4.');
    expect(block).not.toContain('We started working together.');
    expect(block).toContain('quietly pleased');
    expect(block).toContain('Daemon restart soak');
  });

  it('omits a neutral mood rather than describing an absent state', () => {
    const withNeutral = buildAoiPersonaBridgeBlock({
      characterName: 'Aoi',
      sessionCount: 5,
      mood: 'neutral',
    });
    expect(withNeutral).not.toContain('background mood');

    expect(
      buildAoiPersonaBridgeBlock({ characterName: 'Aoi', sessionCount: 5, mood: 'worried' }),
    ).toContain('uneasy');
  });

  it('drops the session line for a single session and a non-finite count', () => {
    expect(
      buildAoiPersonaBridgeBlock({ characterName: 'Aoi', sessionCount: 1, mood: 'content' }),
    ).not.toContain('sessions');
    expect(
      buildAoiPersonaBridgeBlock({
        characterName: 'Aoi',
        sessionCount: Number.NaN,
        mood: 'content',
      }),
    ).not.toContain('sessions');
  });

  it('omits the since-date when the first meeting is unknown', () => {
    const block = buildAoiPersonaBridgeBlock({ characterName: 'Aoi', sessionCount: 9 });
    expect(block).toContain('across 9 sessions.');
    expect(block).not.toContain('since');
  });

  it('shows at most two open threads', () => {
    const block = buildAoiPersonaBridgeBlock({
      characterName: 'Aoi',
      sessionCount: 3,
      openThreadTitles: ['one', 'two', 'three'],
    });
    expect(block).toContain('one; two');
    expect(block).not.toContain('three');
  });

  it('stays bounded by dropping facts rather than truncating a claim', () => {
    const block = buildAoiPersonaBridgeBlock({
      characterName: 'Aoi',
      sessionCount: 42,
      firstMetAt: NOW - 200 * DAY,
      milestones: [{ label: 'M'.repeat(300), occurredAt: NOW }],
      mood: 'worried',
      openThreadTitles: ['T'.repeat(300), 'U'.repeat(300)],
      arc: { arcName: 'A'.repeat(300) },
    });

    expect(block.length).toBeLessThanOrEqual(900);
    // A dropped fact is gone entirely; nothing ends mid-claim about the
    // relationship.
    expect(block).not.toMatch(/-\s*$/);
    expect(block).toContain('## Who you are in this work');
  });

  it('falls back to a generic pronoun for a blank character name', () => {
    const block = buildAoiPersonaBridgeBlock({ characterName: '   ', sessionCount: 4 });
    expect(block).toContain('You are you.');
  });
});
