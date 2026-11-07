# assert-register-holds-no-customer-names.js

## Module overview

This repository is public, and so are the two packages published from it. A
customer tenant's name must not reach either: customer names live in the
control plane's database. This script is the one home of that rule.

It checks, under a root (default: this repository):

1. `registers/tenant-names.json`. Every entry must be `infrastructure`, or the
   `tenant` entry for tenant zero (`blog`, `branchLeft/ghost-tenant-blog`). Any
   other kind or tenant entry, a missing register, or one that is not valid JSON
   is a finding.
2. The sources of `render-core` and `infra/tenant`, which are what the publish
   workflows build and pack. Any register-shaped entry (an object holding a
   string `name` and `kind: 'tenant'`) other than tenant zero is a finding, and so
   is any `ghost-tenant-<slug>` reference other than tenant zero's.

Skipped: `node_modules`, `dist`, any `test` directory and any `*.test.*` file.
Those are not published. A `ghost-tenant-<name>` placeholder in a doc does not
match, because `<` is not a slug character.

Usage: `node scripts/assert-register-holds-no-customer-names.js [ROOT]`. Exit 0
clean, 1 a finding, 2 a usage error. A finding names the file and never quotes the
name.

## Why the checks are the allowlist, not a name list

The guard cannot hold a list of customer names, because that would be the leak. It
refuses everything except what is known to be public.

The proof is `register-no-customer-names.test.js`: an ALL_CAPS placeholder placed
in the register, in each generated package copy and in another package source
file makes it exit non-zero. The same placements pass a copy of the guard with its
two allowlist checks removed.

## Not covered

A tarball inspection step in the publish workflows. This runs on every pull
request, before a publish.
