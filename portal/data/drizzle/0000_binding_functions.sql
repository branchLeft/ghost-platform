-- The binding the portal's row-level security reads. A tenant-facing
-- transaction binds a tenant (or, to look a tenant up, an organisation) in a
-- transaction-local setting; these two functions read it back for the
-- policies in the next migration.
--
-- `bound_tenant()` raises when nothing at all is bound, so an unbound
-- statement fails instead of returning nothing, or everything. When only an
-- organisation is bound it returns null, so no tenant row matches and only
-- the organisation's own register row is readable.
CREATE FUNCTION public.bound_tenant() RETURNS uuid
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  bound_tenant_id text := current_setting('portal.tenant_id', true);
  bound_org_id text := current_setting('portal.organisation_id', true);
BEGIN
  IF coalesce(bound_tenant_id, '') <> '' THEN
    RETURN bound_tenant_id::uuid;
  END IF;
  IF coalesce(bound_org_id, '') <> '' THEN
    RETURN NULL;
  END IF;
  RAISE EXCEPTION 'no tenant bound to the session' USING ERRCODE = '28000';
END
$$;
--> statement-breakpoint
CREATE FUNCTION public.bound_organisation() RETURNS text
LANGUAGE sql STABLE
AS $$
  SELECT nullif(current_setting('portal.organisation_id', true), '')
$$;
