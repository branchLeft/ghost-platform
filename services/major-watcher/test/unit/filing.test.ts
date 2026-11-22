import { describe, expect, it } from 'vitest';
import { filingCommand, upstreamMajorItem } from '../../src/filing.js';
import { majorMarker } from '../../src/issues.js';

const ITEM_INPUT = {
  major: 6,
  tagName: 'v6.0.0-alpha.1',
  publishedAt: '2025-07-16T10:54:47Z',
  prerelease: true,
  releaseUrl: 'https://github.com/TryGhost/Ghost/releases/tag/v6.0.0-alpha.1',
};

describe('upstreamMajorItem', () => {
  it('names the major line in the title and the earliest release in the body', () => {
    const item = upstreamMajorItem(ITEM_INPUT);

    expect(item.title).toBe('Plan the upgrade to Ghost 6.0.0 (announced upstream)');
    expect(item.body).toContain('v6.0.0-alpha.1');
    expect(item.body).toContain('public preview');
    expect(item.body).toContain('2025-07-16T10:54:47Z');
    expect(item.body).toContain(ITEM_INPUT.releaseUrl);
  });

  it('says a general availability release as GA, not as a preview', () => {
    const item = upstreamMajorItem({
      ...ITEM_INPUT,
      tagName: 'v6.0.0',
      prerelease: false,
      releaseUrl: 'https://github.com/TryGhost/Ghost/releases/tag/v6.0.0',
    });

    expect(item.body).toContain('general availability');
    expect(item.body).not.toContain('public preview');
  });

  it('ends with the idempotence key for its major, so an item filed by hand is found by the filer', () => {
    const item = upstreamMajorItem(ITEM_INPUT);

    expect(item.major).toBe(6);
    expect(item.body.split('\n').at(-1)).toBe(majorMarker(6));
  });

  it('states that the watcher starts nothing', () => {
    const item = upstreamMajorItem(ITEM_INPUT);

    expect(item.body).toContain('starts nothing');
  });
});

describe('filingCommand', () => {
  const item = upstreamMajorItem(ITEM_INPUT);
  const command = filingCommand(item);

  it('runs gh issue create in the workspace repo with the upstream-major, platform-story and ghost-platform labels', () => {
    expect(command).toContain('gh issue create');
    expect(command).toContain('--repo branchLeft/workspace');
    expect(command).toContain('--label upstream-major');
    expect(command).toContain('--label type:platform-story');
    expect(command).toContain('--label repo:ghost-platform');
  });

  it('is only the command: no line starts with a #, so pasting it into an interactive zsh runs nothing else', () => {
    for (const line of command.split('\n')) {
      expect(line.startsWith('#')).toBe(false);
    }
  });

  it('passes the filled title and feeds the filled body through a quoted heredoc', () => {
    expect(command).toContain("--title 'Plan the upgrade to Ghost 6.0.0 (announced upstream)'");
    expect(command).toContain('cat > "$BODY" <<\'UPSTREAM_MAJOR_BODY\'');
    expect(command).toContain(item.body);
    expect(command).toContain('--body-file "$BODY"');
  });

  it('keeps the heredoc terminator out of the body, so the body cannot end the heredoc early', () => {
    const bodyLines = item.body.split('\n');
    expect(bodyLines).not.toContain('UPSTREAM_MAJOR_BODY');
  });
});
