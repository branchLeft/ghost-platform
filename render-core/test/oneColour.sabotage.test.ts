/**
 * Source-mutation sabotage for the one-running-colour control: a mutated copy
 * of the real `compose.ts` that renders both colours even when an active
 * colour is given must be caught by the same assertions that pass against the
 * real module.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { Port, PrivateIpV4, Slug, TenantUid } from '../src/brand.js';
import type { renderComposeStack as RenderComposeStackFn } from '../src/compose.js';
import { renderComposeStack } from '../src/compose.js';
import { cleanupSabotageTmp, importSabotaged } from './helpers/sourceSabotage.js';

afterAll(() => {
  cleanupSabotageTmp();
});

const args = {
  kind: 'tenant' as const,
  slug: 'acme' as Slug,
  uid: 30123 as TenantUid,
  appHostPrivateIp: '10.20.1.50' as PrivateIpV4,
  ports: { a: 3101 as Port, b: 3102 as Port, health: 3103 as Port },
  environment: { url: 'https://blog.acme.example' },
  limits: {
    tmpfsSize: '128m',
    themeCompressedBytes: 1,
    themeEntryUncompressedBytes: 1,
    themeTotalUncompressedBytes: 1,
    edgeRequestBodyMaxSize: '64MiB',
    memoryLimit: '640m',
  },
  caps: { cpus: '1.0', cpuShares: 512, pidsLimit: 256, nofile: 4096 },
  dataMount: null,
  mailNetwork: null,
  activeColour: 'a' as const,
};

function serviceNames(yaml: string): string[] {
  return [...yaml.matchAll(/^ {2}(ghost-[ab]):$/gm)].map((m) => m[1]!);
}

describe('ONE-RUNNING-COLOUR — source-mutation sabotage', () => {
  it('a compose.ts that ignores activeColour renders both services; the real module renders one', async () => {
    // RED: mutate compose.ts's actual colour selection so an active colour
    // no longer narrows the document.
    const sabotaged = await importSabotaged<{ renderComposeStack: typeof RenderComposeStackFn }>(
      'compose.ts',
      (source) => {
        const target = 'return [activeColour];';
        if (!source.includes(target)) {
          throw new Error(
            'sabotage target string not found in compose.ts -- update the mutation to match the current source'
          );
        }
        return source.replace(target, 'return COLOURS;');
      }
    );
    expect(serviceNames(sabotaged.renderComposeStack(args))).toEqual(['ghost-a', 'ghost-b']);

    // GREEN: the real, unmutated module renders exactly one service.
    expect(serviceNames(renderComposeStack(args))).toEqual(['ghost-a']);
  });
});
