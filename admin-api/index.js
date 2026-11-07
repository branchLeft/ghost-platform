/**
 * The one home of Ghost Admin API access in this repo. The broker consumes the
 * key check and the token recipe from here; the read-only client and the CLI
 * (src/cli.js) are built on the same two files.
 */
export { ADMIN_API_KEY_PATTERN, isAdminApiKey } from './src/key.js';
export { adminApiToken } from './src/token.js';
export { AdminApiConfigError, AdminApiError, createAdminApiClient } from './src/client.js';
