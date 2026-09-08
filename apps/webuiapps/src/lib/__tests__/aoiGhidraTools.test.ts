// @vitest-environment node
//
// Aoi's Ghidra tool surface. Two things under test:
//
//   - GATING: the tools cost tokens on every turn they are offered, so they are
//     only offered when the conversation is about binaries, plus a sticky window
//     after one is used.
//   - POSTURE: the surface must not reach config editing, approval running, or
//     Python bootstrapping. The claim "Aoi cannot approve its own analysis" is
//     only true while that stays true, so it is asserted against the source
//     rather than left as a comment.
import * as fs from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  GHIDRA_ANALYZE_START_TOOL,
  GHIDRA_FIND_BINARY_TOOL,
  GHIDRA_QUERY_TOOL,
  GHIDRA_REPORT_READ_TOOL,
  GHIDRA_REPORT_RUN_TOOL,
  GHIDRA_SESSION_LIST_TOOL,
  GHIDRA_SESSION_STOP_TOOL,
  cancelGhidraSweep,
  executeGhidraTool,
  getGhidraToolDefinitions,
  getGhidraToolPendingSummary,
  isGhidraTool,
  resetGhidraToolStickiness,
  shouldEnableGhidraTools,
  touchGhidraTools,
} from '../aoiGhidraTools';

const SOURCE = fs.readFileSync(join(__dirname, '..', 'aoiGhidraTools.ts'), 'utf-8');

interface FetchCall {
  url: string;
  init?: RequestInit;
}

let calls: FetchCall[] = [];
let responder: (url: string) => unknown = () => ({ ok: true });

function installFetch(): void {
  calls = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const payload = responder(String(url));
    return {
      status: 200,
      json: async () => payload,
    } as unknown as Response;
  });
}

beforeEach(() => {
  resetGhidraToolStickiness();
  installFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetGhidraToolStickiness();
});

describe('tool gating', () => {
  it('offers the tools when the conversation is about binaries', () => {
    for (const message of [
      'ghidra로 이 바이너리 분석해줘',
      'can you decompile this function',
      'run capa on the client',
      '리버싱 좀 도와줘',
      'draw the call graph',
    ]) {
      expect(shouldEnableGhidraTools(message)).toBe(true);
    }
  });

  it('stays out of unrelated turns', () => {
    for (const message of [
      'what is the weather',
      '오늘 일정 알려줘',
      'fix the css on the header',
    ]) {
      expect(shouldEnableGhidraTools(message)).toBe(false);
    }
  });

  it('looks a few messages back, not only at the latest one', () => {
    expect(
      shouldEnableGhidraTools('and the second one?', [
        { content: 'open ghidra on client.exe' },
        { content: 'ok' },
      ]),
    ).toBe(true);
  });

  it('stays available for a while after the lab is used', () => {
    expect(shouldEnableGhidraTools('and now?')).toBe(false);
    touchGhidraTools();
    expect(shouldEnableGhidraTools('and now?')).toBe(true);
  });

  it('treats a backwards clock as current rather than expired', () => {
    touchGhidraTools(Date.now() + 60 * 60 * 1000);
    expect(shouldEnableGhidraTools('and now?')).toBe(true);
  });

  it('knows its own tool names', () => {
    expect(isGhidraTool(GHIDRA_QUERY_TOOL)).toBe(true);
    expect(isGhidraTool('ida_sql_query')).toBe(false);
  });
});

describe('tool definitions', () => {
  it('exposes exactly the seven proposal/read tools', () => {
    const names = getGhidraToolDefinitions().map((tool) => tool.function.name);
    expect(names).toHaveLength(7);
    expect(names).toContain(GHIDRA_ANALYZE_START_TOOL);
    expect(names).toContain(GHIDRA_REPORT_RUN_TOOL);
    // Nothing that writes to the Ghidra database or the host.
    expect(
      names.some((name) => /rename|comment|delete|write|approve|config|bootstrap/i.test(name)),
    ).toBe(false);
  });

  it('tells the model that starting is a proposal, not an action', () => {
    const start = getGhidraToolDefinitions().find(
      (tool) => tool.function.name === GHIDRA_ANALYZE_START_TOOL,
    );
    expect(start?.function.description).toMatch(/PROPOSE|approval/);
  });

  it('lists the query sub-commands so the model does not have to guess', () => {
    const query = getGhidraToolDefinitions().find(
      (tool) => tool.function.name === GHIDRA_QUERY_TOOL,
    );
    expect(query?.function.description).toContain('decompile');
    expect(query?.function.description).toContain('callgraph');
  });
});

