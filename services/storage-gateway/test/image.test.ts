import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startRig, type Rig } from './support/gateway-rig.js';

// The image cannot be built where these tests run, so what can be checked
// without Docker is checked here: the shape of the Dockerfile, the shape of
// the workflow that publishes it, and that the Dockerfile's own health check
// command works against a running service.

const here = dirname(fileURLToPath(import.meta.url));
const dockerfile = readFileSync(resolve(here, '../Dockerfile'), 'utf8');
const workflow = readFileSync(
  resolve(here, '../../../.github/workflows/storage-gateway-image.yml'),
  'utf8'
);

/** The multi-architecture index of node:26.13.0-alpine that the base-image scan was run against. */
const BASE =
  'node:26.13.0-alpine@sha256:8996bb5821d62a8fd9bb27c1cb07462f3fdce6e47d640c6a881ead0b064ce216';
const RELEASE_SHA = '77506b6d4603ef432bbdec734139fec91e5bea47';

const withoutComments = (text: string): string =>
  text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

function stages(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of withoutComments(source).split(/^(?=FROM )/m)) {
    const name = /^FROM \S+ AS (\w+)/.exec(part)?.[1];
    if (name !== undefined) out[name] = part;
  }
  return out;
}

function jobs(source: string): Record<string, string> {
  const body = withoutComments(source).split(/^jobs:\n/m)[1] ?? '';
  const out: Record<string, string> = {};
  for (const part of body.split(/^(?= {2}[a-z-]+:\n)/m)) {
    const name = /^ {2}([a-z-]+):\n/.exec(part)?.[1];
    if (name !== undefined) out[name] = part;
  }
  return out;
}

describe('the Dockerfile', () => {
  const { build, runtime } = stages(dockerfile);

  it('has a build stage and a runtime stage, both on the scanned base pinned by digest', () => {
    expect(Object.keys(stages(dockerfile))).toEqual(['build', 'runtime']);
    const froms = dockerfile.split('\n').filter((line) => line.startsWith('FROM '));
    expect(froms).toEqual([`FROM ${BASE} AS build`, `FROM ${BASE} AS runtime`]);
  });

  it('upgrades zlib before the package manager is used', () => {
    const text = build ?? '';
    expect(text.indexOf('apk upgrade --no-cache zlib')).toBeGreaterThan(-1);
    expect(text.indexOf('apk upgrade --no-cache zlib')).toBeLessThan(text.indexOf('npm install'));
  });

  it('takes the registry token as a build secret and runs no install script', () => {
    expect(build).toMatch(/--mount=type=secret,id=node_auth_token/);
    expect(build).toMatch(/pnpm install --frozen-lockfile --ignore-scripts/);
    expect(dockerfile).not.toMatch(/^\s*(ARG|ENV)\s+\S*(TOKEN|SECRET|PASSWORD|KEY)/im);
  });

  it('ships no package manager and no dev dependency in the runtime stage', () => {
    expect(runtime).toMatch(/rm -rf \/usr\/local\/lib\/node_modules\/npm/);
    expect(runtime).not.toMatch(/npm install|pnpm/);
    expect(build).toMatch(/pnpm prune --prod/);
    expect(runtime).toMatch(/COPY --from=build \/app\/node_modules/);
  });

  it('runs as the unprivileged node user, with the migrations the store reads at start', () => {
    expect(runtime).toMatch(/^USER node$/m);
    expect(runtime?.indexOf('USER node')).toBeGreaterThan(runtime?.indexOf('rm -rf') ?? 0);
    expect(runtime).toMatch(/COPY --from=build \/app\/drizzle \.\/drizzle/);
    expect(runtime).toMatch(/^CMD \["node", "dist\/main\.js"\]$/m);
  });
});

