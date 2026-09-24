import type { TenantDescriptor } from '@branchleft/ghost-platform-render-core';

/**
 * The hostname the slots file (`slotsFile.ts`) keys its gate entries on --
 * the same value `validate()` already checked agrees with `gate` and with
 * the descriptor's zone. A demo descriptor's `hostname.kind` is always
 * `"ours"` in practice (the broker only ever reconciles demos, and a demo
 * has no verified custom domain to be `"theirs"`), but both branches are
 * handled rather than assumed, since `validate()` does not itself refuse a
 * `"theirs"` demo -- that would be a load-bearing rule this story is not
 * the place to add.
 */
export function hostOf(descriptor: TenantDescriptor, demoZone: string): string {
  return descriptor.hostname.kind === 'ours'
    ? `${descriptor.hostname.sub}.${demoZone}`
    : descriptor.hostname.fqdn;
}
