import { vi } from 'vitest';

// An in-memory stand-in for the workspace repository's issues API: the three
// calls src/issues.ts makes (list by label, create, add a sub-issue), with
// the semantics the filer relies on. Every request is recorded.

export interface FakeIssue {
  id: number;
  number: number;
  html_url: string;
  body: string;
  labels: string[];
  state: 'open' | 'closed';
  parent_issue_url: string | null;
  pull_request?: unknown;
}

export interface RecordedCall {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | null;
  readonly body: unknown;
}

export interface FakeWorkspace {
  readonly fetch: ReturnType<typeof vi.fn<typeof fetch>>;
  readonly issues: FakeIssue[];
  readonly calls: RecordedCall[];
  /** Makes the next sub-issue attach fail with a 500, once. */
  failNextAttach(): void;
}

const REPO = '/repos/branchLeft/workspace';

function json(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 || status === 201 ? 'OK' : 'Error',
    json: async () => body,
  } as Response;
}

export function fakeWorkspace(seed: FakeIssue[] = []): FakeWorkspace {
  const issues = [...seed];
  const calls: RecordedCall[] = [];
  let attachFails = false;
  let nextNumber = 5000;

  const impl = async (
    input: string | URL | Request,
    init?: Parameters<typeof fetch>[1]
  ): Promise<Response> => {
    const url = new URL(String(input));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({
      method,
      path: `${url.pathname}${url.search}`,
      authorization: headers.Authorization ?? null,
      body,
    });
    if (url.hostname !== 'api.github.com') return json(404, {});

    if (method === 'GET' && url.pathname === `${REPO}/issues`) {
      const label = url.searchParams.get('labels');
      const perPage = Number(url.searchParams.get('per_page'));
      const page = Number(url.searchParams.get('page'));
      const matching = issues.filter((i) => label === null || i.labels.includes(label));
      return json(200, matching.slice((page - 1) * perPage, page * perPage));
    }
    if (method === 'POST' && url.pathname === `${REPO}/issues`) {
      const req = body as { title: string; body: string; labels: string[] };
      nextNumber += 1;
      const created: FakeIssue = {
        id: nextNumber * 1000,
        number: nextNumber,
        html_url: `https://github.com/branchLeft/workspace/issues/${nextNumber}`,
        body: req.body,
        labels: req.labels,
        state: 'open',
        parent_issue_url: null,
      };
      issues.push(created);
      return json(201, created);
    }
    const attach = /^\/repos\/branchLeft\/workspace\/issues\/(\d+)\/sub_issues$/.exec(url.pathname);
    if (method === 'POST' && attach) {
      if (attachFails) {
        attachFails = false;
        return json(500, {});
      }
      const child = issues.find((i) => i.id === (body as { sub_issue_id: number }).sub_issue_id);
      if (!child) return json(404, {});
      child.parent_issue_url = `https://api.github.com${REPO}/issues/${attach[1]}`;
      return json(201, child);
    }
    return json(404, {});
  };

  return {
    fetch: vi.fn<typeof fetch>(impl as typeof fetch),
    issues,
    calls,
    failNextAttach: () => {
      attachFails = true;
    },
  };
}
