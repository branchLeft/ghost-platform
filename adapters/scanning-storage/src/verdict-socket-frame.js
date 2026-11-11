'use strict';

// The local verdict socket's framing, shared by the decorator's side
// (socket-verdict-transport.js) and the host end (verdict-host/), so the two
// cannot drift. One JSON object per line. The contract is in
// verdict-socket.md.

const PROTOCOL_VERSION = 1;
const MAX_LINE_BYTES = 1024;
const OP_ASK = 'ask';

const PDQ_BYTES = 32;

// A PDQ hash is the canonical base64 of exactly 32 bytes. Anything else is not
// a key the channel carries: a path, a name or a tenant value must never ride
// this socket, so the host end refuses it on sight.
function isPdqKey(value) {
  if (typeof value !== 'string' || value.length !== 44) return false;
  const bytes = Buffer.from(value, 'base64');
  return bytes.length === PDQ_BYTES && bytes.toString('base64') === value;
}

function encodeLine(object) {
  return `${JSON.stringify(object)}\n`;
}

function encodeAsk(key) {
  return encodeLine({ v: PROTOCOL_VERSION, op: OP_ASK, key });
}

function encodeReply({ key, classification, matchType }) {
  const reply = { v: PROTOCOL_VERSION, key, classification };
  if (typeof matchType === 'string') reply.matchType = matchType;
  return encodeLine(reply);
}

function encodeError(reason) {
  return encodeLine({ v: PROTOCOL_VERSION, error: reason });
}

// Reads the first line from a socket and settles with its text, without the
// newline. It rejects on an oversized line, a socket that ends or closes
// first, an error, or the timeout, and always detaches its listeners.
function readLine(socket, { maxBytes = MAX_LINE_BYTES, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let received = Buffer.alloc(0);
    let timer = null;
    const finish = (settle, value) => {
      if (timer !== null) clearTimeout(timer);
      socket.off('data', onData);
      socket.off('end', onEnd);
      socket.off('close', onEnd);
      socket.off('error', onError);
      settle(value);
    };
    const onData = (chunk) => {
      received = Buffer.concat([received, chunk]);
      const newline = received.indexOf(0x0a);
      if (newline >= 0) {
        if (newline > maxBytes) {
          finish(reject, new Error('line too long'));
          return;
        }
        finish(resolve, received.subarray(0, newline).toString('utf8'));
        return;
      }
      if (received.length > maxBytes) finish(reject, new Error('line too long'));
    };
    const onEnd = () => finish(reject, new Error('socket closed before a full line'));
    const onError = (err) => finish(reject, err);
    socket.on('data', onData);
    socket.on('end', onEnd);
    socket.on('close', onEnd);
    socket.on('error', onError);
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => finish(reject, new Error('timed out reading a line')), timeoutMs);
    }
  });
}

function parseJsonObject(text) {
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

module.exports = {
  PROTOCOL_VERSION,
  MAX_LINE_BYTES,
  OP_ASK,
  isPdqKey,
  encodeAsk,
  encodeReply,
  encodeError,
  readLine,
  parseJsonObject,
};
