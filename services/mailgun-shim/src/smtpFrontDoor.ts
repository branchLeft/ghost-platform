import { BlockList, isIPv4, isIPv6 } from 'node:net';
import { randomUUID } from 'node:crypto';
import {
  SMTPServer,
  type SMTPServerAddress,
  type SMTPServerAuthentication,
  type SMTPServerAuthenticationResponse,
  type SMTPServerDataStream,
  type SMTPServerSession,
} from 'smtp-server';
import { simpleParser } from 'mailparser';
import { isSafeRecipientAddress } from './smtp.js';
import type { Logger } from './log.js';
import type { ShimStore } from './store.js';
import type { WorkerHandle } from './worker.js';

/**
 * Ghost's own transactional sender is the only intended caller (LLD-6 §03):
 * a magic link, a password reset, a staff invite. Loopback plus the private
 * ranges a Docker bridge network hands out — never a public address, in
 * either family. Kept as CIDRs (not a single host) because the container's
 * own address on the bridge isn't known ahead of time.
 */
export const DEFAULT_ALLOWED_SOURCE_CIDRS = [
  '127.0.0.1/32',
  '::1/128',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  'fc00::/7',
];

export function buildSourceAllowList(cidrs: readonly string[]): BlockList {
  const list = new BlockList();
  for (const cidr of cidrs) {
    const slash = cidr.lastIndexOf('/');
    const address = slash === -1 ? cidr : cidr.slice(0, slash);
    const family = isIPv6(address) ? 'ipv6' : 'ipv4';
    const defaultPrefix = family === 'ipv6' ? 128 : 32;
    const prefix = slash === -1 ? defaultPrefix : Number(cidr.slice(slash + 1));
    list.addSubnet(address, prefix, family);
  }
  return list;
}

/**
 * `smtp-server` reports an IPv4 client as an IPv4-mapped IPv6 literal
 * (`::ffff:172.18.0.3`) when the socket is dual-stack. Review cycle 1
 * corrected this docstring: `node:net`'s `BlockList` already resolves a
 * mapped address against an IPv4 subnet correctly on its own (measured:
 * `check('::ffff:10.0.0.5','ipv6')` against a `10.0.0.0/8` IPv4 entry
 * returns `true`; a mapped public address returns `false`), so the mapping
 * below is not needed to avoid a silent false-negative the way the estate's
 * mx1 exporter and the shim's own HTTP rate limiter (#1148) had — both of
 * which never tested their own IPv6 path at all. It is kept anyway: passing
 * a bare `10.0.0.5`-shaped string with family `'ipv4'` to `BlockList.check`
 * is unambiguous where passing the mapped literal with family `'ipv6'`
 * relies on `BlockList`'s own cross-family handling, and this function's own
 * test matrix (`isAllowedSource`'s IPv4/IPv6/mapped cases) covers both paths
 * either way.
 */
export function isAllowedSource(remoteAddress: string | undefined, allowList: BlockList): boolean {
  if (!remoteAddress) {
    return false;
  }
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(remoteAddress);
  const normalized = mapped ? mapped[1]! : remoteAddress;
  if (isIPv4(normalized)) {
    return allowList.check(normalized, 'ipv4');
  }
  if (isIPv6(normalized)) {
    return allowList.check(normalized, 'ipv6');
  }
  return false;
}

export interface SubmitterLimiter {
  /** Keyed on the authenticated submitter's own identity, never its address (#1148 is what happens otherwise). */
  tryTake(submitterId: string): boolean;
}

/**
 * Fixed-window counter, one bucket per authenticated tenant. Never looks at
 * an address at all, so there's no IPv4/IPv6 asymmetry to get wrong — the
 * generalisation LLD-6 M6 asks for, applied by construction rather than by
 * adding an IPv6-shaped test to an address-keyed limiter.
 */
export function createSubmitterLimiter(
  limit: number,
  windowMs: number,
  now: () => number = Date.now
): SubmitterLimiter {
  const windows = new Map<string, { count: number; windowStart: number }>();
  return {
    tryTake(submitterId) {
      const t = now();
      const entry = windows.get(submitterId);
      if (!entry || t - entry.windowStart >= windowMs) {
        windows.set(submitterId, { count: 1, windowStart: t });
        return true;
      }
      if (entry.count >= limit) {
        return false;
      }
      entry.count += 1;
      return true;
    },
  };
}

export interface SmtpFrontDoorOptions {
  store: ShimStore;
  worker: WorkerHandle;
  log: Logger;
  maxMessageBytes: number;
  allowedSourceCidrs?: readonly string[];
  submitterMessagesPerMinute: number;
  now?: () => number;
}

export interface SmtpFrontDoor {
  listen(port: number, host: string): Promise<void>;
  close(): Promise<void>;
}

declare module 'smtp-server' {
  interface SMTPServerSession {
    user?: string;
  }
}

