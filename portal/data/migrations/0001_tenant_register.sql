-- The portal's first migration: the tenant register, and the one mechanism
-- every tenant-facing table is isolated by.
--
-- A tenant-facing query runs as `portal_tenant` with the tenant bound in the
-- transaction-local setting `portal.tenant_id`. `portal.bound_tenant()` raises
-- when nothing is bound, so a row-level-security policy built on it makes an
-- unbound query fail at run time rather than return nothing, or everything.
-- Owner-console reads run as `portal_owner` under a separate policy.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'portal_tenant') THEN
    CREATE ROLE portal_tenant NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'portal_owner') THEN
    CREATE ROLE portal_owner NOLOGIN NOINHERIT;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA portal TO portal_tenant, portal_owner;

CREATE FUNCTION portal.bound_tenant() RETURNS uuid
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  bound text := current_setting('portal.tenant_id', true);
BEGIN
  IF bound IS NULL OR bound = '' THEN
    RAISE EXCEPTION 'no tenant bound to the session' USING ERRCODE = '28000';
  END IF;
  RETURN bound::uuid;
END
$$;

REVOKE ALL ON FUNCTION portal.bound_tenant() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION portal.bound_tenant() TO portal_tenant, portal_owner;

-- Applies the isolation to a table that has a `tenant_id uuid` column. Every
-- later tenant-facing table is isolated by calling this, never by writing its
-- own policy; the migrator's own check refuses a table that has the column
-- and was not given the policy.
CREATE FUNCTION portal.isolate_table(target regclass) RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', target);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %s FOR ALL TO portal_tenant '
    'USING (tenant_id = portal.bound_tenant()) '
    'WITH CHECK (tenant_id = portal.bound_tenant())', target);
  EXECUTE format(
    'CREATE POLICY owner_all ON %s FOR ALL TO portal_owner '
    'USING (true) WITH CHECK (true)', target);
END
$$;

CREATE TABLE portal.tenant_register (
  tenant_id uuid PRIMARY KEY,
  zitadel_org_id text NOT NULL UNIQUE CHECK (zitadel_org_id <> ''),
  created_at timestamptz NOT NULL DEFAULT now()
);

SELECT portal.isolate_table('portal.tenant_register');

-- A tenant may read its own row and nothing else; only the owner path writes.
GRANT SELECT ON portal.tenant_register TO portal_tenant;
GRANT SELECT, INSERT, UPDATE, DELETE ON portal.tenant_register TO portal_owner;

-- Resolving a signed-in session's organisation to its tenant happens before
-- any tenant is bound, so it cannot go through the isolated table. It is the
-- one narrow exception: it answers for the single organisation named and
-- returns the tenant id alone.
CREATE FUNCTION portal.tenant_for_org(org text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, portal
AS $$
  SELECT tenant_id FROM portal.tenant_register WHERE zitadel_org_id = org
$$;

REVOKE ALL ON FUNCTION portal.tenant_for_org(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION portal.tenant_for_org(text) TO portal_tenant, portal_owner;
