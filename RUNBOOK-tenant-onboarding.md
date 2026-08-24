# Runbook — onboarding and tearing down a tenant

The whole sequence for putting one Ghost tenant on a shared Hetzner app host,
and for taking it off again. `provision-tenant.yml` does the part an unattended
run correctly can; everything else here is operator-run, and each of those steps
is operator-run for a stated reason rather than because nobody automated it yet.

**Provisioning is closed until this runbook has been proven end to end on a real
host.** `provision-tenant.yml` refuses at step one unless the
`TENANT_PROVISIONING_FLOW_HETZNERISED` repository variable on
`branchLeft/ghost-platform` is `true`. Setting it is the last step of the
migration, not the first.

## Addresses this runbook uses

| Name | Address | Reached from |
|---|---|---|
| `db1` | `10.20.1.20` | the private network only |
| `app1`, private | `10.20.1.100` | the private network; this is what a tenant's published port binds |
| `app1`, public | `pulumi stack output app1PublicIpv4 --stack production` from `infra/hosts` | the internet; this is what CI deploys to |
| `edge1` | `46.225.95.167` | the internet |

The two `app1` addresses are the pair most easily conflated, and conflating them
fails in opposite directions: a stack that binds the public one publishes a
tenant's Ghost to the internet without the edge in front of it, and a CI job
pointed at the private one hangs.

---

## Before the first tenant, once

**The escrow keypair.** `provision-tenant.yml` mints each tenant's stack
passphrase and refuses to continue if it cannot encrypt a recoverable copy. The
public half is committed at
`infra/provisioning/escrow/tenant-passphrase-escrow.pub.pem`; the private half
goes to the password manager and the off-site archive. Generation and recovery
are in `infra/provisioning/escrow/README.md`. **Do this before any tenant
exists** — a lost escrow private key makes every ciphertext the flow ever
publishes useless at once, and the flow would still report success on every run.

**The provisioning credentials, environment-scoped.** Every
provisioning-capable secret on `branchLeft/ghost-platform` must sit on the
`tenant-provisioning` environment, not at the repository level, behind that
environment's required-reviewer rule. This is the replacement for the
Workload Identity provider condition the rewrite deletes: that one was enforced
by Google regardless of any GitHub setting, and there is no like-for-like
substitute. The workflow verifies both the rule and the scoping before it
creates anything, and refuses if it cannot read either.

```bash
gh secret set GH_PAT_TENANT_PROVISIONING    --repo branchLeft/ghost-platform --env tenant-provisioning
gh secret set HETZNER_S3_ACCESS_KEY_ID      --repo branchLeft/ghost-platform --env tenant-provisioning
gh secret set HETZNER_S3_SECRET_ACCESS_KEY  --repo branchLeft/ghost-platform --env tenant-provisioning
gh secret delete GH_PAT_TENANT_PROVISIONING   --repo branchLeft/ghost-platform
gh secret delete HETZNER_S3_ACCESS_KEY_ID     --repo branchLeft/ghost-platform
gh secret delete HETZNER_S3_SECRET_ACCESS_KEY --repo branchLeft/ghost-platform
```

The deletes matter as much as the sets: `secrets.X` falls back to a
repository-level secret of the same name, so a copy left behind keeps the
workflow working while remaining readable by every other run in the repository,
including one from a branch. Nothing else reports that.

**The platform-wide repository variables** the flow reads. These are facts about
the estate rather than per-tenant answers, which is why they are variables and
not ten more fields on a dispatch form — `workflow_dispatch` also caps inputs at
ten.

```bash
gh variable set PLATFORM_DB_PRIVATE_IP         --repo branchLeft/ghost-platform --body '10.20.1.20'
gh variable set PLATFORM_MEDIA_ENDPOINT        --repo branchLeft/ghost-platform --body '<https://<region>.your-objectstorage.com>'
gh variable set PLATFORM_MEDIA_REGION          --repo branchLeft/ghost-platform --body '<region>'
gh variable set PLATFORM_MEDIA_BUCKET          --repo branchLeft/ghost-platform --body '<media bucket>'
gh variable set PLATFORM_MEDIA_PUBLIC_BASE_URL --repo branchLeft/ghost-platform --body '<https://... >'
gh variable set HETZNER_PULUMI_BACKEND_URL     --repo branchLeft/ghost-platform --body 's3://<tenant-state-bucket>?endpoint=<region>.your-objectstorage.com&s3ForcePathStyle=true&region=<region>'
```

