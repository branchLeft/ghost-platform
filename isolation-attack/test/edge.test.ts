import { describe, expect, it } from 'vitest';
import { EdgeRenderError, GUARD_MOUNT, renderCaddyfile, type EdgeTenant } from '../src/rig/edge.ts';
import { pinnedBases } from '../src/rig/docker.ts';
import { renderPolicy } from '../src/rig/policy.ts';
import { baseThemeFiles, buildZip, zipEntryNames } from '../src/themeZip.ts';
import {
  hostileThemeFiles,
  tossAssignments,
  bombScript,
  type AttackerContext,
} from '../src/payloads.ts';

const tenant = (over: Partial<EdgeTenant> = {}): EdgeTenant => ({
  host: 'a.sites.pp.localhost',
  upstream: 'ghost-a:2368',
  csp: "default-src 'self'; script-src 'self'",
  spoofOrigin: null,
  ...over,
});

describe('the edge Caddyfile', () => {
  it('routes by host, sets the policy and mounts the upload refusal inside the route', () => {
    const text = renderCaddyfile([
      tenant(),
      tenant({ host: 'b.sites.pp.localhost', upstream: 'ghost-b:2368' }),
    ]);
    expect(text).toContain('@tenant0 host a.sites.pp.localhost');
    expect(text).toContain('@tenant1 host b.sites.pp.localhost');
    expect(text).toContain(
      `header Content-Security-Policy "default-src 'self'; script-src 'self'"`
    );
    expect(text).toContain(`import ${GUARD_MOUNT}`);
    expect(text).toContain('reverse_proxy ghost-b:2368');
    expect(text).not.toContain('request_header');
  });

  it('writes no policy for a tenant with none, and spoofs the origin only when asked', () => {
    const text = renderCaddyfile([
      tenant({ csp: null, spoofOrigin: 'http://a.sites.pp.localhost:8080' }),
    ]);
    expect(text).not.toContain('Content-Security-Policy');
    expect(text).toContain('request_header Origin "http://a.sites.pp.localhost:8080"');
  });

  it.each([
    ['a host with a space', { host: 'a b' }],
    ['an upstream with a path', { upstream: 'ghost-a:2368/x' }],
    ['a policy that closes the quote', { csp: 'x" respond 200 "' }],
    ['a policy carrying a placeholder', { csp: 'x {env.SECRET}' }],
  ])('refuses %s', (_name, over) => {
    expect(() => renderCaddyfile([tenant(over)])).toThrow(EdgeRenderError);
  });
});

describe('the policy the rig serves', () => {
  it('is the one render-core renders from derived hashes, enforcing and without unsafe-inline scripts', () => {
    const hash = `sha256-${'A'.repeat(43)}=`;
    const policy = renderPolicy({ kind: 'computed', hashes: [hash] } as never);
    expect(policy.mode).toBe('enforcing');
    expect(policy.value).toContain(`script-src 'self' '${hash}'`);
    expect(policy.value).not.toMatch(/script-src[^;]*unsafe-inline/);
  });

  it('is report-only when no hashes were derived, which the rig refuses to attack', () => {
    expect(renderPolicy({ kind: 'unavailable' } as never).mode).toBe('report-only');
  });
});

describe('the hostile theme', () => {
  const attacker: AttackerContext = {
    value: 'attacker-x',
    sharedDomain: 'sites.pp.localhost',
    rootDomain: 'pp.localhost',
    sessionName: 'ghost-admin-api-session',
  };

  it('is a stored zip that carries the base theme, the hostile template and the script file', () => {
    const files = { ...baseThemeFiles('t'), ...hostileThemeFiles(attacker) };
    const names = zipEntryNames(buildZip(files));
    expect(names).toEqual([
      'package.json',
      'default.hbs',
      'index.hbs',
      'post.hbs',
      'assets/js/attack.js',
    ]);
    expect(files['default.hbs']).toContain('{{ghost_head}}');
    expect(files['default.hbs']).toContain('{{asset "js/attack.js"}}');
  });
});

describe('the attacker payloads', () => {
  const attacker: AttackerContext = {
    value: 'attacker-x',
    sharedDomain: 'sites.pp.localhost',
    rootDomain: 'pp.localhost',
    sessionName: 'ghost-admin-api-session',
  };

  it('write to the shared domain and to the registrable domain, and carry the run value', () => {
    const writes = tossAssignments(attacker);
    expect(writes.every((w) => w.includes('attacker-x'))).toBe(true);
    expect(writes.some((w) => w.includes('Domain=sites.pp.localhost'))).toBe(true);
    expect(writes.some((w) => w.includes('Domain=pp.localhost'))).toBe(true);
  });

  it('write more cookie bytes than Ghost accepts in one header', () => {
    expect(bombScript(attacker)).toContain("'x'.repeat(3800)");
    expect(8 * 3800).toBeGreaterThan(16 * 1024);
  });
});

describe('the pinned base images', () => {
  const digest = 'a'.repeat(64);

  it('reads every digest-pinned FROM line once and ignores unpinned ones', () => {
    const text = [
      `FROM ghost:6-alpine@sha256:${digest} AS base`,
      `FROM --platform=linux/amd64 caddy:2-alpine@sha256:${'b'.repeat(64)}`,
      'FROM alpine:3',
      `FROM ghost:6-alpine@sha256:${digest}`,
      `# FROM never@sha256:${'c'.repeat(64)}`,
    ].join('\n');
    expect(pinnedBases(text)).toEqual([
      `ghost:6-alpine@sha256:${digest}`,
      `caddy:2-alpine@sha256:${'b'.repeat(64)}`,
    ]);
  });
});
