// Historically guarded nodemailer's `to` field, back when this service
// dialled a delivery host directly (deleted with worker.ts/smtp.ts — the
// spool never dials out now, LLD-6). Kept as a claim-time gate in store.ts
// regardless: whatever composes the outbound envelope on the other side of
// the drain connection is handed a recipient string it will interpolate
// into its own message construction, and the same class of address-list
// injection this closed for nodemailer is a reasonable floor to still hand
// downstream rather than assume the drainer re-derives it.
//
// A colon or semicolon opens RFC 2822 group syntax and a comma separates
// addresses, so any of those characters let an address differ from the one
// this service intended — e.g. "grp:attacker@evil.com;" resolves under
// nodemailer's own parser to the envelope recipient "attacker@evil.com"
// (verified via nodemailer's streamTransport, prior to this service
// removing nodemailer as a dependency). A plain email address never
// contains them, so reject anything that does rather than let the address
// grammar reinterpret it.
const UNSAFE_RECIPIENT_CHARS = /[\r\n\t,;:<>"]/;

export function isSafeRecipientAddress(address: string): boolean {
  if (!address || UNSAFE_RECIPIENT_CHARS.test(address)) {
    return false;
  }
  const at = address.indexOf('@');
  return at > 0 && at === address.lastIndexOf('@') && at < address.length - 1;
}
