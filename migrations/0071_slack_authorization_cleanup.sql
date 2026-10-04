-- Slack login is a primary factor; private Slack access is a separate grant.
ALTER TABLE slack_user_links ADD COLUMN security_generation INTEGER;
ALTER TABLE slack_primary_factor_proofs ADD COLUMN security_generation INTEGER;
ALTER TABLE slack_primary_factor_proofs ADD COLUMN authentication_source TEXT
  CHECK(authentication_source IS NULL OR authentication_source IN ('sign_in','sign_up'));
ALTER TABLE slack_installations ADD COLUMN file_scope_error_revision INTEGER;

CREATE VIEW slack_protected_accounts AS
 SELECT security.user_id,security.generation FROM account_security security
 WHERE security.recovery_required=0 AND security.codes_saved=1
   AND (EXISTS(SELECT 1 FROM twoFactor factor WHERE factor.userId=security.user_id AND factor.verified=1)
     OR EXISTS(SELECT 1 FROM passkey factor WHERE factor.userId=security.user_id));

-- Compatibility choice: retain existing protected-account bindings. New writes
-- must carry an explicitly authorized generation; older Workers cannot mint it.
UPDATE slack_user_links SET security_generation=(
 SELECT generation FROM slack_protected_accounts WHERE user_id=slack_user_links.user_id);
DELETE FROM slack_primary_factor_proofs;

CREATE VIEW slack_authorized_user_links AS
 SELECT link.* FROM slack_user_links link
 JOIN slack_protected_accounts security ON security.user_id=link.user_id AND security.generation=link.security_generation
 JOIN slack_installations installation ON installation.id=link.installation_id
   AND installation.generation=link.installation_generation AND installation.disconnected_at IS NULL
 JOIN workspace_members member ON member.workspace_id=installation.workspace_id AND member.user_id=link.user_id
 WHERE (link.migration_state='legacy' AND link.verification_method='legacy_command')
   OR EXISTS(SELECT 1 FROM account oauth WHERE oauth.id=link.better_auth_account_id AND oauth.userId=link.user_id
     AND oauth.providerId='slack' AND oauth.accountId=installation.team_id||':'||link.slack_user_id);

CREATE TRIGGER revoke_slack_security_generation AFTER UPDATE OF generation,recovery_required ON account_security
 WHEN NEW.generation<>OLD.generation OR (NEW.recovery_required=1 AND OLD.recovery_required<>1)
BEGIN
 DELETE FROM slack_user_links WHERE user_id=NEW.user_id;
 DELETE FROM slack_primary_factor_proofs WHERE user_id=NEW.user_id;
END;
CREATE TRIGGER unlink_slack_oauth BEFORE DELETE ON account WHEN OLD.providerId='slack'
BEGIN
 DELETE FROM slack_user_links WHERE better_auth_account_id=OLD.id;
END;

-- Explicit ownership supplied by the allocating Worker survives a disconnect
-- between Slack's response and the successful artifact save.
DROP TRIGGER slack_file_allocation_owner;
CREATE TRIGGER slack_file_allocation_owner AFTER UPDATE OF slack_file_id ON slack_file_artifacts
 WHEN NEW.slack_file_id IS NOT NULL AND NEW.slack_file_id IS NOT OLD.slack_file_id
BEGIN
 UPDATE slack_file_artifacts SET
 cleanup_workspace_id=coalesce(NEW.cleanup_workspace_id,(SELECT workspace_id FROM slack_installations WHERE id=NEW.installation_id)),
 cleanup_team_id=coalesce(NEW.cleanup_team_id,(SELECT team_id FROM slack_installations WHERE id=NEW.installation_id AND generation=NEW.installation_generation)),
 cleanup_bot_user_id=coalesce(NEW.cleanup_bot_user_id,(SELECT bot_user_id FROM slack_installations WHERE id=NEW.installation_id AND generation=NEW.installation_generation))
 WHERE id=NEW.id;
END;
DROP TRIGGER slack_file_allocation_owner_insert;
CREATE TRIGGER slack_file_allocation_owner_insert AFTER INSERT ON slack_file_artifacts WHEN NEW.slack_file_id IS NOT NULL
BEGIN
 UPDATE slack_file_artifacts SET
 cleanup_workspace_id=coalesce(NEW.cleanup_workspace_id,(SELECT workspace_id FROM slack_installations WHERE id=NEW.installation_id)),
 cleanup_team_id=coalesce(NEW.cleanup_team_id,(SELECT team_id FROM slack_installations WHERE id=NEW.installation_id AND generation=NEW.installation_generation)),
 cleanup_bot_user_id=coalesce(NEW.cleanup_bot_user_id,(SELECT bot_user_id FROM slack_installations WHERE id=NEW.installation_id AND generation=NEW.installation_generation))
 WHERE id=NEW.id;
END;
