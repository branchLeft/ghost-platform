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
import { containsHeaderInjectionChars } from './mailgunFields.js';
import { isSafeRecipientAddress } from './recipientSafety.js';
import type { DrainWake } from './drainWake.js';
import type { Logger } from './log.js';
import { resolveSenderDomain, senderBelongsToTenant } from './senderAuthorization.js';
import type { ShimStore } from './store.js';

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

export interface ConcurrencySlot {
  /**
   * Idempotent: safe to call any number of times, from any of the several
   * events that can end one unit of work (a stream ending normally, a
   * stream erroring, or the underlying connection closing without either
   * firing). Only the first call has any effect.
   */
  release(): void;
}

export interface ConcurrencyGuard {
  /** A slot if under both the global and per-key caps (which also increments them), or null if over either — nothing is incremented on a null return, and calling .release() on a null result would be a type error, not a silent no-op, by construction. */
  tryAcquire(key: string): ConcurrencySlot | null;
}

/**
 * Bounds concurrent work as a global count and a per-key count at once, with
 * idempotent release. Pure and standalone (no smtp-server dependency) so the
 * acquire/release bookkeeping — including "released more than once must
 * never double-decrement" — is directly testable without a real connection.
 */
export function createConcurrencyGuard(maxGlobal: number, maxPerKey: number): ConcurrencyGuard {
  let global = 0;
  const perKey = new Map<string, number>();
  return {
    tryAcquire(key) {
      const current = perKey.get(key) ?? 0;
      if (global >= maxGlobal || current >= maxPerKey) {
        return null;
      }
      global += 1;
      perKey.set(key, current + 1);
      let released = false;
      return {
        release(): void {
          if (released) {
            return;
          }
          released = true;
          global -= 1;
          const count = perKey.get(key) ?? 1;
          if (count <= 1) {
            perKey.delete(key);
          } else {
            perKey.set(key, count - 1);
          }
        },
      };
    },
  };
}

export interface UnauthenticatedPoolSlot {
  /** Idempotent, same contract as ConcurrencySlot.release above. */
  release(): void;
}

export type UnauthenticatedPoolAdmission =
  | { admitted: true; slot: UnauthenticatedPoolSlot }
  | {
      admitted: false;
      reason: 'max_unauthenticated_connections_per_source' | 'max_unauthenticated_connections';
    };

export interface UnauthenticatedPoolGuard {
  tryAcquire(remoteAddress: string): UnauthenticatedPoolAdmission;
}

/**
 * Counts only connections this guard admitted, never smtp-server's own
 * connections Set, which includes sockets still in the early-talker delay.
 * See smtpFrontDoor.md#createunauthenticatedpoolguard.
 */
export function createUnauthenticatedPoolGuard(
  maxGlobal: number,
  maxPerSource: number
): UnauthenticatedPoolGuard {
  let global = 0;
  const perSource = new Map<string, number>();
  return {
    tryAcquire(remoteAddress): UnauthenticatedPoolAdmission {
      const current = perSource.get(remoteAddress) ?? 0;
      if (current >= maxPerSource) {
        return { admitted: false, reason: 'max_unauthenticated_connections_per_source' };
      }
      if (global >= maxGlobal) {
        return { admitted: false, reason: 'max_unauthenticated_connections' };
      }
      global += 1;
      perSource.set(remoteAddress, current + 1);
      let released = false;
      return {
        admitted: true,
        slot: {
          release(): void {
            if (released) {
              return;
            }
            released = true;
            global -= 1;
            const count = perSource.get(remoteAddress) ?? 1;
            if (count <= 1) {
              perSource.delete(remoteAddress);
            } else {
              perSource.set(remoteAddress, count - 1);
            }
          },
        },
      };
    },
  };
}

export type UnauthenticatedAdmissionResult =
  | { admitted: true; slot: UnauthenticatedPoolSlot }
  | {
      admitted: false;
      reason:
        | 'max_unauthenticated_connections'
        | 'max_unauthenticated_connections_per_source_queue_full'
        | 'max_unauthenticated_connections_per_source_wait_timeout';
    };

export interface UnauthenticatedAdmissionQueue {
  /**
   * Calls `onResult` exactly once: immediately if a slot is free, or later
   * (still bounded) if this source is at its own cap but a slot for it
   * frees up before the wait bound. Returns `cancel()` so a caller whose
   * own connection has gone away while still queued (its socket closed
   * before being admitted or timed out) can withdraw without ever
   * receiving a result — otherwise a stale request would either occupy a
   * queue slot forever or eventually "admit" a connection that no longer
   * exists.
   */
  request(
    remoteAddress: string,
    onResult: (result: UnauthenticatedAdmissionResult) => void
  ): { cancel(): void };
}

