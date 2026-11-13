/**
 * The strict content policy (LLD-5 C1-C4):
 * `renderEdgeSiteBlock`'s CSP construction, `validateScriptHash`'s format
 * check, and the fail-soft invariant — enforcing only when a real, derived
 * hash set is supplied; report-only otherwise. The real browser proof
 * against a live Ghost, Caddy and headless Chromium (LLD-5's own "Done
 * means") lives in `csp/proof/run-proof.sh`, driven by the derivation tool
 * in `csp/derive/`; this file is the pure, no-I/O half.
 */
import { afterAll, describe, expect, it } from 'vitest';
import {
  PAYMENTS_CSP_NONE,
  renderEdgeSiteBlock,
  stripeOrigins,
  THEME_CSP_UNAVAILABLE,
  validatePaymentOrigin,
  validateScriptHash,
  type PaymentsCsp,
  type ScriptHash,
  type ThemeCsp,
} from '../src/edge.js';
import paymentsOrigins from '../src/payments-origins.json' with { type: 'json' };
import { FieldValidationError } from '../src/brand.js';
import { uploadLimits } from '../src/runtime.js';
import { TEST_ZONES, demoDescriptor, entryTenantDescriptor } from './fixtures.js';
import { validate } from '../src/validate.js';
import type { renderEdgeSiteBlock as RenderEdgeSiteBlockFn } from '../src/edge.js';
import { cleanupSabotageTmp, importSabotaged } from './helpers/sourceSabotage.js';

afterAll(() => {
  cleanupSabotageTmp();
});

// Two real inline-script hashes measured by LLD-5's own spike (05-gate-and-
// edge.html §04, row B) — used here only as syntactically valid tokens, not
// re-derived.
const HASH_A = 'sha256-F3sUOTY6nsxjO/E0Yh1sWe8bHnfXA+ynZs4mVCavecs=' as ScriptHash;
const HASH_B = 'sha256-i9xJDx6XdSpqycz2NHiN9rjeNHF7ihqFRSGYnLQBQZ0=' as ScriptHash;

describe('validateScriptHash', () => {
  it('accepts a well-formed sha256 CSP hash-source token', () => {
    expect(validateScriptHash('sha256-F3sUOTY6nsxjO/E0Yh1sWe8bHnfXA+ynZs4mVCavecs=')).toBe(
      'sha256-F3sUOTY6nsxjO/E0Yh1sWe8bHnfXA+ynZs4mVCavecs='
    );
  });

  it('control case: the pattern still rejects something', () => {
    expect(() => validateScriptHash('not-a-hash')).toThrow(FieldValidationError);
  });

  it('rejects a value with no sha256- prefix', () => {
    expect(() => validateScriptHash('F3sUOTY6nsxjO/E0Yh1sWe8bHnfXA+ynZs4mVCavecs=')).toThrow(
      FieldValidationError
    );
  });

  it('rejects a value missing the trailing padding', () => {
    expect(() => validateScriptHash('sha256-F3sUOTY6nsxjO/E0Yh1sWe8bHnfXA+ynZs4mVCavec')).toThrow(
      FieldValidationError
    );
  });

  it('rejects a value that smuggles CSP syntax through the token', () => {
    // A quote or semicolon here would let the value it tags close the
    // directive early or open a new one when interpolated into the
    // rendered header — the pattern's anchoring is what stops that.
    expect(() => validateScriptHash("sha256-abc'; script-src 'unsafe-inline")).toThrow(
      FieldValidationError
    );
  });
});

