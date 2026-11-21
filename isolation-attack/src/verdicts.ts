// The verdict on each case's observation: pure functions, no browser, no
// network. The case is judged on the harm it names, never on whether a payload
// looked blocked: a case whose attack did not reach the control is
// `not-exercised`, which fails the suite exactly as a breach does.

import type { Judgement, Residual, VectorResult } from './model.ts';
import type {
  BombObservation,
  CrossSiteObservation,
  InlineScriptObservation,
  PortalCookieObservation,
  ThemeObservation,
  TossObservation,
  UploadedScriptObservation,
} from './observations.ts';

function worst(vectors: readonly VectorResult[]): Judgement['verdict'] {
  if (vectors.some((v) => v.outcome === 'ran')) return 'breached';
  if (vectors.length === 0 || vectors.every((v) => v.outcome === 'not-exercised')) {
    return 'not-exercised';
  }
  return 'held';
}

const ATTACK_DIRECTIVES = new Set(['script-src', 'script-src-elem', 'script-src-attr']);

export function judgeUploadedScript(obs: UploadedScriptObservation): Judgement {
  const vectors: VectorResult[] = obs.vectors.map((v) => {
    if (!v.uploaded) {
      return {
        vector: v.name,
        outcome: 'not-exercised',
        evidence: `Ghost refused the upload (${v.uploadStatus}) before the edge saw it`,
      };
    }
    if (v.ran) {
      return {
        vector: v.name,
        outcome: 'ran',
        evidence: `the uploaded file executed (file status ${v.fileStatus})`,
      };
    }
    // A 404 means the file was not there to refuse: the edge did not do it.
    if (v.fileStatus !== 403) {
      return {
        vector: v.name,
        outcome: 'ran',
        evidence: `the edge did not refuse the uploaded file (file status ${v.fileStatus}, wanted 403)`,
      };
    }
    return { vector: v.name, outcome: 'blocked', evidence: 'the edge answered 403 for the file' };
  });
  const verdict = worst(vectors);
  const exercised = vectors.filter((v) => v.outcome !== 'not-exercised').length;
  return {
    verdict,
    vectors,
    summary:
      verdict === 'held'
        ? `${exercised} uploaded file type(s) refused by the edge, none executed`
        : verdict === 'breached'
          ? 'an uploaded file was served or executed on the shared domain'
          : 'no upload reached the edge, so the control was not tested',
  };
}

export function judgeInlineScript(obs: InlineScriptObservation): Judgement {
  const ran = Object.entries(obs.marks)
    .filter(([, set]) => set)
    .map(([name]) => name);
  const attackViolations = obs.violations.filter((v) => ATTACK_DIRECTIVES.has(v.directive));
  const vectors: VectorResult[] = [];
  if (ran.length > 0) {
    for (const name of ran) {
      vectors.push({ vector: name, outcome: 'ran', evidence: 'the injected script executed' });
    }
  } else if (attackViolations.length === 0) {
    vectors.push({
      vector: 'inline-injection',
      outcome: 'not-exercised',
      evidence: 'no script ran and no violation was reported, so the payload never reached a page',
    });
  } else {
    vectors.push({
      vector: 'inline-injection',
      outcome: 'blocked',
      evidence: `${attackViolations.length} script-src violation(s) reported, no mark set`,
    });
  }
  let verdict = worst(vectors);
  let summary =
    verdict === 'held'
      ? 'every injected inline script and handler was refused by the content policy'
      : verdict === 'breached'
        ? `injected script executed: ${ran.join(', ')}`
        : 'the payload never reached a page, so the control was not tested';
  // The control must not be a blunt wall: the page's own sign-in has to work.
  if (verdict === 'held' && (!obs.portalSignIn.rendered || obs.portalSignIn.emailFields < 1)) {
    verdict = 'breached';
    summary = "the policy blocked the attack but also broke Portal's sign-in form";
    vectors.push({
      vector: 'portal-sign-in',
      outcome: 'ran',
      evidence: 'the sign-in form did not render under the policy',
    });
  }
  return { verdict, summary, vectors };
}

function residualFromToss(obs: TossObservation): Residual {
  const r = obs.residual;
  if (r === null) return { status: 'not-measured', detail: 'the residual probe was not run' };
  if (obs.psl === 'present') {
    return r.sharedDomainWriteAccepted
      ? {
          status: 'breached',
          detail:
            'the list entry is stated to be in place yet the browser accepted a write to the shared domain',
        }
      : { status: 'held', detail: 'the browser refused a write to the shared domain' };
  }
  return r.sharedDomainWriteAccepted
    ? {
        status: 'accepted-risk',
        detail:
          `with script already running on a tenant, the browser accepted a shared-domain cookie` +
          ` (seen by the other tenant: ${r.seenByOtherTenant}, by the portal: ${r.seenByPortal}); only the Public Suffix List entry removes this`,
      }
    : { status: 'held', detail: 'the browser refused a write to the shared domain' };
}

