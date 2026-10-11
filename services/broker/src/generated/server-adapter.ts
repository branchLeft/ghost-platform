// @ts-nocheck
// Speckify output, committed as generated and never edited by hand.
/**
 * Speckify's node:http server adapter. This file is copied verbatim into
 * every generated server package (see ../server/write-server.ts) so that
 * package has no runtime dependency on Speckify itself — only on zod, which
 * it already depends on for its own generated schemas. It is typechecked
 * and unit-tested here, in the tool repo, so a defect is caught long before
 * it is baked into a producer's published package.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z, type ZodType } from 'zod';

export interface RequestContext {
  readonly rawRequest: IncomingMessage;
}

export interface HandledResponse {
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
}

/** The shape every generated per-operation Handlers method request takes. */
export interface HandlerRequest<Path, Query, Headers, Body> {
  readonly path: Path;
  readonly query: Query;
  readonly headers: Headers;
  readonly body: Body;
}

/**
 * A discriminated union over a Responses map's own keys, e.g.
 * `{ 200: Thing; 404: Problem }` becomes
 * `{ status: 200; body: Thing } | { status: 404; body: Problem }`.
 */
export type HandlerResponse<Responses extends Record<number, unknown>> = {
  [Status in keyof Responses]: Status extends number
    ? { status: Status; body: Responses[Status]; headers?: Record<string, string> }
    : never;
}[keyof Responses];

type AnyHandler = (
  request: { path: unknown; query: unknown; headers: unknown; body: unknown },
  context: RequestContext,
) => Promise<HandledResponse>;

export type HttpMethod = 'GET' | 'PUT' | 'POST' | 'DELETE' | 'OPTIONS' | 'HEAD' | 'PATCH';

export interface RouteDefinition {
  /** The Handlers method this route dispatches to; matches an operationId. */
  readonly id: string;
  readonly method: HttpMethod;
  /** An OpenAPI-style path template, e.g. `/things/{id}`. */
  readonly path: string;
  readonly bodyMode: 'json' | 'octet-stream' | 'none';
  readonly pathSchema?: ZodType;
  readonly querySchema?: ZodType;
  readonly headersSchema?: ZodType;
  readonly bodySchema?: ZodType;
  /** Response validators, keyed by status; a status without one is not checked. */
  readonly responseSchemas?: Readonly<Record<number, ZodType>>;
}

/** The default {@link ListenerOptions.maxJsonBodyBytes}: 1 MiB. */
export const DEFAULT_MAX_JSON_BODY_BYTES = 1024 * 1024;

export interface ListenerOptions {
  /** Validate handler responses against `responseSchemas`. @default true */
  readonly validateResponses?: boolean;
  /**
   * The largest JSON request body accepted, in bytes. A body that exceeds
   * this is refused with a 413 problem response as soon as the cap is
   * crossed -- never buffered past it. @default {@link DEFAULT_MAX_JSON_BODY_BYTES}
   */
  readonly maxJsonBodyBytes?: number;
  /**
   * Runs before any request parsing at all -- path/query/header coercion
   * and validation, and body parsing -- so a caller verifying a request
   * signature (or doing auth) sees the request exactly as it arrived and
   * gets the first chance to reject it, ahead of Speckify's own
   * validation. `rawBody` carries the exact bytes for a JSON body (signing
   * covers the raw body, not the parsed value); it is `undefined` for an
   * octet-stream body, which is never buffered here.
   */
  readonly beforeHandle?: (
    rawRequest: IncomingMessage,
    route: RouteDefinition,
    rawBody: Buffer | undefined,
  ) => void | Promise<void>;
  readonly onError?: (error: unknown, rawRequest: IncomingMessage) => void;
}

interface ProblemJson {
  readonly title: string;
  readonly status: number;
  readonly errors?: unknown;
}

function sendProblem(res: ServerResponse, status: number, title: string, errors?: unknown): void {
  const body: ProblemJson = errors === undefined ? { title, status } : { title, status, errors };
  res.writeHead(status, { 'content-type': 'application/problem+json' });
  res.end(JSON.stringify(body));
}