describe('renderEdgeSiteBlock — content security policy', () => {
  const limits = uploadLimits();

  it('defaults to the report-only policy with no hash allowance when themeCsp is omitted', () => {
    const descriptor = validate(entryTenantDescriptor(), TEST_ZONES);
    const edge = renderEdgeSiteBlock(descriptor, TEST_ZONES, limits);
    expect(edge.contentSecurityPolicyMode).toBe('report-only');
    expect(edge.contentSecurityPolicy).toContain("script-src 'self'");
    expect(edge.contentSecurityPolicy).not.toContain('sha256-');
  });

  it('renders the same report-only policy for THEME_CSP_UNAVAILABLE explicitly', () => {
    const descriptor = validate(demoDescriptor(), TEST_ZONES);
    const edge = renderEdgeSiteBlock(descriptor, TEST_ZONES, limits, THEME_CSP_UNAVAILABLE);
    expect(edge.contentSecurityPolicyMode).toBe('report-only');
  });

  it("renders the enforcing policy with the theme's own hash set quoted into script-src, and never elsewhere in the header", () => {
    const descriptor = validate(entryTenantDescriptor(), TEST_ZONES);
    const themeCsp: ThemeCsp = { kind: 'computed', hashes: [HASH_A, HASH_B] };
    const edge = renderEdgeSiteBlock(descriptor, TEST_ZONES, limits, themeCsp);
    expect(edge.contentSecurityPolicyMode).toBe('enforcing');
    expect(edge.contentSecurityPolicy).toBe(
      "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; " +
        `script-src 'self' '${HASH_A}' '${HASH_B}'; frame-ancestors 'self'`
    );
    // style-src carries no hash and stays unsafe-inline -- LLD-5 C4's
    // accepted residual, unrelated to script hashing. The directive ends
    // at the semicolon, immediately followed by script-src -- so a hash
    // token could not have landed inside style-src instead.
    expect(edge.contentSecurityPolicy).toContain("style-src 'self' 'unsafe-inline'; script-src");
  });

  it('falls back to report-only when the computed set is empty', () => {
    // An empty hash array is not the same claim as "computed with zero
    // scripts on a real theme" (which is plausible) and not the same as
    // "could not be computed" either -- but a script-src with 'self' and no
    // hash allowance behaves identically for a theme with genuinely zero
    // inline scripts, so this only has to not crash and not claim
    // 'enforcing' incorrectly here; the true "genuinely zero" case is
    // exercised by the derivation tool's own tests, not this one.
    const descriptor = validate(entryTenantDescriptor(), TEST_ZONES);
    const themeCsp: ThemeCsp = { kind: 'computed', hashes: [] };
    const edge = renderEdgeSiteBlock(descriptor, TEST_ZONES, limits, themeCsp);
    expect(edge.contentSecurityPolicy).toContain("script-src 'self'");
    expect(edge.contentSecurityPolicy).not.toContain('sha256-');
  });
});

/** The policy as `directive -> source tokens`, so a test compares sets, never substrings. */
function directivesOf(policy: string): Map<string, string[]> {
  return new Map(
    policy.split('; ').map((part) => {
      const [name, ...sources] = part.split(' ');
      return [name as string, sources];
    })
  );
}

/** Every https origin the policy names, across all directives, sorted. */
function httpsOriginsOf(policy: string): string[] {
  return [...directivesOf(policy).values()]
    .flat()
    .filter((token) => token.startsWith('https:') && token.length > 'https:'.length)
    .sort();
}

// The Stripe origins a paid Ghost needs, as measured by csp/derive (Ghost 6.55.0,
// the real Stripe.js, hosted checkout): the one script and frame host, and no
// connect-src. A change here is a re-measurement, never an edit.
const MEASURED_STRIPE_ORIGINS = {
  'script-src': ['https://js.stripe.com'],
  'frame-src': ['https://js.stripe.com'],
  'connect-src': [] as string[],
};

