import { BlockList, isIP } from 'node:net';

/**
 * Who is asking, for the purpose of the attempt ceiling.
 *
 * The socket peer is the only fact about a request nobody on the far side
 * can choose. X-Forwarded-For is read only when that peer is a configured
 * trusted proxy -- the edge -- and then only its rightmost entry, which is
 * the address the edge itself saw; anything to its left was written by the
 * client. A trusted peer that sends no usable header yields no source at
 * all, and the caller refuses rather than falling back to the proxy's own
 * address, which would pool every visitor into one bucket.
 */
export interface SourceResolver {
  resolve(peer: string | undefined, forwardedFor: string | string[] | undefined): string | null;
}

export class TrustedProxyFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TrustedProxyFormatError';
  }
}

function unmapIpv4(address: string): string {
  const lower = address.toLowerCase();
  return lower.startsWith('::ffff:') && isIP(lower.slice(7)) === 4 ? lower.slice(7) : lower;
}

function expandIpv6(address: string): number[] {
  const [head = '', tail] = address.split('::') as [string, string | undefined];
  const parse = (part: string): number[] =>
    part === '' ? [] : part.split(':').map((group) => parseInt(group, 16));
  const left = parse(head);
  const right = tail === undefined ? [] : parse(tail);
  const zeros: number[] = new Array(8 - left.length - right.length).fill(0);
  return [...left, ...zeros, ...right];
}

/**
 * The ceiling's key for one address. An IPv6 host is routinely handed a
 * whole /64, so keying on the full address would give it 2^64 buckets; the
 * key is the /64 instead. An IPv4-mapped IPv6 address is the IPv4 address.
 * Returns null for anything that is not an IP literal.
 */
export function ceilingKey(address: string): string | null {
  const unmapped = unmapIpv4(address.trim());
  const family = isIP(unmapped);
  if (family === 4) return unmapped;
  if (family !== 6 || unmapped.includes('.') || unmapped.includes('%')) return null;
  const groups = expandIpv6(unmapped).slice(0, 4);
  return `${groups.map((group) => group.toString(16)).join(':')}::/64`;
}

export function parseTrustedProxies(spec: string): BlockList {
  const list = new BlockList();
  for (const raw of spec.split(',')) {
    const entry = raw.trim();
    if (entry === '') continue;
    const [address = '', prefixRaw, ...rest] = entry.split('/');
    const family = isIP(address);
    if (family === 0 || rest.length > 0) {
      throw new TrustedProxyFormatError(`trusted proxy "${entry}" is not an address or CIDR.`);
    }
    const type = family === 4 ? 'ipv4' : 'ipv6';
    if (prefixRaw === undefined) {
      list.addAddress(address, type);
      continue;
    }
    const prefix = Number(prefixRaw);
    const max = family === 4 ? 32 : 128;
    if (!/^[0-9]{1,3}$/.test(prefixRaw) || prefix > max) {
      throw new TrustedProxyFormatError(`trusted proxy "${entry}" has an invalid prefix.`);
    }
    list.addSubnet(address, prefix, type);
  }
  return list;
}

function isTrusted(list: BlockList, address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  return list.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

export function createSourceResolver(trusted: BlockList): SourceResolver {
  return {
    resolve(peer, forwardedFor) {
      if (!peer) return null;
      const peerAddress = unmapIpv4(peer);
      if (!isTrusted(trusted, peerAddress)) return ceilingKey(peerAddress);
      const header = Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor;
      if (!header) return null;
      const rightmost = header.split(',').pop();
      return rightmost === undefined ? null : ceilingKey(rightmost);
    },
  };
}
