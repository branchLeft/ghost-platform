import type { NextFunction, Request, Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requireTenantForDomain } from '../../src/auth.js';
import { createSqliteStore, type ShimStore } from '../../src/store.js';

interface FakeResponse {
  statusCode: number;
  body: unknown;
  locals: Record<string, unknown>;
  status(code: number): FakeResponse;
  json(body: unknown): FakeResponse;
}

function fakeReq(authorization: string | undefined, domain: string): Request {
  return { headers: { authorization }, params: { domain } } as unknown as Request;
}

function fakeRes(): FakeResponse {
  const res: FakeResponse = {
    statusCode: 0,
    body: undefined,
    locals: {},
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(body) {
      res.body = body;
      return res;
    },
  };
  return res;
}

function basicAuthHeader(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
}

describe('requireTenantForDomain — Basic-auth parsing edge cases', () => {
  const store = {
    verifyTenant: vi.fn(),
  } as unknown as ShimStore;
  const middleware = requireTenantForDomain(store);
  const next = vi.fn() as unknown as NextFunction;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects a missing Authorization header', () => {
    const req = fakeReq(undefined, 'tenant.example.com');
    const res = fakeRes();
    middleware(req, res as unknown as Response, next);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ message: 'Missing or malformed Authorization header' });
    expect(next).not.toHaveBeenCalled();
    expect(store.verifyTenant).not.toHaveBeenCalled();
  });

  it('rejects a non-Basic auth scheme (e.g. Bearer)', () => {
    const req = fakeReq('Bearer some-token', 'tenant.example.com');
    const res = fakeRes();
    middleware(req, res as unknown as Response, next);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ message: 'Missing or malformed Authorization header' });
    expect(store.verifyTenant).not.toHaveBeenCalled();
  });

  it('rejects malformed base64 that decodes to a string with no colon separator', () => {
    // "not-base64-with-no-colon" has no ':' once run through base64 decode/garbling.
    const req = fakeReq('Basic not-base64-with-no-colon', 'tenant.example.com');
    const res = fakeRes();
    middleware(req, res as unknown as Response, next);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ message: 'Missing or malformed Authorization header' });
    expect(store.verifyTenant).not.toHaveBeenCalled();
  });

  it('rejects an empty Authorization value after "Basic "', () => {
    const req = fakeReq('Basic ', 'tenant.example.com');
    const res = fakeRes();
    middleware(req, res as unknown as Response, next);
    expect(res.statusCode).toBe(401);
    expect(store.verifyTenant).not.toHaveBeenCalled();
  });

  it('treats an empty username as fine — only the password half is used', () => {
    (store.verifyTenant as ReturnType<typeof vi.fn>).mockReturnValue({
      domain: 'tenant.example.com',
    });
    const req = fakeReq(basicAuthHeader('', 'the-password'), 'tenant.example.com');
    const res = fakeRes();
    middleware(req, res as unknown as Response, next);
    expect(store.verifyTenant).toHaveBeenCalledWith('tenant.example.com', 'the-password');
    expect(next).toHaveBeenCalled();
  });

  it('accepts an empty password as a (failing) verification attempt rather than a parse failure', () => {
    (store.verifyTenant as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const req = fakeReq(basicAuthHeader('api', ''), 'tenant.example.com');
    const res = fakeRes();
    middleware(req, res as unknown as Response, next);
    expect(store.verifyTenant).toHaveBeenCalledWith('tenant.example.com', '');
    expect(res.statusCode).toBe(401);
  });

  it('preserves colons inside the password — only the first colon splits user from password', () => {
    (store.verifyTenant as ReturnType<typeof vi.fn>).mockReturnValue({
      domain: 'tenant.example.com',
    });
    const req = fakeReq(basicAuthHeader('api', 'pass:with:colons'), 'tenant.example.com');
    const res = fakeRes();
    middleware(req, res as unknown as Response, next);
    expect(store.verifyTenant).toHaveBeenCalledWith('tenant.example.com', 'pass:with:colons');
  });

  it('sets res.locals.tenant and calls next() on success', () => {
    const tenant = { domain: 'tenant.example.com' };
    (store.verifyTenant as ReturnType<typeof vi.fn>).mockReturnValue(tenant);
    const req = fakeReq(basicAuthHeader('api', 'good-key'), 'tenant.example.com');
    const res = fakeRes();
    middleware(req, res as unknown as Response, next);
    expect(res.locals.tenant).toBe(tenant);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(0);
  });
});

describe('requireTenantForDomain — unknown domain vs wrong key produce the identical 401 shape', () => {
  const store = {
    verifyTenant: vi.fn(),
  } as unknown as ShimStore;
  const middleware = requireTenantForDomain(store);
  const next = vi.fn() as unknown as NextFunction;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('unknown domain -> 401 { message: "Unauthorized" }', () => {
    (store.verifyTenant as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const req = fakeReq(basicAuthHeader('api', 'any-key'), 'never-registered.example.com');
    const res = fakeRes();
    middleware(req, res as unknown as Response, next);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ message: 'Unauthorized' });
  });

  it('known domain, wrong key -> the exact same 401 shape', () => {
    (store.verifyTenant as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const req = fakeReq(basicAuthHeader('api', 'wrong-key'), 'tenant.example.com');
    const res = fakeRes();
    middleware(req, res as unknown as Response, next);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ message: 'Unauthorized' });
  });
});

describe('tenant isolation with a real store — the core property', () => {
  let store: ShimStore;

  beforeEach(() => {
    store = createSqliteStore(':memory:');
    store.registerTenant('tenant-a.example.com', 'tenant-a-secret-key');
    store.registerTenant('tenant-b.example.com', 'tenant-b-secret-key');
  });

  afterEach(() => {
    store.close();
  });

  it("tenant A's own key authorises tenant A's own domain", () => {
    const middleware = requireTenantForDomain(store);
    const req = fakeReq(basicAuthHeader('api', 'tenant-a-secret-key'), 'tenant-a.example.com');
    const res = fakeRes();
    const next = vi.fn() as unknown as NextFunction;
    middleware(req, res as unknown as Response, next);
    expect(next).toHaveBeenCalled();
    expect(res.locals.tenant).toEqual({ domain: 'tenant-a.example.com' });
  });

  it("a valid key for tenant A never authorises tenant B's domain", () => {
    const middleware = requireTenantForDomain(store);
    const req = fakeReq(basicAuthHeader('api', 'tenant-a-secret-key'), 'tenant-b.example.com');
    const res = fakeRes();
    const next = vi.fn() as unknown as NextFunction;
    middleware(req, res as unknown as Response, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.locals.tenant).toBeUndefined();
  });

  it("tenant B's key is likewise refused against tenant A's domain", () => {
    const middleware = requireTenantForDomain(store);
    const req = fakeReq(basicAuthHeader('api', 'tenant-b-secret-key'), 'tenant-a.example.com');
    const res = fakeRes();
    const next = vi.fn() as unknown as NextFunction;
    middleware(req, res as unknown as Response, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });
});
