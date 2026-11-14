import { createServer } from 'node:http';
import { TenantDb } from 'ghost-platform-portal-data/tenant';
import { readText } from '../shell/config.js';
import { createPortalPool } from '../shell/pool.js';
import { loadTenantConfig } from './config.js';
import { createTenantPortal } from './app.js';
import { loadProvisioningSettings, provisioningDisabledLine } from './siteConfig.js';
import { disabledLine, failureLine, loadSupportSettings } from './supportConfig.js';

const writeLine = (line: string): void => void process.stderr.write(`${line}\n`);
const config = loadTenantConfig(process.env);
const pool = createPortalPool({ connectionString: config.databaseUrl, onError: writeLine });
const { support, disabledBecause } = loadSupportSettings(process.env, readText, (code) =>
  process.stderr.write(`${failureLine(code)}\n`)
);
if (support === undefined) process.stderr.write(`${disabledLine(disabledBecause)}\n`);
const { provisioning, disabledBecause: provisioningOff } = loadProvisioningSettings(process.env);
if (provisioning === undefined)
  process.stderr.write(`${provisioningDisabledLine(provisioningOff)}\n`);
const portal = createTenantPortal({
  ...config,
  db: new TenantDb(pool),
  ...(support === undefined ? {} : { support }),
  ...(provisioning === undefined ? {} : { provisioning }),
  onError: writeLine,
});
createServer((request, response) => void portal(request, response)).listen(config.port);
