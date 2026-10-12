# assert-tenant-provisioning-branch-policy.py

## Module overview

A job that names `environment: tenant-provisioning` runs on whichever branch
dispatched it, with that branch's copy of the workflow file. The workflow's
own in-file checks therefore cannot be the control: a non-main run can leave
them out. The only thing that stops a non-main ref from reaching the
environment's secrets is the environment's deployment branch policy.

This script asserts that policy:

  - the environment restricts deployments to selected branches
    (`custom_branch_policies` true, `protected_branches` false);
  - its only deployment branch rule is `main`, of type `branch`.

It takes no network access. The caller fetches both documents:

    gh api repos/<owner>/<repo>/environments/tenant-provisioning > env.json
    gh api repos/<owner>/<repo>/environments/tenant-provisioning/deployment-branch-policies > policies.json
    python3 assert-tenant-provisioning-branch-policy.py --environment-json env.json --policies-json policies.json

Exit 0 is a pass. Exit 1 prints one `::error::` line per problem.

Setting the policy is a repository-settings change and is not done by this
script. The script only detects that the policy has changed.
