import { Resolver } from 'node:dns/promises';
import type { DnsResolver } from './domainCheck.js';

/**
 * A resolver over the system's `node:dns` that asks the given servers
 * directly, with a short timeout and two tries, so one slow answer cannot
 * hold a portal request open. Passing the servers (for example the estate's
 * own recursive resolvers) keeps the answer from depending on the host's
 * stub configuration.
 */
export function nodeDnsResolver(servers: readonly string[]): DnsResolver {
  const resolver = new Resolver({ timeout: 3000, tries: 2 });
  resolver.setServers([...servers]);
  return {
    resolveTxt: (name) => resolver.resolveTxt(name),
    resolve4: (name) => resolver.resolve4(name),
    resolve6: (name) => resolver.resolve6(name),
    resolveCname: (name) => resolver.resolveCname(name),
  };
}
