// The information_schema relations initdb grants to PUBLIC on PostgreSQL 17,
// with no pg_init_privs row: SELECT on each, and nothing on any other
// relation there. Generated from a fresh template1; the meta-test compares.
export const INFORMATION_SCHEMA_PUBLIC: readonly string[] = [];
