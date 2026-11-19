import { afterEach, describe, expect, it } from 'vitest';
import { render, type Artefact } from '@branchleft/ghost-platform-render-core';
import {
  composeNamesProductionVerdictSource,
  slotNamesProductionVerdictSource,
} from '../../src/verdictSourceReport.js';
import { makeTempDir } from '../../src/atomicFile.js';
import { demoDescriptor, TEST_ZONES } from '../helpers/fixtures.js';
import { startTestBroker, type TestBroker } from '../helpers/testBroker.js';
import type { SlotName } from '@branchleft/ghost-platform-render-core';

const FEATURES = ['images', 'media', 'files'] as const;

/** The real render-core artefacts for a demo: today they name no verdict source. */
function realRender(): readonly Artefact[] {
  return render(demoDescriptor(), TEST_ZONES);
}

/**
 * A test double for the wired production verdict source: the real render with
 * `verdictSource` set on the given features, written the way render-core
 * writes every other storage key. It stands in for the adapter story's render.
 */
function renderWith(value: string, features: readonly string[] = FEATURES): readonly Artefact[] {
  return realRender().map((artefact) => {
    if (artefact.path !== 'compose.yml') return artefact;
    const lines = artefact.content.split('\n').flatMap((line) => {
      const match = /^(\s*)storage__(\w+)__adapter:/.exec(line);
      const indent = match?.[1];
      const feature = match?.[2];
      return indent !== undefined && feature !== undefined && features.includes(feature)
        ? [line, `${indent}storage__${feature}__verdictSource: '${value}'`]
        : [line];
    });
    return { ...artefact, content: lines.join('\n') };
  });
}

function composeOf(artefacts: readonly Artefact[]): string {
  const compose = artefacts.find((a) => a.path === 'compose.yml');
  if (compose === undefined) throw new Error('no compose.yml rendered');
  return compose.content;
}

describe('composeNamesProductionVerdictSource', () => {
  it('is false for what render-core renders for a demo today (no verdict source)', () => {
    expect(composeNamesProductionVerdictSource(composeOf(realRender()))).toBe(false);
  });

  it('is true for the production value on every feature, on both colours', () => {
    const compose = composeOf(renderWith('production'));
    expect(compose.match(/verdictSource/g)).toHaveLength(6);
    expect(composeNamesProductionVerdictSource(compose)).toBe(true);
  });

  it('is false for the in-process fake, any other value and a case or space variant', () => {
    for (const value of [
      'in-process-fake',
      'Production',
      'production ',
      ' production',
      '',
      'prod',
    ]) {
      expect(composeNamesProductionVerdictSource(composeOf(renderWith(value)))).toBe(false);
    }
  });

  it('is false when any one feature is left out', () => {
    for (const left of FEATURES) {
      const some = FEATURES.filter((f) => f !== left);
      expect(composeNamesProductionVerdictSource(composeOf(renderWith('production', some)))).toBe(
        false
      );
    }
  });

  it('is false when one colour names production and the other does not', () => {
    const compose = composeOf(renderWith('production'));
    const first = compose.indexOf("storage__files__verdictSource: 'production'");
    const spoiled =
      compose.slice(0, first) + compose.slice(first).replace('production', 'in-process-fake');
    expect(composeNamesProductionVerdictSource(spoiled)).toBe(false);
  });

  it('is false for an empty file, a comment and a value that is not a scalar', () => {
    expect(composeNamesProductionVerdictSource('')).toBe(false);
    const commented = FEATURES.map((f) => `  # storage__${f}__verdictSource: 'production'`).join(
      '\n'
    );
    expect(composeNamesProductionVerdictSource(commented)).toBe(false);
    const flow = FEATURES.map((f) => `  storage__${f}__verdictSource: ['production']`).join('\n');
    expect(composeNamesProductionVerdictSource(flow)).toBe(false);
  });
});

describe('slotNamesProductionVerdictSource', () => {
  it('is false for a slot that was never rendered', async () => {
    const base = await makeTempDir('verdict-source-');
    expect(await slotNamesProductionVerdictSource(base, '0' as SlotName)).toBe(false);
  });
});

describe('GET /status reports productionVerdictSource from what was rendered', () => {
  let broker: TestBroker | undefined;

  afterEach(async () => {
    await broker?.close();
    broker = undefined;
  });

  async function statusAfterRendering(artefacts: readonly Artefact[] | undefined) {
    broker = await startTestBroker();
    if (artefacts !== undefined) {
      broker.renderer.artefacts = artefacts;
      const res = await broker.signedFetch('POST', '/reconcile', {
        slot: '0',
        descriptor: demoDescriptor(),
      });
      expect(res.status).toBe(200);
    }
    const res = await fetch(`${broker.baseUrl}/status/0`);
    expect(res.status).toBe(200);
    return (await res.json()) as { productionVerdictSource?: unknown };
  }

  it('is false before anything is rendered', async () => {
    expect((await statusAfterRendering(undefined)).productionVerdictSource).toBe(false);
  });

  it('is false for the real demo render, which names no verdict source', async () => {
    expect((await statusAfterRendering(realRender())).productionVerdictSource).toBe(false);
  });

  it('is false for the in-process fake', async () => {
    expect(
      (await statusAfterRendering(renderWith('in-process-fake'))).productionVerdictSource
    ).toBe(false);
  });

  it('is true once the render names the production source (verdict source test double)', async () => {
    expect((await statusAfterRendering(renderWith('production'))).productionVerdictSource).toBe(
      true
    );
  });
});
