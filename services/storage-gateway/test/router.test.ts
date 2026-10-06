import { describe, expect, it } from 'vitest';
import type { CredentialRecord, GatewayRequest } from '../src/contracts.js';
import { guardTenant, routeRequest } from '../src/router.js';

const BUCKET = 'shard-one-bucket';
const FOLDER = 'k7f3q9x2m1';

const req = (
  method: string,
  rawTarget: string,
  headers: GatewayRequest['headers'] = {}
): GatewayRequest => ({ method, rawTarget, headers });

const credential: CredentialRecord = { folder: FOLDER, bucket: BUCKET, state: 'active' };

/** Routes, then applies the folder guard, as `admit` does; returns the refusal code or `ok`. */
function verdict(request: GatewayRequest, cred: CredentialRecord = credential): string {
  const routed = routeRequest(request);
  if (!routed.ok) return routed.refusal.code;
  return guardTenant(routed.route, cred)?.code ?? 'ok';
}

const key = `${FOLDER}/2026/10/image.png`;

describe('routeRequest: the seven allowed shapes', () => {
  it.each([
    ['PUT', `/${BUCKET}/${key}`, 'PutObject'],
    ['PUT', `/${BUCKET}/${key}?x-id=PutObject`, 'PutObject'],
    ['POST', `/${BUCKET}/${key}?uploads`, 'CreateMultipartUpload'],
    ['POST', `/${BUCKET}/${key}?uploads=&x-id=CreateMultipartUpload`, 'CreateMultipartUpload'],
    ['PUT', `/${BUCKET}/${key}?partNumber=3&uploadId=abc`, 'UploadPart'],
    ['PUT', `/${BUCKET}/${key}?x-id=UploadPart&partNumber=10000&uploadId=abc`, 'UploadPart'],
    ['POST', `/${BUCKET}/${key}?uploadId=abc`, 'CompleteMultipartUpload'],
    [
      'POST',
      `/${BUCKET}/${key}?x-id=CompleteMultipartUpload&uploadId=abc`,
      'CompleteMultipartUpload',
    ],
    ['DELETE', `/${BUCKET}/${key}?uploadId=abc`, 'AbortMultipartUpload'],
    ['HEAD', `/${BUCKET}/${key}`, 'HeadObject'],
    ['HEAD', `/${BUCKET}/${key}?x-id=HeadObject`, 'HeadObject'],
    ['GET', `/${BUCKET}/${key}`, 'GetObject'],
    ['GET', `/${BUCKET}/${key}?x-id=GetObject`, 'GetObject'],
  ])('%s %s is %s', (method, target, operation) => {
    const result = routeRequest(req(method, target));
    expect(result).toMatchObject({ ok: true, route: { operation, bucket: BUCKET, key } });
    expect(verdict(req(method, target))).toBe('ok');
  });

  it('carries the upload id and part number through', () => {
    const result = routeRequest(req('PUT', `/${BUCKET}/${key}?partNumber=7&uploadId=2~abc.def`));
    expect(result).toMatchObject({ ok: true, route: { uploadId: '2~abc.def', partNumber: 7 } });
  });

  it('decodes an ordinary percent-encoded space and non-ASCII letter once', () => {
    const result = routeRequest(req('GET', `/${BUCKET}/${FOLDER}/my%20photo-%C3%A9.png`));
    expect(result).toMatchObject({ ok: true, route: { key: `${FOLDER}/my photo-é.png` } });
  });

  it('allows a name that merely contains dots', () => {
    expect(verdict(req('GET', `/${BUCKET}/${FOLDER}/a..b/.hidden/v1.2.3.png`))).toBe('ok');
  });
});

