# ownerDueDiligence.ts

## OWNER_DUE_DILIGENCE_EMAIL

The platform owner's address, set once for the estate, used to add the owner
to every demo as a reader and to send the owner each demo's passphrase. It is
read here and nowhere else.

An unset, blank or invalid value is `OwnerDueDiligenceUnsetError`, never a
default and never a skip: the Ghost admin plugin reads it when it loads, so
the broker does not start without it and no demo is created. The error never
echoes the value. A quote or backslash is refused because the address is
later placed inside a quoted filter.

## assertOwnerDueDiligenceEmail

The same check for a value passed in as an option (the admin client, the owner
copy), so a caller that bypasses the environment still cannot bypass the rule.
