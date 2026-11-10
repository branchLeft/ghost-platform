import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { REQUIRED_CHECKS, RESTORE_ROUTE, assessReport, runProof, verifyReport } from './proof.mjs';
import { fakeOps } from './fake-ops.mjs';

const OLD = 'ghost:old';
const NEW = 'ghost:new';
const MYSQL = 'mysql:pinned';

// The two shapes of the measured break: one table the old code writes on every
// bulk send, and the column a later release renames out from under it.
const oldSchema = {
  posts: { id: { nullable: false }, title: { nullable: false } },
  email_batches: { id: { nullable: false }, provider_id: { nullable: true } },
};
const renamed = (tables) => {
  const batches = { ...tables.email_batches };
  batches.mailgun_message_id = batches.provider_id;
  delete batches.provider_id;
  return { ...tables, email_batches: batches };
};
const additive = (tables) => ({
  ...tables,
  posts: { ...tables.posts, subtitle: { nullable: true } },
});

const oldImage = { schema: oldSchema };
const run = (images, options) => {
  const ops = fakeOps(images, options);
  return runProof({ ops, oldImage: OLD, newImage: NEW, mysqlImage: MYSQL }).then((record) => ({
    record,
    ops,
  }));
};
const byName = (record, name) => record.checks.find((c) => c.name === name);
const red = (record) => record.checks.filter((c) => !c.ok).map((c) => c.name);

describe('a candidate the old image can still serve', () => {
  it('is accepted, with every required check recorded once and green', async () => {
    const { record } = await run({
      [OLD]: oldImage,
      [NEW]: { schema: additive(oldSchema), migrate: additive },
    });
    assert.equal(record.outcome, 'accepted');
    assert.equal(record.ok, true);
    assert.deepEqual(record.checks.map((c) => c.name).sort(), [...REQUIRED_CHECKS].sort());
    assert.deepEqual(red(record), []);
    assert.deepEqual(record.findings, []);
    assert.deepEqual(record.warnings, []);
    assert.deepEqual(verifyReport(record, { oldImage: OLD, newImage: NEW }), []);
  });

  it('boots the old image on the data the new image migrated, in that order', async () => {
    const { ops } = await run({
      [OLD]: oldImage,
      [NEW]: { schema: additive(oldSchema), migrate: additive },
    });
    const boots = ops.world.events.filter((e) => e.startsWith('boot '));
    assert.deepEqual(
      boots.map((e) => e.split(' ')[1]),
      ['old-seed', 'new', 'old-after']
    );
    const schemaAt = (label) =>
      JSON.parse(boots.find((e) => e.startsWith(`boot ${label} `)).slice(`boot ${label} `.length));
    assert.equal(
      schemaAt('old-seed').posts.subtitle,
      undefined,
      'the old image seeds an unmigrated database'
    );
    assert.ok(
      schemaAt('old-after').posts.subtitle,
      'the old image comes back on the migrated database'
    );
  });

  it('records how long the migration and the old image boot took', async () => {
    let t = 0;
    const ops = fakeOps({ [OLD]: oldImage, [NEW]: { schema: oldSchema } });
    const record = await runProof({
      ops,
      oldImage: OLD,
      newImage: NEW,
      mysqlImage: MYSQL,
      clock: () => (t += 10),
    });
    assert.ok(record.timings.newMigrateMs > 0);
    assert.ok(record.timings.oldBootMs > 0);
    assert.ok(record.timings.totalMs > record.timings.oldBootMs);
  });
});

const ROLLBACK_STEPS = [
  'schema-contract',
  'old-boots-on-migrated',
  'session-survives',
  'sign-in',
  'data-intact',
  'publish',
  'member-create',
];
const warned = (record) => record.warnings.map((w) => w.check);

