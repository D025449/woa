import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import unzipper from "unzipper";

import { parseFitBufferCompactBrowser } from "../public/js/fit-import-compact-browser.js";

const DEFAULT_ARCHIVES = [
  "import/AllFitFiles 2.zip",
  "import/UploadedFiles_0-_Part1.zip",
  "import/UploadedFiles_0-_Part2.zip",
  "import/UploadedFiles_20220094-_Part1.zip",
  "import/23778708965.zip"
];
const DEFAULT_OUTPUT = "import/AllFitFiles-deduplicated.zip";
const BERLIN_TIME_ZONE = "Europe/Berlin";
const MIN_WORKOUT_RECORD_COUNT = 300;

function parseArguments(argv) {
  const options = {
    dryRun: false,
    output: DEFAULT_OUTPUT,
    archives: []
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") {
      options.dryRun = true;
    } else if (argument === "--output") {
      options.output = argv[++index];
    } else {
      options.archives.push(argument);
    }
  }

  if (options.archives.length === 0) {
    options.archives = [...DEFAULT_ARCHIVES];
  }
  if (!options.output) {
    throw new Error("--output requires a path");
  }
  return options;
}

function fitStartTimeMs(parsed) {
  let startTimeMs = Number.POSITIVE_INFINITY;
  for (const session of parsed.sessions || []) {
    const candidate = Number(session?.start_time);
    if (Number.isFinite(candidate)) {
      startTimeMs = Math.min(startTimeMs, candidate);
    }
  }

  if (Number.isFinite(startTimeMs)) return startTimeMs;
  const baseTimestampSec = Number(parsed.compactRecords?.baseTimestampSec);
  return Number.isFinite(baseTimestampSec) ? baseTimestampSec * 1000 : null;
}

function berlinFileName(startTimeMs) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: BERLIN_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date(startTimeMs));
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return [
    values.year,
    values.month,
    values.day,
    values.hour,
    values.minute,
    values.second
  ].join("-") + ".fit";
}

function countValidGpsPoints(compactRecords) {
  const latitudes = compactRecords?.positionLatsE6;
  const longitudes = compactRecords?.positionLongsE6;
  if (!latitudes || !longitudes) return 0;

  let count = 0;
  for (let index = 0; index < latitudes.length; index += 1) {
    if (latitudes[index] !== 0x7fffffff && longitudes[index] !== 0x7fffffff) {
      count += 1;
    }
  }
  return count;
}

function candidateQuality(candidate) {
  return [
    candidate.recordCount,
    candidate.validGpsPointCount,
    candidate.sessionCount,
    candidate.byteLength
  ];
}

function compareCandidateQuality(left, right) {
  const leftQuality = candidateQuality(left);
  const rightQuality = candidateQuality(right);
  for (let index = 0; index < leftQuality.length; index += 1) {
    if (leftQuality[index] !== rightQuality[index]) {
      return leftQuality[index] - rightQuality[index];
    }
  }
  const sourceComparison = right.archivePath.localeCompare(left.archivePath);
  if (sourceComparison !== 0) return sourceComparison;
  return right.entryPath.localeCompare(left.entryPath);
}

