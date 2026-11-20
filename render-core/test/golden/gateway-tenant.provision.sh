#!/bin/sh
set -eu
# Provisions gw-co's three named volumes before gw-co's
# unit is enabled. Idempotent; safe to re-run.
/root/platform-provision/provision_tenant_volume.py --uid '30401' 'gw-co'
