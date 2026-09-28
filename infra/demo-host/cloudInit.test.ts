import { describe, expect, it } from 'vitest';

import { USER_DATA_LIMIT_BYTES, renderDemoHostCloudInit } from './cloudInit';

describe('renderDemoHostCloudInit', () => {
  const document = renderDemoHostCloudInit('demo1');

  it('stays far inside the user-data limit, leaving provisioning to SSH', () => {
    // A quarter of the limit: the demo host's scripts are about twice it, so
    // anything creeping up towards it is those scripts being inlined.
    expect(Buffer.byteLength(document, 'utf8')).toBeLessThan(USER_DATA_LIMIT_BYTES / 4);
    expect(USER_DATA_LIMIT_BYTES).toBe(32768);
  });

  it('is a cloud-config document naming the host', () => {
    expect(document.startsWith('#cloud-config\n')).toBe(true);
    expect(document).toMatch(/^hostname: demo1$/m);
    expect(document).toMatch(/^fqdn: demo1$/m);
  });

  it('closes SSH to passwords before the host is reachable', () => {
    expect(document).toContain('/etc/ssh/sshd_config.d/01-branchleft-hardening.conf');
    expect(document).toMatch(/^ {6}PasswordAuthentication no$/m);
    expect(document).toMatch(/^ {6}KbdInteractiveAuthentication no$/m);
    expect(document).toMatch(/^ {6}PermitRootLogin prohibit-password$/m);
  });

  it('creates no account and grants no sudo', () => {
    expect(document).not.toMatch(/^users:/m);
    expect(document).not.toContain('sudoers');
  });

  it.each(['', 'Demo1', 'demo1\nruncmd:', 'demo 1', '-demo1', 'a'.repeat(64)])(
    'refuses the hostname %j rather than write it into the document',
    (hostname) => {
      expect(() => renderDemoHostCloudInit(hostname)).toThrow(/single lower-case DNS label/);
    }
  );
});
