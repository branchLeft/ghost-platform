// Test-only stand-in for the `DrainSource` seam (`src/drainSource.ts`).
// `standIn: true` makes `/status` list it (`src/standIns.ts`), so a host
// still running it can never pass for one ready to go live. A real install
// points `BROKER_DRAIN_SOURCE_MODULE` at a shipped module instead.
export default {
  standIn: true,
  async poll(signal) {
    return new Promise((resolve) => {
      const done = () => resolve({ mail: [], mediaHashes: [] });
      if (signal.aborted) return done();
      signal.addEventListener('abort', done, { once: true });
    });
  },
};
