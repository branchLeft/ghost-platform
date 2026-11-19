'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { TlsIdentityError } = require('./tls-identity-error');

// The host end's own TLS identity: an ECDSA P-256 key and a self-signed
// certificate, made on first start. Nothing outside the host trusts a name or
// a certificate authority; the safety service is meant to trust the pin, which
// is the SHA-256 of the certificate's SubjectPublicKeyInfo. The certificate is
// public data derived from the key, so it is rebuilt if only the key survives;
// a certificate with no key is never replaced silently, because that is a
// host whose key went missing, not a first start.

const KEY_FILE_MODE = 0o600;
const CERTIFICATE_FILE_MODE = 0o644;
const MAX_FILE_BYTES = 64 * 1024;
const BACKDATE_MS = 24 * 60 * 60 * 1000;
const VALIDITY_YEARS = 10;
const SUBJECT_COMMON_NAME = 'verdict-host';

// A FIFO would block an ordinary open, a symbolic link would redirect it, a
// device could become the terminal: each is refused after the open, by fstat.
const READ_FLAGS =
  fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK | fs.constants.O_NOCTTY;
const NEW_FILE_FLAGS =
  fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;

// ---- DER ------------------------------------------------------------------

const TAG = {
  boolean: 0x01,
  integer: 0x02,
  bitString: 0x03,
  octetString: 0x04,
  objectIdentifier: 0x06,
  utf8String: 0x0c,
  utcTime: 0x17,
  generalizedTime: 0x18,
  sequence: 0x30,
  set: 0x31,
  versionField: 0xa0,
  extensionsField: 0xa3,
};
const OID_ECDSA_WITH_SHA256 = Buffer.from('2a8648ce3d040302', 'hex');
const OID_COMMON_NAME = Buffer.from('550403', 'hex');
const OID_BASIC_CONSTRAINTS = Buffer.from('551d13', 'hex');
const OID_KEY_USAGE = Buffer.from('551d0f', 'hex');

function encodeLength(length) {
  if (length < 0x80) return Buffer.from([length]);
  const bytes = [];
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function encode(tag, ...contents) {
  const body = Buffer.concat(contents);
  return Buffer.concat([Buffer.from([tag]), encodeLength(body.length), body]);
}

function encodeTime(date) {
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  const year = date.getUTCFullYear();
  const rest =
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) +
    'Z';
  if (year >= 1950 && year < 2050) return encode(TAG.utcTime, Buffer.from(pad(year % 100) + rest));
  return encode(TAG.generalizedTime, Buffer.from(pad(year, 4) + rest));
}

// A positive INTEGER with no leading zero byte: the top two bits are fixed,
// which leaves 126 random bits.
function randomSerial() {
  const bytes = crypto.randomBytes(16);
  bytes[0] = (bytes[0] & 0x3f) | 0x40;
  return encode(TAG.integer, bytes);
}

function encodeExtension(oid, valueDer) {
  return encode(
    TAG.sequence,
    encode(TAG.objectIdentifier, oid),
    encode(TAG.boolean, Buffer.from([0xff])),
    encode(TAG.octetString, valueDer)
  );
}

function encodeToBeSigned(subjectPublicKeyInfo, now) {
  const algorithm = encode(TAG.sequence, encode(TAG.objectIdentifier, OID_ECDSA_WITH_SHA256));
  const name = encode(
    TAG.sequence,
    encode(
      TAG.set,
      encode(
        TAG.sequence,
        encode(TAG.objectIdentifier, OID_COMMON_NAME),
        encode(TAG.utf8String, Buffer.from(SUBJECT_COMMON_NAME))
      )
    )
  );
  const notBefore = new Date(now - BACKDATE_MS);
  const notAfter = new Date(now);
  notAfter.setUTCFullYear(notAfter.getUTCFullYear() + VALIDITY_YEARS);
  // basicConstraints with CA false (the empty SEQUENCE), and keyUsage with only
  // digitalSignature, which is the bit a TLS 1.3 ECDSA server certificate needs.
  const extensions = encode(
    TAG.sequence,
    encodeExtension(OID_BASIC_CONSTRAINTS, encode(TAG.sequence)),
    encodeExtension(OID_KEY_USAGE, encode(TAG.bitString, Buffer.from([0x07, 0x80])))
  );
  const tbs = encode(
    TAG.sequence,
    encode(TAG.versionField, encode(TAG.integer, Buffer.from([0x02]))),
    randomSerial(),
    algorithm,
    name,
    encode(TAG.sequence, encodeTime(notBefore), encodeTime(notAfter)),
    name,
    subjectPublicKeyInfo,
    encode(TAG.extensionsField, extensions)
  );
  return { tbs, algorithm };
}

