/**
 * The arrival, against a real Ghost from the built image: the emailed link
 * becomes a gate session, and the demo's owner is signed in to Ghost admin
 * through the SSO adapter with no password shown and no mail sent.
 *
 * What is real: Ghost, its SSO adapter, its session middleware and database,
 * its mail transport (to an SMTP sink), the gate's own request handler, ledger
 * and proof reader, and the access-log scanner. What stands in for Caddy is
 * `startEdge`, which does what the rendered Caddyfile does (see support.ts).
 *
 *   IMAGE=ghost-platform:ci pnpm run test:image
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { createFileLedger } from '../../src/usedTokens.js';
import {
  HOST,
  keys,
  LEASE_1,
  PASSPHRASE,
  SLOT,
  startArrivalHarness,
  type ArrivalHarness,
} from '../helpers/arrivalHarness.js';
import { importSabotaged } from '../helpers/sourceSabotage.js';
import { mintInvitation } from '../helpers/invitations.js';
import { Browser, Ghost, SmtpSink, sleep, startEdge } from './support.js';

const OWNER = 'owner@example.test';
const TENANT = 'demo-slug';
const SCANNER = join(
  import.meta.dirname,
  '../../../../demo-host/provision/scan_edge_access_log.py'
);
const BOOT_MS = 90_000;

let ghost: Ghost;
let sink: SmtpSink;
let real: ArrivalHarness;
let sabotaged: ArrivalHarness;
let realEdge: { port: number; close(): Promise<void> };
let sabotagedEdge: { port: number; close(): Promise<void> };
let scratch: string;
let logPath: string;

const nowSeconds = (): number => Math.floor(Date.now() / 1000);
const mint = (over: { exp?: number; iat?: number; host?: string; jti?: string } = {}): string =>
  mintInvitation(keys.privateKey, { host: HOST, sub: OWNER, aud: TENANT, ...over });
const gateSeconds = (h: ArrivalHarness): number => Math.floor(h.now.ms / 1000);
const tokenOf = (reply: { text: string }): string =>
  /name="t" value="([^"]+)"/.exec(reply.text)?.[1] ?? '';

/**
 * What the thing that proves a demo's mail path does, in the same terms: ask
 * this Ghost to send a message through its real transport, and write the
 * proof only if the message arrived. A broken path writes nothing.
 */
async function proveMailPath(h: ArrivalHarness): Promise<boolean> {
  const before = sink.messages.length;
  const sent = await ghost
    .direct('POST', '/ghost/api/admin/authentication/password_reset/', {
      password_reset: [{ email: OWNER }],
    })
    .catch(() => undefined);
  if (sent === undefined || sent.status >= 300) return false;
  for (let waited = 0; waited < 10_000; waited += 250) {
    if (sink.messages.slice(before).some((m) => m.to.includes(OWNER))) {
      h.proveMail(SLOT, LEASE_1, gateSeconds(h));
      return true;
    }
    await sleep(250);
  }
  return false;
}

async function meAs(browser: Browser): Promise<{ status: number; email: string | null }> {
  const reply = await browser.request('GET', '/ghost/api/admin/users/me/');
  const email = (JSON.parse(reply.text || '{}') as { users?: { email?: string }[] }).users?.[0]
    ?.email;
  return { status: reply.status, email: email ?? null };
}

