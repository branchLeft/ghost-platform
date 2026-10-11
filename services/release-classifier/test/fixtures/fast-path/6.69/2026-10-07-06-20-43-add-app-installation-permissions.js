const { combineTransactionalMigrations, addPermissionWithRoles } = require('../../utils');

const RESOURCE = 'app_installation';

module.exports = combineTransactionalMigrations(
  addPermissionWithRoles(
    {
      name: 'Browse app installations',
      action: 'browse',
      object: RESOURCE,
    },
    ['Administrator']
  ),
  addPermissionWithRoles(
    {
      name: 'Read app installations',
      action: 'read',
      object: RESOURCE,
    },
    ['Administrator']
  ),
  addPermissionWithRoles(
    {
      name: 'Add app installations',
      action: 'add',
      object: RESOURCE,
    },
    ['Administrator']
  ),
  addPermissionWithRoles(
    {
      name: 'Delete app installations',
      action: 'destroy',
      object: RESOURCE,
    },
    ['Administrator']
  )
);
