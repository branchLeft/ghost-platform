# test-colour-swap-mysql.sh

## What this proves

The MySQL half of the colour-swap proof (`test-colour-swap.sh` is the
SQLite half): two real Ghost containers, one real MySQL database, proving
the swap in each order and the drain-flag sabotage are backend-agnostic --
neither depends on SQLite's own single-writer file lock. Does not repeat
the SQLite-specific busy-error measurement, since SQLite's own contention
shape has no MySQL equivalent worth counting the same way.

Usage:

```bash
docker build -t ghost-platform:local .
# build drain-sidecar:local separately
./scripts/test-colour-swap-mysql.sh drain-sidecar:local ghost-platform:local
```
