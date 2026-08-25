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

**Prove the archived private key decrypts what the committed public key
produces — before the first tenant, not at the first recovery.** "Saved and
readable" is not custody: doc 14 §3.3 records this rule from INC-3, that the
value read back out of the password manager is the one a decrypt-touching
command has proved. The escrow's `--self-test` round-trips an *ephemeral*
keypair, which proves the openssl option strings are self-consistent and nothing
whatever about the committed key.

Run this once, and again after any rotation, with the private half fetched from
**each** place it is meant to live — the password manager and the off-site
archive — not from the copy still on the workstation from generation:

```bash
# The public half as committed, the private half as retrieved.
printf 'escrow-custody-proof' \
  | python3 infra/provisioning/scripts/escrow-tenant-passphrase.py \
      --public-key infra/provisioning/escrow/tenant-passphrase-escrow.pub.pem \
  | base64 -d > /tmp/escrow-proof.bin
openssl pkeyutl -decrypt -inkey <the retrieved private key> \
  -pkeyopt rsa_padding_mode:oaep -pkeyopt rsa_oaep_md:sha256 \
  -pkeyopt rsa_mgf1_md:sha256 -in /tmp/escrow-proof.bin
rm -f /tmp/escrow-proof.bin
```

It must print `escrow-custody-proof`. Anything else — a padding error, a
different key, an archive holding a truncated paste — means every tenant
passphrase this flow would go on to publish is unrecoverable, while the flow
reports success on every run. That is the failure this step exists to catch, and
it is the only step in this runbook that catches it.

**The provisioning credentials, environment-scoped.** Every
provisioning-capable secret on `branchLeft/ghost-platform` must sit on the
`tenant-provisioning` environment, not at the repository level, behind that
environment's required-reviewer rule. This is the replacement for the
Workload Identity provider condition the rewrite deletes: that one was enforced
by Google regardless of any GitHub setting, and there is no like-for-like
substitute. The workflow verifies both the rule and the scoping before it
creates anything, and refuses if it cannot read either.

