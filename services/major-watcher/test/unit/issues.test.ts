import { describe, expect, it } from 'vitest';
import { upstreamMajorItem } from '../../src/filing.js';
import {
  fileUpstreamMajor,
  majorMarker,
  readFilingConfig,
  type FilingConfig,
} from '../../src/issues.js';
import { fakeWorkspace, type FakeIssue } from './fakeWorkspace.js';

const CONFIG: FilingConfig = { token: 'filing-token-value', launchItem: 3810 };

function itemFor(major: number) {
  return upstreamMajorItem({
    major,
    tagName: `v${major}.0.0-alpha.1`,
    publishedAt: '2025-07-16T10:54:47Z',
    prerelease: true,
    releaseUrl: `https://github.com/TryGhost/Ghost/releases/tag/v${major}.0.0-alpha.1`,
  });
}

function seeded(major: number, overrides: Partial<FakeIssue> = {}): FakeIssue {
  return {
    id: 777,
    number: 4001,
    html_url: 'https://github.com/example-org/tracker/issues/4001',
    body: `earlier body\n\n${majorMarker(major)}`,
    labels: ['upstream-major'],
    state: 'open',
    parent_issue_url: 'https://api.github.com/repos/example-org/tracker/issues/3810',
    ...overrides,
  };
}

