// @vitest-environment node
import { createServer, type IncomingMessage, type Server } from 'http';
import { afterEach, describe, expect, it } from 'vitest';

import { serverSelfOrigin } from '../serverSelfOrigin';

function fakeRequest(socket: Record<string, unknown> | undefined, host?: string): IncomingMessage {
  return {
    socket,
    headers: { host: host ?? 'attacker.example', 'x-forwarded-proto': 'https' },
  } as unknown as IncomingMessage;
}

const servers: Server[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop() as Server;
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
});

describe('serverSelfOrigin', () => {
  it('ignores Host and X-Forwarded-Proto, which the client chooses', () => {
    expect(
      serverSelfOrigin(fakeRequest({ localAddress: '127.0.0.1', localPort: 3000 }, '10.0.0.9:80')),
    ).toBe('http://127.0.0.1:3000');
  });

  it('formats IPv6, unwraps IPv4-mapped addresses, and keeps TLS', () => {
    expect(serverSelfOrigin(fakeRequest({ localAddress: '::1', localPort: 3100 }))).toBe(
      'http://[::1]:3100',
    );
    expect(
      serverSelfOrigin(fakeRequest({ localAddress: '::ffff:192.168.1.5', localPort: 3000 })),
    ).toBe('http://192.168.1.5:3000');
    expect(
      serverSelfOrigin(
        fakeRequest({ localAddress: '127.0.0.1', localPort: 3443, encrypted: true }),
      ),
    ).toBe('https://127.0.0.1:3443');
  });

  it('falls back to the default dev origin without socket details', () => {
    expect(serverSelfOrigin(fakeRequest(undefined))).toBe('http://127.0.0.1:3000');
    expect(serverSelfOrigin(fakeRequest({ localAddress: '127.0.0.1' }))).toBe(
      'http://127.0.0.1:3000',
    );
  });

  it('names the address and port a real server accepted the request on', async () => {
    let seen = '';
    const server = createServer((req, res) => {
      seen = serverSelfOrigin(req);
      res.end('ok');
    });
    servers.push(server);
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    const address = server.address();
    const port = address && typeof address === 'object' ? address.port : 0;

    // A client-chosen Host does not change where the server would call itself.
    await fetch(`http://127.0.0.1:${port}/`, { headers: { 'x-forwarded-proto': 'https' } });

    expect(seen).toBe(`http://127.0.0.1:${port}`);
  });
});
