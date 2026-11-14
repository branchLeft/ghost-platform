// The mysqld-exporter image is upstream's release rebuilt from source with
// patched Go modules, and it runs on the database host's monitoring path. A
// slip in how it is built is silent: an unpinned base, a source that is not the
// one reviewed, a checksum check turned off, a patched module that did not
// take, or a changed entrypoint that the compose command no longer fits. These
// checks read the Dockerfile, the publish workflow and the compose service as
// text and name each way they can drift. Each case below breaks one property in
// a copy of the real text and requires a named problem, so a passing run means
// the check can see the break. Read as text, like the other workflow tests
// here, because the repo's Python jobs install no YAML parser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { problems as publishProblems } from './test-support/publish-job-checks.mjs';

const ROOT = import.meta.dirname;
const DOCKERFILE = path.join(ROOT, 'services', 'mysqld-exporter', 'Dockerfile');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'mysqld-exporter-image.yml');
const COMPOSE = path.join(ROOT, 'db', 'stack', 'compose.yml');

// The oldest golang.org/x/net release that carries the fix for the advisories
// that made the upstream image unusable as published.
const XNET_FLOOR = [0, 62, 0];
const COMPRESS_FLOOR = [1, 20, 2];

// What the upstream image's Dockerfile sets at the pinned release, and what the
// compose command relies on: the entrypoint, the port and the user.
const UPSTREAM = {
  entrypoint: '[ "/bin/mysqld_exporter" ]',
  port: '9104',
  user: 'nobody',
  binary: '/bin/mysqld_exporter',
};

const FLAGS = ['--config.my-cnf', '--mysqld.address', '--web.listen-address'];

// Environment that would loosen module verification or the toolchain pin.
const LOOSENING =
  /GOFLAGS|GOSUMDB|GONOSUMDB|GONOSUMCHECK|GOINSECURE|GOPRIVATE|GOPROXY|GOVCS|-mod=mod|-insecure|GOTOOLCHAIN=(?!local\b)/;

const semver = (v) => /^v(\d+)\.(\d+)\.(\d+)$/.exec(v)?.slice(1).map(Number) ?? null;
const atLeast = (version, floor) => {
  const got = semver(version);
  if (!got) return false;
  for (let i = 0; i < 3; i++) {
    if (got[i] !== floor[i]) return got[i] > floor[i];
  }
  return true;
};

// Whole-line comments go, and a backslash continuation joins its lines, so each
// instruction is one string and text in a comment can never satisfy a check.
export function instructions(source) {
  const joined = source
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n')
    .replace(/\\\n\s*/g, ' ');
  return joined
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean);
}

const envValue = (lines, key) => {
  for (const line of lines.filter((l) => /^ENV\s/.test(l))) {
    const m = new RegExp(`(?:^ENV|\\s)${key}=(\\S+)`).exec(line);
    if (m) return m[1];
  }
  return null;
};

