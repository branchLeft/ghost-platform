// The rollback proof: the old image must boot, and keep working, on data the
// new image has already migrated. Orchestration only; every docker, database
// and HTTP effect goes through `ops`, so the logic is tested against a fake
// and run for real by docker-ops.mjs.
import { checkContract } from './contract.mjs';

/** Every check a record must hold, each ok, for a candidate to be accepted. */
export const REQUIRED_CHECKS = Object.freeze([
  'new-boots',
  'schema-contract',
  'old-boots-on-migrated',
  'session-survives',
  'sign-in',
  'data-intact',
  'publish',
  'member-create',
]);

/**
 * What gates a candidate: red refuses it. The new image must boot on the old
 * data and take a write, and the data must survive (a seeded post that is gone
 * is lost data, broken behaviour, not a missing way back). A candidate that is
 * broken itself is never deployed.
 */
const GATE_CHECKS = Object.freeze(['new-boots', 'data-intact']);
/**
 * The rollback test. Upgrades are forward-only: the way back is the pre-upgrade
 * backup, so a red here is a warning that says so, not a refusal.
 */
export const ROLLBACK_CHECKS = Object.freeze(
  REQUIRED_CHECKS.filter((n) => !GATE_CHECKS.includes(n))
);
/** The only rollback route for a candidate whose way back is red. */
export const RESTORE_ROUTE = 'restore-from-backup';

const REPORT_VERSION = 1;
const OWNER = Object.freeze({
  email: 'owner-rollback-proof@example.test',
  password: 'Xk9-rollback-proof-owner-1234',
  name: 'OWNER_NAME',
  siteTitle: 'SITE_TITLE',
});
const SEED_POST = Object.freeze({
  slug: 'rollback-proof-seed',
  title: 'ROLLBACK_PROOF_SEED_TITLE',
  html: '<p>ROLLBACK_PROOF_SEED_BODY</p>',
  marker: 'ROLLBACK_PROOF_SEED_BODY',
});
const NEW_POST = Object.freeze({
  slug: 'rollback-proof-written-by-new',
  title: 'ROLLBACK_PROOF_NEW_TITLE',
  html: '<p>ROLLBACK_PROOF_NEW_BODY</p>',
  marker: 'ROLLBACK_PROOF_NEW_BODY',
});
const OLD_POST = Object.freeze({
  slug: 'rollback-proof-written-after-rollback',
  title: 'ROLLBACK_PROOF_AFTER_TITLE',
  html: '<p>ROLLBACK_PROOF_AFTER_BODY</p>',
  marker: 'ROLLBACK_PROOF_AFTER_BODY',
});
const NEVER_PUBLISHED_SLUG = 'rollback-proof-never-published';
const MEMBER = Object.freeze({ email: 'member-rollback-proof@example.test', name: 'MEMBER_NAME' });

const detailOf = (err) => (err instanceof Error ? err.message : String(err));

/**
 * Runs the proof and returns the record. Never throws: a harness failure ends
 * as `outcome: 'error'`, which is not an acceptance.
 *
 * `ops.open({ mysqlImage })` resolves to a session with
 * `startColour(image, label)`, `readLiveColumns()` and `close()`.
 * `ops.readOldSchema(image)` resolves to the image's schema tables as an object.
 * `ops.imageId(ref)` resolves to a stable id for the image.
 * A colour has `setupOwner(owner)`, `signIn(owner)`, `admin(cookie)`,
 * `page(path)` and `remove()`.
 */
export async function runProof({
  ops,
  oldImage,
  newImage,
  mysqlImage,
  profile = 'platform',
  clock = Date.now,
  log = () => {},
}) {
  const startedAt = clock();
  const record = {
    v: REPORT_VERSION,
    engine: 'mysql',
    old: { ref: oldImage },
    new: { ref: newImage },
    mysql: { ref: mysqlImage },
    profile,
    checks: [],
    findings: [],
    timings: {},
    outcome: 'error',
    ok: false,
  };
  const check = async (name, fn) => {
    const t0 = clock();
    try {
      const detail = await fn();
      record.checks.push({ name, ok: true, detail: detail ?? '', ms: clock() - t0 });
      log(`PASS ${name}`);
      return true;
    } catch (err) {
      record.checks.push({ name, ok: false, detail: detailOf(err), ms: clock() - t0 });
      log(`FAIL ${name}: ${detailOf(err)}`);
      return false;
    }
  };

  let session;
  try {
    record.old.id = await ops.imageId(oldImage);
    record.new.id = await ops.imageId(newImage);
    session = await ops.open({ mysqlImage });
    const seeded = await seedWithOld({ session, oldImage, log });
    const migrated = await migrateWithNew({ session, newImage, check, record, clock, log });
    if (migrated) {
      await check('schema-contract', async () => {
        const tables = await ops.readOldSchema(oldImage);
        const findings = checkContract(tables, seeded.columns, await session.readLiveColumns());
        record.findings = findings;
        if (findings.length > 0) {
          throw new Error(
            `${findings.length} way(s) the old image cannot use the migrated data: ${findings
              .map((f) => f.text)
              .join('; ')}`
          );
        }
        return 'the old image schema is satisfied by the migrated database';
      });
      await rollBack({ session, oldImage, seeded, check, record, clock, log });
    }
    record.outcome = 'complete';
  } catch (err) {
    record.error = detailOf(err);
    log(`ERROR ${record.error}`);
  } finally {
    if (session) {
      try {
        await session.close();
      } catch (err) {
        record.cleanupError = detailOf(err);
      }
    }
  }
  return finalise(record, startedAt, clock);
}

