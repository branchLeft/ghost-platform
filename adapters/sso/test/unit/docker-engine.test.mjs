import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createEngine,
  demultiplex,
  DOCKER_SOCKET,
  DOCKER_TIMEOUT_MS,
  EngineError,
  EngineTimeoutError,
  engineRequest,
  MAX_RESPONSE_BYTES,
} from '../../scripts/docker-engine.mjs';

const EXEC_ID = 'a'.repeat(64);
let dir;
let socketPath;
let server;
let seen;

/** One Docker multiplexed frame: stream (1 stdout, 2 stderr), three zeros, big-endian length. */
function frame(stream, text) {
  const payload = Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

function readBody(request) {
  return new Promise((resolve) => {
    const chunks = [];
    request.on('data', (c) => chunks.push(c));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

/** A fake Engine on a unix socket. `route(request, body, response)` answers each call. */
async function listen(route) {
  seen = [];
  server = http.createServer(async (request, response) => {
    const body = await readBody(request);
    seen.push({ method: request.method, url: request.url, body });
    route(request, body, response);
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
}

const json = (response, status, value) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
};

/** A healthy exec: create, start with the given frames, inspect with the given state. */
function execRoute({ frames = [], inspect = [{ Running: false, ExitCode: 0 }] } = {}) {
  let inspects = 0;
  return (request, _body, response) => {
    if (request.url.endsWith('/exec') && request.method === 'POST') {
      json(response, 201, { Id: EXEC_ID });
    } else if (request.url === `/exec/${EXEC_ID}/start`) {
      response.writeHead(200, { 'content-type': 'application/vnd.docker.multiplexed-stream' });
      response.end(Buffer.concat(frames));
    } else if (request.url === `/exec/${EXEC_ID}/json`) {
      json(response, 200, inspect[Math.min(inspects++, inspect.length - 1)]);
    } else {
      json(response, 404, { message: 'no such route' });
    }
  };
}

/** Rejects with 'HUNG' instead of letting a regression hang the suite. */
const orHung = (promise, ms = 5000) =>
  Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve('HUNG'), ms))]);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-eng-'));
  socketPath = path.join(dir, 'e.sock');
});
afterEach(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  server = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('defaults', () => {
  it('talks to the standard socket with a 60 second bound', () => {
    expect(DOCKER_SOCKET).toBe('/var/run/docker.sock');
    expect(DOCKER_TIMEOUT_MS).toBe(60_000);
  });
});

describe('listContainers', () => {
  it('asks for running containers carrying the labels, and returns each one-slash name', async () => {
    await listen((_req, _body, response) =>
      json(response, 200, [
        { Names: ['/tz-ghost-a-1'], Labels: { 'com.docker.compose.service': 'ghost-a' } },
        { Names: ['/other/alias'], Labels: {} },
        { Names: [], Labels: {} },
      ])
    );
    const engine = createEngine({ socketPath });
    const rows = await engine.listContainers({ labels: { 'com.docker.compose.project': 'tz' } });
    expect(rows).toEqual([
      { name: 'tz-ghost-a-1', labels: { 'com.docker.compose.service': 'ghost-a' } },
    ]);
    const url = new URL(seen[0].url, 'http://engine');
    expect(url.pathname).toBe('/containers/json');
    expect(JSON.parse(url.searchParams.get('filters'))).toEqual({
      status: ['running'],
      label: ['com.docker.compose.project=tz'],
    });
  });

  it('refuses an answer that is not a list', async () => {
    await listen((_req, _body, response) => json(response, 200, { message: 'x' }));
    await expect(
      createEngine({ socketPath }).listContainers({ labels: { a: 'b' } })
    ).rejects.toThrow(/did not return a list/);
  });

  it('reports a non-200 with the daemon message and never the filters', async () => {
    await listen((_req, _body, response) => json(response, 500, { message: 'daemon is unwell' }));
    const failure = await createEngine({ socketPath })
      .listContainers({ labels: { secretish: 'value' } })
      .catch((e) => e);
    expect(failure).toBeInstanceOf(EngineError);
    expect(failure.message).toMatch(/answered 500: daemon is unwell/);
    expect(failure.message).not.toContain('secretish');
  });
});

describe('exec', () => {
  it('creates, starts and inspects, passing env and the command in the body, not the path', async () => {
    await listen(
      execRoute({
        frames: [frame(1, 'BL_BREAK_GLASS {"a":1}\n'), frame(2, 'warn\n')],
        inspect: [{ Running: false, ExitCode: 0 }],
      })
    );
    const engine = createEngine({ socketPath });
    const result = await engine.exec({
      container: 'tz-ghost-a-1',
      env: ['BL_ACTION=check', 'BL_EXPECT_IDENTITY=support@platform.example'],
      cmd: ['node', '-e', 'console.log(1)'],
    });
    expect(result).toEqual({ code: 0, stdout: 'BL_BREAK_GLASS {"a":1}\n', stderr: 'warn\n' });
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      'POST /containers/tz-ghost-a-1/exec',
      `POST /exec/${EXEC_ID}/start`,
      `GET /exec/${EXEC_ID}/json`,
    ]);
    expect(JSON.parse(seen[0].body)).toEqual({
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      Env: ['BL_ACTION=check', 'BL_EXPECT_IDENTITY=support@platform.example'],
      Cmd: ['node', '-e', 'console.log(1)'],
    });
    expect(JSON.parse(seen[1].body)).toEqual({ Detach: false, Tty: false });
    expect(seen.map((s) => s.url).join(' ')).not.toContain('support@platform.example');
  });

  it('returns a non-zero exit code with its stderr', async () => {
    await listen(
      execRoute({
        frames: [frame(2, 'BL_BREAK_GLASS_REFUSED nope\n')],
        inspect: [{ Running: false, ExitCode: 1 }],
      })
    );
    const result = await createEngine({ socketPath }).exec({ container: 'c', cmd: ['x'] });
    expect(result).toMatchObject({ code: 1, stderr: 'BL_BREAK_GLASS_REFUSED nope\n' });
  });

  it('waits for the exit code while the exec still reports running', async () => {
    await listen(
      execRoute({
        inspect: [
          { Running: true, ExitCode: 0 },
          { Running: true, ExitCode: 0 },
          { Running: false, ExitCode: 3 },
        ],
      })
    );
    const result = await createEngine({ socketPath }).exec({ container: 'c', cmd: ['x'] });
    expect(result.code).toBe(3);
    expect(seen.filter((s) => s.url.endsWith('/json'))).toHaveLength(3);
  });

  it('refuses a container name that is not a plain name, before any request', async () => {
    await listen(execRoute());
    const engine = createEngine({ socketPath });
    for (const bad of ['../../etc', 'a b', '', 'x/exec?', '-rm']) {
      await expect(engine.exec({ container: bad, cmd: ['x'] })).rejects.toThrow(
        /not a container name/
      );
    }
    expect(seen).toEqual([]);
  });

  it('reports a missing container with the daemon message', async () => {
    await listen((_req, _body, response) =>
      json(response, 404, { message: 'No such container: gone' })
    );
    await expect(
      createEngine({ socketPath }).exec({ container: 'gone', cmd: ['x'] })
    ).rejects.toThrow(/exec create answered 404: No such container: gone/);
  });

  it('refuses an exec id that is not hex, so it can never shape a later path', async () => {
    await listen((_req, _body, response) => json(response, 201, { Id: '../containers/x' }));
    await expect(createEngine({ socketPath }).exec({ container: 'c', cmd: ['x'] })).rejects.toThrow(
      /gave no id/
    );
  });
});

