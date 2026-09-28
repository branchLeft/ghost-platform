import { describe, expect, it } from 'vitest';

import { demoHostFirewallRules, edge1SshSource } from './firewall';

const EDGE1 = '95.217.1.1';

describe('demoHostFirewallRules', () => {
  it('is exactly 22 from edge1, 80 and 443 from anywhere, inbound only', () => {
    const rules = demoHostFirewallRules(EDGE1).map(({ description: _, ...rule }) => rule);
    expect(rules).toEqual([
      { direction: 'in', protocol: 'tcp', port: '22', sourceIps: ['95.217.1.1/32'] },
      { direction: 'in', protocol: 'tcp', port: '80', sourceIps: ['0.0.0.0/0', '::/0'] },
      { direction: 'in', protocol: 'tcp', port: '443', sourceIps: ['0.0.0.0/0', '::/0'] },
    ]);
  });

  it('carries no outbound rule, so the host keeps NTP and its updates', () => {
    expect(demoHostFirewallRules(EDGE1).filter((rule) => rule.direction !== 'in')).toEqual([]);
  });

  it('refuses a bad edge1 address rather than writing a rule from it', () => {
    expect(() => demoHostFirewallRules('0.0.0.0')).toThrow(/not a public address/);
  });
});

describe('edge1SshSource', () => {
  it('returns a single-host CIDR', () => {
    expect(edge1SshSource('46.225.95.167')).toBe('46.225.95.167/32');
    expect(edge1SshSource('1.1.1.1')).toBe('1.1.1.1/32');
  });

  it.each([
    ['', 'empty'],
    ['0.0.0.0/0', 'a CIDR'],
    ['95.217.1.1/32', 'already a CIDR'],
    ['95.217.1.0/24', 'a range'],
    ['::/0', 'IPv6'],
    ['2a01:4f8::1', 'IPv6'],
    ['95.217.1', 'three octets'],
    ['95.217.1.1.1', 'five octets'],
    ['95.217.1.256', 'an octet over 255'],
    ['95.217.01.1', 'a leading zero'],
    [' 95.217.1.1', 'leading space'],
    ['95.217.1.1\n', 'trailing newline'],
    ['edge1', 'a hostname'],
    ['undefined', 'an unset output rendered as text'],
  ])('refuses %j (%s)', (value) => {
    expect(() => edge1SshSource(value)).toThrow(/dotted-quad/);
  });

  it.each([
    '0.0.0.0',
    '10.20.1.10',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.0.2.10',
    '192.168.1.1',
    '198.18.0.1',
    '198.51.100.7',
    '203.0.113.10',
    '224.0.0.1',
    '255.255.255.255',
  ])('refuses the non-public address %s', (value) => {
    expect(() => edge1SshSource(value)).toThrow(/not a public address/);
  });

  it.each([
    '9.255.255.255',
    '11.0.0.0',
    '100.63.255.255',
    '100.128.0.0',
    '172.15.255.255',
    '172.32.0.0',
    '223.255.255.255',
  ])('accepts the public address %s, just outside a refused range', (value) => {
    expect(edge1SshSource(value)).toBe(`${value}/32`);
  });
});
