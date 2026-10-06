import { describe, expect, it } from 'vitest';
import { ALLOWED_OPERATIONS } from '../src/contracts.js';

describe('ALLOWED_OPERATIONS', () => {
  it('lists exactly the seven shapes Ghost sends, none of them an object delete or a list', () => {
    expect([...ALLOWED_OPERATIONS].sort()).toEqual(
      [
        'AbortMultipartUpload',
        'CompleteMultipartUpload',
        'CreateMultipartUpload',
        'GetObject',
        'HeadObject',
        'PutObject',
        'UploadPart',
      ].sort()
    );
    expect(ALLOWED_OPERATIONS).not.toContain('DeleteObject');
    expect(ALLOWED_OPERATIONS).not.toContain('ListObjectsV2');
  });
});
