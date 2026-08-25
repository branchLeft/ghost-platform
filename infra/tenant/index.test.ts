import * as pulumi from '@pulumi/pulumi';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Runs `GhostTenant` under Pulumi's mocks and inspects what it actually
 * registers as its own component props. `scripts/assert-no-tenant-deletes.py`
 * reads a tenant's identity out of exactly this -- a `ComponentResource`
 * whose registered props never change emits no step in a real preview, so an
 * empty-props regression here is invisible to every other test in this
 * package, which all exercise pure string derivations with no Pulumi engine.
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
        return { id: `${args.name}-id`, state: { ...args.inputs } };
      },
      call() {
        return {};
      },
    },
    'ghost-tenant-blog',
    'blog',
    false
  );

  const { GhostTenant } = await import('./index.js');
  new GhostTenant('blog', {
    slug: 'blog',
    siteUrl: 'https://blog.example.invalid',
    uid: 30001,
    appHostPrivateIp: '10.20.1.100',
    hostPort: 20001,
    database: { host: '10.20.1.20', password: pulumi.secret('unused-in-this-test') },
    media: {
      endpoint: 'https://hel1.your-objectstorage.com',
      region: 'hel1',
      accessKeyId: 'unused-in-this-test',
      secretAccessKey: pulumi.secret('unused-in-this-test'),
    },
  });
  // Let module-scope resolution settle before any assertion reads `created`.
  await new Promise((resolve) => setTimeout(resolve, 0));
});

const component = () => {
  const found = created.find((r) => r.type === 'ghostPlatform:tenant:GhostTenant');
  if (found === undefined) {
    throw new Error('no ghostPlatform:tenant:GhostTenant resource was registered');
  }
  return found;
};

describe('GhostTenant', () => {
  it('registers its identity fields as real component props, not empty inputs', () => {
    // The regression this guards against: `super(token, name, {}, opts)`
    // would leave `inputs` empty here, and every field below undefined.
    expect(component().inputs.identity).toEqual({
      slug: 'blog',
      uid: 30001,
      stackName: 'blog',
      contentVolume: 'ghost-blog-content',
      adaptersVolume: 'ghost-blog-adapters',
      databaseName: 'ghost_blog',
      appHostPrivateIp: '10.20.1.100',
      maxUserConnections: 10,
    });
  });
});