describe('fileUpstreamMajor', () => {
  it('files one labelled item for a new major and adds it to the launch item', async () => {
    const ws = fakeWorkspace();

    const filed = await fileUpstreamMajor(CONFIG, itemFor(7), ws.fetch);

    expect(filed.created).toBe(true);
    expect(ws.issues).toHaveLength(1);
    const [issue] = ws.issues as [FakeIssue];
    expect(issue.labels).toContain('upstream-major');
    expect(issue.body).toContain(majorMarker(7));
    expect(issue.parent_issue_url).toMatch(/\/issues\/3810$/);
    expect(filed.url).toBe(issue.html_url);
  });

  it('a repeat for the same major files nothing and attaches nothing', async () => {
    const ws = fakeWorkspace();
    await fileUpstreamMajor(CONFIG, itemFor(7), ws.fetch);
    const callsAfterFirst = ws.calls.length;

    const again = await fileUpstreamMajor(CONFIG, itemFor(7), ws.fetch);

    expect(again.created).toBe(false);
    expect(ws.issues).toHaveLength(1);
    const writes = ws.calls.slice(callsAfterFirst).filter((c) => c.method === 'POST');
    expect(writes).toEqual([]);
  });

  it('finds the item of a closed issue too, so a closed major is never filed again', async () => {
    const ws = fakeWorkspace([seeded(7, { state: 'closed' })]);

    const filed = await fileUpstreamMajor(CONFIG, itemFor(7), ws.fetch);

    expect(filed).toEqual({
      number: 4001,
      url: 'https://github.com/example-org/tracker/issues/4001',
      created: false,
    });
    expect(ws.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('the key is the exact major: an item for major 7 does not stop major 70 or major 8', async () => {
    const ws = fakeWorkspace([seeded(7)]);

    const eight = await fileUpstreamMajor(CONFIG, itemFor(8), ws.fetch);
    const seventy = await fileUpstreamMajor(CONFIG, itemFor(70), ws.fetch);

    expect(eight.created).toBe(true);
    expect(seventy.created).toBe(true);
    expect(ws.issues).toHaveLength(3);
  });

  it('ignores a pull request that carries the marker', async () => {
    const ws = fakeWorkspace([seeded(7, { pull_request: {} })]);

    const filed = await fileUpstreamMajor(CONFIG, itemFor(7), ws.fetch);

    expect(filed.created).toBe(true);
  });

  it('searches past the first page of labelled issues', async () => {
    const filler = Array.from({ length: 100 }, (_, n) =>
      seeded(2, { id: 10 + n, number: 100 + n, body: majorMarker(2) })
    );
    const ws = fakeWorkspace([...filler, seeded(7, { id: 888, number: 4002 })]);

    const filed = await fileUpstreamMajor(CONFIG, itemFor(7), ws.fetch);

    expect(filed.created).toBe(false);
    expect(filed.number).toBe(4002);
  });

  it('repairs an item whose attach failed: the next run attaches it and files no second item', async () => {
    const ws = fakeWorkspace();
    ws.failNextAttach();
    await expect(fileUpstreamMajor(CONFIG, itemFor(7), ws.fetch)).rejects.toThrow(
      /sub_issues failed: 500/
    );
    expect(ws.issues).toHaveLength(1);
    expect(ws.issues[0]?.parent_issue_url).toBeNull();

    const retry = await fileUpstreamMajor(CONFIG, itemFor(7), ws.fetch);

    expect(retry.created).toBe(false);
    expect(ws.issues).toHaveLength(1);
    expect(ws.issues[0]?.parent_issue_url).toMatch(/\/issues\/3810$/);
  });

  it('sends the filing token as the bearer and nothing else as credential, and names no token in an error', async () => {
    const ws = fakeWorkspace();
    await fileUpstreamMajor(CONFIG, itemFor(7), ws.fetch);
    for (const call of ws.calls) {
      expect(call.authorization).toBe('Bearer filing-token-value');
    }

    const failing = (async () => ({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      json: async () => ({}),
    })) as unknown as typeof fetch;
    const error = await fileUpstreamMajor(CONFIG, itemFor(9), failing).catch((e: unknown) => e);
    expect(String(error)).toContain('403');
    expect(String(error)).not.toContain('filing-token-value');
  });

  it('fails the call when the issue list is refused, creating nothing', async () => {
    const ws = fakeWorkspace();
    ws.fetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
    } as Response);

    await expect(fileUpstreamMajor(CONFIG, itemFor(7), ws.fetch)).rejects.toThrow(/401/);
    expect(ws.issues).toHaveLength(0);
  });

  it('a stalled call fails with a timeout that names the operation and no token', async () => {
    const stalling = ((_input: unknown, init?: Parameters<typeof fetch>[1]) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      })) as unknown as typeof fetch;

    await expect(
      fileUpstreamMajor({ ...CONFIG, timeoutMs: 20 }, itemFor(7), stalling)
    ).rejects.toThrow(
      new Error('GitHub GET /repos/branchLeft/workspace/issues timed out after 20 ms')
    );
  });

  it('refuses a response that is not a list', async () => {
    const odd = (async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ message: 'nope' }),
    })) as unknown as typeof fetch;

    await expect(fileUpstreamMajor(CONFIG, itemFor(7), odd)).rejects.toThrow(/not an array/);
  });
});

describe('readFilingConfig (fails closed)', () => {
  const names = { token: 'FILING_TOKEN', launchItem: 'LAUNCH_ITEM' };

  it('reads the token and the launch item number', () => {
    expect(readFilingConfig({ FILING_TOKEN: 't', LAUNCH_ITEM: '3810' }, names)).toEqual({
      token: 't',
      launchItem: 3810,
    });
  });

  it('throws naming the variable when the token is absent or empty', () => {
    expect(() => readFilingConfig({ LAUNCH_ITEM: '3810' }, names)).toThrow(
      /FILING_TOKEN is not set/
    );
    expect(() => readFilingConfig({ FILING_TOKEN: '', LAUNCH_ITEM: '3810' }, names)).toThrow(
      /FILING_TOKEN is not set/
    );
  });

  it.each([undefined, '', '0', '-3', '38.5', 'abc', '3810 '])(
    'throws when the launch item is %j',
    (value) => {
      expect(() => readFilingConfig({ FILING_TOKEN: 't', LAUNCH_ITEM: value }, names)).toThrow(
        /LAUNCH_ITEM is not set to an issue number/
      );
    }
  );
});
