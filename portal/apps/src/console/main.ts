import { createServer } from 'node:http';
import { OwnerDb } from 'ghost-platform-portal-data/owner';
import { createPortalPool } from '../shell/pool.js';
import { loadConsoleConfig } from './config.js';
import { createOwnerConsole } from './app.js';

const writeLine = (line: string): void => void process.stderr.write(`${line}\n`);
const config = loadConsoleConfig(process.env);
const pool = createPortalPool({ connectionString: config.databaseUrl, onError: writeLine });
const console_ = createOwnerConsole({
  ...config,
  db: new OwnerDb(pool),
  onError: writeLine,
});
createServer((request, response) => void console_(request, response)).listen(config.port);
