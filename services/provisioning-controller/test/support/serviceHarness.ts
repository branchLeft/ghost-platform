import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService, type Service, type ServiceOptions } from '../../src/service/service.js';
import { TENANT_A, TENANT_B } from './mockHarness.js';

export { TENANT_A, TENANT_B };
export const OWNER_CREDENTIAL = 'TEST-OWNER-CREDENTIAL-0123456789';
export const TENANT_A_CREDENTIAL = 'TEST-TENANT-A-CREDENTIAL-0123456789';
export const TENANT_B_CREDENTIAL = 'TEST-TENANT-B-CREDENTIAL-0123456789';
export const DEMO_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const DEMO_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

export interface Rig {
  readonly dir: string;
  readonly files: {
    readonly owner: string;
    readonly tenants: string;
    readonly demos: string;
    readonly state: string;
  };
  readonly problems: string[];
  /** Starts a service on these files; call again to model a restart. */
  readonly start: (overrides?: Partial<ServiceOptions>) => Promise<RunningService>;
  readonly cleanup: () => Promise<void>;
}

export interface RunningService {
  readonly baseUrl: string;
  readonly service: Service;
  readonly errors: unknown[];
  readonly close: () => Promise<void>;
}

export function demoRegister(
  entries: readonly { tenantId: string; demoId: string; state?: string; address?: string | null }[]
): string {
  return JSON.stringify({
    demos: entries.map((entry) => ({
      tenantId: entry.tenantId,
      demoId: entry.demoId,
      address: entry.address === undefined ? 'demo.example.test' : entry.address,
      state: entry.state ?? 'LIVE',
      expiresAt: '2026-02-01T00:00:00.000Z',
    })),
  });
}

/** A directory of the four inputs a service needs, with working test values in them. */
export function makeRig(): Rig {
  const dir = mkdtempSync(join(tmpdir(), 'provisioning-service-'));
  const files = {
    owner: join(dir, 'owner-credential'),
    tenants: join(dir, 'tenant-credentials'),
    demos: join(dir, 'demos.json'),
    state: join(dir, 'state'),
  };
  writeFileSync(files.owner, `${OWNER_CREDENTIAL}\n`);
  writeFileSync(
    files.tenants,
    `${TENANT_A}=${TENANT_A_CREDENTIAL}\n${TENANT_B}=${TENANT_B_CREDENTIAL}\n`
  );
  writeFileSync(
    files.demos,
    demoRegister([
      { tenantId: TENANT_A, demoId: DEMO_A },
      { tenantId: TENANT_B, demoId: DEMO_B },
    ])
  );
  chmodSync(files.demos, 0o644);
  const problems: string[] = [];
  const running: RunningService[] = [];
  let counter = 0;
  return {
    dir,
    files,
    problems,
    start: async (overrides = {}) => {
      const errors: unknown[] = [];
      const service = createService({
        config: {
          port: 0,
          host: '127.0.0.1',
          ownerCredentialFile: files.owner,
          tenantCredentialsFile: files.tenants,
          demosFile: files.demos,
          stateDir: files.state,
        },
        newId: () => {
          counter += 1;
          return `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
        },
        now: () => new Date('2026-01-01T00:00:00.000Z'),
        onProblem: (code) => problems.push(code),
        onError: (error) => errors.push(error),
        ...overrides,
      });
      await new Promise<void>((resolve) => service.server.listen(0, '127.0.0.1', resolve));
      const { port } = service.server.address() as AddressInfo;
      const started: RunningService = {
        baseUrl: `http://127.0.0.1:${String(port)}`,
        service,
        errors,
        close: () =>
          new Promise<void>((resolve, reject) => {
            service.server.close((error) => (error === undefined ? resolve() : reject(error)));
            service.server.closeAllConnections();
          }),
      };
      running.push(started);
      return started;
    },
    cleanup: async () => {
      for (const one of running) await one.close().catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
