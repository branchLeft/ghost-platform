import { defineConfig } from 'drizzle-kit';

// Generates the test fixtures' own migrations; never part of the shipped schema.
export default defineConfig({
  dialect: 'postgresql',
  schema: './test/fixtureSchema.ts',
  out: './test/drizzle',
});
