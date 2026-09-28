import * as pulumi from '@pulumi/pulumi';
import { beforeAll, describe, expect, it } from 'vitest';

// The whole program under Pulumi's mocks. The firewall is asserted as the
// program declares it, so the edge1 address is the estate stack's output.

type Created = { type: string; name: string; inputs: Record<string, unknown> };

const created: Created[] = [];
const calls: string[] = [];
const EDGE1 = '95.217.1.1';

beforeAll(async () => {
  pulumi.runtime.setMocks(
    {
      newResource(args: pulumi.runtime.MockResourceArgs) {
        created.push({ type: args.type, name: args.name, inputs: args.inputs });
        if (args.type === 'pulumi:pulumi:StackReference') {
          return {
            id: args.name,
            state: { name: args.name, outputs: { edge1PublicIpv4: EDGE1, estateLocation: 'nbg1' } },
          };
        }
        return { id: `${created.length}`, state: { ...args.inputs, ipAddress: '198.51.100.20' } };
      },
      call(args: pulumi.runtime.MockCallArgs) {
        calls.push(args.token);
        if (args.token === 'hcloud:index/getFirewalls:getFirewalls') {
          return { firewalls: [{ name: 'project-marker-demos' }] };
        }
        return { servers: [] };
      },
    },
    'branchleft-ghost-platform-demo-host',
    'production',
    false
  );
  pulumi.runtime.setAllConfig({
    'branchleft-ghost-platform-demo-host:image': 'debian-13',
    'branchleft-ghost-platform-demo-host:serverType': 'cx23',
    'branchleft-ghost-platform-demo-host:ownerSshKeyNames': '["rob@branchleft.co.uk"]',
  });
  await import('./index.js');
  await new Promise((resolve) => setTimeout(resolve, 0));
});

const ofType = (type: string) => created.filter((r) => r.type === type);
const only = (type: string) => {
  const found = ofType(type);
  expect(found).toHaveLength(1);
  return found[0] as Created;
};

describe('the demo host program', () => {
  it('declares one server, one firewall and two primary IPs, and nothing else', () => {
    expect(
      created
        .filter((r) => r.type !== 'pulumi:pulumi:StackReference')
        .map((r) => `${r.type} ${r.name}`)
        .sort()
    ).toEqual([
      'hcloud:index/firewall:Firewall demo1-firewall',
      'hcloud:index/primaryIp:PrimaryIp demo1-ipv4',
      'hcloud:index/primaryIp:PrimaryIp demo1-ipv6',
      'hcloud:index/server:Server demo1',
    ]);
  });

  it("creates the server behind exactly 22 from edge1's address, and 80 and 443 from anywhere", () => {
    const firewall = only('hcloud:index/firewall:Firewall');
    const rules = (firewall.inputs['rules'] as Record<string, unknown>[]).map(
      ({ description: _, ...rule }) => rule
    );
    expect(rules).toEqual([
      { direction: 'in', protocol: 'tcp', port: '22', sourceIps: [`${EDGE1}/32`] },
      { direction: 'in', protocol: 'tcp', port: '80', sourceIps: ['0.0.0.0/0', '::/0'] },
      { direction: 'in', protocol: 'tcp', port: '443', sourceIps: ['0.0.0.0/0', '::/0'] },
    ]);
    expect(firewall.inputs['name']).toBe('demo1');
  });

  it('reads edge1 from the estate stack as applied', () => {
    expect(only('pulumi:pulumi:StackReference').name).toBe(
      'organization/branchleft-hetzner-estate/production'
    );
  });

  it('attaches the firewall on the server at creation', () => {
    const firewall = only('hcloud:index/firewall:Firewall');
    const server = only('hcloud:index/server:Server');
    expect(server.inputs['firewallIds']).toEqual([Number(created.indexOf(firewall) + 1)]);
  });

  it('gives demo1 its own IPv4 and IPv6, kept past the server', () => {
    const server = only('hcloud:index/server:Server');
    const [net] = server.inputs['publicNets'] as Record<string, unknown>[];
    expect(net).toMatchObject({ ipv4Enabled: true, ipv6Enabled: true });
    for (const ip of ofType('hcloud:index/primaryIp:PrimaryIp')) {
      expect(ip.inputs).toMatchObject({
        location: 'nbg1',
        assigneeType: 'server',
        autoDelete: false,
        deleteProtection: true,
      });
    }
    expect(
      ofType('hcloud:index/primaryIp:PrimaryIp')
        .map((r) => r.inputs['type'])
        .sort()
    ).toEqual(['ipv4', 'ipv6']);
  });

  it('is a protected cx23 in Nuremberg on no private network', () => {
    const server = only('hcloud:index/server:Server');
    expect(server.inputs).toMatchObject({
      name: 'demo1',
      serverType: 'cx23',
      location: 'nbg1',
      image: 'debian-13',
      backups: false,
      sshKeys: ['rob@branchleft.co.uk'],
      deleteProtection: true,
      rebuildProtection: true,
    });
    expect(server.inputs['networks']).toBeUndefined();
    expect(String(server.inputs['userData'])).toMatch(/^#cloud-config\nhostname: demo1$/m);
  });

  it('asks the token which project it holds before planning anything', () => {
    expect(calls).toContain('hcloud:index/getServers:getServers');
    expect(calls).toContain('hcloud:index/getFirewalls:getFirewalls');
  });
});
