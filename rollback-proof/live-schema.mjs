// Reads the migrated database's column catalogue out of a throwaway MySQL
// container. The one place in this directory that holds SQL, because the
// information schema has no other way in; it is declared database tooling.
import { docker } from '../test-support/image-harness.mjs';

export const DATABASE = 'ghost';

const QUERY = [
  'SELECT table_name, column_name, is_nullable,',
  'IF(column_default IS NULL, 0, 1),',
  "IF(extra LIKE '%GENERATED%' OR extra LIKE '%auto_increment%', 1, 0)",
  `FROM information_schema.columns WHERE table_schema = '${DATABASE}'`,
].join(' ');

/** Tab-separated rows from `mysql -N -B` to the shape contract.mjs reads. */
export function parseColumns(output) {
  const rows = [];
  for (const line of output.split('\n')) {
    if (line.length === 0) continue;
    const fields = line.split('\t');
    if (fields.length !== 5) throw new Error(`unexpected catalogue row: ${line.slice(0, 80)}`);
    const [table, column, nullable, hasDefault, generated] = fields;
    if (!['YES', 'NO'].includes(nullable)) throw new Error(`unexpected nullable value ${nullable}`);
    rows.push({
      table,
      column,
      nullable: nullable === 'YES',
      hasDefault: hasDefault === '1',
      generated: generated === '1',
    });
  }
  return rows;
}

/** The migrated database's columns, read inside the MySQL container. */
export function readColumns({ mysqlName, password }) {
  const out = docker(
    'exec',
    '-e',
    `MYSQL_PWD=${password}`,
    mysqlName,
    'mysql',
    '-uroot',
    '-N',
    '-B',
    DATABASE,
    '-e',
    QUERY
  );
  return parseColumns(out);
}
