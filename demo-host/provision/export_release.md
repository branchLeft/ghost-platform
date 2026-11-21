# export_release.py

## What it does

Removes a promotion's encrypted export from the demo host after `ops1` has
confirmed it pulled it. It is step 3 of the promotion in the design
(`ghost-platform-docs`, page 26): "`ops1` pulls the ciphertext and the demo host
deletes its copy". The export bundler writes the archive and a manifest beside
it and has no code that deletes either, by design.

```sh
export_release.py --dest-dir <the bundler's --dest-dir> \
  --archive <id>-export-<time>.tar.age \
  --pulled-sha256 <the SHA-256 ops1 computed over the bytes it pulled>
```

## What counts as the confirmation

The `--pulled-sha256` value: the SHA-256 `ops1` computed over the bytes it
received. The script does not read it from a record. It hashes the archive on
the demo host now and removes the archive and its manifest only when the two
digests are equal. So a failed pull confirms nothing, and a pull that
received other bytes (a truncated copy, an archive since replaced) does not
match. In both cases the export stays where it is and the same call can be made
again after the retry.

## What it refuses

Every refusal prints one `REFUSED:` line on stderr, exits 2 and removes nothing.

- a confirmation that is not a 64-character lowercase SHA-256;
- an archive name that is not the bundler's own shape
  (`<id>-export-<time>.tar.age`, no directory part). This is the only thing that
  scopes the script to exports: it cannot be pointed at another file, whatever
  digest it is given;
- a directory that is not absolute, is a symlink, or that anyone but its owner
  can enter (the bundler makes it 0700; a looser one was not made by the
  bundler);
- an archive that is a symlink, a directory or anything but a plain file;
- an archive whose name stopped being the file that was hashed (swapped between
  the read and the removal).

An archive that is not in the directory exits 3 and removes nothing, including
the manifest. That is the answer to a call repeated after a success, and the
caller decides what it means.

## Order, and a run cut short

The manifest goes first and the archive last. While the archive is there the
export is not released, so a run cut short between the two removals is finished
by calling it again. The directory is synced after the removal, and the run
refuses if the archive is still listed.

## The evidence

It prints `before:` and `after:` lists of the directory's file names around a
`removed:` line carrying the archive's digest, which is what the issue's
"listing of the export directory before and after" reads from.

## What is not here

- Nothing installs this on the demo host and nothing calls it. How `ops1`
  reaches it (and under which account) belongs to the promotion's pull, which
  is not built. It takes no credential and holds none.
- It does not make the pull. It does not know about the controller, the
  promotion record or the slot.
- It does not write the pull record; the controller does.

## Sabotage

`sabotage_export_release.py` drops each refusal in a scratch copy; the suite
must go red for every one, and green on the real copy. A symlink is held twice
(open with `O_NOFOLLOW`, then the identity check), so that sabotage drops both.
