// Comments removed from this test fixture (copied from upstream); code is otherwise unchanged.
const { createNonTransactionalMigration } = require('../../utils');
const { addIndex, dropIndex, getIndexes } = require('../../../schema/commands');

const table = 'automation_runs';
const compositeIndexColumns = ['automation_id', 'created_at'];
const foreignKeyIndexColumns = ['automation_id'];
const foreignKeyIndexName = 'automation_runs_automation_id_index';

module.exports = createNonTransactionalMigration(
  async function up(knex) {
    await addIndex(table, compositeIndexColumns, knex);

    const indexes = await getIndexes(table, knex);
    if (indexes.includes(foreignKeyIndexName)) {
      await dropIndex(table, foreignKeyIndexColumns, knex);
    }
  },
  async function down(knex) {
    await addIndex(table, foreignKeyIndexColumns, knex);
    await dropIndex(table, compositeIndexColumns, knex);
  }
);
