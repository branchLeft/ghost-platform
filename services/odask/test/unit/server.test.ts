import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * `server.ts` is excluded from coverage since it is a process entrypoint,
 * unit-testable only by starting a real OS process. This test covers the
 * *source* directly as a fast first line of defence for the one
 * `.listen()` call site's host argument.
 * See ../../README.md#server-test-wiring.
 */
describe('server.ts wiring', () => {
  it('binds to config.bindHost exactly -- no literal, no fallback, no wrapping expression', () => {
    const source = readFileSync(new URL('../../src/server.ts', import.meta.url), 'utf8');
    const listenCalls = [...source.matchAll(/\.listen\(([^)]*)\)/g)];
    expect(listenCalls, 'expected exactly one app.listen(...) call in server.ts').toHaveLength(1);
    const args = listenCalls[0]![1]!.split(',');
    expect(args.length, 'expected app.listen(port, host, callback)').toBeGreaterThanOrEqual(2);
    // The exact second argument, not merely a substring match -- `config.
    // bindHost && "::"` still *contains* `config.bindHost` and would pass
    // a `.toContain()` check while binding every interface. This is the
    // sabotage the review round ran against this test, reverted; see the
    // PR body for its recorded red/green output.
    expect(args[1]!.trim()).toBe('config.bindHost');
  });
});
