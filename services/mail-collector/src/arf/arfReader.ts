/**
 * Reads one RFC 5965 abuse report (ARF) into the one fact the spool needs: a
 * recipient complained about a message this collector submitted. Pure: no
 * clock, no I/O, no logging. Hand-rolled over the three-part report, with
 * hard limits, because a report that cannot be read exactly is "no
 * complaint", never a guess. Every doubt returns a named rejection.
 * See ./README.md for the fail-closed rules and what is still unproven.
 */
import { decodeOutcomeMessageId } from '../outcomeId.js';
import {
  MAX_HEADERS,
  normaliseAuthservId,
  parseHeaders,
  splitBlock,
  trustedAuthResults,
  values,
  type Headers,
} from '../mailHeaders.js';

export interface ArfSource {
  /** Short lower-case name carried into the record, e.g. the provider's programme. */
  name: string;
  /** Organisational domains whose DKIM pass proves a report came from that source. */
  dkimDomains: readonly string[];
}

export interface ArfReaderOptions {
  /** The authserv-id our own receiving MTA writes in its Authentication-Results header. */
  trustedAuthservId: string;
  sources: readonly ArfSource[];
}

/** What the spool needs to suppress: which message, which spool, who, from where, when. */
export interface ComplaintRecord {
  /** Lower-cased, checked against the original message's own To header. */
  recipient: string;
  /** The spool the message was drained from: the tenant or demo stream. */
  targetId: string;
  /** The drained message and its claim generation, from our own Message-ID. */
  id: string;
  drainCount: number;
  /** The configured source name the report authenticated as. */
  source: string;
  /** When we received the report: the caller's clock, never the sender's. */
  timestampMs: number;
  /** The report's Arrival-Date when it is a sane date, else null. Informational only. */
  arrivalDateMs: number | null;
}

export type ArfRejection =
  | 'not_arf' // not a feedback report at all: the caller may treat it as something else
  | 'oversized'
  | 'malformed'
  | 'unauthenticated'
  | 'feedback_type_not_abuse'
  | 'no_message_id'
  | 'not_ours'
  | 'no_recipient'
  | 'recipient_mismatch';

export type ArfResult = { ok: true; record: ComplaintRecord } | { ok: false; reason: ArfRejection };

export type ArfReader = (raw: string, receivedAtMs: number) => ArfResult;

export const ARF_LIMITS = {
  maxRawBytes: 256 * 1024,
  maxParts: 6,
  maxHeaders: MAX_HEADERS,
  maxFeedbackBytes: 16 * 1024,
  maxAddressLength: 254,
} as const;

const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const ADDRESS =
  /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const BOUNDARY = /^[0-9A-Za-z'()+_,\-./:=? ]{1,70}$/;
const REPORT_TYPE = /report-type\s*=\s*"?feedback-report/i;
const GATE_BYTES = 16 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

const fail = (reason: ArfRejection): ArfResult => ({ ok: false, reason });

interface ContentType {
  type: string;
  params: Map<string, string>;
}

function parseContentType(value: string): ContentType | null {
  const pieces: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < value.length; i += 1) {
    const c = value[i]!;
    if (quoted && c === '\\') {
      current += value[i + 1] ?? '';
      i += 1;
    } else if (c === '"') {
      quoted = !quoted;
      current += c;
    } else if (c === ';' && !quoted) {
      pieces.push(current);
      current = '';
    } else {
      current += c;
    }
  }
  if (quoted) {
    return null;
  }
  pieces.push(current);
  const type = pieces[0]!.trim().toLowerCase();
  if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(type)) {
    return null;
  }
  const params = new Map<string, string>();
  for (const piece of pieces.slice(1)) {
    const eq = piece.indexOf('=');
    if (eq < 0) {
      if (piece.trim() === '') {
        continue;
      }
      return null;
    }
    const key = piece.slice(0, eq).trim().toLowerCase();
    let val = piece.slice(eq + 1).trim();
    if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) {
      val = val.slice(1, -1);
    }
    if (params.has(key)) {
      return null;
    }
    params.set(key, val);
  }
  return { type, params };
}

/** Parts of a multipart body. Null if the closing delimiter is missing or there are too many parts. */
function splitMultipart(body: string, boundary: string): string[] | null {
  const open = `--${boundary}`;
  const close = `--${boundary}--`;
  const parts: string[][] = [];
  let current: string[] | null = null;
  for (const line of body.split('\n')) {
    const trimmed = line.trimEnd();
    if (trimmed === close) {
      if (current === null) {
        return null;
      }
      parts.push(current);
      return parts.map((p) => p.join('\n'));
    }
    if (trimmed === open) {
      if (current) {
        parts.push(current);
      }
      if (parts.length >= ARF_LIMITS.maxParts) {
        return null;
      }
      current = [];
    } else if (current) {
      current.push(line);
    }
  }
  return null;
}

