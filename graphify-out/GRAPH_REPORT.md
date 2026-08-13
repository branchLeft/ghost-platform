# Graph Report - tenant-mail-surface  (2026-08-13)

## Corpus Check
- 74 files · ~52,297 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 564 nodes · 803 edges · 52 communities (35 shown, 17 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 6 edges (avg confidence: 0.67)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `096f798c`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- store.ts
- platform/index.ts
- devDependencies
- tenant/index.ts
- compilerOptions
- tenant/package.json
- provisioning/index.ts
- package.json
- mailgun-shim/package.json
- messages.test.ts
- assert-no-provisioning-deletes.py
- assert-no-platform-deletes.py
- compilerOptions
- compilerOptions
- compilerOptions
- platform/package.json
- shim.integration.test.ts
- docker-entrypoint.branchleft.sh
- Ghost Platform Provisioner (SQL User)
- restore
- test-storage-guard.sh
- Tenant infra CI Workflow
- Platform Stack Bootstrap
- Provision tenant
- smoke-test.sh
- provisioning/package.json
- GCP Artifact Registry
- Workload Identity Federation
- Ghost Platform Repository
- Publish tenant package workflow
- platform stack config (Pulumi.platform.yaml)
- GCP Cloud Run
- GCP Cloud SQL
- GCP Media Bucket
- Official Ghost Image
- Ghost Tenant Template Repo
- Build image workflow
- docs-lint workflow
- Mailgun shim CI
- Infrastructure README
- GhostTenant Smoke Test README
- tenant/tsconfig.build.json
- Pulumi Platform Stack
- mailgunFields.ts
- mailgun-shim/tsconfig.build.json
- crypto.ts

## God Nodes (most connected - your core abstractions)
1. `ShimStore` - 20 edges
2. `compilerOptions` - 12 edges
3. `compilerOptions` - 12 edges
4. `compilerOptions` - 12 edges
5. `compilerOptions` - 12 edges
6. `requireTenantForDomain()` - 10 edges
7. `tenantRateLimiter()` - 9 edges
8. `createEventsRouter()` - 9 edges
9. `createMessagesRouter()` - 9 edges
10. `createApp()` - 8 edges

## Surprising Connections (you probably didn't know these)
- `createMessagesRouter()` --calls--> `parseMailgunMessageFields()`  [EXTRACTED]
  services/mailgun-shim/src/routes/messages.ts → services/mailgun-shim/src/mailgunFields.ts
- `deliverMessageAsync()` --calls--> `resolveRecipientTokens()`  [EXTRACTED]
  services/mailgun-shim/src/routes/messages.ts → services/mailgun-shim/src/mailgunFields.ts
- `startLimitedApp()` --calls--> `tenantRateLimiter()`  [EXTRACTED]
  services/mailgun-shim/test/unit/rateLimit.test.ts → services/mailgun-shim/src/rateLimit.ts
- `FakeShimStore` --inherits--> `ShimStore`  [EXTRACTED]
  services/mailgun-shim/test/unit/helpers/fakeStore.ts → services/mailgun-shim/src/store.ts
- `get()` --calls--> `basicAuthHeader()`  [EXTRACTED]
  services/mailgun-shim/test/unit/routes/events.test.ts → services/mailgun-shim/test/unit/helpers/startRouter.ts

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Platform Identity & CI Bootstrap Flow** — infra_platform_runbook_bootstrap_platform_stack, ghost_platform_deployer, pulumi_state_bucket [EXTRACTED 1.00]
- **Independent NPM Projects** — pre_commit_config, infra_tenant, infra_platform [EXTRACTED 1.00]
- **Ghost Platform Architecture** — infra_platform, infra_tenant, ghost_platform_tenant_template [EXTRACTED 1.00]

## Communities (52 total, 17 thin omitted)

### Community 0 - "store.ts"
Cohesion: 0.06
Nodes (40): RFC-2822, RFC-822, createApp(), express-serve-static-core, Locals, parseBasicAuth(), requireTenantForDomain(), mapWithConcurrency() (+32 more)

### Community 1 - "platform/index.ts"
Cohesion: 0.08
Nodes (37): enabledApis, requiredServices, config, dbInstanceName, gcpConfig, githubRepo, mediaBucketName, projectId (+29 more)

### Community 2 - "devDependencies"
Cohesion: 0.08
Nodes (25): form-data, mailgun.js, mailparser, devDependencies, form-data, mailgun.js, mailparser, @types/busboy (+17 more)

### Community 3 - "tenant/index.ts"
Cohesion: 0.13
Nodes (30): CloudRunServiceArgs, createCloudRunService(), createPublicInvokerBinding(), mailEnvs(), plainEnv(), secretEnv(), createTenantDatabase(), DatabaseResult (+22 more)

### Community 4 - "compilerOptions"
Cohesion: 0.11
Nodes (18): compilerOptions, experimentalDecorators, lib, module, moduleResolution, noFallthroughCasesInSwitch, outDir, pretty (+10 more)

### Community 5 - "tenant/package.json"
Cohesion: 0.06
Nodes (32): dependencies, @pulumi/gcp, @pulumi/pulumi, @pulumi/random, devDependencies, @types/node, typescript, vitest (+24 more)

### Community 6 - "provisioning/index.ts"
Cohesion: 0.09
Nodes (28): config, deployerServiceAccountId, gcpConfig, platformDbInstanceConnectionName, platformMediaBucketUrl, platformTenantImageRepositoryDockerPath, projectId, provisioningServiceAccountEmail (+20 more)

### Community 7 - "package.json"
Cohesion: 0.08
Nodes (23): eslint, eslint-config-prettier, @eslint/js, globals, description, devDependencies, eslint, eslint-config-prettier (+15 more)

### Community 8 - "mailgun-shim/package.json"
Cohesion: 0.09
Nodes (21): busboy, express, express-rate-limit, nodemailer, dependencies, busboy, express, express-rate-limit (+13 more)

### Community 9 - "messages.test.ts"
Cohesion: 0.21
Nodes (12): StoredEvent, createFakeStore(), FakeShimStore, basicAuthHeader(), StartedRouter, startRouter(), wait(), get() (+4 more)

### Community 10 - "assert-no-provisioning-deletes.py"
Cohesion: 0.18
Nodes (18): _coverage_self_test(), _declaration_pattern_literal(), _declaration_pattern_suffix(), destructive_steps(), main(), _plan(), _print_quarantined(), protected_names() (+10 more)

### Community 11 - "assert-no-platform-deletes.py"
Cohesion: 0.19
Nodes (16): _coverage_self_test(), _declaration_pattern(), destructive_steps(), main(), _plan(), _print_quarantined(), Pattern, _quarantine() (+8 more)

### Community 12 - "compilerOptions"
Cohesion: 0.11
Nodes (17): ES2023, vitest.config.ts, compilerOptions, esModuleInterop, forceConsistentCasingInFileNames, lib, module, moduleResolution (+9 more)

### Community 13 - "compilerOptions"
Cohesion: 0.11
Nodes (18): compilerOptions, experimentalDecorators, lib, module, moduleResolution, noFallthroughCasesInSwitch, outDir, pretty (+10 more)

### Community 14 - "compilerOptions"
Cohesion: 0.11
Nodes (18): compilerOptions, experimentalDecorators, lib, module, moduleResolution, noFallthroughCasesInSwitch, outDir, pretty (+10 more)

### Community 15 - "platform/package.json"
Cohesion: 0.12
Nodes (15): dependencies, @pulumi/gcp, @pulumi/pulumi, @pulumi/random, devDependencies, @types/node, typescript, @pulumi/gcp (+7 more)

### Community 16 - "shim.integration.test.ts"
Cohesion: 0.21
Nodes (8): smtp-server, createMailgunClient(), MailgunConstructor, MailgunCtor, ReceivedMessage, SmtpSink, startSmtpSink(), smtp-server

### Community 18 - "docker-entrypoint.branchleft.sh"
Cohesion: 0.50
Nodes (3): server__host, server__port, docker-entrypoint.branchleft.sh script

### Community 19 - "Ghost Platform Provisioner (SQL User)"
Cohesion: 0.50
Nodes (4): Ghost Platform Provisioner (SQL User), Ghost Tenant Provisioner Service Account, Provisioning Credential Bootstrap, Tenant Provisioning Identity Bootstrap

### Community 20 - "restore"
Cohesion: 0.67
Nodes (3): main(), restore(), Path

### Community 21 - "test-storage-guard.sh"
Cohesion: 0.83
Nodes (3): assert_blocked(), assert_boots(), test-storage-guard.sh script

### Community 22 - "Tenant infra CI Workflow"
Cohesion: 0.67
Nodes (3): actions/checkout, actions/setup-node, Tenant infra CI Workflow

### Community 23 - "Platform Stack Bootstrap"
Cohesion: 0.67
Nodes (3): Ghost Platform Deployer Service Account, Platform Stack Bootstrap, Pulumi State Bucket (gs://branchleft-pulumi-state)

### Community 24 - "Provision tenant"
Cohesion: 1.00
Nodes (3): Provision tenant, Pulumi Provisioning Program, branchleft-pulumi-state

### Community 26 - "provisioning/package.json"
Cohesion: 0.14
Nodes (13): dependencies, @pulumi/gcp, @pulumi/pulumi, devDependencies, @types/node, typescript, @pulumi/gcp, @pulumi/pulumi (+5 more)

### Community 45 - "tenant/tsconfig.build.json"
Cohesion: 0.14
Nodes (13): compilerOptions, declaration, noEmit, outDir, rootDir, exclude, extends, include (+5 more)

### Community 49 - "mailgunFields.ts"
Cohesion: 0.36
Nodes (6): accumulate(), asArray(), asString(), ParsedMessageFields, parseMailgunMessageFields(), resolveRecipientTokens()

### Community 50 - "mailgun-shim/tsconfig.build.json"
Cohesion: 0.29
Nodes (6): exclude, extends, include, src/**/*.ts, test/**/*.ts, ./tsconfig.json

### Community 51 - "crypto.ts"
Cohesion: 0.70
Nodes (3): hashApiKey(), HashedApiKey, verifyApiKey()

## Knowledge Gaps
- **230 isolated node(s):** `docker-entrypoint.branchleft.sh script`, `server__port`, `server__host`, `requiredServices`, `config` (+225 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **17 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `devDependencies` connect `devDependencies` to `mailgun-shim/package.json`, `shim.integration.test.ts`?**
  _High betweenness centrality (0.041) - this node is a cross-community bridge._
- **Why does `smtp-server` connect `shim.integration.test.ts` to `devDependencies`?**
  _High betweenness centrality (0.037) - this node is a cross-community bridge._
- **What connects `docker-entrypoint.branchleft.sh script`, `server__port`, `server__host` to the rest of the system?**
  _230 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `store.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.05664568678267309 - nodes in this community are weakly interconnected._
- **Should `platform/index.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.07955596669750231 - nodes in this community are weakly interconnected._
- **Should `devDependencies` be split into smaller, more focused modules?**
  _Cohesion score 0.08 - nodes in this community are weakly interconnected._
- **Should `tenant/index.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.13205128205128205 - nodes in this community are weakly interconnected._