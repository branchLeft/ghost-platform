import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * server.ts is excluded from coverage (vitest.config.ts) because it is a
 * process entrypoint -- reading real env vars, starting a real timer,
 * wiring real signal handlers -- none of which is unit-testable without
 * starting an actual OS process, which reachability.test.ts does at the
 * `createApp`/`listen` layer instead. What that test cannot see is whether
 * this file actually passes the configured value through: a hardcoded or
 * defaulted host at the one call site that binds the socket would defeat
 * every guard reachability.test.ts and config.test.ts prove, and nothing
 * else in this suite would notice, because nothing else imports server.ts.
 */
describe('server.ts wiring', () => {
  it('binds to config.bindHost, never a literal address', () => {
    const source = readFileSync(new URL('../../src/server.ts', import.meta.url), 'utf8');
    const listenCalls = [...source.matchAll(/\.listen\(([^)]*)\)/g)];
    expect(listenCalls, 'expected exactly one app.listen(...) call in server.ts').toHaveLength(1);
    const args = listenCalls[0]![1]!;
    expect(args).toContain('config.bindHost');
    expect(args).not.toMatch(/['"][\d.]+['"]/);
  });
});