describe('posture guard', () => {
  it('does not import the operator-only client functions', () => {
    for (const forbidden of [
      'saveGhidraLabConfigRemote',
      'bootstrapGhidraPython',
      'runGhidraApproval',
    ]) {
      expect(SOURCE).not.toContain(forbidden);
    }
  });

  it('never posts to the approval or config routes directly', () => {
    expect(SOURCE).not.toContain('/approvals/run');
    expect(SOURCE).not.toContain('/config');
    expect(SOURCE).not.toContain('/bootstrap-python');
  });
});

describe('execution', () => {
  it('reports a pending approval rather than claiming a session started', async () => {
    responder = () => ({
      ok: true,
      preview: {
        allowed: true,
        blockReasons: [],
        approvalFingerprint: 'a'.repeat(64),
        targetSummary: 'Ghidra headless: C:\\bins\\client.exe',
        expiresAt: 0,
        autoApproved: false,
      },
    });
    const result = JSON.parse(
      await executeGhidraTool(GHIDRA_ANALYZE_START_TOOL, { binaryPath: 'C:\\bins\\client.exe' }),
    );
    expect(result.started).toBe(false);
    expect(result.awaitingApproval).toBe(true);
    expect(result.note).toContain('Nothing runs until');
  });

  it('passes a block reason back with a usable hint', async () => {
    responder = () => ({
      ok: true,
      preview: {
        allowed: false,
        blockReasons: ['preflight_jdk'],
        approvalFingerprint: '',
        targetSummary: '',
        expiresAt: 0,
        autoApproved: false,
      },
    });
    const result = JSON.parse(
      await executeGhidraTool(GHIDRA_ANALYZE_START_TOOL, { binaryPath: 'C:\\bins\\client.exe' }),
    );
    expect(result.blocked).toContain('preflight_jdk');
    expect(result.hint).toContain('setup');
  });

  it('surfaces why the lab is unusable in the session list', async () => {
    responder = (url) =>
      url.includes('/sessions')
        ? { ok: true, sessions: [] }
        : {
            ok: true,
            health: {
              configured: false,
              config: {},
              checks: [
                {
                  id: 'jdk',
                  label: 'JDK 21+',
                  ok: false,
                  found: 'Java 11',
                  remedy: 'Point at a JDK 21 home.',
                  required: true,
                },
              ],
              availableModes: [],
              ghidraVersion: '12.1.3',
              jdkVersion: '',
              jdkMajor: 11,
              pyghidraMcpVersion: '',
              capaVersion: '',
              analysisCapabilityEnabled: true,
              writeCapabilityEnabled: false,
              autoSessionCapabilityEnabled: false,
              globalPanic: false,
              problems: [],
            },
          };
    const result = JSON.parse(await executeGhidraTool(GHIDRA_SESSION_LIST_TOOL, {}));
    expect(result.lab.usable).toBe(false);
    expect(result.lab.blockedBy[0].check).toBe('jdk');
    expect(result.lab.blockedBy[0].fix).toContain('JDK 21');
  });

  it('refuses to invent arguments it was not given', async () => {
    const missing = JSON.parse(await executeGhidraTool(GHIDRA_QUERY_TOOL, { kind: 'imports' }));
    expect(missing.error).toBe('missing_session_or_kind');
    expect(calls).toHaveLength(0);
  });

  it('caps an oversized engine answer into valid JSON', async () => {
    responder = () => ({
      ok: true,
      query: {
        sessionId: 's',
        kind: 'decompile',
        mcpTool: 'decompile_function',
        rows: [{ body: 'x'.repeat(50000) }],
        rowCount: 1,
        truncated: false,
        elapsedMs: 1,
        engineError: '',
      },
    });
    const raw = await executeGhidraTool(GHIDRA_QUERY_TOOL, { sessionId: 's', kind: 'decompile' });
    const parsed = JSON.parse(raw);
    expect(parsed.truncated).toBe(true);
    expect(parsed.note).toContain('narrower');
    expect(raw.length).toBeLessThan(12000);
  });

  it('says a report is not ready rather than returning an empty one', async () => {
    responder = () => ({ ok: true, report: '' });
    const result = JSON.parse(
      await executeGhidraTool(GHIDRA_REPORT_READ_TOOL, { runId: 'grun-1' }),
    );
    expect(result.ready).toBe(false);
  });

  it('turns a route error into a readable refusal', async () => {
    responder = () => ({ ok: false, error: 'path_outside_roots' });
    const result = JSON.parse(
      await executeGhidraTool(GHIDRA_ANALYZE_START_TOOL, { binaryPath: 'C:\\x' }),
    );
    expect(result.error).toContain('path_outside_roots');
  });

  it('turns a transport failure into an answer, for every tool', async () => {
    // These run inside the model's turn. A tool that throws aborts the turn;
    // one that answers with the failure lets the model say what went wrong and
    // move on -- and the query tool's message has to point at the likely cause,
    // which is a session that is not ready yet.
    responder = () => {
      throw new Error('ECONNREFUSED 127.0.0.1:3000');
    };
    const cases: [string, Record<string, unknown>][] = [
      [GHIDRA_QUERY_TOOL, { sessionId: 'sess-1', kind: 'imports' }],
      [GHIDRA_REPORT_RUN_TOOL, { sessionId: 'sess-1' }],
      [GHIDRA_REPORT_READ_TOOL, { runId: 'grun-1-1' }],
      [GHIDRA_SESSION_STOP_TOOL, { sessionId: 'sess-1' }],
    ];
    for (const [tool, args] of cases) {
      const result = await executeGhidraTool(tool, args);
      expect(String(result), tool).toContain('ECONNREFUSED');
    }
    const queryAnswer = await executeGhidraTool(GHIDRA_QUERY_TOOL, {
      sessionId: 'sess-1',
      kind: 'imports',
    });
    expect(String(queryAnswer)).toContain('ghidra_session_list');
  });

  it('rejects an unknown tool name', async () => {
    const result = JSON.parse(await executeGhidraTool('ghidra_rename_function', {}));
    expect(result.error).toContain('unknown_ghidra_tool');
  });

  it('lists the roots when asked to find with no search term', async () => {
    responder = () => ({
      ok: true,
      browse: {
        path: '',
        entries: [
          { name: 'Bins', path: 'C:\\bins', kind: 'directory', sizeBytes: 0, analyzable: false },
        ],
        truncated: false,
      },
    });
    const result = JSON.parse(await executeGhidraTool(GHIDRA_FIND_BINARY_TOOL, {}));
    expect(result.entries[0].path).toBe('C:\\bins');
    expect(calls[0].url).not.toContain('find=');
  });

  it('searches when given a term, and explains a containment refusal', async () => {
    responder = () => ({
      ok: true,
      browse: { path: '', entries: [], truncated: true },
    });
    const found = JSON.parse(
      await executeGhidraTool(GHIDRA_FIND_BINARY_TOOL, { find: 'client', path: 'C:\\bins' }),
    );
    expect(found.truncated).toBe(true);
    expect(calls[0].url).toContain('find=client');

    responder = () => ({ ok: false, error: 'path_outside_roots' });
    const refused = JSON.parse(await executeGhidraTool(GHIDRA_FIND_BINARY_TOOL, { find: 'x' }));
    expect(refused.error).toContain('path_outside_roots');
    expect(refused.hint).toContain('registered as Ghidra Lab roots');
  });

  it('lists sweep runs with their stage progress when given no run id', async () => {
    responder = () => ({
      ok: true,
      runs: [
        {
          runId: 'grun-1',
          binaryName: 'client.exe',
          state: 'running',
          anchorCount: 12,
          droppedClaims: 0,
          stages: [
            { stage: 'identity', state: 'done' },
            { stage: 'imports', state: 'running' },
            { stage: 'synthesis', state: 'pending' },
          ],
          failureReason: '',
        },
      ],
    });
    const result = JSON.parse(await executeGhidraTool(GHIDRA_REPORT_READ_TOOL, {}));
    expect(result.runs[0].runId).toBe('grun-1');
    expect(result.runs[0].stages).toContain('identity:done');
    // Pending stages are noise in a chat result.
    expect(result.runs[0].stages).not.toContain('synthesis:pending');
  });

  it('returns a finished report and flags truncation', async () => {
    responder = () => ({ ok: true, report: '# Report\n'.repeat(3000) });
    const result = JSON.parse(
      await executeGhidraTool(GHIDRA_REPORT_READ_TOOL, { runId: 'grun-1' }),
    );
    expect(result.ready).toBe(true);
    expect(result.truncated).toBe(true);
  });

  it('passes a sweep block reason through without pretending it started', async () => {
    responder = () => ({
      ok: true,
      preview: {
        allowed: false,
        blockReasons: ['session_not_ready:starting'],
        approvalFingerprint: '',
        targetSummary: '',
      },
    });
    const result = JSON.parse(await executeGhidraTool(GHIDRA_REPORT_RUN_TOOL, { sessionId: 's1' }));
    expect(result.started).toBe(false);
    expect(result.blocked).toContain('session_not_ready:starting');
  });

  it('requires a session id for a sweep and for a stop', async () => {
    expect(JSON.parse(await executeGhidraTool(GHIDRA_REPORT_RUN_TOOL, {})).error).toBe(
      'missing_session_id',
    );
    expect(JSON.parse(await executeGhidraTool(GHIDRA_SESSION_STOP_TOOL, {})).error).toBe(
      'missing_session_id',
    );
    expect(calls).toHaveLength(0);
  });

  it('stops a session and reports which one', async () => {
    responder = () => ({ ok: true });
    const result = JSON.parse(
      await executeGhidraTool(GHIDRA_SESSION_STOP_TOOL, { sessionId: 's1' }),
    );
    expect(result.stopped).toBe(true);
    expect(result.sessionId).toBe('s1');
  });

  it('requires a binary path before proposing anything', async () => {
    const result = JSON.parse(await executeGhidraTool(GHIDRA_ANALYZE_START_TOOL, {}));
    expect(result.error).toBe('missing_binary_path');
    expect(result.hint).toContain('ghidra_find_binary');
    expect(calls).toHaveLength(0);
  });

  it('points at the open session when one already holds the binary', async () => {
    responder = () => ({
      ok: true,
      preview: {
        allowed: false,
        blockReasons: ['session_already_open'],
        approvalFingerprint: '',
        targetSummary: '',
        existingSessionId: 's9',
      },
    });
    const result = JSON.parse(
      await executeGhidraTool(GHIDRA_ANALYZE_START_TOOL, { binaryPath: 'C:\\bins\\a.exe' }),
    );
    expect(result.existingSessionId).toBe('s9');
    expect(result.hint).toContain('reuse it');
  });

  it('reports a session-list failure rather than claiming the lab is fine', async () => {
    responder = () => ({ ok: false, error: 'not_authenticated' });
    const result = JSON.parse(await executeGhidraTool(GHIDRA_SESSION_LIST_TOOL, {}));
    expect(result.error).toContain('not_authenticated');
  });

  it('describes what a starting session is waiting on', async () => {
    responder = (url) =>
      url.includes('/sessions')
        ? {
            ok: true,
            sessions: [
              {
                id: 's1',
                binaryName: 'client.exe',
                binaryPath: 'C:\\bins\\client.exe',
                projectName: 'p',
                state: 'starting',
                progress: {
                  phase: 'jvm',
                  projectBytes: 0,
                  deltaBytes: 0,
                  sampledAt: 0,
                  sampleCount: 1,
                },
                failureReason: '',
              },
            ],
          }
        : {
            ok: true,
            health: {
              checks: [],
              availableModes: ['headless'],
              ghidraVersion: '12.1.3',
              jdkVersion: 'Java 21',
              capaVersion: '',
            },
          };
    const result = JSON.parse(await executeGhidraTool(GHIDRA_SESSION_LIST_TOOL, {}));
    expect(result.sessions[0].waitingOn).toContain('JVM is still booting');
    expect(result.lab.usable).toBe(true);
  });
});