/**
 * Matches a request path against an OpenAPI-style template and returns the
 * captured path parameters, or `undefined` when the segment counts or
 * literal segments don't line up.
 */
function matchPath(template: string, actual: string): Record<string, string> | undefined {
  const templateParts = template.split('/').filter((part) => part.length > 0);
  const actualParts = actual.split('/').filter((part) => part.length > 0);
  if (templateParts.length !== actualParts.length) return undefined;

  const params: Record<string, string> = {};
  for (let i = 0; i < templateParts.length; i += 1) {
    const templatePart = templateParts[i] ?? '';
    const actualPart = actualParts[i] ?? '';
    if (templatePart.startsWith('{') && templatePart.endsWith('}')) {
      params[templatePart.slice(1, -1)] = decodeURIComponent(actualPart);
    } else if (templatePart !== actualPart) {
      return undefined;
    }
  }
  return params;
}

/** Thrown by {@link readJsonBody} when the body crosses `maxBytes` before it ends. */
class PayloadTooLargeError extends Error {}

/**
 * Buffers a JSON request body up to `maxBytes`. The moment a chunk would
 * push the running total past the cap, buffering stops and the promise
 * rejects with {@link PayloadTooLargeError} straight away -- the caller can
 * write the 413 response without waiting for the rest of the body to
 * arrive. The request stream is left attached (so the connection keeps
 * draining rather than deadlocking the client on backpressure), but every
 * further chunk is discarded rather than appended -- the body is never
 * buffered past the cap, whatever `Content-Length` claimed or omitted.
 */
function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        if (!settled) {
          settled = true;
          reject(new PayloadTooLargeError());
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

function headersToRecord(req: IncomingMessage): Record<string, string> {
  const record: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') record[key] = value;
    else if (Array.isArray(value)) record[key] = value.join(', ');
  }
  return record;
}

/**
 * Node always lowercases incoming header names, but a header schema's keys
 * are whatever case the spec declared (hey-api's zod plugin preserves it
 * verbatim). Headers are case-insensitive per RFC 9110, so the schema's own
 * declared keys are lowercased to match before validating against `req.headers`.
 */
function withLowercasedHeaderKeys(schema: ZodType): ZodType {
  const shape = (schema as unknown as { shape?: Record<string, ZodType> }).shape;
  if (!shape) return schema;
  return z.object(
    Object.fromEntries(Object.entries(shape).map(([key, value]) => [key.toLowerCase(), value])),
  );
}

/**
 * Path, query and header values all arrive off node:http as plain strings
 * (or, for a repeated query key, several of them) -- but the generated zod
 * schemas type each one by the spec's declared schema (z.int(), z.boolean(),
 * z.array(...)), with no coercion of their own. Left alone, any typed
 * path/query/header parameter fails validation outright (a raw "42" is not
 * a `number` to zod), so every such value is coerced by its field's schema
 * type *before* validation, and the handler is always given the validated,
 * parsed result -- never the raw strings -- exactly as the body already is.
 */
function shapeOf(schema: ZodType | undefined): Record<string, ZodType> | undefined {
  return schema && (schema as unknown as { shape?: Record<string, ZodType> }).shape;
}

/** Zod 4's own type discriminator, after peeling optional/nullable/default/readonly wrappers. */
function baseTypeOf(schema: ZodType): { typeName: string | undefined; base: ZodType } {
  let current = schema;
  for (;;) {
    const def = (current as unknown as { def?: { type?: string; innerType?: ZodType } }).def;
    const isWrapper =
      def?.type === 'optional' ||
      def?.type === 'nullable' ||
      def?.type === 'default' ||
      def?.type === 'readonly';
    if (isWrapper && def.innerType) {
      current = def.innerType;
      continue;
    }
    return { typeName: def?.type, base: current };
  }
}

function elementSchemaOf(schema: ZodType): ZodType | undefined {
  return (schema as unknown as { def?: { element?: ZodType } }).def?.element;
}

