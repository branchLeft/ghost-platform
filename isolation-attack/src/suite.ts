// The run: stand up the target, plant the attacker's content, run every case
// with the controls in place, then switch each control off in turn and run its
// case again, which must go red. A case whose sabotage does not go red cannot
// see its own control, and is reported as such rather than trusted.

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { chromium, type Browser } from 'playwright';
import { attackCookieBomb } from './attacks/cookieBomb.ts';
import { attackCookieTossing } from './attacks/cookieTossing.ts';
import { attackCrossSite } from './attacks/crossSite.ts';
import { attackInlineScript } from './attacks/inlineScript.ts';
import { attackPortalHostCookies } from './attacks/portalHostCookies.ts';
import { attackThemeScript } from './attacks/themeScript.ts';
import { attackUploadedScript } from './attacks/uploadedScript.ts';
import { CASE_SPECS, specOf } from './cases.ts';
import { GhostAdmin } from './ghostAdmin.ts';
import { http } from './http.ts';
import type {
  CaseId,
  CaseResult,
  ImageRecord,
  Judgement,
  RunResult,
  SabotageMode,
  SabotageResult,
  TargetRecord,
} from './model.ts';
import type { AttackerContext } from './payloads.ts';
import { plant } from './plant.ts';
import { LocalRig, PORTAL_HOST, REPO_ROOT, ROOT_DOMAIN, SHARED_DOMAIN } from './rig/localRig.ts';
import {
  PORTAL_LOGIN_PATH,
  PORTAL_SIGNED_IN_PATH,
  PORTAL_WHOAMI_PATH,
  startEvilServer,
  startPortalStub,
  type EvilServer,
  type PortalStub,
} from './rig/servers.ts';
import type { DeployedTarget, Target } from './target.ts';
import {
  judgeCookieBomb,
  judgeCookieTossing,
  judgeCrossSite,
  judgeInlineScript,
  judgePortalHostCookies,
  judgeThemeScript,
  judgeUploadedScript,
} from './verdicts.ts';
import type { EvilHandle, PortalHandle, TenantHandle, World } from './world.ts';

const git = promisify(execFile);

type Log = (line: string) => void;

const SESSION_COOKIE = 'ghost-admin-api-session';

interface Stand {
  readonly world: World;
  readonly targetRecord: TargetRecord;
  readonly images: () => Promise<ImageRecord[]>;
  /** Switches a control off, or restores them all with null. Null where the target cannot be changed. */
  readonly setSabotage: ((mode: SabotageMode | null) => Promise<void>) | null;
  readonly stop: () => Promise<void>;
}

function evilHandle(server: EvilServer): EvilHandle {
  const origin = `http://evil.localhost:${server.port}`;
  return {
    origin,
    seen: server.seen,
  };
}

async function standUpLocal(browser: Browser, log: Log, evil: EvilServer): Promise<Stand> {
  const rig = await LocalRig.start(log);
  const stub: PortalStub = await startPortalStub({ hostPrefixed: true });
  try {
    const portal: PortalHandle = {
      host: PORTAL_HOST,
      origin: `http://${PORTAL_HOST}:${stub.port}`,
      loginPath: PORTAL_LOGIN_PATH,
      signedInPath: PORTAL_SIGNED_IN_PATH,
      whoamiPath: PORTAL_WHOAMI_PATH,
    };
    const attacker = attackerContext(SHARED_DOMAIN, ROOT_DOMAIN);
    const planted = await plant(rig.b, rig.a, attacker);
    const world: World = {
      browser,
      a: rig.a,
      b: rig.b,
      portal,
      evil: evilHandle(evil),
      attacker,
      psl: 'absent',
      planted,
    };
    return {
      world,
      targetRecord: {
        kind: 'local-rig',
        sharedDomain: SHARED_DOMAIN,
        rootDomain: ROOT_DOMAIN,
        tenantHosts: [rig.a.host, rig.b.host],
        portalHost: PORTAL_HOST,
        psl: 'absent',
      },
      images: () => rig.imageRecords(),
      setSabotage: async (mode) => {
        stub.setHostPrefixed(mode !== 'portal-prefix-off');
        // The portal stand-in is not behind the edge: its sabotage leaves the edge alone.
        if (mode === 'portal-prefix-off') return;
        await rig.setMode(mode === null ? 'full' : mode);
        await assertEdgeState(rig, mode);
      },
      stop: async () => {
        await stub.close();
        await rig.stop();
      },
    };
  } catch (error) {
    await stub.close();
    await rig.stop();
    throw error;
  }
}

