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

  static async getCPBestEfforts(grouping, durations, authSub) {
    const query = `
    SELECT *
    FROM get_cp_best_efforts($1, $2, $3)
  `;

    const values = [grouping, durations, authSub];

    const result = await pool.query(query, values);
    return result.rows;
  }



  static async getFTPValues(authSub, period = "quarter") {
    if (!authSub) {
      throw new Error("Unauthorized");
    }

    const query = `
    SELECT *
    FROM get_ftp_by_period2($1, $2)
  `;

    const values = [authSub, period];

    const result = await pool.query(query, values);

    return result.rows;
  }


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

  static async deleteWorkout(sub, workoutId) {

    const { rows } = await pool.query(
      `
      SELECT s3_key
      FROM files
      WHERE id = $1
      AND auth_sub = $2
      `,
      [workoutId, sub]
    );

    if (rows.length === 0) {
      throw new Error("Workout not found");
    }

    const s3Key = rows[0].s3_key;
    const bucket = process.env.S3_BUCKET;

    const payload = await S3Service.deleteObject(bucket, s3Key);

    // 2. DB-Eintrag löschen
    const result = await pool.query(
      `
      DELETE FROM files
      WHERE id = $1
      AND auth_sub = $2
  `,
      [workoutId, sub]
    );


    return result;


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
    if (!payload.data || !Array.isArray(payload.data)) {
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
    filter_all.push({ field: 'auth_sub', type: '=', value: authSub });
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

    const enriched_recs = await FileDBService.post_calculations(authSub, dataResult.rows, "year");

    return {
      data: enriched_recs,
      last_page: Math.ceil(totalRecords / size),
      total_records: totalRecords
    };
  }
  static async post_calculations(userid, workouts, grouping) {
    const ftpSeries = await FileDBService.getFTPValues(userid, grouping);
    const enriched = workouts.map(w => {
      const ftp = Math.round(FileDBService.interpolateFTP(ftpSeries, w.start_time, grouping));
      const IF = w.avg_normalized_power / ftp;
      const TSS =
        Math.round((w.total_timer_time * w.avg_normalized_power * IF) / (ftp * 3600) * 100);
      return {
        ...w,
        ftp,
        IF,
        TSS

      };
    });

    return enriched;
  }

  static periodToDate(period, grouping) {
    if (!period) return null;

    switch (grouping) {

      case "year": {
        // z.B. 2024
        return new Date(period, 0, 1);
      }

      case "month":
      case "year_month": {
        // z.B. 202401
        const year = Math.floor(period / 100);
        const month = (period % 100) - 1;
        return new Date(year, month, 1);
      }

      case "week":
      case "year_week": {
        // z.B. 202401 (ISO Woche)
        const year = Math.floor(period / 100);
        const week = period % 100;

        return FileDBService.getDateOfISOWeek(week, year);
      }

      case "quarter":
      case "year_quarter": {
        // z.B. 20241
        const year = Math.floor(period / 10);
        const quarter = period % 10;

        return new Date(year, (quarter - 1) * 3, 1);
      }

      default:
        throw new Error(`Unsupported grouping: ${grouping}`);
    }
  }

  static getDateOfISOWeek(week, year) {
    const simple = new Date(year, 0, 1 + (week - 1) * 7);
    const dow = simple.getDay();
    const ISOweekStart = new Date(simple);

    if (dow <= 4) {
      ISOweekStart.setDate(simple.getDate() - simple.getDay() + 1);
    } else {
      ISOweekStart.setDate(simple.getDate() + 8 - simple.getDay());
    }

    return ISOweekStart;
  }


  static interpolateFTP(series, date, grouping) {
    const sorted = [...series].sort((a, b) => a.period - b.period);

    const target = new Date(date);

    for (let i = 0; i < sorted.length - 1; i++) {
      const left = sorted[i];
      const right = sorted[i + 1];

      const leftDate = FileDBService.periodToDate(left.period, grouping);
      const rightDate = FileDBService.periodToDate(right.period, grouping);

      if (target >= leftDate && target <= rightDate) {
        const ratio =
          (target - leftDate) / (rightDate - leftDate);

        return left.ftp + ratio * (right.ftp - left.ftp);
      }
    }

    return sorted[sorted.length - 1]?.ftp ?? null;
  }

  static aggregateDailyTSS(workouts) {
    const map = new Map();

    for (const w of workouts) {
      const d = new Date(w.start_time);

      const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

      const prev = map.get(day) || 0;
      map.set(day, prev + (w.tss ?? 0));
    }

    return Array.from(map.entries())
      .map(([day, tss]) => ({ day, tss }))
      .sort((a, b) => new Date(a.day) - new Date(b.day));
  }

  static async getCTLATL(authSub, period) {
    // 1. Alle Workouts laden
    const { rows } = await pool.query(
      `SELECT * FROM files WHERE auth_sub = $1 ORDER BY start_time`,
      [authSub]
    );

    // 2. FTP-Serie laden
    const ftpResult = await FileDBService.getFTPValues(authSub, "year");
    const ftpSeries = ftpResult.raw || ftpResult;

    // 3. Enrichment
    const enriched = rows.map(w =>
      FileDBService.computeWorkoutMetrics(w, ftpSeries, "year")
    );

    // 4. Daily TSS
    const daily = FileDBService.aggregateDailyTSS(enriched);

    // 5. Lücken füllen
    const filled = FileDBService.fillMissingDays(daily);

    // 6. CTL/ATL berechnen
    const ctl = FileDBService.computeCTLATL(filled);


    if (period === 'date') {
      return ctl;
    }
    else if (period === 'week') {
      return FileDBService.groupByAny(ctl, period);
    }
    else {
      return FileDBService.groupByAny(ctl, period);
    }
  }

  static fillMissingDays(daily) {
    if (daily.length === 0) return [];

    const result = [];
    const start = new Date(daily[0].day);
    const end = new Date(daily[daily.length - 1].day);

    const map = new Map(daily.map(d => [d.day, d.tss]));

    for (
      let d = new Date(start);
      d <= end;
      d.setDate(d.getDate() + 1)
    ) {
      const key = d.toISOString().slice(0, 10);

      result.push({
        day: key,
        tss: map.get(key) || 0
      });
    }

    return result;
  }

  static computeCTLATL(daily) {
    const CTL_TC = 42;
    const ATL_TC = 7;

    let ctl = 0;
    let atl = 0;

    return daily.map(d => {
      const tss = d.tss;

      ctl = Math.round(ctl + (tss - ctl) * (1 / CTL_TC));
      atl = Math.round(atl + (tss - atl) * (1 / ATL_TC));

      const tsb = Math.round(ctl - atl);

      return {
        date: d.day,
        tss,
        ctl,
        atl,
        tsb
      };
    });
  }
  static computeWorkoutMetrics(w, ftpSeries, grouping) {
    const ftp = FileDBService.interpolateFTP(
      ftpSeries,
      w.start_time,
      grouping
    );

    if (!ftp || !w.avg_normalized_power || !w.total_timer_time) {
      return {
        ...w,
        ftp: null,
        IF: null,
        tss: 0
      };
    }

    const IF = w.avg_normalized_power / ftp;

    const TSS =
      (w.total_timer_time * w.avg_normalized_power * IF) /
      (ftp * 3600) * 100;

    return {
      ...w,
      ftp,
      IF,
      tss: Math.round(TSS)
    };
  }



  // -----------------------------
  // Helper: ISO-Kalenderwoche
  // -----------------------------
  static getISOWeek(dateStr) {
    const d = new Date(dateStr);
    d.setHours(0, 0, 0, 0);

    d.setDate(d.getDate() + 4 - (d.getDay() || 7));

    const year = d.getFullYear();
    const yearStart = new Date(year, 0, 1);
    const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
    const key = `${year}${String(week).padStart(2, '0')}`

    return { year, week, key };
  }
  // -----------------------------
  // Helper: ISO-Monat
  // -----------------------------
  static getISOMonth(dateStr) {

    const year = dateStr.slice(0, 4);   // "2026"
    const month = dateStr.slice(5, 7);  // "03"

    const key = `${year}${month}`;


    return { year, month, key };
  }

  static getGroupKey(dat_str, grouping) {

    if (grouping === 'date') {
      return dat_str;
    }
    else if (grouping === 'week') {
      const { key } = FileDBService.getISOWeek(dat_str);
      return key;
    }
    else if (grouping === 'month') {
      const { key } = FileDBService.getISOMonth(dat_str);
      return key;
    }

  }


  // -----------------------------
  // Wochen-Gruppierung
  // -----------------------------
  /*static groupByWeek(data) {
    const groups = {};

    data.forEach(entry => {
      const { year, week } = FileDBService.getISOWeek(entry.date);
      const key = `${year}-W${String(week).padStart(2, '0')}`

      if (!groups[key]) {
        groups[key] = {
          year: year,
          week: week,
          date: `${year}${String(week).padStart(2, '0')}`,
          entries: [],
          tss_sum: 0,
          ctl_start: entry.ctl,
          ctl_end: entry.ctl,
          atl_sum: 0,
          tsb_min: entry.tsb,
          tsb_max: entry.tsb
        };
      }

      const g = groups[key];

      g.entries.push(entry);
      g.tss_sum += entry.tss;
      g.ctl_end = entry.ctl;
      g.atl_sum += entry.atl;

      if (entry.tsb < g.tsb_min) g.tsb_min = entry.tsb;
      if (entry.tsb > g.tsb_max) g.tsb_max = entry.tsb;
    });

    return Object.values(groups).map(g => ({
      year: g.year,
      week: g.week,
      date: `${g.year}${String(g.week).padStart(2, '0')}`,
      tss_sum: g.tss_sum,
      ctl_start: g.ctl_start,
      ctl_end: g.ctl_end,
      atl_avg: g.atl_sum / g.entries.length,
      tsb_min: g.tsb_min,
      tsb_max: g.tsb_max
    }));
  }*/

  // -----------------------------
  // Variable-Gruppierung
  // -----------------------------
  static groupByAny(data, grouping) {
    const groups = {};

    data.forEach(entry => {
      const key = FileDBService.getGroupKey(entry.date, grouping); // YYYYMM

      if (!groups[key]) {
        groups[key] = {
          date: key,
          entries: [],
          tss_sum: 0,
          ctl_start: entry.ctl,
          ctl_end: entry.ctl,
          tsb_sum: 0,
          atl_sum: 0
        };
      }

      const g = groups[key];

      g.entries.push(entry);
      g.tss_sum += entry.tss;
      g.ctl_end = entry.ctl;
      g.tsb_sum += entry.tsb;
      g.atl_sum += entry.atl;
    });

    return Object.values(groups).map(g => ({
      date: g.date,
      tss_sum: Math.round(g.tss_sum),
      ctl_start: Math.round(g.ctl_start),
      ctl_end: Math.round(g.ctl_end),
      tsb_avg: Math.round(g.tsb_sum / g.entries.length),
      atl_avg: Math.round(g.atl_sum / g.entries.length)
    }));
  }


static async createSegmentsBulk(authSub, workoutId, segments) {
  const values = [];
  const placeholders = [];
  let cnt = 0;

  segments.forEach((seg, i) => {
    const baseIndex = i * 9;

    placeholders.push(
      `($${baseIndex + 1}, $${baseIndex + 2}, $${baseIndex + 3}, $${baseIndex + 4}, $${baseIndex + 5}, $${baseIndex + 6}, $${baseIndex + 7}, $${baseIndex + 8}, $${baseIndex + 9})`
    );

    values.push(
      workoutId,
      authSub,
      seg.start,
      seg.end,
      seg.segmentType || "manual",
      seg.duration,
      seg.power,
      seg.heartrate,
      ++cnt
    );
  });

  const query = `
    INSERT INTO file_segments (
      file_id,
      auth_sub,
      start_index,
      end_index,
      segmenttype,
      duration,
      power,
      heartrate,
      position     
    )
    VALUES ${placeholders.join(", ")}
    ON CONFLICT DO NOTHING
    RETURNING *
  `;

  const result = await pool.query(query, values);
  return result.rows;
}

static async getSegmentsByWorkout(authSub, workoutId) {
  const query = `
    SELECT
      fs.id,
      fs.file_id,
      fs.start_index,
      fs.end_index,
      fs.segmenttype,
      fs.duration,
      fs.power,
      fs.heartrate,
      fs.position,
      fs.created_at
    FROM file_segments fs
    JOIN files f ON f.id = fs.file_id
    WHERE fs.file_id = $1
      AND fs.auth_sub = $2
    ORDER BY fs.start_index ASC
  `;

  const values = [workoutId, authSub];

  const result = await pool.query(query, values);

  return result.rows;
}



} // class


