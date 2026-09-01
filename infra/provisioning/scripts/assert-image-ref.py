#!/usr/bin/env python3
"""Refuse a tenant `image_ref` that is not a digest-pinned image in this org's
GitHub Container Registry namespace.

The digest pin was already checked inline in `provision-tenant.yml`; the
registry was not, so any registry satisfied it. That is not cosmetic: the
tenant component supplies the reference to the app host at deploy time
(`infra/tenant/index.ts`'s `imageEnvPath`), so the *host* resolves it. An
Artifact Registry reference therefore passes validation, provisions a whole
tenant, and fails on `app1` at pull time — or, worse, succeeds because someone
gave a Hetzner host GCP pull credentials, which is the dependency doc 14 exists
to remove.

Same reasoning as the existing `HETZNER_PULUMI_BACKEND_URL` check next to it,
which refuses a `gs://` backend for the same reason rather than accepting any
well-formed URL.

Extracted rather than written inline for the reason the scoping guard was: a
rule living in workflow YAML is only provable by dispatching the workflow for
real, which for this one means provisioning a tenant.
"""

import argparse
import re
import sys

# Trailing slash is load-bearing. `ghcr.io/branchleft` without it also matches
# `ghcr.io/branchleftevil/...`, an org an attacker can create, and the whole
# point of this check is that the namespace is ours.
ALLOWED_PREFIX = "ghcr.io/branchleft/"

# Anchored at both ends. Unanchored, `evil.example/ghcr.io/branchleft/x` would
# satisfy a substring test while naming a registry we do not control.
DIGEST_RE = re.compile(r"^(?P<name>[^@]+)@sha256:[0-9a-f]{64}$")


def check(image_ref):
    """None when `image_ref` is acceptable, else the reason it is not."""
    if not image_ref:
        return "image_ref is empty"
    if image_ref != image_ref.strip():
        return "image_ref has leading or trailing whitespace"
    match = DIGEST_RE.match(image_ref)
    if not match:
        return ("image_ref must be digest-pinned and end in "
                "@sha256:<64 lowercase hex>. A tag is a mutable pointer, so a "
                "stack deployed by tag has no answer to 'what is running'.")
    name = match.group("name")
    if not name.startswith(ALLOWED_PREFIX):
        detail = ""
        if "docker.pkg.dev" in name:
            detail = (" That is GCP Artifact Registry: the app host would need "
                      "GCP pull credentials, which is the dependency the "
                      "Hetzner migration exists to remove.")
        return ("image_ref must be an image in %s, not %r.%s"
                % (ALLOWED_PREFIX, name, detail))
    return None


SELF_TEST_CASES = (
    ("ghcr.io/branchleft/ghost-tenant@sha256:" + "a" * 64, True),
    # The exact shape that reached this repo's own runbook and passed the
    # digest-only check it replaces.
    ("europe-west1-docker.pkg.dev/branchleft-prod/ghost-platform-tenant/ghost"
     "@sha256:" + "b" * 64, False),
    ("docker.io/library/ghost@sha256:" + "c" * 64, False),
    # A namespace an attacker can register; refused by the prefix's slash.
    ("ghcr.io/branchleftevil/ghost-tenant@sha256:" + "d" * 64, False),
    # A registry we do not control, wearing ours as a path.
    ("evil.example/ghcr.io/branchleft/ghost-tenant@sha256:" + "e" * 64, False),
    ("ghcr.io/branchleft/ghost-tenant:latest", False),
    ("ghcr.io/branchleft/ghost-tenant@sha256:" + "A" * 64, False),
    ("ghcr.io/branchleft/ghost-tenant@sha256:" + "a" * 63, False),
    ("", False),
)


def self_test():
    for image_ref, should_pass in SELF_TEST_CASES:
        reason = check(image_ref)
        if should_pass and reason is not None:
            print("self-test FAILED: %r was refused: %s" % (image_ref, reason),
                  file=sys.stderr)
            return 1
        if not should_pass and reason is None:
            print("self-test FAILED: %r was accepted" % (image_ref,),
                  file=sys.stderr)
            return 1
    print("assert-image-ref self-test: %d cases OK" % len(SELF_TEST_CASES))
    return 0


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image-ref")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args(argv[1:])

    if args.self_test:
        return self_test()
    if args.image_ref is None:
        parser.error("one of --image-ref or --self-test is required")

    reason = check(args.image_ref)
    if reason is not None:
        print("::error::%s" % reason)
        return 1
    print("image_ref accepted: %s" % args.image_ref)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
