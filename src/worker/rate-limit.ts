import type { Env } from "./env";

export type RateLimitRule = { window: number; max: number };

export async function consumeFixedWindow(env: Env, key: string, rule: RateLimitRule) {
  const time = Date.now();
  const windowMs = rule.window * 1000;
  const start = Math.floor(time / windowMs) * windowMs;
  // Keep the stored window monotonic. If requests straddle a boundary and the
  // later window commits first, the older request is deliberately denied
  // instead of reopening budget in a superseded window.
  const result = await env.DB.prepare(`INSERT INTO rateLimit(id,key,count,lastRequest) VALUES (?,?,1,?)
    ON CONFLICT(key) DO UPDATE SET
      count=CASE WHEN rateLimit.lastRequest<excluded.lastRequest THEN 1 ELSE rateLimit.count+1 END,
      lastRequest=MAX(rateLimit.lastRequest,excluded.lastRequest)
    WHERE rateLimit.lastRequest<excluded.lastRequest
       OR (rateLimit.lastRequest=excluded.lastRequest AND rateLimit.count<?)
    RETURNING count`)
    .bind(crypto.randomUUID(), key, start, rule.max)
    .first<{ count: number }>();
  const blocked = result
    ? null
    : await env.DB.prepare("SELECT lastRequest FROM rateLimit WHERE key=?").bind(key).first<{ lastRequest: number }>();
  return {
    allowed: !!result,
    retryAfter: result ? null : Math.max(1, Math.ceil(((blocked?.lastRequest ?? start) + windowMs - time) / 1000)),
  };
}

export function clearRateLimit(env: Env, key: string) {
  return env.DB.prepare("DELETE FROM rateLimit WHERE key=?").bind(key).run();
}
