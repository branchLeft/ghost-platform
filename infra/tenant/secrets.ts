import * as pulumi from '@pulumi/pulumi';
import * as gcp from '@pulumi/gcp';

/**
 * Creates a Secret Manager secret holding a single value and grants the
 * given service account read access to it -- the per-tenant-namespaced
 * pattern doc 02 calls for ("each tenant's Ghost instance should only be
 * able to read its own secrets... per-tenant IAM bindings on Secret Manager
 * entries"), extending `website/infra/secrets.ts`'s `secretWithValue`
 * helper with the accessor binding that file's version doesn't need (that
 * repo has exactly one runtime identity for its one secret set; this
 * component creates a new identity *per tenant*, so the binding has to be
 * part of the same helper or every call site would have to remember it).
 *
 * The secret's value is never read back into this program's own output or
 * logged -- it flows straight from whatever `pulumi.Output` produced it
 * (a `random.RandomPassword.result`, an `HmacKey.secret`, ...) into
 * `SecretVersion.secretData`, which Pulumi treats as a secret input/output
 * end to end.
 */
export function secretWithValue(
  parent: pulumi.Resource,
  name: string,
  secretId: string,
  value: pulumi.Input<string>,
  accessorServiceAccountEmail: pulumi.Input<string>,
  dependsOn: pulumi.Input<pulumi.Input<pulumi.Resource>[]> | undefined = undefined
): { secret: gcp.secretmanager.Secret; version: gcp.secretmanager.SecretVersion } {
  const secret = new gcp.secretmanager.Secret(
    name,
    {
      secretId,
      replication: { auto: {} },
    },
    { parent, dependsOn }
  );

  const version = new gcp.secretmanager.SecretVersion(
    `${name}-version`,
    {
      secret: secret.id,
      secretData: value,
    },
    { parent: secret }
  );

  new gcp.secretmanager.SecretIamMember(
    `${name}-accessor`,
    {
      secretId: secret.id,
      role: 'roles/secretmanager.secretAccessor',
      member: pulumi.interpolate`serviceAccount:${accessorServiceAccountEmail}`,
    },
    { parent: secret }
  );

  return { secret, version };
}
