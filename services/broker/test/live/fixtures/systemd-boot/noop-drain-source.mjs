// Test-only stand-in for the `DrainSource` seam (`src/drainSource.ts`).
// It carries no `real: true`, so `/status` lists it under `notReal`
// (`src/seamReadiness.ts`) and a host still running it cannot pass for one
// ready to go live. A real install points at a shipped module instead.
export default {
  async poll(signal) {
    return new Promise((resolve) => {
      const done = () => resolve({ mail: [], mediaHashes: [] });
      if (signal.aborted) return done();
      signal.addEventListener('abort', done, { once: true });
    });
  },
};