async function scanArchives(archivePaths) {
  const candidatesByStartTime = new Map();
  const failures = [];
  const skippedTooShort = [];
  let inputEntryCount = 0;

  for (const archivePath of archivePaths) {
    const directory = await unzipper.Open.file(archivePath);
    for (const entry of directory.files) {
      if (
        entry.type !== "File"
        || !entry.path.toLowerCase().endsWith(".fit")
        || entry.path.startsWith("__MACOSX/")
      ) {
        continue;
      }

      inputEntryCount += 1;
      try {
        const bytes = await entry.buffer();
        const parsed = parseFitBufferCompactBrowser(bytes, {
          correctDistanceBatching: false
        });
        const recordCount = Number(parsed.compactRecords?.recordCount || 0);
        if (recordCount < MIN_WORKOUT_RECORD_COUNT) {
          skippedTooShort.push({
            archivePath,
            entryPath: entry.path,
            recordCount
          });
          continue;
        }
        const startTimeMs = fitStartTimeMs(parsed);
        if (!Number.isFinite(startTimeMs) || startTimeMs <= 0) {
          throw new Error("FIT file has no usable start time");
        }

        const candidate = {
          archivePath,
          entryPath: entry.path,
          startTimeMs,
          startTimeIso: new Date(startTimeMs).toISOString(),
          outputName: berlinFileName(startTimeMs),
          byteLength: bytes.length,
          sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
          recordCount,
          validGpsPointCount: countValidGpsPoints(parsed.compactRecords),
          sessionCount: Array.isArray(parsed.sessions) ? parsed.sessions.length : 0
        };
        const key = candidate.startTimeIso;
        const candidates = candidatesByStartTime.get(key) || [];
        candidates.push(candidate);
        candidatesByStartTime.set(key, candidates);
      } catch (error) {
        failures.push({
          archivePath,
          entryPath: entry.path,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  const winners = [];
  const duplicateGroups = [];
  for (const candidates of candidatesByStartTime.values()) {
    candidates.sort((left, right) => compareCandidateQuality(right, left));
    const winner = candidates[0];
    winners.push(winner);
    if (candidates.length > 1) {
      duplicateGroups.push({
        startTimeIso: winner.startTimeIso,
        outputName: winner.outputName,
        exactDuplicate: new Set(candidates.map((candidate) => candidate.sha256)).size === 1,
        selected: winner,
        discarded: candidates.slice(1)
      });
    }
  }
  winners.sort((left, right) => left.startTimeMs - right.startTimeMs);

  const outputNames = new Map();
  const namingCollisions = [];
  for (const winner of winners) {
    const existing = outputNames.get(winner.outputName);
    if (existing && existing.startTimeIso !== winner.startTimeIso) {
      namingCollisions.push({ outputName: winner.outputName, workouts: [existing, winner] });
    } else {
      outputNames.set(winner.outputName, winner);
    }
  }

  return {
    inputEntryCount,
    candidatesByStartTime,
    winners,
    duplicateGroups,
    failures,
    skippedTooShort,
    namingCollisions
  };
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

async function writeArchive(winners, outputPath) {
  const stagingDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "woa-fit-dedupe-"));
  const absoluteOutputPath = path.resolve(outputPath);

  try {
    const directories = new Map();
    for (const winner of winners) {
      let directory = directories.get(winner.archivePath);
      if (!directory) {
        directory = await unzipper.Open.file(winner.archivePath);
        directories.set(winner.archivePath, directory);
      }
      const entry = directory.files.find((candidate) => candidate.path === winner.entryPath);
      if (!entry) {
        throw new Error(`Missing selected entry ${winner.entryPath} in ${winner.archivePath}`);
      }
      await fs.writeFile(path.join(stagingDirectory, winner.outputName), await entry.buffer());
    }

    await fs.mkdir(path.dirname(absoluteOutputPath), { recursive: true });
    await fs.rm(absoluteOutputPath, { force: true });
    await run(
      "zip",
      ["-q", "-6", "-X", absoluteOutputPath, ...winners.map((winner) => winner.outputName)],
      { cwd: stagingDirectory }
    );
  } finally {
    await fs.rm(stagingDirectory, { recursive: true, force: true });
  }
}

async function verifyArchive(outputPath, winners) {
  const directory = await unzipper.Open.file(outputPath);
  const entries = directory.files.filter(
    (entry) => entry.type === "File" && entry.path.toLowerCase().endsWith(".fit")
  );
  if (entries.length !== winners.length) {
    throw new Error(`Output contains ${entries.length} FIT files, expected ${winners.length}`);
  }
  const expectedNames = new Set(winners.map((winner) => winner.outputName));
  for (const entry of entries) {
    if (!expectedNames.delete(entry.path)) {
      throw new Error(`Unexpected or duplicate output entry: ${entry.path}`);
    }
  }
  if (expectedNames.size > 0) {
    throw new Error(`Output is missing ${expectedNames.size} expected entries`);
  }
}

function buildReport(scan, archivePaths, outputPath, dryRun) {
  const exactDuplicateGroupCount = scan.duplicateGroups.filter(
    (group) => group.exactDuplicate
  ).length;
  return {
    dryRun,
    generatedAt: new Date().toISOString(),
    timezone: BERLIN_TIME_ZONE,
    namingPattern: "YYYY-MM-DD-HH-mm-ss.fit",
    inputArchives: archivePaths,
    outputPath,
    inputEntryCount: scan.inputEntryCount,
    outputEntryCount: scan.winners.length,
    removedDuplicateCount:
      scan.inputEntryCount
      - scan.winners.length
      - scan.failures.length
      - scan.skippedTooShort.length,
    duplicateGroupCount: scan.duplicateGroups.length,
    exactDuplicateGroupCount,
    differingDuplicateGroupCount: scan.duplicateGroups.length - exactDuplicateGroupCount,
    parseFailureCount: scan.failures.length,
    skippedTooShortCount: scan.skippedTooShort.length,
    namingCollisionCount: scan.namingCollisions.length,
    parseFailures: scan.failures,
    skippedTooShortSamples: scan.skippedTooShort.slice(0, 20),
    namingCollisions: scan.namingCollisions,
    differingDuplicateSamples: scan.duplicateGroups
      .filter((group) => !group.exactDuplicate)
      .slice(0, 20)
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const archivePaths = options.archives.map((archivePath) => path.resolve(archivePath));
  const outputPath = path.resolve(options.output);
  const scan = await scanArchives(archivePaths);
  const report = buildReport(scan, archivePaths, outputPath, options.dryRun);

  if (scan.failures.length > 0 || scan.namingCollisions.length > 0) {
    console.log(JSON.stringify(report, null, 2));
    throw new Error("Archive build stopped because validation found unsafe input");
  }

  if (!options.dryRun) {
    await writeArchive(scan.winners, outputPath);
    await verifyArchive(outputPath, scan.winners);
    const reportPath = `${outputPath}.report.json`;
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    report.reportPath = reportPath;
    report.outputBytes = (await fs.stat(outputPath)).size;
  }
  console.log(JSON.stringify(report, null, 2));
}

await main();