interface Part {
  type: string;
  headers: Headers;
  body: string;
}

function readPart(text: string): Part | null {
  const { head, body } = splitBlock(text);
  const headers = parseHeaders(head);
  if (!headers) {
    return null;
  }
  const types = values(headers, 'content-type');
  if (types.length > 1) {
    return null;
  }
  const ct = types.length === 1 ? parseContentType(types[0]!) : { type: 'text/plain' };
  if (!ct) {
    return null;
  }
  // Only identity encodings are read; an encoded part would parse as noise.
  const encodings = values(headers, 'content-transfer-encoding');
  if (
    encodings.length > 1 ||
    (encodings.length === 1 && !/^(7bit|8bit|binary)$/i.test(encodings[0]!))
  ) {
    return null;
  }
  return { type: ct.type, headers, body };
}

/** One plain address from a header value, or null for a list, a group, a comment, or a quoted local part. */
function singleAddress(value: string): string | null {
  let skeleton = '';
  let quoted = false;
  for (let i = 0; i < value.length; i += 1) {
    const c = value[i]!;
    if (quoted) {
      if (c === '\\') {
        i += 1;
      } else if (c === '"') {
        quoted = false;
      }
      continue;
    }
    if (c === '"') {
      quoted = true;
      skeleton += 'Q';
      continue;
    }
    skeleton += c;
  }
  if (quoted || /[,;()]/.test(skeleton)) {
    return null;
  }
  let candidate = skeleton.trim();
  if (/[<>]/.test(candidate)) {
    const angle = /^[^<>]*<([^<>]*)>$/.exec(candidate);
    if (!angle) {
      return null;
    }
    candidate = angle[1]!.trim();
  }
  if (candidate.length > ARF_LIMITS.maxAddressLength || !ADDRESS.test(candidate)) {
    return null;
  }
  return candidate.toLowerCase();
}

const domainOf = (address: string): string => address.slice(address.lastIndexOf('@') + 1);

