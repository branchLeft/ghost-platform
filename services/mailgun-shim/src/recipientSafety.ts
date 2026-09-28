// Group syntax (':' ';') and list separators (',') let an address resolve
// to a different recipient, so any address containing them is refused.
// See recipientSafety.md#unsafe-recipient-characters.
const UNSAFE_RECIPIENT_CHARS = /[\r\n\t,;:<>"]/;

export function isSafeRecipientAddress(address: string): boolean {
  if (!address || UNSAFE_RECIPIENT_CHARS.test(address)) {
    return false;
  }
  const at = address.indexOf('@');
  return at > 0 && at === address.lastIndexOf('@') && at < address.length - 1;
}
