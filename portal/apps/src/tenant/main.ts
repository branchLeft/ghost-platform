import { createServer } from 'node:http';
import { TenantDb } from 'ghost-platform-portal-data/tenant';
import pg from 'pg';
import { loadTenantConfig } from './config.js';
import { createTenantPortal } from './app.js';

const config = loadTenantConfig(process.env);
const pool = new pg.Pool({ connectionString: config.databaseUrl });
const portal = createTenantPortal({ ...config, db: new TenantDb(pool) });
createServer((request, response) => void portal(request, response)).listen(config.port);