export function dockerfileProblems(source) {
  const found = [];
  const lines = instructions(source);
  const text = lines.join('\n');

  // Every base is pinned by digest as well as tag.
  const froms = lines.filter((l) => /^FROM\s/.test(l));
  if (froms.length < 2) found.push('expected a builder stage and a final stage');
  for (const from of froms) {
    const image = from.split(/\s+/).filter((t) => !t.startsWith('--') && t !== 'FROM')[0];
    if (!/^[\w./-]+:[\w.-]+@sha256:[0-9a-f]{64}$/.test(image ?? '')) {
      found.push(`base image is not pinned by tag and digest: ${from}`);
    }
  }
  if (!/^FROM .*golang:[\d.]+-alpine[\d.]+@sha256:[0-9a-f]{64} AS build$/m.test(text)) {
    found.push('the builder is not a digest-pinned golang image named build');
  }
  if (!/^FROM alpine:[\d.]+@sha256:[0-9a-f]{64}$/m.test(text)) {
    found.push('the final stage is not a digest-pinned alpine image');
  }

  // The source is one release, identified by commit and by module hash, and
  // neither can be overridden from the build command.
  const commit = envValue(lines, 'EXPORTER_COMMIT');
  if (!/^[0-9a-f]{40}$/.test(commit ?? '')) found.push('EXPORTER_COMMIT is not a 40-digit commit');
  const sum = envValue(lines, 'EXPORTER_MODULE_SUM');
  if (!/^h1:[A-Za-z0-9+/]{43}=$/.test(sum ?? '')) {
    found.push('EXPORTER_MODULE_SUM is not an h1 module hash');
  }
  if (!/^\d+\.\d+\.\d+$/.test(envValue(lines, 'EXPORTER_VERSION') ?? '')) {
    found.push('EXPORTER_VERSION is not a release number');
  }
  if (lines.some((l) => /^ARG\s+(EXPORTER_|XNET_|COMPRESS_)/.test(l))) {
    found.push('a pinned input is an ARG, so a build argument could change it');
  }
  if (!/test "\$commit" = "\$EXPORTER_COMMIT"/.test(text)) {
    found.push('the build does not compare the fetched commit with EXPORTER_COMMIT');
  }
  if (!/test "\$sum" = "\$EXPORTER_MODULE_SUM"/.test(text)) {
    found.push('the build does not compare the fetched module hash with EXPORTER_MODULE_SUM');
  }
  if (
    !/go mod download -json "github\.com\/prometheus\/mysqld_exporter@v\$\{EXPORTER_VERSION\}"/.test(
      text
    )
  ) {
    found.push('the source is not fetched as the pinned module version');
  }
  if (lines.some((l) => /^ADD\s/.test(l)) || /\b(curl|git clone|git fetch)\b/.test(text)) {
    found.push('the build fetches something other than the pinned module');
  }

  // The patched modules: at or above the floor, applied, tidied, verified, and
  // checked in the module graph and in the binary itself.
  const xnet = envValue(lines, 'XNET_VERSION');
  if (!atLeast(xnet, XNET_FLOOR)) found.push('XNET_VERSION is below golang.org/x/net v0.62.0');
  const compress = envValue(lines, 'COMPRESS_VERSION');
  if (!atLeast(compress, COMPRESS_FLOOR)) {
    found.push('COMPRESS_VERSION is below github.com/klauspost/compress v1.20.2');
  }
  if (!/go get "golang\.org\/x\/net@\$\{XNET_VERSION\}"/.test(text)) {
    found.push('the build does not go get the pinned golang.org/x/net');
  }
  if (!/go get [^;]*"github\.com\/klauspost\/compress@\$\{COMPRESS_VERSION\}"/.test(text)) {
    found.push('the build does not go get the pinned github.com/klauspost/compress');
  }
  if (!/go mod tidy; go mod verify;/.test(text)) found.push('the build does not tidy and verify');
  if (
    !/test "\$\(go list -m -f '\{\{\.Version\}\}' golang\.org\/x\/net\)" = "\$XNET_VERSION"/.test(
      text
    )
  ) {
    found.push('the build does not check the resolved golang.org/x/net version');
  }
  if (
    !/go version -m \/out\/mysqld_exporter \| grep -Eq [^;]*golang\\\.org\/x\/net[^;]*\$\{XNET_VERSION\}/.test(
      text
    )
  ) {
    found.push('the build does not check golang.org/x/net in the built binary');
  }

  // Verification stays on and the toolchain is the one in the image.
  const loosened = LOOSENING.exec(text);
  if (loosened)
    found.push(`a setting loosens module verification or the toolchain: ${loosened[0]}`);
  if (envValue(lines, 'GOTOOLCHAIN') !== 'local') found.push('GOTOOLCHAIN is not local');
  if (envValue(lines, 'CGO_ENABLED') !== '0') found.push('CGO_ENABLED is not 0');
  if (!/go build -trimpath /.test(text)) found.push('the binary is not built with -trimpath');
  if (!/-X \$\{pkg\}\.Version=\$\{EXPORTER_VERSION\}/.test(text)) {
    found.push('the version is not embedded in the binary');
  }

  // Apache-2.0: the licence and notice travel with the binary.
  if (!/cp LICENSE NOTICE \/out\/licenses\/mysqld_exporter\//.test(text)) {
    found.push('the exporter licence and notice are not copied');
  }
  if (!/^COPY --from=build \/out\/licenses \/licenses$/m.test(text)) {
    found.push('the licences are not copied into the final image');
  }

  // The final stage: the upstream contract, nothing unpinned installed, and
  // the tools the stack's healthcheck runs left in place.
  const finalAt = text.lastIndexOf('\nFROM ');
  const final = finalAt === -1 ? '' : text.slice(finalAt);
  if (!final.includes(`COPY --from=build /out/mysqld_exporter ${UPSTREAM.binary}`)) {
    found.push(`the binary is not at ${UPSTREAM.binary}`);
  }
  if (!final.includes(`ENTRYPOINT ${UPSTREAM.entrypoint}`)) {
    found.push('the entrypoint differs from the upstream image');
  }
  if (!new RegExp(`^EXPOSE ${UPSTREAM.port}$`, 'm').test(final)) {
    found.push('the exposed port differs from the upstream image');
  }
  if (!new RegExp(`^USER ${UPSTREAM.user}$`, 'm').test(final)) {
    found.push('the user is not the unprivileged user the upstream image runs as');
  }
  if (/\bapk\s+(add|upgrade|update)\b/.test(final)) {
    found.push('the final stage installs or upgrades a package');
  }
  if (!/^RUN apk del --no-cache apk-tools$/m.test(final)) {
    found.push('the final stage keeps the package manager and its libraries');
  }
  if (
    /\b(busybox|wget|grep|sh)\b[^\n]*\brm\b|\brm\b[^\n]*\b(busybox|wget|grep|\/bin\/sh)\b/.test(
      final
    )
  ) {
    found.push('the final stage removes a tool the stack healthcheck runs');
  }
  return found;
}

