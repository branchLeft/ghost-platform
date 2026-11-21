/**
 * The variants `tenantEnvironment()` is rendered over for the contract test. Each render is
 * labelled with the axis values it was built from, so a missing name is reported against the
 * branch that produced it. Every axis `tenantEnvironment()` branches on is varied here:
 *
 * - base descriptor (kind; `stripe` branch on demo): demo, tenant, entry, professional, gateway
 * - database (`databaseEnvironment`): sqlite, mysql
 * - media (`mediaEnvironment`, `gatewayMediaEnvironment`, the storage credential lines): local, s3,
 *   gateway (gateway base only; a gateway's shard and folder are valid for its own slug alone)
 * - safety (`isScanningRequired`, `verdictEnvironment`): near/exact combinations, verdict source
 *   absent, production, and production with the host-inbound listener
 * - transport (`transportEnvironment`, the mail password line): queue, smtp
 * - mail enabled (`transportEnvironment`, `bulkMailEnvironment`, `hostLimits`): true, false
 * - break-glass (`breakGlassEnvironment`): disabled, enabled
 * - limits (`hostLimitsEnvironment`): uncapped, capped
 * - widgets (`widgetEnvironment`): cdn, own-origin with and without the third-party block
 */
import type { Port } from '../../src/brand.js';
import type {
  MediaSpec,
  SafetySpec,
  TenantDescriptor,
  TransportSpec,
} from '../../src/descriptor.js';
import { tenantEnvironment, type WidgetSource } from '../../src/environment.js';
import { databaseAndUserName, secretsEnvPath } from '../../src/naming.js';
import { mediaBucketName } from '../../src/media.js';
import { uploadLimits } from '../../src/runtime.js';
import {
  breakGlassEnabled,
  demoDescriptor,
  entryTenantDescriptor,
  gatewayTenantDescriptor,
  professionalTenantDescriptor,
  tenantDescriptor,
  TEST_GATEWAY_ZONES,
} from '../fixtures.js';

const LIMITS = uploadLimits();

type Rendered = Record<string, string | number | boolean>;

/** One render: the axis values it was built from, and every name it produced. */
export interface MatrixRender {
  readonly label: string;
  readonly names: readonly string[];
}

function baseDescriptors(): TenantDescriptor[] {
  return [
    demoDescriptor(),
    tenantDescriptor(),
    entryTenantDescriptor(),
    professionalTenantDescriptor(),
    gatewayTenantDescriptor(),
  ];
}

function databaseVariants(slug: string): TenantDescriptor['database'][] {
  const name = databaseAndUserName(slug as TenantDescriptor['slug']);
  return [
    { kind: 'sqlite', path: `/data/${slug}/ghost.db` },
    { kind: 'mysql', host: 'db-t1.internal', port: 3306 as Port, name, user: name },
  ];
}

function mediaVariants(base: TenantDescriptor): Array<[string, MediaSpec]> {
  const variants: Array<[string, MediaSpec]> = [
    ['local', { kind: 'local', path: `/data/${base.slug}/content`, resize: false, srcsets: false }],
    [
      's3',
      {
        kind: 's3',
        endpoint: 'https://s3.endpoint.example',
        region: 'eu',
        bucket: mediaBucketName(base.slug),
        resize: true,
        srcsets: true,
      },
    ],
  ];
  if (base.media.kind === 'gateway') {
    variants.push(['gateway', base.media]);
  }
  return variants;
}

function transportVariants(slug: string): Array<[string, TransportSpec]> {
  return [
    ['queue', { kind: 'queue', path: `/var/spool/${slug}` }],
    ['smtp', { kind: 'smtp', host: 'mx.internal', port: 587 as Port, user: slug }],
  ];
}

const SAFETY_VARIANTS: Array<[string, SafetySpec]> = [
  ['near+exact', { near: true, exact: true }],
  ['near', { near: true, exact: false }],
  ['exact', { near: false, exact: true }],
  ['unscanned', { near: false, exact: false }],
  ['near+exact,verdict=production', { near: true, exact: true, verdictSource: 'production' }],
  [
    'near+exact,verdict=production,inbound',
    {
      near: true,
      exact: true,
      verdictSource: 'production',
      inbound: { port: 8443, tls: 'pinned-private' },
    },
  ],
];

const WIDGET_VARIANTS: Array<[string, WidgetSource, boolean]> = [
  ['cdn', 'cdn', true],
  ['own-origin,block', 'own-origin', true],
  ['own-origin,no-block', 'own-origin', false],
];

/**
 * Every render across the matrix. Bases are the fixture descriptors; each is crossed with every
 * value of every axis `tenantEnvironment()` branches on.
 */
export function matrixRenders(): MatrixRender[] {
  const renders: MatrixRender[] = [];
  for (const base of baseDescriptors()) {
    const slug = base.slug as string;
    for (const [dbLabel, database] of databaseVariants(slug).map(
      (d, i) => [i === 0 ? 'sqlite' : 'mysql', d] as const
    )) {
      for (const [mediaLabel, media] of mediaVariants(base)) {
        for (const [transportLabel, transport] of transportVariants(slug)) {
          for (const mailEnabled of [true, false]) {
            for (const [safetyLabel, safety] of SAFETY_VARIANTS) {
              for (const [bgLabel, breakGlass] of [
                ['breakGlass=disabled', base.breakGlass],
                ['breakGlass=enabled', breakGlassEnabled(slug)],
              ] as const) {
                for (const [limitsLabel, limits] of [
                  ['uncapped', { membersCap: null, staffCap: null }],
                  ['capped', { membersCap: 50, staffCap: 1 }],
                ] as const) {
                  for (const [widgetLabel, widgets, block] of WIDGET_VARIANTS) {
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
                    > = {
                      ...base,
                      database,
                      media,
                      transport,
                      mail: { ...base.mail, enabled: mailEnabled },
                      safety,
                      limits,
                      breakGlass,
                    };
                    const rendered: Rendered = tenantEnvironment(
                      descriptor,
                      LIMITS,
                      secretsEnvPath(base.slug),
                      TEST_GATEWAY_ZONES,
                      widgets,
                      block
                    );
                    renders.push({
                      label: [
                        `kind=${base.kind}`,
                        `database=${dbLabel}`,
                        `media=${mediaLabel}`,
                        `transport=${transportLabel}`,
                        `mail=${mailEnabled}`,
                        `safety=${safetyLabel}`,
                        bgLabel,
                        limitsLabel,
                        widgetLabel,
                      ].join(' '),
                      names: Object.keys(rendered),
                    });
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  return renders;
}

/** Every environment name across the matrix, sorted and de-duplicated. */
export function environmentNamesAcrossMatrix(): string[] {
  const names = new Set<string>();
  for (const render of matrixRenders()) {
    for (const name of render.names) names.add(name);
  }
  return [...names].sort();
}

/** The fixture descriptors' resource caps, by fixture name. */
export function fixtureResourceCaps(): Record<string, TenantDescriptor['caps']> {
  return {
    demo: demoDescriptor().caps,
    tenant: tenantDescriptor().caps,
    entry: entryTenantDescriptor().caps,
    professional: professionalTenantDescriptor().caps,
    gateway: gatewayTenantDescriptor().caps,
  };
}
