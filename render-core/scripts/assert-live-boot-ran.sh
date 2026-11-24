#!/usr/bin/env bash
# Fails unless the live tenant boot test ran and passed. Reads a verbose vitest
# log. A skipped live test (no TENANT_BOOT_IMAGE, or no Docker) must not pass
# the boot job, so it is refused here rather than reported as green.
set -euo pipefail

log="${1:?usage: assert-live-boot-ran.sh <vitest-verbose-log>}"
test_name='starts the throwaway database, then the rendered Ghost, and gets 200 on /'

if grep -q "↓ ${test_name}" "$log"; then
  echo "::error::the live tenant boot test was skipped; the boot job must not pass without it" >&2
  exit 1
fi
if ! grep -q "✓ ${test_name}" "$log"; then
  echo "::error::the live tenant boot test did not report a pass" >&2
  exit 1
fi
echo "live tenant boot test passed"
