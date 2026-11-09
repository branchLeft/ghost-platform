#!/usr/bin/env node
// Derives the per-directive origin allowlist a Stripe-taking site needs, from
// what a real browser actually reported -- never from a list somebody typed.
// The sibling of derive-script-hashes.mjs: that one measures the theme's
// inline scripts, this one measures what Stripe.js pulls in.
//
// Input (stdin): the JSON csp/proof/capture-checkout.mjs prints for a run
//   - against the REAL Stripe.js (CSP_STRIPE_REAL_JS=1; a stub teaches nothing),
//   - under the strict policy with NO payments allowance, served REPORT-ONLY
//     (an enforcing run stops at the first blocked script, and the frames and
//     requests that would have followed never happen, so the set comes out
//     short and the next deploy breaks on the origin that was hidden).
// Both are checked, and the tool refuses a capture that is neither.
//
// An origin outside Stripe's own domains is never added silently: it is
// reported and the tool exits non-zero, so a hostile or accidental third-party
// request in the capture cannot widen the policy.
//
// Usage:
//   node derive-payment-origins.mjs < capture.json            print the derived set
//   node derive-payment-origins.mjs --write < capture.json    write render-core/src/payments-origins.json
//   node derive-payment-origins.mjs --check < capture.json    exit 1 unless it equals the committed file
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ORIGINS_PATH = join(HERE, '..', '..', 'render-core', 'src', 'payments-origins.json');

/** A violated directive, as the browser names it, to the directive an allowance extends. */
export const DIRECTIVE_OF = {
  'script-src-elem': 'script-src',
  'script-src': 'script-src',
  'frame-src': 'frame-src',
  'connect-src': 'connect-src',
};
const DIRECTIVES = ['script-src', 'frame-src', 'connect-src'];

/**
 * Stripe's published Content Security Policy sources for Checkout and Stripe.js:
 * https://docs.stripe.com/security/guide, section "Content Security Policy",
 * fetched 2026-11-09. This is a FLOOR: the measured set is unioned with it and
 * never replaces it, so a capture that happens to miss a published source
 * cannot narrow the policy. It is taken from documentation and has NOT been
 * verified against the real Stripe.js. `*.js.stripe.com` is the one wildcard;
 * Stripe documents it as a performance allowance for Stripe.js frames.
 * Excluded from the doc on purpose: maps.googleapis.com (Address Element with
 * the tenant's own Google key), and the Connect, Onelink, Crypto and img-src
 * sections, none of which this site loads.
 */
export const PUBLISHED_FLOOR = Object.freeze({
  'script-src': ['https://*.js.stripe.com', 'https://checkout.stripe.com', 'https://js.stripe.com'],
  'frame-src': [
    'https://*.js.stripe.com',
    'https://checkout.stripe.com',
    'https://hooks.stripe.com',
    'https://js.stripe.com',
  ],
  'connect-src': ['https://api.stripe.com', 'https://checkout.stripe.com'],
});

/** Hosts Stripe serves from; a blocked request to anything else is not Stripe's. */
const STRIPE_DOMAINS = ['stripe.com', 'stripe.network'];
const isStripeHost = (host) =>
  STRIPE_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));

/**
 * The measured per-directive origins unioned with PUBLISHED_FLOOR: sorted,
 * de-duplicated, and never narrower than the floor. Pure: no capture is read.
 */
export function withPublishedFloor(measured) {
  return Object.fromEntries(
    DIRECTIVES.map((d) => [d, [...new Set([...(measured[d] ?? []), ...PUBLISHED_FLOOR[d]])].sort()])
  );
}

/**
 * `capture` is capture-checkout.mjs's JSON. Returns `{ origins, problems }`:
 * `origins` maps each directive to the measured origins unioned with
 * PUBLISHED_FLOOR, sorted and de-duplicated; `problems` is non-empty when the
 * capture cannot be trusted or contained an origin that is not Stripe's.
 */
