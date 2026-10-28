import pg from 'pg';
import { bindTenant, TenantDb, type HealthView } from 'ghost-platform-portal-data/tenant';
import { ORG_A, ORG_B, TENANT_A, TENANT_B } from '../../data/test/helpers.js';
import { reading } from './supportHarness.js';
import {
  defineSupportRouteTests,
  VERSION_A,
  VERSION_B,
  type BreakRead,
  type TicketRead,
} from './supportRouteScenarios.js';

interface BrokenRead {
  read?: TicketRead;
  failure?: Error;
}

type AnsweredMethod =
  | 'scopeForOrganisation'
  | 'ownRegistration'
  | 'ownKind'
  | 'moderationSettings'
  | 'ownHealth'
  | 'pendingAcceptances'
  | 'currentDocuments'
  | 'acceptances'
  | 'upcomingSubprocessors';

/**
 * A tenant data layer that answers from memory, so the route behaviour runs
 * with no database. It keys everything by the scope's tenant, as the real one
 * does, and fails closed on any call it was not given an answer for.
 */
function inMemoryTenantDb(broken: BrokenRead): TenantDb {
  const registered = new Map<string, string>([
    [ORG_A, TENANT_A],
    [ORG_B, TENANT_B],
  ]);
  const readings = new Map<string, HealthView>([
    [TENANT_A, reading({ reportedVersion: VERSION_A, versionMatch: true })],
    [
      TENANT_B,
      reading({
        reportedVersion: VERSION_B,
        versionMatch: false,
        mismatchSince: new Date('2026-10-02T10:00:00.000Z'),
      }),
    ],
  ]);
  const answers: Pick<TenantDb, AnsweredMethod> = {
    scopeForOrganisation: async (org) => {
      const tenant = registered.get(org);
      return tenant === undefined ? null : bindTenant(tenant);
    },
    ownRegistration: async (scope) => {
      if (broken.read === 'ownRegistration') throw broken.failure;
      return { tenantId: scope.tenantId, zitadelOrgId: 'org', kind: 'REAL' as const };
    },
    // The moderation page reads the kind from the register row, as main does.
    ownKind: async () => 'REAL' as const,
    // Nothing saved yet: the moderation page renders its defaults.
    moderationSettings: async () => ({}),
    ownHealth: async (scope) => {
      if (broken.read === 'ownHealth') throw broken.failure;
      return readings.get(scope.tenantId) ?? null;
    },
    pendingAcceptances: async () => [],
    currentDocuments: async () => [],
    acceptances: async () => [],
    upcomingSubprocessors: async () => [],
  };
  // The pool is never used: every method the portal calls here is answered above.
  return new Proxy(new TenantDb(new pg.Pool()), {
    get(_target, property) {
      if (!Object.hasOwn(answers, property)) {
        throw new TypeError(`no in-memory answer for ${String(property)}`);
      }
      return answers[property as AnsweredMethod];
    },
  });
}

const broken: BrokenRead = {};
const db = inMemoryTenantDb(broken);

const breakRead: BreakRead = (read, failure) => {
  broken.read = read;
  broken.failure = failure;
};

defineSupportRouteTests(() => db, breakRead);
