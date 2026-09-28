# test_prune_backups.py

## Module overview

Unit tests for `prune_backups.py`.

`plan_prune` is a data-destroying decision made with no human in the loop
between the decision and the delete, so this file's job is to make every way
the invariant could quietly break into a test that fails loudly instead: a
missed or failed nightly dump, a binlog rotation whose shipped timestamp
lands on the wrong side of a cutoff, a clock-skew-exact boundary second, and
the refusal path itself -- proving the function declines to prune rather
than silently opening a gap when it cannot be sure the retained set still
covers the window.
