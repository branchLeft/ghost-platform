// The mail gate: a candidate Ghost image must complete a real send through its
// own spool before it is promoted. It boots the candidate beside a mail spool,
// requests a magic link and sends a one-recipient newsletter to a harness
// address, then drains the spool. The gate passes only when both messages are
// in the spool's queue, from the slot's own domain. Nothing leaves the spool.
// Usage: node scripts/mail-gate/mail-gate.mjs <candidate-image>   (exit 0 = pass)
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { docker, pollHttp200, reservePort, sleep } from '../../test-support/image-harness.mjs';
import {
  GhostContainer,
  LABEL,
  SITE_URL,
  createNetwork,
  dockerOk,
  removeNetwork,
  uniqueName,
} from '../../adapters/scanning-storage/test/helpers/docker-ghost.mjs';

// The pinned digest the demo host's spool runs (scripts/test-demo-mail-spool.sh).
export const PINNED_SPOOL =
  'ghcr.io/branchleft/mailgun-shim@sha256:c32a32e93025aeb2b397b5dbf8e8b17e59256f56e3e881ffc49c71f6b8965571';
export const SLOT_DOMAIN = 'gate-slot0.example.com';
export const HARNESS_ADDRESS = 'harness@example.com';
const DRAIN_DEADLINE_MS = 120_000;

// The entrypoint refuses to boot Ghost unless every storage feature goes
// through the scanning decorator. The gate uses the local stand-ins the image
// tests use, with the in-process verdict source.
function storageEnv() {
  const env = { BRANCHLEFT_ALLOW_LOCAL_STORAGE: 'true' };
  for (const [feature, wraps] of [
    ['images', 'LocalImagesStorage'],
    ['media', 'LocalMediaStorage'],
    ['files', 'LocalFilesStorage'],
  ]) {
    env[`storage__${feature}__adapter`] = 'ScanningStorageAdapter';
    env[`storage__${feature}__verdictSource`] = 'in-process-fake';
    env[`storage__${feature}__wraps`] = wraps;
    env[`storage__${feature}__quarantinePath`] = '/var/lib/ghost/content/quarantine';
  }
  return env;
}

async function drainUntil(port, token, done, deadline) {
  const seen = [];
  const auth = { authorization: `Bearer ${token}` };
  while (Date.now() < deadline && !done(seen)) {
    const { messages } = await (
      await fetch(`http://127.0.0.1:${port}/drain`, { headers: auth })
    ).json();
    if (messages.length === 0) {
      await sleep(500);
      continue;
    }
    seen.push(...messages);
    await fetch(`http://127.0.0.1:${port}/drain/ack`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ acks: messages.map((m) => ({ id: m.id, drainCount: m.drainCount })) }),
    });
  }
  return seen;
}

/**
 * Runs the gate. Never throws: a setup failure is a failed check, so the
 * caller always gets { passed, durationMs, checks }.
 * `transactionalHost` is where the candidate's SMTP transport points; the
 * default is the slot's spool. The control case points it elsewhere.
 */