describe('routeRequest: operations that are refused', () => {
  it.each([
    ['DELETE', `/${BUCKET}/${key}`, 'object delete'],
    ['DELETE', `/${BUCKET}/${key}?versionId=1`, 'versioned delete'],
    ['DELETE', `/${BUCKET}/${key}?uploadId=abc&versionId=1`, 'abort with an extra parameter'],
    ['POST', `/${BUCKET}?delete`, 'multi-object delete'],
    ['POST', `/${BUCKET}/${key}?delete`, 'multi-object delete on an object path'],
    ['GET', `/${BUCKET}`, 'list at the bucket'],
    ['GET', `/${BUCKET}/`, 'list at the bucket with a slash'],
    ['GET', `/${BUCKET}?list-type=2&prefix=${FOLDER}`, 'list v2'],
    ['GET', `/${BUCKET}/${key}?uploads`, 'list multipart uploads'],
    ['GET', `/${BUCKET}/${key}?uploadId=abc`, 'list parts'],
    ['GET', `/${BUCKET}/${key}?versionId=1`, 'get a version'],
    ['GET', `/${BUCKET}/${key}?acl`, 'get acl'],
    ['PUT', `/${BUCKET}/${key}?acl`, 'put acl'],
    ['GET', `/${BUCKET}/${key}?tagging`, 'get tagging'],
    ['GET', `/${BUCKET}/${key}?response-content-type=text/html`, 'response override'],
    ['PUT', `/${BUCKET}`, 'create bucket'],
    ['PUT', `/${BUCKET}/${key}?partNumber=1`, 'part number with no upload id'],
    ['PUT', `/${BUCKET}/${key}?uploadId=abc`, 'put with only an upload id'],
    ['POST', `/${BUCKET}/${key}`, 'post with no query'],
    ['POST', `/${BUCKET}/${key}?uploads=1`, 'create multipart with a value'],
    ['POST', `/${BUCKET}/${key}?uploads&uploadId=abc`, 'mixed multipart parameters'],
    ['PUT', `/${BUCKET}/${key}?x-id=DeleteObject`, 'a marker naming another operation'],
    ['GET', `/${BUCKET}/${key}?x-id=PutObject`, 'a marker naming another operation on get'],
    ['PATCH', `/${BUCKET}/${key}`, 'PATCH'],
    ['OPTIONS', `/${BUCKET}/${key}`, 'OPTIONS'],
    ['get', `/${BUCKET}/${key}`, 'a lower-case method'],
    ['', `/${BUCKET}/${key}`, 'an empty method'],
  ])('%s %s (%s)', (method, target) => {
    expect(verdict(req(method, target))).toBe('operation-not-allowed');
  });

  it.each(['x-amz-copy-source', 'X-Amz-Copy-Source', 'x-amz-copy-source-range'])(
    'refuses a copy through the %s header',
    (header) => {
      expect(
        verdict(req('PUT', `/${BUCKET}/${key}`, { [header]: `/${BUCKET}/other-folder/secret.png` }))
      ).toBe('operation-not-allowed');
      expect(
        verdict(req('PUT', `/${BUCKET}/${key}?partNumber=1&uploadId=a`, { [header]: '/b/k' }))
      ).toBe('operation-not-allowed');
    }
  );
});

