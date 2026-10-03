# tokens

`verifyClaims` decides whether a token's claims belong to the application
presenting them, and names the tenant they bind it to. It reads claims only, so
the signature, key and algorithm must already have been checked: use
`createTokenVerifier` (`verifier.ts`), which does that and then calls this.

What a signature cannot say, and this adds:

- The token was issued to *this* application rather than its sibling. Zitadel
  lists every application of the project in `aud`, so the audience cannot tell
  them apart; the `client_id` claim does.
- The issuer is the sign-in service.
- The organisation the token carries is the only source of a tenant, and it must
  be one the application admits (`allowedOrgIds`): the owner's organisation for
  the console, the reconciled tenant organisations for the portal. A role alone
  never admits: an owner-organisation user who holds `tenant-admin` is refused by
  the portal.
- The role the application requires was granted to the user's own organisation.

Every missing, mistyped or unexpected claim is a refusal, and the function never
throws on hostile input.
