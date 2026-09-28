import type * as hcloud from '@pulumi/hcloud';

/** demo1's whole inbound surface, and nothing else. Why each rule, and why
 * there is no outbound rule: README.md, "The firewall". */

type Rule = hcloud.types.input.FirewallRule;

const ANY_SOURCE = ['0.0.0.0/0', '::/0'];

const DOTTED_QUAD = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** Never edge1's public address, and each a plausible wrong value to wire
 * here: edge1's private address, a documentation example, an unset 0.0.0.0. */
const NOT_PUBLIC: readonly [number, number][] = [
  [0x00000000, 8], // 0.0.0.0/8, "this network"
  [0x0a000000, 8], // 10.0.0.0/8
  [0x64400000, 10], // 100.64.0.0/10, carrier-grade NAT
  [0x7f000000, 8], // 127.0.0.0/8
  [0xa9fe0000, 16], // 169.254.0.0/16, link-local and the metadata service
  [0xac100000, 12], // 172.16.0.0/12
  [0xc0000200, 24], // 192.0.2.0/24, documentation
  [0xc0a80000, 16], // 192.168.0.0/16
  [0xc6120000, 15], // 198.18.0.0/15, benchmarking
  [0xc6336400, 24], // 198.51.100.0/24, documentation
  [0xcb007100, 24], // 203.0.113.0/24, documentation
  [0xe0000000, 3], // 224.0.0.0/3, multicast and reserved
];

function toInt(address: string): number {
  return address.split('.').reduce((acc, octet) => acc * 256 + Number(octet), 0);
}

function inRange(value: number, [base, bits]: [number, number]): boolean {
  const size = 2 ** (32 - bits);
  return value >= base && value < base + size;
}

/** One address, never a range: a CIDR in the input would let a typo widen the
 * rule without anything looking wrong in a diff. */
export function edge1SshSource(address: string): string {
  if (!DOTTED_QUAD.test(address)) {
    throw new Error(
      `edge1's public address must be one dotted-quad IPv4 address, got ${JSON.stringify(address)}. ` +
        'It becomes the only source allowed to reach port 22 on demo1.'
    );
  }
  const value = toInt(address);
  if (NOT_PUBLIC.some((range) => inRange(value, range))) {
    throw new Error(
      `${address} is not a public address, so it cannot be edge1's. ` +
        "Read the estate stack's edge1PublicIpv4 output; the private 10.20.1.10 is never the source demo1 sees."
    );
  }
  return `${address}/32`;
}

export function demoHostFirewallRules(edge1PublicIpv4: string): Rule[] {
  return [
    {
      direction: 'in',
      protocol: 'tcp',
      port: '22',
      sourceIps: [edge1SshSource(edge1PublicIpv4)],
      description: 'SSH from edge1 only: the owner via jump host, ops1 via NAT',
    },
    {
      direction: 'in',
      protocol: 'tcp',
      port: '80',
      sourceIps: ANY_SOURCE,
      description: 'demo edge, HTTP-01 and redirect',
    },
    {
      direction: 'in',
      protocol: 'tcp',
      port: '443',
      sourceIps: ANY_SOURCE,
      description: 'demo edge',
    },
  ];
}
