# export-reimport.image.test.mjs

## Why this test exists

An export is verified by using it. This takes Ghost's own exports from a
seeded Ghost, puts them into a different, fresh Ghost, and looks for named
items there: two posts (one published, one draft, with body and tag), two
tags, two members (with note and label) and the site title and description.

Assertions name items because an empty Ghost answers 200 to everything and
already holds a default post and tag; a status code or a count cannot tell
a restored site from a fresh one.

## What it proves

- **Control**: the same verifier against a fresh Ghost that imported
  nothing fails on every named item. The test also asserts that Ghost's
  home page answers 200 there, so the reason for naming items stays visible.
- **Survival**: after the re-import every named item is present and intact.
- **Sabotage**: an export with one post removed is caught, and the failure
  names that post and no other.

## What each part exports

| Part | Export | Re-import |
|---|---|---|
| content | `GET /ghost/api/admin/db/` (posts, tags, settings) | `POST /ghost/api/admin/db/` |
| members | `GET /ghost/api/admin/members/upload/` (CSV) | `POST /ghost/api/admin/members/upload/` |

Ghost's JSON export carries no members, so they travel by Ghost's own members
CSV. The parts are listed in `export-parts.mjs`; a new kind of export (media,
comments, members from the bundler's archive) is one more entry there, with
its own named items and its own export and import functions.

## Usage

```sh
nvm use
IMAGE=ghost-platform:ci node --test test/image/*.test.mjs
```

`export-parts.unit.test.mjs` tests the verifier's own logic without Docker.
Every container is labelled `branchleft.agent=export-reimport-image-test` and
removed with its anonymous volumes, one Ghost at a time.