/** Proves a switched-off control is really off (and a restored one really on) from what the edge sends. */
async function assertEdgeState(rig: LocalRig, mode: SabotageMode | null): Promise<void> {
  const csp = await rig.servedPolicy(rig.a);
  const guarded = (await http(`${rig.a.origin}/content/files/probe.js`)).status === 403;
  const wantCsp = mode !== 'no-csp';
  const wantGuard = mode !== 'no-upload-guard';
  if ((csp !== null) !== wantCsp)
    throw new Error(
      `the edge ${wantCsp ? 'sent no' : 'still sent a'} content policy in mode ${mode ?? 'full'}`
    );
  if (guarded !== wantGuard)
    throw new Error(`the upload refusal is ${guarded ? 'on' : 'off'} in mode ${mode ?? 'full'}`);
  if (wantCsp && csp !== null && !csp.includes("script-src 'self' 'sha256-")) {
    throw new Error(
      'the edge policy carries no theme hashes: it is not the enforcing policy under test'
    );
  }
}

async function standUpDeployed(
  browser: Browser,
  target: DeployedTarget,
  evil: EvilServer
): Promise<Stand> {
  const handle = async (label: string, creds: DeployedTarget['adminA']): Promise<TenantHandle> => {
    const host = `${label}.${target.sharedDomain}`;
    const origin = `${target.scheme}://${host}`;
    const admin = new GhostAdmin(origin);
    await admin.login(creds);
    return { host, origin, secure: target.scheme === 'https', admin };
  };
  const a = await handle(target.tenantA, target.adminA);
  const b = await handle(target.tenantB, target.adminB);
  const attacker = attackerContext(target.sharedDomain, target.rootDomain);
  const portalUrl = new URL(target.portalOrigin);
  const portal: PortalHandle = {
    host: portalUrl.hostname,
    origin: target.portalOrigin,
    loginPath: target.portalLoginPath,
    signedInPath: null,
    whoamiPath: null,
  };
  const planted = await plant(b, a, attacker);
  const world: World = {
    browser,
    a,
    b,
    portal,
    evil: evilHandle(evil),
    attacker,
    psl: target.psl,
    planted,
  };
  return {
    world,
    targetRecord: {
      kind: 'deployed',
      sharedDomain: target.sharedDomain,
      rootDomain: target.rootDomain,
      tenantHosts: [a.host, b.host],
      portalHost: portal.host,
      psl: target.psl,
    },
    images: async () =>
      target.suppliedImages.map((reference) => ({
        role: 'Supplied by the operator',
        reference,
        imageId: null,
        repoDigests: [reference],
        source: 'supplied' as const,
      })),
    setSabotage: null,
    stop: async () => undefined,
  };
}

function attackerContext(sharedDomain: string, rootDomain: string): AttackerContext {
  return {
    value: `attacker-${randomBytes(6).toString('hex')}`,
    sharedDomain,
    rootDomain,
    sessionName: SESSION_COOKIE,
  };
}

type Driver = (world: World) => Promise<Judgement>;

const DRIVERS: Record<Exclude<CaseId, 'theme-script'>, Driver> = {
  'uploaded-script': async (w) => judgeUploadedScript(await attackUploadedScript(w)),
  'inline-script': async (w) => judgeInlineScript(await attackInlineScript(w)),
  'cookie-tossing': async (w) => judgeCookieTossing(await attackCookieTossing(w)),
  'portal-host-cookies': async (w) => judgePortalHostCookies(await attackPortalHostCookies(w)),
  'cookie-bomb': async (w) => judgeCookieBomb(await attackCookieBomb(w)),
  'cross-site-request': async (w) => judgeCrossSite(await attackCrossSite(w)),
};

