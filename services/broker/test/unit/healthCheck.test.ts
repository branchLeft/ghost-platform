import { afterEach, describe, expect, it } from 'vitest';
import { createHttpHealthChecker } from '../../src/healthCheck.js';
import { startFakeSidecar, type FakeSidecar } from '../helpers/fakeSidecar.js';

describe('createHttpHealthChecker', () => {
  let sidecar: FakeSidecar | undefined;

  afterEach(async () => {
    await sidecar?.close();
    sidecar = undefined;
  });

  it('reports healthy when the sidecar answers 200', async () => {
    sidecar = await startFakeSidecar();
    const checker = createHttpHealthChecker('127.0.0.1', 2000);
    expect(await checker.isHealthy(sidecar.port)).toBe(true);
  });

  it('reports unhealthy when the sidecar answers 503 (drained or Ghost not ready)', async () => {
    sidecar = await startFakeSidecar();
    sidecar.setHealthy(false);
    const checker = createHttpHealthChecker('127.0.0.1', 2000);
    expect(await checker.isHealthy(sidecar.port)).toBe(false);
  });

  it('reports unhealthy, not a throw, when nothing is listening on the port', async () => {
    const checker = createHttpHealthChecker('127.0.0.1', 500);
    // Port 1 is privileged and essentially never has a userland listener.
    expect(await checker.isHealthy(1)).toBe(false);
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
      expect(await checker.isHealthy(port)).toBe(false);
      expect(Date.now() - start).toBeLessThan(2000);
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
