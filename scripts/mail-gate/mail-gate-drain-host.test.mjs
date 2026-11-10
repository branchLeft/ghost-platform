// The spool's drain listener must bind one address, never every interface: the
// shim refuses to start with SHIM_DRAIN_PORT and no SHIM_DRAIN_HOST, and a
// wildcard host would put /drain on every network the spool joins. The gate runs
// the spool with that contract, on a network with a fixed subnet and the spool at
// a fixed address inside it. This checks the spool container's run args and the
// network creation in mail-gate.mjs as source text, so it needs no Docker. The
// real source passes; each mutated copy of it is refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GATE_SPOOL_ADDRESS, GATE_SUBNET } from './mail-gate.mjs';

const source = readFileSync(fileURLToPath(new URL('./mail-gate.mjs', import.meta.url)), 'utf8');

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const UNSPECIFIED = /^\[?[0.:]+\]?$/;

function ipv4ToInt(address) {
  const m = IPV4.exec(address);
  if (!m || m.slice(1).some((octet) => Number(octet) > 255)) return null;
  return m.slice(1).reduce((acc, octet) => acc * 256 + Number(octet), 0);
}

function inSubnet(address, cidr) {
  const [base, bits] = cidr.split('/');
  const a = ipv4ToInt(address);
  const b = ipv4ToInt(base);
  if (a === null || b === null || !(Number(bits) >= 0 && Number(bits) <= 32)) return false;
  const size = 2 ** (32 - Number(bits));
  return Math.floor(a / size) === Math.floor(b / size);
}

// A run-arg or call-arg value: a quoted literal, or an exported const of this file.
function resolve(text, token) {
  const literal = /^'([^']*)'$/.exec(token);
  if (literal) return literal[1];
  const named = new RegExp(`export const ${token} =\\s*'([^']*)';`).exec(text);
  return named ? named[1] : null;
}

// The problems with how a gate source runs its spool, empty when it is right.
function drainHostProblems(text) {
  const problems = [];
  const runStart = text.indexOf("'run',");
  const spoolImageAt = text.indexOf('spoolImage', runStart);
  if (runStart < 0 || spoolImageAt < runStart) {
    return ['the spool container run call must be present'];
  }
  const args = text.slice(runStart, spoolImageAt);

  if (!/'-e',\s*'SHIM_DRAIN_PORT=\d+'/.test(args)) {
    problems.push(
      "the spool container must set 'SHIM_DRAIN_PORT=<n>' as separate '-e' and value arguments"
    );
  }

  const hostArg = /'-e',\s*(?:'SHIM_DRAIN_HOST=([^']*)'|`SHIM_DRAIN_HOST=\$\{(\w+)\}`)/.exec(args);
  const host = hostArg ? (hostArg[1] ?? resolve(text, hostArg[2])) : null;
  if (!hostArg) {
    problems.push('the spool container sets SHIM_DRAIN_PORT with no SHIM_DRAIN_HOST');
  } else if (host === null || host === '') {
    problems.push('SHIM_DRAIN_HOST is empty or does not resolve to a literal');
  } else if (UNSPECIFIED.test(host)) {
    problems.push(`SHIM_DRAIN_HOST is a wildcard address (${host})`);
  } else if (ipv4ToInt(host) === null) {
    problems.push(`SHIM_DRAIN_HOST is not an IPv4 address literal (${host})`);
  }

  const networkArg = /createNetwork\(\s*net\s*(?:,\s*(\w+|'[^']*'))?\s*\)/.exec(text);
  const subnet = networkArg?.[1] ? resolve(text, networkArg[1]) : null;
  if (!networkArg) {
    problems.push('the gate must create its network with createNetwork(net, <subnet>)');
  } else if (!subnet) {
    problems.push(
      'the gate network is created with no fixed subnet, so the spool has no stable address'
    );
  }

  const ipArg = /'--ip',\s*(\w+|'[^']*')/.exec(args);
  const ip = ipArg ? resolve(text, ipArg[1]) : null;
  if (!ipArg) {
    problems.push(
      'the spool container is not started with --ip, so its address is not the bound host'
    );
  } else if (host && ip !== host) {
    problems.push(`--ip (${ip}) differs from SHIM_DRAIN_HOST (${host})`);
  }

  if (host && subnet && ipv4ToInt(host) !== null && !inSubnet(host, subnet)) {
    problems.push(`SHIM_DRAIN_HOST (${host}) is outside the gate network subnet (${subnet})`);
  }
  return problems;
}

function mutate(from, to) {
  assert.ok(source.includes(from), `mutation target not found in mail-gate.mjs: ${from}`);
  return source.replace(from, to);
}

test('GREEN: the real gate runs its spool with a drain host, a fixed address and a fixed subnet', () => {
  assert.deepEqual(drainHostProblems(source), []);
});

test('the exported gate addressing is an IPv4 address inside the exported subnet', () => {
  assert.ok(
    inSubnet(GATE_SPOOL_ADDRESS, GATE_SUBNET),
    `${GATE_SPOOL_ADDRESS} not in ${GATE_SUBNET}`
  );
  assert.ok(!UNSPECIFIED.test(GATE_SPOOL_ADDRESS));
});

test('the gate subnet is not the production drain subnet', () => {
  assert.notEqual(GATE_SUBNET, '10.231.200.0/29');
});

const reds = [
  [
    'no SHIM_DRAIN_HOST',
    () => mutate("      '-e',\n      `SHIM_DRAIN_HOST=${GATE_SPOOL_ADDRESS}`,\n", ''),
    /no SHIM_DRAIN_HOST/,
  ],
  [
    'a wildcard host, 0.0.0.0',
    () => mutate('`SHIM_DRAIN_HOST=${GATE_SPOOL_ADDRESS}`', "'SHIM_DRAIN_HOST=0.0.0.0'"),
    /wildcard address \(0\.0\.0\.0\)/,
  ],
  [
    'a wildcard host, ::',
    () => mutate('`SHIM_DRAIN_HOST=${GATE_SPOOL_ADDRESS}`', "'SHIM_DRAIN_HOST=::'"),
    /wildcard address \(::\)/,
  ],
  [
    'a host outside the gate subnet',
    () => mutate('`SHIM_DRAIN_HOST=${GATE_SPOOL_ADDRESS}`', "'SHIM_DRAIN_HOST=10.231.203.2'"),
    /outside the gate network subnet/,
  ],
  [
    'a host name instead of an address',
    () => mutate('`SHIM_DRAIN_HOST=${GATE_SPOOL_ADDRESS}`', "'SHIM_DRAIN_HOST=mail-spool'"),
    /not an IPv4 address literal/,
  ],
  [
    'no --ip',
    () => mutate("      '--ip',\n      GATE_SPOOL_ADDRESS,\n", ''),
    /not started with --ip/,
  ],
  [
    '--ip that differs from the bound host',
    () => mutate("'--ip',\n      GATE_SPOOL_ADDRESS,", "'--ip',\n      '10.231.202.3',"),
    /differs from SHIM_DRAIN_HOST/,
  ],
  [
    'a network created with no subnet',
    () => mutate('createNetwork(net, GATE_SUBNET)', 'createNetwork(net)'),
    /no fixed subnet/,
  ],
];

for (const [label, build, expected] of reds) {
  test(`RED: a gate with ${label} is refused`, () => {
    const problems = drainHostProblems(build());
    assert.ok(
      problems.some((p) => expected.test(p)),
      `expected a problem matching ${expected}, got ${JSON.stringify(problems)}`
    );
  });
}
