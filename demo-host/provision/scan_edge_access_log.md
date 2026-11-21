# scan_edge_access_log.py

## What it does

Reads the demo edge's access log (Caddy's JSON format, one entry per line) and
goes red when a passphrase travelled in a URL. A passphrase in a URL lands in
browser history, screenshots, pasted chat messages and this log, whose retention
is a tool default. The gate takes a passphrase only in the login form's POST
body and the emailed link carries a single-use token, so a passphrase in a
logged URL means something put it there.

```
scan_edge_access_log.py LOG [--passphrase-file FILE]
```

| Exit | Meaning |
| ---- | ------- |
| 0 | The log was read, had entries, and none carries a passphrase. |
| 1 | `RED: line N: <reason>`, one per finding. |
| 2 | `UNREADABLE`: the file, a line or the passphrase file could not be read, or the log has no entries. |

## What counts as red

- A query parameter named like a passphrase (`passphrase`, `password`, `passwd`,
  `pwd`, `pass`), on any path, in the request URI or in a `Referer` header.
- With `--passphrase-file`, any known passphrase appearing in the URI or the
  `Referer`, matched without regard to case or to what separates the words
  (`%20`, `+`, `-`, `_`, `.`). A known passphrase shorter than 8 characters is
  refused, because it would match by accident.

A finding names its line and reason. It never prints the URL or the passphrase,
so running the scan does not copy a secret into a CI log.

## Fails closed

An empty log is exit 2, not a clean scan: if the edge logs nothing, "no
passphrase found" says nothing. So is a line that is not JSON or not an access
log entry. A scan that could not read the log must not read as a pass.

## What it does not cover

Without `--passphrase-file` it sees only a passphrase sent under a name a
passphrase would be given. A bare passphrase in a path or under another name is
found only when it is listed. The caller that holds the issued passphrases
passes them in; this script holds none.

It does not configure what the edge logs. A log that records no URI is exit 2
(not an access log entry), which is the signal that the logging is wrong.