// The compose service the image replaces: read from the file so the checks
// follow it. Its command carries only the three flags, it overrides neither the
// entrypoint nor the user, and its healthcheck needs wget and grep in the image.
function composeService() {
  const text = fs.readFileSync(COMPOSE, 'utf8');
  const start = text.indexOf('\n  mysqld-exporter:\n');
  assert.ok(start > -1, 'compose has a mysqld-exporter service');
  const rest = text.slice(start + 1);
  const end = rest.slice(1).search(/^\S|^ {2}\S/m);
  return end === -1 ? rest : rest.slice(0, end + 1);
}

const commandFlags = (service) =>
  [...service.matchAll(/^ {6}- (--[\w.-]+)=(\S+)$/gm)].map((m) => [m[1], m[2]]);

const hasProblem = (list, expected) => list.some((p) => p.includes(expected));

// Replace text that must be there: a mutation that silently changed nothing
// would let its case pass without proving anything.
const swap = (text, from, to) => {
  assert.ok(text.includes(from), `the real text contains ${JSON.stringify(from)}`);
  return text.replace(from, to);
};

const real = fs.readFileSync(DOCKERFILE, 'utf8');
const digest = /@sha256:[0-9a-f]{64}/;

test('the Dockerfile pins its bases, source and patched modules and keeps verification on', () => {
  assert.deepEqual(dockerfileProblems(real), []);
});

