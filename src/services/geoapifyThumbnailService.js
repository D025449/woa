import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import IORedis from "ioredis";
import sharp from "sharp";

const MAX_IMAGE_BYTES = 512 * 1024;
const MAP_CREDIT_RESERVATION = 3;
const MAX_DAILY_MAPS = Math.floor(3000 / MAP_CREDIT_RESERVATION);
const REQUEST_INTERVAL_MS = Math.ceil(1000 * MAP_CREDIT_RESERVATION / 5);
const SHARED_FAILURE_THRESHOLD = 3;
const RESERVE_REQUEST = `
  if redis.call('EXISTS', KEYS[3]) == 1 then return -1 end
  if tonumber(redis.call('GET', KEYS[1]) or '0') >= tonumber(ARGV[1]) then return -2 end
  local clock = redis.call('TIME')
  local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
  local slot = math.max(now, tonumber(redis.call('GET', KEYS[2]) or '0'))
  if slot - now > 3000 then return -3 end
  redis.call('INCR', KEYS[1])
  redis.call('EXPIRE', KEYS[1], 172800)
  redis.call('SET', KEYS[2], slot + tonumber(ARGV[2]), 'PX', 10000)
  return slot - now
`;
const RedisConstructor = /** @type {typeof import('ioredis').Redis} */ (
  /** @type {unknown} */ (IORedis)
);
let budgetConnection = null;

function getBudgetConnection() {
  if (!budgetConnection || budgetConnection.status === "end") {
    budgetConnection = new RedisConstructor(process.env.REDIS_URL, {
      lazyConnect: true,
      connectTimeout: 1000,
      commandTimeout: 1000,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null
    });
    budgetConnection.on("error", () => {});
  }
  return budgetConnection;
}

function getBudgetKeys(apiKey) {
  const hash = createHash("sha256").update(apiKey).digest("hex");
  const prefix = `woa:geoapify:${hash}`;
  return [
    `${prefix}:daily:${new Date().toISOString().slice(0, 10)}`,
    `${prefix}:rate`,
    `${prefix}:pause`
  ];
}

async function reserveMapRequest(apiKey, dailyLimit) {
  const connection = getBudgetConnection();
  if (connection.status === "wait") await connection.connect();
  return Number(await connection.eval(RESERVE_REQUEST, 3, ...getBudgetKeys(apiKey), dailyLimit, REQUEST_INTERVAL_MS));
}

async function pauseMapRequests(apiKey, durationMs) {
  await getBudgetConnection().set(getBudgetKeys(apiKey)[2], "1", "PX", durationMs);
}

