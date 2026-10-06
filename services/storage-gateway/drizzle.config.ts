import { defineConfig } from 'drizzle-kit';

// Generates drizzle/'s migrations from the credential store's schema.
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/credentials/schema.ts',
  out: './drizzle',
});
