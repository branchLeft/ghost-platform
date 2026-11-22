import { describe, expect, it } from 'vitest';
import {
  judgeCookieBomb,
  judgeCookieTossing,
  judgeCrossSite,
  judgeInlineScript,
  judgePortalHostCookies,
  judgeThemeScript,
  judgeUploadedScript,
} from '../src/verdicts.ts';
import type {
  BombObservation,
  CookieView,
  CrossSiteObservation,
  InlineScriptObservation,
  PortalCookieObservation,
  ThemeObservation,
  TossObservation,
  UploadedScriptObservation,
} from '../src/observations.ts';

describe('uploaded script', () => {
  const held: UploadedScriptObservation = {
    vectors: [
      { name: 'js', uploaded: true, uploadStatus: 200, fileStatus: 403, ran: false },
      { name: 'svg', uploaded: false, uploadStatus: 415, fileStatus: null, ran: false },
    ],
  };
  it('holds when the edge answered 403 and nothing ran', () => {
    expect(judgeUploadedScript(held).verdict).toBe('held');
  });
  it('is breached when the file ran', () => {
    const obs = {
      vectors: [{ name: 'js', uploaded: true, uploadStatus: 200, fileStatus: 200, ran: true }],
    };
    expect(judgeUploadedScript(obs).verdict).toBe('breached');
  });
  it('is breached when the file was served even if it did not run', () => {
    const obs = {
      vectors: [{ name: 'js', uploaded: true, uploadStatus: 200, fileStatus: 200, ran: false }],
    };
    expect(judgeUploadedScript(obs).verdict).toBe('breached');
  });
  it('does not take a 404 for the edge refusing the file', () => {
    const obs = {
      vectors: [{ name: 'js', uploaded: true, uploadStatus: 200, fileStatus: 404, ran: false }],
    };
    expect(judgeUploadedScript(obs).verdict).toBe('breached');
  });
  it('is not exercised when Ghost refused every upload', () => {
    const obs = {
      vectors: [{ name: 'js', uploaded: false, uploadStatus: 503, fileStatus: null, ran: false }],
    };
    expect(judgeUploadedScript(obs).verdict).toBe('not-exercised');
  });
});

describe('inline script', () => {
  const base: InlineScriptObservation = {
    marks: {},
    violations: [{ directive: 'script-src-elem', blockedURI: 'inline' }],
    portalSignIn: { rendered: true, emailFields: 1 },
    pagesVisited: 2,
  };
  it('holds when nothing ran and the policy reported the attack', () => {
    expect(judgeInlineScript(base).verdict).toBe('held');
  });
  it('is breached when any injected script set its mark', () => {
    const j = judgeInlineScript({ ...base, marks: { head: true } });
    expect(j.verdict).toBe('breached');
    expect(j.summary).toContain('head');
  });
  it('is not exercised when no violation shows the payload reached a page', () => {
    expect(judgeInlineScript({ ...base, violations: [] }).verdict).toBe('not-exercised');
  });
  it('is breached when the policy also breaks the sign-in form', () => {
    const j = judgeInlineScript({ ...base, portalSignIn: { rendered: false, emailFields: 0 } });
    expect(j.verdict).toBe('breached');
  });
});

describe('cookie tossing', () => {
  const own: CookieView = {
    name: 'ghost-admin-api-session',
    value: 's%3Aown',
    domain: 'a.example.test',
    path: '/ghost',
    secure: false,
    httpOnly: true,
  };
  const base: TossObservation = {
    pagesVisited: 3,
    scriptRan: false,
    victimJar: [own],
    attackerNames: ['ghost-admin-api-session', 'toss'],
    attackerValue: 'attacker-1',
    sessionBefore: 's%3Aown',
    sessionAfter: 's%3Aown',
    residual: { sharedDomainWriteAccepted: true, seenByOtherTenant: true, seenByPortal: true },
    psl: 'absent',
  };
  it('holds when only the victim own cookie is sent, and reports the residual as accepted risk', () => {
    const j = judgeCookieTossing(base);
    expect(j.verdict).toBe('held');
    expect(j.residual?.status).toBe('accepted-risk');
  });
  it('is breached when a cookie of the attacker is sent to the victim tenant', () => {
    const tossed: CookieView = {
      ...own,
      name: 'toss',
      value: 'attacker-1',
      domain: '.sites.example.test',
      path: '/',
    };
    expect(judgeCookieTossing({ ...base, victimJar: [own, tossed] }).verdict).toBe('breached');
  });
  it('is breached when the victim session cookie changed', () => {
    expect(judgeCookieTossing({ ...base, sessionAfter: null }).verdict).toBe('breached');
  });
  it('is not exercised when the sibling pages were not visited', () => {
    expect(judgeCookieTossing({ ...base, pagesVisited: 1 }).verdict).toBe('not-exercised');
  });
  it('reports a breached residual when the list entry is stated present yet the write was accepted', () => {
    expect(judgeCookieTossing({ ...base, psl: 'present' }).residual?.status).toBe('breached');
  });
  it('reports a held residual when the browser refused the write', () => {
    const residual = {
      sharedDomainWriteAccepted: false,
      seenByOtherTenant: false,
      seenByPortal: false,
    };
    expect(judgeCookieTossing({ ...base, residual, psl: 'present' }).residual?.status).toBe('held');
  });
});