function scan(...extra: string[]): { code: number | null; out: string } {
  const run = spawnSync('python3', [SCANNER, logPath, ...extra], { encoding: 'utf8' });
  return { code: run.status, out: run.stdout };
}

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'demo-arrival-'));
  logPath = join(scratch, 'edge-access.log');
  sink = await SmtpSink.start();
  ghost = await Ghost.start(
    {
      url: `https://${HOST}`,
      database__client: 'sqlite3',
      database__connection__filename: '/var/lib/ghost/content/data/ghost.db',
      privacy__useUpdateCheck: 'false',
      mail__transport: 'SMTP',
      mail__from: 'noreply@example.test',
      mail__options__host: 'host.docker.internal',
      mail__options__port: String(sink.port),
      mail__options__secure: 'false',
      mail__options__ignoreTLS: 'true',
      spam__user_reset__freeRetries: '50',
      BRANCHLEFT_ALLOW_LOCAL_STORAGE: 'true',
      storage__images__adapter: 'ScanningStorageAdapter',
      storage__images__wraps: 'LocalImagesStorage',
      storage__images__quarantinePath: '/var/lib/ghost/content/quarantine',
      storage__media__adapter: 'ScanningStorageAdapter',
      storage__media__wraps: 'LocalMediaStorage',
      storage__media__quarantinePath: '/var/lib/ghost/content/quarantine',
      storage__files__adapter: 'ScanningStorageAdapter',
      storage__files__wraps: 'LocalFilesStorage',
      storage__files__quarantinePath: '/var/lib/ghost/content/quarantine',
      adapters__sso__active: 'BreakGlassSSO',
      adapters__sso__BreakGlassSSO__publicKey: keys.publicKeyBase64,
      adapters__sso__BreakGlassSSO__tenant: TENANT,
      adapters__sso__BreakGlassSSO__supportIdentity: OWNER,
    },
    HOST,
    BOOT_MS
  );
  // The owner, made as the broker makes it: with a password nobody keeps.
  const setup = await ghost.direct('POST', '/ghost/api/admin/authentication/setup/', {
    setup: [
      {
        name: 'OWNER_NAME',
        email: OWNER,
        password: `${Math.random().toString(36).slice(2)}-${Date.now()}-unkept`,
        blogTitle: 'SITE_TITLE',
      },
    ],
  });
  expect(setup.status).toBe(201);

  // A gate whose ledger forgets, for the layering case below.
  const forgetful = await importSabotaged<{ createFileLedger: typeof createFileLedger }>(
    'usedTokens.ts',
    {
      'usedTokens.ts': (source) =>
        source
          .replace(
            '        await stat(join(dir, recordName(jti)));\n        return true;',
            '        await stat(join(dir, recordName(jti)));\n        return false;'
          )
          .replace(
            "if (isCode(err, 'EEXIST')) return false;",
            "if (isCode(err, 'EEXIST')) return true;"
          ),
    }
  );
  real = await startArrivalHarness({}, true, Date.now());
  sabotaged = await startArrivalHarness(
    { createFileLedger: forgetful.createFileLedger },
    true,
    Date.now()
  );
  realEdge = await startEdge({ gatePort: real.port, ghostPort: ghost.port, logPath });
  sabotagedEdge = await startEdge({ gatePort: sabotaged.port, ghostPort: ghost.port, logPath });
}, BOOT_MS + 180_000);

afterAll(async () => {
  await Promise.allSettled([
    realEdge?.close(),
    sabotagedEdge?.close(),
    real?.stop(),
    sabotaged?.stop(),
  ]);
  await sink?.stop();
  ghost?.remove();
  rmSync(scratch, { recursive: true, force: true });
});

