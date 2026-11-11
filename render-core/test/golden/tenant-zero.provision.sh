#!/bin/sh
set -eu
# Provisions blog's three named volumes before blog's
# unit is enabled. Idempotent; safe to re-run.
/root/platform-provision/provision_tenant_volume.py --uid '30001' 'blog'
