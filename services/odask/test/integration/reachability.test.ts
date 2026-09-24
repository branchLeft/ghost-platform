import { connect, type Socket } from 'node:net';
import { networkInterfaces } from 'node:os';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { DescriptorStore } from '../../src/descriptorStore.js';
import { TokenBucket } from '../../src/rateLimiter.js';

/**
 * The load-bearing control (LLD-5 E2): "Caddy sends no credential and
 * offers no way to add one. The ask endpoint is therefore only as safe as
 * its network position." Every other guard in this service is provable by
 * pure logic; this one is a claim about a real socket, so it is proven
 * against a real socket rather than a mock -- a stubbed `net` module could
 * be made to agree with either implementation.
 *
 * A non-loopback IPv4 address is what a multi-homed edge host has beyond
 * its private interface: something with a route to it that is not the
 * interface odask is supposed to be reachable on. `127.0.0.2` was tried
 * first and rejected -- unlike Linux, macOS does not route the rest of
 * 127.0.0.0/8 to loopback without an explicit interface alias, so a
 * connection to it hangs (ETIMEDOUT) rather than proving anything. The
 * machine's real, already-configured interface has no such platform gap.
 */
const otherInterfaceAddress = (): string | undefined => {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) {
        return addr.address;
      }
    }
  }
  return undefined;
};

const OTHER_ADDRESS = otherInterfaceAddress();

async function listenOn(host: string): Promise<{ port: number; close: () => Promise<void> }> {
  const store = new DescriptorStore({ descriptorDir: '/nonexistent', baseDomain: 'example' });
  const app = createApp(store, new TokenBucket(50, 10));
  const server = app.listen(0, host);
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const { port } = server.address() as AddressInfo;
  return {
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A bounded connect attempt: resolves 'connected' or the refusal reason, never hangs the suite. */
function tryConnect(host: string, port: number): Promise<'connected' | 'refused' | 'timeout'> {
  return new Promise((resolve) => {
    const socket: Socket = connect({ host, port, timeout: 1500 });
    socket.once('connect', () => {
      socket.destroy();
      resolve('connected');
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve('timeout');
    });
    socket.once('error', () => {
      resolve('refused');
    });
  });
}

let close: (() => Promise<void>) | undefined;

afterEach(async () => {
  await close?.();
  close = undefined;
});

describe.skipIf(OTHER_ADDRESS === undefined)(
  'network reachability (LLD-5 E2: "only as safe as its network position")',
  () => {
    it('is not reachable on any interface but the one it was bound to', async () => {
      const server = await listenOn('127.0.0.1');
      close = server.close;

      // The control case: the server *is* reachable on the interface it was
      // actually bound to. Without this, a refusal on OTHER_ADDRESS below
      // would be indistinguishable from the server never having started.
      expect(await tryConnect('127.0.0.1', server.port)).toBe('connected');

      // The load-bearing assertion: nothing but that one interface can reach
      // it, including the host's other real, already-up interface.
      expect(await tryConnect(OTHER_ADDRESS!, server.port)).toBe('refused');
    });

    // The control case this "all clear" needs: proof that OTHER_ADDRESS is a
    // real, reachable interface, and the refusal above is the bind host's
    // doing rather than a network fluke (a dead route would refuse every
    // host equally). This is also, precisely, the shape of the sabotage run
    // against config.ts's required BIND_HOST and recorded verbatim in the PR
    // body: bind here is literal '0.0.0.0' instead of a configured value,
    // and the connection that was refused above now succeeds.
    it('control case: 0.0.0.0 is reachable on every interface, including OTHER_ADDRESS', async () => {
      const server = await listenOn('0.0.0.0');
      close = server.close;
      expect(await tryConnect(OTHER_ADDRESS!, server.port)).toBe('connected');
    });
  }
);
