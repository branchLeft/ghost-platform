// Loaded via `node --import` into a CHILD process (server.ts's own
// startup, not just createApp()) so the patch is in place before ANY of
// the target module's top-level code runs. Reports every call to stdout
// as a single-line JSON record prefixed with a marker the parent test
// process greps for. The parent's own HTTP requests against this child
// never touch this file at all (they run in a different process), so
// unlike the in-process test, there is no baseline traffic to filter
// here: a completely silent child is the whole of what "no outbound
// connection" means for this process's entire lifecycle.
//
// Four independent primitives, patched separately, because none of them
// routes through the others — verified empirically that each one bypasses
// a guard that only patches net.Socket#connect:
//   - net.Socket#connect — every TCP/TLS client (nodemailer's SMTP
//     transport included: tls.connect constructs a TLSSocket, which
//     extends net.Socket and calls this same method).
//   - dns.lookup / dns.resolve* (callback and promise forms) — hostname
//     resolution alone is a network round trip, and by itself is a
//     DNS-exfiltration channel even when nothing after it ever calls
//     connect().
//   - dgram — UDP has its own send path entirely outside net.Socket.
//   - child_process — spawn/exec/execFile can shell out to `curl` or
//     anything else and make a network call this process's own patches
//     can never see, in a separate process.
//
// Patching a property on the object a default/namespace import gives you
// (`import net from 'node:net'; net.X = ...`) does not, by itself, reach
// a caller that used a named import instead (`import { X } from
// 'node:net'`) — Node synthesizes a built-in module's named ESM exports
// once, from a snapshot, and a plain property reassignment afterward
// never reaches that snapshot. `module.syncBuiltinESMExports()` (called
// once, after every patch below) re-syncs that snapshot from the current
// property values, closing the gap for every built-in this file patches
// at once — verified empirically (see the sabotage tests this guard
// backs) rather than assumed from documentation.
import net from 'node:net';
import dns from 'node:dns';
import dgram from 'node:dgram';
import child_process from 'node:child_process';
import module from 'node:module';

const MARKER = 'CONNECT_ATTEMPT ';

function report(kind, detail) {
  try {
    process.stdout.write(MARKER + JSON.stringify({ kind, ...detail }) + '\n');
  } catch {
    process.stdout.write(MARKER + JSON.stringify({ kind }) + '\n');
  }
}

function extractConnectTarget(args) {
  let first = args[0];
  // Node's own Socket#connect normalizes its overloaded arguments into a
  // single [options, callback] array tagged with an internal symbol, and a
  // caller already holding one of those passes it straight through as
  // args[0] — verified empirically rather than assumed from documentation.
  if (Array.isArray(first)) {
    first = first[0];
  }
  if (first && typeof first === 'object') {
    const opts = first;
    return { host: opts.host ?? (opts.path ? `unix:${opts.path}` : undefined), port: opts.port };
  }
  if (typeof first === 'number') {
    return { host: typeof args[1] === 'string' ? args[1] : undefined, port: first };
  }
  return { host: typeof first === 'string' ? first : undefined, port: undefined };
}

const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function patchedConnect(...args) {
  report('net.connect', extractConnectTarget(args));
  return originalConnect.apply(this, args);
};

const DNS_METHODS = [
  'lookup',
  'resolve',
  'resolve4',
  'resolve6',
  'resolveCname',
  'resolveMx',
  'resolveTxt',
];

for (const method of DNS_METHODS) {
  const original = dns[method]?.bind(dns);
  if (!original) continue;
  dns[method] = function patchedDns(hostname, ...rest) {
    // `dns.lookup()` on a literal IP resolves synchronously, in-process,
    // with no libuv/network round trip at all (verified empirically: it
    // returns before the next tick, where a real resolution is always
    // async) — Node's own net.Server#listen() calls it internally for
    // EVERY bind, including a bind to a literal address like '0.0.0.0' or
    // '127.0.0.1'. That is what the SMTP front door's own listen() does on
    // startup, not an outbound resolution of anything — flagging it would
    // make "no outbound connection" fail on every server that binds to an
    // address, including this one legitimately listening for inbound mail.
    // Only `lookup()` ever legitimately receives a literal IP this way;
    // `resolve*()` (RR-type record queries) never does, so they stay
    // reported unconditionally.
    if (method === 'lookup' && net.isIP(hostname)) {
      return original(hostname, ...rest);
    }
    report('dns.' + method, { hostname });
    return original(hostname, ...rest);
  };
}

// The promise-returning API (`dns.promises.*`, and `node:dns/promises`'s
// own default/named exports — the same underlying object, confirmed
// empirically) is a separate object from the callback-style methods
// above and needs its own patch.
for (const method of DNS_METHODS) {
  const original = dns.promises[method]?.bind(dns.promises);
  if (!original) continue;
  dns.promises[method] = function patchedDnsPromise(hostname, ...rest) {
    // Same literal-IP exemption as the callback form above, for the same
    // reason: a bind, not a resolution with any network access.
    if (method === 'lookup' && net.isIP(hostname)) {
      return original(hostname, ...rest);
    }
    report('dns.promises.' + method, { hostname });
    return original(hostname, ...rest);
  };
}

const originalDgramSend = dgram.Socket.prototype.send;
dgram.Socket.prototype.send = function patchedSend(...args) {
  // dgram#send is also heavily overloaded (msg, [offset, length,] port,
  // address, [callback]) — the last two string/number-shaped args before
  // any trailing function are the ones worth reporting; anything short of
  // that still gets flagged, just without a resolved target.
  const withoutCallback = typeof args[args.length - 1] === 'function' ? args.slice(0, -1) : args;
  const address =
    typeof withoutCallback[withoutCallback.length - 1] === 'string'
      ? withoutCallback[withoutCallback.length - 1]
      : undefined;
  const port =
    typeof withoutCallback[withoutCallback.length - 2] === 'number'
      ? withoutCallback[withoutCallback.length - 2]
      : undefined;
  report('dgram.send', { host: address, port });
  return originalDgramSend.apply(this, args);
};

for (const method of ['spawn', 'exec', 'execFile', 'fork']) {
  const original = child_process[method];
  child_process[method] = function patchedChildProcess(command, ...rest) {
    report('child_process.' + method, { command: String(command) });
    return original.call(child_process, command, ...rest);
  };
}

// Re-syncs every built-in module's synthesized ESM named exports from the
// property values patched above, so a caller using
// `import { spawn } from 'node:child_process'` or
// `import { lookup } from 'node:dns'` (this codebase's own house style —
// e.g. `import { randomUUID } from 'node:crypto'` elsewhere) is covered
// exactly the same as a default-import or CJS require() caller. Must run
// after every patch above, not interleaved with them: it snapshots the
// CURRENT property values at the point it's called.
module.syncBuiltinESMExports();
