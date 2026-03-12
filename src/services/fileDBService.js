import pool from "./database.js";
import S3Service from "./s3Service.js";


class FileDBService {

  static allowedColumns = [
    "start_time",
    "total_distance",
    "avg_speed",
    "avg_power",
    "avg_normalized_power",
    "total_timer_time",
    "auth_sub"
  ];

  static numericFields = [
    "total_distance",
    "avg_speed",
    "avg_power",
    "avg_normalized_power",
    "total_timer_time"
  ];


  static buildQueryParts(sort = [], filter = []) {

    let whereParts = [];
    let orderParts = [];
    let params = [];

    // --------------------
    // FILTER
    // --------------------
    (filter || []).forEach(f => {

      if (!FileDBService.allowedColumns.includes(f.field)) return;

      const paramIndex = params.length + 1;

      let value = f.value;
      // 🔥 Cast numbers
      if (FileDBService.numericFields.includes(f.field)) {
        value = parseFloat(value);
      }
      switch (f.type) {

        case "=":
          whereParts.push(`${f.field} = $${paramIndex}`);
          params.push(value);
          break;

        case ">":
          whereParts.push(`${f.field} > $${paramIndex}`);
          params.push(value);
          break;

        case "<":
          whereParts.push(`${f.field} < $${paramIndex}`);
          params.push(value);
          break;

        case ">=":
          whereParts.push(`${f.field} >= $${paramIndex}`);
          params.push(value);
          break;

        case "<=":
          whereParts.push(`${f.field} <= $${paramIndex}`);
          params.push(value);
          break;

        case "like":
          whereParts.push(`${f.field} ILIKE $${paramIndex}`);
          params.push(`%${value}%`);
          break;

        default:
          whereParts.push(`${f.field} = $${paramIndex}`);
          params.push(value);

      }

    });


    // --------------------
    // SORT
    // --------------------
    (sort || []).forEach(s => {

      if (!FileDBService.allowedColumns.includes(s.field)) return;

      const dir = s.dir === "desc" ? "DESC" : "ASC";

      orderParts.push(`${s.field} ${dir}`);

    });


    const whereSQL = whereParts.length
      ? `WHERE ${whereParts.join(" AND ")}`
      : "";

    const orderSQL = orderParts.length
      ? `ORDER BY ${orderParts.join(", ")}`
      : "ORDER BY start_time DESC";


    return {
      whereSQL,
      orderSQL,
      params
    };
  }

static async getWorkoutRecordsPreSignedUrl(workoutId, authSub) {
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
    const bucket = process.env.S3_BUCKET;
    const payload = await S3Service.getPresignedUrl(bucket, s3Key);
    return payload;
}



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
    if (!payload.data|| !Array.isArray(payload.data)) {
      return [];
    }

    /*const data = [];
    for (let i = 0; i < payload.records.length; i++) {
      data.push([
        i, // oder payload.records[i].timestamp, je nachdem was du als x-Achse willst
        payload.records[i].power ?? null,
        payload.records[i].heart_rate ?? null,
        payload.records[i].cadence ?? null
      ]);
    }*/

    /*
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
      data = { t, p, h, c };*/
    const data = payload.data;

    /*for (let i = 0; i < payload.records.length; i++) {
      data.push([
        i,
        payload.records[i].power ?? null,
        payload.records[i].heart_rate ?? null,
        payload.records[i].cadence ?? null
      ]);
    }*/


    const segments = [];
    segments.push({ start: 100, end: 160, type: 'CP1', segmentDuration: 60, avgPower: 500 });
    segments.push({ start: 200, end: 320, type: 'CP2', segmentDuration: 120, avgPower: 400 });
    segments.push({ start: 400, end: 640, type: 'CP4', segmentDuration: 240, avgPower: 300 });
    segments.push({ start: 700, end: 1180, type: 'CP8', segmentDuration: 480, avgPower: 270 });

    return { data, segments };

  }



  static async getWorkoutsByUser(authSub, page, size, sort, filter) {

    const offset = (page - 1) * size;

    const filter_all = [];
    filter_all.push( { field : 'auth_sub', type : '=', value : authSub } );
    filter_all.push(...filter);



    const { whereSQL, orderSQL, params } =
      FileDBService.buildQueryParts(sort, filter_all);

    // -----------------------------------
    // BASE WHERE (User Filter + Tabulator Filter)
    // -----------------------------------

    let baseWhere = "WHERE ";//auth_sub = $1";
    let sqlParams = params;
    if (whereSQL) {
      baseWhere += whereSQL.replace("WHERE ", "");
     // sqlParams = [params];
    }

    // -----------------------------------
    // DATA QUERY
    // -----------------------------------

    const dataQuery = `
    SELECT *
    FROM files
    ${baseWhere}
    ${orderSQL}
    LIMIT $${sqlParams.length + 1}
    OFFSET $${sqlParams.length + 2}
  `;

    const dataParams = [
      ...sqlParams,
      size,
      offset
    ];

    const dataResult = await pool.query(dataQuery, dataParams);

    // -----------------------------------
    // COUNT QUERY
    // -----------------------------------

    const countQuery = `
    SELECT COUNT(*) AS total
    FROM files
    ${baseWhere}
  `;

    const countResult = await pool.query(countQuery, sqlParams);

    const totalRecords = parseInt(countResult.rows[0].total);

    return {
      data: dataResult.rows,
      last_page: Math.ceil(totalRecords / size),
      total_records: totalRecords
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
    avg_normalized_power,
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
      avg_normalized_power,
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
      $24,$25,$26,$27,$28
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
      avg_normalized_power,
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
export { insertFile, FileDBService };