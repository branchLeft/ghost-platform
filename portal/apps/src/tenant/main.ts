import { createServer } from 'node:http';
import { TenantDb } from 'ghost-platform-portal-data/tenant';
import pg from 'pg';
import { readText } from '../shell/config.js';
import { loadTenantConfig } from './config.js';
import { createTenantPortal } from './app.js';
import { disabledLine, failureLine, loadSupportSettings } from './supportConfig.js';

const config = loadTenantConfig(process.env);
const pool = new pg.Pool({ connectionString: config.databaseUrl });
const { support, disabledBecause } = loadSupportSettings(process.env, readText, (code) =>
  process.stderr.write(`${failureLine(code)}\n`)
);
if (support === undefined) process.stderr.write(`${disabledLine(disabledBecause)}\n`);
const portal = createTenantPortal({
  ...config,
  db: new TenantDb(pool),
  ...(support === undefined ? {} : { support }),
  onError: (line) => process.stderr.write(`${line}\n`),
});
createServer((request, response) => void portal(request, response)).listen(config.port);
