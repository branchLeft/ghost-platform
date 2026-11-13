#!/usr/bin/env node
// The real Stripe TEST-mode switch for the checkout gate: every refusal that
// stands between an owner's shell and a Ghost holding a Stripe key lives here,
// in one module the shell, the capture and the setup script all call. The
// default gate never reads any of it. What the switch lets through, and what it
// does not prove: csp/gate/csp-checkout-gate.md.
//
// A refusal names the variable and the rule, never the value. Nothing in this
// file prints, logs or returns a key.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const SWITCH = 'CSP_STRIPE_REAL_TEST_MODE';
export const WEBHOOK_PATH = '/members/webhooks/stripe/';
// Stripe's published success test card. Nothing else is ever typed.
export const PUBLISHED_TEST_CARD = '4242 4242 4242 4242';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

// Environment only: never a file, never an argument.
export const KEY_RULES = [
  {
    name: 'STRIPE_TEST_SECRET_KEY',
    pattern: /^sk_test_[A-Za-z0-9]+$/,
    shape: 'sk_test_ followed by letters and digits',
  },
  {
    name: 'STRIPE_TEST_PUBLISHABLE_KEY',
    pattern: /^pk_test_[A-Za-z0-9]+$/,
    shape: 'pk_test_ followed by letters and digits',
  },
  {
    name: 'STRIPE_TEST_WEBHOOK_SECRET',
    pattern: /^whsec_[A-Za-z0-9]+$/,
    shape: 'whsec_ followed by letters and digits (from `stripe listen --print-secret`)',
  },
];

// Names whose values must never reach any output.
export const SECRET_ENV_NAMES = [
  ...KEY_RULES.map((rule) => rule.name),
  'PROOF_STRIPE_SECRET_KEY',
  'PROOF_STRIPE_PUBLISHABLE_KEY',
  'WEBHOOK_SECRET',
];

// Says what KIND of wrong value it is by its prefix, which is not secret; it
// never repeats any other part of the value.
function classify(value) {
  if (/^sk_live_/.test(value)) return 'a LIVE secret key is refused (test mode only)';
  if (/^pk_live_/.test(value)) return 'a LIVE publishable key is refused (test mode only)';
  if (/^rk_/.test(value)) {
    return 'a restricted key is refused until a test proves it works with Ghost';
  }
  return null;
}

/** `env` is process.env. Returns [{ name, problem }]; empty = every key accepted. */
export function keyProblems(env) {
  const problems = [];
  for (const rule of KEY_RULES) {
    const value = env[rule.name];
    if (typeof value !== 'string' || value === '') {
      problems.push({ name: rule.name, problem: 'is not set or is empty' });
    } else if (!rule.pattern.test(value)) {
      problems.push({
        name: rule.name,
        problem: `${classify(value) ?? 'has the wrong shape'}; it must be ${rule.shape}`,
      });
    }
  }
  return problems;
}

/** The tenant under test must be the local disposable one. Throws, naming only the rule. */
export function assertLocalTenant(origin) {
  let url;
  try {
    url = new URL(origin);
  } catch {
    throw new Error(
      'refusing: the tenant origin is not a URL (it must be http://localhost:<port>)'
    );
  }
  if (url.protocol !== 'http:' || !LOCAL_HOSTS.has(url.hostname) || url.port === '') {
    throw new Error(
      'refusing: real test mode only runs against the local disposable tenant (http://localhost:<port> or http://127.0.0.1:<port>)'
    );
  }
  return url;
}

/** Only the published test card is ever typed. Never repeats the input. */
export function assertPublishedTestCard(input) {
  const digits = typeof input === 'string' ? input.replace(/[\s-]/g, '') : '';
  if (digits !== PUBLISHED_TEST_CARD.replaceAll(' ', '')) {
    throw new Error(
      `refusing: only Stripe's published test card ${PUBLISHED_TEST_CARD} is ever entered; any other card number is refused`
    );
  }
  return PUBLISHED_TEST_CARD;
}

const SECRET_PATTERNS = [/(?:sk|pk|rk)_(?:test|live)_[A-Za-z0-9]+/g, /whsec_[A-Za-z0-9]+/g];

/** The values of every secret-bearing variable that is set and long enough to be one. */
export function secretValues(env) {
  return SECRET_ENV_NAMES.map((name) => env[name]).filter(
    (value) => typeof value === 'string' && value.length >= 8
  );
}

/**
 * Removes key-shaped strings, the exact values of the named secrets, and the
 * fragment of a hosted-checkout URL (it carries the account's encoded key
 * data). Applied to anything the node side prints.
 */