export async function runMailGate({
  image,
  spoolImage = PINNED_SPOOL,
  transactionalHost = 'mail-spool',
  deadlineMs = DRAIN_DEADLINE_MS,
}) {
  const started = Date.now();
  const checks = [];
  const check = (name, ok, detail = '') => checks.push({ name, ok: Boolean(ok), detail });
  const net = uniqueName('mail-gate-net');
  const spool = uniqueName('mail-gate-spool');
  const token = crypto.randomBytes(24).toString('hex');
  const marker = `gate-${crypto.randomBytes(6).toString('hex')}`;
  let ghost = null;
  try {
    const drainPort = await reservePort();
    createNetwork(net);
    docker(
      'run',
      '-d',
      '--name',
      spool,
      '--label',
      LABEL,
      '--network',
      net,
      '--network-alias',
      'mail-spool',
      '--user',
      '31000:31000',
      '--read-only',
      '--tmpfs',
      '/data:rw,uid=31000,gid=31000,mode=0700',
      '-e',
      'PORT=8080',
      '-e',
      'SHIM_DRAIN_PORT=8081',
      '-e',
      'SMTP_LISTEN_PORT=2525',
      '-e',
      'SHIM_DB_PATH=/data/spool.sqlite',
      '-e',
      `SHIM_DRAIN_TOKEN=${token}`,
      '-p',
      `127.0.0.1:${drainPort}:8081`,
      spoolImage
    );
    const spoolUp = await pollHttp200(`http://127.0.0.1:${drainPort}/metrics`, {
      containerName: spool,
      deadlineMs: 90_000,
    });
    check('the spool started and answers on its drain port', spoolUp.ok, spoolUp.detail);
    if (!spoolUp.ok) throw new Error('spool did not start');

    const key = docker(
      'exec',
      spool,
      'node',
      'dist/cli.js',
      'register',
      SLOT_DOMAIN,
      '--sender-domain',
      SLOT_DOMAIN
    )
      .trim()
      .split('\n')
      .pop();
    ghost = await GhostContainer.start(
      image,
      {
        ...storageEnv(),
        mail__transport: 'SMTP',
        mail__from: `noreply@${SLOT_DOMAIN}`,
        mail__options__host: transactionalHost,
        mail__options__port: '2525',
        mail__options__secure: 'false',
        mail__options__ignoreTLS: 'true',
        mail__options__auth__user: SLOT_DOMAIN,
        mail__options__auth__pass: key,
        bulkEmail__mailgun__baseUrl: 'http://mail-spool:8080/v3',
        bulkEmail__mailgun__domain: SLOT_DOMAIN,
        bulkEmail__mailgun__apiKey: key,
      },
      { network: net }
    );
    check('the candidate Ghost answers 200 on its own health path', ghost.booted, ghost.bootDetail);
    if (!ghost.booted) throw new Error('candidate Ghost did not boot');
    await ghost.setupOwner();
    await ghost.login();

    const member = await ghost.json('POST', 'members/', {
      members: [{ email: HARNESS_ADDRESS, name: 'Gate' }],
    });
    check(
      'the harness member exists on the candidate',
      member.status === 201,
      `HTTP ${member.status}`
    );

    // Ghost refuses a magic-link request without an integrity token from GET /members/api/integrity-token.
    const integrityToken = await (await fetch(`${ghost.base}/members/api/integrity-token`)).text();
    const magic = await fetch(`${ghost.base}/members/api/send-magic-link/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: SITE_URL },
      body: JSON.stringify({ email: HARNESS_ADDRESS, emailType: 'signin', integrityToken }),
    });
    const magicBody = (await magic.text()).slice(0, 200);
    check(
      'the magic link was requested',
      magic.status >= 200 && magic.status < 300,
      `HTTP ${magic.status} ${magicBody}`
    );

    const created = await ghost.json('POST', 'posts/?source=html', {
      posts: [{ title: `Gate ${marker}`, html: '<p>Gate</p>', status: 'draft' }],
    });
    const post = created.body?.posts?.[0];
    // Ghost reads the send's newsletter and audience from the query string, not the body.
    const newsletters = await ghost.get('newsletters/');
    const newsletterSlug = newsletters.body?.newsletters?.[0]?.slug;
    const segment = new URLSearchParams({
      source: 'html',
      newsletter: newsletterSlug,
      email_segment: `email:'${HARNESS_ADDRESS}'`,
    });
    const sent = await ghost.json('PUT', `posts/${post?.id}/?${segment}`, {
      posts: [{ status: 'published', updated_at: post?.updated_at }],
    });
    check(
      'the one-recipient newsletter was published for sending',
      sent.status === 200,
      `HTTP ${sent.status}`
    );

    // A From header may carry a display name: "Site" <noreply@slot domain>.
    const addressOf = (from) => /<([^>]+)>/.exec(from)?.[1] ?? from.trim();
    const isHarness = (m) =>
      m.to === HARNESS_ADDRESS &&
      m.domain === SLOT_DOMAIN &&
      addressOf(m.from).endsWith(`@${SLOT_DOMAIN}`);
    const drained = await drainUntil(
      drainPort,
      token,
      (seen) =>
        seen.some((m) => isHarness(m) && m.subject.includes(marker)) &&
        seen.some((m) => isHarness(m) && !m.subject.includes(marker)),
      Date.now() + deadlineMs
    );
    const newsletter = drained.find((m) => isHarness(m) && m.subject.includes(marker));
    const link = drained.find((m) => isHarness(m) && !m.subject.includes(marker));
    const shape = (m) => `to ${m.to}, from ${m.from}, domain ${m.domain}, subject "${m.subject}"`;
    check(
      'the newsletter is in the spool, from the slot domain',
      Boolean(newsletter),
      newsletter ? shape(newsletter) : drained.map(shape).join('; ') || 'nothing drained'
    );
    check(
      'the magic link is in the spool, from the slot domain',
      Boolean(link),
      link ? `subject "${link.subject}"` : 'none drained for the harness address'
    );
  } catch (err) {
    check('the gate ran to completion', false, err.message);
  } finally {
    if (ghost) ghost.stop();
    dockerOk('rm', '-f', '-v', spool);
    removeNetwork(net);
  }
  return {
    passed: checks.length > 0 && checks.every((c) => c.ok),
    durationMs: Date.now() - started,
    checks,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const image = process.argv[2];
  if (!image) {
    console.error('usage: node scripts/mail-gate/mail-gate.mjs <candidate-image>');
    process.exit(2);
  }
  const result = await runMailGate({
    image,
    spoolImage: process.env.MAIL_GATE_SPOOL_IMAGE || PINNED_SPOOL,
  });
  for (const c of result.checks)
    console.log(`${c.ok ? 'PASS' : 'FAIL'}: ${c.name}${c.detail ? ` (${c.detail})` : ''}`);
  console.log(
    `mail gate ${result.passed ? 'passed' : 'FAILED'} in ${(result.durationMs / 1000).toFixed(1)}s`
  );
  process.exit(result.passed ? 0 : 1);
}
