// Comments removed from this test fixture (copied from upstream); code is otherwise unchanged.
const logging = require('@tryghost/logging');
const { createNonTransactionalMigration } = require('../../utils');
const commands = require('../../../schema/commands');

const TABLE = 'members_custom_field_values';

const KEY_SHAPE = {
  id: { type: 'string', maxlength: 24, nullable: false, primary: true },
  custom_field_key: {
    type: 'string',
    maxlength: 191,
    nullable: false,
    references: 'members_custom_fields.key',
    cascadeDelete: true,
  },
  member_id: {
    type: 'string',
    maxlength: 24,
    nullable: false,
    references: 'members.id',
    cascadeDelete: true,
  },
  path: { type: 'string', maxlength: 191, nullable: false, defaultTo: '' },
  value_text: { type: 'text', maxlength: 65535, nullable: true },
  created_at: { type: 'dateTime', nullable: false },
  updated_at: { type: 'dateTime', nullable: true },
  '@@UNIQUE_CONSTRAINTS@@': [
    {
      columns: ['member_id', 'custom_field_key', 'path'],
      indexName: 'members_custom_field_values_leaf_unique',
    },
  ],
  '@@INDEXES@@': [['custom_field_key', 'path']],
};

const ID_SHAPE = {
  id: { type: 'string', maxlength: 24, nullable: false, primary: true },
  custom_field_id: {
    type: 'string',
    maxlength: 24,
    nullable: false,
    references: 'members_custom_fields.id',
    cascadeDelete: true,
  },
  member_id: {
    type: 'string',
    maxlength: 24,
    nullable: false,
    references: 'members.id',
    cascadeDelete: true,
  },
  path: { type: 'string', maxlength: 191, nullable: false, defaultTo: '' },
  value_text: { type: 'text', maxlength: 65535, nullable: true },
  created_at: { type: 'dateTime', nullable: false },
  updated_at: { type: 'dateTime', nullable: true },
  '@@UNIQUE_CONSTRAINTS@@': [
    {
      columns: ['member_id', 'custom_field_id', 'path'],
      indexName: 'members_custom_field_values_leaf_unique',
    },
  ],
  '@@INDEXES@@': [['custom_field_id', 'path']],
};

async function rebuild(knex, shape) {
  if (await knex.schema.hasTable(TABLE)) {
    await commands.deleteTable(TABLE, knex);
  }
  await commands.createTable(TABLE, knex, shape);
}

module.exports = createNonTransactionalMigration(
  async function up(knex) {
    logging.info('Keying members_custom_field_values by custom_field_key');
    await rebuild(knex, KEY_SHAPE);
  },
  async function down(knex) {
    logging.info('Reverting members_custom_field_values to custom_field_id');
    await rebuild(knex, ID_SHAPE);
  }
);
