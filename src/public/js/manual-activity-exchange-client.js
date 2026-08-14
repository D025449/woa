import { strFromU8, unzipSync } from "/vendor/fflate/browser.js";
import {
  parseManualActivityDocument,
  validateManualActivityArchiveManifest
} from "/shared/ManualActivityExchange.js";

function parseJson(bytes, label) {
  try {
    return JSON.parse(strFromU8(bytes));
  } catch {
    throw new Error(`${label}: invalid JSON`);
  }
}

function ensureUniqueStartTimes(activities) {
  const startTimes = new Set();
  for (const activity of activities) {
    const startTime = new Date(activity.startTime).toISOString();
    if (startTimes.has(startTime)) {
      throw new Error("The import contains duplicate activity start times");
    }
    startTimes.add(startTime);
  }
}

export function parseManualActivityBytes(bytes, sourceName = "manual activity import") {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const isZip = data.length >= 4
    && data[0] === 0x50
    && data[1] === 0x4b
    && data[2] === 0x03
    && data[3] === 0x04;
  if (!isZip) {
    const activity = parseManualActivityDocument(parseJson(data, sourceName));
    ensureUniqueStartTimes([activity]);
    return { kind: "single", activities: [activity] };
  }

  let entries;
  try {
    entries = unzipSync(data);
  } catch {
    throw new Error("The selected ZIP archive is invalid");
  }
  const manifestBytes = entries["manifest.json"];
  if (!manifestBytes) throw new Error("The ZIP archive has no manual activity manifest");
  const activityEntries = Object.entries(entries)
    .filter(([name]) => /^activities\/[^/]+\.woa\.json$/u.test(name))
    .sort(([left], [right]) => left.localeCompare(right));
  if (activityEntries.length === 0) {
    throw new Error("The ZIP archive contains no manual activities");
  }
  validateManualActivityArchiveManifest(
    parseJson(manifestBytes, "manifest.json"),
    activityEntries.length
  );
  const activities = activityEntries.map(([name, entry]) => (
    parseManualActivityDocument(parseJson(entry, name))
  ));
  ensureUniqueStartTimes(activities);
  return { kind: "archive", activities };
}

export async function parseManualActivityFile(file) {
  if (!file || typeof file.arrayBuffer !== "function") {
    throw new Error("No manual activity file selected");
  }
  return parseManualActivityBytes(new Uint8Array(await file.arrayBuffer()), file.name);
}