/** DKIM-passing signing domains named by the one Authentication-Results header our MTA wrote. Null if there is not exactly one. */
function trustedDkimPasses(headers: Headers, trustedId: string): string[] | null {
  const clauses = trustedAuthResults(headers, trustedId);
  if (clauses === null) {
    return null;
  }
  const domains: string[] = [];
  for (const piece of clauses) {
    const tokens = piece.trim().split(/\s+/);
    if (tokens[0]!.toLowerCase() !== 'dkim=pass') {
      continue;
    }
    for (const token of tokens.slice(1)) {
      const d = /^header\.d=("?)([A-Za-z0-9.-]+)\1$/i.exec(token);
      if (d) {
        domains.push(d[2]!.toLowerCase());
      }
    }
  }
  return domains;
}

const within = (domain: string, root: string): boolean =>
  domain === root || domain.endsWith(`.${root}`);

function authenticate(top: Headers, opts: ArfReaderOptions): string | null {
  const from = values(top, 'from');
  if (from.length !== 1) {
    return null;
  }
  const fromAddress = singleAddress(from[0]!);
  const passes = trustedDkimPasses(top, opts.trustedAuthservId);
  if (!fromAddress || !passes) {
    return null;
  }
  const fromDomain = domainOf(fromAddress);
  for (const source of opts.sources) {
    for (const d of passes) {
      // The signing domain must be the source's own and must align with the visible From.
      if (source.dkimDomains.some((root) => within(d, root)) && within(fromDomain, d)) {
        return source.name;
      }
    }
  }
  return null;
}

function arrivalMs(value: string | undefined, receivedAtMs: number): number | null {
  if (value === undefined || !/^[A-Za-z0-9 ,:+()-]{10,64}$/.test(value)) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms <= receivedAtMs + DAY_MS && ms >= receivedAtMs - 400 * DAY_MS
    ? ms
    : null;
}

export function createArfReader(options: ArfReaderOptions): ArfReader {
  const trustedAuthservId = normaliseAuthservId(options.trustedAuthservId);
  if (options.sources.length === 0) {
    throw new TypeError('at least one ARF source is required');
  }
  const sources = options.sources.map((s) => {
    const domains = s.dkimDomains.map((d) => d.toLowerCase());
    if (
      !/^[a-z0-9-]{1,32}$/.test(s.name) ||
      domains.length === 0 ||
      !domains.every((d) => DOMAIN.test(d))
    ) {
      throw new TypeError('each ARF source needs a short name and valid dkim domains');
    }
    return { name: s.name, dkimDomains: domains };
  });
  const opts: ArfReaderOptions = { trustedAuthservId, sources };

  return (raw, receivedAtMs) => {
    // A cheap gate on the head of the message: anything that does not say it is
    // a feedback report is not ours to judge, so a DSN never becomes "malformed".
    if (!Number.isFinite(receivedAtMs) || !REPORT_TYPE.test(raw.slice(0, GATE_BYTES))) {
      return fail('not_arf');
    }
    if (raw.length > ARF_LIMITS.maxRawBytes || Buffer.byteLength(raw) > ARF_LIMITS.maxRawBytes) {
      return fail('oversized');
    }
    if (raw.includes('\0') || /\r(?!\n)/.test(raw)) {
      return fail('malformed');
    }
    const text = raw.replace(/\r\n/g, '\n');

    const { head, body } = splitBlock(text);
    const top = parseHeaders(head);
    if (!top) {
      return fail('malformed');
    }
    const types = values(top, 'content-type');
    if (types.length === 0) {
      return fail('not_arf');
    }
    if (types.length > 1) {
      return fail('malformed');
    }
    const ct = parseContentType(types[0]!);
    if (!ct) {
      return fail('malformed');
    }
    if (
      ct.type !== 'multipart/report' ||
      ct.params.get('report-type')?.toLowerCase() !== 'feedback-report'
    ) {
      return fail('not_arf');
    }
    const boundary = ct.params.get('boundary');
    if (boundary === undefined || !BOUNDARY.test(boundary) || boundary.endsWith(' ')) {
      return fail('malformed');
    }
    const rawParts = splitMultipart(body, boundary);
    if (!rawParts) {
      return fail('malformed');
    }
    const parts: Part[] = [];
    for (const rawPart of rawParts) {
      const part = readPart(rawPart);
      if (!part) {
        return fail('malformed');
      }
      parts.push(part);
    }
    const reports = parts.filter((p) => p.type === 'message/feedback-report');
    const originals = parts.filter(
      (p) => p.type === 'message/rfc822' || p.type === 'text/rfc822-headers'
    );
    if (reports.length !== 1 || originals.length !== 1) {
      return fail('malformed');
    }

    const source = authenticate(top, opts);
    if (source === null) {
      return fail('unauthenticated');
    }

    // The report part: one field group, every field the record uses exactly once.
    const reportPart = reports[0]!;
    if (reportPart.body.length > ARF_LIMITS.maxFeedbackBytes) {
      return fail('malformed');
    }
    const group = splitBlock(reportPart.body);
    if (group.body.trim() !== '') {
      return fail('malformed');
    }
    const fields = parseHeaders(group.head.replace(/^\n+/, ''));
    if (!fields) {
      return fail('malformed');
    }
    const once = (name: string): string | undefined | null => {
      const found = values(fields, name);
      return found.length > 1 ? null : found[0];
    };
    const version = once('version');
    const feedbackType = once('feedback-type');
    const userAgent = once('user-agent');
    const orcpt = once('original-rcpt-to');
    const arrival = once('arrival-date');
    if (version !== '1' || !feedbackType || !userAgent || orcpt === null || arrival === null) {
      return fail('malformed');
    }
    if (feedbackType.toLowerCase() !== 'abuse') {
      return fail('feedback_type_not_abuse');
    }

    // The quoted original: only its header block is read, never its body.
    const quoted = splitBlock(originals[0]!.body);
    const originalHeaders = parseHeaders(quoted.head.replace(/^\n+/, ''));
    if (!originalHeaders) {
      return fail('malformed');
    }
    const ids = values(originalHeaders, 'message-id');
    if (ids.length === 0) {
      return fail('no_message_id');
    }
    if (ids.length > 1) {
      return fail('malformed');
    }
    const key = decodeOutcomeMessageId(ids[0]!);
    if (!key) {
      return fail('not_ours');
    }

    const tos = values(originalHeaders, 'to');
    if (tos.length > 1) {
      return fail('malformed');
    }
    const claimed = orcpt === undefined ? null : singleAddress(orcpt);
    if (orcpt !== undefined && claimed === null) {
      return fail('malformed');
    }
    const quotedTo = tos.length === 1 ? singleAddress(tos[0]!) : null;
    if (tos.length === 1 && quotedTo === null) {
      return fail('recipient_mismatch');
    }
    if (claimed !== null && quotedTo !== null && claimed !== quotedTo) {
      return fail('recipient_mismatch');
    }
    const recipient = claimed ?? quotedTo;
    if (recipient === null) {
      return fail('no_recipient');
    }

    return {
      ok: true,
      record: {
        recipient,
        targetId: key.targetId,
        id: key.id,
        drainCount: key.drainCount,
        source,
        timestampMs: receivedAtMs,
        arrivalDateMs: arrivalMs(arrival, receivedAtMs),
      },
    };
  };
}
