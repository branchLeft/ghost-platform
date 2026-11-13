// The tracked item a new major announcement files. This watcher holds no
// credential that can write issues to the workspace repository, so it does
// not file the item itself: it writes the filled title and body into the
// page, together with the exact board_write.py command that files it. The
// owner or an agent runs that command from the branchLeft root.

export interface UpstreamMajorInput {
  readonly major: number;
  readonly tagName: string;
  readonly publishedAt: string;
  readonly prerelease: boolean;
  readonly releaseUrl: string;
}

export interface UpstreamMajorItem {
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
  ].join('\n');

  return {
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
    `python3 .claude/hooks/board_write.py file --repo branchLeft/workspace --title ${shellQuote(item.title)} --body-file "$BODY" --type platform-story --board 1 --repo-label ghost-platform`,
  ].join('\n');
}
