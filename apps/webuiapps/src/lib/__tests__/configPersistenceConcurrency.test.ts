import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isConfigVersionConflict,
  loadPersistedConfig,
  resetPersistedConfigVersion,
  savePersistedConfig,
  updatePersistedConfig,
} from '../configPersistence';

// A tiny in-memory stand-in for the dev-server /api/llm-config handler,
// including its ETag / If-Match contract. config.json has several independent
// whole-file writers, so these tests pin the behavior that stops one from
// silently dropping another's change.
function createConfigServer(initial: Record<string, unknown>) {
  let stored = JSON.stringify(initial);
  let writes = 0;
  const etagOf = (body: string) => `"etag-${body.length}-${body.slice(-12)}"`;

  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (!init || !init.method || init.method === 'GET') {
      return {
        ok: true,
        status: 200,
        headers: { get: (name: string) => (name === 'ETag' ? etagOf(stored) : null) },
        json: async () => JSON.parse(stored),
      } as unknown as Response;
    }
    const headers = (init.headers ?? {}) as Record<string, string>;
    const ifMatch = headers['If-Match'];
    if (ifMatch && ifMatch !== etagOf(stored)) {
      return {
        ok: false,
        status: 409,
        headers: { get: () => etagOf(stored) },
        json: async () => ({ error: 'conflict', code: 'config_version_conflict' }),
      } as unknown as Response;
    }
    stored = init.body as string;
    writes += 1;
    return {
      ok: true,
      status: 200,
      headers: { get: (name: string) => (name === 'ETag' ? etagOf(stored) : null) },
      json: async () => ({ ok: true }),
    } as unknown as Response;
  });

  return {
    fetchMock,
    current: () => JSON.parse(stored) as Record<string, unknown>,
    writeCount: () => writes,
    // Simulate another writer (Gmail token refresh, a settings panel) landing
    // between our read and our write.
    clobber: (mutate: (config: Record<string, unknown>) => Record<string, unknown>) => {
      stored = JSON.stringify(mutate(JSON.parse(stored)));
    },
  };
}

beforeEach(() => {
  resetPersistedConfigVersion();
});

describe('config optimistic concurrency', () => {
  it('sends If-Match from the last read and succeeds when nothing changed', async () => {
    const server = createConfigServer({ llm: { provider: 'deepseek' } });
    globalThis.fetch = server.fetchMock as unknown as typeof fetch;

    const loaded = await loadPersistedConfig();
    await savePersistedConfig({ ...loaded, tavily: { apiKey: 'tvly-new' } });

    const postCall = server.fetchMock.mock.calls.find((call) => call[1]?.method === 'POST');
    expect((postCall?.[1]?.headers as Record<string, string>)['If-Match']).toMatch(/^"etag-/);
    expect(server.current().tavily).toEqual({ apiKey: 'tvly-new' });
  });

  it('rejects a stale write with a typed conflict instead of clobbering', async () => {
    const server = createConfigServer({ llm: { provider: 'deepseek' } });
    globalThis.fetch = server.fetchMock as unknown as typeof fetch;

    const loaded = await loadPersistedConfig();
    server.clobber((config) => ({ ...config, tavily: { apiKey: 'written-by-someone-else' } }));

    await expect(savePersistedConfig({ ...loaded, idaPe: { mode: 'mcp-http' } })).rejects.toSatisfy(
      isConfigVersionConflict,
    );
    // The other writer's change is intact.
    expect(server.current().tavily).toEqual({ apiKey: 'written-by-someone-else' });
  });

  it('updatePersistedConfig retries against the fresh config and keeps both changes', async () => {
    const server = createConfigServer({ llm: { provider: 'deepseek' } });
    globalThis.fetch = server.fetchMock as unknown as typeof fetch;

    let attempt = 0;
    const ok = await updatePersistedConfig((current) => {
      attempt += 1;
      if (attempt === 1) {
        // A concurrent writer lands after we read but before we write.
        server.clobber((config) => ({ ...config, gmail: { connectedEmail: 'a@b.c' } }));
      }
      return { ...current, idaPe: { mode: 'mcp-http' } };
    });

    expect(ok).toBe(true);
    expect(attempt).toBe(2);
    const final = server.current();
    // Neither change was lost: this is exactly the case a blind overwrite broke.
    expect(final.idaPe).toEqual({ mode: 'mcp-http' });
    expect(final.gmail).toEqual({ connectedEmail: 'a@b.c' });
  });

  it('gives up after bounded retries instead of spinning forever', async () => {
    const server = createConfigServer({ llm: { provider: 'deepseek' } });
    globalThis.fetch = server.fetchMock as unknown as typeof fetch;

    let attempts = 0;
    await expect(
      updatePersistedConfig((current) => {
        attempts += 1;
        // Always conflicts: a pathological writer hammering the file.
        server.clobber((config) => ({ ...config, app: { title: `t${attempts}` } }));
        return { ...current, idaPe: { mode: 'prescan-only' } };
      }),
    ).rejects.toSatisfy(isConfigVersionConflict);
    expect(attempts).toBe(4);
  });

  it('reports false (no write) when the config cannot be read', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    const mutate = vi.fn((current) => current);
    expect(await updatePersistedConfig(mutate)).toBe(false);
    expect(mutate).not.toHaveBeenCalled();
  });

  it('surfaces a non-conflict failure rather than retrying it', async () => {
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      if (!init?.method || init.method === 'GET') {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({ llm: { provider: 'deepseek' } }),
        } as unknown as Response;
      }
      return {
        ok: false,
        status: 500,
        headers: { get: () => null },
        json: async () => ({ error: 'disk on fire' }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    await expect(updatePersistedConfig((current) => current)).rejects.toThrow(/disk on fire/);
  });
});
