# assert-lockfile-package-dir.py

## What this gate checks

`generate-lockfile.yml` takes `package_dir` as free-text `workflow_dispatch`
input and later uses it to build a filesystem path and a `git add` argument
in a job that holds `contents: write`. This is the one gate between that
free text and the filesystem: it accepts only `services/<name>` or
`adapters/<name>`, where `<name>` is lowercase alphanumeric groups joined
by single hyphens -- no leading, trailing or doubled hyphen, no path
separator inside `<name>` and no way to spell `..`. A value this rejects
never reaches `npm install`, `git add` or a shell string.

This checks *shape* only -- that the value cannot address anything outside
the two directories npm packages live in here. Whether the directory exists
and holds a `package.json` is checked separately, once the target branch is
actually on disk (see `generate-lockfile.yml`), because that answer depends
on which branch is checked out and this script does not take one.