describe('the bound: a call that never answers ends at the bound, it does not hang', () => {
  it('times out a list that never answers', async () => {
    await listen(() => {});
    const engine = createEngine({ socketPath, timeoutMs: 150 });
    const started = Date.now();
    const outcome = await orHung(engine.listContainers({ labels: { a: 'b' } }).catch((e) => e));
    expect(outcome).toBeInstanceOf(EngineTimeoutError);
    expect(outcome.message).toMatch(/GET \/containers\/json timed out after 150 ms/);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('times out an exec whose process never finishes', async () => {
    await listen((request, _body, response) => {
      if (request.url.endsWith('/exec')) {
        setTimeout(() => json(response, 201, { Id: EXEC_ID }), 100);
      } else {
        // the start call never ends
        response.writeHead(200);
        response.write(frame(1, 'partial'));
      }
    });
    const engine = createEngine({ socketPath, timeoutMs: 400 });
    const begun = Date.now();
    const outcome = await orHung(engine.exec({ container: 'c', cmd: ['x'] }).catch((e) => e));
    expect(outcome).toBeInstanceOf(EngineTimeoutError);
    const elapsed = Date.now() - begun;
    expect(elapsed).toBeGreaterThanOrEqual(350);
    expect(elapsed).toBeLessThan(3000);
  });

  it('times out an inspect that keeps saying running', async () => {
    await listen(execRoute({ inspect: [{ Running: true, ExitCode: 0 }] }));
    const engine = createEngine({ socketPath, timeoutMs: 300 });
    const outcome = await orHung(engine.exec({ container: 'c', cmd: ['x'] }).catch((e) => e));
    expect(outcome).toBeInstanceOf(EngineTimeoutError);
  });

  it('arms a 60 second timer on each call when no bound is given', async () => {
    await listen((_req, _body, response) => json(response, 200, []));
    const spy = vi.spyOn(globalThis, 'setTimeout');
    try {
      await createEngine({ socketPath }).listContainers({ labels: { a: 'b' } });
      const delays = spy.mock.calls.map(([, ms]) => ms);
      expect(delays.some((ms) => ms > DOCKER_TIMEOUT_MS - 1000 && ms <= DOCKER_TIMEOUT_MS)).toBe(
        true
      );
    } finally {
      spy.mockRestore();
    }
  });

  it('refuses at once when the deadline has already passed', async () => {
    const outcome = await engineRequest({
      socketPath,
      method: 'GET',
      path: '/_ping',
      deadlineAt: 1000,
      now: () => 2000,
    }).catch((e) => e);
    expect(outcome).toBeInstanceOf(EngineTimeoutError);
  });
});

describe('failures are errors, not hangs and not silent', () => {
  it('rejects when nothing listens on the socket', async () => {
    const outcome = await orHung(
      createEngine({ socketPath: path.join(dir, 'none.sock'), timeoutMs: 500 })
        .listContainers({ labels: { a: 'b' } })
        .catch((e) => e)
    );
    expect(outcome).toBeInstanceOf(EngineError);
  });

  it('rejects a response cut off mid-body', async () => {
    await listen((_req, _body, response) => {
      response.writeHead(200, { 'content-length': '1000' });
      response.write('[');
      setTimeout(() => response.destroy(), 20);
    });
    const outcome = await orHung(
      createEngine({ socketPath, timeoutMs: 2000 })
        .listContainers({ labels: { a: 'b' } })
        .catch((e) => e)
    );
    expect(outcome).toBeInstanceOf(EngineError);
    expect(outcome).not.toBeInstanceOf(EngineTimeoutError);
  });

  it('rejects a response over the size bound', async () => {
    await listen((_req, _body, response) => {
      response.writeHead(200);
      response.end(Buffer.alloc(MAX_RESPONSE_BYTES + 1024, 0x20));
    });
    const outcome = await orHung(
      createEngine({ socketPath, timeoutMs: 5000 })
        .listContainers({ labels: { a: 'b' } })
        .catch((e) => e)
    );
    expect(outcome).toBeInstanceOf(EngineError);
    expect(outcome.message).toMatch(/size bound/);
  });

  it('rejects an answer that is not JSON', async () => {
    await listen((_req, _body, response) => {
      response.writeHead(200);
      response.end('<html>');
    });
    await expect(
      createEngine({ socketPath }).listContainers({ labels: { a: 'b' } })
    ).rejects.toThrow(/did not return JSON/);
  });
});

describe('demultiplex', () => {
  it('separates interleaved stdout and stderr frames', () => {
    const buffer = Buffer.concat([
      frame(1, 'a'),
      frame(2, 'b'),
      frame(1, 'c'),
      frame(0, 'ignored'),
    ]);
    expect(demultiplex(buffer)).toEqual({ stdout: 'ac', stderr: 'b' });
  });

  it('reads an empty stream as no output', () => {
    expect(demultiplex(Buffer.alloc(0))).toEqual({ stdout: '', stderr: '' });
  });

  it('refuses a frame cut short, a short header and a stream that is not multiplexed', () => {
    expect(() => demultiplex(frame(1, 'hello').subarray(0, 10))).toThrow(/inside a frame/);
    expect(() => demultiplex(Buffer.from([1, 0, 0]))).toThrow(/frame header/);
    expect(() => demultiplex(Buffer.from('{"plain":"json"}\n'))).toThrow(/not Docker multiplexed/);
  });
});
