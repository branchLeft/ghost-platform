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
// routes through the others (review cycle 2, non-blocking finding 3 —
// verified empirically that each one bypasses a guard that only patches
// net.Socket#connect):
//   - net.Socket#connect — every TCP/TLS client (nodemailer's SMTP
//     transport included: tls.connect constructs a TLSSocket, which
//     extends net.Socket and calls this same method).
//   - dns.lookup / dns.resolve* — hostname resolution alone is a
//     network round trip, and by itself is a DNS-exfiltration channel
//     even when nothing after it ever calls connect().
//   - dgram — UDP has its own send path entirely outside net.Socket.
//   - child_process — spawn/exec/execFile can shell out to `curl` or
//     anything else and make a network call this process's own patches
//     can never see, in a separate process.
import net from 'node:net';
import dns from 'node:dns';
import dgram from 'node:dgram';
import child_process from 'node:child_process';

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

for (const method of [
  'lookup',
  'resolve',
  'resolve4',
  'resolve6',
  'resolveCname',
  'resolveMx',
  'resolveTxt',
]) {
  const original = dns[method]?.bind(dns);
  if (!original) continue;
  dns[method] = function patchedDns(hostname, ...rest) {
    report('dns.' + method, { hostname });
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

// Verified limit, not assumed: this catches `import cp from
// 'node:child_process'; cp.spawn(...)` and CJS `require('node:child_process')
// .spawn(...)` (both read the CURRENT property value at call time), but NOT
// `import { spawn } from 'node:child_process'; spawn(...)` — Node's ESM
// named exports for built-in modules are synthesized once during its own
// internal bootstrap, before this preload (or anything else) runs, so a
// later reassignment here never reaches a caller that imported the name
// directly. No reflective way around that was found that didn't mean
// patching before Node's own module system finishes initializing. Real
// gap, documented rather than hidden — src/ has no child_process usage at
// all today, so this only matters if code reintroducing one happens to
// use the named-import form.
for (const method of ['spawn', 'exec', 'execFile', 'fork']) {
  const original = child_process[method];
  child_process[method] = function patchedChildProcess(command, ...rest) {
    report('child_process.' + method, { command: String(command) });
    return original.call(child_process, command, ...rest);
  };
}