/**
 * The listener Ghost's transactional sender connects to (LLD-6 §01-§03):
 * a durable local write, answered at once, with nothing awaited past the
 * SQLite transaction that makes the message durable. It shares
 * `enqueueBatch`/`claimDueRecipients` with the Mailgun-shaped HTTP route
 * (routes/messages.ts) — one queue, two front doors, exactly the LOAD-BEARING
 * shape LLD-6 §03 sets out.
 *
 * `worker.kick()` below is fire-and-forget by its own contract (worker.ts) —
 * nothing here awaits a network hop, which is the whole property this
 * component exists to hold.
 */
export function createSmtpFrontDoor(opts: SmtpFrontDoorOptions): SmtpFrontDoor {
  const { store, worker, log } = opts;
  const now = opts.now ?? Date.now;
  const allowList = buildSourceAllowList(opts.allowedSourceCidrs ?? DEFAULT_ALLOWED_SOURCE_CIDRS);
  const limiter = createSubmitterLimiter(opts.submitterMessagesPerMinute, 60_000, now);

  const server = new SMTPServer({
    banner: 'branchLeft mail spool',
    size: opts.maxMessageBytes,
    disabledCommands: ['STARTTLS'],
    authMethods: ['PLAIN', 'LOGIN'],
    // Plaintext AUTH is refused by smtp-server unless this is set explicitly
    // (its default assumes TLS or STARTTLS carries the credential) — safe
    // only because this listener never leaves the container network (§03).
    allowInsecureAuth: true,
    authOptional: false,
    disableReverseLookup: true,

    onConnect(session: SMTPServerSession, callback: (err?: Error | null) => void): void {
      if (!isAllowedSource(session.remoteAddress, allowList)) {
        log.warn('smtp_connection_refused', { remoteAddress: session.remoteAddress });
        callback(new Error('Connection refused'));
        return;
      }
      callback();
    },

    onAuth(
      auth: SMTPServerAuthentication,
      _session: SMTPServerSession,
      callback: (err: Error | null | undefined, response?: SMTPServerAuthenticationResponse) => void
    ): void {
      // The username IS the submitter's identity (a per-tenant/per-slot
      // domain, same shape as the Mailgun HTTP route's tenant key) — a
      // submission is never trusted because of where it came from or what
      // address it claims to send as (issue #1236's premise). This
      // credential decision is real and tested (an unknown/wrong credential
      // is refused, a valid one is accepted) — deliberately NOT wrapped in a
      // coverage-ignore region, unlike the `?? ''`/`?? null` fallbacks
      // below, so its own coverage stays honest (review cycle 1, minor: an
      // earlier version of this region wrapped this reachable decision too,
      // hiding it from the coverage figure the 90% floor is measured
      // against). Only the `??` fallbacks are the unreachable part: smtp-
      // server's PLAIN and LOGIN mechanisms (lib/sasl.js) always normalise
      // `username`/`password` to a string, even an empty one, before onAuth
      // is ever called (verified from source: PLAIN takes `authcid ||
      // authzid` and `data[2] || ''`, LOGIN takes `(username ||
      // '').toString()` at each step) — undefined is not a value either
      // mechanism can hand this callback, only the TypeScript type says so.
      const tenant = store.verifyTenant(auth.username ?? '', auth.password ?? '');
      if (!tenant) {
        log.warn('smtp_auth_failed', { username: auth.username ?? null });
        callback(new Error('Invalid credentials'));
        return;
      }
      callback(null, { user: tenant.domain });
    },

    onMailFrom(
      _address: SMTPServerAddress,
      session: SMTPServerSession,
      callback: (err?: Error | null) => void
    ): void {
      const submitterId = session.user;
      /* v8 ignore start -- proven unreachable: authOptional:false makes
       * smtp-server refuse MAIL FROM before onAuth has set session.user
       * (verified empirically — a raw MAIL FROM before AUTH gets a 530 from
       * smtp-server itself, this handler is never called). Kept as a
       * fail-closed guard against that contract changing, not exercised
       * because there is no protocol sequence that reaches it. */
      if (!submitterId) {
        callback(new Error('Authentication required'));
        return;
      }
      /* v8 ignore stop */
      if (!limiter.tryTake(submitterId)) {
        log.warn('smtp_submitter_rate_limited', { submitter: submitterId });
        const err = new Error('Too many messages') as Error & { responseCode: number };
        err.responseCode = 450;
        callback(err);
        return;
      }
      callback();
    },

    onRcptTo(
      address: SMTPServerAddress,
      _session: SMTPServerSession,
      callback: (err?: Error | null) => void
    ): void {
      // Same address grammar the outbound path already defends (smtp.ts) —
      // rejecting group/list syntax and control characters here, at
      // acceptance, means the queue never holds a recipient a later
      // nodemailer send could misinterpret.
      if (!isSafeRecipientAddress(address.address)) {
        const err = new Error('Invalid recipient address') as Error & { responseCode: number };
        err.responseCode = 501;
        callback(err);
        return;
      }
      callback();
    },

    onData(
      stream: SMTPServerDataStream,
      session: SMTPServerSession,
      callback: (err?: Error | null, message?: string) => void
    ): void {
      const submitterId = session.user;
      const chunks: Buffer[] = [];
      // `size` above only makes smtp-server COUNT bytes past the cap and
      // flip `stream.sizeExceeded` — it keeps emitting every byte regardless
      // (smtp-stream.js's `_countDataBytes` sets the flag, then still writes
      // the chunk to this stream). Retaining every chunk here until 'end' is
      // what an authenticated submitter can turn into an OOM: a single
      // 600 MiB DATA phase against a 10 MiB cap killed a 256 MiB container
      // (reviewer live repro, review cycle 1). `_countDataBytes` runs before
      // this handler sees each chunk, so `sizeExceeded` is already correct
      // for the chunk in hand — once it flips, stop retaining bytes (release
      // anything already buffered too) while still consuming 'data' events
      // so the stream keeps draining and can still reach 'end' to reply 552.
      let overCap = false;
      stream.on('data', (chunk: Buffer) => {
        if (overCap) {
          return;
        }
        if (stream.sizeExceeded) {
          overCap = true;
          chunks.length = 0;
          return;
        }
        chunks.push(chunk);
      });
      stream.on('error', (err: Error) => callback(err));
      stream.on('end', () => {
        /* v8 ignore start -- proven unreachable: MAIL/RCPT/DATA is a state
         * machine smtp-server enforces itself, and MAIL FROM already refuses
         * to proceed without session.user set (see onMailFrom above), so
         * onData never fires with it unset. Kept as a fail-closed guard
         * against that contract changing. */
        if (!submitterId) {
          callback(new Error('Authentication required'));
          return;
        }
        /* v8 ignore stop */
        if (stream.sizeExceeded) {
          const err = new Error('Message too large') as Error & { responseCode: number };
          err.responseCode = 552;
          callback(err);
          return;
        }

        const recipients = session.envelope.rcptTo
          .map((r) => r.address)
          .filter((address) => isSafeRecipientAddress(address));
        /* v8 ignore start -- proven unreachable: smtp-server only appends to
         * session.envelope.rcptTo the addresses onRcptTo above already
         * accepted with this identical isSafeRecipientAddress check, and
         * DATA is refused with "503 need RCPT command" before onData fires
         * if no RCPT was accepted (verified empirically). Kept as
         * defense-in-depth should a future smtp-server version stop
         * guaranteeing that overlap. */
        if (recipients.length === 0) {
          callback(new Error('No recipients'));
          return;
        }
        /* v8 ignore stop */

        void simpleParser(Buffer.concat(chunks))
          .then((parsed) => {
            const headers: Record<string, string> = {};
            const replyTo =
              parsed.replyTo && !Array.isArray(parsed.replyTo) ? parsed.replyTo.text : undefined;
            if (replyTo) {
              headers['Reply-To'] = replyTo;
            }

            const from =
              (parsed.from && parsed.from.text) ||
              /* v8 ignore next -- session.envelope.mailFrom is only ever
               * unset before MAIL FROM has been accepted, and MAIL FROM is
               * required (smtp-server itself refuses RCPT/DATA without it)
               * before onData can run at all; the ternary's false arm
               * defends a state the protocol never lets this handler see. */
              (session.envelope.mailFrom ? session.envelope.mailFrom.address : '');

            const batchId = `<${now()}.${randomUUID()}@${submitterId}>`;

            // Durable write, synchronous, no network hop — this is the ack
            // Ghost's own request is waiting on (LLD-6 M1). worker.kick()
            // just below is documented fire-and-forget; nothing after this
            // point is awaited before callback() responds.
            store.enqueueBatch({
              batchId,
              domain: submitterId,
              emailId: null,
              payload: {
                from,
                subject: parsed.subject ?? '',
                html: typeof parsed.html === 'string' ? parsed.html : '',
                text: parsed.text ?? '',
                headers,
                recipientVariables: {},
              },
              recipients,
              now: now() / 1000,
            });

            log.info('smtp_enqueue', {
              submitter: submitterId,
              batchId,
              recipientCount: recipients.length,
            });
            worker.kick();

            callback(null, 'Queued. Thank you.');
          })
          .catch((err: unknown) => {
            // Review cycle 1, minor: renamed from `smtp_parse_failed` — this
            // catch spans the `.then()` chain too, so it also reports a
            // synchronous `store.enqueueBatch` failure (e.g. a SQLite write
            // error), not only a `simpleParser` rejection. The old name
            // misled whoever reads this event without misleading the code.
            log.error('smtp_message_processing_failed', {
              submitter: submitterId,
              error: err instanceof Error ? err.message : String(err),
            });
            callback(err instanceof Error ? err : new Error('Failed to parse message'));
          });
      });
    },
  });

  server.on('error', (err) => {
    log.error('smtp_server_error', { error: err.message });
  });

  return {
    listen(port: number, host: string): Promise<void> {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.removeListener('error', reject);
          log.info('worker_lifecycle', { event: 'smtp_listening', port, host });
          resolve();
        });
      });
    },
    close(): Promise<void> {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
