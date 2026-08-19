const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_TTL_MS = 10 * 60 * 1000;

function cacheKey(uid, grouping) {
  return `${String(uid)}:${String(grouping)}`;
}

export class AnalyticsOverviewCache {
  constructor({ maxBytes = DEFAULT_MAX_BYTES, ttlMs = DEFAULT_TTL_MS, now = Date.now } = {}) {
    this.maxBytes = Math.max(0, Number(maxBytes) || 0);
    this.ttlMs = Math.max(1, Number(ttlMs) || DEFAULT_TTL_MS);
    this.now = now;
    this.entries = new Map();
    this.userRevisions = new Map();
    this.totalBytes = 0;
  }

  revision(uid) {
    return this.userRevisions.get(String(uid)) || 0;
  }

  get(uid, grouping) {
    const key = cacheKey(uid, grouping);
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.deleteEntry(key, entry);
      return null;
    }

    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.body;
  }

  set(uid, grouping, body, expectedRevision = this.revision(uid)) {
    if (expectedRevision !== this.revision(uid)) return false;
    const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
    if (buffer.byteLength === 0 || buffer.byteLength > this.maxBytes) return false;

    const key = cacheKey(uid, grouping);
    const existing = this.entries.get(key);
    if (existing) this.deleteEntry(key, existing);
    this.entries.set(key, {
      body: buffer,
      expiresAt: this.now() + this.ttlMs
    });
    this.totalBytes += buffer.byteLength;
    this.prune();
    return true;
  }

  invalidateUser(uid) {
    const userKey = String(uid);
    const prefix = `${userKey}:`;
    this.userRevisions.set(userKey, this.revision(uid) + 1);
    for (const [key, entry] of this.entries) {
      if (key.startsWith(prefix)) this.deleteEntry(key, entry);
    }
  }

  clear() {
    this.entries.clear();
    this.userRevisions.clear();
    this.totalBytes = 0;
  }

  deleteEntry(key, entry) {
    if (!this.entries.delete(key)) return;
    this.totalBytes -= entry.body.byteLength;
  }

  prune() {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.deleteEntry(key, entry);
    }
    while (this.totalBytes > this.maxBytes && this.entries.size > 0) {
      const oldest = this.entries.entries().next().value;
      this.deleteEntry(oldest[0], oldest[1]);
    }
  }
}

export const analyticsOverviewCache = new AnalyticsOverviewCache();

export function invalidateAnalyticsOverviewCache(uid) {
  if (uid != null) analyticsOverviewCache.invalidateUser(uid);
}
