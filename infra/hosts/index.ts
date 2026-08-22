import { APP_HOST_IPS, HOST_IPS, Host } from '@branchleft/hetzner-host';
import * as pulumi from '@pulumi/pulumi';

import { assertColocatedWithEdge } from './locationCheck';
import { verifyEstateProject } from './projectGuard';

/**
 * Refuses the whole program if `hcloud:token` addresses the mail project.
 * See `projectGuard.ts` for why the check is one-directional.
 */
export const estateProjectVerified = verifyEstateProject();

const config = new pulumi.Config();

/**
 * Outputs of the two shared-infra stacks this one builds on. A DIY
 * (non-Pulumi-Cloud) backend fixes the organisation segment to the literal
 * `organization`.
 *
 * Read rather than configured: a hand-copied network id can be stale, and
 * `requireOutput` fails the preview if the source stack has not been applied
 * instead of planning an attachment to nothing.
 */
const networkStack = new pulumi.StackReference(
  'organization/branchleft-hetzner-network/production'
);
const networkId = networkStack.requireOutput('networkId').apply(String);

const estateStack = new pulumi.StackReference('organization/branchleft-hetzner-estate/production');

/**
 * Where these hosts are created: the location `edge1` was *applied* in, not
 * the constant that says where the estate is meant to be. `location` is
 * create-time-only and `app1`↔`db1` is the latency-sensitive pairing, so a
 * mismatch here must fail the preview rather than place the pair in a
 * different location from the edge for the rest of their lives. Both hosts'
 * `location` inputs await this check, so nothing is planned past a mismatch.
 */
const location = estateStack
  .requireOutput('estateLocation')
  .apply((applied) => assertColocatedWithEdge(String(applied)));

const image = config.require('image');

/** Names of keys already registered in the hcloud project, not key material.
 * `hcloud ssh-key list` is the only place the current names can be read. */
const ownerSshKeyNames = config.requireObject<string[]>('ownerSshKeyNames');

/**
 * The Ghost compute host. Public networking is deliberate, not the component
 * default left standing: the deploy path is SSH from GitHub-hosted runners,
 * which cannot reach a host with no public address, and first provisioning
 * needs the same door before the deploy account exists. The edge reaches
 * Ghost over the private network either way.
 */
export const app1 = new Host({
  name: 'app1',
  role: 'app',
  location,
  image,
  ownerSshKeyNames,
  networkId,
  serverType: config.require('app1ServerType'),
  privateIp: APP_HOST_IPS.app1,
  deployPublicKey: config.require('app1DeployPublicKey'),
  publicNetworking: true,
});

/**
 * The database host. No public networking, deliberately: nothing deploys to
 * it over the public internet, and every reachability need it has — MySQL
 * from the app hosts, provisioning over SSH — is served on the private
 * network, the latter through `edge1` as the jump host. Recovery when the
 * private path is down is the Hetzner console.
 */
export const db1 = new Host({
  name: 'db1',
  role: 'db',
  location,
  image,
  ownerSshKeyNames,
  networkId,
  serverType: config.require('db1ServerType'),
  privateIp: HOST_IPS.db1,
  deployPublicKey: config.require('db1DeployPublicKey'),
  publicNetworking: false,
});

export const app1PublicIpv4 = app1.publicIpv4;

/** Restated from the address plan as stack outputs so later stacks read them
 * from state rather than importing this program. */
export const app1PrivateIp = APP_HOST_IPS.app1;
export const db1PrivateIp = HOST_IPS.db1;

/** The applied fact, from the created server — see `estate.ts`'s
 * `estateLocation` in shared-infra for why the constant is not re-exported. */
export const hostsLocation = app1.server.location;