/** Coerces one raw string by a (possibly wrapped) scalar schema's declared type; anything else is left untouched. */
function coerceScalar(schema: ZodType, raw: string): unknown {
  const { typeName } = baseTypeOf(schema);
  if (typeName === 'number') {
    if (raw.trim() === '') return raw;
    const parsed = Number(raw);
    return Number.isNaN(parsed) ? raw : parsed;
  }
  if (typeName === 'boolean') {
    if (raw.toLowerCase() === 'true') return true;
    if (raw.toLowerCase() === 'false') return false;
    return raw;
  }
  return raw;
}

/** Coerces a path or header record (each value always a single raw string) by `schema`'s field types. */
function coerceSingleValuedByShape(
  schema: ZodType | undefined,
  record: Record<string, string>,
): Record<string, unknown> {
  const shape = shapeOf(schema);
  if (!shape) return record;
  const result: Record<string, unknown> = { ...record };
  for (const [key, fieldSchema] of Object.entries(shape)) {
    const raw = record[key];
    if (raw === undefined) continue;
    const { typeName, base } = baseTypeOf(fieldSchema);
    if (typeName === 'array') {
      const element = elementSchemaOf(base);
      result[key] = [element ? coerceScalar(element, raw) : raw];
    } else {
      result[key] = coerceScalar(fieldSchema, raw);
    }
  }
  return result;
}

/** Groups a URL's query string into `{ key: string[] }`, preserving every repeated occurrence of a key. */
function multiValuedQuery(url: URL): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const [key, value] of url.searchParams.entries()) {
    (result[key] ??= []).push(value);
  }
  return result;
}

/**
 * Coerces a multi-valued query record by `schema`'s field types: a field
 * typed as an array keeps every repeated value (coerced item by item); any
 * other field takes its first occurrence, coerced as a scalar. A key with
 * no matching schema field (or no schema at all) falls back to the same
 * "single value, or an array if repeated" shape the adapter always used.
 */
