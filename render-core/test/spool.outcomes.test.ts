/**
 * `SHIM_DRAIN_OUTCOMES` in the spool service environment: opt-in, rendered as
 * the exact string the shim compares against, and absent (byte-identical to
 * every earlier release) for a host with no Sweego route. See
 * ../src/spool.md#the-outcomes-route.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { FieldValidationError } from '../src/brand.js';
import type { DigestPinnedRef, Port, TenantUid } from '../src/brand.js';
import type { TenantDescriptor } from '../src/descriptor.js';
import {
  MAIL_SPOOL_DRAIN_OUTCOMES_KEY,
  MAIL_SPOOL_DRAIN_OUTCOMES_VALUE,
  MAIL_SPOOL_SERVICE,
  assertSpoolPosture,
  mailSpoolDocument,
  mailSpoolNeedsDrainOutcomes,
  renderMailSpoolStack,
  type MailSpoolStackArgs,
} from '../src/spool.js';
import type { YamlValue } from '../src/yaml.js';
import {
  demoDescriptor,
  entryTenantDescriptor,
  professionalTenantDescriptor,
  tenantDescriptor,
} from './fixtures.js';
import { cleanupSabotageTmp, importSabotaged } from './helpers/sourceSabotage.js';

afterAll(() => {
  cleanupSabotageTmp();
});

const here = dirname(fileURLToPath(import.meta.url));
const GOLDEN = readFileSync(join(here, 'golden', 'mail-spool-compose.demo1.yml'), 'utf-8');
const SPOOL_IMAGE_LINE = /^ {4}image: '([^']+)'$/m;
const OUTCOMES_LINE = `      ${MAIL_SPOOL_DRAIN_OUTCOMES_KEY}: '${MAIL_SPOOL_DRAIN_OUTCOMES_VALUE}'`;

const IMAGE = SPOOL_IMAGE_LINE.exec(GOLDEN)?.[1] as DigestPinnedRef;
const DRAIN_PORT = 8095 as Port;
const UIDS = [30001, 30002, 30003, 30004, 30005, 30006, 30007] as TenantUid[];

type Rec = Record<string, YamlValue>;

function args(extra: Partial<MailSpoolStackArgs> = {}): MailSpoolStackArgs {
  return { image: IMAGE, uids: UIDS, drainPort: DRAIN_PORT, ...extra };
}

function environmentOf(document: Rec): Rec {
  return ((document.services as Rec)[MAIL_SPOOL_SERVICE] as Rec).environment as Rec;
}

function withRoute(descriptor: TenantDescriptor, route: unknown): TenantDescriptor {
  return { ...descriptor, mail: { ...descriptor.mail, route } } as unknown as TenantDescriptor;
}

const SWEEGO = { primary: 'sweego', sweegoAllowance: 100 };

describe('the golden this file diffs against', () => {
  it('is the real demo1 spool, so a diff against it means something', () => {
    expect(IMAGE).toMatch(/^ghcr\.io\/branchleft\/mailgun-shim@sha256:[0-9a-f]{64}$/);
    expect(GOLDEN).not.toContain('SHIM_DRAIN_OUTCOMES');
    expect(renderMailSpoolStack(args())).toBe(GOLDEN);
  });
});

describe('mailSpoolNeedsDrainOutcomes()', () => {
  it.each([
    ['no mail specs at all', [], false],
    ['a demo with no route', [demoDescriptor().mail], false],
    ['a tenant with no route', [entryTenantDescriptor().mail], false],
    ['a plain tenant', [tenantDescriptor().mail], false],
    [
      'a tenant on mx1',
      [withRoute(professionalTenantDescriptor(), { primary: 'mx1' }).mail],
      false,
    ],
    ['a tenant on sweego', [withRoute(professionalTenantDescriptor(), SWEEGO).mail], true],
    [
      'one sweego tenant among route-less ones',
      [
        demoDescriptor().mail,
        withRoute(professionalTenantDescriptor(), SWEEGO).mail,
        entryTenantDescriptor().mail,
      ],
      true,
    ],
  ] as const)('%s -> %s', (_label, mails, expected) => {
    expect(mailSpoolNeedsDrainOutcomes(mails)).toBe(expected);
  });
});

describe('a host with no Sweego route renders a byte-identical spool', () => {
  it('CONTROL: drainOutcomes absent is the committed golden, byte for byte', () => {
    expect(renderMailSpoolStack(args())).toBe(GOLDEN);
  });

  it('CONTROL: drainOutcomes false is the committed golden, byte for byte', () => {
    expect(renderMailSpoolStack(args({ drainOutcomes: false }))).toBe(GOLDEN);
  });

  it.each([
    ['a demo', demoDescriptor()],
    ['an entry tenant', entryTenantDescriptor()],
    ['a tenant on mx1', withRoute(professionalTenantDescriptor(), { primary: 'mx1' })],
  ] as const)(
    'CONTROL: the helper over %s renders the golden byte for byte',
    (_label, descriptor) => {
      const drainOutcomes = mailSpoolNeedsDrainOutcomes([descriptor.mail]);
      expect(renderMailSpoolStack(args({ drainOutcomes }))).toBe(GOLDEN);
    }
  );
});

describe('a host with a Sweego route renders the variable, and only that line changes', () => {
  const drainOutcomes = mailSpoolNeedsDrainOutcomes([
    withRoute(professionalTenantDescriptor(), SWEEGO).mail,
  ]);
  const renderedNow = () => renderMailSpoolStack(args({ drainOutcomes }));

  it('adds exactly one line to the golden and removes none', () => {
    const before = GOLDEN.split('\n');
    const after = renderedNow().split('\n');
    expect(after).toHaveLength(before.length + 1);
    expect(after.filter((line) => !before.includes(line))).toEqual([OUTCOMES_LINE]);
    expect(before.filter((line) => !after.includes(line))).toEqual([]);
    expect(after.indexOf(OUTCOMES_LINE)).toBe(
      after.indexOf("      SHIM_DRAIN_HOST: '10.231.200.2'") + 1
    );
  });

  it("renders the string 'true' the shim compares against, quoted, never a YAML boolean", () => {
    expect(renderedNow()).toContain(`\n${OUTCOMES_LINE}\n`);
    expect(renderedNow()).not.toMatch(/SHIM_DRAIN_OUTCOMES: true/);
    expect(environmentOf(mailSpoolDocument(args({ drainOutcomes }))).SHIM_DRAIN_OUTCOMES).toBe(
      'true'
    );
  });

  it("round-trips through the shim's own test: the quoted scalar is the string 'true'", () => {
    const value = /SHIM_DRAIN_OUTCOMES: '([^']*)'/.exec(renderedNow())?.[1];
    expect(value === 'true').toBe(true);
  });

  it('is refused at render time when the caller passes a non-boolean', () => {
    const bad = args({ drainOutcomes: 'true' as unknown as boolean });
    expect(() => renderMailSpoolStack(bad)).toThrow(FieldValidationError);
  });
});

describe('assertSpoolPosture() on SHIM_DRAIN_OUTCOMES', () => {
  function okDocument(): Rec {
    return structuredClone(mailSpoolDocument(args({ drainOutcomes: true }))) as Rec;
  }

  it('GREEN: the real file passes, with and without the variable', () => {
    expect(() => assertSpoolPosture(okDocument(), DRAIN_PORT, true)).not.toThrow();
    expect(() => assertSpoolPosture(okDocument(), DRAIN_PORT)).not.toThrow();
    expect(() =>
      assertSpoolPosture(structuredClone(mailSpoolDocument(args())) as Rec, DRAIN_PORT, false)
    ).not.toThrow();
  });

  it.each([
    ["'True'", 'True'],
    ["'TRUE'", 'TRUE'],
    ["'1'", '1'],
    ["'yes'", 'yes'],
    ["''", ''],
    ["' true'", ' true'],
    ['the boolean true (renders unquoted, not the string)', true],
    ['the boolean false', false],
    ['the number 1', 1],
  ] as const)('RED: refuses %s', (_label, value) => {
    const document = okDocument();
    environmentOf(document).SHIM_DRAIN_OUTCOMES = value;
    expect(() => assertSpoolPosture(document, DRAIN_PORT)).toThrow(
      /SHIM_DRAIN_OUTCOMES must be the string "true" exactly/
    );
    expect(() => assertSpoolPosture(document, DRAIN_PORT, true)).toThrow(
      /SHIM_DRAIN_OUTCOMES must be the string "true" exactly/
    );
  });

  it('RED: refuses a file that lost the variable when the host asked for it', () => {
    const document = okDocument();
    delete environmentOf(document).SHIM_DRAIN_OUTCOMES;
    expect(() => assertSpoolPosture(document, DRAIN_PORT, true)).toThrow(
      /must set SHIM_DRAIN_OUTCOMES/
    );
  });

  it('RED: refuses a file that carries the variable when the host did not ask for it', () => {
    expect(() => assertSpoolPosture(okDocument(), DRAIN_PORT, false)).toThrow(
      /must not set SHIM_DRAIN_OUTCOMES/
    );
  });
});

describe('source-mutation sabotage of the renderer', () => {
  async function sabotaged(
    mutate: (source: string) => string
  ): Promise<typeof renderMailSpoolStack> {
    const module = await importSabotaged<{ renderMailSpoolStack: typeof renderMailSpoolStack }>(
      'spool.ts',
      mutate
    );
    return module.renderMailSpoolStack;
  }

  const OPT_IN = '...(args.drainOutcomes === true';

  it('RED: a renderer that drops the variable is refused at render time; GREEN: the real one renders it', async () => {
    const broken = await sabotaged((source) => {
      if (!source.includes(OPT_IN)) throw new Error('sabotage target not found in spool.ts');
      return source.replace(OPT_IN, '...(false');
    });
    expect(() => broken(args({ drainOutcomes: true }))).toThrow(/must set SHIM_DRAIN_OUTCOMES/);
    expect(renderMailSpoolStack(args({ drainOutcomes: true }))).toContain(OUTCOMES_LINE);
  });

  it('RED: a renderer that always renders the variable is refused for a host that did not ask', async () => {
    const broken = await sabotaged((source) => {
      if (!source.includes(OPT_IN)) throw new Error('sabotage target not found in spool.ts');
      return source.replace(OPT_IN, '...(true');
    });
    expect(() => broken(args())).toThrow(/must not set SHIM_DRAIN_OUTCOMES/);
  });

  it('RED: a renderer that writes a YAML boolean is refused; GREEN: the real one writes the string', async () => {
    const broken = await sabotaged((source) => {
      const target = '[MAIL_SPOOL_DRAIN_OUTCOMES_KEY]: MAIL_SPOOL_DRAIN_OUTCOMES_VALUE';
      if (!source.includes(target)) throw new Error('sabotage target not found in spool.ts');
      return source.replace(target, '[MAIL_SPOOL_DRAIN_OUTCOMES_KEY]: true as unknown as string');
    });
    expect(() => broken(args({ drainOutcomes: true }))).toThrow(
      /SHIM_DRAIN_OUTCOMES must be the string "true" exactly/
    );
  });

  it("RED: a renderer whose value is not exactly 'true' is refused", async () => {
    const broken = await sabotaged((source) => {
      const target = "export const MAIL_SPOOL_DRAIN_OUTCOMES_VALUE = 'true';";
      if (!source.includes(target)) throw new Error('sabotage target not found in spool.ts');
      return source.replace(target, "export const MAIL_SPOOL_DRAIN_OUTCOMES_VALUE = 'True';");
    });
    // The constant and the check share the sabotaged module, so they agree on
    // 'True'; the pinned literal in this test is what catches the drift.
    expect(broken(args({ drainOutcomes: true }))).not.toContain(OUTCOMES_LINE);
    expect(MAIL_SPOOL_DRAIN_OUTCOMES_VALUE).toBe('true');
  });
});
