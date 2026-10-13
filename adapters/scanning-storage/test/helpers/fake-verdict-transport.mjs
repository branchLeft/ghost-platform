// An injected transport for the production verdict client: no socket, no
// address, no credential. Each behaviour is a function the test supplies, and
// everything the client does to it is recorded, so a test can say what was
// asked, what was closed and what was told to stop.
export const NEVER = () => new Promise(() => {});

// A well-behaved service answers with the key it was asked about, so by
// default an answer without a `key` gets the asked one. `echoKey: false`
// leaves answers exactly as the test wrote them.
export function fakeTransport({ connect, ask, close, echoKey = true } = {}) {
  const record = {
    connects: 0,
    asked: [],
    closed: 0,
    connectSignals: [],
    askSignals: [],
  };
  const connection = {
    async ask(key, { signal } = {}) {
      record.asked.push(key);
      record.askSignals.push(signal);
      const answer = await (ask ?? (() => ({ classification: 'no-known-match' })))(key, {
        signal,
      });
      const plain = answer !== null && typeof answer === 'object' && !Array.isArray(answer);
      return echoKey && plain && !('key' in answer) ? { key, ...answer } : answer;
    },
    async close() {
      record.closed += 1;
      if (close) await close();
    },
  };
  const transport = {
    async connect({ signal } = {}) {
      record.connects += 1;
      record.connectSignals.push(signal);
      if (connect) return connect({ signal, connection });
      return connection;
    },
  };
  return { transport, record, connection };
}

export function captureLogger() {
  const lines = [];
  return { logger: { error: (line) => lines.push(String(line)) }, lines };
}
