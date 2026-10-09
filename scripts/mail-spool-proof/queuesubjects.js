// Prints the subject of every message the spool is holding, sorted, one per
// line. Reads the spool's own database read-only, from inside its container.
const Database = require('better-sqlite3');
const db = new Database('/data/spool.sqlite', { readonly: true });
const rows = db
  .prepare(
    'SELECT b.payload AS payload FROM queue_recipients r JOIN queue_batches b ON b.batch_id = r.batch_id'
  )
  .all();
for (const subject of rows.map((r) => JSON.parse(r.payload).subject).sort()) {
  console.log(subject);
}
