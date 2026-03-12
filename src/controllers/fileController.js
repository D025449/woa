import { randomUUID } from "crypto";
import path from "path";

import unzipper from "unzipper";
import pLimit from "p-limit";

import s3Service from "../services/s3Service.js";
import {
  parseFit,
  processFitRecords_v2,
  mapToFileRow
} from "../services/fitService.js";
//import pool from "../services/database.js";
import { insertFile } from "../services/fileDBService.js";


async function processZipBuffer_par(zipBuffer, userSub) {

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

      })

    );

  }

  await Promise.all(tasks);

  return results;
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


async function processFitBuffer(buffer, originalName, userSub) {

  const fitJsonObject = await parseFit(buffer);
  //const fitJsonObjectStr = JSON.stringify(fitJsonObject);
  //const fitJsonBuffer = Buffer.from(fitJsonObjectStr);

  //const proceessed_fit_records = fitService.processFitRecords(fitJsonObject.records);

  const binBuffer = processFitRecords_v2(fitJsonObject.records);


  //const proceessed_fit_records_str = JSON.stringify(proceessed_fit_records);
  //const fitJsonBuffer = Buffer.from(proceessed_fit_records_str);

  //console.log(fitJsonObjectStr.length);
  //console.log(proceessed_fit_records_str.length);

  //const newFilename = path.basename(originalName, path.extname(originalName)) + ".json";

  //const s3Key = `users/${userSub}/${randomUUID()}-${newFilename}`;


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
  //await s3Service.putObject(s3Key, fitJsonBuffer, "application/json");
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

    const userSub = req.session.userInfo.sub;
    const file = req.file;

    const ext = path.extname(file.originalname).toLowerCase();

    let result;

    if (ext === ".fit") {

      await processFitBuffer(file.buffer, file.originalname, userSub);

      result = {
        processed: 1,
        success: 1,
        failed: 0,
        errors: []
      };

    }
    else if (ext === ".zip") {

      result = await processZipBuffer_par(file.buffer, userSub);

    }
    else {

      return res.status(400).json({
        error: "Nur .fit oder .zip Dateien erlaubt"
      });

    }

    res.json({
      message: "Upload abgeschlossen",
      summary: result
    });

  } catch (err) {

    console.error(err);

    res.status(500).json({
      error: "Upload fehlgeschlagen: " + err.message
    });

  }

};

