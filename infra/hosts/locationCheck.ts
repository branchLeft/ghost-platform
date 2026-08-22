import { ESTATE_LOCATION } from '@branchleft/hetzner-host';
import type { EstateLocation } from '@branchleft/hetzner-host';

/**
 * Returns the location this stack may create hosts in, or throws.
 *
 * The argument is the estate stack's `estateLocation` output — the location
 * `edge1` was applied in, read from the created server. Comparing against the
 * constant is not enough on its own: a stack that has already applied does
 * not follow a later edit to `ESTATE_LOCATION`, so the constant says where
 * the estate is meant to be while the output says where it is. `location` is
 * create-time-only on `hcloud.Server`, which makes a mismatch permanent for
 * every host created under it — hence throw, never warn.
 */
export function assertColocatedWithEdge(appliedEdgeLocation: string): EstateLocation {
  if (appliedEdgeLocation !== ESTATE_LOCATION) {
    throw new Error(
      `edge1 is applied in '${appliedEdgeLocation}' but this stack would create ` +
        `app1 and db1 in '${ESTATE_LOCATION}' (the address plan's ESTATE_LOCATION). ` +
        'These hosts must be colocated with the edge and with each other, and ' +
        'location cannot be changed after creation. Reconcile the address plan ' +
        'with the applied estate before any apply.'
    );
  }
  return ESTATE_LOCATION;
}
