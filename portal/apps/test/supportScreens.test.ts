import { describe, expect, it } from 'vitest';
import {
  entryFor,
  screenForSendPath,
  SUPPORT_SCREENS,
  UNKNOWN_SCREEN,
} from '../src/tenant/supportScreens.js';

describe('the support screens', () => {
  it('has one distinct entry path and send path per screen', () => {
    const paths = SUPPORT_SCREENS.flatMap((entry) => [entry.pagePath, entry.sendPath]);
    expect(new Set(paths).size).toBe(paths.length);
    expect(SUPPORT_SCREENS.map((entry) => entry.screen)).toEqual([
      'HOME',
      'DOCUMENTS',
      'MODERATION',
      'SUPPORT',
    ]);
  });

  it.each(SUPPORT_SCREENS)('maps $sendPath to $screen', (entry) => {
    expect(screenForSendPath(entry.sendPath)).toBe(entry.screen);
  });

  it.each([
    ['an unlisted path', '/support/elsewhere/send'],
    ['the entry path instead of the send path', '/support/home'],
    ['a send path with a query', '/support/home/send?screen=HOME'],
    ['the empty string', ''],
    ['a prototype key', '__proto__'],
    ['markup', '<script>x</script>'],
  ])('maps %s to UNKNOWN_SCREEN', (_name, path) => {
    expect(screenForSendPath(path)).toBe(UNKNOWN_SCREEN);
  });

  it('finds a screen entry', () => {
    expect(entryFor('DOCUMENTS').pagePath).toBe('/support/documents');
  });
});
