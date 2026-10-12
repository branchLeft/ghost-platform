'use strict';

const { VerdictClient } = require('./verdict-client');

// Both budgets sit below checks.js's own outer budget, so this client's
// decision (and its log line) is the one that fires; the outer one remains
// the backstop for a client that never returns at all.
const DEFAULT_CONNECT_TIMEOUT_MS = 500;
const DEFAULT_TOTAL_TIMEOUT_MS = 1500;

// The only answers this client will vouch for. A string outside this set
// (a newer vocabulary, a typo, a truncated message) is a malformed answer,
// and a malformed answer is never read as clean and never as a refusal.
const ANSWER_CLASSIFICATIONS = new Set([
  'no-known-match',
  'csam',
  'harmful-abusive-material',
  'test',
]);

const CONNECT_TIMED_OUT = Symbol('connect-timed-out');
const TOTAL_TIMED_OUT = Symbol('total-timed-out');

function deadline(ms, sentinel) {
  let timer;
  const promise = new Promise((resolve) => {
    timer = setTimeout(() => resolve(sentinel), ms);
  });
  return { promise, clear: () => clearTimeout(timer) };
}

function validTimeout(name, value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`ProductionVerdictClient: ${name} must be a positive number of milliseconds`);
  }
  return value;
}

function oneLine(value, max) {
  return String(value).replace(/\s+/g, ' ').slice(0, max);
}

// Closing is best effort: the verdict is already decided, and a failing
// close must change nothing about it.
function closeQuietly(connection) {
  try {
    const closing = connection && typeof connection.close === 'function' && connection.close();
    if (closing && typeof closing.catch === 'function') closing.catch(() => {});
  } catch {
    // Nothing to do.
  }
}

// Reads a transport's answer. Returns the verdict's classification and
// optional matchType, or null when the answer is not one this client
// recognises. Anything not an exact, known classification is null.
function readAnswer(answer) {
  if (answer === null || typeof answer !== 'object' || Array.isArray(answer)) {
    return null;
  }
  const { classification, matchType } = answer;
  if (classification === 'unavailable') {
    return { classification };
  }
  if (typeof classification !== 'string' || !ANSWER_CLASSIFICATIONS.has(classification)) {
    return null;
  }
  return typeof matchType === 'string' ? { classification, matchType } : { classification };
}

// Asks a safety service about one key over an injected transport, and holds
// on every outcome that is not a recognised answer inside the budget. The
// transport owns the socket, the address and any credential; this module
// reads none. getVerdict never rejects, and answers 'no-known-match' only
// when the transport said so inside the budget. The transport shape and the
// outcome table are in production-verdict-client.md.
class ProductionVerdictClient extends VerdictClient {
  #transport;
  #connectTimeoutMs;
  #totalTimeoutMs;
  #logger;

  constructor({
    transport,
    connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
    totalTimeoutMs = DEFAULT_TOTAL_TIMEOUT_MS,
    logger = null,
    source = 'production-verdict-client',
  } = {}) {
    super();
    if (!transport || typeof transport.connect !== 'function') {
      throw new Error('ProductionVerdictClient requires a transport with a connect() function');
    }
    this.#transport = transport;
    this.#connectTimeoutMs = validTimeout('connectTimeoutMs', connectTimeoutMs);
    this.#totalTimeoutMs = validTimeout('totalTimeoutMs', totalTimeoutMs);
    this.#logger = logger;
    this.source = source;
  }

  async getVerdict(key) {
    if (typeof key !== 'string' || key === '') {
      return this.#hold(key, 'invalid-key');
    }

    const controller = new AbortController();
    const connect = deadline(
      Math.min(this.#connectTimeoutMs, this.#totalTimeoutMs),
      CONNECT_TIMED_OUT
    );
    const total = deadline(this.#totalTimeoutMs, TOTAL_TIMED_OUT);
    let connection = null;
    let abandoned = false;
    let answered = false;

    try {
      // A throw before the first await is turned into a rejection, so a
      // transport that fails synchronously is held like any other failure.
      const connecting = Promise.resolve().then(() =>
        this.#transport.connect({ signal: controller.signal })
      );
      // A connection that arrives after its budget is closed, not leaked.
      connecting.then(
        (late) => {
          if (abandoned) closeQuietly(late);
        },
        () => {}
      );
      const connected = await Promise.race([
        connecting.then((value) => ({ value })),
        connect.promise,
        total.promise,
      ]);
      connect.clear();
      if (connected === CONNECT_TIMED_OUT) {
        abandoned = true;
        return this.#hold(key, 'connect-timeout');
      }
      if (connected === TOTAL_TIMED_OUT) {
        abandoned = true;
        return this.#hold(key, 'total-timeout');
      }
      connection = connected.value;
      if (!connection || typeof connection.ask !== 'function') {
        return this.#hold(key, 'malformed-answer', 'transport returned no connection');
      }

      const asking = Promise.resolve().then(() =>
        connection.ask(key, { signal: controller.signal })
      );
      asking.then(
        () => {},
        () => {}
      );
      const got = await Promise.race([asking.then((value) => ({ value })), total.promise]);
      if (got === TOTAL_TIMED_OUT) {
        return this.#hold(key, 'total-timeout');
      }

      const read = readAnswer(got.value);
      if (read === null) {
        return this.#hold(key, 'malformed-answer');
      }
      if (read.classification === 'unavailable') {
        return this.#hold(key, 'channel-unavailable');
      }
      answered = true;
      return { ...read, source: this.source, evidence: key };
    } catch (err) {
      return this.#hold(key, 'transport-error', err);
    } finally {
      connect.clear();
      total.clear();
      // Tell a still-running transport to stop; harmless once it has answered.
      if (!answered) controller.abort();
      closeQuietly(connection);
    }
  }

  #hold(key, reason, detail) {
    this.#log(key, reason, detail);
    return {
      classification: 'unavailable',
      source: this.source,
      evidence: typeof key === 'string' ? key : '',
    };
  }

  #log(key, reason, detail) {
    if (!this.#logger || typeof this.#logger.error !== 'function') return;
    const error = detail === undefined ? '' : ` error=${oneLine(detail?.message ?? detail, 200)}`;
    try {
      this.#logger.error(
        `ProductionVerdictClient: VERDICT_UNAVAILABLE reason=${reason} key=${JSON.stringify(
          oneLine(key, 128)
        )}${error}`
      );
    } catch {
      // A logger that throws must not turn a hold into a crash.
    }
  }
}

module.exports = {
  ProductionVerdictClient,
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_TOTAL_TIMEOUT_MS,
  ANSWER_CLASSIFICATIONS,
};
