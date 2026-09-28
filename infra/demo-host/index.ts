import { ESTATE_LOCATION } from '@branchleft/hetzner-host';
import * as hcloud from '@pulumi/hcloud';
import * as pulumi from '@pulumi/pulumi';

import { renderDemoHostCloudInit } from './cloudInit';
import { demoHostFirewallRules } from './firewall';
import { verifyDemosProject } from './projectGuard';

// Built from hcloud resources rather than `@branchleft/hetzner-host`'s
// `Host`, keeping its create-time decisions: README.md, "Why not Host".
const NAME = 'demo1';

/** Refuses the whole program unless `hcloud:token` addresses the demos
 * project. Every resource below awaits it, so nothing is planned past a
 * failure. */
export const demosProjectVerified = verifyDemosProject();

const config = new pulumi.Config();

/** edge1's address as applied, not configured; a change is picked up on this
 * stack's next apply (README.md). A DIY backend fixes the organisation
 * segment to the literal `organization`. */
const estateStack = new pulumi.StackReference('organization/branchleft-hetzner-estate/production');
const edge1PublicIpv4 = estateStack.requireOutput('edge1PublicIpv4').apply(String);

/** D46/D48: "cx23, Nuremberg across the board", the estate's own location
 * constant. Not colocation with edge1: demo1 shares no network with it. */
const location = demosProjectVerified.apply(() => ESTATE_LOCATION);

const labels = { role: 'demo', env: 'production', 'managed-by': 'pulumi' };

export const firewall = new hcloud.Firewall(`${NAME}-firewall`, {
  name: NAME,
  rules: pulumi
    .all([demosProjectVerified, edge1PublicIpv4])
    .apply(([, edge1]) => demoHostFirewallRules(edge1)),
  labels,
});

/** Declared rather than allocated with the server, which would release the
 * address with it: the demo domain's records and certificates name it. */
function primaryIp(type: 'ipv4' | 'ipv6'): hcloud.PrimaryIp {
  return new hcloud.PrimaryIp(`${NAME}-${type}`, {
    name: `${NAME}-${type}`,
    type,
    location,
    assigneeType: 'server',
    autoDelete: false,
    deleteProtection: true,
    labels,
  });
}

export const primaryIpv4 = primaryIp('ipv4');
export const primaryIpv6 = primaryIp('ipv6');

export const server = new hcloud.Server(
  NAME,
  {
    name: NAME,
    serverType: config.require('serverType'),
    location,
    image: config.require('image'),
    backups: false,
    sshKeys: config.requireObject<string[]>('ownerSshKeyNames'),
    userData: renderDemoHostCloudInit(NAME),
    // On the server, not a separate attachment: the only form the provider
    // treats as in effect from first boot. An attachment applied afterwards
    // leaves the new host on the internet unfiltered.
    firewallIds: [firewall.id.apply((id) => Number(id))],
    publicNets: [
      {
        ipv4Enabled: true,
        ipv4: primaryIpv4.id.apply((id) => Number(id)),
        ipv6Enabled: true,
        ipv6: primaryIpv6.id.apply((id) => Number(id)),
      },
    ],
    deleteProtection: true,
    rebuildProtection: true,
    labels,
  },
  {
    // Create-time-only fields the provider would otherwise plan a
    // replacement for; see `@branchleft/hetzner-host`'s `Host` for each.
    ignoreChanges: ['userData', 'image', 'sshKeys'],
  }
);

export const demo1PublicIpv4 = primaryIpv4.ipAddress;
export const demo1PublicIpv6 = primaryIpv6.ipAddress;
export const demo1Location = server.location;
