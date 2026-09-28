import { ESTATE_LOCATION } from '@branchleft/hetzner-host';
import type { EstateLocation } from '@branchleft/hetzner-host';

/**
 * Returns the location this stack may create hosts in, or throws.
 * `location` is create-time-only on `hcloud.Server`, so a mismatch is
 * permanent for every host created under it. See locationCheck.md#assertcolocatedwithedge.
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
