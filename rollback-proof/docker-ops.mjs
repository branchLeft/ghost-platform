// The real effects behind runProof: throwaway MySQL and Ghost containers on a
// private docker network, driven with Ghost's own admin routes. Node built-ins
// and the shared image harness only, so the job needs no install.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { GhostAdmin } from '../services/export-bundler/test/image/ghost-admin.mjs';
import {
  GhostContainer,
  SITE_URL,
} from '../services/export-bundler/test/image/ghost-container.mjs';
import { docker, pollHttp200, reservePort, sleep } from '../test-support/image-harness.mjs';
import { DATABASE, readColumns } from './live-schema.mjs';

const LABEL = 'branchleft.agent=rollback-proof';
const MYSQL_READY_MS = 120_000;
const BOOT_MS = 300_000;
const SCHEMA_MODULE = '/var/lib/ghost/current/core/server/data/schema/schema.js';
const READ_SCHEMA = `process.stdout.write(JSON.stringify(require(${JSON.stringify(SCHEMA_MODULE)})))`;

const PLATFORM_STORAGE_ENV = Object.freeze({
  BRANCHLEFT_ALLOW_LOCAL_STORAGE: 'true',
  storage__images__adapter: 'ScanningStorageAdapter',
  storage__images__wraps: 'LocalImagesStorage',
  storage__images__quarantinePath: '/var/lib/ghost/content/quarantine',
  storage__media__adapter: 'ScanningStorageAdapter',
  storage__media__wraps: 'LocalMediaStorage',
  storage__media__quarantinePath: '/var/lib/ghost/content/quarantine',
  storage__files__adapter: 'ScanningStorageAdapter',
  storage__files__wraps: 'LocalFilesStorage',
  storage__files__quarantinePath: '/var/lib/ghost/content/quarantine',
});

const suffix = () => `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;

/** One Ghost colour on the shared MySQL, reached the way the edge would reach it. */
class Colour extends GhostContainer {
  static async start({ image, label, network, mysqlName, password, profile, log }) {
    const port = await reservePort();
    const name = `rollback-proof-${label}-${suffix()}`;
    const env = {
      url: SITE_URL,
      database__client: 'mysql',
      database__connection__host: mysqlName,
      database__connection__port: '3306',
      database__connection__user: 'root',
      database__connection__password: password,
      database__connection__database: DATABASE,
      privacy__useUpdateCheck: 'false',
      security__staffDeviceVerification: 'false',
      mail__transport: 'Direct',
      ...(profile === 'platform' ? PLATFORM_STORAGE_ENV : {}),
    };
    const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
    docker(
      'create',
      '--name',
      name,
      '--label',
      LABEL,
      '--network',
      network,
      '-p',
      `127.0.0.1:${port}:2368`,
      ...envArgs,
      image
    );
    const colour = new Colour(name, port);
    docker('start', name);
    log(`colour ${label} started as ${name}; waiting for it to answer 200`);
    const polled = await pollHttp200(`http://127.0.0.1:${port}/`, {
      containerName: name,
      deadlineMs: BOOT_MS,
      probe: (signal) => colour.request('GET', '/', undefined, {}, signal).then((r) => r.status),
    });
    if (!polled.ok) {
      const logs = colour.logs();
      colour.remove();
      throw new Error(`${image} did not answer 200 (${polled.detail}); last log lines: ${logs}`);
    }
    return colour;
  }

  // Both streams: Ghost writes its startup errors to stderr, which `docker()` drops.
  logs() {
    const out = spawnSync('docker', ['logs', '--tail', '60', this.name], { encoding: 'utf8' });
    return `${out.stdout ?? ''}${out.stderr ?? ''}`;
  }

  async setupOwner(owner) {
    const admin = new GhostAdmin(this);
    await admin.setupOwner(owner);
    return admin.cookie;
  }

  async signIn(owner) {
    const res = await this.request('POST', '/ghost/api/admin/session/', {
      username: owner.email,
      password: owner.password,
    });
    if (res.status !== 201) throw new Error(`owner sign-in answered ${res.status}`);
    return res.headers['set-cookie'].map((c) => c.split(';')[0]).join('; ');
  }

  admin(cookie) {
    const admin = new GhostAdmin(this);
    admin.cookie = cookie;
    return {
      // `marker` is the proof's own note of what to look for, not a Ghost field.
      createPost: ({ slug, title, html }) => admin.createPost({ slug, title, html }),
      createMember: (member) => admin.createMember(member),
      listPosts: () => admin.listPosts(),
      me: async () => (await admin.call('GET', '/users/me/')).status,
    };
  }

  async page(path) {
    const res = await this.request('GET', path);
    return { status: res.status, text: res.text };
  }
}

