/** demo1's first-boot user-data: its name and SSH closed to passwords, and
 * nothing more. Why so little: README.md, "First-boot user-data". */

/** Hetzner's documented user-data ceiling, asserted by the tests. */
export const USER_DATA_LIMIT_BYTES = 32 * 1024;

const HOSTNAME = /^[a-z][a-z0-9-]{0,62}$/;

export function renderDemoHostCloudInit(hostname: string): string {
  if (!HOSTNAME.test(hostname)) {
    throw new Error(
      `hostname must be a single lower-case DNS label, got ${JSON.stringify(hostname)}`
    );
  }
  return `#cloud-config
hostname: ${hostname}
preserve_hostname: false
fqdn: ${hostname}
disable_root: false

write_files:
  # The 01- prefix is load-bearing: OpenSSH keeps the first value it reads for
  # a keyword, and the Include glob expands in sort order, so this drop-in
  # wins over the 50-cloud-init.conf cloud-init writes for itself.
  - path: /etc/ssh/sshd_config.d/01-branchleft-hardening.conf
    owner: root:root
    permissions: '0644'
    content: |
      PasswordAuthentication no
      KbdInteractiveAuthentication no
      PermitRootLogin prohibit-password
      PubkeyAuthentication yes

package_update: true
packages:
  - ca-certificates
  - curl
  - gnupg

runcmd:
  - [ install, -d, -m, '0755', -o, root, -g, root, /etc/branchleft ]
  - [ install, -d, -m, '0755', -o, root, -g, root, /opt/branchleft ]
  - [ /usr/sbin/sshd, -t ]
  - [ systemctl, reload, ssh ]
`;
}
