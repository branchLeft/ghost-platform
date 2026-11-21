/**
 * The variants `tenantEnvironment()` is rendered over for the contract test: every fixture kind,
 * with break-glass off and on, both widget sources, the third-party block on and off, and each
 * safety combination. Its union of keys is the set of environment names render-core can produce,
 * which `contract/tenant-entry.json` records and `contract.test.ts` holds equal to.
 */
import type { SafetySpec, TenantDescriptor } from '../../src/descriptor.js';
import { tenantEnvironment, type WidgetSource } from '../../src/environment.js';
import { secretsEnvPath } from '../../src/naming.js';
import { uploadLimits } from '../../src/runtime.js';
import {
  breakGlassEnabled,
  demoDescriptor,
  entryTenantDescriptor,
  professionalTenantDescriptor,
  tenantDescriptor,
  TEST_ZONES,
} from '../fixtures.js';

const LIMITS = uploadLimits();

const SAFETY_VARIANTS: readonly SafetySpec[] = [
  { near: true, exact: true },
  { near: true, exact: false },
  { near: false, exact: true },
  { near: false, exact: false },
];

const WIDGET_VARIANTS: readonly WidgetSource[] = ['cdn', 'own-origin'];

/** Every environment name `tenantEnvironment()` produces across the matrix, sorted. */
export function environmentNamesAcrossMatrix(): string[] {
  const names = new Set<string>();
  const bases = [
    demoDescriptor(),
    tenantDescriptor(),
    entryTenantDescriptor(),
    professionalTenantDescriptor(),
  ];
  for (const base of bases) {
    const breakGlasses = [base.breakGlass, breakGlassEnabled(base.slug)];
    for (const breakGlass of breakGlasses) {
      for (const safety of SAFETY_VARIANTS) {
        const descriptor: Pick<
          TenantDescriptor,
          | 'slug'
          | 'uid'
          | 'kind'
          | 'siteUrl'
          | 'database'
          | 'media'
          | 'transport'
          | 'mail'
          | 'safety'
          | 'limits'
          | 'breakGlass'
        > = { ...base, safety, breakGlass };
        for (const widgets of WIDGET_VARIANTS) {
          for (const block of [true, false]) {
            const rendered = tenantEnvironment(
              descriptor,
              LIMITS,
              secretsEnvPath(base.slug),
              TEST_ZONES,
              widgets,
              block
            );
            for (const key of Object.keys(rendered)) names.add(key);
          }
        }
      }
    }
  }
  return [...names].sort();
}

/** The four fixture descriptors' resource caps, by fixture name. */
export function fixtureResourceCaps(): Record<string, TenantDescriptor['caps']> {
  return {
    demo: demoDescriptor().caps,
    tenant: tenantDescriptor().caps,
    entry: entryTenantDescriptor().caps,
    professional: professionalTenantDescriptor().caps,
  };
}
