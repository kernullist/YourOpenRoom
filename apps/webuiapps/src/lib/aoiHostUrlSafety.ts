// Pure host/URL safety helpers shared by headless host-browser-read and
// browser-drive denylist matching. No Node APIs — safe for any bundle that
// only needs the hostname policy.

// Private / loopback / link-local / metadata / CGNAT IPv4 ranges, keyed on the
// first two octets. Shared by the dotted-IPv4 and IPv4-mapped-IPv6 branches so
// the two spellings can never diverge in what they treat as private.
function isPrivateIpv4Octets(a: number, b: number): boolean {
  if (a === 10 || a === 127 || a === 0) {
    return true;
  }
  if (a === 169 && b === 254) {
    return true; // link-local / cloud metadata
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  }
  if (a === 192 && b === 168) {
    return true;
  }
  if (a === 100 && b >= 64 && b <= 127) {
    return true; // CGNAT
  }
  return false;
}

// Decode the embedded IPv4 first two octets from an IPv4-mapped IPv6 host.
// The WHATWG URL parser compresses a mapped literal to HEX (127.0.0.1 becomes
// "::ffff:7f00:1", 192.168.1.1 becomes "::ffff:c0a8:101"), so a dotted
// "::ffff:127." prefix check is dead code and the compressed form escapes it.
// IPv6 forms that carry an IPv4 address: IPv4-mapped (::ffff:a.b.c.d), the
// deprecated IPv4-compatible form (::a.b.c.d), and the NAT64 well-known prefix
// (64:ff9b::a.b.c.d). The WHATWG URL parser rewrites the dotted tail to hex
// (::ffff:7f00:1), so both spellings are handled.
function mappedIpv4Octets(host: string): { a: number; b: number } | null {
  const mapped = host.match(/^(?:::ffff:|::|64:ff9b::)(.+)$/i);
  if (!mapped) {
    return null;
  }
  const rest = mapped[1];
  const dotted = rest.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (dotted) {
    return { a: Number.parseInt(dotted[1], 10), b: Number.parseInt(dotted[2], 10) };
  }
  const hex = rest.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (hex) {
    const group1 = Number.parseInt(hex[1], 16);
    return { a: (group1 >> 8) & 0xff, b: group1 & 0xff };
  }
  return null;
}

/**
 * The IPv4 address carried inside an IPv4-mapped (::ffff:), IPv4-compatible (::)
 * or NAT64 (64:ff9b::) IPv6 address, in dotted form -- or null when there is none.
 * Accepts both the dotted tail and the hex tail the URL parser rewrites it to
 * ("::ffff:7f00:1"), which is the form a check written for "::ffff:a.b.c.d" misses.
 */
export function extractEmbeddedIpv4(ipv6: string): string | null {
  const host = ipv6
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, '$1');
  const match = host.match(/^(?:::ffff:|::|64:ff9b::)(.+)$/);
  if (!match) {
    return null;
  }
  const tail = match[1];
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(tail)) {
    return tail;
  }
  const hex = tail.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!hex) {
    return null;
  }
  const high = Number.parseInt(hex[1], 16);
  const low = Number.parseInt(hex[2], 16);
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}

