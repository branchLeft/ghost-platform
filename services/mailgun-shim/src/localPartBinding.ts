/**
 * The local part of an address, as the gate read it. Callers pass an address
 * that already has a domain, so the last `@` splits it.
 */
function localPartOf(address: string): string {
  return address.slice(0, address.lastIndexOf('@'));
}

/**
 * True when the credential is bound to a local part and the address names a
 * different one. Compared lower-cased, never as a prefix or suffix, so a slot
 * cannot send as another slot's address by differing in case or by extension.
 * `null` (an unbound credential) never differs. See
 * senderAuthorization.md#the-local-part-binding.
 */
export function localPartDiffers(address: string, boundLocalPart: string | null): boolean {
  return (
    boundLocalPart !== null && localPartOf(address).toLowerCase() !== boundLocalPart.toLowerCase()
  );
}