/**
 * A burst past the per-source cap waits, bounded in count and time, instead
 * of being refused. The global cap is never queued behind.
 * See smtpFrontDoor.md#createunauthenticatedadmissionqueue.
 */
export function createUnauthenticatedAdmissionQueue(
  guard: UnauthenticatedPoolGuard,
  maxQueueDepthPerSource: number,
  maxWaitMs: number,
  scheduleTimeout: (fn: () => void, ms: number) => unknown = (fn, ms) => setTimeout(fn, ms).unref(),
  // `any`, not the ambient NodeJS.Timeout type: this file's plain,
  // non-type-aware eslint config has no @types/node globals to resolve it.
  cancelTimeout: (handle: unknown) => void = (handle) => clearTimeout(handle as any)
): UnauthenticatedAdmissionQueue {
  interface Waiter {
    onResult: (result: UnauthenticatedAdmissionResult) => void;
    timeoutHandle: unknown;
    cancelled: boolean;
  }
  const queues = new Map<string, Waiter[]>();

  function dropFromQueue(remoteAddress: string, waiter: Waiter): void {
    const queue = queues.get(remoteAddress);
    if (!queue) {
      return;
    }
    const idx = queue.indexOf(waiter);
    if (idx !== -1) {
      queue.splice(idx, 1);
    }
    if (queue.length === 0) {
      queues.delete(remoteAddress);
    }
  }

  // Wraps every admitted slot (whether admitted immediately or off the
  // queue) so its own release also wakes the next waiter for the SAME
  // source, if any — a slot freeing for one source can only ever help a
  // connection waiting on that same source's own cap, never a different
  // one's.
  function wrapSlot(remoteAddress: string, slot: UnauthenticatedPoolSlot): UnauthenticatedPoolSlot {
    return {
      release(): void {
        slot.release();
        const queue = queues.get(remoteAddress);
        if (!queue || queue.length === 0) {
          return;
        }
        const waiter = queue.shift()!;
        if (queue.length === 0) {
          queues.delete(remoteAddress);
        }
        cancelTimeout(waiter.timeoutHandle);
        const admission = guard.tryAcquire(remoteAddress);
        if (admission.admitted) {
          waiter.onResult({ admitted: true, slot: wrapSlot(remoteAddress, admission.slot) });
        } else {
          // The slot that just freed for this source was claimed elsewhere
          // between the release above and this re-attempt (single-threaded
          // JS makes that a same-tick reentrancy, not a real race, but stay
          // defensive) — or the global cap has since filled. Either way,
          // this waiter goes back to the FRONT of its own queue rather than
          // being refused outright, so a transient loss doesn't cost it its
          // place; its own timeout is still the only thing that can refuse
          // it now.
          queue.unshift(waiter);
          queues.set(remoteAddress, queue);
        }
      },
    };
  }

  return {
    request(remoteAddress, onResult) {
      // Nothing to withdraw once a result has already been delivered
      // synchronously — the one shared no-op below is handed back on
      // every immediate path so callers can always call `.cancel()`
      // unconditionally without checking which path they got.
      const noopCancel = { cancel(): void {} };

      const admission = guard.tryAcquire(remoteAddress);
      if (admission.admitted) {
        onResult({ admitted: true, slot: wrapSlot(remoteAddress, admission.slot) });
        return noopCancel;
      }
      if (admission.reason === 'max_unauthenticated_connections') {
        // The global backstop is never queued behind — see this function's
        // own doc comment.
        onResult({ admitted: false, reason: 'max_unauthenticated_connections' });
        return noopCancel;
      }

      const queue = queues.get(remoteAddress) ?? [];
      if (queue.length >= maxQueueDepthPerSource) {
        onResult({
          admitted: false,
          reason: 'max_unauthenticated_connections_per_source_queue_full',
        });
        return noopCancel;
      }

      const waiter: Waiter = { onResult, timeoutHandle: undefined, cancelled: false };
      waiter.timeoutHandle = scheduleTimeout(() => {
        if (waiter.cancelled) {
          return;
        }
        dropFromQueue(remoteAddress, waiter);
        onResult({
          admitted: false,
          reason: 'max_unauthenticated_connections_per_source_wait_timeout',
        });
      }, maxWaitMs);
      queue.push(waiter);
      queues.set(remoteAddress, queue);

      return {
        cancel(): void {
          waiter.cancelled = true;
          cancelTimeout(waiter.timeoutHandle);
          dropFromQueue(remoteAddress, waiter);
        },
      };
    },
  };
}