describe('renderEdgeSiteBlock — payments allowance', () => {
  const limits = uploadLimits();
  const themeCsp: ThemeCsp = { kind: 'computed', hashes: [HASH_A, HASH_B] };
  const descriptor = () => validate(entryTenantDescriptor(), TEST_ZONES);

  it('none (explicit or by default) renders the policy byte-identically to before payments existed', () => {
    const before =
      "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; " +
      `script-src 'self' '${HASH_A}' '${HASH_B}'; frame-ancestors 'self'`;
    const byDefault = renderEdgeSiteBlock(descriptor(), TEST_ZONES, limits, themeCsp);
    const explicit = renderEdgeSiteBlock(
      descriptor(),
      TEST_ZONES,
      limits,
      themeCsp,
      PAYMENTS_CSP_NONE
    );
    expect(byDefault.contentSecurityPolicy).toBe(before);
    expect(explicit.contentSecurityPolicy).toBe(before);
    expect(httpsOriginsOf(before)).toEqual([]);
  });

  it('stripe renders exactly the measured origins into script-src and frame-src, and nothing else', () => {
    const edge = renderEdgeSiteBlock(descriptor(), TEST_ZONES, limits, themeCsp, {
      kind: 'stripe',
    });
    expect(edge.contentSecurityPolicyMode).toBe('enforcing');
    expect(edge.contentSecurityPolicy).toBe(
      "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; " +
        `script-src 'self' '${HASH_A}' '${HASH_B}' https://js.stripe.com; ` +
        "frame-src 'self' https://js.stripe.com; frame-ancestors 'self'"
    );
    const directives = directivesOf(edge.contentSecurityPolicy);
    // The only https origin anywhere in the policy is Stripe's measured one.
    expect(httpsOriginsOf(edge.contentSecurityPolicy)).toEqual([
      'https://js.stripe.com',
      'https://js.stripe.com',
    ]);
    // No directive widened beyond what was measured: no connect-src, no
    // wildcard, no scheme source, and no new unsafe-inline or unsafe-eval.
    expect(directives.has('connect-src')).toBe(false);
    expect(directives.get('script-src')).not.toContain("'unsafe-inline'");
    expect(directives.get('script-src')).not.toContain("'unsafe-eval'");
    expect(directives.get('img-src')).toEqual(["'self'", 'data:', 'https:']);
    expect(directives.get('default-src')).toEqual(["'self'"]);
    for (const tokens of directives.values()) {
      expect(tokens.filter((token) => token.includes('*'))).toEqual([]);
    }
  });

  it('keeps report-only for an unavailable theme set even with the allowance', () => {
    const stripe: PaymentsCsp = { kind: 'stripe' };
    const edge = renderEdgeSiteBlock(
      descriptor(),
      TEST_ZONES,
      limits,
      THEME_CSP_UNAVAILABLE,
      stripe
    );
    expect(edge.contentSecurityPolicyMode).toBe('report-only');
    expect(directivesOf(edge.contentSecurityPolicy).get('script-src')).toEqual([
      "'self'",
      'https://js.stripe.com',
    ]);
  });

  it('the committed allowlist is exactly the measured set', () => {
    expect(stripeOrigins()).toEqual(MEASURED_STRIPE_ORIGINS);
    expect(paymentsOrigins.generatedBy).toBe('csp/derive/derive-payment-origins.mjs');
  });

  it('renders connect-src (beside self) only when the allowlist carries a connect origin', () => {
    const edge = renderEdgeSiteBlock(descriptor(), TEST_ZONES, limits, themeCsp, {
      kind: 'stripe',
    });
    expect(directivesOf(edge.contentSecurityPolicy).has('connect-src')).toBe(false);
    // The renderer is generic over the three directives: a re-measurement
    // that finds a connect origin renders it with no code change.
    const widened = stripeOrigins({
      ...MEASURED_STRIPE_ORIGINS,
      'connect-src': ['https://api.stripe.com'],
    });
    expect(widened['connect-src']).toEqual(['https://api.stripe.com']);
  });
});

describe('validatePaymentOrigin — what the allowlist may carry', () => {
  it('accepts a bare https origin on a Stripe-owned domain', () => {
    expect(validatePaymentOrigin('https://js.stripe.com')).toBe('https://js.stripe.com');
    expect(validatePaymentOrigin('https://m.stripe.network')).toBe('https://m.stripe.network');
    expect(validatePaymentOrigin('https://stripe.com')).toBe('https://stripe.com');
  });

  it.each([
    ['a wildcard', 'https://*.stripe.com'],
    ['a bare star', '*'],
    ['a scheme source', 'https:'],
    ['plain http', 'http://js.stripe.com'],
    ['a path', 'https://js.stripe.com/v3/'],
    ['a port', 'https://js.stripe.com:8443'],
    ['a third-party host', 'https://cdn.example.test'],
    ['a lookalike suffix', 'https://js.stripe.com.example.test'],
    ['a lookalike prefix', 'https://notstripe.com'],
    ['a userinfo trick', 'https://js.stripe.com@example.test'],
    ['CSP syntax', "https://js.stripe.com; script-src 'unsafe-inline'"],
    ['a quoted keyword', "'unsafe-inline'"],
    ['an empty string', ''],
  ])('refuses %s', (_label, value) => {
    expect(() => validatePaymentOrigin(value)).toThrow(FieldValidationError);
  });

  it('stripeOrigins refuses a hand-edited file that names a third party', () => {
    expect(() =>
      stripeOrigins({ 'script-src': ['https://js.stripe.com', 'https://cdn.example.test'] })
    ).toThrow(FieldValidationError);
  });
});

