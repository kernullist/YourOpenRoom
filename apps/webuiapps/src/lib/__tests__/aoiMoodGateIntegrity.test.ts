import * as fs from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

// R6.2 safety contract: mood is EXPRESSION ONLY and must never reach a gate.
//
// A mood that could tighten or loosen a gate would be an autonomy input dressed
// as a feeling: a bug in the derivation would move real authority, and a user
// could not tell why. The relationship roadmap states this as an inviolable
// constraint, so it is asserted mechanically rather than left to review.
//
// This reads the gate modules as source text. That is deliberate: a type-level
// argument only proves mood is not passed today, while a source scan fails the
// moment someone adds a mood reference anywhere inside a gate -- including in a
// helper, a comment-guided refactor, or a new field.

const LIB_DIR = join(__dirname, '..');

// Every module that decides authority, delivery, trust, or spend.
const GATE_MODULES = [
  // Delivery / interruption decisions.
  'aoiInterruptionGovernor.ts',
  'aoiProactiveBriefPolicy.ts',
  // Trust, promotion, readiness.
  'aoiJarvisReadinessScorecard.ts',
  'aoiAutonomyPolicy.ts',
  'aoiCognitionReadiness.ts',
  // Spend.
  'aoiAutonomyLlmBudget.ts',
  'aoiScoutNetworkBudget.ts',
  // Real-effect eligibility.
  'aoiAutonomyExecution.ts',
];

// 'mood' appears legitimately in music-recommendation code (AoiMusicMood is a
// playlist vibe, unrelated to Aoi's own state), so the guard targets the
// relationship mood specifically plus any bare identifier use.
const MOOD_PATTERNS = [/AoiMoodState/, /deriveAoiMoodState/, /aoiMoodState/, /\bmood\b/i];

function readGateSource(fileName: string): string {
  return fs.readFileSync(join(LIB_DIR, fileName), 'utf-8');
}

describe('mood never reaches a gate (R6.2)', () => {
  it('has every listed gate module present, so the guard cannot silently pass', () => {
    for (const fileName of GATE_MODULES) {
      expect(fs.existsSync(join(LIB_DIR, fileName)), `${fileName} is missing`).toBe(true);
    }
  });

  it('finds no mood reference in any gate module', () => {
    const offenders: string[] = [];
    for (const fileName of GATE_MODULES) {
      const source = readGateSource(fileName);
      const lines = source.split(/\r?\n/);
      lines.forEach((line, index) => {
        // Skip the music vibe type, which is a different concept entirely.
        if (/AoiMusicMood|musicMood|moodBias|MOOD_QUERIES/.test(line)) {
          return;
        }
        if (MOOD_PATTERNS.some((pattern) => pattern.test(line))) {
          offenders.push(`${fileName}:${index + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it('keeps the mood module free of any gate import', () => {
    const source = fs.readFileSync(join(LIB_DIR, 'aoiMoodState.ts'), 'utf-8');
    // Pure and dependency-free: the direction of the dependency matters as much
    // as its absence. A mood module that imported a gate could grow a path back.
    expect(source).not.toMatch(/^import .*from/m);
    for (const fileName of GATE_MODULES) {
      const moduleName = fileName.replace(/\.ts$/, '');
      expect(source).not.toContain(moduleName);
    }
  });

  it('would actually catch a mood reference (the guard is not vacuous)', () => {
    // A guard that cannot fail proves nothing. These are the shapes a real
    // regression would take.
    const wouldOffend = [
      "import { deriveAoiMoodState } from './aoiMoodState';",
      'if (input.mood === "worried") { return blocked; }',
      '  moodState?: AoiMoodState;',
    ];
    for (const line of wouldOffend) {
      expect(MOOD_PATTERNS.some((pattern) => pattern.test(line))).toBe(true);
    }
    // And it must not fire on the unrelated music vibe, which is why the skip
    // exists at all.
    const musicLines = ['const mood: AoiMusicMood = "chill";', 'moodBias: { upbeat: 2 },'];
    for (const line of musicLines) {
      expect(/AoiMusicMood|musicMood|moodBias|MOOD_QUERIES/.test(line)).toBe(true);
    }
  });

  it('declares mood display-only, so no consumer can read authority from it', () => {
    const source = fs.readFileSync(join(LIB_DIR, 'aoiMoodState.ts'), 'utf-8');
    expect(source).toContain("actionAuthority: 'display_only'");
    expect(source).toContain('mutationCount: 0');
  });
});
