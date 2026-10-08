/**
 * Reads an RFC 3464 delivery status notification into the one fact the
 * spool needs: what the receiving MTA finally did with one message.
 * Hand-rolled over the `message/delivery-status` part because the only
 * fields used are five well-defined header lines; a DSN that does not
 * carry them is "no outcome", never a guess.
 * See ../README.md#outcomes-carried-back-to-the-spool.
 */

export interface ParsedDsn {
  /** The Message-ID of the original message, from the returned headers. */
  originalMessageId: string;
  action: string;
  status: string;
  diagnostic: string | null;
}

export interface MtaOutcome {
  outcome: 'delivered' | 'failed';
  severity?: 'permanent' | 'temporary';
  code?: number;
  message?: string;
}

function unfold(block: string): Map<string, string> {
  const fields = new Map<string, string>();
  let current: string | null = null;
  for (const line of block.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && current !== null) {
      fields.set(current, `${fields.get(current) ?? ''} ${line.trim()}`);
      continue;
    }
    const colon = line.indexOf(':');
    if (colon > 0) {
      current = line.slice(0, colon).trim().toLowerCase();
      fields.set(current, line.slice(colon + 1).trim());
    }
  }
  return fields;
}

export function parseDsn(raw: string): ParsedDsn | null {
  const header =
    /^content-type:\s*message\/delivery-status[^\r\n]*\r?\n(?:[ \t][^\r\n]*\r?\n)*\r?\n/im.exec(
      raw
    );
  if (!header) {
    return null;
  }
  const afterHeader = raw.slice(header.index + header[0].length);
  const boundary = /^--/m.exec(afterHeader);
  const statusPart = boundary ? afterHeader.slice(0, boundary.index) : afterHeader;
  const rest = boundary ? afterHeader.slice(boundary.index) : '';

  // First group is per-message, the rest per-recipient. Ours are always
  // single-recipient submissions, so the first group naming an Action wins.
  let action: string | undefined;
  let status: string | undefined;
  let diagnostic: string | null = null;
  for (const group of statusPart.split(/\r?\n\r?\n/)) {
    const fields = unfold(group);
    const a = fields.get('action');
    if (a !== undefined) {
      action = a.toLowerCase().split(/\s/)[0];
      status = fields.get('status');
      diagnostic = fields.get('diagnostic-code') ?? null;
      break;
    }
  }
  if (action === undefined || status === undefined) {
    return null;
  }

  const idMatch = /^message-id:\s*(<[^>\r\n]+>)/im.exec(rest);
  if (!idMatch) {
    return null;
  }
  return { originalMessageId: idMatch[1]!, action, status, diagnostic };
}

/**
 * What a DSN means for the spool. `relayed` and `expanded` hand the message
 * to a system that will not report back: they are NOT delivery and yield
 * no outcome. 'delivered' needs a 2.x.x status and a permanent failure a
 * 5.x.x one, so a malformed report can neither mark a message delivered nor
 * suppress an address.
 */
export function toOutcome(dsn: ParsedDsn): MtaOutcome | null {
  const smtpCode = dsn.diagnostic ? /\b([2-5][0-9]{2})\b/.exec(dsn.diagnostic)?.[1] : undefined;
  const message = (dsn.diagnostic ?? dsn.status).slice(0, 500);
  const code = smtpCode ? Number(smtpCode) : undefined;
  const base = { ...(code !== undefined ? { code } : {}), message };

  if (dsn.action === 'delivered') {
    return /^2\./.test(dsn.status) ? { outcome: 'delivered' } : null;
  }
  if (dsn.action === 'failed') {
    // Permanent only on an explicit 5.x.x: a malformed status must never be
    // able to suppress an address. 4.x.x is a failure that may still resolve.
    if (/^5\./.test(dsn.status)) {
      return { outcome: 'failed', severity: 'permanent', ...base };
    }
    return /^4\./.test(dsn.status) ? { outcome: 'failed', severity: 'temporary', ...base } : null;
  }
  if (dsn.action === 'delayed') {
    return { outcome: 'failed', severity: 'temporary', ...base };
  }
  return null;
}