async function insertFile(fileRow, bestEfforts) {
  const d = new Date(fileRow.start_time);




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
    swc_long,
    year,
    month,
    week,
    year_quarter,
    year_month,
    year_week

  } = fileRow;
  try {

    await pool.query('BEGIN');

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
      swc_long,

      year,
      month,
      week,
      year_quarter,
      year_month,
      year_week      
    )
    VALUES (
      $1,$2,$3,$4,$5,
      $6,$7,
      $8,$9,$10,$11,$12,$13,$14,$15,
      $16,$17,$18,$19,$20,$21,$22,$23,
      $24,$25,$26,$27,$28,
      $29,$30,$31,$32,$33,$34
    )
    ON CONFLICT (auth_sub, start_time)
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
        swc_long,

        year,
        month,
        week,
        year_quarter,
        year_month,
        year_week,

      ]
    );

    if (result.rows.length === 0) {

      const str = d.toLocaleDateString();
      throw new Error(
        `Upload failed: At '${str}' there's already a workout for this user`
      );
    }

    await insertBestEfforts(result.rows[0].id, bestEfforts);
    await pool.query('COMMIT');

    return result.rows[0];

  } catch (err) {
    await pool.query('ROLLBACK');
    throw err;
  }

}


async function insertBestEfforts(fileId, bestEfforts) {
  if (!fileId) {
    throw new Error('insertBestEfforts: fileId is required');
  }

  if (!Array.isArray(bestEfforts)) {
    throw new Error('insertBestEfforts: bestEfforts must be an array');
  }

  if (bestEfforts.length === 0) {
    return;
  }
  try {

    const values = [];
    const params = [];

    let paramIndex = 1;

    for (const effort of bestEfforts) {
      values.push(`($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++})`);

      params.push(
        fileId,
        effort.start_offset,
        effort.duration,
        effort.endOffset ?? effort.end_offset,
        effort.avgPower,
        effort.avgHeartRate ?? null,
        effort.avgCadence ?? null,
        effort.avgSpeed ?? null
      );
    }

    const sql = `
    INSERT INTO file_best_efforts (
      file_id,
      start_offset,
      duration,
      end_offset,
      avg_power,
      avg_heart_rate,
      avg_cadence,
      avg_speed
    )
    VALUES ${values.join(', ')}
  `;

    await pool.query(sql, params);

    /*const sql = `
      INSERT INTO file_best_efforts (
        file_id,
        start_offset,
        duration,
        end_offset,
        avg_power,
        avg_heart_rate,
        avg_cadence,
        avg_speed
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (file_id, duration)
      DO UPDATE SET
        start_offset   = EXCLUDED.start_offset,
        end_offset     = EXCLUDED.end_offset,
        avg_power      = EXCLUDED.avg_power,
        avg_heart_rate = EXCLUDED.avg_heart_rate,
        avg_cadence    = EXCLUDED.avg_cadence,
        avg_speed      = EXCLUDED.avg_speed
    `;
  
  
  
    try {
      for (const effort of bestEfforts) {
        const startOffset = effort.start_offset;
        const duration = effort.duration;
        const endOffset = effort.endOffset ?? effort.end_offset;
        const avgPower = effort.avgPower;
        const avgHeartRate = effort.avgHeartRate ?? null;
        const avgCadence = effort.avgCadence ?? null;
        const avgSpeed = effort.avgSpeed ?? null;
  
        if (!Number.isInteger(startOffset) || startOffset < 0) {
          throw new Error(`Invalid startOffset: ${startOffset}`);
        }
  
        if (!Number.isInteger(duration) || duration <= 0) {
          throw new Error(`Invalid duration: ${duration}`);
        }
  
        if (!Number.isInteger(endOffset) || endOffset !== startOffset + duration - 1) {
          throw new Error(
            `Invalid endOffset: ${endOffset} for startOffset=${startOffset}, duration=${duration}`
          );
        }
  
        if (typeof avgPower !== 'number' || Number.isNaN(avgPower)) {
          throw new Error(`Invalid avgPower: ${avgPower}`);
        }
  
        await pool.query(sql, [
          fileId,
          startOffset,
          duration,
          endOffset,
          avgPower,
          avgHeartRate,
          avgCadence,
          avgSpeed,
        ]);
      }*/


  } catch (err) {

    throw err;
  }
}


export { insertFile, FileDBService, insertBestEfforts };