#!/usr/bin/env node
import { userInfo } from 'node:os';
import { recoverOwner, RecoveryRefused } from './recovery.js';

/** Usage: `node dist/recover-cli.js <owner-user-id>`.
 *
 * `ZITADEL_URL` is a loopback origin, `ZITADEL_INSTANCE_HOST` the sign-in
 * service's public name, `ZITADEL_RECOVERY_TOKEN_FILE` the staged credential
 * and `RECOVERY_AUDIT_FILE` the audit record. The credential is read from the
 * file, never argv or the environment. */
async function main(argv: readonly string[]): Promise<number> {
  const [userId] = argv;
  const baseUrl = process.env['ZITADEL_URL'];
  const instanceHost = process.env['ZITADEL_INSTANCE_HOST'];
  const credentialFile = process.env['ZITADEL_RECOVERY_TOKEN_FILE'];
  const auditFile = process.env['RECOVERY_AUDIT_FILE'];
  if (!userId || !baseUrl || !instanceHost || !credentialFile || !auditFile) {
    process.stderr.write(
      'usage: ZITADEL_URL=... ZITADEL_INSTANCE_HOST=... ZITADEL_RECOVERY_TOKEN_FILE=... RECOVERY_AUDIT_FILE=... recover <owner-user-id>\n'
    );
    return 2;
  }
  const maxAge = process.env['RECOVERY_MAX_AGE_SECONDS'];
  try {
    const result = await recoverOwner(
      {
        baseUrl,
        instanceHost,
        userId,
        credentialFile,
        auditFile,
        ...(maxAge === undefined ? {} : { maxCredentialAgeSeconds: Number(maxAge) }),
      },
      {
        fetch: (target, init) => fetch(target, init),
        now: () => new Date(),
        uid: process.getuid?.() ?? -1,
        actor: userInfo().username,
        stdoutIsTerminal: process.stdout.isTTY === true,
      }
    );
    process.stdout.write(`${result.actions.join(', ')}\n`);
    process.stdout.write(
      `one-time password (change required at first sign-in): ${result.oneTimePassword}\n`
    );
    return 0;
  } catch (error) {
    if (error instanceof RecoveryRefused) {
      process.stderr.write(`refused (${error.code}): ${error.message}\n`);
      return 1;
    }
    process.stderr.write('failed\n');
    return 1;
  }
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
