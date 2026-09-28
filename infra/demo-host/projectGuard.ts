import * as hcloud from '@pulumi/hcloud';
import * as pulumi from '@pulumi/pulumi';

/** Fails a preview unless `hcloud:token` addresses the demos project. Why
 * both halves are needed: README.md, "The project guard". The inventory is
 * duplicated from shared-infra's `hetzner/projects.ts` and must match it. */

const PROJECTS = {
  mail: ['mx1'],
  org: ['edge1', 'nextcloud1', 'ops1', 'app1', 'db1'],
  tenants: ['edge-t', 'app-t1', 'db-t1'],
  demos: ['demo1'],
  dns: [],
  backup: [],
  'demo-dns': [],
} as const satisfies Record<string, readonly string[]>;

type ProjectName = keyof typeof PROJECTS;

const EXPECTED: ProjectName = 'demos';

const marker = (project: ProjectName) => `project-marker-${project}`;

const FIX =
  "Set the demos project's Read & Write token with `pulumi config set --secret hcloud:token` and re-run";

/** The message names only the sentinels it matched, never the lists it was
 * given: a preview's output gets pasted into issues. */
export function assertDemosProject(
  serverNames: readonly string[],
  firewallNames: readonly string[]
): void {
  const servers = new Set(serverNames);
  const firewalls = new Set(firewallNames);
  const foreign: string[] = [];
  for (const [project, hosts] of Object.entries(PROJECTS) as [ProjectName, readonly string[]][]) {
    if (project === EXPECTED) {
      continue;
    }
    foreign.push(...hosts.filter((host) => servers.has(host)));
    if (firewalls.has(marker(project))) {
      foreign.push(marker(project));
    }
  }
  if (foreign.length > 0) {
    throw new Error(
      `hcloud:token addresses another project, not demos: it can see ${foreign.join(', ')}. ` +
        `Applying with it would create demo1 in the wrong project. ${FIX}.`
    );
  }
  if (!firewalls.has(marker(EXPECTED))) {
    throw new Error(
      `hcloud:token cannot see the firewall ${marker(EXPECTED)}, so nothing shows it addresses the demos project. ` +
        `Either the token belongs to another project or the marker was never created. ${FIX}.`
    );
  }
}

/** Split out so the shape-reading is tested: reading the wrong field is a
 * guard that passes everything. */
export function checkDemosProject(
  servers: { servers: { name: string }[] },
  firewalls: { firewalls: { name: string }[] }
): boolean {
  assertDemosProject(
    servers.servers.map((server) => server.name),
    firewalls.firewalls.map((firewall) => firewall.name)
  );
  return true;
}

/** Exported by the caller as a stack output so it is awaited by
 * construction; a constant `true`, so it never adds a diff. */
export function verifyDemosProject(): pulumi.Output<boolean> {
  return pulumi
    .all([pulumi.output(hcloud.getServers()), pulumi.output(hcloud.getFirewalls())])
    .apply(([servers, firewalls]) => checkDemosProject(servers, firewalls));
}
