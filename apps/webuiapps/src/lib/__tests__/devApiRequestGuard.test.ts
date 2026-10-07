// @vitest-environment node
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'http';
import { describe, expect, it, vi } from 'vitest';

import {
  createDevApiRequestGuard,
  evaluateDevApiRequest,
  isDevApiHostAllowed,
} from '../devApiRequestGuard';

function req(method: string, url: string, headers: IncomingHttpHeaders) {
  return { method, url, headers };
}

describe('isDevApiHostAllowed', () => {
  it('accepts loopback names and IP literals, refuses rebound names', () => {
    for (const host of [
      'localhost:3000',
      'app.localhost',
      '127.0.0.1:3000',
      '[::1]:3000',
      '192.168.0.5:3000',
    ]) {
      expect(isDevApiHostAllowed(host), host).toBe(true);
    }
    for (const host of ['evil.example:3000', 'localhost.evil.example', '', undefined]) {
      expect(isDevApiHostAllowed(host), String(host)).toBe(false);
    }
  });

  it('honours configured hosts, including dotted wildcards, and the allow-all switch', () => {
    expect(isDevApiHostAllowed('dev.example:3000', ['dev.example'])).toBe(true);
    expect(isDevApiHostAllowed('a.b.example', ['.b.example'])).toBe(true);
    expect(isDevApiHostAllowed('b.example', ['.b.example'])).toBe(true);
    expect(isDevApiHostAllowed('other.example', ['.b.example'])).toBe(false);
    expect(isDevApiHostAllowed('anything.example', true)).toBe(true);
    expect(isDevApiHostAllowed('bad host name', [])).toBe(false);
  });
});

describe('evaluateDevApiRequest', () => {
  const host = { host: 'localhost:3000' };

  it('lets same-origin browser requests and header-less local clients through', () => {
    expect(
      evaluateDevApiRequest(
        req('POST', '/api/llm-config', {
          ...host,
          origin: 'http://localhost:3000',
          'sec-fetch-site': 'same-origin',
        }),
      ),
    ).toEqual({ allowed: true });
    // The daemon, CLIs and tests send neither Origin nor Sec-Fetch-*.
    expect(evaluateDevApiRequest(req('POST', '/api/session-data', host))).toEqual({
      allowed: true,
    });
  });

  it('refuses a cross-site simple POST, which is how a visited page reached these routes', () => {
    expect(
      evaluateDevApiRequest(
        req('POST', '/api/openvscode/run', {
          ...host,
          origin: 'https://evil.example',
          'content-type': 'text/plain;charset=UTF-8',
          'sec-fetch-site': 'cross-site',
        }),
      ),
    ).toEqual({ allowed: false, reason: 'cross_origin' });
    // Older browsers without Origin on the request still send Sec-Fetch-Site.
    expect(
      evaluateDevApiRequest(
        req('POST', '/api/aoi-autonomy/policy', { ...host, 'sec-fetch-site': 'cross-site' }),
      ),
    ).toEqual({ allowed: false, reason: 'cross_site_request' });
    expect(evaluateDevApiRequest(req('POST', '/api/x', { ...host, origin: 'null' }))).toEqual({
      allowed: false,
      reason: 'cross_origin',
    });
    expect(evaluateDevApiRequest(req('POST', '/api/x', { ...host, origin: 'not a url' }))).toEqual({
      allowed: false,
      reason: 'cross_origin',
    });
    expect(
      evaluateDevApiRequest(req('POST', '/api/x', { ...host, origin: 'http://localhost:5173' })),
    ).toEqual({ allowed: false, reason: 'cross_origin' });
  });

  it('refuses DNS rebinding even though the browser calls it same-origin', () => {
    expect(
      evaluateDevApiRequest(
        req('POST', '/api/aoi-host/killswitch', {
          host: 'rebind.evil.example:3000',
          origin: 'http://rebind.evil.example:3000',
          'sec-fetch-site': 'same-origin',
        }),
      ),
    ).toEqual({ allowed: false, reason: 'host_not_allowed' });
  });

  it('keeps cross-site top-level GET navigations working (OAuth callbacks)', () => {
    expect(
      evaluateDevApiRequest(
        req('GET', '/api/gmail/oauth/callback?code=x', {
          ...host,
          'sec-fetch-site': 'cross-site',
          'sec-fetch-mode': 'navigate',
        }),
      ),
    ).toEqual({ allowed: true });
    // ...but not a cross-site subresource GET (an <img> aimed at a GET that writes).
    expect(
      evaluateDevApiRequest(
        req('GET', '/api/aoi-autonomy/mission', {
          ...host,
          'sec-fetch-site': 'cross-site',
          'sec-fetch-mode': 'no-cors',
        }),
      ),
    ).toEqual({ allowed: false, reason: 'cross_site_request' });
    // ...nor a cross-site form POST navigation.
    expect(
      evaluateDevApiRequest(
        req('POST', '/api/llm-config', {
          ...host,
          'sec-fetch-site': 'same-site',
          'sec-fetch-mode': 'navigate',
        }),
      ),
    ).toEqual({ allowed: false, reason: 'cross_site_request' });
  });

  it('never lets a foreign site open the third-party-HTML proxy as a document', () => {
    expect(
      evaluateDevApiRequest(
        req('GET', '/api/browser-reader?url=https%3A%2F%2Fevil.example', {
          ...host,
          'sec-fetch-site': 'cross-site',
          'sec-fetch-mode': 'navigate',
          'sec-fetch-dest': 'document',
        }),
      ),
    ).toEqual({ allowed: false, reason: 'cross_site_document' });
  });

  it('reads the first value of a repeated header', () => {
    expect(
      evaluateDevApiRequest(
        req('POST', '/api/x', { ...host, origin: ['https://evil.example'] as unknown as string }),
      ),
    ).toEqual({ allowed: false, reason: 'cross_origin' });
  });

  it('still compares Origin with Host when every host is allowed', () => {
    // allowedHosts: true skips the host check, so an unparseable Host reaches the
    // Origin comparison and must not match anything.
    expect(
      evaluateDevApiRequest(
        req('POST', '/api/x', { host: 'exa mple.com', origin: 'http://example.com' }),
        { allowedHosts: true },
      ),
    ).toEqual({ allowed: false, reason: 'cross_origin' });
  });
});

