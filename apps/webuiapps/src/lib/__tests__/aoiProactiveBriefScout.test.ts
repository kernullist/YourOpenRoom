import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_AOI_AUTONOMY_POLICY } from '../aoiAutonomyPolicy';
import type { AoiAutonomyPolicy, AoiInterestProfile, AoiInterestTopic } from '../aoiAutonomyTypes';
import { loadAoiProactiveBriefCandidates, saveAoiInterestProfile } from '../aoiProactiveBriefStore';
import {
  normalizeAoiProactiveBriefSearchResults,
  type AoiProactiveBriefRawSearchResult,
  type AoiProactiveBriefSearchAdapter,
} from '../aoiProactiveBriefResearch';
import { runAoiProactiveBriefScout } from '../aoiProactiveBriefScout';

const tempRoots: string[] = [];
const SESSION_PATH = 'aoi/default';

function makeTempRoot(): string {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'aoi-proactive-brief-scout-test-'));
  tempRoots.push(root);
  return root;
}

function makePolicy(now = 1000): AoiAutonomyPolicy {
  return {
    ...DEFAULT_AOI_AUTONOMY_POLICY,
    enabled: true,
    proactiveSuggestionsEnabled: true,
    proactiveBriefing: {
      ...DEFAULT_AOI_AUTONOMY_POLICY.proactiveBriefing,
      enabled: true,
      allowBackgroundScout: true,
    },
    confidenceFloor: 0.5,
    defaultCooldownMs: 60 * 60 * 1000,
    updatedAt: now,
  };
}

function makeTopic(partial: Partial<AoiInterestTopic> = {}): AoiInterestTopic {
  return {
    version: 1,
    id: partial.id ?? 'aoi-interest-reverse-engineering',
    sessionPath: partial.sessionPath ?? SESSION_PATH,
    label: partial.label ?? 'Reverse Engineering',
    normalizedLabel: partial.normalizedLabel ?? 'reverse engineering',
    aliases: partial.aliases ?? ['RE', 'malware reversing'],
    source: partial.source ?? 'memory',
    memoryIds: partial.memoryIds ?? ['memory-re-001'],
    evidenceRefs: partial.evidenceRefs ?? ['memory:memory-re-001'],
    confidence: partial.confidence ?? 0.88,
    importance: partial.importance ?? 0.86,
    noveltyPreference: partial.noveltyPreference ?? 0.72,
    currentInfoPreference: partial.currentInfoPreference ?? 0.94,
    muted: partial.muted ?? false,
    pinned: partial.pinned ?? true,
    cooldownKey: partial.cooldownKey ?? 'interest:reverse-engineering',
    createdAt: partial.createdAt ?? 100,
    updatedAt: partial.updatedAt ?? 200,
  };
}

function saveProfile(root: string, topic: AoiInterestTopic = makeTopic()): AoiInterestProfile {
  return saveAoiInterestProfile(
    root,
    SESSION_PATH,
    {
      version: 1,
      sessionPath: SESSION_PATH,
      topics: [topic],
      generatedAt: 1000,
      sourceMemoryCount: 1,
      warnings: [],
    },
    1000,
  );
}

