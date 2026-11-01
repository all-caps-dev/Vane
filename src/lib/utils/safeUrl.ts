// TypeScript: SSRF guard. Decides whether a URL may be fetched by the scraper (public http/https only).

import dns from 'node:dns';
import net from 'node:net';

// Thrown when a URL is refused by policy (not when DNS simply fails).
export class BlockedUrlError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`Blocked URL: ${reason}`);
    this.name = 'BlockedUrlError';
    this.reason = reason;
  }
}

// Host name suffixes that only exist on private networks (tailnet included).
const BLOCKED_SUFFIXES = ['.local', '.internal', '.ts.net', '.localhost'];

// Parses "a.b.c.d" into four numbers, or null when it is not IPv4.
const parseIPv4 = (ip: string): number[] | null => {
  if (net.isIPv4(ip) === false) return null;
  return ip.split('.').map((p) => parseInt(p, 10));
};

const isPrivateIPv4 = (ip: string): boolean => {
  const o = parseIPv4(ip);
  if (!o) return true; // unreadable: fail closed
  const [a, b] = o;
  return (
    a === 0 || // 0.0.0.0/8 "this network"
    a === 10 || // 10.0.0.0/8
    a === 127 || // 127.0.0.0/8 loopback
    (a === 100 && b >= 64 && b <= 127) || // 100.64.0.0/10 CGNAT (Tailscale)
    (a === 169 && b === 254) || // 169.254.0.0/16 link local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
    (a === 192 && b === 168) // 192.168.0.0/16
  );
};

// Expands an IPv6 address into 8 numbers (16 bits each), or null.
const expandIPv6 = (ip: string): number[] | null => {
  let text = ip;

  // A trailing dotted IPv4 part (::ffff:1.2.3.4) becomes two 16 bit groups.
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (v4) {
    const o = parseIPv4(v4[1]);
    if (!o) return null;
    text =
      text.slice(0, v4.index) +
      ((o[0] << 8) | o[1]).toString(16) +
      ':' +
      ((o[2] << 8) | o[3]).toString(16);
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;

  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;

  const groups = [...head, ...Array(Math.max(missing, 0)).fill('0'), ...tail];
  const numbers = groups.map((g) => parseInt(g, 16));
  return numbers.some((n) => !Number.isFinite(n) || n < 0 || n > 0xffff)
    ? null
    : numbers;
};

const isPrivateIPv6 = (ip: string): boolean => {
  const g = expandIPv6(ip.split('%')[0].toLowerCase()); // drop a zone id
  if (!g) return true; // unreadable: fail closed

  const allZeroBefore = (n: number) => g.slice(0, n).every((x) => x === 0);

  if (allZeroBefore(8)) return true; // :: unspecified
  if (allZeroBefore(7) && g[7] === 1) return true; // ::1 loopback
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link local

  // ::ffff:a.b.c.d is an IPv4 address in IPv6 clothing: judge the IPv4 part.
  if (allZeroBefore(5) && g[5] === 0xffff) {
    const v4 = [g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff].join('.');
    return isPrivateIPv4(v4);
  }

  return false;
};

/*
  True when an IP address is loopback, private, link local, CGNAT or
  otherwise not on the public internet. Anything that is not a readable
  IP address also returns true, so a caller that forgets to check net.isIP
  fails closed.
*/
export const isPrivateAddress = (ip: string): boolean => {
  const clean = ip.trim().replace(/^\[|\]$/g, '');
  if (net.isIPv4(clean)) return isPrivateIPv4(clean);
  if (net.isIPv6(clean.split('%')[0])) return isPrivateIPv6(clean);
  return true;
};

// Lowercased host name without IPv6 brackets or a trailing dot.
const cleanHostname = (hostname: string): string =>
  hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');

/*
  Cheap check with no DNS: localhost, private-only suffixes, and literal
  private IPs. Returns the reason when blocked, otherwise null.
*/
export const blockedHostReason = (hostname: string): string | null => {
  const host = cleanHostname(hostname);
  if (host === '') return 'empty host';
  if (host === 'localhost') return 'localhost';
  for (const suffix of BLOCKED_SUFFIXES) {
    if (host.endsWith(suffix)) return `private suffix ${suffix}`;
  }
  if (net.isIP(host) && isPrivateAddress(host)) return 'private address';
  return null;
};

/*
  Parses the URL and refuses it (BlockedUrlError) unless it is http or https
  and every address its host resolves to is public. Returns the parsed URL.
  DNS errors (unknown host) are thrown as they are, not as BlockedUrlError.
*/
export const assertPublicHttpUrl = async (url: string): Promise<URL> => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new BlockedUrlError('invalid url');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new BlockedUrlError(`scheme ${parsed.protocol}`);
  }

  const reason = blockedHostReason(parsed.hostname);
  if (reason) throw new BlockedUrlError(reason);

  const host = cleanHostname(parsed.hostname);

  // A literal public IP needs no lookup.
  if (net.isIP(host)) return parsed;

  const addresses = await dns.promises.lookup(host, { all: true });
  if (addresses.length === 0) throw new BlockedUrlError('no address');
  if (addresses.some((a) => isPrivateAddress(a.address))) {
    throw new BlockedUrlError('resolves to a private address');
  }

  return parsed;
};
