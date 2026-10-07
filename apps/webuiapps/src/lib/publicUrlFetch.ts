// Fetch a URL only if every hop is a public http(s) host.
//
// The browser-reader proxy fetched whatever URL it was given with
// redirect:'follow' and no host check, so the agent's read_url tool (and any page
// that could reach the proxy) could read loopback services, LAN admin pages or a
// cloud metadata endpoint -- directly, or through a public URL that redirects
// there. Redirects are followed by hand here so each hop is checked before it is
// requested.
//
// Residual: the check resolves DNS and fetch resolves it again, so a name with a
// zero TTL can still rebind between the two. Pinning the connection to the
// checked address needs a custom dispatcher; this closes the literal-address and
// redirect paths.
import { lookup as dnsLookup } from 'dns/promises';
import { isAoiPrivateOrLocalHostname } from './aoiHostUrlSafety';

export type PublicUrlRejection =
  | 'unsupported_scheme'
  | 'credentials_in_url'
  | 'private_host'
  | 'private_address'
  | 'unresolvable_host'
  | 'too_many_redirects';

export class PublicUrlRejectedError extends Error {
  readonly reason: PublicUrlRejection;
  readonly url: string;

  constructor(reason: PublicUrlRejection, url: string) {
    super(`Refused to fetch ${url}: ${reason}`);
    this.name = 'PublicUrlRejectedError';
    this.reason = reason;
    this.url = url;
  }
}

export type PublicUrlLookup = (hostname: string) => Promise<readonly { address: string }[]>;

export interface FetchPublicUrlOptions {
  init?: RequestInit;
  maxRedirects?: number;
  lookup?: PublicUrlLookup;
  fetchImpl?: typeof fetch;
}

const defaultLookup: PublicUrlLookup = (hostname) => dnsLookup(hostname, { all: true });

export async function assertPublicHttpUrl(
  url: URL,
  lookup: PublicUrlLookup = defaultLookup,
): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new PublicUrlRejectedError('unsupported_scheme', url.toString());
  }
  if (url.username || url.password) {
    throw new PublicUrlRejectedError('credentials_in_url', url.toString());
  }
  if (isAoiPrivateOrLocalHostname(url.hostname)) {
    throw new PublicUrlRejectedError('private_host', url.toString());
  }
  let addresses: readonly { address: string }[];
  try {
    addresses = await lookup(url.hostname.replace(/^\[(.*)\]$/, '$1'));
  } catch {
    throw new PublicUrlRejectedError('unresolvable_host', url.toString());
  }
  if (addresses.length === 0) {
    throw new PublicUrlRejectedError('unresolvable_host', url.toString());
  }
  if (addresses.some((entry) => isAoiPrivateOrLocalHostname(entry.address))) {
    throw new PublicUrlRejectedError('private_address', url.toString());
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * fetch() restricted to public hosts on every hop. Returns the final response
 * and the URL it came from.
 */
export async function fetchPublicUrl(
  target: URL,
  options: FetchPublicUrlOptions = {},
): Promise<{ response: Response; finalUrl: string }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxRedirects = options.maxRedirects ?? 5;
  let current = target;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    await assertPublicHttpUrl(current, options.lookup);
    const response = await fetchImpl(current.toString(), {
      ...options.init,
      redirect: 'manual',
    });
    const location = response.headers.get('location');
    if (REDIRECT_STATUSES.has(response.status) && location) {
      current = new URL(location, current);
      continue;
    }
    return { response, finalUrl: current.toString() };
  }
  throw new PublicUrlRejectedError('too_many_redirects', target.toString());
}
