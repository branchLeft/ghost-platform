/**
 * The correlation value carried in a submitted message's Message-ID, so a
 * delivery status notification (DSN) that quotes the original headers names
 * exactly which drained message, at which claim generation, on which spool
 * it concerns. Stateless on purpose: a collector restart loses nothing,
 * because nothing about an in-flight message is held in memory.
 * See ../README.md#outcomes-carried-back-to-the-spool.
 */

const DOMAIN_SUFFIX = 'outcomes.invalid';

export interface OutcomeKey {
  targetId: string;
  id: string;
  drainCount: number;
}

function toHex(value: string): string {
  return Buffer.from(value, 'utf8').toString('hex');
}

function fromHex(hex: string): string | null {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/.test(hex)) {
    return null;
  }
  return Buffer.from(hex, 'hex').toString('utf8');
}

/** `<{id}.{drainCount}@{hex(targetId)}.outcomes.invalid>`. `.invalid` is reserved (RFC 6761): it can never collide with a routable domain. */
export function encodeOutcomeMessageId(key: OutcomeKey): string {
  return `<${key.id}.${key.drainCount}@${toHex(key.targetId)}.${DOMAIN_SUFFIX}>`;
}

const MESSAGE_ID = new RegExp(`^<([A-Za-z0-9-]+)\\.([1-9][0-9]*)@([0-9a-f]+)\\.${DOMAIN_SUFFIX}>$`);

/** Null for any Message-ID this collector did not mint. */
export function decodeOutcomeMessageId(messageId: string): OutcomeKey | null {
  const match = MESSAGE_ID.exec(messageId.trim());
  if (!match) {
    return null;
  }
  const targetId = fromHex(match[3]!);
  if (targetId === null) {
    return null;
  }
  return { id: match[1]!, drainCount: Number(match[2]), targetId };
}