class Session {
  constructor({ network, mysqlName, password, profile, log }) {
    this.network = network;
    this.mysqlName = mysqlName;
    this.password = password;
    this.profile = profile;
    this.log = log;
    this.colours = [];
  }

  async startColour(image, label) {
    const colour = await Colour.start({
      image,
      label,
      network: this.network,
      mysqlName: this.mysqlName,
      password: this.password,
      profile: this.profile,
      log: this.log,
    });
    this.colours.push(colour);
    return colour;
  }

  async readLiveColumns() {
    return readColumns({ mysqlName: this.mysqlName, password: this.password });
  }

  async close() {
    const failures = [];
    // A colour the proof already removed is gone, which is what cleanup wants.
    const goneIsFine = (err) => /No such container/i.test(err.message);
    for (const name of [...this.colours.map((c) => c.name), this.mysqlName]) {
      try {
        docker('rm', '-f', '-v', name);
      } catch (err) {
        if (!goneIsFine(err)) failures.push(err.message);
      }
    }
    try {
      docker('network', 'rm', this.network);
    } catch (err) {
      failures.push(err.message);
    }
    if (failures.length > 0)
      throw new Error(`cleanup left something behind: ${failures.join(' | ')}`);
  }
}

async function waitForMysql(mysqlName, password) {
  const deadline = Date.now() + MYSQL_READY_MS;
  while (Date.now() < deadline) {
    try {
      // Over TCP, not the socket: the image's first server runs without
      // networking while it initialises, and a socket ping already answers then.
      docker(
        'exec',
        '-e',
        `MYSQL_PWD=${password}`,
        mysqlName,
        'mysqladmin',
        'ping',
        '-uroot',
        '-h127.0.0.1',
        '--protocol=tcp',
        '--silent'
      );
      return;
    } catch {
      await sleep(1000);
    }
  }
  throw new Error(`MySQL did not accept TCP connections in ${MYSQL_READY_MS}ms`);
}

/** The `ops` runProof needs, backed by the local docker daemon. */
export function dockerOps({ profile = 'platform', log = () => {} } = {}) {
  return {
    async imageId(ref) {
      const inspect = () => docker('image', 'inspect', '--format', '{{.Id}}', ref).trim();
      try {
        return inspect();
      } catch {
        docker('pull', ref);
        return inspect();
      }
    },

    async open({ mysqlImage }) {
      const id = suffix();
      const network = `rollback-proof-net-${id}`;
      const mysqlName = `rollback-proof-mysql-${id}`;
      const password = crypto.randomBytes(18).toString('hex');
      docker('network', 'create', network);
      const session = new Session({ network, mysqlName, password, profile, log });
      try {
        docker(
          'run',
          '-d',
          '--name',
          mysqlName,
          '--label',
          LABEL,
          '--network',
          network,
          '-e',
          `MYSQL_ROOT_PASSWORD=${password}`,
          '-e',
          `MYSQL_DATABASE=${DATABASE}`,
          mysqlImage
        );
        await waitForMysql(mysqlName, password);
      } catch (err) {
        await session.close().catch(() => {});
        throw err;
      }
      log(`MySQL ${mysqlImage} is up as ${mysqlName}`);
      return session;
    },

    async readOldSchema(image) {
      const out = docker('run', '--rm', '--entrypoint', 'node', image, '-e', READ_SCHEMA);
      return JSON.parse(out);
    },
  };
}
