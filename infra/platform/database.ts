import * as gcp from '@pulumi/gcp';
import { dbInstanceName, region } from './config';
import { enabledApis } from './apis';

/**
 * The one shared Cloud SQL instance for every tenant (doc 02 / doc 09,
 * OPEN-QUESTIONS.md #4 and #8). Holds no databases or users itself -- a
 * tenant's logical database and dedicated DB user are provisioned by the
 * *tenant* Pulumi component (next story), against this instance.
 *
 * Sized per the platform owner's 2026-08-04 decision (minimum size everything to start, for
 * two known tiny tenants) and doc 07 §0's corrected right-sizing note:
 * `db-f1-micro`, single zone, smallest workable storage. Revisit only on a
 * real capacity signal (doc 08), not pre-emptively.
 *
 * **Verified, not assumed, that this tier actually supports what doc 09
 * requires (7-day PITR via binary logging):**
 * - Google's own "Configure point-in-time recovery (PITR) | Cloud SQL for
 *   MySQL" documentation
 *   (https://docs.cloud.google.com/sql/docs/mysql/backup-recovery/configure-pitr)
 *   gives a complete worked Terraform example on `tier = "db-f1-micro"` with
 *   `binary_log_enabled = true` and `transaction_log_retention_days = "3"` --
 *   i.e. Google's own docs use this exact tier as the PITR example, not an
 *   unsupported combination.
 * - `gcloud sql instances create --help` (run live against this project,
 *   2026-08-04): `--enable-point-in-time-recovery` and `--tier` are
 *   independent flags with no cross-restriction noted; the only db-f1-micro
 *   caveat surfaced anywhere is exclusion from the Cloud SQL *SLA*
 *   (uptime/availability), which is a completely different axis from PITR
 *   *capability* and was already known (doc 07 §0, OPEN-QUESTIONS.md #13).
 * - `@pulumi/gcp`'s own generated type docs (mirroring the upstream
 *   Terraform provider, itself generated from GCP's API discovery document)
 *   state outright: "shared-core and custom tiers such as `db-g1-small`,
 *   `db-f1-micro`, and `db-custom-*` require `edition = "ENTERPRISE"`" --
 *   confirming both that the tier is a supported PITR/backup configuration
 *   and that `ENTERPRISE` (not `ENTERPRISE_PLUS`) is the only valid edition
 *   for it, which happens to match doc 09's 7-day-retention assumption
 *   (Enterprise's free/max PITR ceiling; Enterprise Plus goes to 35 days but
 *   isn't available at this tier regardless).
 *
 * **Conclusion: no conflict to report.** Every part of doc 09's backup
 * decision (binary logging, PITR, 7-day retention, Enterprise edition)
 * survives at `db-f1-micro` unchanged. The only thing this tier does *not*
 * carry is the Cloud SQL SLA -- already documented as true at every
 * affordable configuration, not something this story's tier choice gives up.
 */
export const dbInstance = new gcp.sql.DatabaseInstance(
  'ghost-platform-db',
  {
    name: dbInstanceName,
    databaseVersion: 'MYSQL_8_0',
    region,

    // Pulumi/IaC-level guard: `pulumi destroy`/an update that would delete
    // this resource fails until this is deliberately flipped. Paired with
    // the API-level guard below -- this instance holds every tenant's data
    // on a single shared instance (doc 02), so an accidental destroy here
    // is not a single tenant's incident, it's the whole platform's.
    deletionProtection: true,

    settings: {
      tier: 'db-f1-micro',
      // Required for shared-core tiers -- see the verification note above.
      edition: 'ENTERPRISE',
      // Single zone per the platform owner's minimum-size decision. Note this does not
      // trade away an SLA that was otherwise available: doc 07 §0 already
      // established the Cloud SQL SLA requires HA *with dedicated CPU*, so
      // no affordable Tier 1-2 configuration carries one, `REGIONAL`
      // (HA) included at this tier.
      availabilityType: 'ZONAL',

      // Smallest workable storage: 10GB is the documented minimum for
      // PD_SSD (`gcloud sql instances create --help` and @pulumi/gcp's
      // field docs both state this). Autoresize stays on with a low cap
      // rather than off outright -- an unhandled full-disk condition on a
      // shared instance is a platform-wide outage, and 20GB is still a
      // small, deliberate ceiling rather than "grow without limit"; raise
      // it (or move to a bigger tier) as a conscious decision once real
      // tenant data volume asks for it.
      diskType: 'PD_SSD',
      diskSize: 10,
      diskAutoresize: true,
      diskAutoresizeLimit: 20,

      // Doc 09's backup/PITR decision. `pointInTimeRecoveryEnabled` is a
      // MySQL no-op (Postgres/SQL Server only per @pulumi/gcp's field docs)
      // -- for MySQL, `binaryLogEnabled` + `transactionLogRetentionDays` on
      // top of `enabled` *is* PITR. 7 days matches doc 09's decision and is
      // Enterprise edition's retention ceiling (Enterprise Plus allows up
      // to 35 but isn't available at this tier, and hasn't been adopted
      // regardless -- see OPEN-QUESTIONS.md #8).
      backupConfiguration: {
        enabled: true,
        binaryLogEnabled: true,
        startTime: '03:00',
        transactionLogRetentionDays: 7,
        backupRetentionSettings: {
          retainedBackups: 7,
          retentionUnit: 'COUNT',
        },
      },

      // Public IP, but deliberately zero authorized networks: nothing
      // connects over a raw public-IP TCP path. The intended consumer --
      // tenant Cloud Run services, next story -- reaches this instance via
      // Cloud Run's built-in Cloud SQL connection (a Unix socket over the
      // Cloud SQL Auth Proxy's IAM-authenticated tunnel), which does not
      // require an authorizedNetworks entry at all. A private-IP/VPC
      // Serverless-Access-Connector setup was considered and not adopted:
      // it has its own real monthly floor cost (the same shape of tradeoff
      // doc 02 already worked through for Filestore vs. Cloud SQL), and
      // buys no isolation benefit the IAM-authenticated proxy doesn't
      // already provide at this scale.
      ipConfiguration: {
        ipv4Enabled: true,
        authorizedNetworks: [],
      },

      // API-level deletion guard -- protects against deletion from *any*
      // surface (gcloud, Console, a differently-authenticated Pulumi run),
      // not just this Pulumi program. See the top-level `deletionProtection`
      // comment above for why both guards are set.
      deletionProtectionEnabled: true,
    },
  },
  { dependsOn: enabledApis }
);

// Deliberately no gcp.sql.User or gcp.sql.Database resource here. Doc 02:
// one logical database + one dedicated DB user *per tenant*, provisioned by
// the tenant component (next story), not this shared stack. This program
// creates no tenant-shaped credential of any kind -- including a root
// password: leaving it unset lets Cloud SQL generate one internally that
// this program never reads, stores, or has any use for (nothing here
// connects as root), rather than generating a credential this repo would
// then have to treat as a secret.
