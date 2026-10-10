// The headless reader's only way out: every connection it makes goes through here.
//
// host_browser_read hands Chrome a URL whose host was checked by NAME, and Chrome
// does the rest itself -- follows redirects, runs the page's script, resolves
// every name. A public page that redirected to 127.0.0.1, or a public name that
// resolves to a private address (localtest.me, 192.168.1.1.nip.io), was read
// like any other: the check never saw an address. So Chrome is pointed at this
// proxy on loopback, which resolves each host itself, refuses private and local
// addresses, and connects to exactly the address it checked -- there is no
// second lookup for a name to rebind between.
//
// Server-only (Node): it listens on a socket.
import * as http from 'http';
import * as net from 'net';
import { lookup as dnsLookup } from 'dns/promises';
import { isAoiPrivateOrLocalHostname } from './aoiHostUrlSafety';

export type AoiEgressLookup = (
  hostname: string,
) => Promise<readonly { address: string; family: number }[]>;

export interface AoiHostBrowserEgressGuardOptions {
  lookup?: AoiEgressLookup;
  // Tests only: names to treat as public whatever they resolve to, so a server
  // on loopback can stand in for a public site. Never set in production.
  treatAsPublicForTest?: (hostname: string) => boolean;
}

export interface AoiHostBrowserEgressGuard {
  port: number;
  // Hosts a request was refused for, for the result to mention.
  refusedHosts(): string[];
  close(): Promise<void>;
}

const defaultLookup: AoiEgressLookup = (hostname) => dnsLookup(hostname, { all: true });
const MAX_REFUSED_KEPT = 20;

// The address to connect to for `host`, or null when it is private, local or
// does not resolve. Every address a name resolves to has to be public: a name
// with one private address among public ones is how a lookup is steered.
async function publicAddress(
  host: string,
  lookup: AoiEgressLookup,
  treatAsPublic: ((hostname: string) => boolean) | undefined,
): Promise<{ address: string; family: number } | null> {
  const bare = host
    .replace(/^\[(.*)\]$/, '$1')
    .replace(/\.$/, '')
    .toLowerCase();
  if (!bare) {
    return null;
  }
  const exempt = treatAsPublic?.(bare) === true;
  const literal = net.isIP(bare);
  if (literal) {
    return !exempt && isAoiPrivateOrLocalHostname(bare) ? null : { address: bare, family: literal };
  }
  if (!exempt && isAoiPrivateOrLocalHostname(bare)) {
    return null;
  }
  let addresses: readonly { address: string; family: number }[];
  try {
    addresses = await lookup(bare);
  } catch {
    return null;
  }
  if (addresses.length === 0) {
    return null;
  }
  if (!exempt && addresses.some((entry) => isAoiPrivateOrLocalHostname(entry.address))) {
    return null;
  }
  return addresses[0];
}

// "host:port" or "[v6]:port", as a CONNECT request names its target.
function splitAuthority(authority: string): { host: string; port: number } | null {
  const match = authority.match(/^(\[[^\]]+\]|[^:[\]]+):(\d{1,5})$/);
  if (!match) {
    return null;
  }
  const port = Number(match[2]);
  return port > 0 && port < 65_536 ? { host: match[1], port } : null;
}

// Headers about the hop to this proxy, not about the request.
const HOP_HEADERS = ['proxy-connection', 'proxy-authorization', 'connection', 'keep-alive'];

export async function startAoiHostBrowserEgressGuard(
  options: AoiHostBrowserEgressGuardOptions = {},
): Promise<AoiHostBrowserEgressGuard> {
  const lookup = options.lookup ?? defaultLookup;
  const treatAsPublic = options.treatAsPublicForTest;
  const refused: string[] = [];
  const sockets = new Set<net.Socket>();
  const track = (socket: net.Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  };
  const refuse = (host: string) => {
    if (refused.length < MAX_REFUSED_KEPT && !refused.includes(host)) {
      refused.push(host);
    }
  };

  // Plain http: the request line carries the absolute URL.
  const server = http.createServer((request, response) => {
    void (async () => {
      let target: URL;
      try {
        target = new URL(request.url ?? '');
      } catch {
        response.writeHead(400).end();
        return;
      }
      if (target.protocol !== 'http:') {
        response.writeHead(400).end();
        return;
      }
      const address = await publicAddress(target.hostname, lookup, treatAsPublic);
      if (!address) {
        refuse(target.hostname);
        response
          .writeHead(403, { 'content-type': 'text/plain' })
          .end('refused: a private or local address');
        return;
      }
      const headers = { ...request.headers };
      for (const name of HOP_HEADERS) {
        delete headers[name];
      }
      const upstream = http.request(
        {
          host: address.address,
          family: address.family,
          port: Number(target.port) || 80,
          method: request.method,
          path: `${target.pathname}${target.search}`,
          headers,
        },
        (reply) => {
          response.writeHead(reply.statusCode ?? 502, reply.headers);
          reply.pipe(response);
        },
      );
      upstream.on('error', () => {
        if (!response.headersSent) {
          response.writeHead(502);
        }
        response.end();
      });
      request.pipe(upstream);
    })();
  });
  server.on('connection', track);
  server.on('clientError', (_error, socket) => socket.destroy());

  // https, and anything else tunnelled: CONNECT host:port.
  server.on('connect', (request: http.IncomingMessage, client: net.Socket, head: Buffer) => {
    client.on('error', () => undefined);
    void (async () => {
      const authority = splitAuthority(request.url ?? '');
      if (!authority) {
        client.end('HTTP/1.1 400 Bad Request\r\n\r\n');
        return;
      }
      const address = await publicAddress(authority.host, lookup, treatAsPublic);
      if (!address) {
        refuse(authority.host.replace(/^\[(.*)\]$/, '$1'));
        client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
        return;
      }
      const upstream = net.connect({
        host: address.address,
        port: authority.port,
        family: address.family,
      });
      track(upstream);
      upstream.on('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length > 0) {
          upstream.write(head);
        }
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.on('error', () => client.destroy());
      client.on('close', () => upstream.destroy());
    })();
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    refusedHosts: () => [...refused],
    close: () =>
      new Promise<void>((resolveClose) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        server.close(() => resolveClose());
      }),
  };
}

// The flags that send every connection the headless browser makes through the
// guard. `<-loopback>` takes away Chrome's own exemption for loopback, which
// would otherwise reach 127.0.0.1 directly; WebRTC is kept off UDP that does
// not go through the proxy.
export function buildAoiHostBrowserEgressArgs(port: number): string[] {
  return [
    `--proxy-server=http://127.0.0.1:${port}`,
    '--proxy-bypass-list=<-loopback>',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
  ];
}