export function deriveOrigins(capture) {
  const problems = [];
  if (capture.realStripeJs !== true) {
    problems.push(
      'the capture used a stub Stripe.js (run with CSP_STRIPE_REAL_JS=1); a stub measures nothing'
    );
  }
  const violations = Array.isArray(capture.violations) ? capture.violations : [];
  const found = Object.fromEntries(DIRECTIVES.map((d) => [d, new Set()]));
  for (const v of violations) {
    if (v.disposition !== 'report') {
      problems.push(
        `a ${v.directive} violation for ${v.blockedURI} was ENFORCED, not reported; ` +
          'serve the probe policy report-only so nothing is hidden behind the first block'
      );
      continue;
    }
    const directive = DIRECTIVE_OF[v.directive];
    if (!directive) {
      problems.push(`unmapped directive ${v.directive} blocking ${v.blockedURI}`);
      continue;
    }
    let url;
    try {
      url = new URL(v.blockedURI);
    } catch {
      problems.push(`${v.directive} blocked "${v.blockedURI}", which is not an origin`);
      continue;
    }
    if (url.protocol !== 'https:' || !isStripeHost(url.hostname)) {
      problems.push(`${v.directive} blocked ${url.origin}, which is not a Stripe https origin`);
      continue;
    }
    found[directive].add(url.origin);
  }
  const measured = Object.fromEntries(DIRECTIVES.map((d) => [d, [...found[d]].sort()]));
  if (problems.length === 0 && DIRECTIVES.every((d) => measured[d].length === 0)) {
    problems.push(
      'the capture reported no Stripe origin at all; the probe policy was not exercised'
    );
  }
  return { origins: withPublishedFloor(measured), problems };
}

/** The committed file's exact text for a derived set (Prettier-stable: short arrays stay on one line). */
export function renderOriginsFile(origins) {
  const lines = DIRECTIVES.map((d) => {
    const one = `    "${d}": [${origins[d].map((o) => JSON.stringify(o)).join(', ')}]`;
    if (one.length <= 80) return one;
    return `    "${d}": [\n${origins[d].map((o) => `      ${JSON.stringify(o)}`).join(',\n')}\n    ]`;
  });
  return (
    '{\n' +
    '  "generatedBy": "csp/derive/derive-payment-origins.mjs",\n' +
    '  "origins": {\n' +
    lines.join(',\n') +
    '\n  }\n' +
    '}\n'
  );
}

function main() {
  const args = process.argv.slice(2);
  const { origins, problems } = deriveOrigins(JSON.parse(readFileSync(0, 'utf-8')));
  for (const p of problems) console.error(`DERIVE PAYMENT ORIGINS RED: ${p}`);
  if (problems.length > 0) {
    process.exitCode = 1;
    return;
  }
  const text = renderOriginsFile(origins);
  if (args.includes('--check')) {
    const committed = readFileSync(ORIGINS_PATH, 'utf-8');
    if (committed !== text) {
      console.error(
        'DERIVE PAYMENT ORIGINS RED: render-core/src/payments-origins.json does not match what the browser reported.\n' +
          `measured:\n${text}committed:\n${committed}`
      );
      process.exitCode = 1;
      return;
    }
    console.log('DERIVE PAYMENT ORIGINS GREEN: the committed allowlist equals the measured set');
    return;
  }
  if (args.includes('--write')) {
    writeFileSync(ORIGINS_PATH, text);
    console.error(`wrote ${ORIGINS_PATH}`);
    return;
  }
  process.stdout.write(text);
}

// Run only when launched directly, comparing real paths (a symlink or a path
// with a space defeats a string compare of import.meta.url). A fail-closed
// misfire guard like csp-regression-gate.mjs's is not needed here: this tool
// writes or checks a file and exits non-zero on any problem, it does not stand
// in for a verdict a caller might skip.
function launchedDirectly() {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return basename(argv1) === basename(fileURLToPath(import.meta.url));
  }
}

if (launchedDirectly()) main();
