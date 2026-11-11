# probe_private_packages.py

Fails if a mirror package that must be private can be read without a credential.
Reports the derived images as an inventory and never fails on them.

Usage:

    probe_private_packages.py [--images PATH] [--list PATH]

The registry prefix comes from the mirror list (images.json "registry"). The
packages that must stay private ("mirror"), the derived images that are
inventoried ("derived"), and the control package that must be served
("control") come from .github/image-mirror/private-packages.json.

For each package the probe asks the registry for an anonymous pull token (the
token request carries no credential and no Authorization header), then lists
the package's tags with that token. GHCR answers the token request by the
package's state, and the probe reads exactly that:

    200  a public package: the token is issued, the tags are then listed
    401  a package that exists and is not public: the only refusal that passes
    403  a package that does not exist: a wrong or empty namespace looks like this

A 403 or 404 is never a pass. A refusal from a namespace that holds nothing
proves nothing, so a missing package is a failure, the same as a package served.

Verdicts for the mirror packages, fail-closed:

    mirror package served           -> FAIL
    mirror package refused (401)    -> pass
    mirror package missing          -> FAIL (403/404: wrong namespace, or never published)
    mirror package unknown answer   -> FAIL (a 5xx, a timeout, a bad token reply)
    control not served              -> FAIL, the probe itself is broken

The derived images (<owner>/<name>: db-recovery, drain-sidecar, mail-collector,
mailgun-shim, demo-edge, portal-apps) are public today and most of their
consumers pull them anonymously. Making them private is a separate story. Each
is probed and printed as `DERIVED-INVENTORY <served|private|gone|unknown>`, with
a summary line, and none fails the run. An unknown answer is printed, never
dropped.

The retired public namespaces are probed and reported as an inventory, each row
printed `LEGACY-PUBLIC <served|refused|missing|unknown> <repo>`:

- `<owner>/mirror/<name>`, for every name in the mirror list;
- `<owner>/mirror-private/<name>`, for every name in the frozen "retired_private"
  list in private-packages.json. The mirror first wrote there and the packages
  were created public, not private as intended; the namespace was abandoned for
  `mirror-private2` rather than reused.

See scripts/mirror-images.md. GitHub cannot make a public package private again,
so those stay public until the owner deletes them; served, now private, gone or
unknown is each reported and none fails the run. The "retired_private" list may
be absent; when present it must be a non-empty list of package names with no
repeats. Its names may repeat the current mirror names, since the same images
were published under both namespaces.

Exit 0: every mirror package refused (401) and the control served, whatever the
derived inventory and the retired namespaces say.
Exit 1: a mirror package served, missing or unknown, or the control not served.
Exit 2: a list is unreadable or inconsistent with the mirror list, including an
unreadable or repeated derived or retired_private name.
