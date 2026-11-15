CREATE FUNCTION kala_guard_operator_workspace_transition() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $body$
DECLARE tenant text; workspace text;
BEGIN
  IF TG_OP='DELETE' THEN tenant:=OLD.organization_id; workspace:=OLD.id;
  ELSE tenant:=NEW.organization_id; workspace:=NEW.id; END IF;
  IF EXISTS (
    SELECT 1 FROM public.settings_operator_operations
    WHERE organization_id=tenant AND resource_kind='workspace' AND resource_id=workspace
      AND state='applying' AND resulting_revision IS NULL
      AND id::text IS DISTINCT FROM current_setting('kala.settings_operation_id',true)
  ) THEN
    RAISE EXCEPTION 'workspace_operation_in_progress' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$body$;
REVOKE ALL ON FUNCTION kala_guard_operator_workspace_transition() FROM PUBLIC;
CREATE TRIGGER kala_guard_operator_workspace_transition
  BEFORE UPDATE OR DELETE ON workspaces
  FOR EACH ROW EXECUTE FUNCTION kala_guard_operator_workspace_transition();
