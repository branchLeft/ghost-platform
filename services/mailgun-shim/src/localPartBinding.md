# localPartBinding.ts

## localPartDiffers

The one comparison behind a credential's From local part binding, kept in a
module of its own so a test can replace exactly this function and show the
refusal depends on it (`test/unit/bindingSabotage.test.ts`). The rule it
implements, and why, is senderAuthorization.md#the-local-part-binding.
