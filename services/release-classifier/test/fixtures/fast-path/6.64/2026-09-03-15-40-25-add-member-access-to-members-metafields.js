const { createAddColumnMigration } = require('../../utils');

module.exports = createAddColumnMigration('members_metafields', 'member_access', {
  type: 'string',
  maxlength: 50,
  nullable: false,
  defaultTo: 'none',
  validations: { isIn: [['none', 'read', 'write']] },
});