describe('routeRequest: malformed targets', () => {
  it.each([
    ['empty', ''],
    ['no leading slash', `${BUCKET}/${key}`],
    ['too long', `/${BUCKET}/${FOLDER}/${'a'.repeat(4100)}`],
    ['raw space', `/${BUCKET}/${FOLDER}/a b.png`],
    ['raw backslash', `/${BUCKET}/${FOLDER}\\..\\other/x.png`],
    ['raw tab', `/${BUCKET}/${FOLDER}/a\tb`],
    ['raw non-ASCII', `/${BUCKET}/${FOLDER}/é.png`],
    ['raw fragment marker', `/${BUCKET}/${FOLDER}/a#b`],
    ['uppercase bucket', `/Shard/${FOLDER}/a.png`],
    ['short bucket', `/b/${FOLDER}/a.png`],
    ['bucket with doubled dots', `/shard..bucket/${FOLDER}/a.png`],
    ['double separator inside the key', `/${BUCKET}/${FOLDER}//a.png`],
    ['double separator after the bucket', `/${BUCKET}//${FOLDER}/a.png`],
    ['double separator leading', `//${BUCKET}/${FOLDER}/a.png`],
    ['trailing separator', `/${BUCKET}/${FOLDER}/a.png/`],
    ['folder only with trailing separator', `/${BUCKET}/${FOLDER}/`],
    ['dot segment', `/${BUCKET}/${FOLDER}/./a.png`],
    ['dot-dot segment', `/${BUCKET}/${FOLDER}/../other/a.png`],
    ['dot-dot at the end', `/${BUCKET}/${FOLDER}/a/..`],
    ['dot-dot before the bucket', `/../${BUCKET}/${FOLDER}/a.png`],
    ['encoded dot-dot', `/${BUCKET}/${FOLDER}/%2e%2e/other/a.png`],
    ['encoded dot-dot upper case', `/${BUCKET}/${FOLDER}/%2E%2E/other/a.png`],
    ['half-encoded dot-dot', `/${BUCKET}/${FOLDER}/.%2e/other/a.png`],
    ['encoded dot in a name', `/${BUCKET}/${FOLDER}/a%2eb.png`],
    ['encoded slash', `/${BUCKET}/${FOLDER}%2fother/a.png`],
    ['encoded slash upper case', `/${BUCKET}/${FOLDER}%2Fother/a.png`],
    ['encoded slash inside the key', `/${BUCKET}/${FOLDER}/..%2fother%2fa.png`],
    ['encoded backslash', `/${BUCKET}/${FOLDER}/..%5cother/a.png`],
    ['encoded backslash upper case', `/${BUCKET}/${FOLDER}/a%5Cb.png`],
    ['double-encoded dot-dot', `/${BUCKET}/${FOLDER}/%252e%252e/a.png`],
    ['double-encoded slash', `/${BUCKET}/${FOLDER}/a%252fb.png`],
    ['encoded percent', `/${BUCKET}/${FOLDER}/a%25b.png`],
    ['encoded NUL', `/${BUCKET}/${FOLDER}/a%00.png`],
    ['encoded newline', `/${BUCKET}/${FOLDER}/a%0Ab.png`],
    ['encoded DEL', `/${BUCKET}/${FOLDER}/a%7Fb.png`],
    ['truncated escape', `/${BUCKET}/${FOLDER}/a%2`],
    ['non-hex escape', `/${BUCKET}/${FOLDER}/a%zz.png`],
    ['overlong UTF-8 slash', `/${BUCKET}/${FOLDER}/%C0%AF`],
    ['overlong UTF-8 dot', `/${BUCKET}/${FOLDER}/%C0%AE%C0%AE/a.png`],
    ['invalid UTF-8', `/${BUCKET}/${FOLDER}/%FF.png`],
    ['encoded lone surrogate', `/${BUCKET}/${FOLDER}/%ED%A0%80.png`],
    ['fullwidth solidus', `/${BUCKET}/${FOLDER}/a%EF%BC%8Fb.png`],
    ['fullwidth full stops', `/${BUCKET}/${FOLDER}/%EF%BC%8E%EF%BC%8E/a.png`],
    ['two dot leaders', `/${BUCKET}/${FOLDER}/%E2%80%A5/a.png`],
    ['fullwidth percent', `/${BUCKET}/${FOLDER}/%EF%BC%85%EF%BC%92e.png`],
    ['fullwidth reverse solidus', `/${BUCKET}/${FOLDER}/a%EF%BC%BCb.png`],
    [
      'small reverse solidus lookalike folding to a backslash',
      `/${BUCKET}/${FOLDER}/a%EF%B9%A8b.png`,
    ],
    ['decomposed (non-NFC) letter', `/${BUCKET}/${FOLDER}/e%CC%81.png`],
    ['zero-width space', `/${BUCKET}/${FOLDER}/a%E2%80%8Bb.png`],
    ['right-to-left override', `/${BUCKET}/${FOLDER}/a%E2%80%AEb.png`],
    ['line separator', `/${BUCKET}/${FOLDER}/a%E2%80%A8b.png`],
    ['no-break space', `/${BUCKET}/${FOLDER}/a%C2%A0b.png`],
    ['key over 1024 bytes', `/${BUCKET}/${FOLDER}/${'a'.repeat(1030)}`],
    ['empty query parameter name', `/${BUCKET}/${key}?=x`],
    ['empty query token', `/${BUCKET}/${key}?uploads&`],
    ['repeated query parameter', `/${BUCKET}/${key}?uploadId=a&uploadId=b&partNumber=1`],
    ['bad escape in query', `/${BUCKET}/${key}?uploadId=%zz&partNumber=1`],
    ['control character in query value', `/${BUCKET}/${key}?uploadId=a%00b&partNumber=1`],
    ['empty upload id', `/${BUCKET}/${key}?uploadId=&partNumber=1`],
    ['zero part number', `/${BUCKET}/${key}?uploadId=a&partNumber=0`],
    ['part number over the limit', `/${BUCKET}/${key}?uploadId=a&partNumber=10001`],
    ['part number with a sign', `/${BUCKET}/${key}?uploadId=a&partNumber=%2B1`],
    ['part number with leading zero', `/${BUCKET}/${key}?uploadId=a&partNumber=01`],
    ['part number that is not a number', `/${BUCKET}/${key}?uploadId=a&partNumber=x`],
  ])('refuses %s', (_label, target) => {
    expect(verdict(req('PUT', target))).toBe('target-malformed');
  });
});

