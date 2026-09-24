#!/bin/sh
# Provisions entry-co's two named volumes before entry-co's
# unit is enabled. Idempotent; safe to re-run.
set -eu
provision_tenant_volume.py --uid 30201 entry-co
