// The Percona Server image is the engine's own image with three changes (fixed
// operating system packages, the telemetry agent and MySQL Shell removed,
// telemetry off). These checks pin what keeps that honest: the base is the
// pinned, mirrored digest and nothing else, the update can only move operating
// system packages, the removals are checked inside the build, the workflow
// builds against the private mirror with a read-only grant and publishes from
// `main` only, and every exemption the image carries is a bounded, named,
// single-finding entry. The scan and attest order is in
// workflow-image-scan-before-attest.test.js; the signer literal is in
// workflow-image-attestation.test.js. Each case below breaks one property in a
// copy of the real text and requires a named problem, so a passing run means the
// check can see the break.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseJobs, withoutComments } from './test-support/publish-job-checks.mjs';

const ROOT = import.meta.dirname;
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const IMAGE = 'ghcr.io/branchleft/percona-server';
const MIRROR = 'ghcr.io/branchleft/mirror-private2';
const UBI = ['ubi-9-baseos-rpms', 'ubi-9-appstream-rpms'];
const MAX_REASON = 500;
const MAX_DAYS = 30;

const uncommentedDockerfile = (text) => text.replace(/^[ \t]*#.*$/gm, '');

export function dockerfileProblems(source, mirroredDigests) {
  const found = [];
  const text = uncommentedDockerfile(source);

  const froms = [...text.matchAll(/^FROM (.+)$/gm)].map((m) => m[1].trim());
  if (froms.length !== 1) found.push(`expected exactly one FROM, found ${froms.length}`);
  const from =
    /^\$\{IMAGE_REGISTRY:-docker\.io\/percona\}\/percona-server:8\.0@(sha256:[0-9a-f]{64})$/.exec(
      froms[0] ?? ''
    );
  if (!from) {
    found.push(
      'the base is not the mirrored form ${IMAGE_REGISTRY:-docker.io/percona}/percona-server:8.0@sha256:<digest>'
    );
  } else if (!mirroredDigests.includes(from[1])) {
    found.push(`the base digest ${from[1]} is not a percona-server entry in the mirror list`);
  }

  const args = [...text.matchAll(/^ARG (.+)$/gm)].map((m) => m[1].trim());
  if (args.length !== 1 || args[0] !== 'IMAGE_REGISTRY') {
    found.push(`the only build argument is IMAGE_REGISTRY, found: ${args.join(', ') || 'none'}`);
  }

  const users = [...text.matchAll(/^USER (.+)$/gm)].map((m) => m[1].trim());
  if (users.length !== 2 || users[0] !== 'root' || users[1] !== 'mysql') {
    found.push(`USER must be root for the change and mysql after it, found: ${users.join(', ')}`);
  }

  if (!/^ENV PERCONA_TELEMETRY_DISABLE=1$/m.test(text)) {
    found.push('telemetry is not turned off by ENV PERCONA_TELEMETRY_DISABLE=1');
  }

  const runs = [...text.matchAll(/^RUN ((?:.*\\\n)*.*)$/gm)].map((m) => m[1]);
  if (runs.length !== 1) found.push(`expected one RUN layer, found ${runs.length}`);
  const run = runs[0] ?? '';
  if (!/rpm -e --nodeps percona-telemetry-agent percona-mysql-shell;/.test(run)) {
    found.push('the telemetry agent and MySQL Shell are not removed with rpm -e --nodeps');
  }
  if (!/rm -f \/call-home\.sh \/usr\/bin\/telemetry-agent-supervisor\.sh;/.test(run)) {
    found.push('the call-home script and the supervisor are not deleted');
  }
  if (!/microdnf --disablerepo='\*'/.test(run)) {
    found.push('the update does not disable every repository first');
  }
  const enabled = [...run.matchAll(/--enablerepo=(\S+)/g)].map((m) => m[1]);
  if (JSON.stringify(enabled) !== JSON.stringify(UBI)) {
    found.push(
      `the update must enable exactly the two UBI repositories, found: ${enabled.join(', ')}`
    );
  }
  if (!/ update -y;/.test(run) || /microdnf[^;]*\b(install|upgrade|reinstall)\b/.test(run)) {
    found.push('the step must update, not install or reinstall');
  }
  if (!/percona-server-server-8\.0\.46-37\.1\.el9\./.test(run)) {
    found.push('the step does not check the server package is still at 8.0.46-37.1.el9');
  }
  if (!/for removed in percona-telemetry-agent percona-mysql-shell/.test(run)) {
    found.push('the step does not check both removals took effect');
  }
  if (!/mysqld --version \| grep -F 'Ver 8\.0\.46-37'/.test(run)) {
    found.push('the step does not check the server version');
  }
  if (/\b(curl|wget)\b|^ADD /m.test(text)) {
    found.push('the image fetches something other than the pinned base and UBI packages');
  }
  if (/^(CMD|ENTRYPOINT|EXPOSE|VOLUME|HEALTHCHECK)\b/m.test(text)) {
    found.push('the image changes the base entrypoint contract');
  }
  return found;
}

export function workflowProblems(source) {
  const found = [];
  const text = withoutComments(source);
  const jobs = parseJobs(source);
  const { test: unit, build, push } = jobs;
  if (!unit || !build || !push) return ['the workflow needs test, build and push jobs'];

  const top = text.split(/^jobs:\n/m)[0];
  if (!/^permissions:\n {2}contents: read\n {2}packages: read\n/m.test(top)) {
    found.push('workflow permissions are not exactly contents: read, packages: read');
  }
  if (/:\s*write(-all)?\s*$/m.test(top)) found.push('top-level permissions grant a write scope');

  for (const [name, job] of [
    ['build', build],
    ['push', push],
  ]) {
    if (!new RegExp(`^ {6}IMAGE_REGISTRY: ${MIRROR}$`, 'm').test(job.text)) {
      found.push(`${name} job does not set IMAGE_REGISTRY to the private mirror`);
    }
    if (!/--build-arg IMAGE_REGISTRY \\\n/.test(job.text)) {
      found.push(`${name} job does not pass IMAGE_REGISTRY to the build`);
    }
    if (!/--platform linux\/amd64/.test(job.text))
      found.push(`${name} job does not build linux/amd64`);
    if (!/docker\/login-action@[0-9a-f]{40}/.test(job.text)) {
      found.push(`${name} job pulls from the private mirror without logging in`);
    }
    if (!/python3 db\/percona\/smoke_check\.py /.test(job.text)) {
      found.push(`${name} job does not run the smoke check`);
    }
  }
  if (/packages:\s*write/.test(build.text) || /packages:\s*write/.test(unit.text)) {
    found.push('only the push job may write packages');
  }
  if (!/^ {4}needs: test$/m.test(push.text)) found.push('push job does not wait on the unit tests');
  const guard = push.condition
    .replace(/^\s*if:\s*\|?-?/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (
    guard !==
    "github.ref == 'refs/heads/main' && (github.event_name == 'workflow_dispatch' || github.event_name == 'push')"
  ) {
    found.push('push job is not guarded to main by push or manual run');
  }
  if (!new RegExp(`^ {6}IMAGE: ${IMAGE}$`, 'm').test(push.text))
    found.push(`push job does not name ${IMAGE}`);
  if (/:latest|--tag "\$IMAGE:latest"/.test(push.text)) found.push('push job tags latest');
  if (!/docker push "\$IMAGE:\$IMAGE_TAG"/.test(push.text)) found.push('push job never pushes');
  return found;
}

export function exemptionProblems(document, image = IMAGE) {
  const found = [];
  const seen = new Set();
  const entries = (document.exemptions ?? []).filter((e) => e.image === image);
  if (entries.length === 0) found.push(`no exemption names ${image}`);
  for (const e of entries) {
    const label = `${e.vulnerability} in ${e.package}`;
    const keys = Object.keys(e).sort().join(',');
    if (keys !== 'expires,granted,image,package,reason,vulnerability') {
      found.push(`${label}: keys are ${keys}`);
    }
    if (seen.has(label)) found.push(`${label}: listed twice`);
    seen.add(label);
    if (typeof e.reason !== 'string' || e.reason.trim() === '' || e.reason.length > MAX_REASON) {
      found.push(`${label}: reason is empty or longer than ${MAX_REASON} characters`);
    }
    if (!/No fix: /.test(e.reason ?? ''))
      found.push(`${label}: reason does not say there is no fix`);
    const days = (Date.parse(e.expires) - Date.parse(e.granted)) / 86400000;
    if (!(days > 0 && days <= MAX_DAYS))
      found.push(`${label}: expiry is not within ${MAX_DAYS} days of the grant`);
    if (!/^(CVE-\d{4}-\d+|GHSA-[\w-]+|GO-\d{4}-\d+)$/.test(e.vulnerability)) {
      found.push(`${label}: vulnerability is not an advisory id`);
    }
  }
  return found;
}

const has = (list, expected) => list.some((p) => p.includes(expected));
const swap = (text, from, to) => {
  assert.ok(text.includes(from), `the real text contains ${JSON.stringify(from)}`);
  return text.replace(from, to);
};

const dockerfile = read('db/percona/Dockerfile');
const workflow = read('.github/workflows/percona-image.yml');
const exemptions = JSON.parse(read('.image-scan-exemptions.json'));
const mirrored = JSON.parse(read('.github/image-mirror/images.json'))
  .images.filter((i) => i.name === 'percona-server')
  .map((i) => i.digest);

test('the Dockerfile layers over the mirrored Percona digest and changes only what it says', () => {
  assert.deepEqual(dockerfileProblems(dockerfile, mirrored), []);
});

test('the Dockerfile checker reports each way the image can drift', () => {
  const digest = /@(sha256:[0-9a-f]{64})/.exec(dockerfile)[1];
  const cases = [
    [swap(dockerfile, `@${digest}`, ''), 'is not the mirrored form'],
    [swap(dockerfile, digest, `sha256:${'0'.repeat(64)}`), 'not a percona-server entry'],
    [
      swap(dockerfile, '${IMAGE_REGISTRY:-docker.io/percona}', 'docker.io/percona'),
      'is not the mirrored form',
    ],
    [swap(dockerfile, 'percona-server:8.0@', 'percona-server:8.4@'), 'is not the mirrored form'],
    [
      swap(dockerfile, 'ARG IMAGE_REGISTRY\n', 'ARG IMAGE_REGISTRY\nARG EXTRA=1\n'),
      'the only build argument',
    ],
    [swap(dockerfile, '\nUSER mysql\n', '\nUSER root\n'), 'USER must be root'],
    [
      swap(dockerfile, 'ENV PERCONA_TELEMETRY_DISABLE=1', 'ENV PERCONA_TELEMETRY_DISABLE=0'),
      'telemetry is not turned off',
    ],
    [
      swap(
        dockerfile,
        'rpm -e --nodeps percona-telemetry-agent percona-mysql-shell',
        'microdnf remove -y percona-telemetry-agent percona-mysql-shell'
      ),
      'not removed with rpm -e --nodeps',
    ],
    [swap(dockerfile, "--disablerepo='*' ", ''), 'does not disable every repository'],
    [
      swap(
        dockerfile,
        '--enablerepo=ubi-9-appstream-rpms',
        '--enablerepo=ubi-9-appstream-rpms --enablerepo=ps-80-testing-x86_64'
      ),
      'exactly the two UBI repositories',
    ],
    [swap(dockerfile, ' update -y;', ' install -y curl;'), 'must update, not install'],
    [
      swap(dockerfile, '    rm -f /call-home.sh /usr/bin/telemetry-agent-supervisor.sh; \\\n', ''),
      'call-home script',
    ],
    [
      swap(dockerfile, "    mysqld --version | grep -F 'Ver 8.0.46-37'\n", '    true\n'),
      'does not check the server version',
    ],
    [
      swap(
        dockerfile,
        '    for removed in percona-telemetry-agent percona-mysql-shell; do',
        '    for removed in percona-mysql-shell; do'
      ),
      'both removals',
    ],
    [
      swap(dockerfile, 'percona-server-server-8.0.46-37.1.el9.', 'percona-server-server-8.0.99.'),
      'still at 8.0.46-37.1.el9',
    ],
    [`${dockerfile}\nADD https://example.invalid/x /x\n`, 'fetches something other'],
    [`${dockerfile}\nENTRYPOINT ["/bin/sh"]\n`, 'entrypoint contract'],
  ];
  for (const [text, expected] of cases) {
    const found = dockerfileProblems(text, mirrored);
    assert.ok(has(found, expected), `expected "${expected}", got ${JSON.stringify(found)}`);
  }
});

test('the workflow builds against the private mirror with read access and publishes from main only', () => {
  assert.deepEqual(workflowProblems(workflow), []);
});

test('the workflow checker reports each way the build or publish can drift', () => {
  const cases = [
    [
      swap(
        workflow,
        `IMAGE_REGISTRY: ${MIRROR}\n\n    steps:`,
        'IMAGE_REGISTRY: docker.io/percona\n\n    steps:'
      ),
      'does not set IMAGE_REGISTRY',
    ],
    [
      swap(
        workflow,
        'permissions:\n  contents: read\n  packages: read\n',
        'permissions:\n  contents: read\n'
      ),
      'not exactly contents: read, packages: read',
    ],
    [
      swap(
        workflow,
        'permissions:\n  contents: read\n  packages: read\n',
        'permissions: write-all\n'
      ),
      'top-level permissions grant a write scope',
    ],
    [
      swap(
        workflow,
        '            --build-arg IMAGE_REGISTRY \\\n            --file db/percona/Dockerfile \\\n            --tag percona-server:ci',
        '            --file db/percona/Dockerfile \\\n            --tag percona-server:ci'
      ),
      'build job does not pass IMAGE_REGISTRY',
    ],
    [
      swap(
        workflow,
        'docker build --platform linux/amd64 \\\n            --build-arg IMAGE_REGISTRY \\\n            --file db/percona/Dockerfile \\\n            --tag percona-server:ci',
        'docker build \\\n            --build-arg IMAGE_REGISTRY \\\n            --file db/percona/Dockerfile \\\n            --tag percona-server:ci'
      ),
      'build job does not build linux/amd64',
    ],
    [
      swap(workflow, 'run: python3 db/percona/smoke_check.py "$IMAGE:$IMAGE_TAG"', 'run: true'),
      'push job does not run the smoke check',
    ],
    [
      swap(workflow, 'run: python3 db/percona/smoke_check.py percona-server:ci', 'run: true'),
      'build job does not run the smoke check',
    ],
    [
      swap(workflow, "github.ref == 'refs/heads/main' &&", "github.ref != ''  &&"),
      'not guarded to main',
    ],
    [
      swap(
        workflow,
        '    needs: test\n    # `main` for every trigger',
        '    needs: build\n    # `main` for every trigger'
      ),
      'does not wait on the unit tests',
    ],
    [
      swap(
        workflow,
        `IMAGE: ${IMAGE}\n      IMAGE_TAG`,
        'IMAGE: ghcr.io/branchleft/other\n      IMAGE_TAG'
      ),
      'does not name',
    ],
    [
      swap(
        workflow,
        '    timeout-minutes: 20\n    env:\n      IMAGE_REGISTRY: ghcr.io/branchleft/mirror-private2\n',
        '    timeout-minutes: 20\n    permissions:\n      packages: write\n    env:\n      IMAGE_REGISTRY: ghcr.io/branchleft/mirror-private2\n'
      ),
      'only the push job may write',
    ],
  ];
  for (const [text, expected] of cases) {
    const found = workflowProblems(text);
    assert.ok(has(found, expected), `expected "${expected}", got ${JSON.stringify(found)}`);
  }
});

test('every exemption for the Percona image is one bounded, named finding with no fix', () => {
  assert.deepEqual(exemptionProblems(exemptions), []);
});

test('the exemption checker reports each way an entry can be too loose', () => {
  const first = exemptions.exemptions.findIndex((e) => e.image === IMAGE);
  const mutate = (change) => {
    const copy = structuredClone(exemptions);
    change(copy.exemptions[first], copy.exemptions);
    return copy;
  };
  const cases = [
    [mutate((e) => (e.expires = '2027-06-01')), 'expiry is not within 30 days'],
    [mutate((e) => (e.reason = '')), 'reason is empty'],
    [mutate((e) => (e.reason = 'No fix: '.padEnd(501, 'x'))), 'longer than 500'],
    [mutate((e) => (e.reason = 'It is fine.')), 'does not say there is no fix'],
    [mutate((e, all) => all.push(structuredClone(e))), 'listed twice'],
    [mutate((e) => (e.vulnerability = 'high')), 'not an advisory id'],
    [mutate((e) => (e.severity = 'high')), 'keys are'],
    [{ exemptions: exemptions.exemptions.filter((e) => e.image !== IMAGE) }, 'no exemption names'],
  ];
  for (const [document, expected] of cases) {
    const found = exemptionProblems(document);
    assert.ok(has(found, expected), `expected "${expected}", got ${JSON.stringify(found)}`);
  }
});

test('the shared exemptions file still holds the entry for the demo edge', () => {
  assert.ok(exemptions.exemptions.some((e) => e.image === 'ghcr.io/branchleft/demo-edge'));
});
