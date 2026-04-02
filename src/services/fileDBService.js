import pool from "./database.js";
import S3Service from "./s3Service.js";
import pgPromise from "pg-promise";


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


    const data = payload.data;
    return { data };

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

  static async getSegmentsByWorkout(authSub, workoutId) {
    const query = `
    SELECT *
    FROM file_segments fs
    WHERE file_id = $1
      AND auth_sub = $2
    ORDER BY start_offset ASC
  `;

    const values = [workoutId, authSub];

    const result = await pool.query(query, values);

    return result.rows;
  }

  static async upsertSegmentsBulk(authSub, workoutId, segments) {
    let cnt = 0;

    const ids = [];
    const fileIds = [];
    const authSubs = [];
    const starts = [];
    const ends = [];
    const types = [];
    const durations = [];
    const powers = [];
    const heartrates = [];
    const cadences = [];
    const speeds = [];
    const altimetersArr = [];
    const positions = [];
    const segmentnames = [];

    const minLats = [];
    const maxLats = [];
    const minLngs = [];
    const maxLngs = [];

    segments.filter(f => f.rowstate === 'CRE' || f.rowstate === 'UPD').forEach(seg => {
      ids.push(seg.id);
      fileIds.push(workoutId);
      authSubs.push(authSub);
      starts.push(seg.start_offset);
      ends.push(seg.end_offset);
      types.push(seg.segmenttype || "manual");
      durations.push(seg.duration);
      powers.push(seg.avg_power);
      heartrates.push(seg.avg_heart_rate);
      cadences.push(seg.avg_cadence);
      speeds.push(seg.avg_speed);
      altimetersArr.push(seg.altimeters);
      segmentnames.push(seg.segmentname);
      positions.push(++cnt);
      minLats.push(seg?.gpstrack?.bbox?.minLat ?? null);
      maxLats.push(seg?.gpstrack?.bbox?.maxLat ?? null);
      minLngs.push(seg?.gpstrack?.bbox?.minLng ?? null);
      maxLngs.push(seg?.gpstrack?.bbox?.maxLng ?? null);
      //seg?.gpstrack?.bbox

    });

    if (cnt === 0) {
      return [];
    }


    const query = `
  INSERT INTO file_segments (
    id,
    file_id,
    auth_sub,
    start_offset,
    end_offset,
    segmenttype,
    duration,
    avg_power,
    avg_heart_rate,
    avg_cadence,
    avg_speed,
    altimeters,
    position,
    segmentname,
    bounds
  )
    SELECT
  u.id,
  u.file_id,
  u.auth_sub,
  u.start_offset,
  u.end_offset,
  u.segmenttype,
  u.duration,
  u.avg_power,
  u.avg_heart_rate,
  u.avg_cadence,
  u.avg_speed,
  u.altimeters,
  u.position,
  u.segmentname,

  CASE 
    WHEN u.minLat IS NOT NULL
    THEN ST_MakeEnvelope(u.minLng, u.minLat, u.maxLng, u.maxLat, 4326)
    ELSE NULL
  END
  FROM UNNEST(
    $1::uuid[],
    $2::uuid[],
    $3::text[],
    $4::int[],
    $5::int[],
    $6::text[],
    $7::float8[],
    $8::float8[],
    $9::float8[],
    $10::float8[],
    $11::float8[],
    $12::float8[],
    $13::int[],
    $14::text[],
    $15::float8[],
    $16::float8[],
    $17::float8[],
    $18::float8[]    
  ) AS u(
  id,
  file_id,
  auth_sub,
  start_offset,
  end_offset,
  segmenttype,
  duration,
  avg_power,
  avg_heart_rate,
  avg_cadence,
  avg_speed,
  altimeters,
  position,
  segmentname,
  minLat,
  maxLat,
  minLng,
  maxLng
)
  ON CONFLICT (id)
  DO UPDATE SET
    start_offset = EXCLUDED.start_offset,
    end_offset = EXCLUDED.end_offset,
    segmenttype = EXCLUDED.segmenttype,
    duration = EXCLUDED.duration,
    avg_power = EXCLUDED.avg_power,
    avg_heart_rate = EXCLUDED.avg_heart_rate,
    avg_cadence = EXCLUDED.avg_cadence,
    avg_speed = EXCLUDED.avg_speed,
    altimeters = EXCLUDED.altimeters,
    position = EXCLUDED.position,
    segmentname = EXCLUDED.segmentname,
    bounds = EXCLUDED.bounds
  WHERE file_segments.auth_sub = EXCLUDED.auth_sub
    AND file_segments.file_id = EXCLUDED.file_id
  RETURNING *
`;

    const values = [
      ids,
      fileIds,
      authSubs,
      starts,
      ends,
      types,
      durations,
      powers,
      heartrates,
      cadences,
      speeds,
      altimetersArr,
      positions,
      segmentnames,
      minLats,
      maxLats,
      minLngs,
      maxLngs
    ];

    const result = await pool.query(query, values);
    return result.rows;
  }






  static async deleteSegmentsBulk(authSub, workoutId, segments) {
    if (!Array.isArray(segments)) {
      return [];
    }
    let cnt = 0;

    const ids = [];

    segments.filter(f => f.rowstate === 'DEL').forEach(seg => {
      ids.push(seg.id);
      ++cnt;
    });

    if (cnt === 0) {
      return [];
    }

    const query = `
    DELETE FROM file_segments
    WHERE id = ANY($1::uuid[])
      AND auth_sub = $2
    RETURNING id
  `;

    const values = [ids, authSub];

    const result = await pool.query(query, values);
    return result.rows;
  }

  static async getSegmentsByWorkout(authSub, workoutId) {
    const query = `
    SELECT
   *
    FROM file_segments
    WHERE file_id = $1
      AND auth_sub = $2
    ORDER BY start_offset ASC
  `;

    const values = [workoutId, authSub];

    const result = await pool.query(query, values);

    return result.rows;
  }

  static async insertFile(fileRow, segments, gps_track) {
    const d = new Date(fileRow.start_time);

    fileRow.validGPS = gps_track.validGPS;
    fileRow.minLat = gps_track?.bbox?.minLat ?? 0;
    fileRow.maxLat = gps_track?.bbox?.maxLat ?? 0;
    fileRow.minLng = gps_track?.bbox?.minLng ?? 0;
    fileRow.maxLng = gps_track?.bbox?.maxLng ?? 0;





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
      minLat,
      maxLat,
      minLng,
      maxLng,
      validGPS,
      year,
      month,
      week,
      year_quarter,
      year_month,
      year_week
    } = fileRow;
    // SET bounds = ST_MakeEnvelope(minLng, minLat, maxLng, maxLat, 4326);


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
  minLat, 
  maxLat,
  minLng,
  maxLng,
  validGPS,
  year,
  month,
  week,
  year_quarter,
  year_month,
  year_week,
  bounds        
)
VALUES (
  $1,$2,$3,$4,$5,
  $6,$7,
  $8,$9,$10,$11,$12,$13,$14,$15,
  $16,$17,$18,$19,$20,$21,$22,$23,
  $24,$25,$26,$27,$28,
  $29,$30,$31,$32,$33,$34,$35,
  ST_MakeEnvelope($27, $25, $28, $26, 4326)
)
ON CONFLICT (auth_sub, start_time)
DO NOTHING
RETURNING *;
    `,
        [
          auth_sub,              // $1
          original_filename,     // $2
          s3_key,                // $3
          mime_type,             // $4
          file_size,             // $5
          start_time,            // $6
          end_time,              // $7
          total_elapsed_time,    // $8
          total_timer_time,      // $9
          total_distance,        // $10
          total_cycles,          // $11
          total_work,            // $12
          total_calories,        // $13
          total_ascent,          // $14
          total_descent,         // $15
          avg_speed,             // $16
          max_speed,             // $17
          avg_power,             // $18
          max_power,             // $19
          avg_normalized_power,  // $20
          avg_heart_rate,        // $21
          max_heart_rate,        // $22
          avg_cadence,           // $23
          max_cadence,           // $24
          minLat,                // $25
          maxLat,                // $26
          minLng,                // $27
          maxLng,                // $28
          validGPS,              // $29
          year,                  // $30
          month,                 // $31
          week,                  // $32
          year_quarter,          // $33
          year_month,            // $34
          year_week              // $35
        ]
      );

      if (result.rows.length === 0) {

        const str = d.toLocaleDateString();
        throw new Error(
          `Upload failed: At '${str}' there's already a workout for this user`
        );
      }

      //await FileDBService.insertBestEfforts(result.rows[0].id, bestEfforts);
      await FileDBService.upsertSegmentsBulk(auth_sub, result.rows[0].id, segments);
      await pool.query('COMMIT');

      return result.rows[0];

    } catch (err) {
      await pool.query('ROLLBACK');
      throw err;
    }

  }


} // class








export { FileDBService };