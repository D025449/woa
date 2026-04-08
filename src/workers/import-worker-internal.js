import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { pipeline } from "node:stream/promises";

import { Worker } from "bullmq";
import unzipper from "unzipper";
import FitParser from "fit-file-parser";

import { randomUUID } from "crypto";
//import path from "path";
import s3Service from "../services/s3Service.js";
import {
  processFitRecords,
  mapToFileRow
} from "../services/fitService.js";

import { FileDBService } from "../services/fileDBService.js";
import SegmentDBService from "../services/segmentDBService.js";
import FilesStreamsApi from "../services/FilesStreamsApi.js";

import { redisConnection } from "../queue/connection.js";
import S3Service from "../services/s3Service.js";
import {
  getImportJobById,
  updateImportJob
} from "../db/import-jobs-repo.js";

export async function createApp() {


  async function processFitJson(fitJsonObject, originalName, uid) {
    const { buffer, normalized_power, segments, gps_track, powers, heartRates, cadences, speeds, altitudes } = processFitRecords(fitJsonObject.records);
    const newFilenamebin = path.basename(originalName, path.extname(originalName)) + ".bin";
    const s3KeyBin = `users/${uid}/${randomUUID()}-${newFilenamebin}`;
    const fitFile = {
      uid: uid,
      original_filename: originalName,
      s3_key: s3KeyBin,
      mime_type: "application/octet-stream",
      file_size: buffer.byteLength
    };
    const fileRow = mapToFileRow(fitJsonObject, fitFile, normalized_power);
    const dbrow = await FileDBService.insertFile(fileRow, segments, gps_track);
    //const values = { powers, heartRates, cadences, speeds, altitudes };
    await FilesStreamsApi.insertStreams(dbrow.id, dbrow.uid, powers, heartRates, cadences, speeds, altitudes);

    if (gps_track.validGPS) {
      const candidates = await SegmentDBService.getMatchingSegmentCandidates(dbrow.id, dbrow.uid);

      const workout = { id: dbrow.id, track: gps_track.track, sampleRate: gps_track.sampleRate };

      const matches = SegmentDBService.matchSegments(workout, candidates);
      await SegmentDBService.storeSegmentBestEfforts(dbrow.uid, matches, powers, heartRates, cadences, speeds);
    }

    await s3Service.putObjectBinary(s3KeyBin, buffer, "application/octet-stream");

  }

  async function downloadObjectToTempFile(s3Key, extension = ".bin") {
    const tmpPath = path.join(os.tmpdir(), `${crypto.randomUUID()}${extension}`);
    const bodyStream = await S3Service.getObjectStream(process.env.S3_BUCKET, s3Key);

    await pipeline(bodyStream, fs.createWriteStream(tmpPath));

    return tmpPath;
  }

  function parseFitBuffer(buffer) {
    return new Promise((resolve, reject) => {
      const parser = new FitParser({
        force: true,
        speedUnit: "km/h",
        lengthUnit: "km",
        temperatureUnit: "celsius",
        elapsedRecordField: true,
        mode: "both"
      });

      parser.parse(buffer, (error, data) => {
        if (error) {
          reject(error);
        } else {
          resolve(data);
        }
      });
    });
  }

  async function persistParsedWorkout(parsedData, context) {
    // TODO:
    // Hier baust du später deine echte Persistierung ein.
    // Zum Beispiel:
    // - Workout-Datensatz speichern
    // - User zuordnen
    // - Samples / Records speichern
    // - Duplikate prüfen
    const filename = path.basename(context.entryName);

    await processFitJson(parsedData, filename, context.uid);
    const hasData = !!parsedData;
    if (hasData === false) {
      console.log("Persist workout", {
        importJobId: context.importJobId,
        uid: context.uid,
        entryName: filename || null,
        hasData: !!parsedData
      })
    }

    return true;
  }

  async function processSingleFitFile(jobId, s3Key, uid) {
    await updateImportJob(jobId, {
      status: "processing",
      stage: "downloading_zip",
      progressPercent: 10
    });

    const fitPath = await downloadObjectToTempFile(s3Key, ".fit");

    try {
      await updateImportJob(jobId, {
        stage: "parsing_fit_files",
        totalFiles: 1,
        processedFiles: 0,
        failedFiles: 0,
        progressPercent: 30
      });

      const buffer = await fs.promises.readFile(fitPath);
      const parsed = await parseFitBuffer(buffer);

      await persistParsedWorkout(parsed, {
        importJobId: jobId,
        uid: uid,
        entryName: path.basename(fitPath)
      });

      await updateImportJob(jobId, {
        status: "completed",
        stage: "completed",
        totalFiles: 1,
        processedFiles: 1,
        failedFiles: 0,
        progressPercent: 100
      });
    } finally {
      await fs.promises.rm(fitPath, { force: true });
    }
  }

  async function processZipFile(jobId, s3Key, uid) {
    await updateImportJob(jobId, {
      status: "processing",
      stage: "downloading_zip",
      progressPercent: 5
    });

    const zipPath = await downloadObjectToTempFile(s3Key, ".zip");

    try {
      await updateImportJob(jobId, {
        stage: "reading_zip",
        progressPercent: 15
      });

      const zipDirectory = await unzipper.Open.file(zipPath);

      const fitEntries = zipDirectory.files.filter((entry) => {
        return entry.type === "File" && entry.path.toLowerCase().endsWith(".fit") && (!entry.path.startsWith("__MACOSX/"));
      });

      const totalFiles = fitEntries.length;

      await updateImportJob(jobId, {
        stage: "parsing_fit_files",
        totalFiles,
        processedFiles: 0,
        failedFiles: 0,
        progressPercent: totalFiles > 0 ? 20 : 100
      });

      let processedFiles = 0;
      let failedFiles = 0;

      for (const entry of fitEntries) {
        try {
          const buffer = await entry.buffer();
          const parsed = await parseFitBuffer(buffer);

          await persistParsedWorkout(parsed, {
            importJobId: jobId,
            entryName: entry.path,
            uid: uid
          });

          processedFiles += 1;

          const progressPercent =
            totalFiles === 0
              ? 100
              : Math.min(95, 20 + (processedFiles / totalFiles) * 75);

          await updateImportJob(jobId, {
            processedFiles,
            failedFiles,
            progressPercent
          });
        } catch (error) {
          failedFiles += 1;

          console.error("FIT processing failed", {
            jobId,
            entryName: entry.path,
            error: error.message
          });

          await updateImportJob(jobId, {
            processedFiles,
            failedFiles
          });
        }
      }

      await updateImportJob(jobId, {
        stage: "saving_results",
        progressPercent: 98
      });

      await updateImportJob(jobId, {
        status: "completed",
        stage: "completed",
        progressPercent: 100
      });
    } finally {
      await fs.promises.rm(zipPath, { force: true });
    }
  }

  async function processImportJob(importJobId) {
    const importJob = await getImportJobById(importJobId);

    if (!importJob) {
      throw new Error(`Import job not found: ${importJobId}`);
    }

    const s3Key = importJob.s3Key;
    const lowerKey = s3Key.toLowerCase();
    const uid = importJob.uid;

    try {
      if (lowerKey.endsWith(".fit")) {
        await processSingleFitFile(importJobId, s3Key, uid);
        return;
      }

      if (lowerKey.endsWith(".zip")) {
        await processZipFile(importJobId, s3Key, uid);
        return;
      }

      throw new Error(`Unsupported file type for key: ${s3Key}`);
    } catch (error) {
      await updateImportJob(importJobId, {
        status: "failed",
        stage: "failed",
        errorMessage: error.message || "Unknown import error"
      });

      throw error;
    }
  }

  const worker = new Worker(
    "fit-imports",
    async (job) => {
      const { jobId } = job.data;

      if (!jobId) {
        throw new Error("Queue job has no jobId");
      }

      await processImportJob(jobId);
    },
    {
      connection: redisConnection,
      concurrency: 2
    }
  );

  worker.on("ready", () => {
    console.log("Import worker is ready");
  });

  worker.on("completed", (job) => {
    console.log("Import worker job completed", {
      queueJobId: job.id,
      importJobId: job.data?.jobId
    });
  });

  worker.on("failed", (job, error) => {
    console.error("Import worker job failed", {
      queueJobId: job?.id,
      importJobId: job?.data?.jobId,
      error: error.message
    });
  });

  worker.on("error", (error) => {
    console.error("Import worker error", error);
  });

}