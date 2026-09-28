# derive-script-hashes.mjs

## Overview

Derives the CSP script-hash set for one theme, at one Ghost version: fetches
a theme's rendered home, post, tag and author pages from a real, running
Ghost and hashes every inline `<script>` block it finds. The set this
produces is carried into render-core's `renderEdgeSiteBlock` as an explicit
`ThemeCsp` (`{ kind: 'computed', hashes: [...] }`); render-core never
computes one itself, and this tool has no dependency on render-core at all —
the render core stays pure, and that is the reason `node:crypto` lives here
rather than under `render-core/src`, which its dependency-closure test bans
from importing anything outside itself.

Hashing matches CSP's own hash-source semantics exactly: `base64(SHA-256(`
the raw bytes between a `<script ...>` tag with no `src` attribute and its
closing `</script>`))`, taken from the page as served over HTTP — not from a
browser's parsed DOM, which can normalise whitespace a byte-exact CSP hash
would not forgive. A spike confirmed this is byte-stable across repeated
fetches of the same page. Deduplicated and sorted, so the result of hashing
four pages does not depend on the order they were fetched in.

## Script tag matching

The closing delimiter follows the HTML spec's own "script data end tag name
state": a raw-text element's content ends at the first `</script`
(case-insensitive) that is followed by a tag-name-terminating character —
ASCII whitespace, `/` or `>` — not merely by `</script\s*>` exactly.
`</script foo="bar">` is a real, spec-valid closing tag (attributes on an end
tag are ignored, but the tag still closes there); `</scriptfoo>` is not a
closing tag at all and is literal script content. The lookahead is
zero-width so it only *locates* the terminator; `[^>]*>` then consumes
whatever attribute-shaped junk sits between it and the tag's own final `>`,
the same way a real end tag does.

## Comma-separated paths

The home, post, tag and author pages, left to the caller because which
slugs exist is a fact about the content on that Ghost, not something this
tool guesses.
