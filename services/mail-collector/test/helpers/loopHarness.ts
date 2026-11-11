import type { DeliveryClient } from '../../src/deliveryClient.js';
import type { SweegoQuota } from '../../src/sendingTarget.js';
import type { Throttle } from '../../src/throttle.js';
import type { WireMessage } from '../../src/drainClient.js';
import type { QueuedMessage } from './fakeShimServer.js';

export const DRAIN_TOKEN = 'estate-drain-token';

/** Sweego allowance and account cap both free: the only quota in which Sweego may be chosen. */
export const QUOTA_FREE: SweegoQuota = {
  allowanceReached: () => false,
  accountCapReached: () => false,
};

export interface FakeClient extends DeliveryClient {
  readonly calls: string[];
  /** Returns an error to throw for this message, or undefined to accept it. */
  behaviour: (message: WireMessage) => Error | undefined;
}

export function fakeClient(): FakeClient {
  const client: FakeClient = {
    calls: [],
    behaviour: () => undefined,
    async deliver(message) {
      client.calls.push(message.id);
      const error = client.behaviour(message);
      if (error) {
        throw error;
      }
    },
    close() {},
  };
  return client;
}

/** A throttle that grants every token at once and counts how many it was asked for. */
export function countingThrottle(): Throttle & { readonly taken: number } {
  let taken = 0;
  return {
    tryTake: () => true,
    waitForToken: async () => {
      taken += 1;
    },
    reload() {},
    currentRate: () => 0,
    get taken(): number {
      return taken;
    },
  };
}

function message(id: string, emailId: string | null): QueuedMessage {
  return {
    id,
    domain: 'tenant.example',
    emailId,
    from: 'noreply@tenant.example',
    to: `reader-${id}@example.com`,
    subject: `Subject ${id}`,
    html: `<p>${id}</p>`,
    text: id,
    headers: {},
  };
}

export const LOGIN = (id: string): QueuedMessage => message(id, null);
export const NEWSLETTER = (id: string): QueuedMessage => message(id, `email-${id}`);

export async function until(
  condition: () => boolean,
  label: string,
  timeoutMs = 5000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for: ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** A short, fixed settle so a "nothing happens" assertion has had several poll cycles to be wrong in. */
export const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 250));
