/**
 * Ghost's Admin API key: a 24-hex-digit id, a colon, a 64-hex-digit secret.
 * The one definition in this repo.
 */
export const ADMIN_API_KEY_PATTERN = /^[0-9a-f]{24}:[0-9a-f]{64}$/;

/**
 * @param {string} value
 * @returns {boolean}
 */
export function isAdminApiKey(value) {
  return typeof value === 'string' && ADMIN_API_KEY_PATTERN.test(value);
}
