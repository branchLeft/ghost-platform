#!/usr/bin/env node
/**
 * A thin CLI over the read-only client.
 *
 *   node admin-api/src/cli.js --url <base> <command>
 *
 * The key is read from GHOST_ADMIN_API_KEY and nowhere else: there is no
 * flag for it, no file path, and no default. Results go to stdout (JSON, or
 * the raw CSV); nothing is ever written to a file. Exit 0 on success, 1 on an
 * API error, 2 on bad usage or a missing key. No message here echoes an
 * argument or a key, so a mistyped secret never reaches a terminal log.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AdminApiConfigError, AdminApiError, createAdminApiClient } from './client.js';

const KEY_VARIABLE = 'GHOST_ADMIN_API_KEY';

const USAGE = [
  'usage: node admin-api/src/cli.js --url <base> [--timeout-ms <n>] <command>',
  '  member-count            how many members',
  '  find-member <email>      the member with that email, or null',
  '  newsletters              the newsletters',
  '  setting <key>            one setting',
  '  support-address          members_support_address, or null',
  '  export-members           the members CSV, raw, to stdout',
  `the key is read from ${KEY_VARIABLE} only`,
].join('\n');

/** @type {Record<string, number>} command name to its argument count */
const COMMANDS = {
  'member-count': 0,
  'find-member': 1,
  newsletters: 0,
  setting: 1,
  'support-address': 0,
  'export-members': 0,
};

/**
 * @param {string[]} argv
 * @returns {{ url: string | undefined, timeoutMs: number | undefined, positional: string[] } | null} null when an option is not one we know
 */
function parseArguments(argv) {
  /** @type {string | undefined} */
  let url;
  /** @type {number | undefined} */
  let timeoutMs;
  /** @type {string[]} */
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = /** @type {string} */ (argv[index]);
    if (argument === '--url' || argument === '--timeout-ms') {
      const value = argv[index + 1];
      if (value === undefined) return null;
      index += 1;
      if (argument === '--url') url = value;
      else timeoutMs = Number(value);
    } else if (argument.startsWith('--url=')) {
      url = argument.slice('--url='.length);
    } else if (argument.startsWith('-')) {
      return null;
    } else {
      positional.push(argument);
    }
  }
  return { url, timeoutMs, positional };
}

/**
 * @param {string[]} argv
 * @param {{ env?: Record<string, string | undefined>, stdout?: { write(text: string): unknown }, stderr?: { write(text: string): unknown }, now?: () => number }} [io]
 * @returns {Promise<number>} the exit code
 */
export async function run(argv, io = {}) {
  const { env = process.env, stdout = process.stdout, stderr = process.stderr, now } = io;
  /** @param {string} text */
  const usageError = (text) => {
    stderr.write(`${text}\n${USAGE}\n`);
    return 2;
  };

  const parsed = parseArguments(argv);
  if (parsed === null) {
    return usageError(`unknown or incomplete option; the key is read from ${KEY_VARIABLE} only`);
  }
  const [command, ...args] = parsed.positional;
  if (command === undefined || !Object.hasOwn(COMMANDS, command)) {
    return usageError('missing or unknown command');
  }
  if (args.length !== COMMANDS[command]) {
    return usageError('wrong number of arguments for the command');
  }
  if (parsed.url === undefined) {
    return usageError('--url is required');
  }
  const key = env[KEY_VARIABLE];
  if (key === undefined || key === '') {
    return usageError(`${KEY_VARIABLE} is not set`);
  }

  try {
    const client = createAdminApiClient({
      baseUrl: parsed.url,
      key,
      ...(now === undefined ? {} : { now }),
      ...(parsed.timeoutMs === undefined ? {} : { timeoutMs: parsed.timeoutMs }),
    });
    const [argument] = args;
    /** @type {unknown} */
    let result;
    switch (command) {
      case 'member-count':
        result = await client.memberCount();
        break;
      case 'find-member':
        result = await client.findMemberByEmail(/** @type {string} */ (argument));
        break;
      case 'newsletters':
        result = await client.listNewsletters();
        break;
      case 'setting':
        result = await client.getSetting(/** @type {string} */ (argument));
        break;
      case 'support-address':
        result = await client.membersSupportAddress();
        break;
      default:
        stdout.write(await client.exportMembersCsv());
        return 0;
    }
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    if (error instanceof AdminApiConfigError) {
      return usageError(error.message);
    }
    if (error instanceof AdminApiError) {
      stderr.write(`${error.message}\n`);
      return 1;
    }
    // Anything else is a bug here, and its message is not ours to trust with
    // a key in it.
    stderr.write('unexpected failure\n');
    return 1;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  process.exitCode = await run(process.argv.slice(2));
}
