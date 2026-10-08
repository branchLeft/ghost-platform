import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ConfigError, parseOrigin, parseOutputs, parsePort } from '../src/shell/config.js';
import { cookieName, parseCookies, setCookie } from '../src/shell/cookies.js';
import { escapeHtml, renderPage } from '../src/shell/html.js';
import { renderDocuments } from '../src/shell/documentsHtml.js';
import { expiryOf } from '../src/shell/oidc.js';
import { ExpiringStore } from '../src/shell/sessions.js';
import { loadConsoleConfig } from '../src/console/config.js';
import { loadTenantConfig } from '../src/tenant/config.js';

const OUTPUTS = JSON.stringify({
  ownerOrgId: 'org-owner',
  projectId: 'project-1',
  tenantOrgIds: { alpha: 'org-a', beta: 'org-b' },
  clientIds: { console: 'client-console', portal: 'client-portal' },
});

const files: Record<string, string> = {
  '/outputs.json': OUTPUTS,
  '/db-url': 'postgres://login@db/portal\n',
};
const read = (path: string): string => {
  const content = files[path];
  if (content === undefined) throw new Error('missing');
  return content;
};

describe('configuration', () => {
  it('builds the tenant portal from its own variables, using only the portal client', () => {
    const config = loadTenantConfig(
      {
        PORTAL_OUTPUTS_FILE: '/outputs.json',
        PORTAL_PUBLIC_ORIGIN: 'https://portal.example.test',
        PORTAL_ISSUER_URL: 'https://id.example.test',
        PORTAL_DATABASE_URL_FILE: '/db-url',
        PORT: '9000',
      },
      read
    );
    expect(config.clientId).toBe('client-portal');
    expect([...config.allowedOrgIds].sort()).toEqual(['org-a', 'org-b']);
    expect(config.allowedOrgIds.has('org-owner')).toBe(false);
    expect(config.databaseUrl).toBe('postgres://login@db/portal');
    expect(config.secureCookies).toBe(true);
    expect(config.port).toBe(9000);
  });

  it('builds the owner console from its own variables, using only the console client', () => {
    const config = loadConsoleConfig(
      {
        CONSOLE_OUTPUTS_FILE: '/outputs.json',
        CONSOLE_PUBLIC_ORIGIN: 'http://127.0.0.1:3000',
        CONSOLE_ISSUER_URL: 'https://id.example.test',
        CONSOLE_DATABASE_URL_FILE: '/db-url',
      },
      read
    );
    expect(config.clientId).toBe('client-console');
    expect(config.ownerOrgId).toBe('org-owner');
    expect(config.secureCookies).toBe(false);
    expect(config.port).toBe(8081);
  });

  it('refuses a missing variable, a bad origin and a bad port', () => {
    expect(() => loadTenantConfig({}, read)).toThrow(ConfigError);
    expect(() => parseOrigin('http://portal.example.test')).toThrow('https');
    expect(() => parseOrigin('not a url')).toThrow('URL');
    expect(() => parseOrigin('https://portal.example.test/path')).toThrow('alone');
    expect(() => parseOrigin(undefined)).toThrow(ConfigError);
    expect(parseOrigin('https://portal.example.test').origin).toBe('https://portal.example.test');
    expect(() => parsePort('0', 1)).toThrow(ConfigError);
    expect(() => parsePort('x', 1)).toThrow(ConfigError);
    expect(parsePort(undefined, 5)).toBe(5);
  });

  it('refuses an outputs file that is not JSON or lacks an identifier', () => {
    expect(() => parseOutputs('nope')).toThrow('JSON');
    expect(() => parseOutputs('null')).toThrow('missing');
    expect(() => parseOutputs('{}')).toThrow('missing');
    const broken = JSON.parse(OUTPUTS) as Record<string, unknown>;
    broken['tenantOrgIds'] = ['org-a'];
    expect(() => parseOutputs(JSON.stringify(broken))).toThrow('missing');
    broken['tenantOrgIds'] = { alpha: '' };
    expect(() => parseOutputs(JSON.stringify(broken))).toThrow('missing');
  });
});

