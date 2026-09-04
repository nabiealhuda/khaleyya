/**
 * In-memory sliding-window rate limiter. This is intentionally simple: it
 * lives in one Node process's memory. That's the correct trade-off while the
 * app runs as a single Railway service — it adds zero infra dependencies and
 * genuinely stops brute-force/abuse traffic on this instance. The moment the
 * app is scaled to multiple replicas, swap the `hits` Map below for a Redis
 * (e.g. Upstash) INCR+EXPIRE pair — the call signature here is designed so
 * that swap doesn't touch any call site.
 */

type Bucket = { count: number; resetAt: number };
const hits = new Map<string, Bucket>();

// Periodically drop expired buckets so this map can't grow unbounded under
// sustained traffic from many distinct IPs.
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of hits) {
    if (bucket.resetAt < now) hits.delete(key);
  }
}, 60_000).unref?.();

export type RateLimitResult = { allowed: boolean; remaining: number; resetAt: number };

export function rateLimit(
  key: string,
  { limit, windowMs }: { limit: number; windowMs: number }
): RateLimitResult {
  const now = Date.now();
  const bucket = hits.get(key);

  if (!bucket || bucket.resetAt < now) {
    const resetAt = now + windowMs;
    hits.set(key, { count: 1, resetAt });
    return { allowed: true, remaining: limit - 1, resetAt };
  }

  if (bucket.count >= limit) {
    return { allowed: false, remaining: 0, resetAt: bucket.resetAt };
  }

  bucket.count += 1;
  return { allowed: true, remaining: limit - bucket.count, resetAt: bucket.resetAt };
}

/** Best-effort client IP extraction behind Railway's proxy. */
export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}
