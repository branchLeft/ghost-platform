#!/bin/sh
set -eu
# Provisions entry-co's two named volumes before entry-co's
# unit is enabled. Idempotent; safe to re-run.
/root/platform-provision/provision_tenant_volume.py --uid '30201' 'entry-co'
