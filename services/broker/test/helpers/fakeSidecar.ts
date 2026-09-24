import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeSidecar {
  readonly port: number;
  setHealthy(healthy: boolean): void;
  close(): Promise<void>;
}

/** A stand-in for `services/drain-sidecar`'s real `/healthz` route. */
export async function startFakeSidecar(): Promise<FakeSidecar> {
  let healthy = true;
  const server: Server = createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: healthy ? 'ok' : 'drained' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    setHealthy: (value) => {
      healthy = value;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
