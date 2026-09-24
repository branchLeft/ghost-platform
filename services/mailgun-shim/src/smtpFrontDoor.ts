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
 * (`::ffff:172.18.0.3`) when the socket is dual-stack. `node:net`'s
 * `BlockList` already resolves a mapped address against an IPv4 subnet
 * correctly on its own (`check('::ffff:10.0.0.5','ipv6')` against a
 * `10.0.0.0/8` entry returns `true`; a mapped public address returns
 * `false`). The explicit mapping below is kept anyway: passing a bare
 * `10.0.0.5`-shaped string with family `'ipv4'` is unambiguous, rather than
 * relying on `BlockList`'s own cross-family handling for the mapped form.
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
  /** Keyed on the authenticated submitter's own identity, never its address. */
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
  /** Cap on connections that have not yet authenticated. Never gates an authenticated submitter — this pool and the authenticated one are counted separately. */
  maxUnauthenticatedConnections: number;
  /** How long a connection has to complete AUTH before it is closed outright, freeing its slot in the unauthenticated pool regardless of how it keeps itself alive (e.g. periodic NOOP). */
  authDeadlineMs: number;
  /** Cap on messages actively streaming DATA at once, across every submitter. This is what bounds worst-case retained memory (maxConcurrentDataPhases * maxMessageBytes) — an authenticated connection that is not sending a message costs nothing, so it is never counted here. */
  maxConcurrentDataPhases: number;
  /** Cap on messages actively streaming DATA at once, per authenticated submitter. Stops one credential monopolising the global budget. */
  maxConcurrentDataPhasesPerSubmitter: number;
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
 * `smtp-server`'s own connection objects, as held in `SMTPServer.connections`
 * (typed `Set<any>` upstream) — narrowed to exactly what's needed to tell an
 * authenticated connection from an unauthenticated one and to end one that
 * has overrun its auth deadline. `session` here is the same object instance
 * `onAuth` mutates, so `.session.user` reflects live auth state.
 */
interface RawSmtpConnection {
  session?: { user?: string };
  close(): void;
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

  // What actually costs memory is a DATA phase in flight, not a connection —
  // an authenticated, idle connection retains nothing. Counted globally and
  // per submitter so worst-case retained memory stays
  // maxConcurrentDataPhases * maxMessageBytes, and no single credential can
  // claim the whole budget.
  let inFlightDataGlobal = 0;
  const inFlightDataPerSubmitter = new Map<string, number>();

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

      // `server.connections` already includes this connection (smtp-server
      // adds it before calling onConnect), with no `session.user` yet, so it
      // is correctly counted here. Capping ALL connections — authenticated
      // or not — behind one number let an attacker with no credential hold
      // every slot with idle connections and get a real submitter refused
      // at the greeting. This cap counts only the unauthenticated pool, so
      // an authenticated submitter is never turned away because of it.
      const connections = server.connections as unknown as Set<RawSmtpConnection>;
      const unauthenticatedCount = [...connections].filter((c) => !c.session?.user).length;
      if (unauthenticatedCount > opts.maxUnauthenticatedConnections) {
        log.warn('smtp_connection_refused', {
          remoteAddress: session.remoteAddress,
          reason: 'max_unauthenticated_connections',
        });
        const err = new Error('Too many connections') as Error & { responseCode: number };
        err.responseCode = 421;
        callback(err);
        return;
      }

      callback();

