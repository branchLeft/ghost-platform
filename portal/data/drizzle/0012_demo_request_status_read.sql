-- The binding the front door's row policy reads. A prospect-facing transaction
-- binds the address the identity service verified in a transaction-local
-- setting; this function reads it back for the `own_request` policy in this
-- migration. Nothing bound reads as null, so no row matches and the policy
-- admits nothing: an unbound statement sees no request at all.
CREATE FUNCTION public.bound_address() RETURNS text
LANGUAGE sql STABLE
AS $$
  SELECT nullif(current_setting('portal.prospect_address', true), '')
$$;
--> statement-breakpoint
ALTER TABLE "portal"."demo_request" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "request_insert" ON "portal"."demo_request" AS PERMISSIVE FOR INSERT TO "portal_prospect" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "own_request" ON "portal"."demo_request" AS PERMISSIVE FOR SELECT TO "portal_prospect" USING ("portal"."demo_request"."verified_address" = public.bound_address());--> statement-breakpoint
CREATE POLICY "provisioner_read" ON "portal"."demo_request" AS PERMISSIVE FOR SELECT TO "portal_provisioner" USING (true);