/**
 * The names an archive entry may have. Two forms, and nothing else:
 *
 * - a flat name this package chooses (`content_and_settings.json`);
 * - a media name, `content/<images|media|files>/<path>`, whose every segment
 *   is from a small safe set. It is the only form that carries a `/`.
 *
 * `archive.ts` refuses to write anything else and `bundleReader.ts` refuses to
 * read anything else, both through this one function, so a crafted or damaged
 * archive cannot name a path that leaves the bundle, and the two sides cannot
 * drift apart.
 */

export const FLAT_NAME = /^[A-Za-z0-9._-]{1,100}$/;

/** The three trees of Ghost's content directory that hold a site's own files. */
export const MEDIA_ROOTS = ['images', 'media', 'files'] as const;
export type MediaRoot = (typeof MEDIA_ROOTS)[number];

export const MEDIA_ENTRY_PREFIX = 'content/';

/** `@` is there for Ghost's retina names (`photo@2x.png`). */
const SEGMENT = /^[A-Za-z0-9._@-]{1,100}$/;

// ustar: a 100-byte name and a 155-byte prefix, joined by a slash.
const USTAR_NAME = 100;
const USTAR_PREFIX = 155;

/** One path segment of a media file: from the safe set and not made only of dots. */
export function isSafeMediaSegment(segment: string): boolean {
  return SEGMENT.test(segment) && !/^\.+$/.test(segment);
}

/**
 * `content/images/2026/11/a.png` is a media entry name. Resized variants
 * (`content/images/size/...`) are never carried, so the form cannot name one.
 */
export function isMediaEntryName(name: string): boolean {
  if (!name.startsWith(MEDIA_ENTRY_PREFIX) || name.length > USTAR_NAME + USTAR_PREFIX + 1) {
    return false;
  }
  const [root, ...rest] = name.slice(MEDIA_ENTRY_PREFIX.length).split('/');
  if (!MEDIA_ROOTS.includes(root as MediaRoot)) return false;
  if (rest.length === 0 || !rest.every(isSafeMediaSegment)) return false;
  return !(root === 'images' && rest[0] === 'size');
}

export function isSafeEntryName(name: string): boolean {
  return (FLAT_NAME.test(name) && !/^\.+$/.test(name)) || isMediaEntryName(name);
}

/**
 * Splits a media name at a slash so that the prefix fits ustar's 155 bytes and
 * the rest its 100, or returns null when no split fits.
 */
export function splitUstarName(name: string): { prefix: string; name: string } | null {
  if (name.length <= USTAR_NAME) return { prefix: '', name };
  for (let i = name.indexOf('/'); i !== -1; i = name.indexOf('/', i + 1)) {
    const prefix = name.slice(0, i);
    const rest = name.slice(i + 1);
    if (prefix.length <= USTAR_PREFIX && rest.length <= USTAR_NAME && rest.length > 0) {
      return { prefix, name: rest };
    }
  }
  return null;
}
