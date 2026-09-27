import { describe, expect, it } from 'vitest';
import type { SlotName } from '@branchleft/ghost-platform-render-core';
import { createFailClosedEmailBatchChecker } from '../../src/emailBatchChecker.js';

describe('createFailClosedEmailBatchChecker', () => {
  it('always reports a submitting batch -- the safe default when no real checker is configured', async () => {
    const checker = createFailClosedEmailBatchChecker();
    expect(await checker.hasSubmittingBatch('0' as SlotName)).toBe(true);
    expect(await checker.hasSubmittingBatch('6' as SlotName)).toBe(true);
  });
});