The media values are the ones the media-isolation decision is still open on, so
they are placeholders here rather than invented: the endpoint host and the
region must name the same location, and a mismatch is an opaque 403 that reads
as a credential problem. `HETZNER_PULUMI_BACKEND_URL` must **not** be
`branchleft-pulumi-state` — that bucket holds the estate's own checkpoint, and
the S3 credential is not scoped per stack, so pointing tenants at it would give
every tenant deployer write access to the checkpoint the production hcloud token
lives in. The workflow refuses that bucket by name.

---

## Onboarding, in order

The order is not arbitrary. Two steps have to precede the deploy slot, and one
of them changes whether a safety check fires at all — see step 6.

### 1. Ask the tenant whether their repository is public

Public is the platform default. Whether it is public is a disclosure about that
tenant — the repository, and its name, say that they are a customer — so it is
their answer to give, before anything is created. The dispatch form opens on an
option that is not a valid answer, so it cannot be left unanswered.

### 2. Allocate the UID on the app host

```bash
ssh -i ~/.ssh/id_ed25519_hetzner root@<app1-public-ipv4> \
  '/root/platform-provision/provision_tenant_volume.py --list-claims'
```

One `<slug>=<uid>` line per tenant already on that host. Pick the next free
number in `30000`–`30999`. It is host state: nothing in a config file can answer
this for a host several tenant repositories deploy to, and the script refuses a
UID another tenant holds — but only once you are already on the host, by which
point the repository would exist.

Pick the host port the same way, distinct per tenant on that host.

### 3. Dispatch the provisioning workflow

```bash
gh workflow run "Provision tenant" --repo branchLeft/ghost-platform \
  -f tenant_visibility=public \
  -f tenant_name=<slug> \
  -f tenant_repo=ghost-tenant-<slug> \
  -f site_url=https://<hostname> \
  -f tenant_uid=<uid from step 2> \
  -f host_port=<port from step 2> \
  -f app_host_private_ip=10.20.1.100 \
  -f app_host_ssh_address=<app1-public-ipv4> \
  -f image_ref=ghcr.io/branchleft/<image>@sha256:<digest>
```

It pauses on the `tenant-provisioning` environment's required reviewer. Approve
it, then read the job summary: it carries the escrowed passphrase ciphertext.

**Decrypt and file that ciphertext now**, per
`infra/provisioning/escrow/README.md`. The run's summary and its artifact both
expire; the password manager is the escrow of record, and step 5 needs the
plaintext anyway.

### 4. Create the tenant's database and DB user, on `db1`

```bash
ssh -i ~/.ssh/id_ed25519_hetzner root@<db1-reachable-address> \
  'MYSQL_PWD=<mysql root password> /root/platform-provision/provision_tenant_db.py <slug>'
```

It prints `password=<value>` **once**, and prints nothing about it on a re-run —
`CREATE USER IF NOT EXISTS` is a no-op against an existing account. Capture it
before the terminal scrolls; the recovery if you lose it is a password reset,
not a lookup.

`db1` is private-network-only, so this runs from `app1` or through it.

### 5. Complete and merge nothing yet — finish the handover branch

From a local checkout of the generated repository, on the
`provisioning/handover` branch:

```bash
git clone https://github.com/branchLeft/ghost-tenant-<slug>.git
cd ghost-tenant-<slug>
git checkout provisioning/handover

export PULUMI_CONFIG_PASSPHRASE='<the decrypted escrow value>'
export AWS_ACCESS_KEY_ID='<Hetzner S3 access key id>'
export AWS_SECRET_ACCESS_KEY='<Hetzner S3 secret access key>'
pulumi login "$(gh variable get PULUMI_BACKEND_URL --repo branchLeft/ghost-tenant-<slug>)"

# The salt FIRST, before any `--secret` write. Without it Pulumi mints a new
# salt into this file, and the stack's checkpoint then disagrees with its own
# config about which key its secrets are under.
printf '\nencryptionsalt: %s\n' '<the PULUMI_ENCRYPTION_SALT value>' >> Pulumi.<slug>.yaml

pulumi config set --secret databasePassword     --stack <slug>   # from step 4
pulumi config set --secret mediaAccessKeyId     --stack <slug>
pulumi config set --secret mediaSecretAccessKey --stack <slug>

# Then take the salt back out, and confirm before committing.
python3 - <<'EOF'
import pathlib, re
p = pathlib.Path([f for f in pathlib.Path('.').glob('Pulumi.*.yaml')][0])
p.write_text(re.sub(r'(?m)^encryptionsalt:.*\n', '', p.read_text()))
EOF
python3 scripts/assert-no-committed-pulumi-secrets.py --scan-tree .
```

Then fill in `known_hosts` with the app host's SSH host key, taken from the host
over your own root session — never `ssh-keyscan`, which is trust-on-first-use
and would record whatever answered:

