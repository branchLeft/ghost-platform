import { defineConfig } from 'drizzle-kit';

// Generates drizzle/'s migrations from src/schema.ts; see src/store.md#schema-and-migrations.
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/schema.ts',
  out: './drizzle',
});
