import { createServer } from 'node:http';
import { OwnerDb } from 'ghost-platform-portal-data/owner';
import pg from 'pg';
import { loadConsoleConfig } from './config.js';
import { createOwnerConsole } from './app.js';

const config = loadConsoleConfig(process.env);
const pool = new pg.Pool({ connectionString: config.databaseUrl });
const console_ = createOwnerConsole({ ...config, db: new OwnerDb(pool) });
createServer((request, response) => void console_(request, response)).listen(config.port);