describe('pending summaries', () => {
  it('says something specific for every tool', () => {
    expect(getGhidraToolPendingSummary(GHIDRA_FIND_BINARY_TOOL, { find: 'tavern' })).toContain(
      'tavern',
    );
    expect(getGhidraToolPendingSummary(GHIDRA_FIND_BINARY_TOOL, {})).toContain('roots');
    expect(
      getGhidraToolPendingSummary(GHIDRA_ANALYZE_START_TOOL, {
        binaryPath: 'C:\\a\\b\\client.exe',
      }),
    ).toContain('client.exe');
    expect(getGhidraToolPendingSummary(GHIDRA_QUERY_TOOL, { kind: 'decompile' })).toContain(
      'decompile',
    );
    expect(getGhidraToolPendingSummary(GHIDRA_REPORT_RUN_TOOL, {})).toContain('sweep');
    expect(getGhidraToolPendingSummary(GHIDRA_REPORT_READ_TOOL, { runId: 'r' })).toContain(
      'report',
    );
    expect(getGhidraToolPendingSummary(GHIDRA_REPORT_READ_TOOL, {})).toContain('runs');
    expect(getGhidraToolPendingSummary(GHIDRA_SESSION_LIST_TOOL, {})).toBeTruthy();
    expect(getGhidraToolPendingSummary(GHIDRA_SESSION_STOP_TOOL, {})).toContain('Closing');
    expect(getGhidraToolPendingSummary('something_else', {})).toBe('Ghidra Lab');
  });
});

describe('cancelGhidraSweep', () => {
  it('is not a tool, but is callable by the app', async () => {
    responder = () => ({ ok: true });
    await expect(cancelGhidraSweep('grun-1')).resolves.toBeUndefined();
    expect(calls[0].url).toContain('runId=grun-1');
    expect(isGhidraTool('cancelGhidraSweep')).toBe(false);
  });
});
