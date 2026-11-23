import { describe, expect, it } from 'vitest';
import { renderSlot0Descriptor } from '../../src/slot0Descriptor.js';
import { RECONCILE_PATH, signedReconcileRequest } from '../../src/reconcileRequest.js';
import { signingPayload, verifySignature } from '../../src/signing.js';
import { generateTestKeyPair } from '../helpers/signer.js';

const descriptor = renderSlot0Descriptor({
  imageDigest: `sha256:${'8c9f2dc488c03454609e6573674f10f27ca162a440ff3f5910eaab48bafd9f3d'}`,
  ownerEmail: 'owner@example.test',
  gateArgon2idHash:
    '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0c2FsdA$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaA',
  expiresAt: '2027-01-31T00:00:00.000Z',
  zones: {
    demoZone: 'demo.trypublicpress.co.uk',
    platformZone: 'sites.publicpress.co.uk',
    ownedDomains: ['demo.trypublicpress.co.uk', 'publicpress.co.uk'],
    demoMailDomain: 'demo.trypublicpress.co.uk',
  },
});

describe('signedReconcileRequest', () => {
  it('signs the exact body bytes the broker will read, for POST /reconcile', () => {
    const keys = generateTestKeyPair();
    const req = signedReconcileRequest({
      slot: '0',
      descriptor,
      privateKeyRaw: keys.privateKeyRaw,
      nowSeconds: 1_800_000_000,
      nonce: 'n'.repeat(32),
    });
    const ok = verifySignature(
      keys.publicKeyRaw,
      'POST',
      RECONCILE_PATH,
      req.headers['X-Broker-Timestamp'] as string,
      req.headers['X-Broker-Nonce'] as string,
      req.body,
      req.headers['X-Broker-Signature'] as string
    );
    expect(ok).toBe(true);
    expect(JSON.parse(req.body.toString('utf8'))).toEqual({ slot: '0', descriptor });
    expect(req.headers['Content-Length']).toBe(String(req.body.length));
  });

  it('refuses the signature once one byte of the body changes', () => {
    const keys = generateTestKeyPair();
    const req = signedReconcileRequest({
      slot: '0',
      descriptor,
      privateKeyRaw: keys.privateKeyRaw,
      nowSeconds: 1_800_000_000,
      nonce: 'n'.repeat(32),
    });
    const tampered = Buffer.from(req.body.toString('utf8').replace('"slot":"0"', '"slot":"1"'));
    const ok = verifySignature(
      keys.publicKeyRaw,
      'POST',
      RECONCILE_PATH,
      req.headers['X-Broker-Timestamp'] as string,
      req.headers['X-Broker-Nonce'] as string,
      tampered,
      req.headers['X-Broker-Signature'] as string
    );
    expect(ok).toBe(false);
    expect(signingPayload('POST', RECONCILE_PATH, '1', 'n', req.body).length).toBeGreaterThan(0);
  });
});
