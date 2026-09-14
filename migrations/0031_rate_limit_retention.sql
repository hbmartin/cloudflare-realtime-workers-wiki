-- New high-cardinality rate-limit buckets retire one stale predecessor as they
-- arrive. Cron remains the idle/backlog cleanup path.
CREATE TRIGGER prune_stale_rate_limit_on_insert AFTER INSERT ON rateLimit BEGIN
  DELETE FROM rateLimit WHERE id=(
    SELECT id FROM rateLimit
     WHERE id!=NEW.id AND lastRequest<NEW.lastRequest-86400000
     ORDER BY lastRequest,id LIMIT 1
  );
END;