```bash
ssh -i ~/.ssh/id_ed25519_hetzner root@<app1-public-ipv4> \
  'cat /etc/ssh/ssh_host_ed25519_key.pub'
```

Write one line into `known_hosts`: `<app1-public-ipv4> ` followed by that whole
output. Commit and push, but do not merge yet.

The salt is not in the escrow ciphertext: it is in the tenant repository's
`PULUMI_ENCRYPTION_SALT` environment secret, which is write-only. If you no
longer have it, read it out of the stack's checkpoint —
`pulumi stack export --stack <slug> | python3 -c 'import json,sys; print(json.load(sys.stdin)["deployment"]["secrets_providers"]["state"]["salt"])'`.

### 6. Provision the host side, in this order

```bash
# a. The volumes and the UID claim. The rendered stack declares both volumes
#    external, so skipping this fails the unit start loudly rather than coming
#    up on a volume Docker seeded world-writable from the image.
ssh -i ~/.ssh/id_ed25519_hetzner root@<app1-public-ipv4> \
  "/root/platform-provision/provision_tenant_volume.py --uid <uid> <slug>"

# b. The secrets file, from the stack's own output. Root-owned 0600. No
#    automated path may write it -- branchleft-deploy writes only
#    /etc/branchleft/<slug>.image.env.
pulumi stack output --show-secrets secretsEnvFile --stack <slug> \
  | ssh -i ~/.ssh/id_ed25519_hetzner root@<app1-public-ipv4> \
      "install -m 0600 -o root -g root /dev/stdin /etc/branchleft/<slug>.env"

# c. The Compose file, also from the stack's output, also root-owned. Every line
#    of it is a runtime-isolation control, which is why nothing automated writes
#    it either: a stack that silently loses one still starts and still serves.
pulumi stack output composeFile --stack <slug> \
  | ssh -i ~/.ssh/id_ed25519_hetzner root@<app1-public-ipv4> \
      "mkdir -p /opt/branchleft/<slug> && install -m 0644 -o root -g root /dev/stdin /opt/branchleft/<slug>/compose.yml"

# d. Enable the unit -- WITHOUT --now. It has no image pin yet, and the unit's
#    EnvironmentFile for that file carries no leading dash, so starting it now
#    would fail. The tenant repo's first deploy pins the digest and restarts it.
ssh -i ~/.ssh/id_ed25519_hetzner root@<app1-public-ipv4> \
  "systemctl enable branchleft-compose@<slug>"

# e. The deploy slot. Generate the keypair on the workstation first: one per
#    tenant, never reused. A key installed against two slots resolves to
#    whichever authorized_keys entry sshd reaches first, which hands one
#    repository a deploy into the other's stack.
ssh-keygen -t ed25519 -N '' -C 'unused' -f ~/.ssh/id_ed25519_slot_<slug>
ssh -i ~/.ssh/id_ed25519_hetzner root@<app1-public-ipv4> \
  "/root/platform-provision/provision_deploy_slot.py --public-key-file /dev/stdin --adopt-existing-stack <slug>" \
  < ~/.ssh/id_ed25519_slot_<slug>.pub

# f. The private half, environment-scoped on the tenant repo. Never a
#    repository secret: that is readable by any workflow run, including one from
#    a branch.
gh secret set APP_HOST_DEPLOY_KEY --repo branchLeft/ghost-tenant-<slug> --env production \
  < ~/.ssh/id_ed25519_slot_<slug>
rm ~/.ssh/id_ed25519_slot_<slug>
```

**Why `--adopt-existing-stack` is expected here, and what you must check before
passing it.** `provision_deploy_slot.py` refuses a slug naming a stack the host
already runs, and step (c) has just created `/opt/branchleft/<slug>`. The
ordering is deliberate — the compose file has to exist before the first deploy,
because `branchleft-deploy` refuses a stack with no compose file, so a slot
granted first would authenticate and then fail every deploy. The cost is that
this refusal fires on every tenant, which is the thing that makes it stop being
read. **So read it every time:** the refusal names the stack it found. If that
name is anything other than the tenant you are onboarding — `website`, `edge`,
`db`, `monitoring` — stop. Granting `website`'s slot to a tenant repository
hands that repository the marketing site.

Tightening this so the flag is not routine on the normal path is tracked
separately; until then, the check is yours to make.

**Verify the slot before going further.** Nothing in CI can exercise the path a
slot key takes — sshd forced command → `$SHELL -c` → `sudo -n` with no
controlling terminal → stdin → wrapper — so this is the proof gate:

```bash
printf '%s\n' 'not-an-image' \
  | ssh -T -i ~/.ssh/id_ed25519_slot_<slug> deploy@<app1-public-ipv4>
```

