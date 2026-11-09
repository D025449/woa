import { createHash, randomUUID } from "node:crypto";
import { getSessionRedisClient } from "../services/sessionService.js";

const SCRIPT = `
local clock = redis.call('TIME')
local now = clock[1] * 1000 + math.floor(clock[2] / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - 60000)
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[1]) then
  local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  return {0, math.max(1, math.ceil((tonumber(oldest[2]) + 60000 - now) / 1000))}
end
redis.call('ZADD', KEYS[1], now, ARGV[2])
redis.call('PEXPIRE', KEYS[1], 60000)
return {1, 0}
`;

export default function publicApiRateLimit(bucket, limit, identify, { getClient = getSessionRedisClient } = {}) {
  return async (req, res, next) => {
    res.set("Cache-Control", "no-store");
    try {
      const identity = identify(req);
      if (typeof identity !== "string" || !identity) throw new Error("Missing rate-limit identity");
      const digest = createHash("sha256").update(identity).digest("hex");
      const client = await getClient();
      const result = await client.eval(SCRIPT, { keys: [`woa:api:v1:${bucket}:${digest}`],
        arguments: [String(limit), randomUUID()] });
      if (!Array.isArray(result) || result.length !== 2 || typeof result[0] !== "number" || ![0, 1].includes(result[0])
        || typeof result[1] !== "number" || !Number.isInteger(result[1])
        || (result[0] === 1 ? result[1] !== 0 : result[1] < 1 || result[1] > 60)) {
        throw new Error("Invalid rate-limit result");
      }
      if (Number(result[0]) === 1) return next();
      const retry = Math.max(1, Math.min(60, Number(result[1]) || 60));
      res.set("Retry-After", String(Math.ceil(retry)));
      return res.status(429).json({ error: { code: "rate_limited", message: "Request allowance exceeded.", request_id: randomUUID() } });
    } catch {
      return res.status(503).json({ error: { code: "service_unavailable", message: "API protection unavailable.", request_id: randomUUID() } });
    }
  };
}
