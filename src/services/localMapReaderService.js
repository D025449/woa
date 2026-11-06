import path from "node:path";
import { randomUUID } from "node:crypto";
import { openSync, closeSync, writeFileSync, unlinkSync, readdirSync, lstatSync, readFileSync } from "node:fs";
import { readMapArchiveSet, mapArchivePath } from "./localMapArchiveSetService.js";

export function withMapReaderGate(directory, operation) {
  const filename = path.join(directory, ".maps-reader-gate.lock");
  const descriptor = openSync(filename, "wx", 0o600);
  try { return operation(); }
  finally { closeSync(descriptor); unlinkSync(filename); }
}

export function mapReaderFilename(directory, id) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid map reader ID");
  return path.join(directory, `.maps-reader-${id}.json`);
}

export function reserveMapReader(directory, id = randomUUID()) {
  const entries = readMapArchiveSet(directory).active.archives;
  writeFileSync(mapReaderFilename(directory, id), JSON.stringify({ version: 1, pid: process.pid, archives: entries }),
    { flag: "wx", mode: 0o600 });
  return { id, entries };
}

export function releaseMapReader(directory, id) {
  try { unlinkSync(mapReaderFilename(directory, id)); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}

export function readReservedMapFiles(directory) {
  const files = new Set();
  for (const name of readdirSync(directory).filter(name => /^\.maps-reader-[a-f0-9-]{36}\.json$/.test(name))) {
    const filename = path.join(directory, name);
    const details = lstatSync(filename);
    if (!details.isFile() || details.size > 128 * 1024) throw new Error("Invalid map reader reservation");
    const reader = JSON.parse(readFileSync(filename, "utf8"));
    if (reader.version !== 1 || !Number.isSafeInteger(reader.pid) || reader.pid <= 0
      || !Array.isArray(reader.archives) || reader.archives.length > 16) throw new Error("Invalid map reader reservation");
    try { process.kill(reader.pid, 0); }
    catch (error) { if (error.code === "ESRCH") continue; if (error.code !== "EPERM") throw error; }
    for (const entry of reader.archives) {
      mapArchivePath(directory, entry);
      files.add(entry.filename);
    }
  }
  return files;
}