import * as pulumi from '@pulumi/pulumi';
import { beforeAll, describe, expect, it } from 'vitest';

// The program pointed at the wrong project: proves every resource waits on
// the guard, so a wrong token plans no Hetzner resource at all.

const created: string[] = [];
const rejections: string[] = [];

beforeAll(async () => {
  process.on('unhandledRejection', (reason) => {
    rejections.push(reason instanceof Error ? reason.message : String(reason));
  });
  pulumi.runtime.setMocks(
    {
      newResource(args: pulumi.runtime.MockResourceArgs) {
        created.push(args.type);
        if (args.type === 'pulumi:pulumi:StackReference') {
          return {
            id: args.name,
            state: { name: args.name, outputs: { edge1PublicIpv4: '95.217.1.1' } },
          };
        }
        return { id: `${created.length}`, state: args.inputs };
      },
      call(args: pulumi.runtime.MockCallArgs) {
        if (args.token === 'hcloud:index/getFirewalls:getFirewalls') {
          // The tenants project: empty, like demos before its first apply.
          return { firewalls: [{ name: 'project-marker-tenants' }] };
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
  const program = await import('./index.js');
  await new Promise<void>((resolve) => {
    program.demosProjectVerified.apply(() => resolve());
    setTimeout(resolve, 200);
  });
});

describe('the demo host program under the wrong token', () => {
  it('registers no Hetzner resource', () => {
    expect(created.filter((type) => type.startsWith('hcloud:'))).toEqual([]);
  });

  it('stops every one of them on the guard, not on something else', () => {
    expect(rejections.length).toBeGreaterThan(0);
    for (const message of rejections) {
      expect(message).toContain('hcloud:token addresses another project, not demos');
    }
  });
});
