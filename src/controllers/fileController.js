import { randomUUID } from "crypto";


import path from "path";

import unzipper from "unzipper";
import pLimit from "p-limit";
import fs from "fs";
import fsp from "fs/promises";
import { PassThrough } from "stream";

import s3Service from "../services/s3Service.js";
import {
  parseFit,
  processFitRecords,
  mapToFileRow
} from "../services/fitService.js";
//import pool from "../services/database.js";
import { insertFile } from "../services/fileDBService.js";
import { progressEmitter } from "../services/progressEmitter.js";


/*async function processZipBuffer_par(sourcePath, userSub, jobId) {
  try {
    const directory = await unzipper.Open.buffer(zipBuffer);

    const results = {
      processed: 0,
      success: 0,
      failed: 0,
      errors: []
    };

    const limit = pLimit(4); // ← Parallelität (4–6 ist meist optimal)

    const tasks = [];

    for (const entry of directory.files) {

      if (entry.type !== "File") continue;

      const ext = path.extname(entry.path).toLowerCase();

      if (ext !== ".fit") continue;
      if (entry.path.includes("__MACOSX")) continue;
      if (path.basename(entry.path).startsWith("._")) continue;

      const name = entry.path;
      const filename = path.basename(name);

      results.processed++;

      tasks.push(

        limit(async () => {

          try {

            console.log("ZIP entry:", entry.path);

            const buffer = await entry.buffer();

            await processFitBuffer(buffer, filename, userSub);

            results.success++;

          } catch (err) {

            const message = getErrorMessage(err);

            console.error(`Fehler bei FIT: ${name}`, message);

            results.failed++;

            results.errors.push({
              file: entry.path,
              error: message
            });
          }

          progressEmitter.emit(jobId, { file: filename });

        })

      );

    }

    await Promise.all(tasks);
    progressEmitter.emit(jobId, {
      progress: 100,
      status: "done"
    })
    return results;

  }
  finally {
    fsp.unlink(sourcePath);

  }

}*/

async function processZipStreamParallel(sourcePath, userSub, jobId) {

  const results = {
    processed: 0,
    success: 0,
    failed: 0,
    errors: []
  };

  const limit = pLimit(4); // Parallelität

  const tasks = [];

  try {

    const zipStream = fs
      .createReadStream(sourcePath)
      .pipe(unzipper.Parse({ forceStream: true }));

    for await (const entry of zipStream) {

      if (entry.type !== "File") {
        entry.autodrain();
        continue;
      }

      const ext = path.extname(entry.path).toLowerCase();

      if (ext !== ".fit") {
        entry.autodrain();
        continue;
      }

      if (entry.path.includes("__MACOSX")) {
        entry.autodrain();
        continue;
      }

      const filename = path.basename(entry.path);

      results.processed++;

      // wichtig: Stream entkoppeln
      const pass = new PassThrough();
      entry.pipe(pass);

      tasks.push(

        limit(async () => {

          try {

            const chunks = [];

            for await (const chunk of pass) {
              chunks.push(chunk);
            }

            const buffer = Buffer.concat(chunks);

            await processFitBuffer(buffer, filename, userSub);

            results.success++;

            progressEmitter.emit(jobId, { file: filename, err: 'uploaded' });

          } catch (err) {

            const message = getErrorMessage(err);

            results.failed++;

            results.errors.push({
              file: entry.path,
              error: message
            });

            console.error(`Fehler bei FIT: ${entry.path}`, message);

            progressEmitter.emit(jobId, { file: filename, err: err.message});

          }

          

        })

      );

    }

    await Promise.all(tasks);

    progressEmitter.emit(jobId, {
      progress: 100,
      status: "done"
    });

    return results;

  } finally {

    await fsp.unlink(sourcePath);

  }

}