function makeSearch(results?: AoiProactiveBriefRawSearchResult[]): AoiProactiveBriefSearchAdapter {
  const defaultResults = [
    {
      title: 'Reverse engineering new loader technique',
      url: 'https://research.example.com/re/loader-technique',
      content: 'A public writeup about reverse engineering a loader technique.',
    },
    {
      title: 'Malware reversing case study',
      url: 'https://security.example.net/posts/re-case-study',
      content: 'A second public source with a reversing case study.',
    },
  ];
  return vi.fn(async (request) => ({
    query: request.query,
    retrievedAt: request.now,
    results: results ?? defaultResults,
  }));
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('Aoi proactive brief scout', () => {
  it('creates a source-backed candidate for an RE topic from public search results', async () => {
    const root = makeTempRoot();
    saveProfile(root);

    const result = await runAoiProactiveBriefScout({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      now: 10_000,
      budget: {
        allowNetwork: true,
        maxTopicsPerWakeup: 1,
        maxNetworkCallsPerWakeup: 1,
      },
      dependencies: {
        search: makeSearch(),
        loadPolicy: () => makePolicy(10_000),
      },
    });

    expect(result.createdCandidates).toHaveLength(1);
    expect(result.createdCandidates[0]?.topicLabel).toBe('Reverse Engineering');
    expect(result.createdCandidates[0]?.sources.map((source) => source.url)).toEqual([
      'https://research.example.com/re/loader-technique',
      'https://security.example.net/posts/re-case-study',
    ]);
    expect(result.createdCandidates[0]?.summary).toContain('source-backed current-info candidate');
    expect(loadAoiProactiveBriefCandidates(root, SESSION_PATH, 10_001)).toHaveLength(1);
  });

  it('returns a Tavily warning and creates no fake current-info brief when config is missing', async () => {
    const root = makeTempRoot();
    saveProfile(root);

    const result = await runAoiProactiveBriefScout({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      configFile: join(root, 'missing-config.json'),
      now: 10_000,
      budget: {
        allowNetwork: true,
      },
      dependencies: {
        loadPolicy: () => makePolicy(10_000),
      },
    });

    expect(result.createdCandidates).toHaveLength(0);
    expect(result.warnings).toContain('tavily_not_configured:cannot_refresh_current_info');
    expect(result.skippedTopics.some((topic) => topic.reason === 'tavily_not_configured')).toBe(
      true,
    );
    expect(loadAoiProactiveBriefCandidates(root, SESSION_PATH, 10_001)).toHaveLength(0);
  });

  it('deduplicates sources by normalized URL and host/title similarity', () => {
    const sources = normalizeAoiProactiveBriefSearchResults({
      retrievedAt: 10_000,
      results: [
        {
          title: 'Reverse Engineering Loader Technique',
          url: 'https://research.example.com/re/loader-technique?utm_source=aoi',
          content: 'First result.',
        },
        {
          title: 'Reverse Engineering Loader Technique',
          url: 'https://research.example.com/re/loader-technique',
          content: 'Duplicate result.',
        },
        {
          title: 'Reverse Engineering Loader Technique Explained',
          url: 'https://research.example.com/re/loader-technique-explained',
          content: 'Same host and very similar title.',
        },
        {
          title: 'Malware reversing case study',
          url: 'https://security.example.net/posts/re-case-study',
          content: 'Independent source.',
        },
      ],
    });

    expect(sources.map((source) => source.host)).toEqual([
      'research.example.com',
      'security.example.net',
    ]);
  });

  it('applies source host controls before storing a candidate', async () => {
    const root = makeTempRoot();
    saveProfile(root);

    const result = await runAoiProactiveBriefScout({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      now: 10_000,
      budget: {
        allowNetwork: true,
        maxTopicsPerWakeup: 1,
        maxNetworkCallsPerWakeup: 1,
        minSourcesPerCandidate: 1,
      },
      dependencies: {
        search: makeSearch(),
        loadPolicy: () => ({
          ...makePolicy(10_000),
          proactiveBriefing: {
            ...makePolicy(10_000).proactiveBriefing,
            sourceHostControls: {
              'research.example.com': {
                version: 1,
                host: 'research.example.com',
                allowed: true,
                muted: false,
                updatedAt: 10_000,
              },
              'security.example.net': {
                version: 1,
                host: 'security.example.net',
                allowed: false,
                muted: true,
                updatedAt: 10_000,
              },
            },
          },
        }),
      },
    });

    expect(result.createdCandidates).toHaveLength(1);
    expect(result.createdCandidates[0]?.sources.map((source) => source.host)).toEqual([
      'research.example.com',
    ]);
  });

  it('blocks repeated scout runs through proactive brief cooldowns', async () => {
    const root = makeTempRoot();
    saveProfile(root);
    const search = makeSearch();

    await runAoiProactiveBriefScout({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      now: 10_000,
      budget: {
        allowNetwork: true,
      },
      dependencies: {
        search,
        loadPolicy: () => makePolicy(10_000),
      },
    });
    const repeated = await runAoiProactiveBriefScout({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      now: 10_100,
      budget: {
        allowNetwork: true,
      },
      dependencies: {
        search,
        loadPolicy: () => makePolicy(10_000),
      },
    });

    expect(repeated.createdCandidates).toHaveLength(0);
    expect(
      repeated.skippedTopics.some(
        (topic) =>
          topic.reason === 'global_cooldown_active' || topic.reason === 'topic_cooldown_active',
      ),
    ).toBe(true);
  });

  it('rejects low-evidence search results instead of storing a candidate', async () => {
    const root = makeTempRoot();
    saveProfile(root);

    const result = await runAoiProactiveBriefScout({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      now: 10_000,
      budget: {
        allowNetwork: true,
        minSourcesPerCandidate: 2,
      },
      dependencies: {
        search: makeSearch([
          {
            title: 'Single source',
            url: 'https://research.example.com/re/single-source',
            content: 'Only one public source.',
          },
        ]),
        loadPolicy: () => makePolicy(10_000),
      },
    });

    expect(result.createdCandidates).toHaveLength(0);
    expect(result.skippedTopics.some((topic) => topic.reason === 'low_evidence')).toBe(true);
    expect(loadAoiProactiveBriefCandidates(root, SESSION_PATH, 10_001)).toHaveLength(0);
  });

  it('preserves cannot-know freshness text on stored candidates', async () => {
    const root = makeTempRoot();
    saveProfile(root);

    const result = await runAoiProactiveBriefScout({
      sessionsDir: root,
      sessionPath: SESSION_PATH,
      now: 10_000,
      budget: {
        allowNetwork: true,
      },
      dependencies: {
        search: makeSearch(),
        loadPolicy: () => makePolicy(10_000),
      },
    });
    const stored = loadAoiProactiveBriefCandidates(root, SESSION_PATH, 10_001);

    expect(result.sourceFreshness[0]?.cannotKnow.join(' ')).toContain('cannot know');
    expect(stored[0]?.freshness.cannotKnow.join(' ')).toContain('cannot know');
  });

  it('does not import the structured research start path in the quick scout modules', () => {
    const source = [
      fs.readFileSync(join(process.cwd(), 'src/lib/aoiProactiveBriefScout.ts'), 'utf-8'),
      fs.readFileSync(join(process.cwd(), 'src/lib/aoiProactiveBriefResearch.ts'), 'utf-8'),
    ].join('\n');

    expect(source).not.toMatch(/executeAoiResearchTool|startAoiResearchRun|start_research/);
  });
});
