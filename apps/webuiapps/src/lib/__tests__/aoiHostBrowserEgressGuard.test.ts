import { afterEach, describe, expect, it } from 'vitest';
import * as http from 'http';
import * as net from 'net';

import {
  buildAoiHostBrowserEgressArgs,
  startAoiHostBrowserEgressGuard,
  type AoiHostBrowserEgressGuard,
} from '../aoiHostBrowserEgressGuard';

// The guard is a real proxy on loopback; so is the "site" behind it. A site on
// loopback can only stand in for a public one through the test-only exemption,
// which is exactly what keeps the guard honest everywhere else.

const opened: { close(): Promise<void> }[] = [];

afterEach(async () => {
  while (opened.length) {
    await opened.pop()?.close();
  }
});

async function site(body: string): Promise<number> {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain', 'x-path': request.url ?? '' });
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  opened.push({ close: () => new Promise((resolve) => server.close(() => resolve())) });
  return (server.address() as net.AddressInfo).port;
}

async function echo(): Promise<number> {
  const server = net.createServer((socket) => socket.pipe(socket));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  opened.push({ close: () => new Promise((resolve) => server.close(() => resolve())) });
  return (server.address() as net.AddressInfo).port;
}

async function guarded(
  options: Parameters<typeof startAoiHostBrowserEgressGuard>[0] = {},
): Promise<AoiHostBrowserEgressGuard> {
  const guard = await startAoiHostBrowserEgressGuard(options);
  opened.push(guard);
  return guard;
}

// A plain-http request through the proxy, the way a browser sends one.
function viaProxy(guard: AoiHostBrowserEgressGuard, url: string) {
  return new Promise<{ status: number; body: string; path?: string }>((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port: guard.port,
        method: 'GET',
        path: url,
        headers: { host: new URL(url).host },
      },
      (response) => {
        let body = '';
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            body,
            path: response.headers['x-path'] as string | undefined,
          }),
        );
      },
    );
    request.on('error', reject);
    request.end();
  });
}

// A CONNECT through the proxy; resolves with the status line and, once
// tunnelled, what an echo server sends back.
function tunnel(guard: AoiHostBrowserEgressGuard, authority: string) {
  return new Promise<{ status: string; echoed: string }>((resolve, reject) => {
    const socket = net.connect(guard.port, '127.0.0.1', () => {
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    });
    let seen = '';
    socket.on('data', (chunk) => {
      seen += chunk.toString();
      if (seen.includes('\r\n\r\n') && seen.startsWith('HTTP/1.1 200')) {
        const [head, rest] = seen.split('\r\n\r\n');
        if (rest === '') {
          socket.write('ping');
          return;
        }
        socket.end();
        resolve({ status: head.split('\r\n')[0], echoed: rest });
      }
    });
    socket.on('end', () => resolve({ status: seen.split('\r\n')[0], echoed: '' }));
    socket.on('error', reject);
  });
}