export function judgeCookieTossing(obs: TossObservation): Judgement {
  const residual = residualFromToss(obs);
  if (obs.pagesVisited < 2) {
    return {
      verdict: 'not-exercised',
      summary: 'the sibling tenant pages were not visited',
      vectors: [
        { vector: 'sibling-tenant-script', outcome: 'not-exercised', evidence: 'no page visited' },
      ],
      residual,
    };
  }
  const tossed = obs.victimJar.filter(
    (c) => obs.attackerNames.includes(c.name) && c.value.includes(obs.attackerValue)
  );
  const sessionChanged = obs.sessionAfter !== obs.sessionBefore;
  const vectors: VectorResult[] = [];
  for (const c of tossed) {
    vectors.push({
      vector: c.name,
      outcome: 'ran',
      evidence: `the victim tenant would be sent the attacker's cookie (domain ${c.domain}, path ${c.path})`,
    });
  }
  if (sessionChanged) {
    vectors.push({
      vector: 'session-cookie',
      outcome: 'ran',
      evidence: "the victim tenant's own session cookie was replaced",
    });
  }
  if (vectors.length === 0) {
    vectors.push({
      vector: 'sibling-tenant-script',
      outcome: 'blocked',
      evidence: obs.scriptRan
        ? 'the sibling script ran but no cookie reached the victim tenant'
        : 'the sibling tenant script did not run, so no cookie was written',
    });
  }
  const verdict = vectors.some((v) => v.outcome === 'ran') ? 'breached' : 'held';
  return {
    verdict,
    vectors,
    residual,
    summary:
      verdict === 'held'
        ? 'no cookie from the sibling tenant reached the victim tenant'
        : 'a cookie written on the sibling tenant reached the victim tenant',
  };
}

export function judgePortalHostCookies(obs: PortalCookieObservation): Judgement {
  const vectors: VectorResult[] = [];
  if (obs.probes.length === 0) {
    return {
      verdict: 'not-exercised',
      summary: 'the portal set no cookie to attack',
      vectors: [{ vector: 'portal-cookies', outcome: 'not-exercised', evidence: 'none set' }],
    };
  }
  for (const p of obs.probes) {
    const problems: string[] = [];
    if (!p.name.startsWith('__Host-')) problems.push('the name lacks the __Host- prefix');
    if (!p.secure) problems.push('not Secure');
    if (p.path !== '/') problems.push(`Path is ${p.path}`);
    if (!p.hostOnly) problems.push('carries a Domain attribute');
    if (p.attackerValueInJar) problems.push("the attacker's value is in the jar under this name");
    if (p.jarValues.length !== 1 || p.jarValues[0] !== p.genuineValue) {
      problems.push(`the jar holds ${p.jarValues.length} value(s), not the one genuine value`);
    }
    vectors.push(
      problems.length === 0
        ? {
            vector: p.name,
            outcome: 'blocked',
            evidence: 'only the portal-set value is held under the prefixed name',
          }
        : { vector: p.name, outcome: 'ran', evidence: problems.join('; ') }
    );
  }
  if (obs.sessionRead !== null && obs.sessionRead.seen !== obs.sessionRead.genuine) {
    vectors.push({
      vector: 'portal-session-read',
      outcome: 'ran',
      evidence: `the portal read a session value that was not its own (${obs.sessionRead.seen === null ? 'none' : 'attacker-supplied'})`,
    });
  }
  const verdict = worst(vectors);
  return {
    verdict,
    vectors,
    summary:
      verdict === 'held'
        ? `${obs.probes.length} portal cookie(s) are __Host- pinned and none could be overwritten or shadowed` +
          (obs.twinsAccepted.length > 0
            ? ` (the browser accepted ${obs.twinsAccepted.length} unprefixed twin(s); the portal reads none of them)`
            : '')
        : 'a portal cookie could be written, replaced or shadowed from a sibling origin',
  };
}

