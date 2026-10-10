# assert-no-tenant-deletes.py

## Module overview

`<preview-json-file>` must come from `pulumi preview --json --show-sames`.
Without `--show-sames`, Pulumi omits a component from `steps` entirely once
its registered inputs stop changing — proved against a real capture of this
component, not assumed. Without the flag, a tenant that has not changed and a
tenant whose component silently stopped registering its identity as an input
(this guard's original defect) produce the identical empty result, and this
guard cannot tell them apart. `component_is_present()` refuses a plan that
carries no step at all for the component it guards, so a plan captured
without the flag fails closed rather than silently passing.

**This guard ships inside `@branchleft/ghost-platform-tenant`, not inside the
tenant repo that runs it.** The earlier GCP-era guard lived in the template and
carried a literal list of the component's child-resource names, which meant a
version bump of the component could rename what the guard was watching without
touching the guard. Shipping it beside the component it guards makes the two
one artifact: a rename is a diff in this directory.

Three halves, guarding three different failures.

**1. Nothing in a tenant plan may be destroyed or replaced.** Default-deny,
with no protected-name list at all, because under the Hetzner shape a tenant
program declares no cloud resources — its whole content is configuration, and a
routine apply can only ever be `create`, `same` or `update`. A `delete` or a
`replace` in a tenant plan is therefore always either a teardown that belongs
in a deliberate `pulumi destroy`, or a refactor that has not been thought
through. A name list would have to be kept in step with the component; "no
destructive step at all" needs no maintenance and cannot silently empty.

**2. The tenant's identity may not change under an existing stack.** This is
the half a plan guard cannot express as an op, because every one of these
arrives as a clean `update`:

  - the content volume name — the tenant's themes, settings, routes and
    generated assets are orphaned on the host under the old name, and Ghost
    boots onto an empty volume that reseeds from the image as though the site
    were new;
  - the UID — the content volume is mode `0700` to the old number, so the
    container starts and then cannot read its own data;
  - the database name — Ghost boots against an empty schema and runs its
    migrations into it;
  - the slug or stack name — the Compose project, systemd unit and secrets
    file all move, leaving the running stack orphaned under the old name;
  - the app host address — the tenant is published on a host the edge is not
    routing to.

None of those is destructive to Pulumi and every one of them is destructive to
the tenant. They are compared here from `GhostTenant`'s own `identity` output.

**3. A tenant plan may carry the stack and the component, and nothing else.**
Every step's resource type must be `pulumi:pulumi:Stack` or
`ghostPlatform:tenant:GhostTenant`; any other type is refused, whatever its op,
including a provider (`pulumi:providers:*`) and a child of the component. While
a tenant stack holds configuration and no real resources, the worst a holder of
the state credential can do to its checkpoint is corrupt a rendering, so the
first real resource must fail the plan and force that to be reconsidered,
instead of shipping green. The type is read from the URN's own type field, split from the left: a
resource *name* containing `::` stays inside the name and cannot present the
stack's token as its own type.

A check that a tenant's real preview carries no other step type has not been
made against a live capture: the captured fixtures below show the stack and the
component only. If a real preview ever carries another type for a stack that
holds no resources, this refusal fails the deploy loudly, and that capture is
what should decide the allowlist.

**What this cannot prove**, both limits real and inherited from every plan
guard in this estate:

1. `pulumi preview` compares the program to Pulumi *state*, never to the live
   host. A volume already deleted out of band still reads as unchanged.
2. Nothing in a plan guard constrains a direct action outside Pulumi. The
   host-side refusals in `app/provision/provision_tenant_volume.py` are the
   control for that path; this is defence in depth on top.

## verify_coverage

Reads the built package where one exists and the TypeScript source
otherwise, so the check works both from a tenant repo's `node_modules` and
from this repository's own tree.

Scoped to whatever object `super()` actually passes as `identity`, not to
`this.identity = pulumi.output(...)`. A preview decides whether a
component emits a step at all from its *registered inputs* — what
`super()` was called with — never from an output assignment, which a
preview does not even resolve (see the constructor's own comment). A
version of this check that read the output instead passed a component
with genuinely empty props outright, which is the exact defect this guard
exists to catch; checking the output was never checking the thing that
determines whether a plan carries a step at all.

## Self-test fixtures

A guard whose matcher has quietly stopped matching passes every input, so the
refusals are exercised rather than assumed. The `_CAPTURED_*` fixtures are
trimmed from real `pulumi preview --json` runs against this component — the
guard's original defect was exactly a plan shape nobody had captured, only
assumed, so this is the part that has to stop being hand-built. The
destructive-op fixtures below them stay synthetic: a `ComponentResource` has
no provider to produce a genuine `replace`, so there is no real preview to
capture for those, and they exist to exercise the op-name substring match
rather than a captured shape. The extra-resource fixtures are synthetic for
the same reason: this component declares no provider resource, so there is no
real preview that carries one. They are exercised through `main()` as well as
`check_plan()`, and beside a control case of exactly the stack and the
component, so a refusal is known to be about the extra resource and not about
a plan that was never clean.

## Upgrade-from-2.0.0 fixture

Derived, not captured: no `2.0.0`-pinned tenant exists yet to take a genuine
`pulumi preview --json` from, and this guard must never be run against a
real stack. Instead built from two things already settled elsewhere in this
repository, not assumed:

- `git show v2.0.0:infra/tenant/index.ts` calls `super(COMPONENT_TYPE_TOKEN,
  name, {}, opts)` — empty registered props, so `inputs` on the persisted
  resource is empty — but calls `this.registerOutputs({identity:
  this.identity, ...})`, so that same resource's `outputs.identity` is fully
  populated. A tenant deployed under `2.0.0` is left in exactly this shape.
- `_CAPTURED_IDENTITY_UPDATE`, itself a real capture, already establishes
  what an `update` step's `newState` looks like for this component:
  `identity` under `inputs` only, never `outputs` — a component's outputs
  are not resolved until an apply, true of every step here (see
  `_captured_same_stack_step()`).

Confidence: high on structure — both source facts were read from the tagged
commits, not recalled — but this is still a derived shape, not a substitute
for a genuine capture once a `2.0.0`-pinned tenant exists to take one from.

Every identity field, not just one, is varied against this shape: the old
identity here is reachable only through `outputs` and the new one only
through `inputs`, a combination none of the other fixtures exercise, and a
comparison that quietly narrowed to a single field for that combination
would still look correct against a fixture that only ever changed `uid`.
