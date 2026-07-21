import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { AoiHostBridgeSettingsPanel } from './AoiHostBridgeSettingsPanel';

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  } as unknown as Response;
}

// A URL-dispatched fetch mock so the panel's parallel initial loads all resolve
// regardless of order.
function installFetch(statusBody: Record<string, unknown>) {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const target = String(url);
    if (target.includes('/killswitch')) {
      return Promise.resolve(
        jsonResponse({
          ok: true,
          killSwitch: {
            globalPanic: false,
            enabledCapabilities: ['os_file_read', 'process_activity'],
            updatedAt: 1,
          },
        }),
      );
    }
    if (target.includes('/status')) {
      return Promise.resolve(jsonResponse({ ok: true, ...statusBody }));
    }
    if (target.includes('/spawn-allowlist')) {
      return Promise.resolve(jsonResponse({ ok: true, entries: [] }));
    }
    if (target.includes('/read-roots') || target.includes('/write-roots')) {
      return Promise.resolve(jsonResponse({ ok: true, roots: [] }));
    }
    if (target.includes('/browser-drive/standing-grants')) {
      return Promise.resolve(jsonResponse({ ok: true, grants: [] }));
    }
    if (target.includes('/browser-drive-allowlist')) {
      return Promise.resolve(jsonResponse({ ok: true, entries: [] }));
    }
    if (target.includes('/approvals')) {
      return Promise.resolve(jsonResponse({ ok: true, approvals: [] }));
    }
    if (target.includes('/api/aoi-autonomy/sources') || target.includes('/sources')) {
      return Promise.resolve(
        jsonResponse({
          ok: true,
          sessionPath: 'aoi/default',
          registry: { version: 1, sessionPath: 'aoi/default', sources: [], updatedAt: 1 },
        }),
      );
    }
    void init;
    return Promise.resolve(jsonResponse({ ok: false, error: 'unexpected route' }, false));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('AoiHostBridgeSettingsPanel', () => {
  it('renders the capabilities and toggles one via the kill switch', async () => {
    const fetchMock = installFetch({
      tokenConfigured: true,
      killSwitch: { globalPanic: false, enabledCapabilities: [], updatedAt: 0 },
    });
    render(<AoiHostBridgeSettingsPanel sessionPath="aoi/default" />);

    // Capabilities is the default host sub-section.
    expect(await screen.findByTestId('aoi-host-section-capabilities')).toBeTruthy();
    const toggle = await screen.findByTestId('aoi-host-cap-os_file_read');
    expect(toggle.textContent).toContain('Disabled');

    fireEvent.click(toggle);

    await waitFor(() =>
      expect(screen.getByTestId('aoi-host-cap-os_file_read').textContent).toContain('Enabled'),
    );
    const killswitchCall = fetchMock.mock.calls.find((call) =>
      String(call[0]).includes('/killswitch'),
    );
    expect(killswitchCall).toBeTruthy();
    const body = JSON.parse((killswitchCall?.[1] as { body: string }).body);
    expect(body).toEqual({ action: 'set', capability: 'os_file_read', enabled: true });
  });

  it('syncs process-activity session consent when Process list is enabled', async () => {
    const fetchMock = installFetch({
      tokenConfigured: true,
      killSwitch: { globalPanic: false, enabledCapabilities: [], updatedAt: 0 },
    });
    render(<AoiHostBridgeSettingsPanel sessionPath="aoi/default" />);

    const toggle = await screen.findByTestId('aoi-host-cap-process_activity');
    fireEvent.click(toggle);

    await waitFor(() =>
      expect(screen.getByTestId('aoi-host-cap-process_activity').textContent).toContain('Enabled'),
    );
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          (call) =>
            String(call[0]).includes('/sources') &&
            String((call[1] as { body?: string } | undefined)?.body || '').includes(
              'process-activity',
            ),
        ),
      ).toBe(true),
    );
  });

  it('creates a standing grant from the Standing grants tab', async () => {
    const fetchMock = installFetch({
      tokenConfigured: true,
      killSwitch: { globalPanic: false, enabledCapabilities: [], updatedAt: 0 },
    });
    render(<AoiHostBridgeSettingsPanel sessionPath="aoi/default" />);

    // Move to the Standing grants sub-section.
    const tab = await screen.findByText('Standing grants');
    fireEvent.click(tab);

    const domain = await screen.findByTestId('aoi-host-standing-domain-input');
    fireEvent.change(domain, { target: { value: 'example.com' } });
    fireEvent.change(screen.getByTestId('aoi-host-standing-ttl-input'), {
      target: { value: '15' },
    });
    fireEvent.change(screen.getByTestId('aoi-host-standing-max-input'), { target: { value: '5' } });
    fireEvent.click(screen.getByTestId('aoi-host-standing-add'));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        (c) =>
          String(c[0]).includes('/browser-drive/standing-grants') &&
          (c[1] as { method?: string } | undefined)?.method === 'POST',
      );
      expect(call).toBeTruthy();
      expect(JSON.parse((call?.[1] as { body: string }).body)).toEqual({
        domain: 'example.com',
        ttlMs: 15 * 60_000,
        maxActions: 5,
      });
    });
  });

  it('warns when the daemon has not minted a token', async () => {
    installFetch({
      tokenConfigured: false,
      killSwitch: { globalPanic: false, enabledCapabilities: [], updatedAt: 0 },
    });
    render(<AoiHostBridgeSettingsPanel />);
    await waitFor(() => expect(screen.getByTestId('aoi-host-no-token')).toBeTruthy());
  });
});