describe('guardTenant: bucket and folder', () => {
  it('refuses any bucket but the tenant’s assigned one', () => {
    expect(verdict(req('GET', `/other-shard-bucket/${key}`))).toBe('bucket-not-allowed');
    expect(verdict(req('GET', `/${BUCKET}x/${key}`))).toBe('bucket-not-allowed');
    expect(verdict(req('GET', `/x${BUCKET}/${key}`))).toBe('bucket-not-allowed');
  });

  it('refuses another tenant’s folder', () => {
    expect(verdict(req('GET', `/${BUCKET}/zzzzzzzzzz/2026/a.png`))).toBe('key-outside-folder');
    expect(verdict(req('PUT', `/${BUCKET}/zzzzzzzzzz/2026/a.png`))).toBe('key-outside-folder');
  });

  it('refuses the bucket root and a key with no folder', () => {
    expect(verdict(req('GET', `/${BUCKET}/a.png`))).toBe('key-outside-folder');
  });

  it('refuses the folder itself as an object name', () => {
    expect(verdict(req('PUT', `/${BUCKET}/${FOLDER}`))).toBe('key-outside-folder');
  });

  it('refuses a folder name that is only a prefix of the key’s first segment', () => {
    expect(verdict(req('GET', `/${BUCKET}/${FOLDER}x/a.png`))).toBe('key-outside-folder');
    expect(verdict(req('GET', `/${BUCKET}/${FOLDER.slice(0, -1)}/a.png`))).toBe(
      'key-outside-folder'
    );
  });

  it('compares the folder case-sensitively', () => {
    expect(verdict(req('GET', `/${BUCKET}/${FOLDER.toUpperCase()}/a.png`))).toBe(
      'key-outside-folder'
    );
  });

  it('refuses the folder only appearing deeper in the key', () => {
    expect(verdict(req('GET', `/${BUCKET}/other/${FOLDER}/a.png`))).toBe('key-outside-folder');
  });

  it('applies to every allowed operation', () => {
    for (const [method, query] of [
      ['PUT', ''],
      ['GET', ''],
      ['HEAD', ''],
      ['POST', '?uploads'],
      ['PUT', '?partNumber=1&uploadId=a'],
      ['POST', '?uploadId=a'],
      ['DELETE', '?uploadId=a'],
    ] as const) {
      expect(verdict(req(method, `/${BUCKET}/zzzzzzzzzz/a.png${query}`))).toBe(
        'key-outside-folder'
      );
    }
  });

  it.each([
    ['empty', ''],
    ['two segments', 'a/b'],
    ['a dot-dot', '..'],
    ['a dot', '.'],
    ['encoded text', 'a%2fb'],
    ['a backslash', 'a\\b'],
    ['a control character', 'a\u0000b'],
    ['a query marker that no segment may carry', 'a?b'],
  ])('refuses a credential whose folder is %s', (_label, folder) => {
    expect(verdict(req('GET', `/${BUCKET}/${key}`), { ...credential, folder })).toBe(
      'credential-invalid'
    );
  });

  it('refuses a credential whose bucket is not a valid bucket name', () => {
    expect(verdict(req('GET', `/${BUCKET}/${key}`), { ...credential, bucket: 'Bad Bucket' })).toBe(
      'credential-invalid'
    );
  });
});
