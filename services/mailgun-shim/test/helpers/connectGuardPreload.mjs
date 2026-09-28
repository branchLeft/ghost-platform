// Loaded with node --import into a child process; reports every outbound
// primitive (net, dns, dgram, child_process) on stdout.
// See connectGuardPreload.md#the-preload.
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
    // lookup() of a literal IP is in-process, and every listen() makes one,
    // so it is not reported; resolve*() always is.
    // See connectGuardPreload.md#a-lookup-of-a-literal-ip.
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
