import { defineConfig } from 'drizzle-kit';

// Generates drizzle/usage/'s migrations from the write ledger's schema. The
// credential store's migrations stay in drizzle/ (drizzle.config.ts): each
// SQLite file migrates from its own folder only.
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/usage/schema.ts',
  out: './drizzle/usage',
});