export function redactSecrets(text, secrets = []) {
  let out = String(text);
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (typeof secret === 'string' && secret.length >= 8)
      out = out.split(secret).join('[REDACTED]');
  }
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[REDACTED]');
  return out.replace(/(https:\/\/checkout\.stripe\.com\/[^\s"'#]*)#[^\s"']*/g, '$1#[REDACTED]');
}

/**
 * True when the violation was raised by a document of the tenant, which is
 * what the tenant's policy governs. Stripe's hosted page and its own frames
 * answer to Stripe's policy. A document that cannot be placed is counted as
 * the tenant's (fail closed).
 */
export function isTenantViolation(violation, tenantOrigin) {
  try {
    const document = new URL(violation.documentURI);
    if (document.protocol !== 'http:' && document.protocol !== 'https:') return true;
    return document.origin === new URL(tenantOrigin).origin;
  } catch {
    return true;
  }
}

/** The one command block the owner runs, with every non-secret value filled. */
export function ownerCommand() {
  return [
    'read -rs STRIPE_TEST_SECRET_KEY; export STRIPE_TEST_SECRET_KEY',
    'read -rs STRIPE_TEST_PUBLISHABLE_KEY; export STRIPE_TEST_PUBLISHABLE_KEY',
    'read -rs STRIPE_TEST_WEBHOOK_SECRET; export STRIPE_TEST_WEBHOOK_SECRET',
    `${SWITCH}=1 csp/gate/csp-checkout-gate.py`,
  ].join('\n');
}

export function listenCommand(port) {
  return `stripe listen --forward-to http://localhost:${port}${WEBHOOK_PATH}`;
}

export function usage(port = 4321) {
  return [
    'Real Stripe TEST-mode checkout (opt in with CSP_STRIPE_REAL_TEST_MODE=1).',
    '',
    'Prerequisites: Docker running; render-core built (cd render-core && pnpm run build);',
    'Chromium installed (cd csp/proof && pnpm install && pnpm exec playwright install chromium);',
    'the Stripe CLI logged in to the TEST-mode account, with this running in a second terminal:',
    '',
    listenCommand(port),
    '',
    '`stripe listen --print-secret` prints the signing secret (whsec_...) for STRIPE_TEST_WEBHOOK_SECRET.',
    'The keys come from the shell environment only (a restricted rk_ key is refused). Run from the',
    'repository root, in the first terminal:',
    '',
    ownerCommand(),
    '',
    `Only the published test card ${PUBLISHED_TEST_CARD} is entered, only against the local tenant.`,
  ].join('\n');
}

/**
 * Everything checked before a container starts. Returns { ok, lines }; `lines`
 * is for the owner and carries no key value.
 */
export function preflight(env, origin) {
  const problems = keyProblems(env).map((p) => `${p.name}: ${p.problem}`);
  let url = null;
  try {
    url = assertLocalTenant(origin);
  } catch (err) {
    problems.push(err.message);
  }
  if (env.CSP_STRIPE_TEST_CARD !== undefined) {
    try {
      assertPublishedTestCard(env.CSP_STRIPE_TEST_CARD);
    } catch (err) {
      problems.push(`CSP_STRIPE_TEST_CARD: ${err.message}`);
    }
  }
  if (problems.length > 0) {
    return {
      ok: false,
      lines: [
        'REAL TEST MODE REFUSED:',
        ...problems.map((p) => `  ${p}`),
        '',
        usage(url ? url.port : undefined),
      ],
    };
  }
  return {
    ok: true,
    lines: [
      `real test mode: keys accepted (names only: ${KEY_RULES.map((r) => r.name).join(', ')}), tenant ${url.origin}`,
      `webhook route, in a second terminal before the gate pays: ${listenCommand(url.port)}`,
    ],
  };
}

function option(argv, name) {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main(argv) {
  const [command] = argv;
  if (command === 'help') {
    console.log(usage());
    return 0;
  }
  if (command === 'preflight') {
    const result = preflight(process.env, option(argv, '--origin'));
    const sink = result.ok ? console.log : console.error;
    for (const line of result.lines) sink(line);
    return result.ok ? 0 : 2;
  }
  if (command === 'redact') {
    process.stdout.write(redactSecrets(await readStdin(), secretValues(process.env)));
    return 0;
  }
  console.error('usage: real-test-mode.mjs help | preflight --origin <url> | redact');
  return 2;
}

const launchedDirectly = (() => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (launchedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(redactSecrets(err.message || err, secretValues(process.env)));
      process.exitCode = 2;
    }
  );
}
