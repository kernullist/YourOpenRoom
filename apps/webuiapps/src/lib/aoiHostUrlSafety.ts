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
function mappedIpv4Octets(host: string): { a: number; b: number } | null {
  const mapped = host.match(/^::ffff:(.+)$/i);
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
 * True for loopback / private / link-local / metadata / CGNAT hosts that must
 * never be opened by host-browser or browser-drive navigations (SSRF surface).
 */
export function isAoiPrivateOrLocalHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, '');
  if (!host) {
    return true;
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0') {
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
    if (
      host.startsWith('fc') ||
      host.startsWith('fd') ||
      host.startsWith('fe80') ||
      host === '::'
    ) {
      return true;
    }
  }
  return false;
}
