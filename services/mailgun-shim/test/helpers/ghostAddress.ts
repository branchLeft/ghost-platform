/**
 * Ghost's EmailAddressParser.stringify, copied byte for byte so the test
 * builds the wire value the way Ghost does.
 * See ghostAddress.md#ghoststringify.
 */
export function ghostStringify(name: string | undefined, address: string): string {
  if (!name) {
    return address;
  }
  const escapedName = name.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const nameCleanedForGmail = escapedName.replace(/[✅✓✔☑\u{1F5F8}]/gu, '').trim();
  return `"${nameCleanedForGmail}" <${address}>`;
}
