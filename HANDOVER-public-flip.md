# Handover — the public flip

Everything below is platform-owner-only: merges, a force-push, repo settings,
and production IAM. Nothing here has been run.

Prepared alongside PRs #19–#23 (this repo), branchLeft/website#53 and
branchLeft/shared-infra#11. Delete this file once the flip is done.

---

## 1. Merge, in this order

| # | PR | Why here |
|---|---|---|
| 1 | ghost-platform **#19** | Removes the last tenant name from the tree. Also renames the type-check jobs, and a check context must report on `main` once before a ruleset can require it — so the earlier this lands, the better. |
| 2 | ghost-platform **#17** | The provisioning identity. Rewrites `infra-platform-ci.yml` and `apis.ts`; #19's two replacement lines are copied from it verbatim, so its hunks should apply as no-ops. |
| 3 | ghost-platform-tenant-template **#6** | Different repo, unaffected by the squash. Any time. |
| 4 | ghost-platform **#20**, **#21**, **#22** | Deletions, identifier scrub, README rewrite. Mutually disjoint. |
| 5 | ghost-platform **#23** | **Last.** Its formatting pass reindents `workloadIdentity.ts`, which #21 also edits. Rebase after #21 lands. |
| 6 | website **#53**, shared-infra **#11** | Independent repos, any time. #53 removes a personal email from an already-public repo — no reason to wait. |

`Analyze (javascript-typescript)` fails on #23 and will keep failing until the
flip: code scanning needs Advanced Security on private repos and is free on
public ones. The workflow is correct — it only fails on upload.

---

## 2. Prune, then squash

```bash
cd ghost-platform
git fetch origin --prune
git branch -r --merged origin/main | grep -v 'origin/main$' | sed 's|origin/||' \
  | xargs -n1 git push origin --delete          # read the list first
```

Then squash. **Before the flip, not after** — a force-push to a public repo
does not unpublish anything: GitHub keeps orphaned commits reachable by SHA
until GC, and once anyone forks, they persist in the fork network for good.

```bash
git checkout main && git pull
git checkout --orphan squashed
git add -A
git commit -m "Initial commit"     # write a real message
git branch -M squashed main
git push --force origin main
git tag -f v0.1.0 && git tag -f v0.1.1 && git push --force --tags origin
```

What this disposes of, and the only way to dispose of it: commit `0b19f8a`
quotes the real tenant name **in its own message** while claiming to remove
it, and roughly eight other messages carry `branchleft-prod`, `website/infra`,
`ghost-platform-docs` or a private cross-repo reference.

It does **not** fix `@branchleft/ghost-platform-tenant@0.1.1`, which already
shipped that name inside `dist/index.d.ts`. Only the `0.2.0` republish does
(step 6).

---

## 3. Audit before flipping

```bash
git grep -inE 'salamander|greenwich' -- ':!graphify-out'
git grep -nE 'branchleft-prod|branchleft-pulumi-state|gcpkms://|@branchleft-prod\.iam' \
  -- ':!graphify-out' ':!infra/platform/RUNBOOK-bootstrap.md'
git check-ignore -v infra/platform/cloud-sql-proxy    # must match
trufflehog git file://.                               # over the squashed history
```

`RUNBOOK-bootstrap.md` is excluded deliberately — it is the live bootstrap
procedure you are about to run, and it leaves the repo in step 7.

**Then skim the accumulated Actions logs.** Flipping makes every past run's
logs and job summaries world-readable retroactively. `infra-platform-ci.yml`'s
deploy job writes the full `pulumi preview --json` plan into
`$GITHUB_STEP_SUMMARY` on every push to `main`. Its own comment argues that is
safe — URNs, step ops, non-secret config — and the reasoning holds, but it was
written for a private repo. Check the real summaries rather than the intent,
and delete any run you are unsure about. The force-push may moot most of this;
verify rather than assume.

---

