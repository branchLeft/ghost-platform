import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_BODY_CEILING_MIB } from '../src/body.js';

// The platform's default upload ceiling is declared in the tenant runtime
// module. It is read as text, so this package imports nothing from there.
const RUNTIME = fileURLToPath(new URL('../../../infra/tenant/runtime.ts', import.meta.url));

describe('default body ceiling', () => {
  it('equals the tenant runtime default upload ceiling', () => {
    const text = readFileSync(RUNTIME, 'utf8');
    const match = /export const DEFAULT_UPLOAD_CEILING_MIB = (\d+);/.exec(text);
    expect(match, 'DEFAULT_UPLOAD_CEILING_MIB not found in infra/tenant/runtime.ts').not.toBeNull();
    expect(DEFAULT_BODY_CEILING_MIB).toBe(Number(match?.[1]));
  });
});
