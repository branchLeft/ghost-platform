import { chmod, symlink } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FileApprovalLedger,
  FileRegisterReader,
  TrustedFileError,
  readTrustedJson,
} from '../../src/index.js';
import { APPROVAL, ENTRY } from '../support/doubles.js';
import { Workdir } from '../support/workdir.js';

let work: Workdir;
beforeEach(async () => {
  work = await Workdir.create();
});
afterEach(async () => {
  await work.remove();
});

describe('readTrustedJson', () => {
  it('reads a private file the user owns', async () => {
    const file = await work.json('a.json', { ok: true });
    expect(await readTrustedJson(file)).toEqual({ ok: true });
  });

  it('refuses a file other users can write, because they could approve onboarding', async () => {
    const file = await work.json('a.json', { ok: true }, 0o666);
    await chmod(file, 0o664);
    await expect(readTrustedJson(file)).rejects.toThrow('other users can write it');
    await chmod(file, 0o602);
    await expect(readTrustedJson(file)).rejects.toThrow('other users can write it');
  });

  it('refuses a file another user owns, because that user could rewrite it', async () => {
    const file = await work.json('a.json', { ok: true });
    const spy = vi.spyOn(process, 'getuid').mockReturnValue((process.getuid?.() ?? 0) + 1);
    try {
      await expect(readTrustedJson(file)).rejects.toThrow('it belongs to another user');
    } finally {
      spy.mockRestore();
    }
  });

  it('refuses a symbolic link, a directory, a missing file and text that is not JSON', async () => {
    const real = await work.json('real.json', { ok: true });
    const link = work.path('link.json');
    await symlink(real, link);
    await expect(readTrustedJson(link)).rejects.toThrow('it is a symbolic link');
    await expect(readTrustedJson(work.dir)).rejects.toThrow('it is not a regular file');
    await expect(readTrustedJson(work.path('missing.json'))).rejects.toThrow('cannot be opened');
    const text = work.path('text.json');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(text, 'not json', { mode: 0o600 });
    await expect(readTrustedJson(text)).rejects.toThrow('it is not JSON');
  });

  it('names the file and never its contents', async () => {
    const file = await work.json('a.json', { secret: 'SECRETVALUE' }, 0o666);
    await chmod(file, 0o664);
    const failure = (await readTrustedJson(file).catch((e: unknown) => e)) as TrustedFileError;
    expect(failure).toBeInstanceOf(TrustedFileError);
    expect(failure.message).toContain(file);
    expect(failure.message).not.toContain('SECRETVALUE');
  });
});

describe('FileApprovalLedger', () => {
  it('finds a recorded approval by id and returns undefined for an unknown one', async () => {
    const file = await work.json('approvals.json', { approvals: [APPROVAL] });
    const ledger = new FileApprovalLedger(file);
    expect(await ledger.find(APPROVAL.approvalId)).toEqual(APPROVAL);
    expect(await ledger.find('OTHER_PLACEHOLDER')).toBeUndefined();
  });

  it('reads the file again on every call, so a withdrawn approval is seen at the next check', async () => {
    const file = await work.json('approvals.json', { approvals: [APPROVAL] });
    const ledger = new FileApprovalLedger(file);
    expect(await ledger.find(APPROVAL.approvalId)).toBeDefined();
    await work.json('approvals.json', { approvals: [] });
    expect(await ledger.find(APPROVAL.approvalId)).toBeUndefined();
    await work.json('approvals.json', { approvals: [{ ...APPROVAL, scopes: ['setup'] }] });
    expect((await ledger.find(APPROVAL.approvalId))?.scopes).toEqual(['setup']);
  });

  it.each([
    ['no list', {}],
    ['an approval that is not an object', { approvals: ['x'] }],
    ['an unknown scope', { approvals: [{ ...APPROVAL, scopes: ['everything'] }] }],
    ['a missing tenant', { approvals: [{ ...APPROVAL, tenantId: '' }] }],
    ['the same id twice', { approvals: [APPROVAL, APPROVAL] }],
  ])('refuses a file with %s', async (_name, content) => {
    const file = await work.json('approvals.json', content);
    await expect(new FileApprovalLedger(file).find(APPROVAL.approvalId)).rejects.toBeInstanceOf(
      TrustedFileError
    );
  });
});

describe('FileRegisterReader', () => {
  it('reads one tenant and returns undefined for an unknown one', async () => {
    const file = await work.json('register.json', { entries: [ENTRY] });
    const reader = new FileRegisterReader(file);
    expect(await reader.read(ENTRY.tenantId)).toEqual(ENTRY);
    expect(await reader.read('OTHER_PLACEHOLDER')).toBeUndefined();
  });

  it.each([
    ['no list', {}],
    ['a port that is text', { entries: [{ ...ENTRY, appHostPort: '20001' }] }],
    [
      'hostnames that are not a list',
      { entries: [{ ...ENTRY, hostnames: 'host.example.invalid' }] },
    ],
    ['a hostname that is not text', { entries: [{ ...ENTRY, hostnames: [1] }] }],
    ['the same tenant twice', { entries: [ENTRY, ENTRY] }],
  ])('refuses a file with %s', async (_name, content) => {
    const file = await work.json('register.json', content);
    await expect(new FileRegisterReader(file).read(ENTRY.tenantId)).rejects.toBeInstanceOf(
      TrustedFileError
    );
  });
});
