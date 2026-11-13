#!/bin/sh
set -eu
# Provisions demo-tenant's three named volumes before demo-tenant's
# unit is enabled. Idempotent; safe to re-run.
/root/platform-provision/provision_tenant_volume.py --uid '30001' 'demo-tenant'
