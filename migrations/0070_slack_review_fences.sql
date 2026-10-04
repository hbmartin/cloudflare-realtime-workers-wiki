ALTER TABLE slack_channel_subscriptions ADD COLUMN validation_revision INTEGER NOT NULL DEFAULT 0;

-- Every accepted validation or repair invalidates outstanding snapshots, even
-- when its evidence is unchanged or two checks finish in the same millisecond.
CREATE TRIGGER slack_mapping_validation_revision
AFTER UPDATE OF installation_id,channel_id,created_by,channel_name,channel_type,
 validation_state,validation_error,validation_scope_error_revision,validated_at,
 bot_is_member,notification_blocked_at,notification_error ON slack_channel_subscriptions
BEGIN
 UPDATE slack_channel_subscriptions SET validation_revision=OLD.validation_revision+1 WHERE id=NEW.id;
END;
