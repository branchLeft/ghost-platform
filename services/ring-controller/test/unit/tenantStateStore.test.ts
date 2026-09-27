import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTempDir } from '../../src/atomicFile.js';
import {
  createFileTenantStateStore,
  type PersistedTenantState,
} from '../../src/tenantStateStore.js';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await makeTempDir('ring-controller-statestore-');
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function record(overrides: Partial<PersistedTenantState> = {}): PersistedTenantState {
  return {
    tenantId: 'tenant-a',
    state: 'applying',
    pageSent: false,
    updatedAt: '2026-09-27T00:00:00.000Z',
    ...overrides,
  };
}

describe('createFileTenantStateStore', () => {
  it('creates the store directory on first save, even if it does not exist yet', async () => {
    const dir = join(await tempDir(), 'nested', 'deeper');
    const store = createFileTenantStateStore(dir);

    await store.save(record());

    expect(await store.load('tenant-a')).toEqual(record());
  });

  it('round-trips a saved record through load', async () => {
    const store = createFileTenantStateStore(await tempDir());
    await store.save(record({ tenantId: 'tenant-b', state: 'verifying', pageSent: true }));

    const loaded = await store.load('tenant-b');

    expect(loaded).toEqual(record({ tenantId: 'tenant-b', state: 'verifying', pageSent: true }));
  });

  it('load returns undefined for a tenant with no persisted record', async () => {
    const store = createFileTenantStateStore(await tempDir());

    expect(await store.load('never-saved')).toBeUndefined();
  });

  it('a later save overwrites the earlier record for the same tenant', async () => {
    const store = createFileTenantStateStore(await tempDir());
    await store.save(record({ state: 'backing-up' }));
    await store.save(record({ state: 'applying' }));

    expect(await store.load('tenant-a')).toEqual(record({ state: 'applying' }));
  });

  it('remove deletes the persisted record', async () => {
    const store = createFileTenantStateStore(await tempDir());
    await store.save(record());

    await store.remove('tenant-a');

    expect(await store.load('tenant-a')).toBeUndefined();
  });

  it('remove on a tenant never saved does not throw', async () => {
    const store = createFileTenantStateStore(await tempDir());

    await expect(store.remove('never-saved')).resolves.toBeUndefined();
  });

  it('list returns every persisted record, and is empty before anything is saved', async () => {
    const store = createFileTenantStateStore(await tempDir());
    expect(await store.list()).toEqual([]);

    await store.save(record({ tenantId: 'tenant-a' }));
    await store.save(record({ tenantId: 'tenant-b', state: 'done' }));

    const all = await store.list();
    expect(all.map((r) => r.tenantId).sort()).toEqual(['tenant-a', 'tenant-b']);
  });

  it('list on a directory that was never created returns empty, not an error', async () => {
    const dir = join(await tempDir(), 'never-created');
    const store = createFileTenantStateStore(dir);

    expect(await store.list()).toEqual([]);
  });

  it('sanitises a tenant id that is not filesystem-safe', async () => {
    const store = createFileTenantStateStore(await tempDir());
    await store.save(record({ tenantId: '../escape' }));

    expect(await store.load('../escape')).toEqual(record({ tenantId: '../escape' }));
  });

  it('load rethrows a real filesystem error rather than reading it as "not found"', async () => {
    const dir = await tempDir();
    const store = createFileTenantStateStore(dir);
    // A directory sitting where the record file would be turns the read
    // into EISDIR, not ENOENT -- a different failure than "never saved",
    // and one `load` must not silently swallow.
    await mkdir(join(dir, 'tenant-a.json'));

    await expect(store.load('tenant-a')).rejects.toThrow();
  });

  it('list rethrows a real filesystem error rather than reading it as "no records yet"', async () => {
    const dir = await tempDir();
    // The store's directory path is itself a plain file, so `readdir`
    // fails with ENOTDIR, not ENOENT -- list must surface that, not
    // report an empty store.
    const filePath = join(dir, 'not-a-directory');
    await writeFile(filePath, 'x', 'utf8');
    const store = createFileTenantStateStore(filePath);

    await expect(store.list()).rejects.toThrow();
  });
});
