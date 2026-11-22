import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  createSqliteStore,
  isLeaseId,
  TenantRegistrationRefused,
  type ShimStore,
} from './store.js';

export interface CliIO {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

export function generateApiKey(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * A bare `--flag`-shaped token, never a real domain or credential label —
 * used to refuse two shapes an unvalidated positional/flag parser lets
 * through silently: a flag consumed as the positional it was never meant
 * to fill (`register --sender-domain x d` registering a tenant literally
 * named `--sender-domain`), and a flag consumed as another flag's own
 * value (`register d --sender-domain --rotate` storing `--rotate` as the
 * sender domain because nothing checked what followed `--sender-domain`
 * before taking it).
 */
function looksLikeFlag(value: string | undefined): boolean {
  return value !== undefined && value.startsWith('--');
}

/**
 * Operator input is refused, never coerced: a typo'd sender domain would
 * otherwise surface later as every real send being refused.
 * See cli.md#hostname-pattern.
 */
const HOSTNAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

function isPlainLowercaseHostname(value: string): boolean {
  return HOSTNAME_PATTERN.test(value);
}

/**
 * A From local part the shim can bind a credential to: the same shape
 * render-core accepts for a demo's local part. Case is kept as typed here
 * (the store compares lower-cased); anything else is refused, not coerced.
 */
const LOCAL_PART_PATTERN = /^[A-Za-z0-9]([A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/;

function isLocalPart(value: string): boolean {
  return LOCAL_PART_PATTERN.test(value);
}

/** Reports a refused registration on stderr and returns exit code 1; rethrows anything else. */
function reportRefusal(err: unknown, io: CliIO): number {
  if (err instanceof TenantRegistrationRefused) {
    io.stderr(`Refused: ${err.message}`);
    return 1;
  }
  throw err;
}

/**
 * Opens the DB directly (WAL makes this safe alongside the running
 * service). Never routes through src/log.ts — a plaintext API key must
 * reach the operator's terminal exactly once and never through anything
 * that could end up in a log line or log aggregator.
 */
export async function runCli(
  argv: string[],
  openStore: () => ShimStore,
  io: CliIO
): Promise<number> {
  const [command, ...rest] = argv;

  switch (command) {
    case 'register': {
      const domain = rest[0];
      const senderDomainIndex = rest.indexOf('--sender-domain');
      const senderDomain = senderDomainIndex !== -1 ? rest[senderDomainIndex + 1] : undefined;
      const localPartIndex = rest.indexOf('--sender-local-part');
      const senderLocalPart = localPartIndex !== -1 ? rest[localPartIndex + 1] : undefined;
      const leaseIndex = rest.indexOf('--lease');
      const lease = leaseIndex !== -1 ? rest[leaseIndex + 1] : undefined;
      // A flag can never fill the positional slot, and a flag can never be
      // another flag's own value — see looksLikeFlag's own doc comment for
      // the two shapes this refuses.
      if (
        !domain ||
        !senderDomain ||
        looksLikeFlag(domain) ||
        looksLikeFlag(senderDomain) ||
        !isPlainLowercaseHostname(domain) ||
        !isPlainLowercaseHostname(senderDomain) ||
        (localPartIndex !== -1 &&
          (senderLocalPart === undefined ||
            looksLikeFlag(senderLocalPart) ||
            !isLocalPart(senderLocalPart))) ||
        (leaseIndex !== -1 && (lease === undefined || !isLeaseId(lease)))
      ) {
        io.stderr(
          'Usage: register <credential-domain> --sender-domain <domain> [--sender-local-part <local-part>] [--lease <lease-id>] [--rotate]'
        );
        io.stderr(
          'With --lease the credential serves that demo lease (a 26-character ULID): every batch it enqueues is stamped with it, so a recycle can purge exactly that lease (purge-lease).'
        );
        io.stderr(
          'Both <credential-domain> and <domain> must be plain lowercase hostnames (e.g. blog.branchleft.co.uk).'
        );
        io.stderr(
          'With --sender-local-part the credential may send only as <local-part>@<domain>; without it, as any local part at <domain>.'
        );
        return 1;
      }
      const rotate = rest.includes('--rotate');
      const store = openStore();
      try {
        // registerTenant is INSERT OR REPLACE — without this guard a
        // second `register` for a live domain would silently rotate its
        // key (and sender domain) out from under it. To change only the
        // sender domain on an existing tenant without re-keying it, use
        // set-sender-domain instead.
        if (store.tenantExists(domain) && !rotate) {
          io.stderr(`Tenant ${domain} already exists. Pass --rotate to replace its key.`);
          return 1;
        }
        const apiKey = generateApiKey();
        try {
          store.registerTenant(domain, apiKey, senderDomain, senderLocalPart ?? null, lease);
        } catch (err) {
          return reportRefusal(err, io);
        }
        io.stdout(
          `Registered ${domain} (sender: ${senderLocalPart ? `${senderLocalPart}@` : 'any local part at '}${senderDomain}).`
        );
        io.stdout('API key (shown once — it will not be shown again):');
        io.stdout(apiKey);
        return 0;
      } finally {
        store.close();
      }
    }

    case 'set-sender-domain': {
      const domain = rest[0];
      const senderDomain = rest[1];
      if (
        !domain ||
        !senderDomain ||
        looksLikeFlag(domain) ||
        looksLikeFlag(senderDomain) ||
        !isPlainLowercaseHostname(domain) ||
        !isPlainLowercaseHostname(senderDomain)
      ) {
        io.stderr('Usage: set-sender-domain <credential-domain> <sender-domain>');
        io.stderr('Both arguments must be plain lowercase hostnames (e.g. blog.branchleft.co.uk).');
        return 1;
      }
      const store = openStore();
      try {
        let updated: boolean;
        try {
          updated = store.setSenderDomain(domain, senderDomain);
        } catch (err) {
          return reportRefusal(err, io);
        }
        if (!updated) {
          io.stderr(`Tenant ${domain} is not registered. Use register to create it.`);
          return 1;
        }
        io.stdout(`Set ${domain}'s sender domain to ${senderDomain}.`);
        return 0;
      } finally {
        store.close();
      }
    }

    case 'set-sender-local-part': {
      const domain = rest[0];
      const localPart = rest[1];
      if (
        !domain ||
        !localPart ||
        looksLikeFlag(domain) ||
        looksLikeFlag(localPart) ||
        !isPlainLowercaseHostname(domain) ||
        !isLocalPart(localPart)
      ) {
        io.stderr('Usage: set-sender-local-part <credential-domain> <local-part>');
        io.stderr(
          '<credential-domain> must be a plain lowercase hostname and <local-part> a plain local part (e.g. noreply).'
        );
        return 1;
      }
      const store = openStore();
      try {
        let updated: boolean;
        try {
          updated = store.setSenderLocalPart(domain, localPart);
        } catch (err) {
          return reportRefusal(err, io);
        }
        if (!updated) {
          io.stderr(`Tenant ${domain} is not registered. Use register to create it.`);
          return 1;
        }
        io.stdout(`Bound ${domain} to the From local part ${localPart}.`);
        return 0;
      } finally {
        store.close();
      }
    }

    case 'set-lease': {
      const domain = rest[0];
      const lease = rest[1];
      if (
        !domain ||
        !lease ||
        rest.length !== 2 ||
        looksLikeFlag(domain) ||
        !isPlainLowercaseHostname(domain) ||
        !isLeaseId(lease)
      ) {
        io.stderr('Usage: set-lease <credential-domain> <lease-id>');
        io.stderr(
          '<credential-domain> must be a plain lowercase hostname and <lease-id> a 26-character ULID.'
        );
        return 1;
      }
      const store = openStore();
      try {
        if (!store.setTenantLease(domain, lease)) {
          io.stderr(`Tenant ${domain} is not registered. Use register to create it.`);
          return 1;
        }
        io.stdout(`Bound ${domain} to lease ${lease}.`);
        return 0;
      } finally {
        store.close();
      }
    }

    case 'purge-lease': {
      // Deletes unsent mail, so it takes the lease id once, exactly: it
      // names one lease, never a credential domain. See cli.md#purge-lease.
      const lease = rest[0];
      if (!lease || rest.length !== 1 || !isLeaseId(lease)) {
        io.stderr('Usage: purge-lease <lease-id>');
        io.stderr('<lease-id> must be a 26-character ULID. Nothing was purged.');
        return 1;
      }
      const store = openStore();
      try {
        const { recipients, batches } = store.purgeLease(lease);
        io.stdout(
          `Purged lease ${lease}: ${recipients} unsent recipient(s) and ${batches} empty batch(es) removed.`
        );
        return 0;
      } finally {
        store.close();
      }
    }

    case 'remove': {
      // Guarded like `register --rotate`: deleting the row is what locks a
      // live sender out (every send from it gets the same 401), so the
      // operator must type the domain a second time. See cli.md#remove.
      const domain = rest[0];
      const confirmIndex = rest.indexOf('--confirm');
      const confirmed = confirmIndex !== -1 ? rest[confirmIndex + 1] : undefined;
      if (
        !domain ||
        looksLikeFlag(domain) ||
        !isPlainLowercaseHostname(domain) ||
        rest.length !== 3 ||
        confirmIndex !== 1
      ) {
        io.stderr('Usage: remove <credential-domain> --confirm <credential-domain>');
        io.stderr(
          '<credential-domain> must be a plain lowercase hostname (e.g. blog.branchleft.co.uk), repeated after --confirm.'
        );
        return 1;
      }
      if (confirmed !== domain) {
        io.stderr(
          `--confirm must repeat the domain exactly (got ${confirmed ?? '(nothing)'}). Nothing was removed.`
        );
        return 1;
      }
      const store = openStore();
      try {
        const existing = store.listTenants().find((tenant) => tenant.domain === domain);
        if (!existing || !store.removeTenant(domain)) {
          io.stderr(`Tenant ${domain} is not registered. Nothing was removed.`);
          return 1;
        }
        io.stdout(
          `Removed ${domain} (sender domain: ${existing.senderDomain ?? 'NOT SET'}). Its key no longer authenticates.`
        );
        return 0;
      } finally {
        store.close();
      }
    }

    case 'list': {
      const store = openStore();
      try {
        // The credential domain alone cannot confirm set-sender-domain
        // actually ran — a tenant with sender_domain still NULL prints
        // identically to a fully-configured one. Printing both makes this
        // the real post-deploy diagnostic an operator needs.
        for (const { domain, senderDomain, senderLocalPart } of store.listTenants()) {
          io.stdout(
            `${domain} (sender domain: ${senderDomain ?? 'NOT SET'}, local part: ${senderLocalPart ?? 'ANY'})`
          );
        }
        return 0;
      } finally {
        store.close();
      }
    }

    case 'events': {
      const domain = rest[0];
      if (!domain) {
        io.stderr('Usage: events <domain> [--limit N]');
        return 1;
      }
      const limitIndex = rest.indexOf('--limit');
      const limitArg = limitIndex !== -1 ? Number(rest[limitIndex + 1]) : NaN;
      const limit = Number.isFinite(limitArg) && limitArg > 0 ? limitArg : 300;
      const store = openStore();
      try {
        const { events } = store.listEvents(domain, { limit, offset: 0 });
        for (const event of events) {
          io.stdout(JSON.stringify(event));
        }
        return 0;
      } finally {
        store.close();
      }
    }

    default:
      io.stderr(`Unknown command: ${command ?? '(none)'}`);
      io.stderr(
        'Usage: cli.js <register|set-sender-domain|set-sender-local-part|set-lease|purge-lease|remove|list|events> ...'
      );
      return 1;
  }
}

/* v8 ignore start -- process entrypoint wiring (argv/env/exit), same shape as server.ts; runCli above carries the tested behaviour. */
function main(): void {
  const dbPath = process.env.SHIM_DB_PATH;
  if (!dbPath) {
    process.stderr.write('SHIM_DB_PATH is required.\n');
    process.exit(1);
  }
  const io: CliIO = {
    stdout: (line) => process.stdout.write(line + '\n'),
    stderr: (line) => process.stderr.write(line + '\n'),
  };
  void runCli(process.argv.slice(2), () => createSqliteStore(dbPath), io).then((code) => {
    process.exitCode = code;
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
/* v8 ignore stop */
