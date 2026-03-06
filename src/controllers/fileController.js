const { randomUUID } = require('crypto');
const s3Service = require('../services/s3Service');
const fitService = require('../services/fitService');
const pool = require('../services/database');
const { insertFile } = require('../services/fileDBService');
const path = require("path");
const unzipper = require("unzipper");


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

  const fitJsonObject = await fitService.parseFit(buffer);
  //const fitJsonObjectStr = JSON.stringify(fitJsonObject);
  //const fitJsonBuffer = Buffer.from(fitJsonObjectStr);

  const proceessed_fit_records = fitService.processFitRecords(fitJsonObject.records);
  const proceessed_fit_records_str = JSON.stringify(proceessed_fit_records);
  const fitJsonBuffer = Buffer.from(proceessed_fit_records_str);

  //console.log(fitJsonObjectStr.length);
  console.log(proceessed_fit_records_str.length);

  const newFilename = path.basename(originalName, path.extname(originalName)) + ".json";

  const s3Key = `users/${userSub}/${randomUUID()}-${newFilename}`;

  const fitFile = {
    auth_sub: userSub,
    original_filename: originalName,
    s3_key: s3Key,
    mime_type: "application/json",
    file_size: fitJsonBuffer.length
  };

  const fileRow = fitService.mapToFileRow(fitJsonObject, fitFile);



  await insertFile(fileRow);
  await s3Service.putObject(s3Key, fitJsonBuffer, "application/json");

}

function getErrorMessage(err) {
  if (!err) return "Unknown error";

  if (typeof err === "string") return err;

  if (err.message) return err.message;

  return JSON.stringify(err);
}

exports.uploadFile = async (req, res) => {

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

      result = await processZipBuffer(file.buffer, userSub);

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

/*
exports.uploadFile = async (req, res) => {
  try {
    const userSub = req.session.userInfo.sub; // kommt vom authMiddleware

    const file = req.file;



    const fitJsonObject = await fitService.parseFit(file.buffer);


    const fitJsonBuffer = Buffer.from(JSON.stringify(fitJsonObject));

    const newFilename = path.basename(file.originalname, path.extname(file.originalname)) + ".json";

    const s3Key = `users/${userSub}/${randomUUID()}-${newFilename}`;
    const fitFile = {
      auth_sub: userSub,
      original_filename: file.originalname,
      s3_key: s3Key,
      mime_type: "application/json",
      file_size: fitJsonBuffer.length
    }

    const fileRow = fitService.mapToFileRow(fitJsonObject, fitFile);


    await insertFile(fileRow);
    await s3Service.putObject(s3Key, fitJsonBuffer, "application/json");


    res.json({ message: "Upload erfolgreich" });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Upload fehlgeschlagen: " + err.message });
  }
};*/