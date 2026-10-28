import { X509Certificate, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

/**
 * A throwaway self-signed certificate, built in memory with node:crypto alone
 * each time a test file needs one. The key never touches disk or the
 * repository. TEST ONLY: the subject says so, and it is valid for two days.
 */
export interface TestCertificate {
  readonly cert: string;
  readonly key: string;
}

export interface TestCertificateOptions {
  readonly dnsNames: readonly string[];
  readonly ipAddresses?: readonly string[];
  readonly validFrom?: Date;
  readonly validTo?: Date;
}

const DAY_MS = 86_400_000;

function lengthOf(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let value = n; value > 0; value >>= 8) bytes.unshift(value & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), lengthOf(body.length), body]);
}

const sequence = (...parts: Buffer[]): Buffer => tlv(0x30, ...parts);

function objectId(dotted: string): Buffer {
  const [first = 0, second = 0, ...rest] = dotted.split('.').map(Number);
  const out: number[] = [40 * first + second];
  for (const n of rest) {
    const chunk = [n & 0x7f];
    for (let value = n >> 7; value > 0; value >>= 7) chunk.unshift((value & 0x7f) | 0x80);
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}

function generalizedTime(date: Date): Buffer {
  const text = date.toISOString().replace(/[-:T]|\.\d{3}/g, '');
  return tlv(0x18, Buffer.from(text, 'ascii'));
}

function nameOf(commonName: string): Buffer {
  return sequence(tlv(0x31, sequence(objectId('2.5.4.3'), tlv(0x0c, Buffer.from(commonName)))));
}

export function generateTestCertificate(options: TestCertificateOptions): TestCertificate {
  const now = Date.now();
  const validFrom = options.validFrom ?? new Date(now - DAY_MS);
  const validTo = options.validTo ?? new Date(now + DAY_MS);
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const serial = randomBytes(16);
  serial[0] = ((serial[0] ?? 0) & 0x7f) | 0x01;

  const signatureAlgorithm = sequence(objectId('1.2.840.10045.4.3.2'));
  const names = sequence(
    ...options.dnsNames.map((name) => tlv(0x82, Buffer.from(name))),
    ...(options.ipAddresses ?? []).map((ip) => tlv(0x87, Buffer.from(ip.split('.').map(Number))))
  );
  const extensions = tlv(
    0xa3,
    sequence(
      sequence(
        objectId('2.5.29.19'),
        tlv(0x01, Buffer.from([0xff])),
        tlv(0x04, sequence(tlv(0x01, Buffer.from([0xff]))))
      ),
      sequence(objectId('2.5.29.17'), tlv(0x04, names))
    )
  );
  const subject = nameOf('TEST ONLY');
  const toBeSigned = sequence(
    tlv(0xa0, tlv(0x02, Buffer.from([0x02]))),
    tlv(0x02, serial),
    signatureAlgorithm,
    subject,
    sequence(generalizedTime(validFrom), generalizedTime(validTo)),
    subject,
    publicKey.export({ type: 'spki', format: 'der' }),
    extensions
  );
  const signature = sign('sha256', toBeSigned, { key: privateKey, dsaEncoding: 'der' });
  const der = sequence(toBeSigned, signatureAlgorithm, tlv(0x03, Buffer.from([0x00]), signature));
  const lines = der.toString('base64').match(/.{1,64}/g) ?? [];
  return {
    cert: `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`,
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

/** The certificate parses, names `host` and is inside its validity window right now. */
export function certificateIsUsableFor(cert: string, host: string, at: Date = new Date()): boolean {
  const parsed = new X509Certificate(cert);
  return (
    new Date(parsed.validFrom) <= at &&
    at <= new Date(parsed.validTo) &&
    parsed.checkHost(host) !== undefined
  );
}