describe('the headless reader’s egress guard', () => {
  it('forwards a request to a public site', async () => {
    const port = await site('hello');
    const guard = await guarded({
      lookup: async () => [{ address: '127.0.0.1', family: 4 }],
      treatAsPublicForTest: (host) => host === 'reader.example',
    });
    const reply = await viaProxy(guard, `http://reader.example:${port}/page?x=1`);
    expect(reply).toEqual({ status: 200, body: 'hello', path: '/page?x=1' });
    expect(guard.refusedHosts()).toEqual([]);
  });

  it('refuses a private address, written out or resolved to', async () => {
    const port = await site('secret');
    const guard = await guarded({
      lookup: async (host) =>
        host === 'localtest.me' ? [{ address: '127.0.0.1', family: 4 }] : [],
    });
    for (const url of [
      `http://127.0.0.1:${port}/secret`,
      `http://localhost:${port}/secret`,
      `http://localtest.me:${port}/secret`,
      `http://nowhere.example:${port}/`,
    ]) {
      const reply = await viaProxy(guard, url);
      expect(reply.status, url).toBe(403);
      expect(reply.body, url).not.toContain('secret');
    }
    expect(guard.refusedHosts()).toEqual([
      '127.0.0.1',
      'localhost',
      'localtest.me',
      'nowhere.example',
    ]);
  });

  it('refuses a name with any private address among its public ones', async () => {
    const guard = await guarded({
      lookup: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '10.0.0.5', family: 4 },
      ],
    });
    expect((await viaProxy(guard, 'http://mixed.example/')).status).toBe(403);
  });

  it('tunnels to a public site and refuses to tunnel anywhere private', async () => {
    const port = await echo();
    const guard = await guarded({
      lookup: async () => [{ address: '127.0.0.1', family: 4 }],
      treatAsPublicForTest: (host) => host === 'reader.example',
    });
    await expect(tunnel(guard, `reader.example:${port}`)).resolves.toEqual({
      status: 'HTTP/1.1 200 Connection Established',
      echoed: 'ping',
    });
    for (const authority of [
      `127.0.0.1:${port}`,
      `[::1]:${port}`,
      `internal.example.lan:${port}`,
    ]) {
      const reply = await tunnel(guard, authority);
      expect(reply.status, authority).toBe('HTTP/1.1 403 Forbidden');
    }
    expect((await tunnel(guard, 'not-an-authority')).status).toBe('HTTP/1.1 400 Bad Request');
  });

  it('refuses what it cannot resolve, and a host that is no host', async () => {
    const guard = await guarded({
      lookup: async () => {
        throw new Error('ENOTFOUND');
      },
    });
    expect((await viaProxy(guard, 'http://gone.example/')).status).toBe(403);
    expect((await tunnel(guard, '.:443')).status).toBe('HTTP/1.1 403 Forbidden');
  });

  it('answers 502 when the public site does not answer', async () => {
    const closedPort = await (async () => {
      const server = net.createServer();
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      const { port } = server.address() as net.AddressInfo;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      return port;
    })();
    const guard = await guarded({
      lookup: async () => [{ address: '127.0.0.1', family: 4 }],
      treatAsPublicForTest: () => true,
    });
    expect((await viaProxy(guard, `http://reader.example:${closedPort}/`)).status).toBe(502);
  });

  it('passes on bytes sent with the CONNECT itself', async () => {
    const port = await echo();
    const guard = await guarded({
      lookup: async () => [{ address: '127.0.0.1', family: 4 }],
      treatAsPublicForTest: () => true,
    });
    const echoed = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(guard.port, '127.0.0.1', () => {
        // The request and the first bytes of the tunnel in one write.
        socket.write(`CONNECT reader.example:${port} HTTP/1.1\r\n\r\nhello`);
      });
      let seen = '';
      socket.on('data', (chunk) => {
        seen += chunk.toString();
        if (seen.endsWith('hello')) {
          socket.end();
          resolve(seen.split('\r\n\r\n')[1]);
        }
      });
      socket.on('error', reject);
    });
    expect(echoed).toBe('hello');
  });

  it('answers a request it cannot read with an error, not a fetch', async () => {
    const guard = await guarded();
    const reply = await new Promise<number>((resolve, reject) => {
      const request = http.request(
        { host: '127.0.0.1', port: guard.port, method: 'GET', path: '/relative' },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      request.on('error', reject);
      request.end();
    });
    expect(reply).toBe(400);
    // An absolute URL for anything but http is not proxied either.
    const other = await new Promise<number>((resolve, reject) => {
      const request = http.request(
        { host: '127.0.0.1', port: guard.port, method: 'GET', path: 'ftp://files.example/x' },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      request.on('error', reject);
      request.end();
    });
    expect(other).toBe(400);
  });

  it('closes every connection it holds', async () => {
    const port = await echo();
    const guard = await startAoiHostBrowserEgressGuard({
      lookup: async () => [{ address: '127.0.0.1', family: 4 }],
      treatAsPublicForTest: () => true,
    });
    const socket = net.connect(guard.port, '127.0.0.1');
    await new Promise<void>((resolve) => socket.on('connect', () => resolve()));
    socket.write(`CONNECT reader.example:${port} HTTP/1.1\r\n\r\n`);
    await new Promise<void>((resolve) => socket.once('data', () => resolve()));
    const closed = new Promise<void>((resolve) => socket.on('close', () => resolve()));
    await guard.close();
    await closed;
  });

  it('points the browser at itself, loopback included', () => {
    expect(buildAoiHostBrowserEgressArgs(41_234)).toEqual([
      '--proxy-server=http://127.0.0.1:41234',
      '--proxy-bypass-list=<-loopback>',
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    ]);
  });
});
