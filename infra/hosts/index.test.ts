import * as pulumi from '@pulumi/pulumi';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Runs the whole program under Pulumi's mocks and asserts the resource
 * inventory it declares. The point is the pair of `publicNetworking`
 * literals: they are adjacent, symmetric, and create-time-only — a
 * transposition survives typecheck, wedges the stack if caught at apply,
 * and exposes the database host publicly if not caught at all. The
 * inventory assertions double as the structural half of the "exactly two
 * hosts, their firewalls, addresses and attachments" acceptance check.
 */

type Created = {
  type: string;
  name: string;
  inputs: Record<string, unknown>;
};

const created: Created[] = [];

beforeAll(async () => {
  pulumi.runtime.setMocks(
    {
      newResource(args: pulumi.runtime.MockResourceArgs) {
        created.push({ type: args.type, name: args.name, inputs: args.inputs });
        if (args.type === 'pulumi:pulumi:StackReference') {
          return {
            id: args.name,
            state: {
              name: args.name,
              outputs: { networkId: '4242', estateLocation: 'nbg1' },
            },
          };
        }
        return { id: `${args.name}-id`, state: { ...args.inputs, ipAddress: '203.0.113.10' } };
      },
      call() {
        // hcloud.getServers for the project guard: an estate-shaped project.
        return { servers: [] };
      },
    },
    'branchleft-ghost-platform-hosts',
    'production',
    false
  );
  pulumi.runtime.setAllConfig({
    'branchleft-ghost-platform-hosts:image': 'debian-13',
    'branchleft-ghost-platform-hosts:app1ServerType': 'cx23',
    'branchleft-ghost-platform-hosts:db1ServerType': 'cx23',
    'branchleft-ghost-platform-hosts:ownerSshKeyNames': '["rob@branchleft.co.uk"]',
    'branchleft-ghost-platform-hosts:app1DeployPublicKey':
      'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEXAMPLE deploy@app1',
    'branchleft-ghost-platform-hosts:db1DeployPublicKey':
      'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEXAMPLE deploy@db1',
  });
  await import('./index.js');
  // Let module-scope outputs settle before any assertion reads `created`.
  await new Promise((resolve) => setTimeout(resolve, 0));
});

const servers = () => created.filter((r) => r.type === 'hcloud:index/server:Server');
const byName = (name: string) => {
  const server = servers().find((r) => r.name === name);
  if (server === undefined) {
    throw new Error(`no server named ${name} was declared`);
  }
  return server;
};
const publicNet = (name: string) =>
  (byName(name).inputs['publicNets'] as { ipv4Enabled: boolean; ipv6Enabled: boolean }[])[0];

describe('the hosts program', () => {
  it('declares exactly two servers, two firewalls and two network attachments', () => {
    expect(
      servers()
        .map((r) => r.name)
        .sort()
    ).toEqual(['app1', 'db1']);
    expect(created.filter((r) => r.type === 'hcloud:index/firewall:Firewall')).toHaveLength(2);
    expect(
      created.filter((r) => r.type === 'hcloud:index/serverNetwork:ServerNetwork')
    ).toHaveLength(2);
  });

  it('attaches each host at its address-plan address', () => {
    const ips = created
      .filter((r) => r.type === 'hcloud:index/serverNetwork:ServerNetwork')
      .map((r) => r.inputs['ip'])
      .sort();
    expect(ips).toEqual(['10.20.1.100', '10.20.1.20']);
  });

  it('gives app1 public networking — the SSH deploy path needs it', () => {
    expect(publicNet('app1')).toMatchObject({ ipv4Enabled: true, ipv6Enabled: true });
  });

  it('denies db1 public networking — private network only', () => {
    expect(publicNet('db1')).toMatchObject({ ipv4Enabled: false, ipv6Enabled: false });
  });

  it('declares primary IPs for app1 alone', () => {
    const primaryIps = created
      .filter((r) => r.type === 'hcloud:index/primaryIp:PrimaryIp')
      .map((r) => r.name)
      .sort();
    expect(primaryIps).toEqual(['app1-ipv4', 'app1-ipv6']);
  });

  it('declares the firewall on each server at creation', () => {
    expect(byName('app1').inputs['firewallIds']).toHaveLength(1);
    expect(byName('db1').inputs['firewallIds']).toHaveLength(1);
  });
});
