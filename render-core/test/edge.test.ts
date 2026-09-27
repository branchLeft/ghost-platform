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
  renderEdgeSiteBlock,
  THEME_CSP_UNAVAILABLE,
  validateScriptHash,
  type ScriptHash,
  type ThemeCsp,
} from '../src/edge.js';
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

describe('FAIL-SOFT CSP — source-mutation sabotage', () => {
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
          "themeCsp.kind === 'computed' && themeCsp.hashes.length > 0\n      ? `script-src 'self' ${themeCsp.hashes.map((hash) => `'${hash}'`).join(' ')}`\n      : \"script-src 'self'\";";
        if (!source.includes(target)) {
          throw new Error(
            'sabotage target string not found in edge.ts -- update the mutation to match the current source'
          );
        }
        return source.replace(target, '"script-src \'self\'";');
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
