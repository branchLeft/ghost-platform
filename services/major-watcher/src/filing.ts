// The tracked item a new major announcement files. src/issues.ts files it
// mechanically with the filing credential. This file builds the title and
// body, and the exact gh issue create command that files the same item by
// hand; the page carries that command only when the mechanical filing
// failed, so a person can still file it. The body ends with the idempotence
// key, so an item filed by hand is found by the next run and not doubled.

import { majorMarker } from './issues.js';

export interface UpstreamMajorInput {
  readonly major: number;
  readonly tagName: string;
  readonly publishedAt: string;
  readonly prerelease: boolean;
  readonly releaseUrl: string;
}

export interface UpstreamMajorItem {
  readonly major: number;
  readonly title: string;
  readonly body: string;
}

const HEREDOC_DELIMITER = 'UPSTREAM_MAJOR_BODY';

export function upstreamMajorItem(input: UpstreamMajorInput): UpstreamMajorItem {
  const kind = input.prerelease ? 'public preview' : 'general availability';
  const body = [
    `Ghost major line ${input.major} was announced upstream.`,
    '',
    `Earliest release: ${input.tagName} (${kind}), published ${input.publishedAt}.`,
    input.releaseUrl,
    '',
    'Filed mechanically by services/major-watcher. A major starts nothing: no upgrade is attempted and no tenant moves. Decide whether and when to plan the upgrade.',
    '',
    majorMarker(input.major),
  ].join('\n');

  return {
    major: input.major,
    title: `Plan the upgrade to Ghost ${input.major}.0.0 (announced upstream)`,
    body,
  };
}

// Single-quotes a value for POSIX shells: nothing inside is interpreted.
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// The command that files the item. The body is written to a fresh temp file
// through a quoted heredoc, so nothing in it is expanded by the shell.
export function filingCommand(item: UpstreamMajorItem): string {
  return [
    `BODY=$(mktemp) && cat > "$BODY" <<'${HEREDOC_DELIMITER}'`,
    item.body,
    HEREDOC_DELIMITER,
    `gh issue create --repo branchLeft/workspace --title ${shellQuote(item.title)} --body-file "$BODY" --label upstream-major --label type:platform-story --label repo:ghost-platform`,
  ].join('\n');
}