async function seedWithOld({ session, oldImage, log }) {
  const colour = await session.startColour(oldImage, 'old-seed');
  try {
    const cookie = await colour.setupOwner(OWNER);
    const admin = colour.admin(cookie);
    await admin.createPost(SEED_POST);
    log('seeded the old image with an owner and a post');
    // What the old image left, read before any newer image touches it.
    return { cookie, columns: await session.readLiveColumns() };
  } finally {
    await colour.remove();
  }
}

async function migrateWithNew({ session, newImage, check, record, clock, log }) {
  const t0 = clock();
  let colour;
  // The new image must boot on the old image's data and take a first write; a
  // new image that cannot is refused before the way back is even tried.
  const booted = await check('new-boots', async () => {
    colour = await session.startColour(newImage, 'new');
    const cookie = await colour.signIn(OWNER);
    await colour.admin(cookie).createPost(NEW_POST);
    log('the new image booted, migrated, and wrote a post of its own');
    return 'the new image booted on the old image data, migrated it and took a write';
  });
  record.timings.newMigrateMs = clock() - t0;
  if (colour !== undefined) await colour.remove();
  return booted;
}

async function rollBack({ session, oldImage, seeded, check, record, clock, log }) {
  const t0 = clock();
  let colour;
  const booted = await check('old-boots-on-migrated', async () => {
    colour = await session.startColour(oldImage, 'old-after');
    return 'the old image booted on the migrated data and answered 200';
  });
  record.timings.oldBootMs = clock() - t0;
  if (!booted) return;
  try {
    await check('session-survives', async () => {
      const status = await colour.admin(seeded.cookie).me();
      if (status !== 200) {
        throw new Error(`an owner session opened before the upgrade answered ${status}, not 200`);
      }
      return 'the pre-upgrade owner session still authenticates';
    });
    let cookie;
    await check('sign-in', async () => {
      cookie = await colour.signIn(OWNER);
      return 'a fresh owner sign-in succeeds';
    });
    await check('data-intact', async () => {
      const admin = colour.admin(seeded.cookie);
      const slugs = (await admin.listPosts()).map((p) => p.slug);
      for (const post of [SEED_POST, NEW_POST]) {
        if (!slugs.includes(post.slug)) throw new Error(`post ${post.slug} is missing`);
        const page = await colour.page(`/${post.slug}/`);
        if (page.status !== 200 || !page.text.includes(post.marker)) {
          throw new Error(`post ${post.slug} does not render (HTTP ${page.status})`);
        }
      }
      // Control: a page that was never published must not answer, or "renders" proves nothing.
      const absent = await colour.page(`/${NEVER_PUBLISHED_SLUG}/`);
      if (absent.status === 200) {
        throw new Error(
          'the never-published control page answered 200, so rendering proves nothing'
        );
      }
      return 'the seeded post and the post the new image wrote are listed and render';
    });
    await check('publish', async () => {
      if (cookie === undefined) throw new Error('no sign-in, so nothing can be published');
      await colour.admin(cookie).createPost(OLD_POST);
      const page = await colour.page(`/${OLD_POST.slug}/`);
      if (page.status !== 200 || !page.text.includes('ROLLBACK_PROOF_AFTER_BODY')) {
        throw new Error(
          `a post published after the rollback does not render (HTTP ${page.status})`
        );
      }
      return 'a post published on the old image renders';
    });
    await check('member-create', async () => {
      if (cookie === undefined) throw new Error('no sign-in, so no member can be created');
      await colour.admin(cookie).createMember(MEMBER);
      return 'a member can be created';
    });
    log('smoke set finished');
  } finally {
    await colour.remove();
  }
}

