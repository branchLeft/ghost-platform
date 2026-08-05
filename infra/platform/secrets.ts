import * as pulumi from '@pulumi/pulumi';
import * as gcp from '@pulumi/gcp';
import { enabledApis } from './apis';

/**
 * Creates a Secret Manager secret holding a single value.
 *
 * Mirrors `infra/tenant/secrets.ts`'s helper of the same name, minus its
 * accessor binding. That deliberate omission is the whole point of the
 * difference: the tenant helper creates a new runtime identity per tenant, so
 * the `roles/secretmanager.secretAccessor` binding has to travel with the
 * helper or a call site would forget it. This stack's secrets have **no
 * service-account consumer at all** -- nothing running in GCP reads them --
 * so a reader binding here would be a grant with no grantee, i.e. an access
 * path opened speculatively. Whoever needs to read one reads it as a human
 * with `gcloud secrets versions access`, under their own project-level IAM.
 *
 * When a future story does give one of these secrets a machine consumer, add
 * the binding at that call site (or add an optional accessor parameter then),
 * so the grant lands in the same diff as the thing that needs it.
 *
 * The value is never read back into this program's own outputs or logged --
 * it flows straight from whatever `pulumi.Output` produced it (a
 * `random.RandomPassword.result`, ...) into `SecretVersion.secretData`, which
 * Pulumi treats as a secret input/output end to end.
 */
export function secretWithValue(
  name: string,
  secretId: string,
  value: pulumi.Input<string>,
  opts: pulumi.CustomResourceOptions = {}
): { secret: gcp.secretmanager.Secret; version: gcp.secretmanager.SecretVersion } {
  const secret = new gcp.secretmanager.Secret(
    name,
    {
      secretId,
      replication: { auto: {} },
    },
    { dependsOn: enabledApis, ...opts }
  );

  const version = new gcp.secretmanager.SecretVersion(
    `${name}-version`,
    {
      secret: secret.id,
      secretData: value,
    },
    { parent: secret }
  );

  return { secret, version };
}
