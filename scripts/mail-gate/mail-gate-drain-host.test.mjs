// The spool's drain listener must bind one address, never every interface: the
// shim refuses to start with SHIM_DRAIN_PORT and no SHIM_DRAIN_HOST, and a
// wildcard host would put /drain on every network the spool joins. The gate runs
// the spool with that contract, on a network with a fixed subnet and the spool at
// a fixed address inside it. These tests build the real `docker run` argument list
// the gate passes (spoolRunArgs), read its flags and values back, and judge them.
// Each mutated argument list is refused. No Docker is needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GATE_SPOOL_ADDRESS, GATE_SUBNET, spoolRunArgs } from './mail-gate.mjs';

const IMAGE = 'example.invalid/spool@sha256:' + 'a'.repeat(64);

function gateArgs(overrides = {}) {
  return spoolRunArgs({
    spool: 'drain-host-test-spool',
    net: 'drain-host-test-net',
    token: 'token-for-test',
    drainPort: 40123,
    spoolImage: IMAGE,
    ...overrides,
  });
}

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

// The value that follows each occurrence of a flag, e.g. every '-e' value.
function valuesOf(args, flag) {
  const out = [];
  args.forEach((arg, i) => {
    if (arg === flag && i + 1 < args.length) out.push(args[i + 1]);
  });
  return out;
}

// The problems with a spool run argument list on a network with the given
// subnet, empty when the spool gets a drain host, a fixed address and a subnet.
function drainHostProblems(args, subnet) {
  const problems = [];
  const env = valuesOf(args, '-e');
  const hostEntries = env.filter((v) => v.startsWith('SHIM_DRAIN_HOST='));
  const hasDrainPort = env.includes('SHIM_DRAIN_PORT=8081');
  if (hasDrainPort && hostEntries.length === 0) {
    problems.push('the spool container sets SHIM_DRAIN_PORT with no SHIM_DRAIN_HOST');
  }
  const host = hostEntries.length === 1 ? hostEntries[0].slice('SHIM_DRAIN_HOST='.length) : null;
  if (hostEntries.length > 1) {
    problems.push('the spool container sets SHIM_DRAIN_HOST more than once');
  } else if (host === '' || host === null) {
    if (hostEntries.length === 1) problems.push('SHIM_DRAIN_HOST is empty');
  } else if (UNSPECIFIED.test(host)) {
    problems.push(`SHIM_DRAIN_HOST is a wildcard address (${host})`);
  } else if (ipv4ToInt(host) === null) {
    problems.push(`SHIM_DRAIN_HOST is not an IPv4 address literal (${host})`);
  }

  if (subnet === undefined || subnet === null || subnet === '') {
    problems.push(
      'the gate network is created with no fixed subnet, so the spool has no stable address'
    );
  }

  const ips = valuesOf(args, '--ip');
  if (ips.length !== 1) {
    problems.push(
      'the spool container is not started with --ip, so its address is not the bound host'
    );
  } else if (host && ips[0] !== host) {
    problems.push(`--ip (${ips[0]}) differs from SHIM_DRAIN_HOST (${host})`);
  }

  if (host && subnet && ipv4ToInt(host) !== null && !inSubnet(host, subnet)) {
    problems.push(`SHIM_DRAIN_HOST (${host}) is outside the gate network subnet (${subnet})`);
  }
  return problems;
}

function without(args, flag, value) {
  const i = args.findIndex((a, j) => a === flag && args[j + 1] === value);
  assert.ok(i >= 0, `${flag} ${value} is not in the argument list`);
  return [...args.slice(0, i), ...args.slice(i + 2)];
}

function replaced(args, from, to) {
  const i = args.indexOf(from);
  assert.ok(i >= 0, `${from} is not in the argument list`);
  return args.map((a, j) => (j === i ? to : a));
}

test('GREEN: the gate spool runs with a drain host, a fixed address and a fixed subnet', () => {
  assert.deepEqual(drainHostProblems(gateArgs(), GATE_SUBNET), []);
});

test('the gate addressing is an IPv4 address inside the gate subnet, never a wildcard', () => {
  assert.ok(
    inSubnet(GATE_SPOOL_ADDRESS, GATE_SUBNET),
    `${GATE_SPOOL_ADDRESS} not in ${GATE_SUBNET}`
  );
  assert.ok(!UNSPECIFIED.test(GATE_SPOOL_ADDRESS));
});

test('the gate subnet is not the production drain subnet', () => {
  assert.notEqual(GATE_SUBNET, '10.231.200.0/29');
});

test('RED: a gate spool with no SHIM_DRAIN_HOST is refused', () => {
  const args = without(gateArgs(), '-e', `SHIM_DRAIN_HOST=${GATE_SPOOL_ADDRESS}`);
  assert.match(drainHostProblems(args, GATE_SUBNET).join('\n'), /no SHIM_DRAIN_HOST/);
});

test('RED: a wildcard SHIM_DRAIN_HOST, 0.0.0.0, is refused', () => {
  const args = replaced(
    gateArgs(),
    `SHIM_DRAIN_HOST=${GATE_SPOOL_ADDRESS}`,
    'SHIM_DRAIN_HOST=0.0.0.0'
  );
  assert.match(drainHostProblems(args, GATE_SUBNET).join('\n'), /wildcard address \(0\.0\.0\.0\)/);
});

test('RED: a wildcard SHIM_DRAIN_HOST, ::, is refused', () => {
  const args = replaced(gateArgs(), `SHIM_DRAIN_HOST=${GATE_SPOOL_ADDRESS}`, 'SHIM_DRAIN_HOST=::');
  assert.match(drainHostProblems(args, GATE_SUBNET).join('\n'), /wildcard address \(::\)/);
});

test('RED: a SHIM_DRAIN_HOST outside the gate subnet is refused', () => {
  const args = replaced(
    gateArgs(),
    `SHIM_DRAIN_HOST=${GATE_SPOOL_ADDRESS}`,
    'SHIM_DRAIN_HOST=10.231.203.2'
  );
  assert.match(drainHostProblems(args, GATE_SUBNET).join('\n'), /outside the gate network subnet/);
});

test('RED: a SHIM_DRAIN_HOST that is a host name is refused', () => {
  const args = replaced(
    gateArgs(),
    `SHIM_DRAIN_HOST=${GATE_SPOOL_ADDRESS}`,
    'SHIM_DRAIN_HOST=mail-spool'
  );
  assert.match(drainHostProblems(args, GATE_SUBNET).join('\n'), /not an IPv4 address literal/);
});

test('RED: a spool started with no --ip is refused', () => {
  const args = without(gateArgs(), '--ip', GATE_SPOOL_ADDRESS);
  assert.match(drainHostProblems(args, GATE_SUBNET).join('\n'), /not started with --ip/);
});

test('RED: an --ip that differs from the bound host is refused', () => {
  const args = replaced(gateArgs(), GATE_SPOOL_ADDRESS, '10.231.202.3');
  assert.match(drainHostProblems(args, GATE_SUBNET).join('\n'), /differs from SHIM_DRAIN_HOST/);
});

test('RED: a gate network with no fixed subnet is refused', () => {
  assert.match(drainHostProblems(gateArgs(), undefined).join('\n'), /no fixed subnet/);
});