export interface SmtpFrontDoorOptions {
  store: ShimStore;
  wake: DrainWake;
  log: Logger;
  maxMessageBytes: number;
  /** Cap on RCPT commands accepted for a single message — the (N+1)th and later get a temporary refusal (452), every earlier one stays accepted. Counted per-message (smtp-server replaces the whole envelope on RSET/EHLO/HELO and after each completed DATA), never cumulative across a connection's lifetime. */
  maxRecipientsPerMessage: number;
  /** How many connections from one source address are admitted into the unauthenticated pool without waiting. Checked before the global pool, so one source (e.g. a compromised, credential-less container) can never occupy more than its own instantly-admitted share — churning connections defeats a purely time-based deadline, and a purely global count-based cap doesn't need many source addresses to exhaust. A legitimate source bursting past this does not get refused outright: see maxUnauthenticatedPerSourceWaitQueueDepth/Ms below. */
  maxUnauthenticatedConnectionsPerSource: number;
  /** Cap on connections that have not yet authenticated, across every source — the backstop behind the per-source cap above. Never gates an authenticated submitter — this pool and the authenticated one are counted separately. Never queued behind: it bounds many distinct hostile sources at once, a threat a per-source wait does nothing about. */
  maxUnauthenticatedConnections: number;
  /** How many connections from one source may be waiting at once for a per-source slot to free, once that source is past maxUnauthenticatedConnectionsPerSource. Bounds the queue's own memory; a source past this is refused outright rather than queued further. */
  maxUnauthenticatedPerSourceWaitQueueDepth: number;
  /** How long a queued connection waits for its own source's slot to free before being refused. Comfortably under nodemailer's own greeting timeout, so a legitimate burst waits rather than losing the message outright. */
  maxUnauthenticatedPerSourceWaitMs: number;
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
    /** Set once this connection is admitted into the unauthenticated pool (onConnect); called from onAuth on success so the slot frees the instant it stops being needed, without waiting for the connection to eventually close. Idempotent — also called from the connection's own 'close', whichever fires first. */
    releaseUnauthSlot?: () => void;
    /**
     * The authenticated tenant's registered sending domain (store.ts's
     * `Tenant.senderDomain`), set once by onAuth and never re-derived from
     * a message — never the same as `user` (the credential key) for a
     * tenant whose two values differ, e.g. tenant zero. `null` means "no
     * sender domain registered": onMailFrom refuses every message for such
     * a tenant before RCPT/DATA can run, so a later handler seeing this
     * still null on a message that reached onData would be a state-machine
     * violation, not a normal case.
     */
    tenantSenderDomain?: string | null;
  }
}

/**
 * smtp-server's connection objects, narrowed to what the guards need;
 * _socket is the only place a mid-transfer disconnect is observable.
 * See smtpFrontDoor.md#rawsmtpconnection.
 */
interface RawSmtpConnection {
  session?: { user?: string; remoteAddress?: string };
  close(): void;
  _socket?: {
    once(event: 'close', listener: () => void): void;
    removeListener(event: 'close', listener: () => void): void;
  };
}

/**
 * The listener Ghost's transactional sender connects to: a durable local
 * write answered at once, sharing the queue with the HTTP route.
 * See smtpFrontDoor.md#createsmtpfrontdoor.
 */