      // A connection that never authenticates is closed outright once its
      // deadline passes, regardless of how it keeps itself alive in the
      // meantime (e.g. a NOOP every few seconds, which resets smtp-server's
      // own idle timeout but never authenticates) — otherwise the
      // unauthenticated pool above still fills, just more slowly. A
      // connection that has authenticated by the time this fires is exempt:
      // `session.user` is set on this same object by onAuth, so the check
      // below is a no-op for it.
      const deadline = setTimeout(() => {
        if (session.user) {
          return;
        }
        log.warn('smtp_auth_deadline_exceeded', { remoteAddress: session.remoteAddress });
        connections.forEach((c) => {
          if (c.session === session) {
            c.close();
          }
        });
      }, opts.authDeadlineMs);
      deadline.unref();
    },

    onAuth(
      auth: SMTPServerAuthentication,
      _session: SMTPServerSession,
      callback: (err: Error | null | undefined, response?: SMTPServerAuthenticationResponse) => void
    ): void {
      // The username IS the submitter's identity (a per-tenant/per-slot
      // domain, same shape as the Mailgun HTTP route's tenant key) — a
      // submission is never trusted because of where it came from or what
      // address it claims to send as. This credential decision itself is
      // reachable and tested; only the `?? ''`/`?? null` fallbacks below are
      // not (smtp-server's PLAIN and LOGIN mechanisms, lib/sasl.js, always
      // normalise `username`/`password` to a string, even an empty one,
      // before onAuth is called — undefined is not a value either mechanism
      // hands this callback, only the TypeScript type says so).
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
      /* v8 ignore start -- proven unreachable: MAIL/RCPT/DATA is a state
       * machine smtp-server enforces itself, and MAIL FROM already refuses
       * to proceed without session.user set (see onMailFrom above), so
       * onData never fires with it unset. Kept as a fail-closed guard
       * against that contract changing. */
      if (!session.user) {
        callback(new Error('Authentication required'));
        return;
      }
      /* v8 ignore stop */
      const submitterId = session.user;

      // Bounds worst-case retained memory as maxConcurrentDataPhases *
      // maxMessageBytes: a message over either cap is drained and discarded
      // (never retained) rather than refused outright, reusing the same
      // proven-safe path as the size cap below — the stream still has to be
      // consumed to reach 'end' and reply, whichever cap it tripped.
      const submitterInFlight = inFlightDataPerSubmitter.get(submitterId) ?? 0;
      const overConcurrencyCap =
        inFlightDataGlobal >= opts.maxConcurrentDataPhases ||
        submitterInFlight >= opts.maxConcurrentDataPhasesPerSubmitter;
      if (overConcurrencyCap) {
        log.warn('smtp_data_concurrency_refused', { submitter: submitterId });
      } else {
        inFlightDataGlobal += 1;
        inFlightDataPerSubmitter.set(submitterId, submitterInFlight + 1);
      }
      let slotReleased = false;
      const releaseConcurrencySlot = (): void => {
        if (slotReleased || overConcurrencyCap) {
          return;
        }
        slotReleased = true;
        inFlightDataGlobal -= 1;
        const count = inFlightDataPerSubmitter.get(submitterId) ?? 1;
        if (count <= 1) {
          inFlightDataPerSubmitter.delete(submitterId);
        } else {
          inFlightDataPerSubmitter.set(submitterId, count - 1);
        }
      };

      const chunks: Buffer[] = [];
      // `size` above only makes smtp-server COUNT bytes past the cap and
      // flip `stream.sizeExceeded` — it keeps emitting every byte regardless.
      // `_countDataBytes` (smtp-stream.js) runs before this handler sees each
      // chunk, so the flag is already correct for the chunk in hand: once it
      // flips, stop retaining bytes (release anything already buffered too)
      // while still consuming `data` events so the stream keeps draining and
      // can still reach `end` to reply 552. `retainedBytes` at the point the
      // flag flips is logged so retention can be asserted on directly,
      // rather than inferred from process-wide memory measurements.
      let overCap = overConcurrencyCap;
      let retainedBytes = 0;
      stream.on('data', (chunk: Buffer) => {
        if (overCap) {
          return;
        }
        if (stream.sizeExceeded) {
          overCap = true;
          log.warn('smtp_size_cap_exceeded', { submitter: submitterId, retainedBytes });
          chunks.length = 0;
          retainedBytes = 0;
          return;
        }
        retainedBytes += chunk.length;
        chunks.push(chunk);
      });
      stream.on('error', (err: Error) => {
        releaseConcurrencySlot();
        callback(err);
      });
      stream.on('end', () => {
        releaseConcurrencySlot();
        if (overConcurrencyCap) {
          const err = new Error('Too many concurrent messages') as Error & { responseCode: number };
          err.responseCode = 450;
          callback(err);
          return;
        }
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
            // This catch spans the `.then()` chain too, so it also reports a
            // synchronous `store.enqueueBatch` failure (e.g. a SQLite write
            // error), not only a `simpleParser` rejection — hence the name.
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
