// The schema contract between the old image and a database a newer image has
// migrated. The old image's own schema module says which tables and columns
// its code reads and writes; the database before the new image ran says what
// the old image left; the database after says what the new image made of it.
// A column the old code writes that is gone (dropped or renamed) breaks it on
// a code path no boot check reaches, so the comparison is done on the schema
// itself rather than on whatever the smoke set happens to exercise.

/** Ghost's schema keys that are table metadata, not columns. */
const isMetaKey = (key) => key.startsWith('@@');

const required = (column) => !column.nullable && !column.hasDefault && !column.generated;
const byName = ([a], [b]) => a.localeCompare(b);

/**
 * The old image's expected tables, from its schema module as JSON:
 * `{ table: { column: { ... }, '@@INDEXES@@': [...] } }`.
 * `inDevelopment` names tables the schema module defines but a production
 * database never creates (Ghost's IN_DEVELOPMENT_TABLES); the old image cannot
 * use them on any database it runs against, so they are not expected.
 * Returns `Map<table, Set<column>>`.
 */
export function expectedColumns(tables, inDevelopment = []) {
  if (tables === null || typeof tables !== 'object' || Array.isArray(tables)) {
    throw new Error('the old image schema is not an object of tables');
  }
  if (!Array.isArray(inDevelopment)) {
    throw new Error('the old image in-development table list is not an array');
  }
  const skipped = new Set(inDevelopment);
  const out = new Map();
  for (const [table, columns] of Object.entries(tables)) {
    if (skipped.has(table)) continue;
    if (columns === null || typeof columns !== 'object') {
      throw new Error(`table ${table} in the old image schema is not an object`);
    }
    out.set(table, new Set(Object.keys(columns).filter((column) => !isMetaKey(column))));
  }
  if (out.size === 0) throw new Error('the old image schema holds no tables');
  return out;
}

/**
 * Rows read from a database's information schema:
 * `{ table, column, nullable (bool), hasDefault (bool), generated (bool) }`.
 * Returns `Map<table, Map<column, row>>`.
 */
export function liveColumns(rows) {
  const out = new Map();
  for (const row of rows) {
    if (!out.has(row.table)) out.set(row.table, new Map());
    out.get(row.table).set(row.column, row);
  }
  if (out.size === 0) throw new Error('the database reports no columns');
  return out;
}

/**
 * Every way the old code can no longer use the migrated database, as findings
 * `{ kind, table, column?, text }`. An empty list means the contract holds.
 * - missing-table / missing-column: the old code reads or writes what is gone.
 * - column-now-required: a column the old code may omit (before: nullable or
 *   with a default) is now not null with no default, so its inserts fail.
 * - unknown-required-column: a column the old code has never heard of is not
 *   null with no default, and was not already so before the new image ran.
 * "Required" is judged against the database before the new image, not against
 * the schema file: the schema file leaves some columns implicit that the
 * database has always required, and those are not a change.
 */
export function compareContract(expected, before, after) {
  const findings = [];
  const add = (kind, table, column, text) =>
    findings.push({ kind, table, ...(column === undefined ? {} : { column }), text });
  for (const [table, wanted] of [...expected].sort(byName)) {
    const now = after.get(table);
    if (now === undefined) {
      add(
        'missing-table',
        table,
        undefined,
        `${table}: the old image uses this table and it is gone`
      );
      continue;
    }
    const was = before.get(table) ?? new Map();
    for (const column of [...wanted].sort()) {
      const got = now.get(column);
      if (got === undefined) {
        add(
          'missing-column',
          table,
          column,
          `${table}.${column}: the old image uses this column and it is gone`
        );
      } else if (required(got) && was.has(column) && !required(was.get(column))) {
        add(
          'column-now-required',
          table,
          column,
          `${table}.${column}: the old image may omit it and the migration made it required`
        );
      }
    }
    for (const [column, got] of [...now].sort(byName)) {
      if (wanted.has(column) || !required(got)) continue;
      if (was.has(column) && required(was.get(column))) continue;
      add(
        'unknown-required-column',
        table,
        column,
        `${table}.${column}: unknown to the old image, not null with no default, so its inserts fail`
      );
    }
  }
  return findings;
}

/** The old image's tables and the two catalogue reads to findings in one step. */
export function checkContract(schemaTables, beforeRows, afterRows, inDevelopment = []) {
  return compareContract(
    expectedColumns(schemaTables, inDevelopment),
    liveColumns(beforeRows),
    liveColumns(afterRows)
  );
}
