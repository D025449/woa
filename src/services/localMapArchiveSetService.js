import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync, lstatSync, createReadStream } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { withMapStorageBudget } from "./localMapStorageService.js";

export const MAP_ARCHIVE_MANIFEST = "map-archive-set.json";

export function mapArchiveFingerprint(filename) {
  const details = lstatSync(filename, { bigint: true });
  if (!details.isFile()) throw new Error("Map archive must be a regular file");
  return [details.dev, details.ino, details.size, details.mtimeNs, details.ctimeNs].join(":");
}

export function mapArchivePath(directory, entry, checkFiles = true) {
  if (!entry || !/^[a-z0-9]+(?:[-/][a-z0-9]+)*$/.test(entry.id)) throw new Error("Invalid archive region");
  const basename = `${entry.id.replaceAll("/", "--")}.mbtiles`;
  if (entry.filename !== basename && !new RegExp(`^versions/[a-f0-9-]{36}/${basename.replaceAll(".", "\\.")}$`).test(entry.filename)) {
    throw new Error("Invalid archive set path");
  }
  if (!checkFiles) return path.join(directory, entry.filename);
  let current = directory;
  for (const component of entry.filename.split("/")) {
    current = path.join(current, component);
    if (lstatSync(current).isSymbolicLink()) throw new Error("Archive set symlinks are unsupported");
  }
  mapArchiveFingerprint(current);
  return current;
}

function validateSet(directory, set, checkFiles = true) {
  if (!set || typeof set.id !== "string" || !/^[a-z0-9-]{1,80}$/.test(set.id)
    || !Array.isArray(set.archives) || set.archives.length > 16
    || new Set(set.archives.map(entry => entry.id)).size !== set.archives.length) throw new Error("Invalid archive set");
  for (const entry of set.archives) {
    const filename = mapArchivePath(directory, entry, checkFiles);
    if (checkFiles && entry.fingerprint && mapArchiveFingerprint(filename) !== entry.fingerprint) throw new Error("Archive file changed since activation");
  }
  return set;
}

export function readMapArchiveSet(directory, { checkFiles = true } = {}) {
  let raw;
  try {
    const filename = path.join(directory, MAP_ARCHIVE_MANIFEST);
    if (lstatSync(filename).isSymbolicLink() || lstatSync(filename).size > 128 * 1024) throw new Error("Invalid archive manifest");
    raw = readFileSync(filename, "utf8");
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (raw !== undefined) {
    const manifest = JSON.parse(raw);
    if (manifest.version !== 1) throw new Error("Unsupported archive manifest");
    return { version: 1, managed: true, active: validateSet(directory, manifest.active, checkFiles),
      previous: manifest.previous ? validateSet(directory, manifest.previous, false) : null };
  }
  const filenames = (() => { try { return readdirSync(directory); } catch (error) { if (error.code === "ENOENT") return []; throw error; } })()
    .filter(name => name.endsWith(".mbtiles")).sort();
  const archives = filenames.map(filename => ({ id: filename.slice(0, -8).replaceAll("--", "/"), filename,
    sha256: null, source: null, fingerprint: mapArchiveFingerprint(path.join(directory, filename)) }));
  const identity = archives.map(entry => [entry.filename, mapArchiveFingerprint(mapArchivePath(directory, entry))]);
  return { version: 1, managed: false, active: { id: `legacy-${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`,
    archives }, previous: null };
}

export function mapArchiveSetIdentity(directory, set = readMapArchiveSet(directory, { checkFiles: false }).active) {
  return createHash("sha256").update(JSON.stringify([set.id, set.archives.map(entry => {
    let fingerprint;
    try { fingerprint = mapArchiveFingerprint(mapArchivePath(directory, entry)); }
    catch (error) { if (error.code !== "ENOENT") throw error; fingerprint = "missing"; }
    return [entry.id, entry.filename, fingerprint];
  })])).digest("hex");
}

export async function describeMapArchive(directory, entry) {
  const filename = mapArchivePath(directory, entry);
  const fingerprint = mapArchiveFingerprint(filename);
  if (entry.fingerprint && entry.fingerprint !== fingerprint) throw new Error("Archive file changed since activation");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  const sha256 = hash.digest("hex");
  if (mapArchiveFingerprint(filename) !== fingerprint || entry.sha256 && entry.sha256 !== sha256) {
    throw new Error("Archive checksum changed");
  }
  return { ...entry, bytes: Number(lstatSync(filename).size), fingerprint, sha256 };
}

export async function activateMapArchiveSet(config, active, expectedIdentity, previous = readMapArchiveSet(config.dataDirectory, { checkFiles: false }).active) {
  const manifest = { version: 1, active: validateSet(config.dataDirectory, active), previous };
  const payload = JSON.stringify(manifest);
  if (Buffer.byteLength(payload) > 128 * 1024) throw new Error("Archive manifest too large");
  return withMapStorageBudget(config, Buffer.byteLength(payload), async () => {
    if (mapArchiveSetIdentity(config.dataDirectory) !== expectedIdentity) throw new Error("Active archive set changed; check again");
    const temporary = path.join(config.dataDirectory, `${MAP_ARCHIVE_MANIFEST}.${randomUUID()}.part`);
    try {
      const output = await open(temporary, "wx", 0o600);
      try { await output.writeFile(payload); await output.sync(); } finally { await output.close(); }
      await rename(temporary, path.join(config.dataDirectory, MAP_ARCHIVE_MANIFEST));
      const directory = await open(config.dataDirectory, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
    return manifest;
  });
}