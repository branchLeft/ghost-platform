import { argon2 } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { validate, type ZoneConfig } from '@branchleft/ghost-platform-render-core';
import { SLOT_IMAGE_REF } from '../../src/controlPlaneSlotImagePush.js';
import { mintGateHash, renderSlot0Descriptor, Slot0InputError } from '../../src/slot0Descriptor.js';

const DIGEST = `sha256:8c9f2dc488c03454609e6573674f10f27ca162a440ff3f5910eaab48bafd9f3d`;
const ZONES: ZoneConfig = {
  demoZone: 'demo.trypublicpress.co.uk',
  platformZone: 'sites.publicpress.co.uk',
  ownedDomains: ['demo.trypublicpress.co.uk', 'publicpress.co.uk'],
  demoMailDomain: 'demo.trypublicpress.co.uk',
};
const HASH =
  '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0c2FsdA$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaA';

function input(overrides: Partial<Parameters<typeof renderSlot0Descriptor>[0]> = {}) {
  return {
    imageDigest: DIGEST,
    ownerEmail: 'owner@example.test',
    gateArgon2idHash: HASH,
    expiresAt: '2027-01-31T00:00:00.000Z',
    zones: ZONES,
    ...overrides,
  };
}

describe('renderSlot0Descriptor', () => {
  it('renders a demo descriptor on slot 0 that validate() accepts', () => {
    const d = renderSlot0Descriptor(input());
    expect(() => validate(d, ZONES)).not.toThrow();
    expect(d.kind).toBe('demo');
    expect(d.slug).toBe('slot-0');
    expect(d.siteUrl).toBe('https://slot-0.demo.trypublicpress.co.uk');
    expect(d.uid).toBe(30001);
    expect(d.ports).toEqual({ a: 9300, b: 9301, health: 10100 });
    expect(d.appHostIp).toBe('10.20.1.50');
  });

  it('pins the image to the pushed digest under the slot image name', () => {
    const d = renderSlot0Descriptor(input());
    expect(d.image).toBe(`${SLOT_IMAGE_REF}@${DIGEST}`);
  });

  it('keeps mail off', () => {
    const d = renderSlot0Descriptor(input());
    expect(d.mail.enabled).toBe(false);
  });

  it('refuses a digest that is not sha256 of 64 lowercase hex', () => {
    expect(() => renderSlot0Descriptor(input({ imageDigest: 'sha256:ABC' }))).toThrow(
      Slot0InputError
    );
    expect(() => renderSlot0Descriptor(input({ imageDigest: 'latest' }))).toThrow(Slot0InputError);
  });

  it('refuses a descriptor render-core rejects (an empty owner address)', () => {
    expect(() => renderSlot0Descriptor(input({ ownerEmail: 'not-an-address' }))).toThrow();
  });
});

describe('mintGateHash', () => {
  it('mints a PHC string that re-derives to the same tag under its own parameters', async () => {
    const phc = await mintGateHash('correct horse battery');
    const match =
      /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/.exec(phc);
    expect(match).not.toBeNull();
    const [, m, t, p, saltB64, tagB64] = match as unknown as string[];
    const salt = Buffer.from(saltB64 as string, 'base64');
    const tag = Buffer.from(tagB64 as string, 'base64');
    const derived = await new Promise<Buffer>((resolve, reject) =>
      argon2(
        'argon2id',
        {
          message: Buffer.from('correct horse battery'),
          nonce: salt,
          parallelism: Number(p),
          tagLength: tag.length,
          memory: Number(m),
          passes: Number(t),
        },
        (err, out) => (err ? reject(err) : resolve(out))
      )
    );
    expect(derived.equals(tag)).toBe(true);
  });

  it('refuses an empty passphrase', async () => {
    await expect(mintGateHash('')).rejects.toThrow(Slot0InputError);
  });
});