async function readBoundedImage(response, controller) {
  const mimeType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (!["image/png", "image/jpeg"].includes(mimeType)
    || Number(response.headers.get("content-length")) > MAX_IMAGE_BYTES
    || !response.body) {
    controller.abort();
    throw new Error("Invalid map image response");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_IMAGE_BYTES) {
        controller.abort();
        throw new Error("Map image exceeds size limit");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

export class GeoapifyThumbnailClient {
  constructor({
    apiKey = () => process.env.GEOAPIFY_API_KEY || "",
    dailyLimit = () => Number(process.env.GEOAPIFY_DAILY_MAP_LIMIT ?? MAX_DAILY_MAPS),
    fetchImpl = globalThis.fetch,
    reserve = reserveMapRequest,
    pause = pauseMapRequests,
    timeoutMs = 15000
  } = {}) {
    this.apiKey = apiKey;
    this.dailyLimit = dailyLimit;
    this.fetchImpl = fetchImpl;
    this.reserve = reserve;
    this.pause = pause;
    this.timeoutMs = timeoutMs;
    this.pausedUntil = 0;
    this.consecutiveFailures = 0;
  }

  async getBackground({ longitude, latitude, zoom }, { onFallback = (_details) => {}, workoutId = null } = {}) {
    const nextDay = () => {
      const now = new Date();
      return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
    };
    const fallback = (reason, retryAt = Date.now() + 300000) => {
      onFallback({ reason, retryAt });
      return null;
    };
    const apiKey = String(this.apiKey()).trim();
    const limit = Math.min(MAX_DAILY_MAPS, Math.floor(this.dailyLimit()));
    if (!apiKey) return fallback("not-configured");
    if (!Number.isFinite(limit) || limit <= 0) return fallback("disabled");
    if (Date.now() < this.pausedUntil) return fallback("provider-pause", this.pausedUntil);
    if (!Number.isFinite(longitude) || Math.abs(longitude) > 180
      || !Number.isFinite(latitude) || Math.abs(latitude) > 85.05112878
      || !Number.isFinite(zoom) || zoom < 1 || zoom > 20) {
      return fallback("unsupported-viewport");
    }

    let cooldownMs = 300000;
    let failureReason = "budget-unavailable";
    let httpStatus = null;
    let timedOut = false;
    const controller = new AbortController();
    let timeout;
    try {
      const waitMs = await this.reserve(apiKey, limit);
      if (waitMs === -2) return fallback("daily-limit", nextDay());
      if (waitMs === -1) return fallback("shared-provider-pause");
      if (!Number.isFinite(waitMs) || waitMs < 0 || waitMs > 3000) return fallback("queue-busy");
      if (waitMs > 0) await delay(waitMs);
      const url = new URL("https://maps.geoapify.com/v1/staticmap");
      url.search = new URLSearchParams({
        style: "osm-bright-smooth",
        width: "320",
        height: "200",
        format: "png",
        center: `lonlat:${longitude.toFixed(7)},${latitude.toFixed(7)}`,
        zoom: zoom.toFixed(7),
        apiKey
      }).toString();
      failureReason = "network-error";
      timeout = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
      const response = await this.fetchImpl(url, {
        signal: controller.signal,
        redirect: "error",
        headers: { Accept: "image/png", "User-Agent": "WOA-WorkoutThumbnails/1.0" }
      });
      httpStatus = response.status;
      if (!response.ok) {
        failureReason = `http-${response.status}`;
        if (response.status === 429) {
          cooldownMs = nextDay() - Date.now();
        }
        controller.abort();
        throw new Error("Map provider unavailable");
      }
      failureReason = "invalid-image";
      const bytes = await readBoundedImage(response, controller);
      clearTimeout(timeout);
      timeout = undefined;
      const image = sharp(bytes, { limitInputPixels: 320 * 200, failOn: "error" });
      const metadata = await image.metadata();
      if (!["png", "jpeg"].includes(metadata.format)
        || metadata.width !== 320 || metadata.height !== 200 || (metadata.pages || 1) !== 1) {
        throw new Error("Unexpected map dimensions or format");
      }
      const webp = await image
        .modulate({ saturation: 0.45 })
        .linear(0.78, 56)
        .webp({ quality: 55, effort: 3 })
        .timeout({ seconds: 2 })
        .toBuffer();
      this.consecutiveFailures = 0;
      return `data:image/webp;base64,${webp.toString("base64")}`;
    } catch {
      this.consecutiveFailures += 1;
      const globalPause = httpStatus === 429 || this.consecutiveFailures >= SHARED_FAILURE_THRESHOLD;
      const retryAt = Date.now() + cooldownMs;
      if (globalPause) this.pausedUntil = retryAt;
      const reason = timedOut ? "timeout" : failureReason;
      console.warn("[thumbnail] map.failed", {
        workoutId,
        reason,
        httpStatus,
        consecutiveFailures: this.consecutiveFailures,
        globalPause,
        retryAt: new Date(retryAt).toISOString()
      });
      if (globalPause) await this.pause(apiKey, cooldownMs).catch(() => {});
      return fallback(reason, retryAt);
    } finally {
      clearTimeout(timeout);
    }
  }
}

export default new GeoapifyThumbnailClient();