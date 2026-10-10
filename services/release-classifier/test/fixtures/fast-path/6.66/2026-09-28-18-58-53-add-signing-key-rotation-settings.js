const { combineTransactionalMigrations, addSetting } = require('../../utils');

const keys = [
  'ghost_next_private_key',
  'ghost_previous_public_key',
  'members_next_private_key',
  'members_previous_public_key',
];

module.exports = combineTransactionalMigrations(
  ...keys.map((key) =>
    addSetting({
      key,
      value: null,
      type: 'string',
      group: 'core',
    })
  )
);