## 4. Flip

```bash
gh api -X PATCH repos/branchLeft/ghost-platform -f visibility=public
```

---

## 5. Bootstrap the provisioning identity

Follow `infra/platform/RUNBOOK-bootstrap.md` in its own order:

**P0b → V → V2 → P1 → P3–P7 → P2 → P8**

Three things worth restating because getting them wrong is expensive:

- **P0b** creates the environment and the required reviewer in one call. The
  nested array will not survive `gh api -f`/`-F` — use `--input`.
- **V** verifies the gate actually blocks *before* anything is granted. This is
  the entire reason the repo is public: environment required-reviewer
  protection does not enforce on private repos on the Free plan. **If V does
  not block, stop** — the premise has failed and nothing after it is safe.
- **V2** prints the real OIDC claim. P2's federation condition is written from
  that output, not from documentation.

---

## 6. Post-flip checklist

**Ruleset.** The public-repo ruleset blocks the graphify bot's direct push to
`main` — known from the org rollout. Resolve that first (bypass actor, or
PR-based commit-back), then:

```bash
cd github-workflows
./org-policy/apply.sh ghost-platform     # audit first; it only POSTs and will duplicate
```

Required contexts once each has reported green on `main`: `docker build`,
`Platform type check`, `Tenant type check`, `docs-lint`, and
`Analyze (javascript-typescript)`. Note `ghost-platform-main.json` currently
requires only `docker build`; the two type-check contexts are newly
unambiguous as of #19, which is what makes adding them possible.

**Secret scanning + push protection.** Free on public, and the real ongoing
mitigation for the class of miss #19 caught by hand.

**Actions → fork PRs.** Set "Require approval for all external contributors"
(public defaults to first-time contributors only). Uncheck "Allow GitHub
Actions to create and approve pull requests".

**Package visibility.** `@branchleft/ghost-platform-tenant` was published from
a private repo, and GitHub Packages visibility does **not** follow the repo.
Decide public vs PAT-gated — the `0.2.0` republish is the natural moment.

**Guard the graphify caller.** Add `if: github.repository ==
'branchLeft/ghost-platform'`. It holds `contents: write` and commits
`graphify-out/` back to the branch, which misbehaves on forks.
(`branchLeft/github-workflows` is public, so the reusable call itself is fine.)

**Org-level.** Add `ghost-platform` to `branchLeft/.github`'s `SECURITY.md`
supported list — it names only `components` and `website` today. Fix the stale
`ghost-platform-tenants-main.json` ruleset name while there.

**Confirm** the three `vars.GCP_*` and the `platform` environment survived the
visibility change.

---

## 7. Then

- Move `RUNBOOK-bootstrap.md` to `ghost-platform-docs/` and rewrite its four
  inbound references (`README.md`, `infra/README.md`, two comment sites in
  `infra-platform-ci.yml`) to state the fact each needs rather than link.
- Publish `0.2.0`: `exports` field, `@pulumi/pulumi` and `@pulumi/gcp` moved to
  `peerDependencies`, and a clean `dist/index.d.ts`. Delete the `0.1.1`
  version afterwards. The component has one consumer (the template, which
  pins), so the peer-dependency migration costs nothing today and more later.
- Extract `infra/tenant/naming.ts` and add Vitest. The highest-value test is
  the storage prefix's trailing slash — `blog` must not match `blog-archive/`
  — which is a live cross-tenant isolation property currently guarded only by
  a comment.

## Not flip-blocking, unowned

`shared-infra` has no CI apply path. Its `CLAUDE.md` claimed CI owned
`pulumi up` while its README said CI never applies; shared-infra#11 corrects
the docs and states the gap, but building the apply job — a deployer SA, a new
WIF pool, and a delete guard covering the forwarding rules, certificate map
and Cloud Armor policy — is real work and needs an owner. The edge is the
highest-blast-radius estate in the workspace.