describe('the Dockerfile health check', () => {
  let rig: Rig;
  beforeAll(async () => {
    rig = await startRig();
  });
  afterAll(async () => {
    await rig.stop();
  });

  const command = (): string[] => {
    const line = /^HEALTHCHECK .*\\\n\s*CMD (\[.*\])$/m.exec(dockerfile)?.[1] ?? '[]';
    return JSON.parse(line) as string[];
  };

  /** Runs the health check as the image does: `node -e`, from the package directory, with the service's environment. */
  function run(env: Record<string, string>): Promise<number> {
    const [binary, ...args] = command();
    expect(binary).toBe('node');
    return new Promise((resolveExit) => {
      const child = spawn(process.execPath, args, {
        cwd: resolve(here, '..'),
        env: { PATH: process.env.PATH ?? '', ...env },
        stdio: 'ignore',
      });
      child.on('exit', (code) => resolveExit(code ?? -1));
    });
  }

  it('exits 0 against a running service, using only node', async () => {
    expect(command().slice(0, 2)).toEqual(['node', '-e']);
    expect(
      await run({
        STORAGE_GATEWAY_LISTEN_HOST: '127.0.0.1',
        STORAGE_GATEWAY_LISTEN_PORT: String(rig.port),
      })
    ).toBe(0);
  });

  it('treats an unspecified listen address as loopback', async () => {
    expect(
      await run({
        STORAGE_GATEWAY_LISTEN_HOST: '0.0.0.0',
        STORAGE_GATEWAY_LISTEN_PORT: String(rig.port),
      })
    ).toBe(0);
  });

  it('exits 1 when nothing answers', async () => {
    const port = rig.port;
    await rig.gateway.stop();
    expect(
      await run({
        STORAGE_GATEWAY_LISTEN_HOST: '127.0.0.1',
        STORAGE_GATEWAY_LISTEN_PORT: String(port),
      })
    ).toBe(1);
  });
});

describe('the publish workflow', () => {
  const all = jobs(workflow);
  const text = withoutComments(workflow);

  it('has build, push, scan and attest jobs and no deploy job', () => {
    expect(Object.keys(all)).toEqual(['build', 'push', 'scan', 'attest']);
    expect(text).not.toMatch(/^\s*environment:/m);
    expect(text).not.toMatch(/pulumi|ssh |rsync|deploy/i);
  });

  it('asks for no write credential at the top level or in the build, scan or attest-free jobs', () => {
    expect(text.split(/^jobs:\n/m)[0]).toMatch(
      /^permissions:\n {2}contents: read\n {2}packages: read\n/m
    );
    for (const name of ['build', 'scan']) expect(all[name]).not.toMatch(/: write/);
    expect(all.push).toMatch(/packages: write/);
    expect(all.push).not.toMatch(/id-token: write|attestations: write/);
    expect(all.attest).toMatch(/id-token: write/);
    expect(all.attest).toMatch(/attestations: write/);
  });

  it('publishes only from main, only the image the checks ran against, and refuses a malformed digest', () => {
    expect(all.push).toMatch(/needs: build/);
    expect(all.push).toMatch(/github\.ref == 'refs\/heads\/main'/);
    expect(all.push).toMatch(/needs\.build\.outputs\.image-id/);
    expect(all.push).not.toMatch(/docker (image |buildx )?build/);
    expect(all.push).toMatch(/\^sha256:\[0-9a-f\]\{64\}\$/);
    expect(text).not.toMatch(/:latest/);
  });

  it('scans the pushed digest, then attests only a scanned one, both at the v1.1.0 release', () => {
    expect(all.scan).toMatch(/needs: push/);
    expect(all.scan).toContain(
      `uses: branchLeft/github-workflows/.github/workflows/image-scan.yml@${RELEASE_SHA}`
    );
    expect(all.attest).toMatch(/needs: \[push, scan\]/);
    expect(all.attest).toContain(
      `uses: branchLeft/github-workflows/.github/actions/attest-and-verify-image@${RELEASE_SHA}`
    );
    expect(all.attest).toMatch(
      /signer-workflow: branchLeft\/ghost-platform\/\.github\/workflows\/storage-gateway-image\.yml$/m
    );
    expect(text).not.toMatch(/workflow_ref/);
  });
});
