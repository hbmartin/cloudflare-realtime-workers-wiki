import { sha256Hex } from "../shared/import-integrity";

// Cross-zone Worker subrequests share Cloudflare's synthetic source IP. The
// originating zone keeps unrelated Worker callers out of the same bucket.
const CROSS_ZONE_WORKER_IP = "2a06:98c0:3600::103";

export function sourceRateLimitKey(request: Request) {
  const ip = request.headers.get("cf-connecting-ip")?.trim().toLowerCase() || "unattributed";
  const workerZone =
    ip === CROSS_ZONE_WORKER_IP ? request.headers.get("cf-worker")?.trim().toLowerCase() || "unknown" : null;
  return sha256Hex(workerZone ? `worker:${workerZone}` : `ip:${ip}`);
}
