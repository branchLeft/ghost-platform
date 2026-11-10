import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EXIT, main } from './cli.mjs';
import { fakeOps } from './fake-ops.mjs';

const schema = { posts: { id: { nullable: false } } };
const goodImages = { 'ghost:old': { schema }, 'ghost:new': { schema } };

function harness(images, files = {}) {
  const out = [];
  const err = [];
  const written = {};
  return {
    out,
    err,
    written,
    deps: {
      ops: fakeOps(images),
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      readFile: (p) => {
        if (!(p in files)) throw new Error('ENOENT');
        return files[p];
      },
      writeFile: (p, t) => {
        written[p] = t;
      },
    },
  };
}
const RUN = ['run', '--old', 'ghost:old', '--new', 'ghost:new', '--mysql', 'mysql:pinned'];

describe('run', () => {
  it('exits 0 and writes the record for an accepted pair', async () => {
    const h = harness(goodImages);
    assert.equal(await main([...RUN, '--out', 'r.json'], h.deps), EXIT.accepted);
    assert.equal(JSON.parse(h.written['r.json']).outcome, 'accepted');
    assert.ok(h.out.some((l) => l.startsWith('ACCEPTED:')));
  });

  it('exits 2 for a refused pair and still writes the record', async () => {
    const images = { 'ghost:old': { schema }, 'ghost:new': { schema, bootError: () => 'boom' } };
    const h = harness(images);
    assert.equal(await main(RUN, h.deps), EXIT.refused);
    assert.equal(JSON.parse(h.written['rollback-report.json']).outcome, 'refused');
  });

  it('records the profile, platform unless told otherwise, and refuses an unknown one', async () => {
    const h = harness(goodImages);
    await main([...RUN, '--out', 'a.json'], h.deps);
    assert.equal(JSON.parse(h.written['a.json']).profile, 'platform');
    await main([...RUN, '--profile', 'stock', '--out', 'b.json'], h.deps);
    assert.equal(JSON.parse(h.written['b.json']).profile, 'stock');
    const bad = harness(goodImages);
    assert.equal(await main([...RUN, '--profile', 'odd'], bad.deps), EXIT.error);
    assert.deepEqual(bad.written, {});
  });

  it('exits 1 when the run could not finish', async () => {
    const h = harness({ 'ghost:old': { schema } });
    assert.equal(await main(RUN, h.deps), EXIT.error);
  });
});

describe('arguments', () => {
  it('exit 1 with a message for no command, an unknown flag, a missing value or a missing flag', async () => {
    for (const argv of [
      [],
      ['nope'],
      ['run', '--old', 'a', '--new', 'b', '--mysql', 'c', '--bogus', 'x'],
      ['run', '--old', 'a', '--new'],
      ['run', '--old', 'a', '--new', 'b'],
      ['verify', '--report', 'r.json'],
    ]) {
      const h = harness(goodImages);
      assert.equal(await main(argv, h.deps), EXIT.error, JSON.stringify(argv));
      assert.ok(h.err.length > 0);
    }
  });
});

describe('verify', () => {
  const record = async () => {
    const h = harness(goodImages);
    await main(RUN, h.deps);
    return h.written['rollback-report.json'];
  };
  const VERIFY = ['verify', '--report', 'r.json', '--old', 'ghost:old', '--new', 'ghost:new'];

  it('exits 0 for a good record of the same pair', async () => {
    const h = harness(goodImages, { 'r.json': await record() });
    assert.equal(await main(VERIFY, h.deps), EXIT.accepted);
  });

  it('exits 2 for a red record, and names why', async () => {
    const red = JSON.parse(await record());
    red.checks[0].ok = false;
    const h = harness(goodImages, { 'r.json': JSON.stringify(red) });
    assert.equal(await main(VERIFY, h.deps), EXIT.refused);
    assert.ok(h.out.some((l) => /REFUSED: new-boots is red/.test(l)));
  });

  it('exits 1 for an unreadable or malformed record', async () => {
    assert.equal(await main(VERIFY, harness(goodImages).deps), EXIT.error);
    assert.equal(await main(VERIFY, harness(goodImages, { 'r.json': '{nope' }).deps), EXIT.error);
  });
});