describe('cookies, pages and sessions', () => {
  it('parses cookies, keeping the first of a repeated name', () => {
    const jar = parseCookies('a=1; b=2; a=3; =x; junk');
    expect(jar.get('a')).toBe('1');
    expect(jar.get('b')).toBe('2');
    expect(jar.size).toBe(2);
    expect(parseCookies(undefined).size).toBe(0);
  });

  it('marks cookies HttpOnly, SameSite, host-bound and Secure over TLS', () => {
    expect(cookieName('s', true)).toBe('__Host-s');
    expect(cookieName('s', false)).toBe('s');
    const header = setCookie('__Host-s', 'v', { maxAge: 30.7, secure: true });
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain('Secure');
    expect(header).toContain('Max-Age=30');
    expect(setCookie('s', '', { maxAge: -5, secure: false })).toContain('Max-Age=0');
    expect(setCookie('s', '', { maxAge: 5, secure: false })).not.toContain('Secure');
  });

  it('escapes markup', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;'
    );
    const page = renderPage({
      title: '<T>',
      nav: [{ label: 'L', href: '/"x' }],
      signOutLabel: 'OUT',
      body: '<p>b</p>',
    });
    expect(page).toContain('&lt;T&gt;');
    expect(page).toContain('href="/&quot;x"');
  });

  it('reads the expiry of a token and refuses a malformed one', () => {
    const payload = Buffer.from(JSON.stringify({ exp: 5 })).toString('base64url');
    expect(expiryOf(`h.${payload}.s`)).toBe(5);
    expect(expiryOf('h.e30.s')).toBeNull();
    expect(expiryOf('garbage')).toBeNull();
  });

  it('expires entries, hands a one-time entry out once, and refuses when full of live ones', () => {
    let now = 100;
    const store = new ExpiringStore<{ expiresAt: number }>(() => now);
    const id = store.put({ expiresAt: 110 });
    expect(id).not.toBeNull();
    expect(store.get(id ?? '')).not.toBeNull();
    expect(store.get(undefined)).toBeNull();
    expect(store.take(id ?? '')).not.toBeNull();
    expect(store.take(id ?? '')).toBeNull();
    store.delete(undefined);
    const stale = store.put({ expiresAt: 101 });
    now = 102;
    expect(store.get(stale ?? '')).toBeNull();

    const full = new ExpiringStore<{ expiresAt: number }>(() => now);
    for (let i = 0; i < 10_000; i += 1) full.put({ expiresAt: 1000 });
    expect(full.put({ expiresAt: 1000 })).toBeNull();
    now = 2000;
    expect(full.put({ expiresAt: 3000 })).not.toBeNull();
  });
});

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : path.endsWith('.ts') ? [path] : [];
  });
}

const importsOf = (path: string): string[] =>
  [...readFileSync(path, 'utf8').matchAll(/(?:from|import\()\s*['"]([^'"]+)['"]/g)].map(
    (match) => match[1] ?? ''
  );

describe('the two applications stay separate', () => {
  const entries = sources(SRC).map((path) => ({
    file: relative(SRC, path),
    imports: importsOf(path),
  }));
  const under = (dir: string) => entries.filter((entry) => entry.file.startsWith(`${dir}/`));

  it('keeps the tenant portal off the owner entry point, the migrator and the console', () => {
    for (const { file, imports } of under('tenant')) {
      for (const target of imports) {
        expect(target, file).not.toMatch(/portal-data\/(owner|migrate)/);
        expect(target, file).not.toMatch(/console/);
      }
    }
  });

  it('keeps the owner console off the tenant entry point and the tenant portal', () => {
    for (const { file, imports } of under('console')) {
      for (const target of imports) {
        expect(target, file).not.toMatch(/portal-data\/(tenant|migrate)/);
        expect(target, file).not.toMatch(/tenant/);
      }
    }
  });

  it('keeps the shared shell free of storage and of either application', () => {
    const shell = under('shell');
    expect(shell.length).toBeGreaterThan(0);
    for (const { file, imports } of shell) {
      for (const target of imports) {
        expect(target, file).not.toMatch(/portal-data|\.\.\/(tenant|console)\//);
      }
    }
  });

  it('finds the imports it is meant to forbid (control case)', () => {
    const control = importsOf(join(SRC, 'console', 'app.ts')).join(' ');
    expect(control).toContain('portal-data/owner');
    expect(importsOf(join(SRC, 'tenant', 'app.ts')).join(' ')).toContain('portal-data/tenant');
  });
});

describe('renderDocuments', () => {
  it('says so when no document is in force, and escapes what a document holds', () => {
    expect(renderDocuments([], new Set(), [])).toContain('NO_DOCUMENTS_IN_FORCE');
    const page = renderDocuments(
      [
        {
          kind: 'terms',
          version: 1,
          title: '<b>T</b>',
          body: 'A & B',
          entries: [],
          effectiveAt: new Date('2026-10-01T00:00:00Z'),
        },
      ],
      new Set(['terms:1']),
      []
    );
    expect(page).toContain('&lt;b&gt;T&lt;/b&gt;');
    expect(page).toContain('A &amp; B');
    expect(page).toContain('ACCEPT_THIS_VERSION');
  });
});
