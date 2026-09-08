-- Migration 0019 was already deployed before retired_at writes were cast.
-- Normalize rows it stored with SQLite's REAL storage class.
UPDATE slack_unfurls
   SET retired_at = CAST(retired_at AS INTEGER)
 WHERE retired_at IS NOT NULL
   AND typeof(retired_at) <> 'integer';
