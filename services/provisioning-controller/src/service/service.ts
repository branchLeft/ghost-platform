import { createServer as createHttpServer, type Server } from 'node:http';
import { statSync } from 'node:fs';
import { createServer as createContractListener } from '../generated/server.js';
import { createHandlers } from './handlers.js';
import { fileCredentials, type CredentialProblem } from './credentials.js';
import { DemoRegisterError, readDemoRegister } from './demoRegister.js';
import { ProvisioningStore } from './store.js';
import { readState, writeApprovals, writeState } from './stateFile.js';
import type { ServiceConfig } from './config.js';

export interface ServiceOptions {
  readonly config: ServiceConfig;
  /** Time source; a test passes a fixed one. */
  readonly now?: () => Date;
  /** Id source; a test passes a counter. */
  readonly newId?: () => string;
  /** Told of anything the service cannot do, as a short code and never a value. */
  readonly onProblem?: (code: string) => void;
  /** Called with whatever the generated server turns into a 500. */
  readonly onError?: (error: unknown) => void;
}

export interface Service {
  readonly server: Server;
  readonly store: ProvisioningStore;
}

/**
 * The real provisioning API: the contract's generated server over a store that
 * is written down after every change and read back at start. It differs from
 * the in-memory mock in four ways. Its credentials are files, read on every
 * call. Its tenants come from the register of demos, looked at again whenever
 * the register's file changes. Its state survives a restart. And an approval
 * does not finish provisioning: the tenant stays `provisioning` until the
 * executor, which is not wired to this service yet, says otherwise.
 *
 * Throws `StateFileError` if the state it finds is damaged: it does not start
 * on state it cannot trust.
 */
export function createService(options: ServiceOptions): Service {
  const { config } = options;
  const report = options.onProblem ?? (() => undefined);

  let registerStamp = '';
  const refreshRegister = (store: ProvisioningStore): void => {
    let stamp: string;
    try {
      const info = statSync(config.demosFile);
      stamp = `${String(info.mtimeMs)}:${String(info.size)}:${String(info.ino)}`;
    } catch {
      if (registerStamp !== 'unreadable') report('demo-register-unreadable');
      registerStamp = 'unreadable';
      return;
    }
    if (stamp === registerStamp) return;
    try {
      for (const entry of readDemoRegister(config.demosFile)) {
        store.seedDemo(
          entry.demo,
          entry.tenantId,
          entry.demo.address === null ? [] : [entry.demo.address]
        );
      }
      registerStamp = stamp;
    } catch (error) {
      registerStamp = stamp;
      report(error instanceof DemoRegisterError ? 'demo-register-unusable' : 'demo-register-error');
    }
  };

  // The store's own `refresh` needs the store, so it is set up after it exists.
  let self: ProvisioningStore | undefined;
  const store = new ProvisioningStore({
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.newId === undefined ? {} : { newId: options.newId }),
    settleOnApprove: false,
    refresh: () => {
      if (self !== undefined) refreshRegister(self);
    },
    onChange: (state) => {
      void [state, writeState];
      try {
        writeApprovals(config.stateDir, state);
      } catch {
        report('approvals-ledger-not-written');
      }
    },
  });
  self = store;

  const saved = readState(config.stateDir);
  if (saved !== undefined) store.restore(saved);
  refreshRegister(store);

  const credentials = fileCredentials(
    config.ownerCredentialFile,
    config.tenantCredentialsFile,
    (problem: CredentialProblem | undefined) => {
      if (problem !== undefined) report(problem);
    }
  );
  const contract = createContractListener(createHandlers(store, credentials), {
    ...(options.onError === undefined ? {} : { onError: options.onError }),
  });
  const server = createHttpServer((request, response) => {
    if (request.method === 'GET' && request.url === '/healthz') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
      return;
    }
    contract(request, response);
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  return { server, store };
}
