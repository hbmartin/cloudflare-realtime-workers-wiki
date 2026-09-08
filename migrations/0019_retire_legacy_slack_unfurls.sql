-- Slack's chat.unfurl API requires the timestamp of the message receiving the
-- preview. Migration 0017 could not reconstruct it from the legacy schema, so
-- explicitly retire those pending rows instead of reporting them as delivered.
ALTER TABLE slack_unfurls ADD COLUMN retired_at INTEGER;
ALTER TABLE slack_unfurls ADD COLUMN retirement_reason TEXT;

UPDATE slack_unfurls
   SET retired_at = CAST(unixepoch('subsec') * 1000 AS INTEGER),
       retirement_reason = 'legacy_missing_message_ts'
 WHERE delivered_at IS NULL AND message_ts IS NULL;

UPDATE outbox
   SET last_error = 'legacy_unfurl_missing_message_ts'
 WHERE topic = 'slack_unfurl'
   AND EXISTS (
     SELECT 1 FROM slack_unfurls unfurl
      WHERE unfurl.id = json_extract(outbox.payload_json, '$.unfurlId')
        AND unfurl.retirement_reason = 'legacy_missing_message_ts'
   );