describe('createDevApiRequestGuard', () => {
  function run(url: string, headers: IncomingHttpHeaders, method = 'POST') {
    const guard = createDevApiRequestGuard();
    const next = vi.fn();
    const writeHead = vi.fn();
    const end = vi.fn();
    guard(
      { method, url, headers } as unknown as IncomingMessage,
      { writeHead, end } as unknown as ServerResponse,
      next,
    );
    return { next, writeHead, end };
  }

  it('answers 403 with the reason and never reaches the route', () => {
    const result = run('/api/llm-config', {
      host: 'localhost:3000',
      origin: 'https://evil.example',
    });
    expect(result.next).not.toHaveBeenCalled();
    expect(result.writeHead).toHaveBeenCalledWith(403, expect.any(Object));
    expect(JSON.parse(String(result.end.mock.calls[0][0]))).toMatchObject({
      error: 'forbidden_request_origin',
      reason: 'cross_origin',
    });
  });

  it('passes allowed requests and everything outside /api', () => {
    expect(run('/api/llm-config', { host: 'localhost:3000' }).next).toHaveBeenCalledTimes(1);
    expect(
      run('/src/index.tsx', { host: 'evil.example', origin: 'https://evil.example' }, 'GET').next,
    ).toHaveBeenCalledTimes(1);
  });
});

describe('evaluateDevApiRequest without a Host header', () => {
  it('passes a non-browser request, refuses one that carries browser headers', () => {
    expect(evaluateDevApiRequest(req('POST', '/api/x', {}))).toEqual({ allowed: true });
    expect(
      evaluateDevApiRequest(req('POST', '/api/x', { origin: 'https://evil.example' })),
    ).toEqual({ allowed: false, reason: 'host_not_allowed' });
    expect(
      evaluateDevApiRequest(req('POST', '/api/x', { 'sec-fetch-site': 'cross-site' })),
    ).toEqual({ allowed: false, reason: 'host_not_allowed' });
  });
});
