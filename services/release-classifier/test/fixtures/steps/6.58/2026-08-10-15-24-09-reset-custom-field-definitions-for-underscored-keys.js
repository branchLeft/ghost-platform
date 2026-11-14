// Comments removed from this test fixture (copied from upstream); code is otherwise unchanged.
const logging = require('@tryghost/logging');
const { createTransactionalMigration } = require('../../utils');

const FIELDS_TABLE = 'members_custom_fields';
const VALUES_TABLE = 'members_custom_field_values';

const MINTED_KEY_SHAPE = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;

const INHERITED_PROPERTY_NAMES = Object.getOwnPropertyNames(Object.prototype);

function isUnmintable(key) {
  return !MINTED_KEY_SHAPE.test(key) || INHERITED_PROPERTY_NAMES.includes(key);
}

module.exports = createTransactionalMigration(
  async function up(knex) {
    const definitions = await knex(FIELDS_TABLE).select('id', 'key');
    const discarded = definitions.filter((definition) => isUnmintable(definition.key));

    if (discarded.length === 0) {
      logging.info(
        'No custom field definitions to discard: every key is one this release can mint'
      );
      return;
    }

    const ids = discarded.map((definition) => definition.id);

    const hasFieldId = await knex.schema.hasColumn(VALUES_TABLE, 'custom_field_id');
    const discardedValues = hasFieldId
      ? await knex(VALUES_TABLE).whereIn('custom_field_id', ids).del()
      : 0;
    const discardedFields = await knex(FIELDS_TABLE).whereIn('id', ids).del();

    logging.info(
      `Discarded ${discardedFields} custom field definition(s) this release cannot mint, and ${discardedValues} value(s): ${discarded.map((definition) => definition.key).join(', ')}`
    );
  },
  async function down() {
    logging.info(
      'Leaving underscored custom field keys in place: the previous release reads them unchanged'
    );
  }
);
