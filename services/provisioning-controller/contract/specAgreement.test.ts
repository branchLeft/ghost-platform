import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { routes } from '../src/generated/server.js';
import { createMockHandlers } from '../mock/handlers.js';
import { MockStore } from '../mock/store.js';
import {
  OWNER_CREDENTIAL,
  TENANT_A,
  TENANT_A_CREDENTIAL,
  raw,
  startMock,
} from '../test/support/mockHarness.js';
import * as real from '../test/support/serviceHarness.js';
import { createHandlers } from '../src/service/handlers.js';

/**
 * The spec (openapi.yaml), the routes generated from it and the mock that
 * serves them must name the same operations, and the mock must enforce the
 * credential the spec names for each. A renamed spec route, or an operation
 * the mock does not implement, fails here.
 */
interface Operation {
  readonly id: string;
  readonly method: string;
  readonly path: string;
  readonly scheme: string;
  readonly statuses: readonly number[];
}

interface SpecOperation {
  operationId: string;
  security: Record<string, unknown>[];
  responses: Record<string, unknown>;
}

interface Spec {
  paths: Record<string, Record<string, SpecOperation>>;
  components: { securitySchemes: Record<string, { in: string; name: string }> };
}

const spec = parse(readFileSync(new URL('../openapi.yaml', import.meta.url), 'utf8')) as Spec;

const operations: Operation[] = Object.entries(spec.paths).flatMap(([path, item]) =>
  Object.entries(item).map(([method, operation]) => ({
    id: operation.operationId,
    method: method.toUpperCase(),
    path,
    scheme: Object.keys(operation.security[0] ?? {})[0] ?? '',
    statuses: Object.keys(operation.responses).map(Number),
  }))
);

const sorted = (values: string[]): string[] => [...values].sort();

describe('the spec, the generated routes and the mock name the same operations', () => {
  it('the spec has the eight operations the journey needs, each behind one credential', () => {
    expect(sorted(operations.map((o) => o.id))).toEqual([
      'approvePromotionRequest',
      'createPromotionRequest',
      'createTicket',
      'getDemo',
      'getTenant',
      'listPromotionRequests',
      'listTickets',
      'moveTicket',
    ]);
    for (const operation of operations) {
      expect(['tenantCredential', 'ownerCredential'], operation.id).toContain(operation.scheme);
    }
  });

  it('the generated route table matches the spec, operation by operation', () => {
    const fromSpec = operations.map((o) => `${o.id} ${o.method} ${o.path}`);
    const fromRoutes = routes.map((r) => `${r.id} ${r.method} ${r.path}`);
    expect(sorted(fromRoutes)).toEqual(sorted(fromSpec));
  });

  it('the real service implements exactly the spec operations', () => {
    const handlers = createHandlers(new MockStore(), {
      owner: OWNER_CREDENTIAL,
      tenants: new Map(),
    });
    expect(sorted(Object.keys(handlers))).toEqual(sorted(operations.map((o) => o.id)));
  });

  it('the mock implements exactly the spec operations', () => {
    const handlers = createMockHandlers(new MockStore(), {
      owner: OWNER_CREDENTIAL,
      tenants: new Map(),
    });
    expect(sorted(Object.keys(handlers))).toEqual(sorted(operations.map((o) => o.id)));
  });
});

interface Served {
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
}

/** The sweep, for any implementation of the contract that can be started and given credentials. */
function sweep(
  name: string,
  start: () => Promise<{
    served: Served;
    owner: string;
    tenant: string;
    done?: () => Promise<void>;
  }>
): void {
  describe(`${name} enforces the credential the spec names, on every operation`, () => {
    let running: Served;
    let owner = '';
    let tenant = '';
    let done: (() => Promise<void>) | undefined;
    beforeAll(async () => {
      const started = await start();
      running = started.served;
      owner = started.owner;
      tenant = started.tenant;
      done = started.done;
    });
    afterAll(async () => {
      await running.close();
      await done?.();
    });

    /** The header a scheme travels in, read from the spec rather than assumed. */
    function headerFor(scheme: string): string {
      const found = spec.components.securitySchemes[scheme];
      expect(found?.in, scheme).toBe('header');
      return found?.name ?? '';
    }

    function request(operation: Operation, headers: Record<string, string>) {
      const path = operation.path.replace('{tenant}', TENANT_A).replace('{id}', TENANT_A);
      const bodies: Record<string, unknown> = {
        createPromotionRequest: { tier: 'essentials' },
        createTicket: { kind: 'support', contact: 'a@example.test', message: 'TEST_MESSAGE' },
        moveTicket: { state: 'open' },
      };
      const body = operation.id in bodies ? JSON.stringify(bodies[operation.id]) : undefined;
      return raw(running.baseUrl, operation.method, path, {
        headers: {
          ...headers,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body }),
      });
    }

    for (const operation of operations) {
      it(`${operation.id}: no credential is 401, the other kind is 403, the right one is served`, async () => {
        const other =
          operation.scheme === 'ownerCredential' ? 'tenantCredential' : 'ownerCredential';
        const otherValue = other === 'ownerCredential' ? owner : tenant;
        const rightValue = operation.scheme === 'ownerCredential' ? owner : tenant;

        const none = await request(operation, {});
        expect(none.status).toBe(401);
        const wrongKind = await request(operation, { [headerFor(other)]: otherValue });
        expect(wrongKind.status).toBe(403);
        const right = await request(operation, { [headerFor(operation.scheme)]: rightValue });
        expect([401, 403]).not.toContain(right.status);

        for (const result of [none, wrongKind, right]) {
          expect(operation.statuses, `${operation.id} answered ${String(result.status)}`).toContain(
            result.status
          );
        }
      });
    }
  });
}

sweep('the mock', async () => {
  const mock = await startMock();
  return { served: mock, owner: OWNER_CREDENTIAL, tenant: TENANT_A_CREDENTIAL };
});

sweep('the real service', async () => {
  const rig = real.makeRig();
  const started = await rig.start();
  return {
    served: started,
    owner: real.OWNER_CREDENTIAL,
    tenant: real.TENANT_A_CREDENTIAL,
    done: () => rig.cleanup(),
  };
});
