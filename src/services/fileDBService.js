
const pool = require('./database'); // dein Postgres-Pool

async function insertFile(fitFile) {

  const { auth_sub, original_filename, s3_key, mime_type, file_size } = fitFile;
  const result = await pool.query(`
  INSERT INTO files (auth_sub, original_filename, s3_key, mime_type, file_size)
  VALUES ($1, $2, $3, $4, $5)
  ON CONFLICT (auth_sub, original_filename)
  DO NOTHING
  RETURNING *;
`, [auth_sub, original_filename, s3_key, mime_type, file_size]);

  if (result.rows.length === 0) {
    throw new Error(`Upload fehlgeschlagen: Datei '${originalFilename}' existiert bereits für diesen User.`);
  }
};

/*
    id               UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
    auth_sub         VARCHAR(255)   NOT NULL,
    original_filename TEXT          NOT NULL,
    s3_key           TEXT           NOT NULL,
    mime_type        TEXT           NOT NULL,
    file_size        INTEGER        NOT NULL,
    uploaded_at      TIMESTAMP      NOT NULL DEFAULT NOW(),

*/
module.exports = {
  insertFile
};