describe('a candidate the old image cannot serve is warned about, not refused', () => {
  it('warns on a renamed column that no boot or smoke step reaches, naming it and the restore route', async () => {
    const { record } = await run({
      [OLD]: oldImage,
      [NEW]: { schema: renamed(oldSchema), migrate: renamed },
    });
    assert.equal(record.outcome, 'warned');
    assert.equal(record.ok, true, 'a warning does not refuse the candidate');
    assert.deepEqual(red(record), ['schema-contract']);
    assert.deepEqual(warned(record), ['schema-contract']);
    assert.match(record.warnings[0].detail, /email_batches\.provider_id/);
    assert.equal(record.warnings[0].route, RESTORE_ROUTE);
    assert.equal(record.rollbackRoute, RESTORE_ROUTE);
    assert.equal(byName(record, 'old-boots-on-migrated').ok, true, 'the boot alone looks healthy');
    assert.equal(byName(record, 'publish').ok, true);
    assert.equal(record.findings[0].kind, 'missing-column');
    assert.deepEqual(verifyReport(record, { oldImage: OLD, newImage: NEW }), []);
  });

  it('warns about an old image that will not boot on the migrated data, and says the rest did not run', async () => {
    const { record } = await run({
      [OLD]: {
        schema: oldSchema,
        bootError: (t) => (t.posts.subtitle ? 'unknown column subtitle' : undefined),
      },
      [NEW]: { schema: additive(oldSchema), migrate: additive },
    });
    assert.equal(record.outcome, 'warned');
    assert.equal(byName(record, 'old-boots-on-migrated').ok, false);
    assert.match(byName(record, 'old-boots-on-migrated').detail, /unknown column subtitle/);
    for (const name of ['session-survives', 'sign-in', 'data-intact', 'publish', 'member-create']) {
      assert.equal(byName(record, name).ok, false, `${name} cannot be green when nothing booted`);
      assert.equal(byName(record, name).detail, 'not run');
    }
    assert.deepEqual(
      warned(record),
      ROLLBACK_STEPS.filter((n) => n !== 'schema-contract')
    );
    assert.deepEqual(verifyReport(record, { oldImage: OLD, newImage: NEW }), []);
  });

  for (const step of ['publish', 'member-create', 'sign-in']) {
    it(`warns about an old image whose ${step} step fails after the rollback`, async () => {
      const control = await run({ [OLD]: oldImage, [NEW]: { schema: oldSchema } });
      assert.equal(control.record.outcome, 'accepted', 'the control: no fault, no warning');
      assert.deepEqual(control.record.warnings, []);
      const { record } = await run({
        [OLD]: { schema: oldSchema, fault: step },
        [NEW]: { schema: oldSchema },
      });
      assert.equal(record.outcome, 'warned');
      assert.equal(byName(record, step).ok, false);
      assert.ok(warned(record).includes(step));
    });
  }

  it('warns when the owner session opened before the upgrade is gone', async () => {
    const { record } = await run({
      [OLD]: oldImage,
      [NEW]: { schema: oldSchema, onBoot: (w) => w.cookies.clear() },
    });
    assert.equal(byName(record, 'session-survives').ok, false);
    assert.equal(record.outcome, 'warned');
  });

  it('warns when a post the old image seeded is gone after the migration', async () => {
    const { record } = await run({
      [OLD]: oldImage,
      [NEW]: { schema: oldSchema, onBoot: (w) => w.posts.delete('rollback-proof-seed') },
    });
    assert.equal(byName(record, 'data-intact').ok, false);
    assert.match(byName(record, 'data-intact').detail, /rollback-proof-seed is missing/);
    assert.equal(record.outcome, 'warned');
  });

  it('does not trust "renders" when a never-published page also answers 200', async () => {
    const { record } = await run(
      { [OLD]: oldImage, [NEW]: { schema: oldSchema } },
      { everythingRenders: true }
    );
    assert.equal(byName(record, 'data-intact').ok, false);
    assert.match(byName(record, 'data-intact').detail, /never-published control/);
  });
});

describe('a candidate that is itself broken is still refused', () => {
  it('refuses a new image that does not boot, and never tries the way back', async () => {
    const { record, ops } = await run({
      [OLD]: oldImage,
      [NEW]: { schema: oldSchema, bootError: () => 'migration failed' },
    });
    assert.equal(record.outcome, 'refused');
    assert.equal(record.ok, false);
    assert.equal(byName(record, 'new-boots').ok, false);
    assert.ok(!ops.world.events.some((e) => e.startsWith('boot old-after')));
    assert.deepEqual(red(record).sort(), [...REQUIRED_CHECKS].sort());
    assert.ok(
      verifyReport(record, { oldImage: OLD, newImage: NEW }).some((r) => /new-boots is red/.test(r))
    );
  });
});

describe('a run that cannot finish', () => {
  it('ends as an error, never as an acceptance', async () => {
    const { record } = await run(
      { [OLD]: oldImage, [NEW]: { schema: oldSchema } },
      { failOpen: 'docker is down' }
    );
    assert.equal(record.outcome, 'error');
    assert.equal(record.ok, false);
    assert.match(record.error, /docker is down/);
    assert.deepEqual(red(record).sort(), [...REQUIRED_CHECKS].sort());
  });

  it('ends as an error for an image it cannot find', async () => {
    const { record } = await run({ [OLD]: oldImage });
    assert.equal(record.outcome, 'error');
    assert.match(record.error, /no such image/);
  });

  it('always closes the session and removes every colour, on every outcome', async () => {
    for (const images of [
      { [OLD]: oldImage, [NEW]: { schema: oldSchema } },
      { [OLD]: oldImage, [NEW]: { schema: renamed(oldSchema), migrate: renamed } },
      { [OLD]: oldImage, [NEW]: { schema: oldSchema, bootError: () => 'boom' } },
    ]) {
      const { ops } = await run(images);
      const booted = ops.world.events
        .filter((e) => e.startsWith('boot '))
        .map((e) => e.split(' ')[1]);
      for (const label of booted)
        assert.ok(ops.world.events.includes(`remove ${label}`), `${label} removed`);
      assert.equal(ops.world.events.at(-1), 'close');
    }
  });
});

