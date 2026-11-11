'use strict';

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const {
  PROTOCOL_VERSION,
  OP_ASK,
  MAX_LINE_BYTES,
  isPdqKey,
  encodeReply,
  encodeError,
  readLine,
  parseJsonObject,
} = require('../src/verdict-socket-frame');

// The local verdict socket the scanning decorator asks on. A unix socket, so
// it holds no address a remote machine could reach. One ask per connection:
// the reply carries the key it answers, copied from the queue's own record,
// and a connection that closes first is forgotten, so a late verdict can never
// be handed to a later ask. Behaviour: verdict-host.md.

const DEFAULT_ASK_WAIT_MS = 1000;
const DEFAULT_READ_TIMEOUT_MS = 2000;
const DEFAULT_MAX_CONNECTIONS = 64;
const DEFAULT_SOCKET_MODE = 0o600;

function isEnoent(err) {
  return err?.code === 'ENOENT';
}

// Clears the path a previous run of this service left behind, and nothing else.
function clearStaleSocket(file) {
  let isSocket;
  try {
    isSocket = fs.lstatSync(file).isSocket();
  } catch (err) {
    if (isEnoent(err)) return;
    throw err;
  }
  if (!isSocket) throw new Error(`${file} exists and is not a socket; refusing to remove it`);
  fs.unlinkSync(file);
}

function startLocalSocket({
  queue,
  socketPath,
  socketMode = DEFAULT_SOCKET_MODE,
  askWaitMs = DEFAULT_ASK_WAIT_MS,
  readTimeoutMs = DEFAULT_READ_TIMEOUT_MS,
  maxConnections = DEFAULT_MAX_CONNECTIONS,
  onAsk = () => {},
}) {
  if (typeof socketPath !== 'string' || !path.isAbsolute(socketPath)) {
    throw new Error('the local socket path must be absolute');
  }
  // hash -> set of functions to call with the verdict that settles it.
  const waiters = new Map();

  queue.on('verdict', ({ hash, verdict }) => {
    const waiting = waiters.get(hash);
    if (waiting === undefined) return;
    waiters.delete(hash);
    for (const deliver of waiting) deliver(hash, verdict);
  });

  const reply = (socket, text) => {
    if (!socket.destroyed) socket.end(text);
  };

  async function onConnection(socket) {
    socket.on('error', () => {});
    let line;
    try {
      line = await readLine(socket, { maxBytes: MAX_LINE_BYTES, timeoutMs: readTimeoutMs });
    } catch {
      socket.destroy();
      return;
    }
    const ask = parseJsonObject(line);
    if (
      ask === null ||
      ask.v !== PROTOCOL_VERSION ||
      ask.op !== OP_ASK ||
      !isPdqKey(ask.key) ||
      Object.keys(ask).length !== 3
    ) {
      onAsk('bad');
      reply(socket, encodeError('bad-ask'));
      return;
    }

    const result = queue.ask(ask.key);
    if (result.status === 'verdict') {
      onAsk('verdict');
      reply(socket, encodeReply({ key: ask.key, ...result.verdict }));
      return;
    }
    if (result.status !== 'queued') {
      onAsk(result.status);
      reply(socket, encodeError(result.status === 'full' ? 'busy' : 'unavailable'));
      return;
    }

    onAsk('queued');
    let timer = null;
    const forget = () => {
      if (timer !== null) clearTimeout(timer);
      const waiting = waiters.get(ask.key);
      if (waiting !== undefined) {
        waiting.delete(deliver);
        if (waiting.size === 0) waiters.delete(ask.key);
      }
    };
    const deliver = (hash, verdict) => {
      forget();
      reply(socket, encodeReply({ key: hash, ...verdict }));
    };
    if (!waiters.has(ask.key)) waiters.set(ask.key, new Set());
    waiters.get(ask.key).add(deliver);
    socket.once('close', forget);
    // No verdict inside the wait is an answer of its own: nothing yet. The hash
    // stays queued, and the decorator holds the upload and asks again later.
    timer = setTimeout(() => {
      forget();
      reply(socket, encodeReply({ key: ask.key, classification: 'unavailable' }));
    }, askWaitMs);
  }

  const open = new Set();
  const server = net.createServer((socket) => {
    open.add(socket);
    socket.once('close', () => open.delete(socket));
    return onConnection(socket);
  });
  server.maxConnections = maxConnections;

  return new Promise((resolve, reject) => {
    clearStaleSocket(socketPath);
    // 0600 from the instant it exists; the configured mode applies after.
    // listen() binds a unix path in the same tick, so the umask is restored
    // before any other code runs.
    const previousUmask = process.umask(0o177);
    server.once('error', reject);
    try {
      server.listen(socketPath, () => {
        server.off('error', reject);
        fs.chmodSync(socketPath, socketMode);
        resolve({
          server,
          close: () =>
            new Promise((done) => {
              server.close(() => done());
              for (const socket of open) socket.destroy();
            }),
        });
      });
    } finally {
      process.umask(previousUmask);
    }
  });
}

module.exports = {
  startLocalSocket,
  clearStaleSocket,
  DEFAULT_ASK_WAIT_MS,
  DEFAULT_SOCKET_MODE,
};