describe('FAIL-SOFT CSP — source-mutation sabotage', () => {
  it('a payments allowance that never reaches the header is caught; the real module renders it', async () => {
    const descriptor = validate(entryTenantDescriptor(), TEST_ZONES);
    const limits = uploadLimits();
    const themeCsp: ThemeCsp = { kind: 'computed', hashes: [HASH_A, HASH_B] };

    // RED: the allowance function returns its base untouched, so a paid
    // site's script-src and frame-src carry no Stripe origin.
    const sabotaged = await importSabotaged<{ renderEdgeSiteBlock: typeof RenderEdgeSiteBlockFn }>(
      'edge.ts',
      (source) => {
        const target = ": `${base} ${stripe[directive].join(' ')}`;";
        if (!source.includes(target)) {
          throw new Error(
            'sabotage target string not found in edge.ts -- update the mutation to match the current source'
          );
        }
        return source.replace(target, ': base;');
      }
    );
    const sabotagedEdge = sabotaged.renderEdgeSiteBlock(descriptor, TEST_ZONES, limits, themeCsp, {
      kind: 'stripe',
    });
    expect(httpsOriginsOf(sabotagedEdge.contentSecurityPolicy)).toEqual([]);

    // GREEN: the real module renders them.
    const real = renderEdgeSiteBlock(descriptor, TEST_ZONES, limits, themeCsp, { kind: 'stripe' });
    expect(httpsOriginsOf(real.contentSecurityPolicy)).toEqual([
      'https://js.stripe.com',
      'https://js.stripe.com',
    ]);
  });

  it('a stray origin in the allowlist is caught by the exact-set check; the real file is not', async () => {
    const descriptor = validate(entryTenantDescriptor(), TEST_ZONES);
    const limits = uploadLimits();
    const themeCsp: ThemeCsp = { kind: 'computed', hashes: [HASH_A, HASH_B] };

    // RED: the allowlist gains one extra, still Stripe-owned, origin. The
    // origin-shape check accepts it (it IS a Stripe host), so only the
    // exact-set assertion can notice: the policy is wider than was measured.
    const sabotaged = await importSabotaged<{ renderEdgeSiteBlock: typeof RenderEdgeSiteBlockFn }>(
      'edge.ts',
      (source) => {
        const target =
          "import paymentsOrigins from './payments-origins.json' with { type: 'json' };";
        if (!source.includes(target)) {
          throw new Error(
            'sabotage target string not found in edge.ts -- update the mutation to match the current source'
          );
        }
        return source.replace(
          target,
          "const paymentsOrigins = { origins: { 'script-src': ['https://js.stripe.com', 'https://stray.stripe.com'], 'frame-src': ['https://js.stripe.com'], 'connect-src': [] as string[] } };"
        );
      }
    );
    const sabotagedEdge = sabotaged.renderEdgeSiteBlock(descriptor, TEST_ZONES, limits, themeCsp, {
      kind: 'stripe',
    });
    expect(httpsOriginsOf(sabotagedEdge.contentSecurityPolicy)).not.toEqual(
      httpsOriginsOf(
        renderEdgeSiteBlock(descriptor, TEST_ZONES, limits, themeCsp, { kind: 'stripe' })
          .contentSecurityPolicy
      )
    );
    expect(directivesOf(sabotagedEdge.contentSecurityPolicy).get('script-src')).not.toEqual([
      "'self'",
      `'${HASH_A}'`,
      `'${HASH_B}'`,
      'https://js.stripe.com',
    ]);

    // GREEN: the real file renders exactly the measured script-src.
    const real = renderEdgeSiteBlock(descriptor, TEST_ZONES, limits, themeCsp, { kind: 'stripe' });
    expect(directivesOf(real.contentSecurityPolicy).get('script-src')).toEqual([
      "'self'",
      `'${HASH_A}'`,
      `'${HASH_B}'`,
      'https://js.stripe.com',
    ]);
  });

  it('an origin-shape check that accepts anything is caught; the real module refuses a third party', async () => {
    // RED: the validator is dropped from the allowlist path, so a hand-edited
    // file naming a third party would flow straight into script-src.
    const sabotaged = await importSabotaged<{ stripeOrigins: typeof stripeOrigins }>(
      'edge.ts',
      (source) => {
        const target =
          'out[directive] = list.map((origin) => validatePaymentOrigin(origin, `payments.${directive}`));';
        if (!source.includes(target)) {
          throw new Error(
            'sabotage target string not found in edge.ts -- update the mutation to match the current source'
          );
        }
        return source.replace(target, 'out[directive] = list;');
      }
    );
    expect(
      sabotaged.stripeOrigins({ 'script-src': ['https://cdn.example.test'] })['script-src']
    ).toEqual(['https://cdn.example.test']);

    // GREEN: the real module refuses it.
    expect(() => stripeOrigins({ 'script-src': ['https://cdn.example.test'] })).toThrow(
      FieldValidationError
    );
  });

  it('a contentSecurityPolicy() that always reports "enforcing" is caught; the real module is not', async () => {
    const descriptor = validate(entryTenantDescriptor(), TEST_ZONES);
    const limits = uploadLimits();

    // RED: mutate edge.ts's actual mode computation so it always claims
    // 'enforcing', even for the unavailable/default case -- the exact
    // regression LLD-5's own "Done means" calls out: an enforcing policy
    // must never be guessed.
    const sabotaged = await importSabotaged<{ renderEdgeSiteBlock: typeof RenderEdgeSiteBlockFn }>(
      'edge.ts',
      (source) => {
        const target = "mode: themeCsp.kind === 'computed' ? 'enforcing' : 'report-only'";
        if (!source.includes(target)) {
          throw new Error(
            'sabotage target string not found in edge.ts -- update the mutation to match the current source'
          );
        }
        return source.replace(target, "mode: 'enforcing'");
      }
    );
    const sabotagedEdge = sabotaged.renderEdgeSiteBlock(descriptor, TEST_ZONES, limits);
    // RED: the sabotaged module claims an enforcing policy with no hash set
    // at all -- exactly the false claim LLD-5's fail-soft mark exists to
    // prevent.
    expect(sabotagedEdge.contentSecurityPolicyMode).toBe('enforcing');
    expect(sabotagedEdge.contentSecurityPolicy).not.toContain('sha256-');

    // GREEN: the real, unmutated module reports report-only when no hash
    // set was supplied.
    const { renderEdgeSiteBlock: realRenderEdgeSiteBlock } = await import('../src/edge.js');
    const realEdge = realRenderEdgeSiteBlock(descriptor, TEST_ZONES, limits);
    expect(realEdge.contentSecurityPolicyMode).toBe('report-only');
  });

  it('a script-src that omits the hash allowance is caught; the real module renders it', async () => {
    const descriptor = validate(entryTenantDescriptor(), TEST_ZONES);
    const limits = uploadLimits();
    const themeCsp: ThemeCsp = { kind: 'computed', hashes: [HASH_A, HASH_B] };

    // RED: mutate edge.ts so script-src never carries the theme's hash
    // allowance -- the same shape as row D of LLD-5's own spike (drop the
    // hashes and Ghost's own inline blocks are blocked too).
    const sabotaged = await importSabotaged<{ renderEdgeSiteBlock: typeof RenderEdgeSiteBlockFn }>(
      'edge.ts',
      (source) => {
        const target =
          "? `script-src 'self' ${themeCsp.hashes.map((hash) => `'${hash}'`).join(' ')}`";
        if (!source.includes(target)) {
          throw new Error(
            'sabotage target string not found in edge.ts -- update the mutation to match the current source'
          );
        }
        return source.replace(target, '? "script-src \'self\'"');
      }
    );
    const sabotagedEdge = sabotaged.renderEdgeSiteBlock(descriptor, TEST_ZONES, limits, themeCsp);
    // RED: a real, computed hash set was supplied but never reached the
    // header.
    expect(sabotagedEdge.contentSecurityPolicy).not.toContain('sha256-');

    // GREEN: the real, unmutated module renders both hashes into script-src.
    const { renderEdgeSiteBlock: realRenderEdgeSiteBlock } = await import('../src/edge.js');
    const realEdge = realRenderEdgeSiteBlock(descriptor, TEST_ZONES, limits, themeCsp);
    expect(realEdge.contentSecurityPolicy).toContain(`'${HASH_A}'`);
    expect(realEdge.contentSecurityPolicy).toContain(`'${HASH_B}'`);
  });
});