// An IPv6 address as its eight 16-bit groups, `::` expanded and a dotted IPv4
// tail folded into the last two -- or null when it is not one.
function ipv6Groups(host: string): number[] | null {
  let text = host;
  const dotted = text.match(/^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (dotted) {
    const octets = dotted.slice(2).map((part) => Number.parseInt(part, 10));
    if (octets.some((octet) => octet > 255)) {
      return null;
    }
    text =
      `${dotted[1]}${((octets[0] << 8) | octets[1]).toString(16)}:` +
      `${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) {
    return null;
  }
  const groupsOf = (part: string) => (part === '' ? [] : part.split(':'));
  const head = groupsOf(halves[0]);
  const tail = halves.length === 2 ? groupsOf(halves[1]) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) {
    return null;
  }
  const all = [...head, ...new Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  if (all.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) {
    return null;
  }
  return all.map((group) => Number.parseInt(group, 16));
}

// Where an IPv6 address carries or tunnels to an IPv4 one, whether that one is
// private: the IPv4-translated SIIT form (::ffff:0:a.b.c.d), the NAT64 local-use
// prefix (64:ff9b:1::/48, private by definition), 6to4 (2002:AABB:CCDD::, the
// IPv4 in the second and third groups) and Teredo (2001:0::/32, a tunnel whose
// far end is not this address at all).
function tunnelsToPrivateIpv4(groups: number[]): boolean {
  const zero = (from: number, to: number) => groups.slice(from, to).every((group) => group === 0);
  const octetsAt = (index: number) => [groups[index] >> 8, groups[index] & 0xff];
  if (zero(0, 4) && groups[4] === 0xffff && groups[5] === 0) {
    const [a, b] = octetsAt(6);
    return isPrivateIpv4Octets(a, b);
  }
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups[2] === 1) {
    return true;
  }
  if (groups[0] === 0x2002) {
    const [a, b] = octetsAt(1);
    return isPrivateIpv4Octets(a, b);
  }
  return groups[0] === 0x2001 && groups[1] === 0;
}

// Names that only resolve inside a private network: suffixes reserved or never
// delegated for that use (.local is mDNS, .internal was set aside by ICANN in
// 2024 and also holds cloud metadata names like metadata.google.internal,
// .home.arpa is RFC 8375; .lan, .corp, .home and .intranet are not in the
// public root). .test is RFC 6761's name for testing, and local development
// setups (Valet, dnsmasq) point it at this machine; .mshome.net is the name
// Windows Internet Connection Sharing hands out on its private subnet.
const PRIVATE_NAME_SUFFIXES = [
  '.local',
  '.internal',
  '.home.arpa',
  '.localdomain',
  '.lan',
  '.intranet',
  '.corp',
  '.home',
  '.test',
  '.mshome.net',
];

// The browser resolves a name itself, after this check, so an intranet host is
// only stopped here by its NAME. A single label ("intranet", "nas") is looked up
// on the local network and never on the public internet.
function isPrivateNetworkName(host: string): boolean {
  if (!host.includes('.') && !host.includes(':')) {
    return true;
  }
  return PRIVATE_NAME_SUFFIXES.some((suffix) => host.endsWith(suffix) || host === suffix.slice(1));
}

/**
 * True for loopback / private / link-local / metadata / CGNAT hosts that must
 * never be opened by host-browser or browser-drive navigations (SSRF surface).
 */
export function isAoiPrivateOrLocalHostname(hostname: string): boolean {
  // URL.hostname keeps the brackets on IPv6 ("[::ffff:7f00:1]"). Strip them here
  // rather than trusting every caller to, or the prefix checks below never match.
  const host = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, '$1')
    .replace(/\.$/, '');
  if (!host) {
    return true;
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0') {
    return true;
  }
  if (isPrivateNetworkName(host)) {
    return true;
  }
  if (host === '::1' || host === '[::1]') {
    return true;
  }
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const parts = ipv4.slice(1).map((part) => Number.parseInt(part, 10));
    if (parts.some((part) => !Number.isFinite(part) || part < 0 || part > 255)) {
      return true;
    }
    if (isPrivateIpv4Octets(parts[0], parts[1])) {
      return true;
    }
  }
  if (host.includes(':')) {
    const mapped = mappedIpv4Octets(host);
    if (mapped && isPrivateIpv4Octets(mapped.a, mapped.b)) {
      return true;
    }
    const groups = ipv6Groups(host);
    if (groups && tunnelsToPrivateIpv4(groups)) {
      return true;
    }
    // fc00::/7 unique local, fe80::/10 link-local (fe80 to febf, not just
    // fe80) and the retired fec0::/10 site-local block, which some networks
    // still route.
    if (/^f[cd]/.test(host) || /^fe[89a-f]/.test(host) || host === '::') {
      return true;
    }
  }
  return false;
}