async function processZipBuffer(zipBuffer, userSub) {

  const directory = await unzipper.Open.buffer(zipBuffer);

  const results = {
    processed: 0,
    success: 0,
    failed: 0,
    errors: []
  };

  for (const entry of directory.files) {

    if (entry.type !== "File") continue;

    const ext = path.extname(entry.path).toLowerCase();

    if (ext !== ".fit") continue;
    if (entry.path.includes("__MACOSX")) continue;
    if (path.basename(entry.path).startsWith("._")) continue;
    const name = entry.path;
    const filename = path.basename(name);


    console.log("ZIP entry:", entry.path);
    results.processed++;

    try {

      const buffer = await entry.buffer();

      await processFitBuffer(buffer, filename, userSub);

      results.success++;

    } catch (err) {

      const message = getErrorMessage(err);

      console.error(`Fehler bei FIT: ${name}`, message);

      results.failed++;

      results.errors.push({
        file: entry.path,
        error: err.message
      });

      // wichtig: nicht rethrow!
    }

  }

  return results;

}

async function processFitPath(sourcePath, originalName, userSub, jobId) {
  try {
    await new Promise(r => setTimeout(r, 200));
    const buffer = await fsp.readFile(sourcePath);
    const fitJsonObject = await parseFit(buffer);
    const binBuffer = processFitRecords(fitJsonObject.records);
    const newFilenamebin = path.basename(originalName, path.extname(originalName)) + ".bin";
    const s3KeyBin = `users/${userSub}/${randomUUID()}-${newFilenamebin}`;
    const fitFile = {
      auth_sub: userSub,
      original_filename: originalName,
      s3_key: s3KeyBin,
      mime_type: "application/octet-stream",
      file_size: binBuffer.byteLength
    };
    const fileRow = mapToFileRow(fitJsonObject, fitFile);
    await insertFile(fileRow);
    await s3Service.putObjectBinary(s3KeyBin, binBuffer, "application/octet-stream");
    progressEmitter.emit(jobId, { file: originalName, status: 'done' });
  }
  catch (errr) {
      progressEmitter.emit(jobId, { file: originalName, err: errr.message, status: 'err' });
  }

  finally {
    // Datei immer löschen
    await fsp.unlink(sourcePath);



  }

  /* .then(() => {
     progressEmitter.emit(jobId, {
       progress: 100,
       status: "done",
       file: file.originalname,

     })
   })
   .catch(err => {
     console.error("Async Fehler:", err);
     progressEmitter.emit(jobId, {
       progress: 100,
       status: "err",
       file: file.originalname,
       error: err

     })

   });*/


}


async function processFitBuffer(buffer, originalName, userSub) {

  const fitJsonObject = await parseFit(buffer);
  const binBuffer = processFitRecords(fitJsonObject.records);
  const newFilenamebin = path.basename(originalName, path.extname(originalName)) + ".bin";
  const s3KeyBin = `users/${userSub}/${randomUUID()}-${newFilenamebin}`;
  const fitFile = {
    auth_sub: userSub,
    original_filename: originalName,
    s3_key: s3KeyBin,
    mime_type: "application/octet-stream",
    file_size: binBuffer.byteLength
  };
  const fileRow = mapToFileRow(fitJsonObject, fitFile);
  await insertFile(fileRow);
  await s3Service.putObjectBinary(s3KeyBin, binBuffer, "application/octet-stream");
}

function getErrorMessage(err) {
  if (!err) return "Unknown error";

  if (typeof err === "string") return err;

  if (err.message) return err.message;

  return JSON.stringify(err);
}

export async function uploadFile(req, res) {

  try {

    const userSub = req.user.sub;
    const file = req.file;

    const ext = path.extname(file.originalname).toLowerCase();

    let result;
    const jobId = randomUUID();
    if (ext === ".fit") {

      processFitPath(file.path, file.originalname, userSub, jobId);

    }
    else if (ext === ".zip") {

      processZipStreamParallel(file.path, userSub, jobId);

    }
    else {
      return res.status(400).json({
        error: "Nur .fit oder .zip Dateien erlaubt"
      });

    }

    return res.json({
      status: 'trig',
      message: "Upload started",
      jobId
    });

  } catch (err) {

    console.error(err);

    res.status(500).json({
      error: "Upload fehlgeschlagen: " + err.message
    });

  }

};

