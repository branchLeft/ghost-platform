/**
 * The correlation value carried in a submitted message's Message-ID, so a
 * delivery status notification (DSN) that quotes the original headers names
 * exactly which drained message, at which claim generation, on which spool
 * it concerns. Stateless on purpose: a collector restart loses nothing,
 * because nothing about an in-flight message is held in memory.
 * See ../README.md#outcomes-carried-back-to-the-spool.
 *
 * A minted id also carries a MAC over the message, its generation, its spool
 * and its recipient, so a bounce is acted on only when it quotes an id this
 * collector signed for that recipient: anyone can mail the return path, but
 * only the holder of the key can produce an id that verifies.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

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

const MAC_HEX_LENGTH = 32;
/** The shortest key the collector accepts: a guessable key is no key. */
export const MIN_MAC_KEY_LENGTH = 32;

const MESSAGE_ID = new RegExp(
  `^<([A-Za-z0-9-]+)\\.([1-9][0-9]*)(?:\\.([0-9a-f]{${MAC_HEX_LENGTH}}))?@([0-9a-f]+)\\.${DOMAIN_SUFFIX}>$`
);

function parse(messageId: string): (OutcomeKey & { mac: string | null }) | null {
  const match = MESSAGE_ID.exec(messageId.trim());
  if (!match) {
    return null;
  }
  const targetId = fromHex(match[4]!);
  if (targetId === null) {
    return null;
  }
  return { id: match[1]!, drainCount: Number(match[2]), targetId, mac: match[3] ?? null };
}

/**
 * Null for any Message-ID this collector did not mint. Reads the shape only:
 * it does not check the MAC, so it proves nothing about who sent a message
 * that quotes the id. A bounce goes through `verifyOutcomeMessageId`.
 */
export function decodeOutcomeMessageId(messageId: string): OutcomeKey | null {
  const parsed = parse(messageId);
  return parsed
    ? { id: parsed.id, drainCount: parsed.drainCount, targetId: parsed.targetId }
    : null;
}

/** Lower-cased and trimmed: the one form a recipient is signed and checked in. */
export const normaliseRecipient = (address: string): string => address.trim().toLowerCase();

function macFor(key: OutcomeKey, recipient: string, macKey: string): string {
  if (macKey.length < MIN_MAC_KEY_LENGTH) {
    throw new TypeError(`the Message-ID key must be at least ${MIN_MAC_KEY_LENGTH} characters`);
  }
  // NUL cannot appear in any field, so the fields cannot run into one another.
  const input = [
    'outcome-id-v1',
    key.id,
    String(key.drainCount),
    key.targetId,
    normaliseRecipient(recipient),
  ].join('\0');
  return createHmac('sha256', macKey).update(input).digest('hex').slice(0, MAC_HEX_LENGTH);
}

/** `<{id}.{drainCount}.{mac}@{hex(targetId)}.outcomes.invalid>`: as `encodeOutcomeMessageId`, plus a MAC bound to `recipient`. */
export function signOutcomeMessageId(key: OutcomeKey, recipient: string, macKey: string): string {
  return `<${key.id}.${key.drainCount}.${macFor(key, recipient, macKey)}@${toHex(key.targetId)}.${DOMAIN_SUFFIX}>`;
}

/**
 * The key this id names, but only if it carries a MAC that verifies for one of
 * `recipients`. Null for an unsigned id, a truncated or altered MAC, an id
 * signed for a different recipient or with a different key, or no recipient.
 */
export function verifyOutcomeMessageId(
  messageId: string,
  recipients: readonly string[],
  macKey: string
): OutcomeKey | null {
  const parsed = parse(messageId);
  if (!parsed || parsed.mac === null) {
    return null;
  }
  const key: OutcomeKey = {
    id: parsed.id,
    drainCount: parsed.drainCount,
    targetId: parsed.targetId,
  };
  const given = Buffer.from(parsed.mac, 'hex');
  for (const recipient of recipients) {
    const expected = Buffer.from(macFor(key, recipient, macKey), 'hex');
    if (given.length === expected.length && timingSafeEqual(given, expected)) {
      return key;
    }
  }
  return null;
}
