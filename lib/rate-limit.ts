// In-memory per-user sliding window rate limiter. Fine for a single instance in
// test mode; a distributed store (e.g. Redis) is required in production.
const buckets = new Map<string, number[]>();

export function isRateLimited(
  key: string,
  maxRequests: number,
  windowMs: number
): boolean {
  const now = Date.now();
  const windowStart = now - windowMs;

  const hits = (buckets.get(key) ?? []).filter((t) => t > windowStart);

  if (hits.length >= maxRequests) {
    buckets.set(key, hits);
    return true;
  }

  hits.push(now);
  buckets.set(key, hits);
  return false;
}