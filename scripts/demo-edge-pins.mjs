#!/usr/bin/env node
// Holds a built demo-edge image to the pins in services/demo-edge/Dockerfile.
// See demo-edge-pins.md. Node built-ins only; no install.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HETZNER_MODULE_PATH = 'github.com/caddy-dns/hetzner/v2';
export const HETZNER_MODULE_ID = 'dns.providers.hetzner';
export const CADDY_MODULE_PATH = 'github.com/caddyserver/caddy/v2';

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SEMVER = /^v\d+\.\d+\.\d+$/;

// Comment lines go, and a trailing backslash joins the next line, so a pin
// can never be satisfied by text inside a comment.
function logicalLines(text) {
  return text
    .replace(/\\\n/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

function parseFrom(line) {
  const match = /^FROM\s+(\S+)(?:\s+AS\s+(\S+))?$/i.exec(line);
  if (!match) return null;
  const ref = /^(?<repo>[^:@]+)(?::(?<tag>[^@]+))?(?:@(?<digest>.+))?$/.exec(match[1]);
  const tag = ref?.groups.tag ?? '';
  const caddy = /^(\d+\.\d+\.\d+)(?:-builder)?-alpine$/.exec(tag);
  return {
    repo: ref?.groups.repo ?? match[1],
    tag,
    digest: ref?.groups.digest ?? '',
    stage: match[2] ?? null,
    builder: tag.includes('-builder'),
    caddy: caddy ? caddy[1] : null,
  };
}

// The three spellings of the Caddy version (builder tag, `xcaddy build`
// argument, final tag), the digests and the module pin, as written.
export function readPins(dockerfileText) {
  const lines = logicalLines(dockerfileText);
  const froms = lines.map(parseFrom).filter(Boolean);
  const builds = lines.filter((line) => /^RUN\s+xcaddy\s+build\b/.test(line));
  const first = builds[0] ?? '';
  const args = first.replace(/^RUN\s+xcaddy\s+build\s*/, '');
  const xcaddyVersion = /^(?!--)(\S+)/.exec(args)?.[1] ?? null;
  const modules = [...first.matchAll(/--with\s+([^\s@]+)(?:@(\S+))?/g)].map((m) => ({
    path: m[1],
    version: m[2] ?? null,
  }));
  return { froms, builds, xcaddyVersion, modules };
}

// Static problems with the Dockerfile's own pins. Empty means coherent. A
// deliberate bump that moves every spelling together passes; a one-sided or
// unpinned change does not.
export function problems(dockerfileText) {
  const found = [];
  const { froms, builds, xcaddyVersion, modules } = readPins(dockerfileText);
  if (froms.length !== 2) {
    found.push(`expected exactly two FROM lines (builder, final), found ${froms.length}`);
  }
  for (const from of froms) {
    if (from.repo !== 'caddy') found.push(`FROM ${from.repo} is not the caddy image`);
    if (!DIGEST.test(from.digest)) {
      found.push(`FROM ${from.repo}:${from.tag} has no @sha256 digest pin`);
    }
    if (!from.caddy) {
      found.push(`FROM ${from.repo}:${from.tag} is not a caddy X.Y.Z[-builder]-alpine tag`);
    }
  }
  const [builder, final] = froms;
  if (builder && !(builder.stage === 'builder' && builder.builder)) {
    found.push('first FROM is not the -builder-alpine image named AS builder');
  }
  if (final && (final.stage !== null || final.builder)) {
    found.push('last FROM is not the plain -alpine final image');
  }
  if (builds.length !== 1) {
    found.push(`expected exactly one xcaddy build, found ${builds.length}`);
  }
  if (builds.length > 0) {
    if (!xcaddyVersion || !SEMVER.test(xcaddyVersion)) {
      found.push(`xcaddy build has no vX.Y.Z Caddy version argument (got '${xcaddyVersion}')`);
    }
    const hetzner = modules.filter((m) => m.path === HETZNER_MODULE_PATH);
    if (hetzner.length !== 1) {
      found.push(`xcaddy build does not name ${HETZNER_MODULE_PATH} exactly once`);
    } else if (!hetzner[0].version || !SEMVER.test(hetzner[0].version)) {
      found.push(
        `${HETZNER_MODULE_PATH} is not pinned to a vX.Y.Z version (got '${hetzner[0].version}')`
      );
    }
    for (const m of modules) {
      if (m.path !== HETZNER_MODULE_PATH)
        found.push(`xcaddy build adds an unexpected module ${m.path}`);
    }
  }
  if (builder?.caddy && final?.caddy && builder.caddy !== final.caddy) {
    found.push(`builder Caddy ${builder.caddy} and final Caddy ${final.caddy} disagree`);
  }
  if (builder?.caddy && xcaddyVersion && xcaddyVersion !== `v${builder.caddy}`) {
    found.push(`xcaddy build ${xcaddyVersion} and builder tag ${builder.caddy} disagree`);
  }
  return found;
}

const fieldsOf = (line) => line.trim().split(/\s+/);

// What the built binary reports, held to the Dockerfile's pins. `version` is
// `caddy version`, `modules` is `caddy list-modules --versions`, `buildInfo`
// is `caddy build-info`, `arch` is the image's architecture.
export function compareReports(
  pins,
  { version, modules, buildInfo, arch },
  expectedArch = 'amd64'
) {
  const found = [];
  const { builds, modules: pinned, xcaddyVersion } = pins;
  const caddy = xcaddyVersion;
  const hetzner = pinned.find((m) => m.path === HETZNER_MODULE_PATH)?.version;
  if (builds.length === 0 || !caddy || !hetzner) {
    return ['the Dockerfile pins cannot be read'];
  }
  const reported = /^(v\d+\.\d+\.\d+)(?:\s|$)/.exec((version ?? '').trim())?.[1];
  if (reported !== caddy) {
    found.push(`binary reports Caddy ${reported ?? `'${version}'`}, the Dockerfile pins ${caddy}`);
  }
  const moduleLine = (modules ?? '')
    .split('\n')
    .map(fieldsOf)
    .find((f) => f[0] === HETZNER_MODULE_ID);
  if (!moduleLine) {
    found.push(`binary has no ${HETZNER_MODULE_ID} module`);
  } else if (moduleLine[1] !== hetzner) {
    found.push(`binary has ${HETZNER_MODULE_ID} ${moduleLine[1]}, the Dockerfile pins ${hetzner}`);
  }
  const deps = new Map(
    (buildInfo ?? '')
      .split('\n')
      .map(fieldsOf)
      .filter((f) => f[0] === 'dep')
      .map((f) => [f[1], f[2]])
  );
  if (deps.get(HETZNER_MODULE_PATH) !== hetzner) {
    found.push(
      `build-info has ${HETZNER_MODULE_PATH} ${deps.get(HETZNER_MODULE_PATH) ?? 'absent'}, the Dockerfile pins ${hetzner}`
    );
  }
  if (deps.get(CADDY_MODULE_PATH) !== caddy) {
    found.push(
      `build-info has ${CADDY_MODULE_PATH} ${deps.get(CADDY_MODULE_PATH) ?? 'absent'}, the Dockerfile pins ${caddy}`
    );
  }
  if (arch !== expectedArch)
    found.push(`image architecture is '${arch}', expected '${expectedArch}'`);
  return found;
}

function observe(image) {
  const run = (...args) =>
    execFileSync('docker', ['run', '--rm', '--entrypoint', 'caddy', image, ...args], {
      encoding: 'utf8',
    });
  return {
    version: run('version'),
    modules: run('list-modules', '--versions'),
    buildInfo: run('build-info'),
    arch: execFileSync('docker', ['image', 'inspect', '--format', '{{.Architecture}}', image], {
      encoding: 'utf8',
    }).trim(),
  };
}

function main(argv) {
  const rest = [...argv];
  let arch = 'amd64';
  const at = rest.indexOf('--arch');
  if (at >= 0) arch = rest.splice(at, 2)[1];
  const [image, dockerfile] = rest;
  if (!image || !arch || rest.length > 2) {
    console.error('usage: demo-edge-pins.mjs <image> [dockerfile] [--arch amd64]');
    return 2;
  }
  const file =
    dockerfile ??
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      'services',
      'demo-edge',
      'Dockerfile'
    );
  const text = fs.readFileSync(file, 'utf8');
  const found = problems(text);
  if (found.length === 0) found.push(...compareReports(readPins(text), observe(image), arch));
  for (const problem of found) console.error(`::error::demo-edge pins: ${problem}`);
  if (found.length === 0) console.log(`demo-edge pins hold for ${image}`);
  return found.length === 0 ? 0 : 1;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
