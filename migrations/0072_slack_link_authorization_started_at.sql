-- Verification time and relink timestamps fence individual operations. Preserve
-- a separate start for historical previews under an unchanged access grant.
ALTER TABLE slack_user_links ADD COLUMN authorization_started_at INTEGER;
UPDATE slack_user_links SET authorization_started_at=coalesce(verified_at,linked_at);
