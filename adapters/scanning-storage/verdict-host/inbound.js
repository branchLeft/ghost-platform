'use strict';

const http = require('node:http');
const { parseVerdictsBody, definitiveAnswers, CHANNEL_VERSION } = require('./verdicts-body');

// The inbound end of the verdict channel: the safety service dials this and
// the host answers, never the other way. Two routes, both signed, both bounded
// in bytes and time. The contract is docs/verdict-channel.md in
// branchLeft/content-safety; the limits chosen here are in verdict-host.md.

const PENDING_PATH = '/safety/v1/pending';
const VERDICTS_PATH = '/safety/v1/verdicts';
const MAX_BODY_BYTES = 256 * 1024;

const DEFAULT_HOLD_MS = 30_000;
const DEFAULT_TICK_MS = 250;
const DEFAULT_MAX_HELD_POLLS = 4;
const DEFAULT_MAX_CONNECTIONS = 32;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

class BodyTooLarge extends Error {}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      reject(new BodyTooLarge());
      return;
    }
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new BodyTooLarge());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
    req.on('aborted', () => reject(new Error('aborted')));
  });
}

function sendJson(res, status, object) {
  const text = JSON.stringify(object);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function startInbound({
  queue,
  authenticate,
  host,
  port,
  holdMs = DEFAULT_HOLD_MS,
  tickMs = DEFAULT_TICK_MS,
  maxHeldPolls = DEFAULT_MAX_HELD_POLLS,
  maxConnections = DEFAULT_MAX_CONNECTIONS,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  now = Date.now,
  logger = console,
  count = () => {},
}) {
  let held = 0;

  function holdPoll(res) {
    if (held >= maxHeldPolls) {
      count('polls', 'busy');
      res.writeHead(503).end();
      return;
    }
    held += 1;
    const deadline = now() + holdMs;
    let timer = null;
    let finished = false;
    const finish = () => {
      if (finished) return false;
      finished = true;
      held -= 1;
      if (timer !== null) clearInterval(timer);
      queue.off('enqueued', attempt);
      res.off('close', finish);
      return true;
    };
    function attempt() {
      if (finished) return;
      const leased = queue.lease();
      if (leased !== null) {
        if (!finish()) return;
        count('polls', 'batch');
        sendJson(res, 200, { v: CHANNEL_VERSION, batch: leased.batch, hashes: leased.hashes });
        return;
      }
      if (now() >= deadline) {
        if (!finish()) return;
        count('polls', 'empty');
        sendJson(res, 200, { v: CHANNEL_VERSION, hashes: [] });
      }
    }
    // A caller that went away is not served: its hashes stay queued.
    res.on('close', finish);
    queue.on('enqueued', attempt);
    timer = setInterval(attempt, tickMs);
    attempt();
  }

  function takeVerdicts(res, body) {
    const parsed = parseVerdictsBody(body.toString('utf8'));
    if (parsed === null) {
      count('posts', 'unreadable');
      res.writeHead(400).end();
      return;
    }
    const offered = queue.batchHashes(parsed.batch);
    if (offered === null || !queue.settle(parsed.batch, definitiveAnswers(parsed, offered))) {
      count('posts', 'gone');
      res.writeHead(409).end();
      return;
    }
    count('posts', 'accepted');
    res.writeHead(204).end();
  }

  async function onRequest(req, res) {
    const isPoll = req.method === 'GET' && req.url === PENDING_PATH;
    const isPost = req.method === 'POST' && req.url === VERDICTS_PATH;
    if (!isPoll && !isPost) {
      res.writeHead(404).end();
      return;
    }
    let body;
    try {
      body = await readBody(req, MAX_BODY_BYTES);
    } catch (err) {
      if (err instanceof BodyTooLarge && !res.headersSent) {
        res.writeHead(413, { connection: 'close' }).end(() => req.destroy());
        return;
      }
      req.destroy();
      return;
    }
    const verdict = authenticate(req.method, req.url, req.headers, body);
    if (!verdict.ok) {
      count('refused', verdict.reason);
      logger.error(`VerdictHost: VERDICT_HOST_REQUEST_REFUSED reason=${verdict.reason}`);
      res.writeHead(401).end();
      return;
    }
    if (isPoll) {
      if (body.length > 0) {
        res.writeHead(400).end();
        return;
      }
      holdPoll(res);
      return;
    }
    takeVerdicts(res, body);
  }

  const server = http.createServer((req, res) => {
    onRequest(req, res).catch((err) => {
      logger.error(
        `VerdictHost: VERDICT_HOST_REQUEST_FAILED error=${String(err?.code ?? err?.name)}`
      );
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  server.maxConnections = maxConnections;
  server.requestTimeout = requestTimeoutMs;
  server.headersTimeout = requestTimeoutMs;
  server.maxHeadersCount = 32;
  // A held poll is a response still being produced, not an idle socket.
  server.keepAliveTimeout = 5000;

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve({
        server,
        address: server.address(),
        close: () =>
          new Promise((done) => {
            server.close(() => done());
            server.closeAllConnections();
          }),
      });
    });
  });
}

module.exports = {
  startInbound,
  PENDING_PATH,
  VERDICTS_PATH,
  MAX_BODY_BYTES,
  DEFAULT_HOLD_MS,
};