let themeCounter = 0;
const themeDriver = (world: World): Promise<Judgement> => {
  themeCounter += 1;
  return attackThemeScript(world, `attack-suite-theme-${themeCounter}`).then(judgeThemeScript);
};

/**
 * A driver that throws has not shown the control held. It is recorded as not
 * exercised with the error, so one broken attack cannot cost the run's other
 * results, and still fails the suite.
 */
function driverOf(id: CaseId): Driver {
  const driver = id === 'theme-script' ? themeDriver : DRIVERS[id];
  return async (world) => {
    try {
      return await driver(world);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        verdict: 'not-exercised',
        summary: `the attack could not be driven: ${message.slice(0, 300)}`,
        vectors: [{ vector: 'driver', outcome: 'not-exercised', evidence: message.slice(0, 300) }],
      };
    }
  };
}

function sabotageResult(mode: SabotageMode, judgement: Judgement): SabotageResult {
  return {
    mode,
    verdict: judgement.verdict,
    wentRed: judgement.verdict === 'breached',
    summary: judgement.summary,
  };
}

export async function runSuite(target: Target, log: Log): Promise<RunResult> {
  const startedAt = new Date().toISOString();
  const evil = await startEvilServer();
  const browser = await chromium.launch();
  let stand: Stand | null = null;
  try {
    stand =
      target.kind === 'local'
        ? await standUpLocal(browser, log, evil)
        : await standUpDeployed(browser, target, evil);
    const { world } = stand;

    const green = new Map<CaseId, Judgement>();
    const red = new Map<CaseId, SabotageResult>();

    const order: CaseId[] = [
      'uploaded-script',
      'inline-script',
      'cookie-tossing',
      'portal-host-cookies',
      'cookie-bomb',
      'cross-site-request',
    ];
    for (const id of order) {
      log(`case ${id}, controls in place`);
      green.set(id, await driverOf(id)(world));
    }

    // Each sabotage runs in the phase its mode needs, then the controls are put back.
    const sabotagePhases: { mode: SabotageMode; ids: CaseId[] }[] = [
      { mode: 'no-upload-guard', ids: ['uploaded-script'] },
      { mode: 'no-csp', ids: ['inline-script', 'cookie-tossing', 'cookie-bomb'] },
      { mode: 'origin-spoof', ids: ['cross-site-request'] },
      { mode: 'portal-prefix-off', ids: ['portal-host-cookies'] },
    ];
    const sabotage = async (phase: { mode: SabotageMode; ids: CaseId[] }): Promise<void> => {
      if (stand?.setSabotage == null) return;
      await stand.setSabotage(phase.mode);
      for (const id of phase.ids) {
        log(`case ${id}, with ${phase.mode}`);
        red.set(id, sabotageResult(phase.mode, await driverOf(id)(world)));
      }
      await stand.setSabotage(null);
    };
    for (const phase of sabotagePhases) await sabotage(phase);

    // The hostile theme changes what tenant B serves, so it goes last.
    log('case theme-script, controls in place');
    green.set('theme-script', await driverOf('theme-script')(world));
    await sabotage({ mode: 'no-csp', ids: ['theme-script'] });

    const cases: CaseResult[] = CASE_SPECS.map((spec) => {
      const judgement = green.get(spec.id);
      if (judgement === undefined) throw new Error(`case ${spec.id} did not run`);
      return {
        ...judgement,
        id: spec.id,
        title: specOf(spec.id).title,
        control: spec.control,
        sabotage: red.get(spec.id) ?? null,
      };
    });

    const finishedAt = new Date().toISOString();
    return {
      schema: 1,
      startedAt,
      finishedAt,
      target: stand.targetRecord,
      images: await stand.images(),
      browser: { name: 'chromium', version: browser.version() },
      revision: await revision(),
      cases,
    };
  } finally {
    await browser.close().catch(() => undefined);
    await evil.close();
    await stand?.stop();
  }
}

async function revision(): Promise<string | null> {
  try {
    const { stdout } = await git('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT });
    return stdout.trim();
  } catch {
    return null;
  }
}
