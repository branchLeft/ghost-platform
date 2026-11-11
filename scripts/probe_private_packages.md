# probe_private_packages.py

Fails if a package that must be private can be read without a credential.

Usage:

    probe_private_packages.py [--images PATH] [--list PATH]

The registry prefix comes from the mirror list (images.json "registry"). The
packages that must stay private, and the control package that must be served,
come from .github/image-mirror/private-packages.json.

For each package the probe asks the registry for an anonymous pull token (the
token request carries no credential and no Authorization header), then lists
the package's tags with that token. GHCR answers the token request by the
package's state, and the probe reads exactly that:

    200  a public package: the token is issued, the tags are then listed
    401  a package that exists and is not public: the only refusal that passes
    403  a package that does not exist: a wrong or empty namespace looks like this

A 403 or 404 is never a pass. A refusal from a namespace that holds nothing
proves nothing, so a missing package is a failure, the same as a package served.

Verdicts, fail-closed:

    private package served          -> FAIL
    private package refused (401)   -> pass
    private package missing         -> FAIL (403/404: wrong namespace, or never published)
    private package unknown answer  -> FAIL (a 5xx, a timeout, a bad token reply)
    control not served              -> FAIL, the probe itself is broken

The retired public namespace (<owner>/mirror/<name>, see scripts/mirror-images.md)
is probed and reported as an inventory. GitHub cannot make a public package
private again, so those stay public until the owner deletes them; served, now
private or gone is each reported and none fails the run.

Exit 0: every private package refused (401) and the control served.
Exit 1: a private package served, missing or unknown, or the control not served.
Exit 2: a list is unreadable or inconsistent with the mirror list.
