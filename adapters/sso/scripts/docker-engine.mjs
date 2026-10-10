// A minimal Docker Engine API client over the mounted unix socket, using
// Node's http and nothing else. It lists containers by label and runs one
// command in one container. See docker-engine.md for the calls it makes,
// the bound on each and what it refuses.

import http from 'node:http';

export const DOCKER_SOCKET = '/var/run/docker.sock';
/** A wedged call must not hold the timer's run open for ever. */
export const DOCKER_TIMEOUT_MS = 60_000;
/** More response than this from one call is a fault, not a result. */
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const CONTAINER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;
const EXEC_ID = /^[a-f0-9]{16,128}$/;

export class EngineTimeoutError extends Error {
  constructor(what, ms) {
    super(`Docker Engine call ${what} timed out after ${ms} ms`);
    this.name = 'EngineTimeoutError';
  }
}

export class EngineError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EngineError';
  }
}

/**
 * One request, bounded end to end by `deadlineAt` (epoch ms): the timer covers
 * connecting, waiting and reading the whole body, and destroys the socket.
 * Resolves `{ status, body }`; never includes the request body in an error.
 */
export function engineRequest({ socketPath, method, path, body, deadlineAt, now = Date.now }) {
  const what = `${method} ${path.split('?')[0]}`;
  const remaining = deadlineAt - now();
  return new Promise((resolve, reject) => {
    if (remaining <= 0) {
      reject(new EngineTimeoutError(what, 0));
      return;
    }
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = payload
      ? { 'content-type': 'application/json', 'content-length': payload.length }
      : {};
    const request = http.request({ socketPath, method, path, headers });
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      request.destroy();
      settle(reject, new EngineTimeoutError(what, remaining));
    }, remaining);
    request.on('error', (error) =>
      settle(reject, new EngineError(`${what} failed: ${error.message}`))
    );
    request.on('response', (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          request.destroy();
          settle(reject, new EngineError(`${what} returned more than the size bound`));
          return;
        }
        chunks.push(chunk);
      });
      response.on('error', (error) =>
        settle(reject, new EngineError(`${what} failed: ${error.message}`))
      );
      response.on('close', () => {
        if (!response.complete) settle(reject, new EngineError(`${what} was cut off`));
      });
      response.on('end', () =>
        settle(resolve, { status: response.statusCode, body: Buffer.concat(chunks) })
      );
    });
    request.end(payload ?? undefined);
  });
}

/**
 * Splits Docker's multiplexed stream (8-byte header: stream, 0, 0, 0, then a
 * big-endian length) into stdout and stderr. A short or unknown frame is
 * refused rather than guessed at.
 */
export function demultiplex(buffer) {
  const out = [];
  const err = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (buffer.length - offset < 8)
      throw new EngineError('exec stream ended inside a frame header');
    const stream = buffer[offset];
    const size = buffer.readUInt32BE(offset + 4);
    if (
      ![0, 1, 2].includes(stream) ||
      buffer[offset + 1] + buffer[offset + 2] + buffer[offset + 3] !== 0
    ) {
      throw new EngineError('exec stream is not Docker multiplexed output');
    }
    const end = offset + 8 + size;
    if (end > buffer.length) throw new EngineError('exec stream ended inside a frame');
    if (stream === 1) out.push(buffer.subarray(offset + 8, end));
    if (stream === 2) err.push(buffer.subarray(offset + 8, end));
    offset = end;
  }
  return {
    stdout: Buffer.concat(out).toString('utf8'),
    stderr: Buffer.concat(err).toString('utf8'),
  };
}

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseJson(response, what) {
  try {
    return JSON.parse(response.body.toString('utf8'));
  } catch {
    throw new EngineError(`${what} did not return JSON`);
  }
}

function expectStatus(response, ok, what) {
  if (response.status === ok) return;
  let detail = '';
  try {
    detail = String(JSON.parse(response.body.toString('utf8')).message ?? '').slice(0, 300);
  } catch {
    // not JSON: the status alone is reported
  }
  throw new EngineError(`${what} answered ${response.status}${detail ? `: ${detail}` : ''}`);
}

/**
 * The two operations the grant tool needs. Each logical call (a list, or an
 * exec's create, start and inspect together) shares one `timeoutMs` bound.
 */
export function createEngine({
  socketPath = DOCKER_SOCKET,
  timeoutMs = DOCKER_TIMEOUT_MS,
  now = Date.now,
} = {}) {
  const call = (deadlineAt, method, path, body) =>
    engineRequest({ socketPath, method, path, body, deadlineAt, now });

  return {
    /** Running containers carrying every one of `labels` ({key: value}). */
    async listContainers({ labels }) {
      const filters = {
        status: ['running'],
        label: Object.entries(labels).map(([key, value]) => `${key}=${value}`),
      };
      const path = `/containers/json?filters=${encodeURIComponent(JSON.stringify(filters))}`;
      const response = await call(now() + timeoutMs, 'GET', path);
      expectStatus(response, 200, 'list containers');
      const rows = parseJson(response, 'list containers');
      if (!Array.isArray(rows)) throw new EngineError('list containers did not return a list');
      return rows.flatMap((row) => {
        const names = Array.isArray(row.Names) ? row.Names : [];
        const own = names.find((n) => typeof n === 'string' && /^\/[^/]+$/.test(n));
        return own ? [{ name: own.slice(1), labels: row.Labels ?? {} }] : [];
      });
    },

    /** Runs `cmd` in `container`; resolves `{ code, stdout, stderr }`. */
    async exec({ container, cmd, env = [] }) {
      if (!CONTAINER_NAME.test(container)) throw new EngineError('not a container name');
      const deadlineAt = now() + timeoutMs;
      const created = await call(
        deadlineAt,
        'POST',
        `/containers/${encodeURIComponent(container)}/exec`,
        { AttachStdout: true, AttachStderr: true, Tty: false, Env: env, Cmd: cmd }
      );
      expectStatus(created, 201, 'exec create');
      const id = parseJson(created, 'exec create').Id;
      if (typeof id !== 'string' || !EXEC_ID.test(id))
        throw new EngineError('exec create gave no id');
      const started = await call(deadlineAt, 'POST', `/exec/${id}/start`, {
        Detach: false,
        Tty: false,
      });
      expectStatus(started, 200, 'exec start');
      const output = demultiplex(started.body);
      for (;;) {
        const inspected = await call(deadlineAt, 'GET', `/exec/${id}/json`);
        expectStatus(inspected, 200, 'exec inspect');
        const state = parseJson(inspected, 'exec inspect');
        if (state.Running !== true && Number.isInteger(state.ExitCode)) {
          return { code: state.ExitCode, ...output };
        }
        if (now() >= deadlineAt) throw new EngineTimeoutError('GET /exec/json', timeoutMs);
        await sleepMs(50);
      }
    },
  };
}
