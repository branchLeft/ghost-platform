import {
  Host,
  EDGE_RULES,
  INTERNAL_RULES,
  HOST_IPS,
  ESTATE_LOCATION,
} from '@branchleft/hetzner-host';
import type { HostArgs } from '@branchleft/hetzner-host';
import * as pulumi from '@pulumi/pulumi';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Proves `@branchleft/hetzner-host` is genuinely installable and usable from
 * `ghost-platform` -- a repo with no `shared-infra`-scoped grant of its own
 * -- resolving the published `dist/` over the registry rather than a `file:`
 * link. No Pulumi program or stack lives alongside this test: the Hetzner
 * host stack that calls `Host` for real is a separate, not-yet-started
 * story, tracked on the board rather than invented speculatively here.
 */

type Created = { type: string; name: string };

const created: Created[] = [];

beforeAll(() => {
  pulumi.runtime.setMocks(
    {
      newResource(args: pulumi.runtime.MockResourceArgs) {
        created.push({ type: args.type, name: args.name });
        return { id: `${args.name}-id`, state: { ...args.inputs, ipAddress: '203.0.113.10' } };
      },
      call() {
        return {};
      },
    },
    'ghost-platform-hetzner-host-check',
    'test',
    false
  );
});

describe('the published @branchleft/hetzner-host package, installed via npm', () => {
  it('constructs a Host against the real exported address plan and rule sets', async () => {
    const args: HostArgs = {
      name: 'installcheck1',
      role: 'app',
      serverType: 'cx23',
      location: ESTATE_LOCATION,
      image: 'debian-13',
      ownerSshKeyNames: ['owner'],
      networkId: '4242',
      privateIp: HOST_IPS.mon1,
      deployPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEXAMPLE deploy@test',
    };
    const host = new Host(args);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(created.some((r) => r.type === 'hcloud:index/server:Server')).toBe(true);
    expect(created.some((r) => r.type === 'hcloud:index/firewall:Firewall')).toBe(true);
    expect(created.some((r) => r.type === 'hcloud:index/serverNetwork:ServerNetwork')).toBe(true);

    // `role: 'app'` must select INTERNAL_RULES, not EDGE_RULES -- confirms
    // the exported rule sets actually differ, not just that both resolve.
    expect(INTERNAL_RULES.length).toBeLessThan(EDGE_RULES.length);

    const ip = await new Promise((resolve) => host.publicIpv4?.apply(resolve));
    expect(ip).toBe('203.0.113.10');
  });
});
