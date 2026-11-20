import type { DemoCeilings } from './demoCeilings.js';
import type { DrainTarget } from './descriptorTargets.js';
import { normalizeRecipient } from './descriptorTargets.js';
import type { DropDetail } from './droppedOutcomes.js';
import type { WireMessage } from './drainClient.js';
import { normalizeDomain } from './headerFromScope.js';

/**
 * The record of which addresses a demo slot may send to: LLD-6's "the
 * collector will not send to an address absent from our own verified-address
 * record". An interface, so a test can stand in for the record and the record's
 * real source can change without touching the check. `address` is whatever the
 * message names, unnormalised.
 */
export interface VerifiedRecipients {
  isVerified(target: DrainTarget, address: string): boolean;
}

/**
 * The record today: the one address the prospect claimed the slot with, read
 * from the slot's descriptor (`ownerEmail`): the owner's ruling is the
 * prospect's own claimed address only, so a member list imported into a demo
 * can send nothing. A slot whose descriptor carries none has no verified
 * recipient at all.
 */
export const descriptorOwnerRecipients: VerifiedRecipients = {
  isVerified(target, address) {
    const wanted = normalizeRecipient(address);
    return wanted !== null && target.ownerEmail !== undefined && wanted === target.ownerEmail;
  },
};

/**
 * Why a demo message was not sent. Labels only: no address, name or domain is
 * ever part of one. `identity-unknown`: the slot has no usable sender identity
 * yet, so the message waits (it is nothing the message did).
 */
export type DemoRefusalReason =
  'identity-unknown' | 'recipient-not-verified' | 'slot-ceiling' | 'estate-ceiling';

export type DemoVerdict =
  | {
      readonly ok: true;
      /** The slot's own address on the demo mail domain: the From the message is sent with. */
      readonly from: string;
    }
  | { readonly ok: false; readonly action: 'hold'; readonly reason: 'identity-unknown' }
  | {
      readonly ok: false;
      readonly action: 'refuse';
      readonly reason: Exclude<DemoRefusalReason, 'identity-unknown'>;
      /** What the spool is told, so the failure shows in Ghost instead of the message vanishing. */
      readonly detail: DropDetail;
    };

export interface DemoContainment {
  /**
   * Decides one drained demo message. Pure apart from taking a place under the
   * ceilings; safe to call again for the same message id (a re-offer).
   */
  admit(target: DrainTarget, message: Pick<WireMessage, 'id' | 'to'>): DemoVerdict;
}

export interface DemoContainmentOptions {
  recipients: VerifiedRecipients;
  ceilings: DemoCeilings;
}

const RECIPIENT_REFUSED: DropDetail = {
  severity: 'permanent',
  message: 'Demo mail goes only to the demo owner',
};
// Temporary, so the owner's own address is never suppressed for hitting a ceiling.
const CEILING_REACHED: DropDetail = {
  severity: 'temporary',
  message: 'Demo mail limit reached',
};

/**
 * What a drained demo message must satisfy before any target sees it, whatever
 * its Ghost asked for (the visitor is an administrator there):
 *
 * 1. the slot has a sender identity: its own local part, on the demo domain;
 * 2. the recipient is in the verified-address record;
 * 3. the slot is under its own ceiling and every demo slot together are under
 *    the estate ceiling.
 *
 * The From the message goes out with is the slot's own local part on the demo
 * domain. The order matters: a refused recipient never spends a place.
 * See ../README.md#demo-mail-containment.
 */
export function createDemoContainment(options: DemoContainmentOptions): DemoContainment {
  return {
    admit(target, message) {
      const domain =
        target.sendingDomain === undefined ? null : normalizeDomain(target.sendingDomain);
      if (target.senderLocalPart === undefined || domain === null) {
        return { ok: false, action: 'hold', reason: 'identity-unknown' };
      }
      if (!options.recipients.isVerified(target, message.to)) {
        return {
          ok: false,
          action: 'refuse',
          reason: 'recipient-not-verified',
          detail: RECIPIENT_REFUSED,
        };
      }
      const place = options.ceilings.reserve(target.id, message.id, target.mailCeiling);
      if (place !== 'ok') {
        return {
          ok: false,
          action: 'refuse',
          reason: place === 'slot' ? 'slot-ceiling' : 'estate-ceiling',
          detail: CEILING_REACHED,
        };
      }
      return { ok: true, from: `${target.senderLocalPart}@${domain}` };
    },
  };
}