describe('verifyReport, the gate side', () => {
  const accepted = async () =>
    (await run({ [OLD]: oldImage, [NEW]: { schema: oldSchema } })).record;
  const warnedRecord = async () =>
    (await run({ [OLD]: oldImage, [NEW]: { schema: renamed(oldSchema), migrate: renamed } }))
      .record;
  const ask = (record) => verifyReport(record, { oldImage: OLD, newImage: NEW });

  it('accepts a good record for the same pair', async () => {
    assert.deepEqual(ask(await accepted()), []);
    assert.deepEqual(assessReport(await accepted(), { oldImage: OLD, newImage: NEW }).warnings, []);
  });

  it('accepts a warned record and hands back the warnings it recomputed', async () => {
    const result = assessReport(await warnedRecord(), { oldImage: OLD, newImage: NEW });
    assert.deepEqual(result.reasons, []);
    assert.deepEqual(
      result.warnings.map((w) => w.check),
      ['schema-contract']
    );
    assert.equal(result.warnings[0].route, RESTORE_ROUTE);
  });

  it('refuses a record made for another pair', async () => {
    const record = await accepted();
    assert.ok(
      ask({ ...record, new: { ref: 'ghost:other' } }).some((r) => /another new image/.test(r))
    );
    assert.ok(
      ask({ ...record, old: { ref: 'ghost:other' } }).some((r) => /another old image/.test(r))
    );
  });

  it('refuses a missing, repeated, unknown or red gate check, whatever the record says of itself', async () => {
    const record = await accepted();
    const without = { ...record, checks: record.checks.filter((c) => c.name !== 'publish') };
    assert.ok(ask(without).some((r) => /publish is missing/.test(r)));
    const twice = { ...record, checks: [...record.checks, record.checks[0]] };
    assert.ok(ask(twice).some((r) => /recorded 2 times/.test(r)));
    const extra = { ...record, checks: [...record.checks, { name: 'extra', ok: true }] };
    assert.ok(ask(extra).some((r) => /unknown check extra/.test(r)));
    const lying = {
      ...record,
      ok: true,
      checks: record.checks.map((c) =>
        c.name === 'new-boots' ? { ...c, ok: false, detail: 'x' } : c
      ),
    };
    assert.ok(ask(lying).some((r) => /new-boots is red/.test(r)));
    assert.ok(ask(lying).some((r) => /claims ok/.test(r)));
  });

  it('refuses a record that carries an error, or findings next to a green schema check', async () => {
    const record = await accepted();
    assert.ok(ask({ ...record, error: 'late failure' }).some((r) => /ended in an error/.test(r)));
    assert.ok(
      ask({ ...record, findings: [{ text: 'x' }] }).some((r) =>
        /finding\(s\) but schema-contract is green/.test(r)
      )
    );
  });

  it('refuses a warned record that no longer names the restore route', async () => {
    const record = await warnedRecord();
    const stripped = {
      ...record,
      warnings: record.warnings.map((w) => ({ ...w, route: undefined })),
    };
    assert.ok(ask(stripped).some((r) => /restore-from-backup/.test(r)));
    const gone = { ...record, warnings: [] };
    assert.ok(ask(gone).some((r) => /restore-from-backup/.test(r)));
    const noRoute = { ...record, rollbackRoute: undefined };
    assert.ok(ask(noRoute).some((r) => /restore-from-backup/.test(r)));
  });

  it('refuses a rollback check that did not run although the old image booted: a half-finished record', async () => {
    const record = await accepted();
    const half = {
      ...record,
      checks: record.checks.map((c) =>
        c.name === 'publish' ? { ...c, ok: false, detail: 'not run' } : c
      ),
      warnings: [{ check: 'publish', detail: 'not run', route: RESTORE_ROUTE }],
      rollbackRoute: RESTORE_ROUTE,
    };
    assert.ok(ask(half).some((r) => /publish did not run/.test(r)));
  });

  it('refuses things that are not records', () => {
    assert.deepEqual(ask(null), ['the record is not an object']);
    assert.ok(ask({}).length > 0);
    assert.ok(ask({ v: 2 }).some((r) => /unknown record version/.test(r)));
  });
});
