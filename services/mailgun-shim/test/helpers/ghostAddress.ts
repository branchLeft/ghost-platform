/**
 * Ghost's own `EmailAddressParser.stringify` (email-address-parser.js,
 * forks/Ghost tag v6.55.0), copied rather than imported — this service has
 * no dependency on Ghost's codebase, and the whole point of a live-shape
 * test is to build the wire value the same way Ghost really does, not to
 * hand-type a guess at it. Kept byte-for-byte
 * identical to the source: escape `\` then `"`, strip the same five
 * checkmark characters Ghost strips as problematic for Gmail delivery,
 * then wrap in double quotes. A name is ALWAYS quoted when present —
 * Ghost never emits `Name <addr>` bare.
 */
export function ghostStringify(name: string | undefined, address: string): string {
  if (!name) {
    return address;
  }
  const escapedName = name.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const nameCleanedForGmail = escapedName.replace(/[✅✓✔☑\u{1F5F8}]/gu, '').trim();
  return `"${nameCleanedForGmail}" <${address}>`;
}