test('the Dockerfile checker reports each way the build can loosen', () => {
  const cases = [
    // A base is no longer pinned by digest.
    [
      real.replace(new RegExp(`(golang:\\S+)${digest.source}`), '$1'),
      'not pinned by tag and digest',
    ],
    [
      real.replace(new RegExp(`(alpine:\\S+)${digest.source}`), '$1'),
      'not pinned by tag and digest',
    ],
    [swap(real, 'FROM alpine:3.24.4@', 'FROM alpine:latest@'), 'digest-pinned alpine'],
    // The source is no longer one reviewed commit and hash.
    [
      swap(
        real,
        'EXPORTER_COMMIT=8feed91b970d346a15c12f164957c8f9a0e3291e',
        'EXPORTER_COMMIT=v0.21.0'
      ),
      'not a 40-digit commit',
    ],
    [swap(real, 'EXPORTER_MODULE_SUM=h1:', 'EXPORTER_MODULE_SUM=sha:'), 'not an h1 module hash'],
    [
      swap(real, 'ENV EXPORTER_VERSION=0.21.0', 'ARG EXPORTER_VERSION=0.21.0\nENV EXPORTER_X=1'),
      'could change it',
    ],
    [
      swap(real, '    test "$commit" = "$EXPORTER_COMMIT"; \\\n', ''),
      'does not compare the fetched commit',
    ],
    [
      swap(real, '    test "$sum" = "$EXPORTER_MODULE_SUM"; \\\n', ''),
      'does not compare the fetched module hash',
    ],
    [
      swap(real, 'WORKDIR /src\n', 'WORKDIR /src\nADD https://example.invalid/x.tar.gz /src\n'),
      'fetches something other',
    ],
    // A patched module slips below its floor, or stops being applied.
    [swap(real, 'XNET_VERSION=v0.62.0', 'XNET_VERSION=v0.61.0'), 'below golang.org/x/net v0.62.0'],
    [swap(real, 'XNET_VERSION=v0.62.0', 'XNET_VERSION=v0.9.0'), 'below golang.org/x/net v0.62.0'],
    [
      swap(real, 'COMPRESS_VERSION=v1.20.2', 'COMPRESS_VERSION=v1.20.1'),
      'below github.com/klauspost/compress',
    ],
    [
      swap(real, 'go get "golang.org/x/net@${XNET_VERSION}" ', 'go get '),
      'go get the pinned golang.org/x/net',
    ],
    [swap(real, '    go mod verify; \\\n', ''), 'tidy and verify'],
    [
      swap(
        real,
        "go list -m -f '{{.Version}}' golang.org/x/net",
        "go list -m -f '{{.Version}}' golang.org/x/sys"
      ),
      'resolved golang.org/x/net version',
    ],
    [
      swap(
        real,
        'golang\\.org/x/net[[:space:]]+${XNET_VERSION}',
        'golang\\.org/x/sys[[:space:]]+${XNET_VERSION}'
      ),
      'in the built binary',
    ],
    // Verification or the toolchain pin is turned off.
    [
      swap(real, 'ENV GOTOOLCHAIN=local', 'ENV GOSUMDB=off GOTOOLCHAIN=local'),
      'loosens module verification',
    ],
    [
      swap(real, 'ENV GOTOOLCHAIN=local', 'ENV GOFLAGS=-mod=mod GOTOOLCHAIN=local'),
      'loosens module verification',
    ],
    [
      swap(real, 'ENV GOTOOLCHAIN=local', 'ENV GONOSUMDB=* GOTOOLCHAIN=local'),
      'loosens module verification',
    ],
    [swap(real, 'GOTOOLCHAIN=local', 'GOTOOLCHAIN=auto'), 'loosens module verification'],
    [swap(real, 'GOTOOLCHAIN=local', 'GOTOOLCHAIN_X=1'), 'GOTOOLCHAIN is not local'],
    [swap(real, 'go build -trimpath', 'go build'), '-trimpath'],
    // The licences stop travelling with the binary.
    [swap(real, 'cp LICENSE NOTICE', 'cp LICENSE'), 'licence and notice are not copied'],
    [swap(real, 'COPY --from=build /out/licenses /licenses\n', ''), 'licences are not copied'],
    // The final stage departs from the upstream contract.
    [
      swap(
        real,
        'ENTRYPOINT [ "/bin/mysqld_exporter" ]',
        'ENTRYPOINT [ "/bin/mysqld_exporter", "--log.level=debug" ]'
      ),
      'entrypoint differs',
    ],
    [swap(real, 'EXPOSE 9104', 'EXPOSE 9105'), 'exposed port differs'],
    [swap(real, 'USER nobody', 'USER root'), 'unprivileged user'],
    [
      swap(real, 'RUN apk del --no-cache apk-tools', 'RUN apk upgrade --no-cache'),
      'installs or upgrades',
    ],
    [swap(real, 'RUN apk del --no-cache apk-tools\n', ''), 'keeps the package manager'],
    [
      swap(
        real,
        'RUN apk del --no-cache apk-tools',
        'RUN apk del --no-cache apk-tools && rm -f /usr/bin/wget'
      ),
      'removes a tool',
    ],
    [
      swap(
        real,
        '/bin/mysqld_exporter\nCOPY --from=build /out/licenses',
        '/usr/bin/mysqld_exporter\nCOPY --from=build /out/licenses'
      ),
      'is not at /bin/mysqld_exporter',
    ],
  ];
  for (const [text, expected] of cases) {
    const found = dockerfileProblems(text);
    assert.ok(hasProblem(found, expected), `expected "${expected}", got ${JSON.stringify(found)}`);
  }
});