export function createSmtpFrontDoor(opts: SmtpFrontDoorOptions): SmtpFrontDoor {
  const { store, wake, log } = opts;
  const now = opts.now ?? Date.now;
  const allowList = buildSourceAllowList(opts.allowedSourceCidrs ?? DEFAULT_ALLOWED_SOURCE_CIDRS);
  const limiter = createSubmitterLimiter(opts.submitterMessagesPerMinute, 60_000, now);

  // What actually costs memory is a DATA phase in flight, not a connection —
  // an authenticated, idle connection retains nothing. Counted globally and
  // per submitter so worst-case retained memory stays
  // maxConcurrentDataPhases * maxMessageBytes, and no single credential can
  // claim the whole budget.
  const dataPhaseGuard = createConcurrencyGuard(
    opts.maxConcurrentDataPhases,
    opts.maxConcurrentDataPhasesPerSubmitter
  );

  // See createUnauthenticatedPoolGuard's own comment for why this counts
  // admissions itself rather than filtering server.connections, and
  // createUnauthenticatedAdmissionQueue's for why a per-source burst waits
  // rather than being refused outright.
  const unauthPoolGuard = createUnauthenticatedPoolGuard(
    opts.maxUnauthenticatedConnections,
    opts.maxUnauthenticatedConnectionsPerSource
  );
  const unauthAdmissionQueue = createUnauthenticatedAdmissionQueue(
    unauthPoolGuard,
    opts.maxUnauthenticatedPerSourceWaitQueueDepth,
    opts.maxUnauthenticatedPerSourceWaitMs
  );

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

      // Per-source is checked before global: one churning source never takes
      // more than its share; the global cap is only the backstop.
      // See smtpFrontDoor.md#per-source-before-global.
      const remoteAddress = session.remoteAddress ?? '';
      const connections = server.connections as unknown as Set<RawSmtpConnection>;
      let rawConnection: RawSmtpConnection | undefined;
      for (const c of connections) {
        if (c.session === session) {
          rawConnection = c;
          break;
        }
      }

      // If this connection's own socket goes away while it is still
      // waiting for a slot — the client gave up, or simply dropped —
      // withdraw its queued request so it never occupies a queue slot
      // pointlessly and is never "admitted" after it can no longer be
      // answered. Removed the instant a result arrives either way, so it
      // never lingers alongside the DATA-phase close listener a later
      // message on this same connection attaches.
      const onEarlyClose = (): void => pending.cancel();
      rawConnection?._socket?.once('close', onEarlyClose);
      // unauthAdmissionQueue.request() calls onResult synchronously, before
      // returning, on every immediate path (admitted, or refused outright
      // by the global cap or a full per-source wait queue) — the only path
      // that defers it is genuinely entering that per-source wait queue.
      // settledSynchronously therefore tells the two apart exactly, with no
      // guess at how long "reaching the queue" takes — a caller (a test
      // proving the cancel-on-early-close path, an operator's own log
      // search) waiting on smtp_connection_queued below has a real
      // readiness signal instead of a sleep.
      let settledSynchronously = false;
      const pending = unauthAdmissionQueue.request(remoteAddress, (result) => {
        settledSynchronously = true;
        rawConnection?._socket?.removeListener('close', onEarlyClose);

        if (!result.admitted) {
          log.warn('smtp_connection_refused', {
            remoteAddress: session.remoteAddress,
            reason: result.reason,
          });
          const err = new Error('Too many connections') as Error & { responseCode: number };
          err.responseCode = 421;
          callback(err);
          return;
        }

        // Released the instant this connection leaves the unauthenticated
        // pool: either it authenticates (onAuth calls this same function on
        // success, below) or its underlying socket closes first for any
        // reason — a normal disconnect, the deadline eviction just below,
        // or a mid-handshake network drop. `.release()` is idempotent, so
        // whichever of the two fires first is the one that actually frees
        // the slot; the other is a no-op.
        session.releaseUnauthSlot = result.slot.release;
        rawConnection?._socket?.once('close', result.slot.release);

        callback();

        // A connection that never authenticates is closed outright once its
        // deadline passes, timed from ADMISSION (not from when it first
        // connected — time already spent waiting for a slot isn't time it
        // had to authenticate in), regardless of how it keeps itself alive
        // in the meantime (e.g. a NOOP every few seconds, which resets
        // smtp-server's own idle timeout but never authenticates) —
        // otherwise the unauthenticated pool above still fills, just more
        // slowly. A connection that has authenticated by the time this
        // fires is exempt: `session.user` is set on this same object by
        // onAuth, so the check below is a no-op for it.
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
      });
      if (!settledSynchronously) {
        log.info('smtp_connection_queued', { remoteAddress: session.remoteAddress });
      }
    },

    async onAuth(
      auth: SMTPServerAuthentication,
      session: SMTPServerSession,
      callback: (err: Error | null | undefined, response?: SMTPServerAuthenticationResponse) => void
    ): Promise<void> {
      // The username is the submitter's identity. verifyTenant is awaited so a
      // store or crypto error reaches smtp-server as a credential failure.
      // See smtpFrontDoor.md#authentication.
      let tenant;
      try {
        tenant = await store.verifyTenant(auth.username ?? '', auth.password ?? '');
      } catch {
        tenant = null;
      }
      if (!tenant) {
        log.warn('smtp_auth_failed', { username: auth.username ?? null });
        callback(new Error('Invalid credentials'));
        return;
      }
      // This connection is leaving the unauthenticated pool — free its slot
      // now rather than waiting for it to eventually close, so a submitter
      // that opens many short-lived connections in a row (one per message)
      // never accumulates against its own per-source cap.
      session.releaseUnauthSlot?.();
      // Cached on the session, not re-looked-up per message: it can only
      // change by an operator rotating this credential, which ends the
      // connection anyway (a fresh AUTH is required either way).
      session.tenantSenderDomain = tenant.senderDomain;
      callback(null, { user: tenant.domain });
    },

    onMailFrom(
      address: SMTPServerAddress,
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
      // The fail-closed gate: a tenant with no registered sender domain
      // (every row that predates this field) is refused rather than
      // silently checked against its credential key. This is the only
      // place this runs for a given message — onData's own header checks
      // below trust session.tenantSenderDomain because a message can only
      // reach onData after MAIL FROM has already passed this gate for it.
      const senderDomain = resolveSenderDomain(
        { domain: submitterId, senderDomain: session.tenantSenderDomain ?? null },
        log,
        'smtp'
      );
      if (!senderDomain) {
        const err = new Error(
          '4.3.5 System not accepting network messages: sender domain not registered for this account'
        ) as Error & { responseCode: number };
        err.responseCode = 450;
        callback(err);
        return;
      }
      // The envelope half of the sender-binding control: mustMatchSender at
      // mx1 can only bind the envelope to the shim's own relaying login
      // once mail leaves this process, never to which tenant credential
      // submitted it — this is the only hop that still knows that. A
      // credential may only submit as its own registered sender domain.
      if (!senderBelongsToTenant(address.address, senderDomain)) {
        log.warn('smtp_mail_from_domain_mismatch', {
          submitter: submitterId,
          remoteAddress: session.remoteAddress,
        });
        const err = new Error(
          '5.7.1 Sender address rejected: domain not authorised for this account'
        ) as Error & { responseCode: number };
        err.responseCode = 553;
        callback(err);
        return;
      }
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
      session: SMTPServerSession,
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
      // onRcptTo runs before the address is pushed, so this is the count already
      // accepted for this message; the cap refuses only later recipients.
      // See smtpFrontDoor.md#recipient-cap.
      if (session.envelope.rcptTo.length >= opts.maxRecipientsPerMessage) {
        log.warn('smtp_too_many_recipients', {
          submitter: session.user ?? null,
          limit: opts.maxRecipientsPerMessage,
        });
        // smtp-server's handler_RCPT sends err.responseCode/err.message
        // verbatim with no enhanced-status-code context of its own for an
        // onRcptTo-supplied error (unlike its internal syntax-error paths),
        // so the enhanced code is written into the message text itself to
        // land on the wire as "452 4.5.3 Too many recipients".
        const err = new Error('4.5.3 Too many recipients') as Error & { responseCode: number };
        err.responseCode = 452;
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
      const slot = dataPhaseGuard.tryAcquire(submitterId);
      const overConcurrencyCap = slot === null;
      if (overConcurrencyCap) {
        log.warn('smtp_data_concurrency_refused', { submitter: submitterId });
      }
      const releaseConcurrencySlot = (): void => slot?.release();

      // Release the slot on socket close too: smtp-server detaches the data
      // stream without emitting when a connection drops mid-DATA.
      // See smtpFrontDoor.md#releasing-the-data-slot-on-close.
      const connections = server.connections as unknown as Set<RawSmtpConnection>;
      let rawConnection: RawSmtpConnection | undefined;
      for (const c of connections) {
        if (c.session === session) {
          rawConnection = c;
          break;
        }
      }
      rawConnection?._socket?.once('close', releaseConcurrencySlot);
      const detachCloseRelease = (): void => {
        rawConnection?._socket?.removeListener('close', releaseConcurrencySlot);
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
      /* v8 ignore start -- unreachable today: smtp-server never emits on the data
       * stream. Kept fail-closed. See smtpFrontDoor.md#the-data-stream-never-errors. */
      stream.on('error', (err: Error) => {
        releaseConcurrencySlot();
        detachCloseRelease();
        callback(err);
      });
      /* v8 ignore stop */
      stream.on('end', () => {
        releaseConcurrencySlot();
        detachCloseRelease();
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
            // The header half of the sender binding, enforced only when a From is
            // present; refused before enqueue, never a 250 then a drop.
            // See smtpFrontDoor.md#header-from-and-sender.
            const senderDomain = session.tenantSenderDomain;
            /* v8 ignore start -- proven unreachable: onMailFrom's own
             * resolveSenderDomain gate refuses every message for a tenant
             * with no sender domain before DATA can run, so onData never
             * sees this unset. Kept as a fail-closed guard against that
             * contract changing. */
            if (!senderDomain) {
              log.error('sender_domain_not_registered', { domain: submitterId, route: 'smtp' });
              const safeErr = new Error('Temporary failure, please try again later') as Error & {
                responseCode: number;
              };
              safeErr.responseCode = 450;
              callback(safeErr);
              return;
            }
            /* v8 ignore stop */
            const headerFrom = parsed.from?.text;
            if (headerFrom !== undefined && !senderBelongsToTenant(headerFrom, senderDomain)) {
              log.warn('smtp_header_from_domain_mismatch', { submitter: submitterId });
              const err = new Error(
                '5.7.1 Sender address rejected: domain not authorised for this account'
              ) as Error & { responseCode: number };
              err.responseCode = 550;
              callback(err);
              return;
            }

            const replyTo =
              parsed.replyTo && !Array.isArray(parsed.replyTo) ? parsed.replyTo.text : undefined;
            const subject = parsed.subject ?? '';
            const from =
              (parsed.from && parsed.from.text) ||
              /* v8 ignore next -- session.envelope.mailFrom is only ever
               * unset before MAIL FROM has been accepted, and MAIL FROM is
               * required (smtp-server itself refuses RCPT/DATA without it)
               * before onData can run at all; the ternary's false arm
               * defends a state the protocol never lets this handler see. */
              (session.envelope.mailFrom ? session.envelope.mailFrom.address : '');

            // Refuses CR/LF/NUL in decoded headers, as the HTTP route does, so an
            // encoded-word decoding to a CRLF cannot inject a header.
            // See smtpFrontDoor.md#refuse-never-strip.
            for (const [label, value] of [
              ['From', from],
              ['Subject', subject],
              ...(replyTo !== undefined ? ([['Reply-To', replyTo]] as const) : []),
            ] as const) {
              if (containsHeaderInjectionChars(value)) {
                log.warn('smtp_header_injection_refused', { submitter: submitterId, field: label });
                const err = new Error(
                  `5.6.0 Message content rejected: ${label} contains a disallowed control character`
                ) as Error & { responseCode: number };
                err.responseCode = 550;
                callback(err);
                return;
              }
            }
            // A submitted Sender is never copied into the stored headers, so there is
            // nothing to validate, and no second parser difference to exploit.
            // See smtpFrontDoor.md#sender-is-stripped-not-validated.

            const headers: Record<string, string> = {};
            if (replyTo) {
              headers['Reply-To'] = replyTo;
            }

            const batchId = `<${now()}.${randomUUID()}@${submitterId}>`;

            // Durable write, synchronous, no network hop — this is the ack
            // Ghost's own request is waiting on (LLD-6 M1). wake.notify()
            // just below is documented fire-and-forget; nothing after this
            // point is awaited before callback() responds.
            store.enqueueBatch({
              batchId,
              domain: submitterId,
              emailId: null,
              payload: {
                from,
                subject,
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
            wake.notify();

            callback(null, 'Queued. Thank you.');
          })
          .catch((err: unknown) => {
            // This catch spans the `.then()` chain too, so it also reports a
            // synchronous `store.enqueueBatch` failure (e.g. a SQLite write
            // error), not only a `simpleParser` rejection — hence the name.
            // The real error is logged (server-side only) but never handed
            // to `callback`: smtp-server writes an Error's own `.message`
            // straight onto the wire, and a raw SQLite constraint/IO message
            // is internal detail no submitter should see. A temporary 4xx
            // (not the permanent domain-mismatch 550s above) since this is
            // this process's own failure, not a policy refusal — retrying
            // later is the right client behaviour.
            log.error('smtp_message_processing_failed', {
              submitter: submitterId,
              error: err instanceof Error ? err.message : String(err),
            });
            const safeErr = new Error('Temporary failure, please try again later') as Error & {
              responseCode: number;
            };
            safeErr.responseCode = 450;
            callback(safeErr);
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
