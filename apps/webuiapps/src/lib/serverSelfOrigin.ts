import type { IncomingMessage } from 'http';
import type { TLSSocket } from 'tls';

const FALLBACK_ORIGIN = 'http://127.0.0.1:3000';

/**
 * The origin this server can call itself on, read from the socket that accepted
 * the request.
 *
 * Plugins used to build it from the Host and X-Forwarded-Proto headers, which the
 * client chooses: a request with `Host: <any IP>` pointed the server-side model
 * call (prompt and fetched sources included) at that host, and whatever it
 * answered came back as the model's output. The socket's local address is one the
 * server is listening on, so a self-call always reaches this server.
 */
export function serverSelfOrigin(req: IncomingMessage): string {
  const socket = req.socket as TLSSocket | undefined;
  const port = socket?.localPort;
  const localAddress = socket?.localAddress;
  if (!port || !localAddress) {
    return FALLBACK_ORIGIN;
  }
  const mappedIpv4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(localAddress);
  const address = mappedIpv4 ? mappedIpv4[1] : localAddress;
  const host = address.includes(':') ? `[${address}]` : address;
  return `${socket.encrypted ? 'https' : 'http'}://${host}:${port}`;
}
