-- Membership loss ends the workspace access grant, even if the member rejoins.
DELETE FROM slack_user_links
WHERE NOT EXISTS (
  SELECT 1 FROM slack_installations installation
  JOIN workspace_members member ON member.workspace_id=installation.workspace_id
    AND member.user_id=slack_user_links.user_id
  WHERE installation.id=slack_user_links.installation_id
);

CREATE TRIGGER revoke_slack_workspace_membership AFTER DELETE ON workspace_members
BEGIN
  DELETE FROM slack_user_links WHERE user_id=OLD.user_id AND installation_id IN (
    SELECT id FROM slack_installations WHERE workspace_id=OLD.workspace_id
  );
END;
