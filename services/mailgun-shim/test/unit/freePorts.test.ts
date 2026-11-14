import { createServer, type Server } from 'node:net';
import { describe, expect, it } from 'vitest';
import { freePorts, isAddressInUse, withFreePorts } from '../helpers/freePorts.js';

function listenOn(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function inUse(): Error {
  return new Error(
    'server exited early (code 1). stderr:\nError: listen EADDRINUSE: address already in use 127.0.0.1:1'
  );
}

describe('freePorts', () => {
  it('returns distinct ports, every one free to bind once it returns', async () => {
    const ports = await freePorts(8);
    expect(new Set(ports).size).toBe(8);
    for (const port of ports) {
      expect(port).toBeGreaterThan(0);
      await close(await listenOn(port));
    }
  });
});

describe('isAddressInUse', () => {
  it('recognises the error code and a failure message that quotes it', () => {
    expect(isAddressInUse(Object.assign(new Error('x'), { code: 'EADDRINUSE' }))).toBe(true);
    expect(isAddressInUse(inUse())).toBe(true);
  });

  it('does not recognise other failures', () => {
    expect(isAddressInUse(new Error('server never logged "listening"'))).toBe(false);
    expect(isAddressInUse('EADDRINUSE')).toBe(false);
  });
});

describe('withFreePorts', () => {
  it('returns the result of the first attempt when nothing collides', async () => {
    let attempts = 0;
    const result = await withFreePorts(2, async ([a, b]) => {
      attempts += 1;
      return a === b ? 'same' : 'distinct';
    });
    expect(result).toBe('distinct');
    expect(attempts).toBe(1);
  });

  it('runs the attempt again on a fresh set of ports after a collision', async () => {
    const seen: number[][] = [];
    const result = await withFreePorts(2, async (ports) => {
      seen.push(ports);
      if (seen.length === 1) throw inUse();
      return 'recovered';
    });
    expect(result).toBe('recovered');
    expect(seen).toHaveLength(2);
  });

  it('rethrows any other failure at once, never retrying a real defect', async () => {
    let attempts = 0;
    await expect(
      withFreePorts(1, async () => {
        attempts += 1;
        throw new Error('server never logged "listening"');
      })
    ).rejects.toThrow('never logged');
    expect(attempts).toBe(1);
  });

  it('gives up after the attempt limit and rethrows the last collision', async () => {
    let attempts = 0;
    await expect(
      withFreePorts(
        1,
        async () => {
          attempts += 1;
          throw inUse();
        },
        3
      )
    ).rejects.toThrow('EADDRINUSE');
    expect(attempts).toBe(3);
  });
});
