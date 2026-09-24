import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const SessionFromToken = require('../../../ghost-core-overlay/session-from-token.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OVERLAY_DIR = path.resolve(__dirname, '../../../ghost-core-overlay');

// A fake req.session.save() that never calls its callback until the test
// releases it -- the shape needed to prove `next()` waits for the write,
// not just that it eventually happens.
function makeReq() {
  const pending = [];
  const save = vi.fn((cb) => {
    pending.push(cb);
  });
  return {
    session: { save },
    releaseSave(err = null) {
      const cb = pending.pop();
      if (!cb) {
        throw new Error('test bug: session.save was not called yet');
      }
      cb(err);
    },
  };
}

async function flushMicrotasks() {
  await new Promise((resolve) => setImmediate(resolve));
}

function handlerWith({
  createSession,
  callNextWithError = false,
  token = 'a-token',
  lookup = 'a-lookup',
  user = { id: 'user-1' },
} = {}) {
  return SessionFromToken({
    getTokenFromRequest: async () => token,
    getLookupFromToken: async () => lookup,
    findUserByLookup: async () => user,
    createSession,
    callNextWithError,
  });
}

describe('ghost-core-overlay/session-from-token.js', () => {
  it('does not call next until the deferred save resolves, then calls it exactly once with no error', async () => {
    const next = vi.fn();
    const createSession = vi.fn(async () => {});
    const handler = handlerWith({ createSession });
    const req = makeReq();

    const done = handler(req, {}, next);
    await flushMicrotasks();

    expect(req.session.save).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();

    req.releaseSave(null);
    await done;

    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0]).toEqual([]);
  });

  it('a save error calls next(err) and never plain next()', async () => {
    const next = vi.fn();
    const saveErr = new Error('disk full');
    const createSession = vi.fn(async () => {});
    const handler = handlerWith({ createSession });
    const req = makeReq();

    const done = handler(req, {}, next);
    await flushMicrotasks();
    req.releaseSave(saveErr);
    await done;

    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith(saveErr);
    // Never plain `next()` on the error path -- an unauthenticated-looking
    // response for a request that already holds an accepted token.
    expect(next.mock.calls[0].length).toBe(1);
  });

  it('no path calls next twice, on either the success or the save-error branch', async () => {
    const successNext = vi.fn();
    const successHandler = handlerWith({ createSession: vi.fn(async () => {}) });
    const successReq = makeReq();
    const successDone = successHandler(successReq, {}, successNext);
    await flushMicrotasks();
    successReq.releaseSave(null);
    await successDone;
    expect(successNext).toHaveBeenCalledTimes(1);

    const errorNext = vi.fn();
    const errorHandler = handlerWith({ createSession: vi.fn(async () => {}) });
    const errorReq = makeReq();
    const errorDone = errorHandler(errorReq, {}, errorNext);
    await flushMicrotasks();
    errorReq.releaseSave(new Error('boom'));
    await errorDone;
    expect(errorNext).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['true', true],
    ['false', false],
  ])(
    'a createSession error matches upstream when callNextWithError is %s: next called once, no session.save attempted',
    async (_label, callNextWithError) => {
      const next = vi.fn();
      const err = new Error('lookup exploded');
      const createSession = vi.fn(async () => {
        throw err;
      });
      const handler = handlerWith({ createSession, callNextWithError });
      const req = makeReq();

      await handler(req, {}, next);

      expect(req.session.save).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledTimes(1);
      if (callNextWithError) {
        expect(next).toHaveBeenCalledWith(err);
      } else {
        expect(next.mock.calls[0]).toEqual([]);
      }
    }
  );

  it('no token: next() called immediately, no createSession or save attempted (unchanged upstream branch)', async () => {
    const next = vi.fn();
    const createSession = vi.fn(async () => {});
    const handler = handlerWith({ createSession, token: null });
    const req = makeReq();

    await handler(req, {}, next);

    expect(createSession).not.toHaveBeenCalled();
    expect(req.session.save).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0]).toEqual([]);
  });

  it('no lookup: next() called immediately, no createSession or save attempted (unchanged upstream branch)', async () => {
    const next = vi.fn();
    const createSession = vi.fn(async () => {});
    const handler = handlerWith({ createSession, lookup: null });
    const req = makeReq();

    await handler(req, {}, next);

    expect(createSession).not.toHaveBeenCalled();
    expect(req.session.save).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('no user: next() called immediately, no createSession or save attempted (unchanged upstream branch)', async () => {
    const next = vi.fn();
    const createSession = vi.fn(async () => {});
    const handler = handlerWith({ createSession, user: null });
    const req = makeReq();

    await handler(req, {}, next);

    expect(createSession).not.toHaveBeenCalled();
    expect(req.session.save).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  // Proves the README's re-derivation step 2 diffs against a verified
  // original, not a guess reconstructed from memory of the patch.
  it('the pristine upstream copy matches the pinned hash the build guard checks', () => {
    const upstreamPath = path.join(OVERLAY_DIR, 'session-from-token.upstream.js');
    const pinPath = path.join(OVERLAY_DIR, 'session-from-token.upstream.sha256');
    const upstreamBytes = fs.readFileSync(upstreamPath);
    const pinned = fs.readFileSync(pinPath, 'utf8').trim().split(/\s+/)[0];
    const actual = crypto.createHash('sha256').update(upstreamBytes).digest('hex');
    expect(actual).toBe(pinned);
  });
});