**The tenant-state credential is its own Object Storage key pair, not
`HETZNER_S3_ACCESS_KEY_ID` / `HETZNER_S3_SECRET_ACCESS_KEY`.** Those two names
are `infra-hosts-ci.yml`'s repository-level credential for
`branchleft-pulumi-state`, the estate's own state bucket; that workflow's plan
job declares no `environment:` and can only ever resolve a repository secret,
so it must keep them at the repository level. Provisioning reaches a
different bucket, `branchleft-tenant-pulumi-state`, and needs a *second*
Object Storage credential scoped to it — reusing the estate's would give a
tenant deployer write access to the checkpoint the production hcloud token
lives in (branchLeft/workspace#284). Mint it in the Hetzner Cloud Console
(Object Storage → the project holding `branchleft-tenant-pulumi-state` →
Credentials → Generate credential), scoped read-write to that bucket alone if
per-bucket scoping is available on the account, and set it under its own
names:

```bash
gh secret set GH_PAT_TENANT_PROVISIONING        --repo branchLeft/ghost-platform --env tenant-provisioning
gh secret set TENANT_STATE_S3_ACCESS_KEY_ID     --repo branchLeft/ghost-platform --env tenant-provisioning
gh secret set TENANT_STATE_S3_SECRET_ACCESS_KEY --repo branchLeft/ghost-platform --env tenant-provisioning
gh secret delete GH_PAT_TENANT_PROVISIONING     --repo branchLeft/ghost-platform
```

**Do not delete `HETZNER_S3_ACCESS_KEY_ID` / `HETZNER_S3_SECRET_ACCESS_KEY` at
the repository level.** `infra-hosts-ci.yml`'s plan and apply jobs both read
them from there, and deleting them breaks the hosts stack that owns `app1` and
`db1`. The delete above applies only to `GH_PAT_TENANT_PROVISIONING`, which
has no other consumer: `secrets.X` falls back to a repository-level secret of
the same name, so a copy left behind keeps `provision-tenant.yml` working
while remaining readable by every other run in the repository, including one
from a branch. Nothing else reports that.

**The platform-wide repository variables** the flow reads. These are facts about
the estate rather than per-tenant answers, which is why they are variables and
not ten more fields on a dispatch form — `workflow_dispatch` also caps inputs at
ten.

```bash
gh variable set PLATFORM_DB_PRIVATE_IP     --repo branchLeft/ghost-platform --body '10.20.1.20'
gh variable set PLATFORM_MEDIA_ENDPOINT    --repo branchLeft/ghost-platform --body 'https://hel1.your-objectstorage.com'
gh variable set PLATFORM_MEDIA_REGION      --repo branchLeft/ghost-platform --body 'hel1'
gh variable set HETZNER_PULUMI_BACKEND_URL --repo branchLeft/ghost-platform --body 's3://<tenant-state-bucket>?endpoint=<region>.your-objectstorage.com&s3ForcePathStyle=true&region=<region>'
```

**There is no `PLATFORM_MEDIA_BUCKET` or `PLATFORM_MEDIA_PUBLIC_BASE_URL`, and
if this repository still holds either, delete it.** Each tenant has its own
media bucket, `branchleft-media-<slug>`, and the tenant component derives both
the bucket name and the public base URL from the slug and the endpoint. A
leftover variable naming one shared bucket is read by nothing and is evidence
for a shape that no longer exists:

```bash
gh variable delete PLATFORM_MEDIA_BUCKET          --repo branchLeft/ghost-platform
gh variable delete PLATFORM_MEDIA_PUBLIC_BASE_URL --repo branchLeft/ghost-platform
```

And the reviewers a generated tenant repository's `production` environment is
created with. Verbatim JSON, because it becomes the API body's `reviewers` array
— a repository variable rather than an identity written into a workflow file in
a public repository:

```bash
gh api users/Rob-branchLeft --jq .id     # the numeric id to put below
gh variable set TENANT_ENVIRONMENT_REVIEWERS --repo branchLeft/ghost-platform \
  --body '[{"type":"User","id":<that id>}]'
```

Provisioning refuses to create a public tenant repo's environment while this is
unset, and reads the environment back afterwards to confirm a
`required_reviewers` rule actually landed — a PUT naming a principal without
access to the new repository succeeds and silently produces no rule. For a
**private** tenant repo it is skipped with a warning: protection rules are a
public-repository feature on this plan tier, so choosing private for a tenant
also chooses that their deploy cannot be gated. The environment is still
created, because the scoping it gives — secrets readable only by the job that
declares it, never by a run from a branch — is plan-independent and is most of
the value.

The endpoint host and the region must name the same location: against Ceph RGW
the region is part of the SigV4 credential scope, so a mismatch is an opaque 403
that reads as a credential problem rather than as an addressing one.
`HETZNER_PULUMI_BACKEND_URL` must **not** be
`branchleft-pulumi-state` — that bucket holds the estate's own checkpoint, and
the S3 credential is not scoped per stack, so pointing tenants at it would give
every tenant deployer write access to the checkpoint the production hcloud token
lives in. The workflow refuses that bucket by name.

---

## Onboarding, in order

The order is not arbitrary. Two steps have to precede the deploy slot, and one
of them changes whether a safety check fires at all — see step 8. Step 6 has an
ordering constraint of its own: a media bucket exists, briefly, before the
policy that fences it, and during that window every S3 key in the project can
reach it.

### 1. Ask the tenant whether their repository is public

Public is the platform default. Whether it is public is a disclosure about that
tenant — the repository, and its name, say that they are a customer — so it is
their answer to give, before anything is created. The dispatch form opens on an
option that is not a valid answer, so it cannot be left unanswered.

### 2. Put the provisioning scripts on the hosts

**Do this before step 3, every time.** Three different directories in two
repositories provide the scripts this runbook invokes, they land in three
different places, and `db1` is private-network-only so everything reaching it
goes through `edge1`. An earlier draft of this runbook invoked all of them from
one invented path.

```bash
JUMP="ssh -i ~/.ssh/id_ed25519_hetzner -W %h:%p root@46.225.95.167"

# a. db1's own scripts, from branchLeft/ghost-platform. Destination fixed by
#    db/RUNBOOK-db.md -- the systemd units installed from there reference it.
scp -i ~/.ssh/id_ed25519_hetzner -o ProxyCommand="$JUMP" -r \
  db/provision root@10.20.1.20:/opt/branchleft/db/

# b. The app host's per-tenant volume step, also from branchLeft/ghost-platform.
#    No runbook placed this anywhere before; it goes beside the host-provisioning
#    scripts so that one directory on an app host holds everything root runs.
scp -i ~/.ssh/id_ed25519_hetzner -r \
  app/provision/. root@<app1-public-ipv4>:/root/platform-provision/

# c. The host-provisioning scripts, from branchLeft/shared-infra. This is what
#    installs provision_deploy_slot.py and the branchleft-deploy wrapper that
#    understands --slot; a host provisioned before slot keys existed needs the
#    wrapper refreshed or every slot deploy fails with `invalid stack name`.
scp -i ~/.ssh/id_ed25519_hetzner -r \
  hetzner/provision/. root@<app1-public-ipv4>:/root/platform-provision
ssh -i ~/.ssh/id_ed25519_hetzner root@<app1-public-ipv4> \
  '/root/platform-provision/30-install-deploy-tooling.sh'
```

`app/provision/` and `hetzner/provision/` share `/root/platform-provision` on an
app host and come from different repositories, so copy both whenever either
changes; a stale half is a script that runs and disagrees with its neighbour.

### 3. Allocate the UID on the app host

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

### 4. Dispatch the provisioning workflow

```bash
gh workflow run "Provision tenant" --repo branchLeft/ghost-platform \
  -f tenant_visibility=public \
  -f tenant_name=<slug> \
  -f tenant_repo=ghost-tenant-<slug> \
  -f site_url=https://<hostname> \
  -f tenant_uid=<uid from step 3> \
  -f host_port=<port from step 3> \
  -f app_host_private_ip=10.20.1.100 \
  -f app_host_ssh_address=<app1-public-ipv4> \
  -f image_ref=ghcr.io/branchleft/<image>@sha256:<digest>
```

It pauses on the `tenant-provisioning` environment's required reviewer. Approve
it, then read the job summary: it carries the escrowed passphrase ciphertext.

**Decrypt and file that ciphertext now**, per
`infra/provisioning/escrow/README.md`. The run's summary and its artifact both
expire; the password manager is the escrow of record, and step 7 needs the
plaintext anyway — it is what unlocks `pulumi config set --secret` on this
tenant's stack.

### 5. Create the tenant's database and DB user, on `db1`

`db1` has no public address, so this goes through `edge1`:

```bash
JUMP="ssh -i ~/.ssh/id_ed25519_hetzner -W %h:%p root@46.225.95.167"
ssh -i ~/.ssh/id_ed25519_hetzner -o ProxyCommand="$JUMP" root@10.20.1.20 \
  'MYSQL_PWD=<mysql root password> python3 /opt/branchleft/db/provision/provision_tenant_db.py <slug>'
```

It prints `password=<value>` **once**, and prints nothing about it on a re-run —
`CREATE USER IF NOT EXISTS` is a no-op against an existing account. Capture it
before the terminal scrolls; the recovery if you lose it is a password reset,
not a lookup.


### 6. Create this tenant's media bucket, credential and bucket policy

**This is an operator step and cannot be anything else.** Hetzner states that
S3 credentials are created in the Cloud Console and *not* via any API — neither
the S3 API nor the hcloud API carries the resource — so no runner can mint one.
That is also the posture we would want: a credential able to create media
credentials is a credential able to reach every tenant's media, which is the
boundary this whole shape exists to draw.

The bucket name is `branchleft-media-<slug>`. It is derived, not chosen: the
tenant component computes it from the slug, so a bucket under any other name is
a tenant whose uploads fail after a deploy that reported success.

Render the exact sequence, with every value in place, from a checkout of
`branchLeft/ghost-platform`:

```bash
python3 infra/provisioning/scripts/render-media-bucket-policy.py --commands \
  --slug <slug> \
  --project-id <the Hetzner project id holding the Object Storage credentials> \
  --tenant-access-key <the access key id the Console showed for this tenant> \
  --admin-access-key <your own operator access key id>
```

Take the credential first, because the policy has to name it:

1. Hetzner Cloud Console → the project holding the media buckets → Object
   Storage → Credentials → **Generate credential**. Record both halves
   immediately: **the secret is shown once and cannot be read back, through the
   Console or otherwise.**
2. Run the rendered sequence. It creates the bucket with `--acl private`,
   enables versioning, applies the policy and reads it back.

**Do not leave the policy for later, and do not hand the tenant its key before
the policy is applied.** Hetzner's default is that every key pair is valid for
every bucket in its own project, so an unfenced bucket is reachable by every
credential in that project, and a fresh credential reaches every unfenced bucket.

**Never `--acl public-read`.** That is a *bucket* ACL, and READ on a bucket is
LIST in S3 semantics: it would publish this tenant's object names, and through
the bucket name the fact that the tenant exists. Public-read-but-not-listable is
served by the policy's `s3:GetObject` grant on the object path alone.

#### Verify the four decisions against the live bucket

Hetzner documents `NotPrincipal` verbatim but publishes no list of supported
policy actions or conditions, and says nothing about `NotAction`, which the
policy's object-level deny relies on to leave anonymous reads intact. A
successful `put-bucket-policy` is therefore not proof. Run all four, with the
**tenant's** key in the environment except where stated:

```bash
S3="aws --endpoint-url https://hel1.your-objectstorage.com s3api"

# a. Public read works. No credential at all -- if this needs one, cdnUrl is
#    broken for every reader.
echo hello > /tmp/probe.txt
$S3 put-object --bucket branchleft-media-<slug> --key probe.txt --body /tmp/probe.txt
curl -fsS "https://hel1.your-objectstorage.com/branchleft-media-<slug>/probe.txt"

# b. The bucket is NOT listable anonymously. This is the one that fails
#    silently: every image would still load. Expect AccessDenied, not a listing.
curl -sS "https://hel1.your-objectstorage.com/branchleft-media-<slug>?list-type=2"

# c. Media is append-only for the tenant's own key. Expect AccessDenied.
$S3 delete-object --bucket branchleft-media-<slug> --key probe.txt

# d. The tenant's key reaches no other tenant's bucket. Expect AccessDenied.
$S3 list-objects-v2 --bucket branchleft-media-<another live slug>
```

If (b) returns a listing, or (c) succeeds, stop: the policy did not land as
written, and neither failure is visible from the tenant's side. Delete `probe.txt`
with your **operator** key once the four are done.

The operator key is deliberately still able to delete: append-only is a property
of the tenant's credential, so that Ghost admin's delete button returns a 403,
not a property of the bucket.

### 7. Complete and merge nothing yet — finish the handover branch

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

pulumi config set --secret databasePassword     --stack <slug>   # from step 5
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

### 8. Provision the host side, in this order

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
#    Run WITHOUT --adopt-existing-stack first. It is expected to REFUSE, and
#    the refusal names the stack it found on the host -- that name is the
#    check. Passing the flag up front suppresses the message entirely, so a
#    mistyped slug would grant that stack's deploy slot to this tenant with no
#    signal at all.
ssh -i ~/.ssh/id_ed25519_hetzner root@<app1-public-ipv4> \
  "/root/platform-provision/provision_deploy_slot.py --public-key-file /dev/stdin <slug>" \
  < ~/.ssh/id_ed25519_slot_<slug>.pub

#    Read the refusal. It must name the slug you are onboarding, and nothing
#    else. Only then re-run with the flag.
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

**Why the grant is run twice, and why the first one is not a mistake.**
`provision_deploy_slot.py` refuses a slug naming a stack the host already runs
unless `--adopt-existing-stack` is given, and step (c) has just created
`/opt/branchleft/<slug>`. That ordering is deliberate: the compose file has to
exist before the first deploy, because `branchleft-deploy` refuses a stack with
no compose file, so a slot granted first would authenticate and then fail every
deploy.

The cost is that the refusal fires for every tenant, which is what makes a
refusal stop being read. Passing the flag up front is worse than that, not
better: the script raises **only** when the flag is absent, so with it there is
no refusal, no warning, and no line naming the stack found — a mistyped slug at
this step silently grants that stack's slot to this tenant. Granting `website`'s
slot to a tenant repository hands that repository the marketing site.

So the first run exists to produce the message, and reading it is the control.
If it names anything other than the tenant you are onboarding — `website`,
`edge`, `db`, `monitoring` — stop.

Changing the check's shape so the flag is not routine on the normal path is
[branchLeft/workspace#279](https://github.com/branchLeft/workspace/issues/279);
until it lands, this two-step is the procedure.

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

### 9. Register the tenant at the edge

Add this tenant's site block to the edge site registry in
`branchLeft/shared-infra`, using the stack's own value:

```bash
pulumi stack output edgeRequestBodyMaxSize --stack <slug>
```

It is derived from the same input as the container's `/tmp` ceiling so the two
cannot disagree. Setting it there by hand to a different number defeats that.

### 10. Merge the handover pull request

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
   whole of `branchleft-media-<slug>`. After step 5 there is no configured place
   to put them back.

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

9. **The media credential, then the bucket, in the Cloud Console.** Both count
   against account-wide allowances — 200 S3 credentials and 100 buckets across
   all projects — so a teardown that leaves them behind spends two of a fixed
   budget on a tenant that no longer exists. Delete the credential first: a
   bucket deleted while its key still exists leaves a key with no policy fencing
   it, valid for every other bucket in the project. Emptying the bucket needs
   your operator key, because the tenant's own cannot delete.

A tenant removed without step 1 leaves a working deploy key for a stack that no
longer exists, and on a host that has not been rebuilt the on-host register is
the only place that would show it.

**The UID is not reused.** Step 5 frees the claim, but handing the same number
to a later tenant means any file left anywhere on that host under the old UID
becomes the new tenant's. Allocate forward.