export function judgeCookieBomb(obs: BombObservation): Judgement {
  let residual: Residual;
  if (obs.residual === null) {
    residual = { status: 'not-measured', detail: 'the oversize-cookie probe was not run' };
  } else if (obs.psl === 'present') {
    residual = obs.residual.sharedDomainWriteAccepted
      ? {
          status: 'breached',
          detail:
            'the list entry is stated to be in place yet the shared-domain cookies were accepted',
        }
      : { status: 'held', detail: 'the browser refused the shared-domain cookies' };
  } else if (obs.residual.sharedDomainWriteAccepted) {
    residual = {
      status: 'accepted-risk',
      detail:
        `${obs.residual.cookieBytes} bytes of shared-domain cookies were accepted; the next request to the ` +
        `other tenant answered ${obs.residual.statusWithBomb ?? 'no HTTP response (the connection was refused or reset)'}, and ` +
        `${obs.residual.statusAfterClear ?? 'no HTTP response'} once the cookies were cleared`,
    };
  } else {
    residual = { status: 'held', detail: 'the browser refused the shared-domain cookies' };
  }
  if (obs.pagesVisited < 2) {
    return {
      verdict: 'not-exercised',
      summary: 'the sibling tenant pages were not visited',
      vectors: [{ vector: 'sibling-tenant-script', outcome: 'not-exercised', evidence: 'no page' }],
      residual,
    };
  }
  const vectors: VectorResult[] = [];
  if (obs.bombBytesInVictimJar > 0 || obs.victimStatus !== 200) {
    vectors.push({
      vector: 'sibling-tenant-script',
      outcome: 'ran',
      evidence: `the victim tenant answered ${obs.victimStatus ?? 'nothing'} with ${obs.bombBytesInVictimJar} bytes of attacker cookies in its jar`,
    });
  } else {
    vectors.push({
      vector: 'sibling-tenant-script',
      outcome: 'blocked',
      evidence: obs.scriptRan
        ? 'the script ran but wrote nothing the victim tenant is sent'
        : 'the sibling script did not run, so no cookie was written',
    });
  }
  const verdict = worst(vectors);
  return {
    verdict,
    vectors,
    residual,
    summary:
      verdict === 'held'
        ? 'the victim tenant still answers 200 after the sibling tenant pages were visited'
        : 'the sibling tenant could make the victim tenant refuse its reader',
  };
}

export function judgeCrossSite(obs: CrossSiteObservation): Judgement {
  const vectors: VectorResult[] = obs.vectors.map((v) => {
    if (v.requestsToVictim === 0) {
      return {
        vector: v.name,
        outcome: 'not-exercised',
        evidence: 'the browser sent no request to the victim tenant',
      };
    }
    return {
      vector: v.name,
      outcome: 'blocked',
      evidence: `${v.origin} request(s) answered ${v.statuses.join(', ')}`,
    };
  });
  if (obs.postsAfter !== obs.postsBefore) {
    vectors.push({
      vector: 'state-change',
      outcome: 'ran',
      evidence: `the victim tenant's post count went from ${obs.postsBefore} to ${obs.postsAfter}`,
    });
  }
  const verdict = worst(vectors);
  return {
    verdict,
    vectors,
    summary:
      verdict === 'held'
        ? 'forged cross-origin requests changed nothing on the victim tenant'
        : verdict === 'breached'
          ? 'a forged cross-origin request changed state on the victim tenant'
          : 'no forged request reached the victim tenant',
  };
}

export function judgeThemeScript(obs: ThemeObservation): Judgement {
  const vectors: VectorResult[] = [];
  if (obs.uploadStatus === 422) {
    // Ghost's own theme validation rejected the suite's zip: that is a fault in
    // the attack, not a control, and must not read as the platform holding.
    vectors.push({
      vector: 'theme-upload',
      outcome: 'not-exercised',
      evidence: 'Ghost rejected the theme as invalid (422), so no hostile theme was served',
    });
  } else if (obs.uploadStatus >= 400) {
    vectors.push({
      vector: 'theme-upload',
      outcome: 'blocked',
      evidence: `the hostile theme was refused at upload (${obs.uploadStatus})`,
    });
  } else if (obs.activateStatus !== null && obs.activateStatus >= 400) {
    vectors.push({
      vector: 'theme-activation',
      outcome: 'blocked',
      evidence: `the hostile theme was refused at activation (${obs.activateStatus})`,
    });
  } else {
    for (const v of obs.vectors) {
      vectors.push(
        v.ran
          ? {
              vector: v.name,
              outcome: 'ran',
              evidence: `the theme's script executed on the tenant's own origin (file status ${v.fileStatus})`,
            }
          : {
              vector: v.name,
              outcome: 'blocked',
              evidence: `the theme's script did not execute (file status ${v.fileStatus})`,
            }
      );
    }
  }
  const verdict = worst(vectors);
  return {
    verdict,
    vectors,
    summary:
      verdict === 'held'
        ? 'a hostile theme could not run script on the shared domain'
        : verdict === 'breached'
          ? 'a tenant-supplied theme ran script on the shared domain'
          : 'the hostile theme never reached a page',
  };
}
