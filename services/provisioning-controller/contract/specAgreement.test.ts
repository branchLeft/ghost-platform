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
  type RunningMock,
} from '../test/support/mockHarness.js';

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
  it('the spec has the five operations the journey needs, each behind one credential', () => {
    expect(sorted(operations.map((o) => o.id))).toEqual([
      'approvePromotionRequest',
      'createPromotionRequest',
      'getDemo',
      'getTenant',
      'listPromotionRequests',
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

  it('the mock implements exactly the spec operations', () => {
    const handlers = createMockHandlers(new MockStore(), {
      owner: OWNER_CREDENTIAL,
      tenants: new Map(),
    });
    expect(sorted(Object.keys(handlers))).toEqual(sorted(operations.map((o) => o.id)));
  });
});

describe('the mock enforces the credential the spec names, on every operation', () => {
  let running: RunningMock;
  beforeAll(async () => {
    running = await startMock();
  });
  afterAll(async () => {
    await running.close();
  });

  /** The header a scheme travels in, read from the spec rather than assumed. */
  function headerFor(scheme: string): string {
    const found = spec.components.securitySchemes[scheme];
    expect(found?.in, scheme).toBe('header');
    return found?.name ?? '';
  }

  function request(operation: Operation, headers: Record<string, string>) {
    const path = operation.path.replace('{tenant}', TENANT_A).replace('{id}', TENANT_A);
    const body =
      operation.id === 'createPromotionRequest'
        ? JSON.stringify({ tier: 'essentials' })
        : undefined;
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
      const other = operation.scheme === 'ownerCredential' ? 'tenantCredential' : 'ownerCredential';
      const otherValue = other === 'ownerCredential' ? OWNER_CREDENTIAL : TENANT_A_CREDENTIAL;
      const rightValue =
        operation.scheme === 'ownerCredential' ? OWNER_CREDENTIAL : TENANT_A_CREDENTIAL;

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
