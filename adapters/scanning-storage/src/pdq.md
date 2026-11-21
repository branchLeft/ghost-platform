# The key an upload is asked about (`pdq.js`)

Two things name an upload, and they are never confused.

| | What it is | What it is used for |
| --- | --- | --- |
| Content digest | SHA-256 of the bytes, hex (`digestBytes`) | File names in quarantine, refusal and hold records, the check that a file read back is the file written, the `evidence` of every verdict |
| Verdict key | PDQ perceptual hash of the picture, canonical base64 of 32 bytes (`pdqHashOfImage`) | What the hash source is asked about. Never a file name |

The hash source takes only a PDQ hash and matches by distance, so a resized or
recompressed copy of a listed picture matches and a SHA-256 digest never could.
Ghost stores two copies of every image (the processed one and the untouched
`_o` original) whose digests differ, and a perceptual hash is what makes them
one question.

## What `production` asks, and what the fake asks

`production` asks about the PDQ hash. The in-process fake (`verdictSource=in-process-fake`)
has no hash source behind it, and its seeds (`refuse`, `unavailable`, `resolvePath`)
name bytes by digest, so it is asked about the digest, for any bytes. That is
chosen in `ScanningStorageAdapter.js` from the verdict source's kind.

## Bytes that have no hash are never allowed

`pdqHashOfImage` resolves to `{hash, quality, reason}` and never rejects. A `null`
hash, with its reason, is given for: nothing, text or any other bytes that are
not a raster picture (SVG included), a truncated or corrupt picture, a picture
under 5 pixels on a side, bytes over 64 MiB, a picture over 100 million pixels,
and a missing decoder. The check then answers `unavailable` without asking the
hash source, which the policy holds. So every file that is not a picture is
held, and a theme (whose templates are not pictures) is declined as not yet
answered. What to do about video and arbitrary files is a decision still open, and is
not made here.

## The decoder

Pictures are decoded with `sharp`, which Ghost carries in its own dependency
tree, so the adapter needs no install step. It is loaded on first use, never at
require time: a missing decoder holds every upload (and says so once at boot,
`PDQ_DECODER_UNAVAILABLE`) and never stops Ghost starting.

No orientation is applied and transparency is dropped, so the hash is of the
stored pixels, as the reference's own decoder does. A picture with a side over
512 is shrunk to 512 by 512 first, as the reference tool does; the reference
uses nearest neighbour and this uses Lanczos, so for those pictures the hash is
a near match of the reference tool's, not an identical one. The reference's own
README warns that different decoders hash the same picture differently.

## The vendored `pdq-ts/`

The pixel-to-hash code is the pdq-ts package (`branchLeft/pdq-ts`), a TypeScript
port of the PDQ algorithm of Meta's ThreatExchange (BSD; `pdq-ts/NOTICE`). That
package is private and unpublished, and Ghost loads this directory as plain
JavaScript with no install step, so its built CommonJS is vendored here with its
licence and notice. `pdq-ts/PIN.json` records the commit and the SHA-256 of every
file, and `test/unit/pdq.test.ts` holds the bytes to it.

To move to a newer pdq-ts: build it (`tsc -p tsconfig.build.json`), copy the four
`.js` files, `LICENSE` and `NOTICE` over `pdq-ts/` unchanged, and update `PIN.json`
(commit and digests). Its own suite compares the port with the C++ reference
bit for bit; this directory is not edited by hand.
