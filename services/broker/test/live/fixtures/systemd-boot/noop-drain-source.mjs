// Test-only stand-in for the `DrainSource` seam (`src/drainSource.ts`) so
// this proof's server can start at all. No real implementation exists
// anywhere in this repo yet -- RUNBOOK-broker-deploy.md's "Left out,
// deliberately" -- and this file is never what a real install points
// `BROKER_DRAIN_SOURCE_MODULE` at.
export default {
  async poll(signal) {
    return new Promise((resolve) => {
      const done = () => resolve({ mail: [], mediaHashes: [] });
      if (signal.aborted) return done();
      signal.addEventListener('abort', done, { once: true });
    });
  },
};