test('an unpinned FROM is reported as a pin problem', () => {
  const sabotaged = real.replace(/^(FROM .*golang:\S+)@sha256:[0-9a-f]{64}/m, '$1');
  assert.notEqual(sabotaged, real);
  assert.ok(hasProblem(dockerfileProblems(sabotaged), 'not pinned by tag and digest'));
});

test('the compose service reaches the image through its upstream entrypoint, port and user', () => {
  const service = composeService();
  assert.match(service, /^ {4}network_mode: host$/m);
  assert.doesNotMatch(service, /^ {4}(entrypoint|user):/m, 'compose overrides neither');
  const flags = commandFlags(service);
  assert.deepEqual(
    flags.map(([name]) => name),
    FLAGS,
    'the command carries exactly the three flags'
  );
  const listen = flags.find(([name]) => name === '--web.listen-address')[1];
  assert.ok(listen.endsWith(`:${UPSTREAM.port}`), 'the listen port is the one the image exposes');
});

test('the compose healthcheck runs tools the image keeps', () => {
  const service = composeService();
  const check = /test: \['CMD-SHELL', '(.+)'\]/.exec(service);
  assert.ok(check, 'the service has a CMD-SHELL healthcheck');
  assert.match(check[1], /\bwget\b/);
  assert.match(check[1], /\bgrep\b/);
  // The final stage is Alpine, whose busybox provides both, and removes neither.
  assert.match(real, /^FROM alpine:/m);
  assert.deepEqual(
    dockerfileProblems(real).filter((p) => p.includes('healthcheck')),
    []
  );
});

test('the workflow proof starts the exporter with the same flags the compose command passes', () => {
  const workflow = fs.readFileSync(WORKFLOW, 'utf8');
  const composeFlags = commandFlags(composeService()).map(([name]) => name);
  for (const flag of composeFlags) {
    assert.ok(workflow.includes(`${flag}=`), `the workflow proof passes ${flag}`);
  }
  assert.ok(workflow.includes(`--entrypoint`) === false, 'the proof keeps the image entrypoint');
});

test('the publish workflow follows the proof, push, scan, attest route', () => {
  assert.deepEqual(publishProblems(fs.readFileSync(WORKFLOW, 'utf8')), []);
});

test('the image is built for the platform db1 runs and the scan reads', () => {
  const workflow = fs.readFileSync(WORKFLOW, 'utf8');
  assert.match(
    workflow,
    /docker build --platform linux\/amd64 --tag mysqld-exporter:ci services\/mysqld-exporter/
  );
});

test('the build context holds no pinned input a build could pick up besides the Dockerfile', () => {
  const dir = path.join(ROOT, 'services', 'mysqld-exporter');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['Dockerfile', 'README.md']);
});
