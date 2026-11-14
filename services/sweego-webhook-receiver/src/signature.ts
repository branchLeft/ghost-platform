import { createHmac, timingSafeEqual } from 'node:crypto';

const MAX_SIGNATURE_HEADER_CHARS = 1024;
const MAX_SIGNATURE_CANDIDATES = 8;
const SHA256_BYTES = 32;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** The dashboard secret is base64; anything else is a deployment error. */
export function decodeSecret(text: string): Buffer {
  const trimmed = text.trim();
  if (!BASE64.test(trimmed) || trimmed.length % 4 !== 0) {
    throw new Error('webhook secret is not valid base64');
  }
  const decoded = Buffer.from(trimmed, 'base64');
  if (decoded.length < 16) {
    throw new Error('webhook secret decodes to fewer than 16 bytes');
  }
  return decoded;
}

/**
 * Candidate signatures from the header: space-separated tokens, each either
 * bare base64 or `v1,<base64>`. A token naming another version is ignored.
 * Whether Sweego sends the prefix or several tokens is unproven; both are
 * accepted so neither can lock out a genuine delivery.
 */
export function signatureCandidates(header: string): Buffer[] {
  if (header.length > MAX_SIGNATURE_HEADER_CHARS) {
    return [];
  }
  const out: Buffer[] = [];
  for (const token of header.split(/\s+/).filter((t) => t.length > 0)) {
    if (out.length >= MAX_SIGNATURE_CANDIDATES) {
      break;
    }
    let value = token;
    const comma = token.indexOf(',');
    if (comma !== -1) {
      if (token.slice(0, comma) !== 'v1') {
        continue;
      }
      value = token.slice(comma + 1);
    }
    if (!BASE64.test(value) || value.length % 4 !== 0) {
      continue;
    }
    out.push(Buffer.from(value, 'base64'));
  }
  return out;
}

export interface VerifyInput {
  secrets: readonly Buffer[];
  webhookId: string;
  webhookTimestamp: string;
  rawBody: Buffer;
  signatureHeader: string;
}

/**
 * HMAC-SHA256 over `{id}.{timestamp}.{raw body}`, computed on the bytes as
 * received, before any parse. Every secret is tried against every candidate
 * with no early exit, and a candidate of the wrong length is skipped before
 * timingSafeEqual (which throws on unequal lengths).
 */
export function verifySignature(input: VerifyInput): boolean {
  const candidates = signatureCandidates(input.signatureHeader);
  if (candidates.length === 0) {
    return false;
  }
  const prefix = Buffer.from(`${input.webhookId}.${input.webhookTimestamp}.`, 'utf8');
  const signed = Buffer.concat([prefix, input.rawBody]);
  let matched = false;
  for (const secret of input.secrets) {
    const expected = createHmac('sha256', secret).update(signed).digest();
    for (const candidate of candidates) {
      if (candidate.length === SHA256_BYTES && timingSafeEqual(candidate, expected)) {
        matched = true;
      }
    }
  }
  return matched;
}

/** Seconds-since-epoch string accepted within `futureSeconds` ahead and `pastSeconds` behind. */
export function timestampInWindow(
  timestamp: string,
  nowMs: number,
  futureSeconds: number,
  pastSeconds: number
): boolean {
  if (!/^[0-9]{1,12}$/.test(timestamp)) {
    return false;
  }
  const age = Math.floor(nowMs / 1000) - Number(timestamp);
  return age >= -futureSeconds && age <= pastSeconds;
}
