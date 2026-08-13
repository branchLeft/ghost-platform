# Graph Report - .  (2026-08-08)

## Corpus Check
- Corpus is ~26,995 words - fits in a single context window. You may not need a graph.

## Summary
- 222 nodes · 293 edges · 14 communities (13 shown, 1 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 3 edges (avg confidence: 0.82)
- Token cost: 88,379 input · 0 output

## Community Hubs (Navigation)
- Platform Infra Config
- CI/CD Workflows & Guardrails
- Tenant Cloud Run Service
- Platform Package Dependencies
- Platform TypeScript Config
- Tenant Package Dependencies
- Tenant Smoke-Test Dependencies
- Tenant Smoke-Test TS Config
- Tenant TypeScript Config
- Delete-Guard Script
- Storage Guard & Container Image
- Docker Entrypoint
- Storage Guard Test
- Smoke Test Script

## God Nodes (most connected - your core abstractions)
1. `compilerOptions` - 12 edges
2. `compilerOptions` - 12 edges
3. `compilerOptions` - 12 edges
4. `enabledApis` - 7 edges
5. `Platform stack bootstrap runbook` - 6 edges
6. `region` - 5 edges
7. `self_test()` - 5 edges
8. `verify_coverage()` - 5 edges
9. `createCloudRunService()` - 5 edges
10. `secretWithValue()` - 5 edges

## Surprising Connections (you probably didn't know these)
- `ghost_platform_provisioner privilege-narrowing incident (2026-08-05)` --semantically_similar_to--> `assert-no-platform-deletes.py preflight guard`  [INFERRED] [semantically similar]
  infra/platform/RUNBOOK-bootstrap.md → .github/workflows/infra-platform-ci.yml
- `ghost-platform repository` --references--> `Build-only CI workflow (build.yml)`  [EXTRACTED]
  README.md → .github/workflows/build.yml
- `Smoke test step (scripts/smoke-test.sh)` --references--> `scripts/smoke-test.sh`  [EXTRACTED]
  .github/workflows/build.yml → README.md
- `Storage guard regression test step (scripts/test-storage-guard.sh)` --references--> `scripts/test-storage-guard.sh`  [EXTRACTED]
  .github/workflows/build.yml → README.md
- `Platform stack (infra/platform/)` --references--> `Deploy (pulumi up) job`  [EXTRACTED]
  infra/README.md → .github/workflows/infra-platform-ci.yml

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **CI-driven platform deploy guardrail system** — _github_workflows_infra_platform_ci_workload_identity_federation, _github_workflows_infra_platform_ci_assert_no_platform_deletes, _github_workflows_infra_platform_ci_deployer_service_account, _github_workflows_infra_platform_ci_deploy_job [INFERRED 0.85]
- **Repo split: platform stack vs. tenant component** — infra_readme_platform_stack, infra_readme_tenant_component, infra_readme_split_by_shape_rationale, _github_workflows_infra_tenant_ci_reusable_component_scope [EXTRACTED 1.00]
- **Platform stack bootstrap identity chain** — infra_platform_runbook_bootstrap_bootstrap_process, infra_platform_runbook_bootstrap_kms_binding, infra_platform_runbook_bootstrap_state_bucket_binding, _github_workflows_infra_platform_ci_deployer_service_account [INFERRED 0.85]

## Communities (14 total, 1 thin omitted)

### Community 0 - "Platform Infra Config"
Cohesion: 0.08
Nodes (37): enabledApis, requiredServices, config, dbInstanceName, gcpConfig, githubRepo, mediaBucketName, projectId (+29 more)

### Community 1 - "CI/CD Workflows & Guardrails"
Cohesion: 0.12
Nodes (25): Build-only CI workflow (build.yml), Smoke test step (scripts/smoke-test.sh), assert-no-platform-deletes.py preflight guard, Decision: CI owns platform stack applies (Rob, 2026-08-05), Deploy (pulumi up) job, ghost-platform-deployer service account, Type check job (infra/platform CI), Workload Identity Federation (GitHub OIDC to GCP) (+17 more)

### Community 2 - "Tenant Cloud Run Service"
Cohesion: 0.16
Nodes (16): CloudRunServiceArgs, createCloudRunService(), createPublicInvokerBinding(), plainEnv(), secretEnv(), createTenantDatabase(), DatabaseResult, DEFAULT_MAX_USER_CONNECTIONS (+8 more)

### Community 3 - "Platform Package Dependencies"
Cohesion: 0.12
Nodes (15): dependencies, @pulumi/gcp, @pulumi/pulumi, @pulumi/random, devDependencies, @types/node, typescript, @pulumi/gcp (+7 more)

### Community 4 - "Platform TypeScript Config"
Cohesion: 0.12
Nodes (15): compilerOptions, experimentalDecorators, lib, module, moduleResolution, noFallthroughCasesInSwitch, outDir, pretty (+7 more)

### Community 5 - "Tenant Package Dependencies"
Cohesion: 0.12
Nodes (15): dependencies, @pulumi/gcp, @pulumi/pulumi, @pulumi/random, devDependencies, @types/node, typescript, @pulumi/gcp (+7 more)

### Community 6 - "Tenant Smoke-Test Dependencies"
Cohesion: 0.12
Nodes (15): dependencies, @pulumi/gcp, @pulumi/pulumi, @pulumi/random, devDependencies, @types/node, typescript, @pulumi/gcp (+7 more)

### Community 7 - "Tenant Smoke-Test TS Config"
Cohesion: 0.12
Nodes (15): compilerOptions, experimentalDecorators, lib, module, moduleResolution, noFallthroughCasesInSwitch, outDir, pretty (+7 more)

### Community 8 - "Tenant TypeScript Config"
Cohesion: 0.12
Nodes (15): compilerOptions, experimentalDecorators, lib, module, moduleResolution, noFallthroughCasesInSwitch, outDir, pretty (+7 more)

### Community 9 - "Delete-Guard Script"
Cohesion: 0.26
Nodes (12): _coverage_self_test(), _declaration_pattern(), destructive_steps(), main(), _plan(), Match `new <Ctor>('<name>'` -- a resource *declaration*, not a mention.…, Return (name, op) for every protected resource this plan would destroy. Raises…, Prove `--verify-coverage` still distinguishes a declaration from a mention.… (+4 more)

### Community 10 - "Storage Guard & Container Image"
Cohesion: 0.33
Nodes (6): Storage guard regression test step (scripts/test-storage-guard.sh), Correction: Ghost env vars have no GHOST_ prefix, Fail-closed storage guard (docker-entrypoint.branchleft.sh), Ghost's built-in S3Storage adapter, scripts/test-storage-guard.sh, Tenant Ghost container image (Dockerfile)

### Community 11 - "Docker Entrypoint"
Cohesion: 0.50
Nodes (3): server__host, server__port, docker-entrypoint.branchleft.sh script

### Community 12 - "Storage Guard Test"
Cohesion: 0.83
Nodes (3): assert_blocked(), assert_boots(), test-storage-guard.sh script

## Knowledge Gaps
- **94 isolated node(s):** `docker-entrypoint.branchleft.sh script`, `server__port`, `server__host`, `requiredServices`, `config` (+89 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **1 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Build-only CI workflow (build.yml)` connect `CI/CD Workflows & Guardrails` to `Storage Guard & Container Image`?**
  _High betweenness centrality (0.008) - this node is a cross-community bridge._
- **Why does `Storage guard regression test step (scripts/test-storage-guard.sh)` connect `Storage Guard & Container Image` to `CI/CD Workflows & Guardrails`?**
  _High betweenness centrality (0.005) - this node is a cross-community bridge._
- **What connects `docker-entrypoint.branchleft.sh script`, `server__port`, `server__host` to the rest of the system?**
  _94 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Platform Infra Config` be split into smaller, more focused modules?**
  _Cohesion score 0.07955596669750231 - nodes in this community are weakly interconnected._
- **Should `CI/CD Workflows & Guardrails` be split into smaller, more focused modules?**
  _Cohesion score 0.12 - nodes in this community are weakly interconnected._
- **Should `Platform Package Dependencies` be split into smaller, more focused modules?**
  _Cohesion score 0.125 - nodes in this community are weakly interconnected._
- **Should `Platform TypeScript Config` be split into smaller, more focused modules?**
  _Cohesion score 0.125 - nodes in this community are weakly interconnected._