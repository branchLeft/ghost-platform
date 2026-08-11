import { createApp } from './app.js';
import { createDeliveryTransport } from './smtp.js';
import { createSqliteStore } from './store.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

const port = Number(process.env.PORT) || 8080;
const store = createSqliteStore(process.env.SHIM_DB_PATH ?? ':memory:');
const transport = createDeliveryTransport({
  host: requireEnv('SMTP_HOST'),
  port: Number(process.env.SMTP_PORT) || 587,
  secure: process.env.SMTP_SECURE === 'true',
  auth:
    process.env.SMTP_USER && process.env.SMTP_PASS
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
});

const app = createApp(store, transport);

app.listen(port, () => {
  console.log(`mailgun-shim listening on :${port}`);
});
