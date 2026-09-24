// Loaded via `node --import` into a CHILD process (server.ts's own
// startup, not just createApp()) so the patch is in place before ANY of
// the target module's top-level code runs. Patches the same primitive
// test/noOutboundConnection.test.ts patches in-process (net.Socket#connect
// — what every TCP/TLS client in Node, nodemailer's SMTP transport
// included, bottoms out on), and reports every call over stdout as a
// single-line JSON record prefixed with a marker the parent test process
// greps for. The parent's own HTTP requests against this child never touch
// this file at all (they run in a different process), so unlike the
// in-process test, there is no baseline traffic to filter here: a
// completely silent child is the whole of what "no outbound connection"
// means for this process's entire lifecycle.
import net from 'node:net';

const MARKER = 'CONNECT_ATTEMPT ';

function extractTarget(args) {
  let first = args[0];
  // Node's own Socket#connect normalizes its overloaded arguments into a
  // single [options, callback] array tagged with an internal symbol, and a
  // caller already holding one of those passes it straight through as
  // args[0] — verified empirically (see noOutboundConnection.test.ts's own
  // comment on this) rather than assumed from documentation.
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
  try {
    process.stdout.write(MARKER + JSON.stringify(extractTarget(args)) + '\n');
  } catch {
    process.stdout.write(MARKER + '{}\n');
  }
  return originalConnect.apply(this, args);
};
