DROP TRIGGER prevent_final_owner_demotion;
DROP TRIGGER prevent_final_owner_removal;

CREATE TRIGGER prevent_final_owner_demotion
BEFORE UPDATE OF role ON workspace_members
WHEN OLD.role = 'owner' AND NEW.role <> 'owner'
 AND EXISTS (SELECT 1 FROM workspaces WHERE id = OLD.workspace_id)
 AND (SELECT COUNT(*) FROM workspace_members WHERE workspace_id = OLD.workspace_id AND role = 'owner') <= 1
BEGIN
  SELECT RAISE(ABORT, 'final_owner');
END;

CREATE TRIGGER prevent_final_owner_removal
BEFORE DELETE ON workspace_members
WHEN OLD.role = 'owner'
 AND EXISTS (SELECT 1 FROM workspaces WHERE id = OLD.workspace_id)
 AND (SELECT COUNT(*) FROM workspace_members WHERE workspace_id = OLD.workspace_id AND role = 'owner') <= 1
BEGIN
  SELECT RAISE(ABORT, 'final_owner');
END;