function buildCertificate(privateKey, now) {
  const subjectPublicKeyInfo = crypto
    .createPublicKey(privateKey)
    .export({ type: 'spki', format: 'der' });
  const { tbs, algorithm } = encodeToBeSigned(subjectPublicKeyInfo, now);
  const signature = crypto.sign('sha256', tbs, { key: privateKey, dsaEncoding: 'der' });
  const der = encode(
    TAG.sequence,
    tbs,
    algorithm,
    encode(TAG.bitString, Buffer.from([0x00]), signature)
  );
  return new crypto.X509Certificate(der).toString();
}

// ---- the pin --------------------------------------------------------------

function parseCertificate(certificatePem, file) {
  try {
    return new crypto.X509Certificate(certificatePem);
  } catch (cause) {
    throw new TlsIdentityError(
      'certificate-unreadable',
      `the TLS certificate${file === undefined ? '' : ` ${file}`} is not a readable certificate`,
      { cause }
    );
  }
}

function subjectPublicKeyInfoOf(publicKey) {
  return publicKey.export({ type: 'spki', format: 'der' });
}

/**
 * The pin of a certificate: SHA-256 over its SubjectPublicKeyInfo DER, as 64
 * lowercase hex characters.
 * @param {string} certificatePem
 * @returns {string}
 * @throws {TlsIdentityError} reason `certificate-unreadable` when the text is not a certificate.
 */
function computeSubjectPublicKeyPin(certificatePem) {
  const certificate = parseCertificate(certificatePem);
  return crypto
    .createHash('sha256')
    .update(subjectPublicKeyInfoOf(certificate.publicKey))
    .digest('hex');
}

// ---- files ----------------------------------------------------------------

function requireDirectory(file) {
  const directory = path.dirname(file);
  let isDirectory = false;
  try {
    isDirectory = fs.statSync(directory).isDirectory();
  } catch (cause) {
    throw new TlsIdentityError(
      'missing-directory',
      `the directory ${directory} for ${file} cannot be read`,
      { cause }
    );
  }
  if (!isDirectory) {
    throw new TlsIdentityError('missing-directory', `${directory} is not a directory`);
  }
}

function openForReading(file, label) {
  try {
    return fs.openSync(file, READ_FLAGS);
  } catch (cause) {
    if (cause.code === 'ENOENT') return null;
    const reason = cause.code === 'ELOOP' ? 'not-regular-file' : `${label}-unreadable`;
    throw new TlsIdentityError(reason, `the TLS ${label} file ${file} cannot be opened`, { cause });
  }
}

// Returns the file's text, or null when there is no file. The checks are on
// the open descriptor, so what was checked is what is read.
function readExisting(file, label, { requirePrivate }) {
  const descriptor = openForReading(file, label);
  if (descriptor === null) return null;
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) {
      throw new TlsIdentityError(
        'not-regular-file',
        `the TLS ${label} file ${file} is not a regular file`
      );
    }
    if (requirePrivate && (stat.mode & 0o077) !== 0) {
      throw new TlsIdentityError(
        'key-permissions',
        `the TLS key file ${file} is readable by group or others; it must be mode 0600`
      );
    }
    if (stat.size > MAX_FILE_BYTES) {
      throw new TlsIdentityError('not-regular-file', `the TLS ${label} file ${file} is too large`);
    }
    return fs.readFileSync(descriptor, 'utf8');
  } catch (cause) {
    if (cause instanceof TlsIdentityError) throw cause;
    throw new TlsIdentityError(
      `${label}-unreadable`,
      `the TLS ${label} file ${file} cannot be read`,
      {
        cause,
      }
    );
  } finally {
    fs.closeSync(descriptor);
  }
}

function removeOwnPartialFile(file) {
  try {
    fs.unlinkSync(file);
    return '';
  } catch (cause) {
    return cause.code === 'ENOENT' ? '' : '; the partial file could not be removed';
  }
}

