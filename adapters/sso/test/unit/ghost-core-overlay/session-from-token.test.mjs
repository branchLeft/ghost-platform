import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

// The file under test is Ghost's own session-from-token.js with our patch
// applied, built once per run by test/unit/global-setup.mjs from the pinned
// base image. No copy of Ghost's source is committed.
const require = createRequire(import.meta.url);
const SessionFromToken = require('../../../ghost-core-overlay/derived/session-from-token.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OVERLAY_DIR = path.resolve(__dirname, '../../../ghost-core-overlay');
const DERIVED_DIR = path.join(OVERLAY_DIR, 'derived');
const APPLY_SCRIPT = path.join(OVERLAY_DIR, 'apply-session-from-token-patch.sh');

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

  // The tests above run against the derived file; this proves the derived file
  // is the one the image build ships: the same pin the Dockerfile checks.
  it('the derived file hashes to the pin the image build checks', () => {
    const pinPath = path.join(OVERLAY_DIR, 'session-from-token.patched.sha256');
    const pinned = fs.readFileSync(pinPath, 'utf8').trim().split(/\s+/)[0];
    const actual = crypto
      .createHash('sha256')
      .update(fs.readFileSync(path.join(DERIVED_DIR, 'session-from-token.js')))
      .digest('hex');
    expect(actual).toBe(pinned);
  });
});

// The same script the Dockerfile runs. Each case hands it a Ghost file in a
// temp directory and reads back its verdict, so the build gate is shown to
// pass for the pinned file and to fail, with its own reason, for a changed one.
describe('ghost-core-overlay/apply-session-from-token-patch.sh (the build gate)', () => {
  const baseline = fs.readFileSync(
    path.join(DERIVED_DIR, 'baseline', 'session-from-token.js'),
    'utf8'
  );

  function gate(ghostFileText) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sso-overlay-gate-'));
    try {
      fs.writeFileSync(path.join(dir, 'session-from-token.js'), ghostFileText);
      const result = spawnSync(APPLY_SCRIPT, [dir], { encoding: 'utf8' });
      return {
        status: result.status,
        stderr: result.stderr,
        produced: fs.readFileSync(path.join(dir, 'session-from-token.js'), 'utf8'),
      };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('passes for the file the patch was written against and produces the derived file', () => {
    const result = gate(baseline);
    expect(result.status).toBe(0);
    expect(result.produced).toBe(
      fs.readFileSync(path.join(DERIVED_DIR, 'session-from-token.js'), 'utf8')
    );
  });

  it('fails, naming the patch, when a line the patch touches has changed upstream', () => {
    const changed = baseline.replace(
      'await createSession(req, res, user);',
      'await createSession(req, res, user); // changed upstream'
    );
    expect(changed).not.toBe(baseline);
    const result = gate(changed);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/session-from-token\.patch no longer applies cleanly/);
  });

  it('fails, naming the pin, when upstream changed outside the patch but the patch still applies', () => {
    const result = gate(`// changed upstream\n${baseline}`);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/does not match session-from-token\.patched\.sha256/);
  });

  it('fails for a file that already carries the patch', () => {
    const result = gate(fs.readFileSync(path.join(DERIVED_DIR, 'session-from-token.js'), 'utf8'));
    expect(result.status).not.toBe(0);
  });
});

describe('ghost-core-overlay holds no copy of Ghost source', () => {
  it('commits no JavaScript or licence copy beside the patch (the derived/ build output is git-ignored)', () => {
    const entries = fs.readdirSync(OVERLAY_DIR).filter((name) => name !== 'derived');
    const sourceCopies = entries.filter((name) => /\.js$/.test(name) || /^LICENSE/i.test(name));
    expect(sourceCopies).toEqual([]);
  });
});
