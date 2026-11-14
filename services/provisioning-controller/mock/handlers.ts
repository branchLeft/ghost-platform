import type { Handlers } from '../src/generated/server.js';
import { authorizeOwner, authorizeTenant, type Credentials, type Refusal } from './auth.js';
import type { MockStore } from './store.js';

/**
 * The contract's operations over the in-memory store. The generated server
 * has already checked the request against the spec by the time a method here
 * runs, and checks the success response against it on the way out; the
 * `Handlers` type makes the compiler check every status and error body.
 */

function refused(why: Refusal): { status: 401 | 403; body: { code: Refusal } } {
  return { status: why === 'unauthenticated' ? 401 : 403, body: { code: why } };
}

export function createMockHandlers(store: MockStore, credentials: Credentials): Handlers {
  return {
    getDemo(request, context) {
      const { tenant } = request.path;
      const why = authorizeTenant(credentials, context.rawRequest, tenant);
      if (why !== undefined) return Promise.resolve(refused(why));
      const demo = store.getDemo(tenant);
      return Promise.resolve(
        demo === undefined
          ? { status: 404, body: { code: 'demo-not-found' } }
          : { status: 200, body: demo }
      );
    },

    createPromotionRequest(request, context) {
      const { tenant } = request.path;
      const why = authorizeTenant(credentials, context.rawRequest, tenant);
      if (why !== undefined) return Promise.resolve(refused(why));
      const outcome = store.createRequest(tenant, request.body.tier);
      switch (outcome.kind) {
        case 'recorded':
          return Promise.resolve({ status: 201, body: outcome.request });
        case 'no-demo':
          return Promise.resolve({ status: 404, body: { code: 'demo-not-found' } });
        case 'not-promotable':
          return Promise.resolve({ status: 409, body: { code: 'demo-not-promotable' } });
        case 'other-request-open':
          return Promise.resolve({ status: 409, body: { code: 'request-already-open' } });
      }
    },

    getTenant(request, context) {
      const { tenant } = request.path;
      const why = authorizeTenant(credentials, context.rawRequest, tenant);
      if (why !== undefined) return Promise.resolve(refused(why));
      const found = store.getTenant(tenant);
      return Promise.resolve(
        found === undefined
          ? { status: 404, body: { code: 'tenant-not-found' } }
          : { status: 200, body: found }
      );
    },

    listPromotionRequests(request, context) {
      const why = authorizeOwner(credentials, context.rawRequest);
      if (why !== undefined) return Promise.resolve(refused(why));
      return Promise.resolve({
        status: 200,
        body: { items: store.listRequests(request.query?.state) },
      });
    },

    approvePromotionRequest(request, context) {
      const why = authorizeOwner(credentials, context.rawRequest);
      if (why !== undefined) return Promise.resolve(refused(why));
      const outcome = store.approve(request.path.id);
      switch (outcome.kind) {
        case 'approved':
          return Promise.resolve({ status: 200, body: outcome.request });
        case 'no-request':
          return Promise.resolve({ status: 404, body: { code: 'request-not-found' } });
        case 'not-approvable':
          return Promise.resolve({ status: 409, body: { code: 'not-approvable' } });
      }
    },
  };
}
