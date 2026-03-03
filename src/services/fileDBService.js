
const pool = require('./database'); // dein Postgres-Pool
const S3Service = require("./s3Service");

/*async function insertFile(fitFile) {

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
*/


class FileDBService {

  static async getWorkoutRecords(workoutId, authSub) {

    if (!authSub) {
      throw new Error("Unauthorized");
    }

    // 1️⃣ File prüfen + s3_key holen
    const { rows } = await pool.query(
      `
      SELECT s3_key
      FROM files
      WHERE id = $1
      AND auth_sub = $2
      `,
      [workoutId, authSub]
    );

    if (rows.length === 0) {
      throw new Error("Workout not found");
    }

    const s3Key = rows[0].s3_key;

    // 2️⃣ JSON von S3 laden
    const bucket = process.env.S3_BUCKET;
    const payload = await S3Service.getJsonObject(bucket, s3Key);

    // 3️⃣ Records extrahieren
    if (!payload.records || !Array.isArray(payload.records)) {
      return [];
    }


  const t = [];
  const p = [];
  const h = [];
  const c = [];
  let i = 0;
  for (const r of payload.records) {
    t.push(i++);
    p.push(r.power ?? null);
    h.push(r.heart_rate ?? null);
    c.push(r.cadence ?? null);
  }

  return { t, p, h, c };

    // 4️⃣ Transformieren für Chart
    /*const transformed = payload.records
      .filter(r => r.timestamp) // Sicherheitsfilter
      .map(r => ({
        timestamp: r.timestamp,
        power: r.power ?? null,
        heart_rate: r.heart_rate ?? null,
        cadence: r.cadence ?? null
      }));

    return transformed;*/
  }


  static async getWorkoutsByUser(authSub, page = 1, size = 20) {

    const offset = (page - 1) * size;

    // Hauptquery
    const dataQuery = `
      SELECT *
      FROM files
      WHERE auth_sub = $1
      ORDER BY start_time DESC
      LIMIT $2 OFFSET $3
    `;

    const countQuery = `
      SELECT COUNT(*) AS cnt
      FROM files
      WHERE auth_sub = $1
    `;

    const { rows: data } = await pool.query(
      dataQuery,
      [authSub, size, offset]
    );

    const { rows: countRows } = await pool.query(
      countQuery,
      [authSub]
    );

    const total = parseInt(countRows[0].cnt);

    return {
      data,
      last_page: Math.ceil(total / size),
      total_records: total
    };
  }

}




async function insertFile(fileRow) {

  const {
    auth_sub,
    original_filename,
    s3_key,
    mime_type,
    file_size,

    start_time,
    end_time,

    total_elapsed_time,
    total_timer_time,
    total_distance,
    total_cycles,
    total_work,
    total_calories,
    total_ascent,
    total_descent,

    avg_speed,
    max_speed,
    avg_power,
    max_power,
    avg_heart_rate,
    max_heart_rate,
    avg_cadence,
    max_cadence,

    nec_lat,
    nec_long,
    swc_lat,
    swc_long
  } = fileRow;

  const result = await pool.query(
    `
    INSERT INTO files (
      auth_sub,
      original_filename,
      s3_key,
      mime_type,
      file_size,

      start_time,
      end_time,

      total_elapsed_time,
      total_timer_time,
      total_distance,
      total_cycles,
      total_work,
      total_calories,
      total_ascent,
      total_descent,

      avg_speed,
      max_speed,
      avg_power,
      max_power,
      avg_heart_rate,
      max_heart_rate,
      avg_cadence,
      max_cadence,

      nec_lat,
      nec_long,
      swc_lat,
      swc_long
    )
    VALUES (
      $1,$2,$3,$4,$5,
      $6,$7,
      $8,$9,$10,$11,$12,$13,$14,$15,
      $16,$17,$18,$19,$20,$21,$22,$23,
      $24,$25,$26,$27
    )
    ON CONFLICT (auth_sub, original_filename)
    DO NOTHING
    RETURNING *;
    `,
    [
      auth_sub,
      original_filename,
      s3_key,
      mime_type,
      file_size,

      start_time,
      end_time,

      total_elapsed_time,
      total_timer_time,
      total_distance,
      total_cycles,
      total_work,
      total_calories,
      total_ascent,
      total_descent,

      avg_speed,
      max_speed,
      avg_power,
      max_power,
      avg_heart_rate,
      max_heart_rate,
      avg_cadence,
      max_cadence,

      nec_lat,
      nec_long,
      swc_lat,
      swc_long
    ]
  );

  if (result.rows.length === 0) {
    throw new Error(
      `Upload fehlgeschlagen: Datei '${original_filename}' existiert bereits für diesen User.`
    );
  }

  return result.rows[0];
}
module.exports = {
  insertFile,
  FileDBService
};