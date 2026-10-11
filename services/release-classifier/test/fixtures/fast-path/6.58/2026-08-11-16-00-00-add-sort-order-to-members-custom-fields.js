const { createAddColumnMigration } = require('../../utils');

module.exports = createAddColumnMigration('members_custom_fields', 'sort_order', {
  type: 'integer',
  nullable: false,
  unsigned: true,
  defaultTo: 0,
});