describe('the demo owner arrives from the emailed link', () => {
  it('has no way in without a gate session: Ghost admin answers the gate, not Ghost', async () => {
    const stranger = new Browser(realEdge.port, HOST);
    const admin = await stranger.request('GET', '/ghost/');
    expect(admin.status).toBe(401);
    expect(admin.text).toContain('DEMO_GATE_PASSPHRASE_LABEL');
    expect(await stranger.request('GET', '/ghost/api/admin/users/me/')).toMatchObject({
      status: 401,
    });
  });

  it('does not say ready before the mail path is proved, and the link is not spent by asking', async () => {
    const token = mint();
    const visitor = new Browser(realEdge.port, HOST);
    const page = await visitor.request('GET', `/__gate/enter?t=${encodeURIComponent(token)}`);
    expect(page.status).toBe(503);
    expect(page.text).toContain('DEMO_ARRIVAL_NOT_READY');
    expect(page.text).not.toContain('DEMO_ARRIVAL_READY');
    const refused = await visitor.request('POST', '/__gate/enter', { t: token });
    expect(refused.status).toBe(503);
    expect(visitor.cookieNames).toEqual([]);
  });

  it('signs the owner in to Ghost admin: link, gate session, admin session, no mail, no password', async () => {
    expect(await proveMailPath(real)).toBe(true);
    const mailsBefore = sink.messages.length;
    const token = mint();
    const owner = new Browser(realEdge.port, HOST);

    // Following the link shows a form and spends nothing.
    const page = await owner.request('GET', `/__gate/enter?t=${encodeURIComponent(token)}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain('DEMO_ARRIVAL_READY');
    expect(tokenOf(page)).toBe(token);
    expect(
      (await owner.request('GET', `/__gate/enter?t=${encodeURIComponent(token)}`)).status
    ).toBe(200);
    expect(owner.cookieNames).toEqual([]);

    // The form's POST exchanges it for a gate session and sends the browser on to admin.
    const exchange = await owner.request('POST', '/__gate/enter', { t: token });
    expect(exchange.status).toBe(303);
    expect(owner.cookieNames).toEqual(['__Host-bl_demo_gate']);
    const location = exchange.headers.location ?? '';
    expect(location.startsWith('/ghost/?bl_break_glass=')).toBe(true);

    // Not signed in yet: the gate session alone is not an admin session.
    expect((await meAs(owner)).status).toBe(403);

    // Ghost's adapter turns the same token into an Administrator session.
    const admin = await owner.request('GET', location);
    expect(admin.status).toBe(302);
    expect(owner.cookieNames).toContain('ghost-admin-api-session');
    expect(await meAs(owner)).toEqual({ status: 200, email: OWNER });

    // The owner never saw a password, and Ghost's device verification sent no code.
    expect(sink.messages.length).toBe(mailsBefore);
    expect(await ghost.adapterLines()).toContain(
      'break-glass: token accepted for the configured identity'
    );
  });

  it('refuses a replayed link at the gate, and a replay straight at Ghost’s adapter', async () => {
    const token = mint();
    const first = new Browser(realEdge.port, HOST);
    expect((await first.request('POST', '/__gate/enter', { t: token })).status).toBe(303);
    await first.request('GET', `/ghost/?bl_break_glass=${encodeURIComponent(token)}`);
    expect((await meAs(first)).email).toBe(OWNER);

    // Another browser replays the exchange: refused at the gate, no session of any kind.
    const replay = new Browser(realEdge.port, HOST);
    const refused = await replay.request('POST', '/__gate/enter', { t: token });
    expect(refused.status).toBe(410);
    expect(refused.text).toContain('DEMO_ARRIVAL_LINK_USED');
    expect(replay.cookieNames).toEqual([]);
    expect(
      (await replay.request('GET', `/__gate/enter?t=${encodeURIComponent(token)}`)).status
    ).toBe(410);

    // A holder of a gate session who presents the used token to Ghost itself: the adapter refuses it too.
    const holder = new Browser(realEdge.port, HOST);
    expect((await holder.request('POST', '/__gate/enter', { t: mint() })).status).toBe(303);
    await holder.request('GET', `/ghost/?bl_break_glass=${encodeURIComponent(token)}`);
    expect(holder.cookieNames).not.toContain('ghost-admin-api-session');
    expect((await meAs(holder)).status).toBe(403);
    expect(await ghost.adapterLines()).toContain('break-glass: token refused (replay)');
  });

  it('sabotage: a gate whose ledger forgets lets the replay through the gate, and only Ghost’s adapter still stops it', async () => {
    await proveMailPath(sabotaged);
    const token = mint();
    const first = new Browser(sabotagedEdge.port, HOST);
    expect((await first.request('POST', '/__gate/enter', { t: token })).status).toBe(303);
    await first.request('GET', `/ghost/?bl_break_glass=${encodeURIComponent(token)}`);
    expect((await meAs(first)).email).toBe(OWNER);

    // RED at the gate: the used link is accepted a second time.
    const replay = new Browser(sabotagedEdge.port, HOST);
    const second = await replay.request('POST', '/__gate/enter', { t: token });
    expect(second.status).toBe(303);
    // The second control holds: no admin session for the replay.
    await replay.request('GET', second.headers.location ?? '/');
    expect((await meAs(replay)).status).toBe(403);

    // GREEN: the real gate refuses the same replay at the gate.
    const again = new Browser(realEdge.port, HOST);
    const real1 = mint();
    expect((await again.request('POST', '/__gate/enter', { t: real1 })).status).toBe(303);
    expect(
      (await new Browser(realEdge.port, HOST).request('POST', '/__gate/enter', { t: real1 })).status
    ).toBe(410);
  });

  it('refuses a link that has expired, with no session and no sign of Ghost', async () => {
    const token = mint({ exp: nowSeconds() + 120 });
    const visitor = new Browser(realEdge.port, HOST);
    expect(
      (await visitor.request('GET', `/__gate/enter?t=${encodeURIComponent(token)}`)).status
    ).toBe(200);
    const mailsBefore = sink.messages.length;
    real.now.ms += 130_000;
    try {
      real.proveMail(SLOT, LEASE_1, gateSeconds(real));
      const late = await visitor.request('POST', '/__gate/enter', { t: token });
      expect(late.status).toBe(401);
      expect(late.text).toContain('DEMO_ARRIVAL_LINK_EXPIRED');
      expect(visitor.cookieNames).toEqual([]);
      expect(sink.messages.length).toBe(mailsBefore);
    } finally {
      real.now.ms -= 130_000;
    }
  });

  it('refuses a link minted for another demo', async () => {
    const visitor = new Browser(realEdge.port, HOST);
    const refused = await visitor.request('POST', '/__gate/enter', {
      t: mint({ host: 'c3d4.demo.example' }),
    });
    expect(refused.status).toBe(401);
    expect(visitor.cookieNames).toEqual([]);
  });

  it('breaks the mail path and the page stops saying ready; mending it brings ready back', async () => {
    expect(await proveMailPath(real)).toBe(true);
    const ready = await new Browser(realEdge.port, HOST).request(
      'GET',
      `/__gate/enter?t=${encodeURIComponent(mint())}`
    );
    expect(ready.status).toBe(200);

    // The path breaks: Ghost's next send is refused, so no proof is renewed.
    await sink.pause();
    expect(await proveMailPath(real)).toBe(false);
    // The proof ages out: past its limit the page no longer says ready.
    real.now.ms += 700_000;
    try {
      const token = mintInvitation(
        keys.privateKey,
        { host: HOST, sub: OWNER, aud: TENANT },
        gateSeconds(real)
      );
      const broken = await new Browser(realEdge.port, HOST).request(
        'GET',
        `/__gate/enter?t=${encodeURIComponent(token)}`
      );
      expect(broken.status).toBe(503);
      expect(broken.text).toContain('DEMO_ARRIVAL_NOT_READY');
      expect(broken.text).not.toContain('DEMO_ARRIVAL_READY');

      // Mended: the prover succeeds again, and the page is ready again.
      await sink.resume();
      expect(await proveMailPath(real)).toBe(true);
      const mended = await new Browser(realEdge.port, HOST).request(
        'GET',
        `/__gate/enter?t=${encodeURIComponent(token)}`
      );
      expect(mended.status).toBe(200);
    } finally {
      real.now.ms -= 700_000;
    }
  });

  it('scan of the edge access log: clean after all of that, red the moment a passphrase is in a URL', async () => {
    const known = join(scratch, 'known-passphrases.txt');
    writeFileSync(known, `${PASSPHRASE}\n`);
    // The links, the gate session and the admin sign-in all went through this log.
    const clean = scan('--passphrase-file', known);
    expect({ code: clean.code, out: clean.out.split('\n')[0] }).toMatchObject({ code: 0 });
    expect(clean.out).toMatch(/^CLEAN: \d+ entries/);

    // RED: a passphrase put in a query string...
    const visitor = new Browser(realEdge.port, HOST);
    await visitor.request('GET', `/?passphrase=${encodeURIComponent(PASSPHRASE)}`);
    const byName = scan();
    expect(byName.code).toBe(1);
    expect(byName.out).toContain('a query parameter is named like a passphrase');
    expect(byName.out).not.toContain('horse');

    // ...and one pasted into a path under no particular name, found because it is a known one.
    rmSync(logPath);
    writeFileSync(logPath, '');
    await visitor.request('GET', '/clean-path');
    expect(scan('--passphrase-file', known).code).toBe(0);
    await visitor.request('GET', `/${PASSPHRASE.replace(/ /g, '-')}`);
    const byValue = scan('--passphrase-file', known);
    expect(byValue.code).toBe(1);
    expect(byValue.out).toContain('a known passphrase appears in the URL');
    expect(scan().code).toBe(0);
  });
});
