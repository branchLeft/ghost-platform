#!/bin/sh
# Provisions demo-1's two named volumes before demo-1's
# unit is enabled. Idempotent; safe to re-run.
set -eu
provision_tenant_volume.py --uid 30001 demo-1
