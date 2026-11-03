# secrets-absent.test.ts

## What it proves

A tenant stack's state holds no secret value. The component takes no secret,
so the check plants the six former values where one could still arrive: in the
removed `secrets` argument, which must be refused without echoing them, and in
stack config under the names the old template read with `requireSecret`. It
then gathers everything the component hands to Pulumi, using
`test/leaks.ts`:

- every public field, with whether it is a Pulumi secret;
- every input the component registered;
- every entry it passed to `registerOutputs()`, captured at the call because
  that map is what stack state stores and the mocks never show it.

`findLeaks` reports any sentinel in any of them, any value Pulumi would store
as a secret, and any output key off the allowlist. The allowlist is the exact
key set, so a new output is a decision a reviewer sees in the diff.
`secretsEnvTemplate` is also asserted to hold only comments and empty `KEY=`
lines.

## Control cases

An empty list from `findLeaks` only means something if it can be non-empty.
`LeakingStandIn` is a real Pulumi component that leaks one way each: a secret
field, a plain field, a secret recorded in `registerOutputs()`, and an output
key off the list. It goes through the same gatherer and each must be reported.
A clean stand-in must report nothing, so the check is not simply always red.

The same sabotage was made by hand to `index.ts`: a `secretsEnvFile` output
built with `pulumi.secret()` from `requireSecret('databasePassword')` turned
the check red, naming the secret marker, the sentinel and the allowlist;
removing it turned it green.
