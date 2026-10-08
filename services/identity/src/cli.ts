#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { validateConfig } from './config.js';
import { desiredState } from './desired.js';
import { managementClient } from './management.js';
import { reconcile } from './reconcile.js';

/** Usage: `node dist/cli.js <config.json> [outputs.json]`.
 *
 * `ZITADEL_URL` names the instance. The service-account token is read from
 * the file `ZITADEL_TOKEN_FILE` names, never from argv or the environment, so
 * it appears in neither `ps` nor a process dump. */
async function main(argv: readonly string[]): Promise<number> {
  const flags = argv.filter((a) => a.startsWith('--'));
  const [configPath, outputsPath] = argv.filter((a) => !a.startsWith('--'));
  const flag = (name: string): string | undefined =>
    flags.find((f) => f.startsWith(`--${name}=`))?.slice(name.length + 3);
  const devConsole = flag('local-dev-console-origin');
  const devPortal = flag('local-dev-portal-origin');
  const unknown = flags.filter(
    (f) =>
      !f.startsWith('--local-dev-console-origin=') && !f.startsWith('--local-dev-portal-origin=')
  );
  if (unknown.length > 0 || (devConsole === undefined) !== (devPortal === undefined)) {
    process.stderr.write(
      'both --local-dev-console-origin= and --local-dev-portal-origin= or neither\n'
    );
    return 2;
  }
  const url = process.env['ZITADEL_URL'];
  const tokenFile = process.env['ZITADEL_TOKEN_FILE'];
  if (!configPath || !url || !tokenFile) {
    process.stderr.write(
      'usage: ZITADEL_URL=... ZITADEL_TOKEN_FILE=... cli <config.json> [outputs.json]\n'
    );
    return 2;
  }
  const config = validateConfig(JSON.parse(readFileSync(configPath, 'utf8')));
  const client = managementClient({
    baseUrl: url,
    token: () => readFileSync(tokenFile, 'utf8').trim(),
    fetch: (target, init) => fetch(target, init),
  });
  const result = await reconcile(
    client,
    desiredState(
      config,
      devConsole !== undefined && devPortal !== undefined
        ? { console: devConsole, portal: devPortal }
        : undefined
    )
  );
  for (const action of result.actions) {
    const detail = action.detail ? ` (${action.detail})` : '';
    process.stdout.write(`${action.status.padEnd(9)} ${action.kind} ${action.name}${detail}\n`);
  }
  if (outputsPath) writeFileSync(outputsPath, `${JSON.stringify(result.outputs, null, 2)}\n`);
  return result.drift ? 1 : 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'failed'}\n`);
    process.exitCode = 1;
  }
);
