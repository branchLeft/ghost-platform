'use strict';

const net = require('node:net');
const path = require('node:path');
const {
  PROTOCOL_VERSION,
  MAX_LINE_BYTES,
  encodeAsk,
  readLine,
  parseJsonObject,
} = require('./verdict-socket-frame');

// The real transport for ProductionVerdictClient: it talks to the host end
// over a local unix socket and nowhere else. The address is a path, so it
// cannot name a remote machine. One connection carries one ask, and the
// reply is the host end's own line with its own `key`, passed on unchanged:
// nothing here stamps the asked key onto an answer. See verdict-socket.md.

const DEFAULT_REPLY_TIMEOUT_MS = 2000;

function createSocketVerdictTransport({
  socketPath,
  replyTimeoutMs = DEFAULT_REPLY_TIMEOUT_MS,
  connectSocket = (file) => net.createConnection({ path: file }),
} = {}) {
  if (typeof socketPath !== 'string' || !path.isAbsolute(socketPath)) {
    throw new Error('createSocketVerdictTransport requires an absolute socketPath');
  }
  if (
    typeof replyTimeoutMs !== 'number' ||
    !Number.isFinite(replyTimeoutMs) ||
    replyTimeoutMs <= 0
  ) {
    throw new Error('replyTimeoutMs must be a positive number of milliseconds');
  }

  return {
    connect({ signal } = {}) {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error('connect aborted'));
          return;
        }
        const socket = connectSocket(socketPath);
        const onAbort = () => {
          socket.destroy();
          reject(new Error('connect aborted'));
        };
        const settled = () => {
          socket.off('error', onConnectError);
          signal?.removeEventListener('abort', onAbort);
        };
        const onConnectError = (err) => {
          settled();
          socket.destroy();
          reject(err);
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        socket.once('error', onConnectError);
        socket.once('connect', () => {
          settled();
          resolve(connectionOver(socket, { replyTimeoutMs }));
        });
      });
    },
  };
}

function connectionOver(socket, { replyTimeoutMs }) {
  let asked = false;
  // An error after connect is reported by the pending read, not left unhandled.
  socket.on('error', () => {});
  return {
    async ask(key, { signal } = {}) {
      if (asked) throw new Error('one ask per connection');
      asked = true;
      if (signal?.aborted) throw new Error('ask aborted');
      const onAbort = () => socket.destroy();
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const reading = readLine(socket, { maxBytes: MAX_LINE_BYTES, timeoutMs: replyTimeoutMs });
        socket.write(encodeAsk(key));
        const reply = parseJsonObject(await reading);
        if (reply === null || reply.v !== PROTOCOL_VERSION) {
          throw new Error('unreadable reply');
        }
        if (typeof reply.error === 'string') {
          throw new Error(`host end refused the ask: ${reply.error}`);
        }
        return reply;
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
    },
    close() {
      socket.destroy();
    },
  };
}

module.exports = { createSocketVerdictTransport, DEFAULT_REPLY_TIMEOUT_MS };
