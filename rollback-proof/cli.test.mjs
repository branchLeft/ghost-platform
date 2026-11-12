import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EXIT, main } from './cli.mjs';
import { fakeOps } from './fake-ops.mjs';

const schema = { posts: { id: { nullable: false } } };
const goodImages = { 'ghost:old': { schema }, 'ghost:new': { schema } };
const withBatches = (provider) => ({
  posts: schema.posts,
  email_batches: { id: { nullable: false }, [provider]: { nullable: true } },
});
const renamedImages = {
  'ghost:old': { schema: withBatches('provider_id') },
  'ghost:new': {
    schema: withBatches('mailgun_message_id'),
    migrate: () => withBatches('mailgun_message_id'),
  },
};

function harness(images, files = {}, github = {}) {
  const out = [];
  const err = [];
  const written = {};
  const appended = {};
  return {
    out,
    err,
    written,
    appended,
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
      appendFile: (p, t) => {
        appended[p] = (appended[p] ?? '') + t;
      },
      github,
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
    assert.ok(!h.out.some((l) => l.startsWith('WARNING')));
  });

  it('exits 2 for a pair whose new image is itself broken, and still writes the record', async () => {
    const images = { 'ghost:old': { schema }, 'ghost:new': { schema, bootError: () => 'boom' } };
    const h = harness(images);
    assert.equal(await main(RUN, h.deps), EXIT.refused);
    assert.equal(JSON.parse(h.written['rollback-report.json']).outcome, 'refused');
  });

  it('exits 0 with a warning that names the column and the restore route when only the way back is broken', async () => {
    const h = harness(renamedImages);
    assert.equal(EXIT.warned, 0);
    assert.equal(await main([...RUN, '--out', 'w.json'], h.deps), EXIT.warned);
    const record = JSON.parse(h.written['w.json']);
    assert.equal(record.outcome, 'warned');
    assert.ok(h.out.some((l) => l.startsWith('WARNED:')));
    const warning = h.out.filter((l) => l.startsWith('WARNING')).join('\n');
    assert.match(warning, /email_batches\.provider_id/);
    assert.match(warning, /restore-from-backup/);
    assert.ok(!h.out.some((l) => l.startsWith('::warning')), 'no annotation outside Actions');
  });

  it('leaves the annotation and the summary to verify, so a run then verify shows each once', async () => {
    const h = harness(renamedImages, {}, { annotate: true, summaryFile: 'summary.md' });
    assert.equal(await main(RUN, h.deps), EXIT.warned);
    assert.ok(!h.out.some((l) => l.startsWith('::warning')));
    assert.deepEqual(h.appended, {});
  });

  it('writes no annotation and no summary for a clean pair', async () => {
    const h = harness(goodImages, {}, { annotate: true, summaryFile: 'summary.md' });
    assert.equal(await main(RUN, h.deps), EXIT.accepted);
    assert.ok(!h.out.some((l) => l.startsWith('::warning')));
    assert.deepEqual(h.appended, {});
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
  const record = async (images = goodImages) => {
    const h = harness(images);
    await main(RUN, h.deps);
    return h.written['rollback-report.json'];
  };
  const VERIFY = ['verify', '--report', 'r.json', '--old', 'ghost:old', '--new', 'ghost:new'];

  it('exits 0 for a good record of the same pair', async () => {
    const h = harness(goodImages, { 'r.json': await record() });
    assert.equal(await main(VERIFY, h.deps), EXIT.accepted);
  });

  it('exits 0 for a warned record, repeats the warning, and writes the summary', async () => {
    const h = harness(
      renamedImages,
      { 'r.json': await record(renamedImages) },
      { annotate: true, summaryFile: 'summary.md' }
    );
    assert.equal(await main(VERIFY, h.deps), EXIT.warned);
    assert.ok(h.out.some((l) => l.startsWith('WARNED:')));
    assert.ok(h.out.some((l) => /^WARNING.*restore-from-backup/.test(l)));
    const annotation = h.out.find((l) => l.startsWith('::warning title='));
    assert.ok(annotation, 'a ::warning annotation');
    assert.match(annotation, /restore-from-backup/);
    assert.match(annotation, /email_batches\.provider_id/);
    assert.ok(!annotation.includes('\n'), 'one line');
    assert.match(h.appended['summary.md'], /restore-from-backup/);
    assert.match(h.appended['summary.md'], /email_batches\.provider_id/);
  });

  it('writes no annotation or summary for a clean record, and no annotation outside Actions', async () => {
    const clean = harness(
      goodImages,
      { 'r.json': await record() },
      { annotate: true, summaryFile: 's.md' }
    );
    assert.equal(await main(VERIFY, clean.deps), EXIT.accepted);
    assert.ok(!clean.out.some((l) => l.startsWith('::warning')));
    assert.deepEqual(clean.appended, {});
    const local = harness(renamedImages, { 'r.json': await record(renamedImages) });
    assert.equal(await main(VERIFY, local.deps), EXIT.warned);
    assert.ok(!local.out.some((l) => l.startsWith('::warning')));
  });

  it('exits 2 for a warned record whose restore route was removed', async () => {
    const stripped = JSON.parse(await record(renamedImages));
    delete stripped.rollbackRoute;
    const h = harness(renamedImages, { 'r.json': JSON.stringify(stripped) });
    assert.equal(await main(VERIFY, h.deps), EXIT.refused);
    assert.ok(h.out.some((l) => /REFUSED:.*restore-from-backup/.test(l)));
  });

  it('exits 2 for a red gate check, and names why', async () => {
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
