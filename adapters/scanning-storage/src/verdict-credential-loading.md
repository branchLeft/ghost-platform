# Loading the PDQ vendor credential (a username and password pair)

## What it is

The contract for how the safety service that asks the hash-matching vendor
(Arachnid Shield, `POST /v1/pdq`) reads its credential. It is a design note,
not code. The service is not on `main`: it is built in a separate repo, and
`ProductionVerdictClient` (see `production-verdict-client.md`) owns no
credential by design. The credential belongs to the transport, and this note
is what that transport must do.

## Where the credential lives

- In exactly one place: on the host the service runs on, in two files, one
  holding the username and one holding the password, each readable by its
  owner alone. The two are one credential with one custody entry.
- Config names the two files' paths. Config never holds a value.
- Never an environment value, in a unit file, a compose file or a shell
  profile. Never a command-line argument.
- Never in a log line, an error message, a metric label, a rendered host
  artefact or a test fixture outside a temporary directory.

The service's own configuration names them `arachnid.usernameFile` and
`arachnid.passwordFile` (absolute paths, two different files). That service is
built in a separate repo and owns the names; this note follows it.

## Load rules (fail closed)

1. Either path missing from config, or both naming the same file: the PDQ
   channel has no source. The decorator refuses
   new uploads with `SCANNER_UNCONFIGURED`, as `verdict-source.md` already
   does. Nothing falls back to the in-process fake.
2. Either path missing, not a regular file, or unreadable: the same refusal. The
   log line names the path and the error code, never the contents.
3. Any group or other permission bit set (mode & 0o077 is not zero) on either
   file is refused, whatever the owner. Each file is read at most once at
   start.
4. An empty file, or one holding only whitespace, is refused, as is a username
   that holds a colon and a control character in either half.
5. The pair is held in the transport's memory and sent only as the
   authentication the vendor requires: HTTP Basic, the header value `Basic `
   followed by the base64 of `username:password`. The two halves are not
   trimmed alike. The username is trimmed of all its surrounding whitespace.
   The password has only one trailing line ending stripped (`\n` or `\r\n`);
   a leading or trailing space in it is part of the password and is sent as
   written.
6. A refused credential is a boot-time error on the service's own log, with
   a stable token an alert can match. It is not retried in a loop.

## How it is proven

- Unit tests use a fake file in a temporary directory:
  - mode `0400` on both files is accepted and the pair reaches the transport
    as the Basic header value;
  - mode `0644` on either file is refused, with neither half in any captured
    log;
  - a missing path, an empty file, a missing config key and one file named for
    both halves are each refused.
- Sabotage: relax rule 3 (drop the group and other bit check). The
  world-readable case must go red; restore the check and it must go green.
  Record both in the PR that lands the service.

## What the vendor says, and what it does not

From the vendor's published OpenAPI document (`/v1/pdq`, base URL
`https://shield.projectarachnid.com`, retrieved 2026-11-09):

- Request: `{"hashes": [<base64 PDQ hash>, ...]}`.
- Answer: `scanned_hashes`, each with a `classification`
  (`csam`, `harmful-abusive-material`, `test`, `no-known-match`) and a
  `match_type` (`exact`, `near`, or null).

The document names no authentication scheme, no rate limit and no batch
size. The rate limit and batch size are UNKNOWN until the vendor's
documentation or the account answers them.

The authentication scheme is not unknown. The live endpoint, called with no
credential and an empty hash list on 2026-11-10, answered `401` with
`www-authenticate: Basic` and the text "please supply your API username and
password in the Authorization header", on both `/v1/pdq` and `/v1/pdq/`. The
vendor's own client library takes a username and a password and builds the
header as `Basic ` plus the base64 of `username:password`. The credential is
therefore a pair, never one token, and no part of it is sent anywhere but in
that header.

The `match_type` the vendor returns for the vendor's own test hash is also
UNKNOWN. It decides whether the `near` branch has a supplier-driven control,
so it is recorded from the vendor's answer and never inferred here.
