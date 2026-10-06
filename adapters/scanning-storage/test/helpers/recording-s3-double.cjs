'use strict';

// A recording S3 double, run inside a container from
// the Ghost image (which carries node) so Ghost reaches both by container name
// over a user-defined network.
//
// S3 side (port 9090, path-style): stores objects in memory, answers the
// calls Ghost's S3Storage makes, and records every request it receives as a
// "shape" plus the signing facts a gateway would judge. It never checks a
// signature. Any request it cannot classify is recorded as UNKNOWN, never
// refused, so the test sees what Ghost really sent.
//
// Control endpoints live under /__control/ on the S3 port, outside any bucket:
//   GET  /__control/requests          the recorded requests, as JSON
//   POST /__control/fail-parts/on|off  make UploadPart answer 500 (abort path)
//

const http = require('node:http');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const BUCKET = process.env.DOUBLE_BUCKET || 'recording-double';
const requests = [];
const objects = new Map();
const uploads = new Map();
let failParts = false;

function classify(method, pathname, query) {
  const keyed = pathname.split('/').filter(Boolean).length > 1;
  if (!keyed) {
    return method === 'GET' ? 'ListObjects' : `UNKNOWN ${method} bucket-level`;
  }
  if (method === 'PUT' && query.has('partNumber') && query.has('uploadId')) return 'UploadPart';
  if (method === 'PUT' && query.size === 0) return 'PutObject';
  if (method === 'POST' && query.has('uploads')) return 'CreateMultipartUpload';
  if (method === 'POST' && query.has('uploadId')) return 'CompleteMultipartUpload';
  if (method === 'DELETE' && query.has('uploadId')) return 'AbortMultipartUpload';
  if (method === 'DELETE' && query.size === 0) return 'DeleteObject';
  if (method === 'HEAD' && query.size === 0) return 'HeadObject';
  if (method === 'GET' && query.size === 0) return 'GetObject';
  return `UNKNOWN ${method} ?${[...query.keys()].sort().join('&')}`;
}

function describeSigning(req, query) {
  const h = req.headers;
  const auth = h.authorization || '';
  return {
    authScheme: auth.split(' ')[0] || null,
    presigned: query.has('X-Amz-Signature') || query.has('X-Amz-Algorithm'),
    payloadHash: h['x-amz-content-sha256']
      ? /^[0-9a-f]{64}$/.test(h['x-amz-content-sha256'])
        ? 'signed-sha256'
        : h['x-amz-content-sha256']
      : null,
    transferEncoding: h['transfer-encoding'] || null,
    contentEncoding: h['content-encoding'] || null,
    hasContentLength: h['content-length'] !== undefined,
    crc32Header: h['x-amz-checksum-crc32'] !== undefined,
    checksumAlgorithmHeader:
      h['x-amz-sdk-checksum-algorithm'] || h['x-amz-checksum-algorithm'] || null,
    trailerHeader: h['x-amz-trailer'] || null,
    expect: h.expect || null,
  };
}

function xml(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/xml' });
  res.end(`<?xml version="1.0" encoding="UTF-8"?>${body}`);
}

function noSuchKey(res, method) {
  if (method === 'HEAD') {
    res.writeHead(404);
    return res.end();
  }
  return xml(res, 404, '<Error><Code>NoSuchKey</Code><Message>missing</Message></Error>');
}

const s3 = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://double');
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);

    if (url.pathname.startsWith('/__control/')) {
      if (url.pathname === '/__control/requests') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(requests));
      }
      if (url.pathname === '/__control/fail-parts/on') failParts = true;
      if (url.pathname === '/__control/fail-parts/off') failParts = false;
      res.writeHead(200);
      return res.end('ok');
    }

    // Create-bucket is the harness's own call, not Ghost's.
    if (req.method === 'PUT' && url.pathname === `/${BUCKET}`) {
      res.writeHead(200);
      return res.end();
    }

    // The SDK tags every request with the operation name in `x-id`. It is
    // recorded for the reader but plays no part in classifying, so a shape is
    // judged by what a gateway can see in method, path and query alone.
    const xId = url.searchParams.get('x-id');
    url.searchParams.delete('x-id');
    const shape = classify(req.method, url.pathname, url.searchParams);
    requests.push({
      seq: requests.length,
      shape,
      method: req.method,
      path: url.pathname,
      queryKeys: [...url.searchParams.keys()].sort(),
      xId,
      bodyBytes: body.length,
      signing: describeSigning(req, url.searchParams),
    });

    const key = decodeURIComponent(url.pathname.split('/').slice(2).join('/'));
    switch (shape) {
      case 'PutObject':
        objects.set(key, body);
        res.writeHead(200, { etag: `"${crypto.createHash('md5').update(body).digest('hex')}"` });
        return res.end();
      case 'CreateMultipartUpload': {
        const id = crypto.randomBytes(8).toString('hex');
        uploads.set(id, { key, parts: new Map() });
        return xml(
          res,
          200,
          `<InitiateMultipartUploadResult><Bucket>${BUCKET}</Bucket><Key>${key}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`
        );
      }
      case 'UploadPart': {
        if (failParts) {
          return xml(
            res,
            500,
            '<Error><Code>InternalError</Code><Message>forced</Message></Error>'
          );
        }
        const upload = uploads.get(url.searchParams.get('uploadId'));
        if (upload) upload.parts.set(Number(url.searchParams.get('partNumber')), body);
        res.writeHead(200, { etag: `"${crypto.createHash('md5').update(body).digest('hex')}"` });
        return res.end();
      }
      case 'CompleteMultipartUpload': {
        const upload = uploads.get(url.searchParams.get('uploadId'));
        if (upload) {
          const ordered = [...upload.parts.entries()].sort((a, b) => a[0] - b[0]).map((p) => p[1]);
          objects.set(upload.key, Buffer.concat(ordered));
        }
        return xml(
          res,
          200,
          `<CompleteMultipartUploadResult><Bucket>${BUCKET}</Bucket><Key>${key}</Key><ETag>"done"</ETag></CompleteMultipartUploadResult>`
        );
      }
      case 'AbortMultipartUpload':
        uploads.delete(url.searchParams.get('uploadId'));
        res.writeHead(204);
        return res.end();
      case 'DeleteObject':
        objects.delete(key);
        res.writeHead(204);
        return res.end();
      case 'HeadObject':
      case 'GetObject': {
        const object = objects.get(key);
        if (!object) return noSuchKey(res, req.method);
        res.writeHead(200, {
          'content-length': object.length,
          'content-type': 'application/octet-stream',
        });
        return res.end(req.method === 'HEAD' ? undefined : object);
      }
      default:
        return xml(
          res,
          501,
          '<Error><Code>NotImplemented</Code><Message>unexpected shape</Message></Error>'
        );
    }
  });
});

// A distinct, valid PNG, so a test can hold or upload bytes no other scenario uses.
function tinyPng(seed) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.concat(
    [0, 1].map((row) => Buffer.from([0, seed, row * 40, 90, seed, 20, 60]))
  );
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

if (require.main === module) {
  s3.listen(9090, '0.0.0.0');
}

module.exports = { tinyPng, classify };
