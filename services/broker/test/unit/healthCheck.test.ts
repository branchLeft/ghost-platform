import { afterEach, describe, expect, it } from 'vitest';
import type { EmailAddress, SlotName } from '@branchleft/ghost-platform-render-core';
import { createHttpHealthChecker } from '../../src/healthCheck.js';
import { slotPort } from '../../src/slotPorts.js';
import {
  startFakeSidecar,
  startFakeSidecarOnSocket,
  startRealHealthRouter,
  type FakeSidecar,
  type RealHealthRouter,
  type SocketSidecar,
} from '../helpers/fakeSidecar.js';
import { startTestBroker, type TestBroker } from '../helpers/testBroker.js';
import { demoDescriptor } from '../helpers/fixtures.js';

// Any app port: the fake sidecar below answers every check alike.
const APP_PORT = 9300;

describe('createHttpHealthChecker', () => {
  let sidecar: FakeSidecar | undefined;

  afterEach(async () => {
    await sidecar?.close();
    sidecar = undefined;
  });

  it('reports healthy when the sidecar answers 200', async () => {
    sidecar = await startFakeSidecar();
    const checker = createHttpHealthChecker('127.0.0.1', 2000);
    expect(await checker.isHealthy(sidecar.port, APP_PORT)).toBe(true);
  });

  it('reports unhealthy when the sidecar answers 503 (drained or Ghost not ready)', async () => {
    sidecar = await startFakeSidecar();
    sidecar.setHealthy(false);
    const checker = createHttpHealthChecker('127.0.0.1', 2000);
    expect(await checker.isHealthy(sidecar.port, APP_PORT)).toBe(false);
  });

  it('reports unhealthy, not a throw, when nothing is listening on the port', async () => {
    const checker = createHttpHealthChecker('127.0.0.1', 500);
    // Port 1 is privileged and essentially never has a userland listener.
    expect(await checker.isHealthy(1, APP_PORT)).toBe(false);
  });

  it('reports unhealthy on a timeout rather than hanging', async () => {
    const { createServer } = await import('node:http');
    const server = createServer(() => {
      /* never responds */
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const checker = createHttpHealthChecker('127.0.0.1', 100);
      const start = Date.now();
      expect(await checker.isHealthy(port, APP_PORT)).toBe(false);
      expect(Date.now() - start).toBeLessThan(2000);
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

/**
 * The real `demo-host/provision/health_router.py` (a child process) in front
 * of one stand-in sidecar per colour on unix sockets. Only the sidecars are
 * doubles; the router, the header it demands and its 503s are the shipped
 * ones, so `fakeSidecar`'s "answers any check" blindness cannot hide a
 * missing or wrong colour here.
 */
describe('against the real health router', () => {
  // Slot 3's two colours listen on 9306 (a) and 9307 (b).
  const SLOT = '3' as SlotName;
  const APP_A = slotPort(9300, SLOT, 'a');
  const APP_B = slotPort(9300, SLOT, 'b');
  let router: RealHealthRouter | undefined;
  const sidecars: SocketSidecar[] = [];

  afterEach(async () => {
    await Promise.all(sidecars.splice(0).map((s) => s.close()));
    await router?.close();
    router = undefined;
  });

  async function startRouter(
    colours: readonly ('a' | 'b')[]
  ): Promise<Record<string, SocketSidecar>> {
    router = await startRealHealthRouter(SLOT);
    const started: Record<string, SocketSidecar> = {};
    for (const colour of colours) {
      const sidecar = await startFakeSidecarOnSocket(router.colourSocketPath(colour));
      sidecars.push(sidecar);
      started[colour] = sidecar;
    }
    return started;
  }

  it('control case: a check with no colour header is refused 503, even with a healthy sidecar', async () => {
    await startRouter(['a', 'b']);
    const response = await fetch(`http://127.0.0.1:${router!.port}/healthz`);
    expect(response.status).toBe(503);
  });

  it('control case: a header that is not one of the slot own two upstreams is refused 503', async () => {
    await startRouter(['a', 'b']);
    // Slot 4's colour a: a real colour of another slot, never this one's.
    const elsewhere = await fetch(`http://127.0.0.1:${router!.port}/healthz`, {
      headers: { 'X-Colour-Upstream': '127.0.0.1:9308' },
    });
    expect(elsewhere.status).toBe(503);
  });

  it('reads healthy for the colour asked about when that colour answers 200', async () => {
    await startRouter(['a', 'b']);
    const checker = createHttpHealthChecker('127.0.0.1', 2000);
    expect(await checker.isHealthy(router!.port, APP_A)).toBe(true);
    expect(await checker.isHealthy(router!.port, APP_B)).toBe(true);
  });

  it('answers for the colour named, never the other one', async () => {
    const sidecars = await startRouter(['a', 'b']);
    sidecars.a!.setHealthy(false);
    const checker = createHttpHealthChecker('127.0.0.1', 2000);
    expect(await checker.isHealthy(router!.port, APP_A)).toBe(false);
    expect(await checker.isHealthy(router!.port, APP_B)).toBe(true);
  });

  it('reads unhealthy for a colour with no sidecar even when the other colour is healthy', async () => {
    await startRouter(['a']);
    const checker = createHttpHealthChecker('127.0.0.1', 2000);
    expect(await checker.isHealthy(router!.port, APP_A)).toBe(true);
    expect(await checker.isHealthy(router!.port, APP_B)).toBe(false);
  });
});

describe('/status healthy against the real health router', () => {
  let broker: TestBroker | undefined;
  let router: RealHealthRouter | undefined;
  const sidecars: SocketSidecar[] = [];

  afterEach(async () => {
    await broker?.close();
    await Promise.all(sidecars.splice(0).map((s) => s.close()));
    await router?.close();
    broker = undefined;
    router = undefined;
  });

  async function statusHealthy(): Promise<unknown> {
    const res = await fetch(`${broker!.baseUrl}/status/0`);
    return ((await res.json()) as { healthy: unknown }).healthy;
  }

  it('reads true only for the live colour: a reconcile lands on a, the swap moves live to b', async () => {
    router = await startRealHealthRouter('0');
    const a = await startFakeSidecarOnSocket(router.colourSocketPath('a'));
    const b = await startFakeSidecarOnSocket(router.colourSocketPath('b'));
    sidecars.push(a, b);
    // The descriptor pins slot 0's health port to 10100, so the router (on an
    // OS-chosen port) is reached by redirecting only the port; the colour the
    // broker names is the production path.
    const routerPort = router.port;
    const real = createHttpHealthChecker('127.0.0.1', 2000);
    broker = await startTestBroker({
      wrapDeps: (deps) => ({
        ...deps,
        healthChecker: {
          isHealthy: (_port, colourAppPort) => real.isHealthy(routerPort, colourAppPort),
        },
      }),
    });

    // Nothing reconciled yet: no live colour, so no health claim.
    expect(await statusHealthy()).toBe(false);

    const built = await broker.signedFetch('POST', '/reconcile', {
      slot: '0',
      descriptor: demoDescriptor({}),
    });
    expect(await built.json()).toMatchObject({ phase: 'running', colour: 'a' });
    b.setHealthy(false);
    expect(await statusHealthy()).toBe(true);

    // Colour a goes unhealthy while b is fine: live is a, so healthy is false.
    a.setHealthy(false);
    b.setHealthy(true);
    expect(await statusHealthy()).toBe(false);

    a.setHealthy(true);
    b.setHealthy(false);
    const swapped = await broker.signedFetch('POST', '/reconcile', {
      slot: '0',
      descriptor: demoDescriptor({ ownerEmail: 'second@example.com' as EmailAddress }),
    });
    expect(await swapped.json()).toMatchObject({ phase: 'running', colour: 'b' });
    // Live is now b, and b is the unhealthy one: a's 200 must not be borrowed.
    expect(await statusHealthy()).toBe(false);
    b.setHealthy(true);
    expect(await statusHealthy()).toBe(true);
  });
});
