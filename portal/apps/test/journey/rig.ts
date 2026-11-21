import { randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CALLBACK_PATH,
  ROLE_OWNER,
  ROLE_TENANT_ADMIN,
} from 'ghost-platform-identity/dist/index.js';
import {
  createFixture,
  FIXTURE_DATABASE,
  ORG_B,
  TENANT_B,
  type Fixture,
} from '../../../data/test/helpers.js';
import { CLIENT_CONSOLE, CLIENT_PORTAL, PROJECT_ID } from '../idp.js';
import { startTestIdp, type TestIdp } from '../idpServer.js';
import { generateTestCertificate } from '../selfSignedCert.js';
import { startSmtpHarness, type SmtpHarness } from '../supportSmtpServer.js';
import {
  freePort,
  startApp,
  startMock,
  waitUntilServing,
  type AppSpec,
  type Running,
} from './processes.js';
import type { Target } from './target.js';

export const OWNER_ORG_ID = 'org-owner-journey';

/** Where an image sees the rig's files. */
const IMAGE_MOUNT = '/rig';
const LOOPBACK = '127.0.0.1';
const SMTP_ACCOUNT = 'journey-support@example.test';
const SMTP_RECIPIENT = 'journey-inbox@example.test';
/**
 * The data layer's fixture logins share one throwaway password
 * (portal/data/test/helpers.ts); the logins' names are read from its pools.
 */
const FIXTURE_LOGIN_PASSWORD = 'test-only-not-a-secret';

export interface Rig {
  readonly portalOrigin: string;
  readonly consoleOrigin: string;
  readonly idp: TestIdp;
  /** The demo tenant the journey signs in as: a DEMO row in the fixture register. */
  readonly demoTenantId: string;
  /** The mail the tenant portal sent: a real SMTP server standing in for the mail host. */
  readonly mail: SmtpHarness;
  /** What each process said so far, for a failure message. */
  logs(): string;
  close(): Promise<void>;
}

type Started = Running & { exited(): boolean };

function databaseUrl(login: string | undefined, adminUrl: string): string {
  if (login === undefined) throw new Error('the fixture pool names no login');
  const admin = new URL(adminUrl);
  const url = new URL(`postgres://${LOOPBACK}/${FIXTURE_DATABASE}`);
  url.hostname = admin.hostname;
  url.port = admin.port;
  url.username = login;
  url.password = FIXTURE_LOGIN_PASSWORD;
  return url.toString();
}

const describeLogs = (processes: readonly Started[]): string =>
  processes.map((p) => `--- ${p.name}\n${p.output()}`).join('\n');

/**
 * The journey's rig. The tenant portal and the owner console run as their own
 * processes (from the built checkout, or from the image), each configured only
 * by the variables and files it reads in production, against: the data layer's
 * fixture database (migrated by the provisioning command, a DEMO tenant in the
 * register), the HTTP test identity provider, the provisioning API mock as its
 * own process, and an SMTP server standing in for the mail host. Needs
 * `PORTAL_TEST_DATABASE_URL`, like the data-layer tests.
 */
