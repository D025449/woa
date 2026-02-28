const { randomUUID } = require('crypto');
const s3Service = require('../services/s3Service');
const fitService = require('../services/fitService');
const pool = require('../services/database');
const {insertFile} = require('../services/fileDBService');
const path = require("path");

exports.uploadFile = async (req, res) => {
  try {
    const userSub = req.session.userInfo.sub; // kommt vom authMiddleware
    //const userSub = req.user.sub;
    const file = req.file;

    //parseFit(file.buffer);

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

    await insertFile(fitFile);
    await s3Service.uploadFile(s3Key,fitJsonBuffer, "application/json");


    /*await db.query(
      `INSERT INTO files 
       (user_sub, original_filename, s3_key, mime_type, file_size)
       VALUES ($1, $2, $3, $4, $5)`,
      [userSub, file.originalname, key, file.mimetype, file.size]
    );*/

    res.json({ message: "Upload erfolgreich" });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Upload fehlgeschlagen" });
  }
};