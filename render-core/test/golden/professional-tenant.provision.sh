#!/bin/sh
# Provisions pro-co's two named volumes before pro-co's
# unit is enabled. Idempotent; safe to re-run.
set -eu
provision_tenant_volume.py --uid 30301 pro-co