Expect `branchleft-deploy: image reference must be digest-pinned`. That message
is the proof: the key authenticated, the forced command ran, sudo relayed stdin,
and the only thing left for the caller to supply was the image. Silence or a
hang is the `use_pty` case in
`branchLeft/shared-infra`'s `hetzner/RUNBOOK-provision-host.md`, and the fix
there is a sudoers drop-in, not a change to the key.

**Record the slot off-host.** The register lives only at
`/etc/branchleft/deploy-slots/` on the app host, which is correct for
enforcement and useless for recovery: a host rebuild loses every slot at once,
breaks every tenant's deploys, and leaves nothing to say which keys to re-grant.
Record the tenant, the host and the key fingerprint
(`ssh-keygen -lf ~/.ssh/id_ed25519_slot_<slug>.pub`) wherever that tenant's
other provisioning facts live.

### 7. Register the tenant at the edge

Add this tenant's site block to the edge site registry in
`branchLeft/shared-infra`, using the stack's own value:

```bash
pulumi stack output edgeRequestBodyMaxSize --stack <slug>
```

It is derived from the same input as the container's `/tmp` ceiling so the two
cannot disagree. Setting it there by hand to a different number defeats that.

### 8. Merge the handover pull request

That is the first deploy. A healthy run applies the stack, reads `image` from
it, and pipes the digest over the slot key. Check the `Deploy` job actually ran
— a skipped job still reports the run as successful — and read its summary,
which names the digest that reached the host.

---

## Recovering a failed provisioning run

There is no automatic rollback, and the flow's own ordering is what keeps the
damage small: nothing is created until the escrow has been proved, and the
tenant's stack is not minted until its repository exists and holds the
passphrase.

Undo in the reverse of the order things were made:

1. If a stack was created, `pulumi destroy --stack <slug>` then
   `pulumi stack rm <slug>` against the tenant backend, with that stack's
   passphrase and salt in scope. **Before deleting the repository** — a destroy
   reads the checkpoint, so a repository deleted first strands the stack
   permanently.
2. If host-side steps ran, undo them per the teardown section below.
3. Delete the generated repository. That is also what revokes the provisioning
   PAT's reach into it.

**Do not re-dispatch the workflow to retry.** `pulumi stack init` fails outright
on an existing stack, and that refusal is correct: a retry mints a fresh
passphrase, and resuming an existing stack under a different one would re-wrap
it under a value the tenant repository's secret does not hold.

---

## Teardown

Order matters, and two steps are unrecoverable in the wrong one.

```bash
# 1. Revoke the slot first, so nothing can redeploy while the rest is
#    dismantled. Immediate: the stack keeps running, and nothing can change it.
ssh -i ~/.ssh/id_ed25519_hetzner root@<app1-public-ipv4> \
  "/root/platform-provision/provision_deploy_slot.py --revoke <slug>"

# 2. Stop and disable the unit.
ssh -i ~/.ssh/id_ed25519_hetzner root@<app1-public-ipv4> \
  "systemctl disable --now branchleft-compose@<slug>"
```

3. **Take the final backups you intend to keep** — the database dump and the
   media prefix. After step 5 there is no configured place to put them back.

4. **`pulumi destroy` and `pulumi stack rm`, before the repository or its
   passphrase secret is deleted.** A stack whose passphrase is gone cannot be
   destroyed either, because destroy reads a checkpoint it can no longer
   decrypt.

```bash
# 5. Host-side state, on the app host as root.
rm -f /etc/branchleft/<slug>.env /etc/branchleft/<slug>.image.env
rm -rf /opt/branchleft/<slug>
docker volume rm ghost-<slug>-content ghost-<slug>-adapters
rm -f /etc/branchleft/tenant-uids/<slug>

# 6. The database and its user, on db1 as root. `<sql-slug>` is the slug with
#    every hyphen replaced by an underscore -- MySQL identifiers cannot carry
#    the hyphens a slug may, so `acme-blog` is `ghost_acme_blog` here.
mysql --socket /opt/branchleft/db/run/mysqld/mysqld.sock --user root \
  -e "DROP DATABASE ghost_<sql-slug>; DROP USER 'ghost_<sql-slug>'@'10.20.1.%';"
```

7. Remove this tenant's site block from the edge site registry.

8. Archive the tenant repository rather than deleting it, unless the tenant
   asked otherwise. Archiving keeps the audit trail; deleting removes the record
   that the stack ever existed.

A tenant removed without step 1 leaves a working deploy key for a stack that no
longer exists, and on a host that has not been rebuilt the on-host register is
the only place that would show it.

**The UID is not reused.** Step 5 frees the claim, but handing the same number
to a later tenant means any file left anywhere on that host under the old UID
becomes the new tenant's. Allocate forward.