function finalise(record, startedAt, clock) {
  for (const name of REQUIRED_CHECKS) {
    if (!record.checks.some((c) => c.name === name)) {
      record.checks.push({ name, ok: false, detail: 'not run', ms: 0 });
    }
  }
  record.timings.totalMs = clock() - startedAt;
  const { reasons, warnings } = recompute(record);
  record.warnings = warnings;
  if (warnings.length > 0) record.rollbackRoute = RESTORE_ROUTE;
  record.ok = reasons.length === 0;
  if (!record.ok) record.outcome = record.error !== undefined ? 'error' : 'refused';
  else record.outcome = warnings.length > 0 ? 'warned' : 'accepted';
  return record;
}

/**
 * Reads the checks, never `ok`, and returns the reasons the candidate is
 * refused and the warnings it is accepted with. A rollback check that is red
 * is a warning; a rollback check that did not run is one only because the old
 * image did not boot, otherwise the record is half-finished and is refused.
 */
function recompute(record) {
  const reasons = [];
  const warnings = [];
  const checks = Array.isArray(record.checks) ? record.checks : [];
  const hitsFor = (name) => checks.filter((c) => c?.name === name);
  const oldBoot = hitsFor('old-boots-on-migrated')[0];
  const cascade = oldBoot?.ok === false && oldBoot.detail !== 'not run';
  const warn = (name, detail) => warnings.push({ check: name, detail, route: RESTORE_ROUTE });
  for (const name of REQUIRED_CHECKS) {
    const hits = hitsFor(name);
    const unrun = hits[0]?.detail === 'not run';
    // The checks after the old image's boot cannot run when it did not boot.
    const cascaded = unrun && cascade && name !== 'schema-contract';
    if (hits.length === 0) reasons.push(`required check ${name} is missing`);
    else if (hits.length > 1) reasons.push(`check ${name} is recorded ${hits.length} times`);
    else if (hits[0].ok === true) continue;
    else if (cascaded) warn(name, hits[0].detail);
    else if (GATE_CHECKS.includes(name)) reasons.push(`${name} is red: ${hits[0].detail}`);
    else if (unrun)
      reasons.push(`${name} did not run although the old image booted: the record is unfinished`);
    else warn(name, hits[0].detail);
  }
  for (const c of checks) {
    if (!REQUIRED_CHECKS.includes(c?.name)) reasons.push(`unknown check ${String(c?.name)}`);
  }
  if (record.error !== undefined) reasons.push(`the run ended in an error: ${record.error}`);
  const schemaGreen = hitsFor('schema-contract')[0]?.ok === true;
  if (Array.isArray(record.findings) && record.findings.length > 0 && schemaGreen) {
    reasons.push(`${record.findings.length} schema finding(s) but schema-contract is green`);
  }
  return { reasons, warnings };
}

/** True when the record names, for every warning, the one rollback route. */
function namesRestoreRoute(record, warnings) {
  if (warnings.length === 0) return true;
  if (record.rollbackRoute !== RESTORE_ROUTE || !Array.isArray(record.warnings)) return false;
  return warnings.every((w) =>
    record.warnings.some((r) => r?.check === w.check && r.route === RESTORE_ROUTE)
  );
}

/**
 * What the gate calls on a stored record: the reasons to refuse the pair (empty
 * means accepted) and the warnings it is accepted with, recomputed from the
 * checks. Refuses another pair's record, a red gate check, a missing, repeated
 * or unknown check, an unfinished or errored run, a record whose own `ok`
 * disagrees with its checks, and a record that warns without naming the
 * restore route.
 */
export function assessReport(record, { oldImage, newImage }) {
  if (record === null || typeof record !== 'object') {
    return { reasons: ['the record is not an object'], warnings: [] };
  }
  const reasons = [];
  if (record.v !== REPORT_VERSION) reasons.push(`unknown record version ${String(record.v)}`);
  if (record.old?.ref !== oldImage) reasons.push(`the record is for another old image`);
  if (record.new?.ref !== newImage) reasons.push(`the record is for another new image`);
  const found = recompute(record);
  reasons.push(...found.reasons);
  if (!namesRestoreRoute(record, found.warnings)) {
    reasons.push(`the record warns without naming the rollback route, ${RESTORE_ROUTE}`);
  }
  if (record.ok === true && reasons.length > 0)
    reasons.push('the record claims ok and its checks disagree');
  return { reasons, warnings: found.warnings };
}

/** The reasons to refuse the pair, or an empty list. */
export function verifyReport(record, pair) {
  return assessReport(record, pair).reasons;
}