describe('portal __Host- cookies', () => {
  const probe = {
    name: '__Host-portal_session',
    genuineValue: 'genuine',
    jarValues: ['genuine'],
    secure: true,
    path: '/',
    hostOnly: true,
    attackerValueInJar: false,
  };
  const base: PortalCookieObservation = {
    probes: [probe],
    sessionRead: { seen: 'genuine', genuine: 'genuine' },
    twinsAccepted: ['portal_session'],
  };
  it('holds when only the genuine value is held under the prefixed name', () => {
    expect(judgePortalHostCookies(base).verdict).toBe('held');
  });
  it('is breached when the name carries no prefix', () => {
    const obs = { ...base, probes: [{ ...probe, name: 'portal_session' }] };
    expect(judgePortalHostCookies(obs).verdict).toBe('breached');
  });
  it('is breached when the attacker value is held under the portal name', () => {
    const obs = {
      ...base,
      probes: [{ ...probe, jarValues: ['attacker', 'genuine'], attackerValueInJar: true }],
    };
    expect(judgePortalHostCookies(obs).verdict).toBe('breached');
  });
  it('is breached when the portal read a session that was not its own', () => {
    const obs = { ...base, sessionRead: { seen: 'attacker', genuine: 'genuine' } };
    expect(judgePortalHostCookies(obs).verdict).toBe('breached');
  });
  it('is breached when the cookie carries a Domain attribute', () => {
    const obs = { ...base, probes: [{ ...probe, hostOnly: false }] };
    expect(judgePortalHostCookies(obs).verdict).toBe('breached');
  });
  it('is not exercised when the portal set no cookie', () => {
    expect(judgePortalHostCookies({ ...base, probes: [] }).verdict).toBe('not-exercised');
  });
});

describe('cookie bomb', () => {
  const base: BombObservation = {
    pagesVisited: 2,
    scriptRan: false,
    victimStatus: 200,
    bombBytesInVictimJar: 0,
    residual: {
      cookieBytes: 30_000,
      statusWithBomb: 431,
      statusAfterClear: 200,
      sharedDomainWriteAccepted: true,
    },
    psl: 'absent',
  };
  it('holds when the victim tenant still answers 200, and records the measured limit', () => {
    const j = judgeCookieBomb(base);
    expect(j.verdict).toBe('held');
    expect(j.residual?.status).toBe('accepted-risk');
    expect(j.residual?.detail).toContain('431');
  });
  it('is breached when bomb cookies reach the victim tenant', () => {
    expect(judgeCookieBomb({ ...base, bombBytesInVictimJar: 30_000 }).verdict).toBe('breached');
  });
  it('is breached when the victim tenant answers nothing', () => {
    expect(judgeCookieBomb({ ...base, victimStatus: null }).verdict).toBe('breached');
  });
  it('is breached when the victim tenant refuses the request', () => {
    expect(judgeCookieBomb({ ...base, victimStatus: 431 }).verdict).toBe('breached');
  });
  it('is not exercised when the sibling pages were not visited', () => {
    expect(judgeCookieBomb({ ...base, pagesVisited: 0 }).verdict).toBe('not-exercised');
  });
});

describe('cross-site request', () => {
  const base: CrossSiteObservation = {
    vectors: [
      { name: 'form', origin: 'cross-site', requestsToVictim: 1, statuses: [403] },
      { name: 'click', origin: 'same-site', requestsToVictim: 1, statuses: [403] },
    ],
    postsBefore: 2,
    postsAfter: 2,
  };
  it('holds when requests arrived and nothing changed', () => {
    expect(judgeCrossSite(base).verdict).toBe('held');
  });
  it('is breached when the victim post count moved', () => {
    expect(judgeCrossSite({ ...base, postsAfter: 3 }).verdict).toBe('breached');
  });
  it('is not exercised when no request reached the victim', () => {
    const obs = {
      ...base,
      vectors: base.vectors.map((v) => ({ ...v, requestsToVictim: 0, statuses: [] })),
    };
    expect(judgeCrossSite(obs).verdict).toBe('not-exercised');
  });
});

describe('theme script', () => {
  const served: ThemeObservation = {
    uploadStatus: 200,
    activateStatus: 200,
    vectors: [
      { name: 'theme-inline-script', ran: false, fileStatus: 200 },
      { name: 'theme-script-file', ran: false, fileStatus: 403 },
    ],
  };
  it('holds when nothing in the served theme ran', () => {
    expect(judgeThemeScript(served).verdict).toBe('held');
  });
  it('is breached when the theme script file ran', () => {
    const obs = {
      ...served,
      vectors: [served.vectors[0]!, { name: 'theme-script-file', ran: true, fileStatus: 200 }],
    };
    expect(judgeThemeScript(obs).verdict).toBe('breached');
  });
  it('holds when the platform refused the theme at upload', () => {
    expect(judgeThemeScript({ ...served, uploadStatus: 403, activateStatus: null }).verdict).toBe(
      'held'
    );
  });
  it('is not exercised when Ghost rejected the theme as invalid', () => {
    expect(judgeThemeScript({ ...served, uploadStatus: 422, activateStatus: null }).verdict).toBe(
      'not-exercised'
    );
  });
});