function coerceQueryByShape(
  schema: ZodType | undefined,
  multiValued: Record<string, string[]>,
): Record<string, unknown> {
  const shape = shapeOf(schema);
  const result: Record<string, unknown> = {};
  for (const [key, values] of Object.entries(multiValued)) {
    const fieldSchema = shape?.[key];
    if (!fieldSchema) {
      result[key] = values.length > 1 ? values : values[0];
      continue;
    }
    const { typeName, base } = baseTypeOf(fieldSchema);
    if (typeName === 'array') {
      const element = elementSchemaOf(base);
      result[key] = element ? values.map((value) => coerceScalar(element, value)) : values;
    } else {
      result[key] = coerceScalar(fieldSchema, values[0] ?? '');
    }
  }
  return result;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  handlers: object,
  routes: readonly RouteDefinition[],
  validateResponses: boolean,
  options: ListenerOptions,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const method = (req.method ?? 'GET').toUpperCase();

  const route = routes.find(
    (candidate) => candidate.method === method && matchPath(candidate.path, url.pathname),
  );
  if (!route) {
    sendProblem(res, 404, 'Not Found');
    return;
  }

  // beforeHandle runs before path/query/header and body parsing so callers
  // can verify request signatures and reject requests before Speckify's own
  // validation runs. Raw JSON body is read up front too, still before all
  // other parsing, so beforeHandle can check body signatures.
  let rawJsonBody: Buffer | undefined;
  if (route.bodyMode === 'json') {
    const maxJsonBodyBytes = options.maxJsonBodyBytes ?? DEFAULT_MAX_JSON_BODY_BYTES;
    try {
      rawJsonBody = await readJsonBody(req, maxJsonBodyBytes);
    } catch (error) {
      if (error instanceof PayloadTooLargeError) {
        sendProblem(res, 413, 'Payload Too Large');
        return;
      }
      throw error;
    }
  }
  await options.beforeHandle?.(req, route, rawJsonBody);

  const rawPathParams = matchPath(route.path, url.pathname) ?? {};
  let pathParams: Record<string, unknown> = coerceSingleValuedByShape(
    route.pathSchema,
    rawPathParams,
  );
  if (route.pathSchema) {
    const result = route.pathSchema.safeParse(pathParams);
    if (!result.success) {
      sendProblem(res, 400, 'Invalid path parameters', result.error.issues);
      return;
    }
    pathParams = result.data as Record<string, unknown>;
  }

  let query: Record<string, unknown> = coerceQueryByShape(route.querySchema, multiValuedQuery(url));
  if (route.querySchema) {
    const result = route.querySchema.safeParse(query);
    if (!result.success) {
      sendProblem(res, 400, 'Invalid query parameters', result.error.issues);
      return;
    }
    query = result.data as Record<string, unknown>;
  }

  const rawHeaders = headersToRecord(req);
  let headers: Record<string, unknown> = rawHeaders;
  if (route.headersSchema) {
    const lowercasedSchema = withLowercasedHeaderKeys(route.headersSchema);
    const coercedHeaders = coerceSingleValuedByShape(lowercasedSchema, rawHeaders);
    const result = lowercasedSchema.safeParse(coercedHeaders);
    if (!result.success) {
      sendProblem(res, 400, 'Invalid headers', result.error.issues);
      return;
    }
    headers = result.data as Record<string, unknown>;
  }

  let body: unknown;
  if (route.bodyMode === 'octet-stream') {
    body = req;
  } else if (route.bodyMode === 'json') {
    // rawJsonBody was already read above, ahead of beforeHandle.
    const raw = rawJsonBody ?? Buffer.alloc(0);
    if (raw.length === 0) {
      body = undefined;
    } else {
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        sendProblem(res, 400, 'Malformed JSON body');
        return;
      }
    }
    if (route.bodySchema) {
      const result = route.bodySchema.safeParse(body);
      if (!result.success) {
        sendProblem(res, 400, 'Invalid request body', result.error.issues);
        return;
      }
      body = result.data;
    }
  } else {
    body = undefined;
  }

  // The concrete per-package `Handlers` interface types each method
  // precisely; this generic dispatcher only ever sees it structurally, so
  // the lookup is cast once at this one boundary rather than threading an
  // unsound generic through the public signature.
  const handler = (handlers as Record<string, AnyHandler>)[route.id];
  if (!handler) {
    // A route without a matching handler means generation produced an
    // inconsistent package (the completeness guard should have caught this
    // first); fail loudly rather than serve a silent 404 for a documented
    // operation.
    throw new Error(`No handler registered for operation "${route.id}"`);
  }

  const response = await handler({ path: pathParams, query, headers, body }, { rawRequest: req });

  if (validateResponses) {
    const schema = route.responseSchemas?.[response.status];
    if (schema) {
      const result = schema.safeParse(response.body);
      if (!result.success) {
        throw new Error(
          `Handler for "${route.id}" returned a status ${String(response.status)} body that fails its schema: ${result.error.message}`,
        );
      }
    }
  }

  res.writeHead(response.status, { 'content-type': 'application/json', ...response.headers });
  res.end(response.body === undefined ? undefined : JSON.stringify(response.body));
}

/**
 * Builds a `node:http` request listener that dispatches to `handlers` by
 * matching `routes`. `Handlers` is typed loosely here (each method takes an
 * untyped request) so this stays generic; the package's own generated
 * `Handlers` interface is what gives a consumer full type safety when it
 * implements the interface.
 */
export function createRequestListener(
  handlers: object,
  routes: readonly RouteDefinition[],
  options: ListenerOptions = {},
): (req: IncomingMessage, res: ServerResponse) => void {
  const validateResponses = options.validateResponses ?? true;
  return (req: IncomingMessage, res: ServerResponse) => {
    void handleRequest(req, res, handlers, routes, validateResponses, options).catch(
      (error: unknown) => {
        options.onError?.(error, req);
        if (!res.headersSent) {
          sendProblem(res, 500, 'Internal Server Error');
        }
      },
    );
  };
}
