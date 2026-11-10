# Loading the PDQ vendor credential

## What it is

The contract for how the safety service that asks the hash-matching vendor
(Arachnid Shield, `POST /v1/pdq`) reads its credential. It is a design note,
not code. The service is not on `main`: it is built in a separate repo, and
`ProductionVerdictClient` (see `production-verdict-client.md`) owns no
credential by design. The credential belongs to the transport, and this note
is what that transport must do.

## Where the credential lives

- In exactly one place: a root-only file on the host the service runs on.
- Config names the file's path. Config never holds the value.
- Never an environment value, in a unit file, a compose file or a shell
  profile. Never a command-line argument.
- Never in a log line, an error message, a metric label, a rendered host
  artefact or a test fixture outside a temporary directory.

The config key is PROPOSED as `verdictCredentialFile` (absolute path). The
service's own change confirms the name.

## Load rules (fail closed)

1. No path in config: the PDQ channel has no source. The decorator refuses
   new uploads with `SCANNER_UNCONFIGURED`, as `verdict-source.md` already
   does. Nothing falls back to the in-process fake.
2. Path missing, not a regular file, or unreadable: the same refusal. The
   log line names the path and the error code, never the contents.
3. Any group or other permission bit set (mode & 0o077 is not zero) is
   refused, whatever the owner. The file is read at most once at start.
4. An empty file, or one holding only whitespace, is refused.
5. The value is held in the transport's memory and sent only as the
   authentication the vendor requires. It is trimmed of one trailing newline
   before use.
6. A refused credential is a boot-time error on the service's own log, with
   a stable token an alert can match. It is not retried in a loop.

## How it is proven

- Unit tests use a fake file in a temporary directory:
  - mode `0400` is accepted and the value reaches the transport;
  - mode `0644` is refused, with no value in any captured log;
  - a missing path, an empty file and a missing config key are each refused.
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
size. These are UNKNOWN until the vendor's documentation or the account
answers them. The credential's shape (one token, or a username and a
password pair) is UNKNOWN for the same reason. The loader must not assume
either form; it reads the file as the transport needs and the service's
change records the form it chose.

The `match_type` the vendor returns for the vendor's own test hash is also
UNKNOWN. It decides whether the `near` branch has a supplier-driven control,
so it is recorded from the vendor's answer and never inferred here.
