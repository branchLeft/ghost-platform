import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import type { Demo } from '../generated/index.js';
import { zDemoState, zUuid } from '../generated/zod.gen.js';

/**
 * The register of demos: which tenants exist and where each one's demo stands.
 * The owner's tooling writes it and the service only reads it, so it says what a
 * tenant's demo is until that tenant is promoted. It holds tenant identity, so
 * it is never in the repository; the deployment places it.
 */

const zEntry = z.strictObject({
  tenantId: zUuid,
  demoId: zUuid,
  address: z.string().min(1).nullable(),
  state: zDemoState,
  expiresAt: z.iso.datetime().nullable(),
});
const zRegister = z.strictObject({ demos: z.array(zEntry) });

export interface DemoRegisterEntry {
  readonly tenantId: string;
  readonly demo: Demo;
}

export class DemoRegisterError extends Error {
  constructor(readonly problem: string) {
    super(`the demo register cannot be used: ${problem}`);
    this.name = 'DemoRegisterError';
  }
}

const GROUP_OR_OTHER_WRITE = 0o022;

function entries(text: string): readonly DemoRegisterEntry[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new DemoRegisterError('it is not JSON');
  }
  const parsed = zRegister.safeParse(json);
  if (!parsed.success) throw new DemoRegisterError('it does not have the shape of a register');
  const seen = new Set<string>();
  for (const entry of parsed.data.demos) {
    if (seen.has(entry.tenantId)) throw new DemoRegisterError('a tenant appears twice');
    seen.add(entry.tenantId);
  }
  return parsed.data.demos.map((entry) => ({
    tenantId: entry.tenantId,
    demo: {
      demo_id: entry.demoId,
      address: entry.address,
      state: entry.state,
      expires_at: entry.expiresAt,
    },
  }));
}

/**
 * Reads the register from the opened file, so nothing can be swapped in after
 * the check. A link, anything but a regular file and a file another user could
 * write are refused: whoever can write it decides which tenants exist. Another
 * owner is allowed, because the file is best placed where this process cannot
 * write it at all.
 */
export function readDemoRegister(path: string): readonly DemoRegisterEntry[] {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new DemoRegisterError('it cannot be opened');
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) throw new DemoRegisterError('it is not a regular file');
    if ((info.mode & GROUP_OR_OTHER_WRITE) !== 0) {
      throw new DemoRegisterError('other users can write it');
    }
    return entries(readFileSync(fd, 'utf8'));
  } finally {
    closeSync(fd);
  }
}