function writeNewFile(file, text, mode, label) {
  let descriptor = null;
  try {
    descriptor = fs.openSync(file, NEW_FILE_FLAGS, mode);
    // The umask can only narrow the mode given to open; this sets it exactly.
    fs.fchmodSync(descriptor, mode);
    fs.writeSync(descriptor, text);
    fs.fsyncSync(descriptor);
  } catch (cause) {
    const created = descriptor !== null;
    const cleanup = created ? removeOwnPartialFile(file) : '';
    throw new TlsIdentityError(
      'write-failed',
      `the TLS ${label} file ${file} could not be written${cleanup}`,
      {
        cause,
      }
    );
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

function writeCertificate(certFile, certificatePem) {
  const temporary = `${certFile}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  writeNewFile(temporary, certificatePem, CERTIFICATE_FILE_MODE, 'certificate');
  try {
    fs.renameSync(temporary, certFile);
  } catch (cause) {
    const cleanup = removeOwnPartialFile(temporary);
    throw new TlsIdentityError(
      'write-failed',
      `the TLS certificate file ${certFile} could not be put in place${cleanup}`,
      { cause }
    );
  }
}

// ---- the identity ---------------------------------------------------------

function parsePrivateKey(privateKeyPem, keyFile) {
  let privateKey;
  try {
    privateKey = crypto.createPrivateKey(privateKeyPem);
  } catch (cause) {
    throw new TlsIdentityError(
      'key-unreadable',
      `the TLS key file ${keyFile} is not a readable private key; remove the key and certificate files to start over`,
      { cause }
    );
  }
  const isP256 =
    privateKey.asymmetricKeyType === 'ec' &&
    privateKey.asymmetricKeyDetails?.namedCurve === 'prime256v1';
  if (!isP256) {
    throw new TlsIdentityError('key-type', `the TLS key file ${keyFile} is not an ECDSA P-256 key`);
  }
  return privateKey;
}

function requireMatchingKey(certificate, privateKey, { certFile, keyFile }) {
  const fromCertificate = subjectPublicKeyInfoOf(certificate.publicKey);
  const fromKey = subjectPublicKeyInfoOf(crypto.createPublicKey(privateKey));
  if (!fromCertificate.equals(fromKey)) {
    throw new TlsIdentityError(
      'key-mismatch',
      `the TLS certificate ${certFile} was not made for the key ${keyFile}`
    );
  }
}

function requireUnexpired(certificate, certFile, nowMs) {
  const expiresAt = Date.parse(certificate.validTo);
  if (Number.isNaN(expiresAt)) {
    throw new TlsIdentityError(
      'certificate-unreadable',
      `the TLS certificate ${certFile} has no readable end date`
    );
  }
  if (expiresAt <= nowMs) {
    throw new TlsIdentityError(
      'certificate-expired',
      `the TLS certificate ${certFile} has expired; remove the key and certificate files to make a new identity (the pin changes)`
    );
  }
}

function identityOf(certificatePem, privateKeyPem) {
  return { certificatePem, privateKeyPem, pin: computeSubjectPublicKeyPin(certificatePem) };
}

// Both are built before anything is written, so a failure leaves no file.
function makeIdentity({ certFile, keyFile, nowMs }) {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const certificatePem = buildCertificate(privateKey, nowMs);
  writeNewFile(keyFile, privateKeyPem, KEY_FILE_MODE, 'key');
  writeCertificate(certFile, certificatePem);
  return identityOf(certificatePem, privateKeyPem);
}

/**
 * Makes or reuses the host end's TLS identity. The directories of both files
 * must exist. Never overwrites an existing file; never writes the private key
 * anywhere but its own file.
 * @param {{certFile: string, keyFile: string, now?: () => number}} options
 * @returns {{certificatePem: string, privateKeyPem: string, pin: string}}
 * @throws {TlsIdentityError} reasons: `missing-directory`, `certificate-without-key`,
 *   `not-regular-file`, `key-permissions`, `key-unreadable`, `key-type`,
 *   `certificate-unreadable`, `key-mismatch`, `certificate-expired`, `write-failed`.
 */
function ensureTlsIdentity({ certFile, keyFile, now = Date.now }) {
  requireDirectory(certFile);
  requireDirectory(keyFile);
  const existingKey = readExisting(keyFile, 'key', { requirePrivate: true });
  const existingCertificate = readExisting(certFile, 'certificate', { requirePrivate: false });
  if (existingKey === null && existingCertificate !== null) {
    throw new TlsIdentityError(
      'certificate-without-key',
      `the TLS certificate ${certFile} exists but its key ${keyFile} does not; it will not be replaced silently`
    );
  }
  if (existingKey === null) return makeIdentity({ certFile, keyFile, nowMs: now() });

  const privateKey = parsePrivateKey(existingKey, keyFile);
  if (existingCertificate === null) {
    const certificatePem = buildCertificate(privateKey, now());
    writeCertificate(certFile, certificatePem);
    return identityOf(certificatePem, existingKey);
  }
  const certificate = parseCertificate(existingCertificate, certFile);
  requireMatchingKey(certificate, privateKey, { certFile, keyFile });
  requireUnexpired(certificate, certFile, now());
  return identityOf(existingCertificate, existingKey);
}

module.exports = { ensureTlsIdentity, computeSubjectPublicKeyPin };
