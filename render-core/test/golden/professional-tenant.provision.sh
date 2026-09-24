#!/bin/sh
set -eu
# Provisions pro-co's two named volumes before pro-co's
# unit is enabled. Idempotent; safe to re-run.
/root/platform-provision/provision_tenant_volume.py --uid '30301' 'pro-co'
