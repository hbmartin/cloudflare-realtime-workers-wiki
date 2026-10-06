-- Discover orphan reservations from live unsent children, not retained root history.
CREATE INDEX slack_digest_unsent_children ON slack_digest_messages(receipt_id,id)
 WHERE state='pending' AND attempted_at IS NULL;
