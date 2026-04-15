import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { pipeline } from "node:stream/promises";

import { Worker } from "bullmq";
import unzipper from "unzipper";
import FitParser from "fit-file-parser";

import {
  processFitRecords,
  mapAggregatedToFileRow
} from "../services/fitService.js";

import { FileDBService } from "../services/fileDBService.js";
import SegmentDBService from "../services/segmentDBService.js";

import { redisConnection } from "../queue/connection.js";
import S3Service from "../services/s3Service.js";
import {
  getImportJobById,
  updateImportJob
} from "../db/import-jobs-repo.js";

export async function createApp() {
  const LOCAL_BATCH_FIT_CONCURRENCY = 2;

  function createStepLogger(scope, meta = {}) {
    const startedAt = Date.now();
    let lastAt = startedAt;
    const steps = [];

    return {
      mark(label, extra = {}) {
        const now = Date.now();
        steps.push({
          label,
          stepMs: now - lastAt,
          totalMs: now - startedAt,
          ...extra
        });
        lastAt = now;
      },
      flush(extra = {}) {
        console.log(`[timing] ${scope}`, {
          ...meta,
          totalMs: Date.now() - startedAt,
          steps,
          ...extra
        });
      }
    };
  }

  function createBatchTrace(scope, meta = {}) {
    const startedAt = Date.now();
    const totals = {
      entryBufferMs: 0,
      parseFitMs: 0,
      persistWorkoutMs: 0,
      updateJobMs: 0,
      processFitRecordsMs: 0,
      mapAggregatedRowMs: 0,
      insertFileMs: 0,
      getMatchingSegmentCandidatesMs: 0,
      matchSegmentsMs: 0,
      storeSegmentBestEffortsMs: 0
    };

    return {
      add(metric, ms) {
        if (Object.hasOwn(totals, metric)) {
          totals[metric] += ms;
        }
      },
      checkpoint(extra = {}) {
        console.log(`[timing] ${scope}`, {
          ...meta,
          totalMs: Date.now() - startedAt,
          totals,
          ...extra
        });
      },
      flush(extra = {}) {
        console.log(`[timing] ${scope}`, {
          ...meta,
          totalMs: Date.now() - startedAt,
          totals,
          ...extra
        });
      }
    };
  }

  async function processSegmentBestEffortsJob(uid, segmentIds) {
    await SegmentDBService.updateBestEffortsStatus(uid, segmentIds, "processing", null);

    try {
      const matchingEfforts =
        segmentIds.length === 1
          ? await (async () => {
              const segment = await SegmentDBService.getSegmentById(uid, segmentIds[0]);
              return segment
                ? SegmentDBService.scanWorkoutsForSegment(uid, segment)
                : [];
            })()
          : await SegmentDBService.scanWorkoutsForSegments(
              uid,
              segmentIds.map((id) => ({ id }))
            );

      await SegmentDBService.storeSegmentBestEffortsV2(matchingEfforts);
      await SegmentDBService.updateBestEffortsStatus(uid, segmentIds, "completed", null);
    } catch (error) {
      await SegmentDBService.updateBestEffortsStatus(
        uid,
        segmentIds,
        "failed",
        error.message || "Unknown segment best-effort error"
      );
      throw error;
    }
  }


  async function processFitJson(fitJsonObject,uid) {
    const timing = createStepLogger("worker.process-fit-json", {
      uid
    });
    let dbrow = null;

    try {
      const { aggregated, segments, gps_track, workoutObject } = processFitRecords(fitJsonObject);
      timing.mark("process-fit-records", {
        segmentCount: segments?.length ?? 0,
        gpsPointCount: gps_track?.track?.length ?? 0,
        validGps: !!gps_track?.validGps
      });
      const fitFile = {
        uid: uid
      };
      const fileRow = mapAggregatedToFileRow(aggregated, fitFile, workoutObject.getNormalizedPower());
      timing.mark("map-aggregated-to-file-row");
      dbrow = await FileDBService.insertFile(fileRow, segments, gps_track, workoutObject);
      timing.mark("insert-file", {
        workoutId: dbrow?.id
      });

      if (gps_track.validGps) {
        const candidates = await SegmentDBService.getMatchingSegmentCandidatesV2(
          gps_track.bbox,
          dbrow.uid
        );
        timing.mark("get-matching-segment-candidates", {
          candidateCount: candidates.length
        });

        const workout = { id: dbrow.id, track: gps_track.track, sampleRate: gps_track.sampleRate };

        const matches = SegmentDBService.matchSegments(workout, candidates);
        timing.mark("match-segments", {
          matchCount: matches.length
        });
        await SegmentDBService.storeSegmentBestEfforts(matches, workoutObject);
        timing.mark("store-segment-best-efforts");
      }

      timing.flush({
        status: "completed",
        workoutId: dbrow?.id
      });
    } catch (error) {
      timing.flush({
        status: "failed",
        workoutId: dbrow?.id,
        error: error.message
      });
      throw error;
    }


  }

  async function processFitJsonWithMetrics(fitJsonObject, uid, batchTrace) {
    const processFitRecordsStartedAt = Date.now();
    const { aggregated, segments, gps_track, workoutObject } = processFitRecords(fitJsonObject);
    batchTrace?.add("processFitRecordsMs", Date.now() - processFitRecordsStartedAt);

    const fitFile = {
      uid
    };

    const mapStartedAt = Date.now();
    const fileRow = mapAggregatedToFileRow(aggregated, fitFile, workoutObject.getNormalizedPower());
    batchTrace?.add("mapAggregatedRowMs", Date.now() - mapStartedAt);

    const insertStartedAt = Date.now();
    const dbrow = await FileDBService.insertFile(fileRow, segments, gps_track, workoutObject);
    batchTrace?.add("insertFileMs", Date.now() - insertStartedAt);

    if (gps_track.validGps) {
      const candidatesStartedAt = Date.now();
      const candidates = await SegmentDBService.getMatchingSegmentCandidatesV2(
        gps_track.bbox,
        dbrow.uid
      );
      batchTrace?.add("getMatchingSegmentCandidatesMs", Date.now() - candidatesStartedAt);

      const matchStartedAt = Date.now();
      const workout = { id: dbrow.id, track: gps_track.track, sampleRate: gps_track.sampleRate };
      const matches = SegmentDBService.matchSegments(workout, candidates);
      batchTrace?.add("matchSegmentsMs", Date.now() - matchStartedAt);

      const storeStartedAt = Date.now();
      await SegmentDBService.storeSegmentBestEfforts(matches, workoutObject);
      batchTrace?.add("storeSegmentBestEffortsMs", Date.now() - storeStartedAt);
    }

    return dbrow;
  }

  function parseFitBuffer(buffer) {
    return new Promise((resolve, reject) => {
      const parser = new FitParser({
        force: true,
        speedUnit: "km/h",
        lengthUnit: "km",
        temperatureUnit: "celsius",
        elapsedRecordField: true,
        mode: "list"
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

    await processFitJson(parsedData, context.uid);
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



  async function processSingleLocalFitFile(jobId, filePath, uid, originalFileName) {
    await updateImportJob(jobId, {
      status: "processing",
      stage: "parsing_fit_files",
      totalFiles: 1,
      processedFiles: 0,
      failedFiles: 0,
      progressPercent: 30
    });

    try {
      const buffer = await fs.promises.readFile(filePath);
      const parsed = await parseFitBuffer(buffer);

      await persistParsedWorkout(parsed, {
        importJobId: jobId,
        uid,
        entryName: originalFileName || path.basename(filePath)
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
      await fs.promises.rm(filePath, { force: true });
    }
  }

  async function processFitFileAtPath(filePath, uid, originalFileName) {
    const buffer = await fs.promises.readFile(filePath);
    const parsed = await parseFitBuffer(buffer);

    await persistParsedWorkout(parsed, {
      uid,
      entryName: originalFileName || path.basename(filePath)
    });
  }



  async function processLocalZipFile(jobId, zipPath, uid) {
    const batchTrace = createBatchTrace("worker.process-local-zip", {
      jobId,
      uid,
      zipPath: path.basename(zipPath)
    });
    await updateImportJob(jobId, {
      status: "processing",
      stage: "reading_zip",
      progressPercent: 15
    });

    try {
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
      batchTrace.checkpoint({
        phase: "opened-zip",
        totalFiles
      });

      for (const entry of fitEntries) {
        try {
          const bufferStartedAt = Date.now();
          const buffer = await entry.buffer();
          batchTrace.add("entryBufferMs", Date.now() - bufferStartedAt);
          const parseStartedAt = Date.now();
          const parsed = await parseFitBuffer(buffer);
          batchTrace.add("parseFitMs", Date.now() - parseStartedAt);

          const persistStartedAt = Date.now();
          await persistParsedWorkout(parsed, {
            importJobId: jobId,
            entryName: entry.path,
            uid
          });
          batchTrace.add("persistWorkoutMs", Date.now() - persistStartedAt);

          processedFiles += 1;

          const progressPercent =
            totalFiles === 0
              ? 100
              : Math.min(95, 20 + (processedFiles / totalFiles) * 75);

          const updateStartedAt = Date.now();
          await updateImportJob(jobId, {
            processedFiles,
            failedFiles,
            progressPercent
          });
          batchTrace.add("updateJobMs", Date.now() - updateStartedAt);

          if (processedFiles % 25 === 0 || processedFiles === totalFiles) {
            batchTrace.checkpoint({
              phase: "processing",
              processedFiles,
              failedFiles
            });
          }
        } catch (error) {
          failedFiles += 1;

          console.error("FIT processing failed", {
            jobId,
            entryName: entry.path,
            error: error.message
          });

          const updateStartedAt = Date.now();
          await updateImportJob(jobId, {
            processedFiles,
            failedFiles
          });
          batchTrace.add("updateJobMs", Date.now() - updateStartedAt);
        }
      }

      const savingStartedAt = Date.now();
      await updateImportJob(jobId, {
        stage: "saving_results",
        progressPercent: 98
      });
      batchTrace.add("updateJobMs", Date.now() - savingStartedAt);

      const completedStartedAt = Date.now();
      await updateImportJob(jobId, {
        status: "completed",
        stage: "completed",
        progressPercent: 100
      });
      batchTrace.add("updateJobMs", Date.now() - completedStartedAt);
      batchTrace.flush({
        phase: "completed",
        totalFiles,
        processedFiles,
        failedFiles
      });
    } finally {
      await fs.promises.rm(zipPath, { force: true });
    }
  }

  async function countFitEntries(filePath) {
    const lowerPath = filePath.toLowerCase();

    if (lowerPath.endsWith(".fit")) {
      return 1;
    }

    if (lowerPath.endsWith(".zip")) {
      const zipDirectory = await unzipper.Open.file(filePath);
      return zipDirectory.files.filter((entry) =>
        entry.type === "File" &&
        entry.path.toLowerCase().endsWith(".fit") &&
        (!entry.path.startsWith("__MACOSX/"))
      ).length;
    }

    return 0;
  }

  async function processLocalBatch(jobId, files, uid, originalFileNames = []) {
    const batchTrace = createBatchTrace("worker.process-local-batch", {
      jobId,
      uid,
      inputCount: files.length
    });
    await updateImportJob(jobId, {
      status: "processing",
      stage: "reading_zip",
      progressPercent: 10
    });

    const totalFilesPerInput = await Promise.all(files.map((filePath) => countFitEntries(filePath)));
    const totalFiles = totalFilesPerInput.reduce((sum, count) => sum + count, 0);
    batchTrace.checkpoint({
      phase: "counted-inputs",
      totalFiles
    });

    await updateImportJob(jobId, {
      stage: "parsing_fit_files",
      totalFiles,
      processedFiles: 0,
      failedFiles: 0,
      progressPercent: totalFiles > 0 ? 15 : 100
    });

    let processedFiles = 0;
    let failedFiles = 0;

    try {
      for (let i = 0; i < files.length; i++) {
        const filePath = files[i];
        const originalFileName = originalFileNames[i] || path.basename(filePath);
        const lowerPath = filePath.toLowerCase();

        if (lowerPath.endsWith(".fit")) {
          try {
          const persistStartedAt = Date.now();
          const buffer = await fs.promises.readFile(filePath);
          const parsed = await parseFitBuffer(buffer);
          batchTrace.add("parseFitMs", Date.now() - persistStartedAt);

          const processStartedAt = Date.now();
          await processFitJsonWithMetrics(parsed, uid, batchTrace);
          batchTrace.add("persistWorkoutMs", Date.now() - processStartedAt);
          processedFiles += 1;
          } catch (error) {
            failedFiles += 1;
            console.error("FIT processing failed", {
              jobId,
              entryName: originalFileName,
              error: error.message
            });
          } finally {
            await fs.promises.rm(filePath, { force: true });
          }
        } else if (lowerPath.endsWith(".zip")) {
          try {
            const zipDirectory = await unzipper.Open.file(filePath);
            const fitEntries = zipDirectory.files.filter((entry) =>
              entry.type === "File" &&
              entry.path.toLowerCase().endsWith(".fit") &&
              (!entry.path.startsWith("__MACOSX/"))
            );

            const processZipFitEntry = async (entry) => {
              try {
                const bufferStartedAt = Date.now();
                const buffer = await entry.buffer();
                batchTrace.add("entryBufferMs", Date.now() - bufferStartedAt);
                const parseStartedAt = Date.now();
                const parsed = await parseFitBuffer(buffer);
                batchTrace.add("parseFitMs", Date.now() - parseStartedAt);

                const persistStartedAt = Date.now();
                await processFitJsonWithMetrics(parsed, uid, batchTrace);
                batchTrace.add("persistWorkoutMs", Date.now() - persistStartedAt);

                processedFiles += 1;
              } catch (error) {
                failedFiles += 1;
                console.error("FIT processing failed", {
                  jobId,
                  entryName: entry.path,
                  error: error.message
                });
              }
            };

            for (let entryIndex = 0; entryIndex < fitEntries.length; entryIndex += LOCAL_BATCH_FIT_CONCURRENCY) {
              const entryBatch = fitEntries.slice(
                entryIndex,
                entryIndex + LOCAL_BATCH_FIT_CONCURRENCY
              );
              await Promise.all(entryBatch.map((entry) => processZipFitEntry(entry)));

              const progressPercent =
                totalFiles === 0
                  ? 100
                  : Math.min(95, 15 + ((processedFiles + failedFiles) / totalFiles) * 80);

              const updateStartedAt = Date.now();
              await updateImportJob(jobId, {
                processedFiles,
                failedFiles,
                progressPercent
              });
              batchTrace.add("updateJobMs", Date.now() - updateStartedAt);

              if ((processedFiles + failedFiles) % 25 === 0 || (processedFiles + failedFiles) === totalFiles) {
                batchTrace.checkpoint({
                  phase: "processing",
                  processedFiles,
                  failedFiles
                });
              }
            }
          } finally {
            await fs.promises.rm(filePath, { force: true });
          }

          continue;
        } else {
          failedFiles += 1;
        }

        const progressPercent =
          totalFiles === 0
            ? 100
            : Math.min(95, 15 + ((processedFiles + failedFiles) / totalFiles) * 80);

        const updateStartedAt = Date.now();
        await updateImportJob(jobId, {
          processedFiles,
          failedFiles,
          progressPercent
        });
        batchTrace.add("updateJobMs", Date.now() - updateStartedAt);

        if ((processedFiles + failedFiles) % 25 === 0 || (processedFiles + failedFiles) === totalFiles) {
          batchTrace.checkpoint({
            phase: "processing",
            processedFiles,
            failedFiles
          });
        }
      }

      const savingStartedAt = Date.now();
      await updateImportJob(jobId, {
        stage: "saving_results",
        progressPercent: 98
      });
      batchTrace.add("updateJobMs", Date.now() - savingStartedAt);

      const completedStartedAt = Date.now();
      await updateImportJob(jobId, {
        status: "completed",
        stage: "completed",
        totalFiles,
        processedFiles,
        failedFiles,
        progressPercent: 100
      });
      batchTrace.add("updateJobMs", Date.now() - completedStartedAt);
      batchTrace.flush({
        phase: "completed",
        totalFiles,
        processedFiles,
        failedFiles
      });
    } catch (error) {
      await Promise.all(files.map((filePath) => fs.promises.rm(filePath, { force: true }).catch(() => {})));
      batchTrace.flush({
        phase: "failed",
        totalFiles,
        processedFiles,
        failedFiles,
        error: error.message
      });
      throw error;
    }
  }

  async function processImportJob(importJobId) {
    const importJob = await getImportJobById(importJobId);

    if (!importJob) {
      throw new Error(`Import job not found: ${importJobId}`);
    }

    const localPaths = Array.isArray(importJob.localPaths) ? importJob.localPaths : null;
    const localPath = importJob.localPath;
    const originalFileNames = Array.isArray(importJob.originalFileNames) ? importJob.originalFileNames : null;
    const originalFileName = importJob.originalFileName;
    const lowerLocalPath = localPath?.toLowerCase?.();
    const uid = importJob.uid;

    try {
      if (localPaths?.length) {
        await processLocalBatch(importJobId, localPaths, uid, originalFileNames || []);
        return;
      }

      if (lowerLocalPath?.endsWith(".fit")) {
        await processSingleLocalFitFile(importJobId, localPath, uid, originalFileName);
        return;
      }

      if (lowerLocalPath?.endsWith(".zip")) {
        await processLocalZipFile(importJobId, localPath, uid);
        return;
      }

      throw new Error(`Unsupported file type for import job: ${importJobId}`);
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

  const segmentBestEffortsWorker = new Worker(
    "segment-best-efforts",
    async (job) => {
      const { uid, segmentIds } = job.data ?? {};

      if (!uid || !Array.isArray(segmentIds) || segmentIds.length === 0) {
        throw new Error("Segment best-efforts queue job is missing uid or segmentIds");
      }

      await processSegmentBestEffortsJob(uid, segmentIds);
    },
    {
      connection: redisConnection,
      concurrency: 1
    }
  );

  segmentBestEffortsWorker.on("ready", () => {
    console.log("Segment best-efforts worker is ready");
  });

  segmentBestEffortsWorker.on("completed", (job) => {
    console.log("Segment best-efforts worker job completed", {
      queueJobId: job.id,
      segmentIds: job.data?.segmentIds
    });
  });

  segmentBestEffortsWorker.on("failed", (job, error) => {
    console.error("Segment best-efforts worker job failed", {
      queueJobId: job?.id,
      segmentIds: job?.data?.segmentIds,
      error: error.message
    });
  });

  segmentBestEffortsWorker.on("error", (error) => {
    console.error("Segment best-efforts worker error", error);
  });

}