export async function startRig(
  target: Target,
  options: { readonly allowPlaceholderCopy?: boolean } = {}
): Promise<Rig> {
  const adminUrl = process.env['PORTAL_TEST_DATABASE_URL'];
  if (adminUrl === undefined) throw new Error('PORTAL_TEST_DATABASE_URL is not set');
  const cleanups: Array<() => Promise<void>> = [];
  const processes: Started[] = [];
  const close = async (): Promise<void> => {
    for (const cleanup of cleanups.reverse()) await cleanup().catch(() => undefined);
    cleanups.length = 0;
  };
  try {
    const fixture: Fixture = await createFixture();
    cleanups.push(() => fixture.close());

    // World-readable on purpose: an image runs as its own user and must read
    // these. Everything in them is a throwaway made for this run.
    const dir = mkdtempSync(join(tmpdir(), 'journey-rig-'));
    chmodSync(dir, 0o755);
    cleanups.push(() => Promise.resolve(rmSync(dir, { recursive: true, force: true })));
    const file = (name: string, content: string): string => {
      writeFileSync(join(dir, name), content, { mode: 0o644 });
      return target.kind === 'dist' ? join(dir, name) : `${IMAGE_MOUNT}/${name}`;
    };

    const idp = await startTestIdp({
      users: [
        {
          id: 'demo-admin',
          label: 'DEMO_ADMIN',
          subject: 'journey-demo-admin',
          org: ORG_B,
          role: ROLE_TENANT_ADMIN,
        },
        {
          id: 'owner',
          label: 'OWNER',
          subject: 'journey-owner',
          org: OWNER_ORG_ID,
          role: ROLE_OWNER,
        },
      ],
      clients: [
        { clientId: CLIENT_PORTAL, redirectUris: [] },
        { clientId: CLIENT_CONSOLE, redirectUris: [] },
      ],
    });
    cleanups.push(() => idp.close());

    const certificate = generateTestCertificate({
      dnsNames: ['localhost'],
      ipAddresses: [LOOPBACK],
    });
    const smtpPassword = randomBytes(12).toString('hex');
    const mail = await startSmtpHarness({
      cert: certificate,
      security: 'starttls',
      user: SMTP_ACCOUNT,
      password: smtpPassword,
    });
    cleanups.push(() => mail.close());

    const [portalPort, consolePort, mockPort] = await Promise.all([
      freePort(),
      freePort(),
      freePort(),
    ]);
    const portalOrigin = `http://${LOOPBACK}:${String(portalPort)}`;
    const consoleOrigin = `http://${LOOPBACK}:${String(consolePort)}`;
    idp.allowRedirect(CLIENT_PORTAL, `${portalOrigin}${CALLBACK_PATH}`);
    idp.allowRedirect(CLIENT_CONSOLE, `${consoleOrigin}${CALLBACK_PATH}`);

    const tenantCredential = randomBytes(16).toString('hex');
    const ownerCredential = randomBytes(16).toString('hex');
    const mock = startMock({
      MOCK_OWNER_CREDENTIAL: ownerCredential,
      MOCK_TENANT_CREDENTIALS: `${TENANT_B}=${tenantCredential}`,
      PORT: String(mockPort),
      LISTEN_HOST: LOOPBACK,
    });
    processes.push(mock);
    cleanups.push(() => mock.stop());
    const provisioningUrl = `http://${LOOPBACK}:${String(mockPort)}`;

    const outputs = file(
      'outputs.json',
      JSON.stringify({
        ownerOrgId: OWNER_ORG_ID,
        projectId: PROJECT_ID,
        clientIds: { console: CLIENT_CONSOLE, portal: CLIENT_PORTAL },
        tenantOrgIds: { demo: ORG_B },
      })
    );
    const tenantDatabase = file(
      'tenant-database-url',
      databaseUrl(fixture.tenant.options.user, adminUrl)
    );
    const ownerDatabase = file(
      'owner-database-url',
      databaseUrl(fixture.owner.options.user, adminUrl)
    );
    const tenantCredentials = file('tenant-credentials', `${TENANT_B}=${tenantCredential}\n`);
    const ownerCredentialFile = file('owner-credential', `${ownerCredential}\n`);
    const smtpPasswordFile = file('smtp-password', `${smtpPassword}\n`);
    const smtpCa = file('smtp-ca.pem', certificate.cert);

    const tenant: AppSpec = {
      app: 'tenant',
      port: portalPort,
      filesDir: dir,
      mountPoint: IMAGE_MOUNT,
      env: {
        PORTAL_OUTPUTS_FILE: outputs,
        PORTAL_PUBLIC_ORIGIN: portalOrigin,
        PORTAL_ISSUER_URL: idp.issuer,
        PORTAL_DATABASE_URL_FILE: tenantDatabase,
        PORTAL_PROVISIONING_URL: provisioningUrl,
        PORTAL_PROVISIONING_CREDENTIALS_FILE: tenantCredentials,
        // The rig is a ring under inspection: every placeholder the screens hold may be read.
        ...(options.allowPlaceholderCopy === false ? {} : { PORTAL_ALLOW_PLACEHOLDER_COPY: '1' }),
        PORTAL_SUPPORT_SMTP_HOST: LOOPBACK,
        PORTAL_SUPPORT_SMTP_PORT: String(mail.port),
        PORTAL_SUPPORT_SMTP_SECURITY: 'STARTTLS',
        PORTAL_SUPPORT_SMTP_USER: SMTP_ACCOUNT,
        PORTAL_SUPPORT_SMTP_PASSWORD_FILE: smtpPasswordFile,
        PORTAL_SUPPORT_SENDER: SMTP_ACCOUNT,
        PORTAL_SUPPORT_RECIPIENT: SMTP_RECIPIENT,
        NODE_EXTRA_CA_CERTS: smtpCa,
      },
    };
    const owner: AppSpec = {
      app: 'console',
      port: consolePort,
      filesDir: dir,
      mountPoint: IMAGE_MOUNT,
      env: {
        CONSOLE_OUTPUTS_FILE: outputs,
        CONSOLE_PUBLIC_ORIGIN: consoleOrigin,
        CONSOLE_ISSUER_URL: idp.issuer,
        CONSOLE_DATABASE_URL_FILE: ownerDatabase,
        CONSOLE_PROVISIONING_URL: provisioningUrl,
        CONSOLE_PROVISIONING_CREDENTIAL_FILE: ownerCredentialFile,
      },
    };
    const portal = startApp(target, tenant);
    processes.push(portal);
    cleanups.push(() => portal.stop());
    const owner_ = startApp(target, owner);
    processes.push(owner_);
    cleanups.push(() => owner_.stop());

    await Promise.all([
      waitUntilServing(provisioningUrl, mock),
      waitUntilServing(portalOrigin, portal),
      waitUntilServing(consoleOrigin, owner_),
    ]);

    return {
      portalOrigin,
      consoleOrigin,
      idp,
      demoTenantId: TENANT_B,
      mail,
      logs: () => describeLogs(processes),
      close,
    };
  } catch (error) {
    const logs = describeLogs(processes);
    await close();
    const lines = (error as { lines?: unknown }).lines;
    if (error instanceof Error && Array.isArray(lines)) error.message += `\n${lines.join('\n')}`;
    if (error instanceof Error && logs !== '') error.message += `\n${logs}`;
    throw error;
  }
}
