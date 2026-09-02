#!/usr/bin/env python3
"""Refuse a tenant `image_ref` that is not a digest-pinned image in this org's
GitHub Container Registry namespace.

The app host resolves this reference at deploy time, not the runner
(`infra/tenant/index.ts`'s `imageEnvPath`), so a reference the runner accepts
but the host cannot pull provisions an entire tenant before failing.

The value also reaches a systemd `EnvironmentFile` by way of
`pulumi config set imageRef`, so it is parsed as a whole-string grammar rather
than by prefix and suffix: anything permitted between them is injected into the
unit's environment, one `KEY=VALUE` per newline.
"""

import argparse
import re
import sys

# Trailing slash is load-bearing. `ghcr.io/branchleft` without it also matches
# `ghcr.io/branchleftevil/...`, an org an attacker can create.
ALLOWED_PREFIX = "ghcr.io/branchleft/"

# Docker's path-component grammar. Lowercase only, and a separator must sit
# between two alphanumeric runs -- so `..`, a leading `-` and an empty
# component are all unrepresentable, which is what keeps traversal and empty
# repository names out without a separate check for each.
_COMPONENT = r"[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*"

# One expression for the whole string. A prefix test plus a suffix test
# constrains neither what lies between them nor what the character class
# admits: `[^@]+` matches newlines, spaces and shell metacharacters, and this
# value reaches a systemd EnvironmentFile.
#
# `\Z`, never `$`: Python's `$` also matches immediately before a trailing
# newline, so `<valid ref>\n` satisfies a `$`-anchored pattern -- and a
# trailing newline is exactly what turns one EnvironmentFile line into two.
REF_RE = re.compile(
    r"\Aghcr\.io/branchleft/(?:%s/)*%s@sha256:[0-9a-f]{64}\Z"
    % (_COMPONENT, _COMPONENT))

# Matched only to tell "wrong registry" apart from "malformed", so the refusal
# can say which. Never used to accept anything.
_REGISTRY_RE = re.compile(r"\A(?P<name>[^@\s]+)@sha256:[0-9a-f]{64}\Z")


def check(image_ref):
    """None when `image_ref` is acceptable, else the reason it is not."""
    if not image_ref:
        return "image_ref is empty"
    if REF_RE.match(image_ref):
        return None

    # Everything below only chooses the wording.
    if image_ref != image_ref.strip() or any(
            c.isspace() for c in image_ref):
        return ("image_ref contains whitespace. It is written into a systemd "
                "EnvironmentFile, where a newline becomes another variable.")
    match = _REGISTRY_RE.match(image_ref)
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
    return ("image_ref is in %s but is not a valid image path: %r. Lowercase "
            "alphanumeric components separated by / . _ or -, and at least one "
            "component after the org." % (ALLOWED_PREFIX, name))


SELF_TEST_CASES = (
    ("ghcr.io/branchleft/ghost-tenant@sha256:" + "a" * 64, True),
    ("ghcr.io/branchleft/ghost/tenant@sha256:" + "a" * 64, True),
    # The shape this repo publishes today, which the digest-only check it
    # replaces accepted.
    ("europe-west1-docker.pkg.dev/branchleft-prod/ghost-platform-tenant/ghost"
     "@sha256:" + "b" * 64, False),
    ("docker.io/library/ghost@sha256:" + "c" * 64, False),
    # A namespace anyone can register; refused by the prefix's slash.
    ("ghcr.io/branchleftevil/ghost-tenant@sha256:" + "d" * 64, False),
    # A registry we do not control, wearing ours as a path.
    ("evil.example/ghcr.io/branchleft/ghost-tenant@sha256:" + "e" * 64, False),
    # Reaches a systemd EnvironmentFile: one newline is one extra variable.
    ("ghcr.io/branchleft/x\nEVIL=1@sha256:" + "a" * 64, False),
    ("ghcr.io/branchleft/x y@sha256:" + "a" * 64, False),
    ("ghcr.io/branchleft/x;rm -rf /@sha256:" + "a" * 64, False),
    ("ghcr.io/branchleft/../evil/x@sha256:" + "a" * 64, False),
    ("ghcr.io/branchleft/@sha256:" + "a" * 64, False),
    ("ghcr.io/branchleft/X-UPPER@sha256:" + "a" * 64, False),
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
