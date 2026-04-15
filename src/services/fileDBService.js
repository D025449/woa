import pool from "./database.js";
import pgPromise from "pg-promise";


class FileDBService {

  static createStepLogger(scope, meta = {}) {
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

  static allowedColumns = [
    "start_time",
    "uid",
    "id",
    "total_distance",
    "avg_speed",
    "avg_power",
    "avg_cadence",
    "avg_speed",
    "avg_normalized_power",
    "total_timer_time"
  ];

  static numericFields = [
    "id",
    "total_distance",
    "avg_speed",
    "avg_power",
    "avg_cadence",
    "avg_speed",
    "avg_normalized_power",
    "total_timer_time"
  ];



static async getMatchingWorkoutCandidates(sids, uid) {
  const USE_BOUNDS_ONLY_SEGMENT_CANDIDATES = true;

  const spatialFilter = USE_BOUNDS_ONLY_SEGMENT_CANDIDATES
    ? `s.bounds && w.bounds`
    : `s.bounds && w.bounds
      AND ST_DWithin(w.geom::geography, s.geom::geography, 100)`;

  const sql = `
    SELECT
      w.id as wid,
      w.samplerategps as wsamplerate,
      s.id as sid,
      ST_AsGeoJSON(w.geom)::json AS wgeom,
      ST_AsGeoJSON(s.geom)::json AS sgeom
    FROM gps_segments s
    JOIN workouts w
      ON w.uid = $2
    WHERE
      s.uid = $2
      AND s.id = ANY($1)
      AND ${spatialFilter}
      AND NOT EXISTS( SELECT 1 from gps_segment_best_efforts sbe WHERE sbe.wid = w.id and sbe.sid = s.id  )
  `;

  const result = await pool.query(
    sql,
    [sids, uid] // 👈 wichtig: Array übergeben
  );

  return result.rows;
}

static async getMatchingWorkoutCandidatesV2(bounds, segmentId, uid) {
  const sql = `
    SELECT
      w.id as wid,
      w.samplerategps as wsamplerate,
      ST_AsGeoJSON(w.geom)::json AS wgeom
    FROM workouts w
    WHERE
      w.uid = $1
      AND w.bounds && ST_MakeEnvelope($2, $3, $4, $5, 4326)
  `;

  const result = await pool.query(
    sql,
    [
      uid,
      bounds.minLng,
      bounds.minLat,
      bounds.maxLng,
      bounds.maxLat
    ]
  );

  return result.rows;
}




  static async getTrack(wid, uid) {


    const sql = `SELECT
      id,
      ST_AsGeoJSON(geom)::json AS geom
    FROM files
    WHERE
      uid = $2
      AND id = $1`

    const result = await pool.query(
      sql,
      [wid, uid]
    );

    return result.rows;
  }





  static async getCPBestEfforts(grouping, durations, uid) {
    const query = `
    SELECT *
    FROM get_cp_best_efforts($1, $2, $3)
  `;

    const values = [grouping, durations, uid];

    const result = await pool.query(query, values);
    return result.rows;
  }



  static async getFTPValues(uid, period = "quarter") {
    if (!uid) {
      throw new Error("Unauthorized");
    }

    const query = `
    SELECT *
    FROM get_ftp_by_period2($1, $2)
  `;

    const values = [uid, period];

    const result = await pool.query(query, values);

    return result.rows;
  }


  static buildQueryParts(allowedColumns, numericColumns, sort = [], filter = []) {

    let whereParts = [];
    let orderParts = [];
    let params = [];

    // --------------------
    // FILTER
    // --------------------
    (filter || []).forEach(f => {

      if (!allowedColumns.includes(f.field)) return;

      const paramIndex = params.length + 1;

      let value = f.value;
      // 🔥 Cast numbers
      if (numericColumns.includes(f.field)) {
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

      if (!allowedColumns.includes(s.field)) return;

      const dir = s.dir === "desc" ? "DESC" : "ASC";

      orderParts.push(`${s.field} ${dir}`);

    });


    const whereSQL = whereParts.length
      ? `WHERE ${whereParts.join(" AND ")}`
      : "";

    const orderSQL = orderParts.length
      ? `ORDER BY ${orderParts.join(", ")}`
      : "ORDER BY id ASC";


    return {
      whereSQL,
      orderSQL,
      params
    };
  }

  static async getWorkoutRecordsPreSignedUrl() {
    throw new Error("Legacy workout data endpoint is no longer supported");
  }

  static async deleteWorkout(uid, workoutId) {

    const { rowCount } = await pool.query(
      `
      SELECT 1
      FROM workouts
      WHERE id = $1
      AND uid = $2
      `,
      [workoutId, uid]
    );

    if (rowCount === 0) {
      throw new Error("Workout not found");
    }


    // 2. DB-Eintrag löschen
    const result = await pool.query(
      `
      DELETE FROM workouts
      WHERE id = $1
      AND uid= $2
  `,
      [workoutId, uid]
    );


    return result;


  }

  static async getWorkoutRecords() {
    throw new Error("Legacy workout data endpoint is no longer supported");
  }

  static getFileDefaultColumns() {
    return `id,
      uid,
      start_time,
      end_time,
      year,
      month,
      week,
      year_quarter,
      year_month,
      year_week,
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
      avg_normalized_power,
      avg_power,
      max_power,
      avg_heart_rate,
      max_heart_rate,
      avg_cadence,
      max_cadence,
      validGps`
  }


  static async getWorkoutsByUser(uid, page, size, sort, filter) {

    const offset = (page - 1) * size;

    const filter_all = [];
    filter_all.push({ field: 'uid', type: '=', value: uid });
    filter_all.push(...filter);



    const { whereSQL, orderSQL, params } =
      FileDBService.buildQueryParts(FileDBService.allowedColumns, FileDBService.numericFields, sort, filter_all);

    // -----------------------------------
    // BASE WHERE (User Filter + Tabulator Filter)
    // -----------------------------------

    let baseWhere = "WHERE ";
    let sqlParams = params;
    if (whereSQL) {
      baseWhere += whereSQL.replace("WHERE ", "");
      // sqlParams = [params];
    }

    const colums = FileDBService.getFileDefaultColumns();

    // -----------------------------------
    // DATA QUERY
    // -----------------------------------



    const dataQuery = `
    SELECT ${colums} 
    FROM workouts
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
    FROM workouts
    ${baseWhere}
  `;

    const countResult = await pool.query(countQuery, sqlParams);

    const totalRecords = parseInt(countResult.rows[0].total);

    const enriched_recs = await FileDBService.post_calculations(uid, dataResult.rows, "year");

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

  static async getCTLATL(uid, period) {
    // 1. Alle Workouts laden
    const { rows } = await pool.query(
      `SELECT * FROM workouts WHERE uid = $1 ORDER BY start_time`,
      [uid]
    );

    // 2. FTP-Serie laden
    const ftpResult = await FileDBService.getFTPValues(uid, "year");
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

  static async getSegmentsByWorkout(uid, workoutId) {
    const query = `
    SELECT *
    FROM workout_segments fs
    WHERE file_id = $1
      AND uid = $2
    ORDER BY start_offset ASC
  `;

    const values = [workoutId, uid];

    const result = await pool.query(query, values);

    return result.rows;
  }

  static async upsertSegmentsBulk(uid, workoutId, segments) {
    let cnt = 0;

    const fileIds = [];
    const uids = [];
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

    segments.filter(f => f.rowstate === 'CRE' || f.rowstate === 'UPD').forEach(seg => {
      fileIds.push(workoutId);
      uids.push(uid);
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

    });

    if (cnt === 0) {
      return [];
    }


    const query = `
  INSERT INTO workout_segments (
    wid,
    uid,
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
    segmentname
  )
    SELECT
  u.wid,
  u.uid,
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
  u.segmentname
  FROM UNNEST(
    $1::int[],
    $2::int[],
    $3::int[],
    $4::int[],
    $5::text[],
    $6::float8[],
    $7::float8[],
    $8::float8[],
    $9::float8[],
    $10::float8[],
    $11::float8[],
    $12::int[],
    $13::text[]
  ) AS u(
  wid,
  uid,
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
  segmentname
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
    segmentname = EXCLUDED.segmentname
  WHERE workout_segments.uid = EXCLUDED.uid
    AND workout_segments.wid = EXCLUDED.wid
  RETURNING *
`;

    const values = [
      fileIds,
      uids,
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
      segmentnames
    ];

    const result = await pool.query(query, values);
    return result.rows;
  }






  static async deleteSegmentsBulk(uid, workoutId, segments) {
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
    DELETE FROM workout_segments
    WHERE id = ANY($1::uuid[])
      AND uid = $2
    RETURNING id
  `;

    const values = [ids, uid];

    const result = await pool.query(query, values);
    return result.rows;
  }

  static async getSegmentsByWorkout(uid, workoutId) {
    const query = `
    SELECT
   *
    FROM workout_segments
    WHERE wid = $1
      AND uid = $2
    ORDER BY start_offset ASC
  `;

    const values = [workoutId, uid];

    const result = await pool.query(query, values);

    return result.rows;
  }

  static async insertFile(fileRow, segments, gps_track, workoutObject) {
    const timing = FileDBService.createStepLogger("db.insert-file", {
      uid: fileRow.uid,
      validGps: !!gps_track?.validGps,
      gpsPointCount: gps_track?.track?.length ?? 0,
      segmentCount: segments?.length ?? 0
    });
    const d = new Date(fileRow.start_time);

    const compressedBuffer = await workoutObject.toCompressedBuffer();
    timing.mark("to-compressed-buffer", {
      compressedBytes: compressedBuffer.length
    });
    //console.log({BufferSizeWritten: compressedBuffer.length});


    fileRow.validGps = gps_track.validGps;
    let sampleRateGPS = gps_track?.sampleRate ?? 1;
    if (fileRow.validGps) {
      fileRow.bbox = gps_track?.bbox ?? null;
    }
    else {
      sampleRateGPS = 1;
      fileRow.bbox = null;
    }


    // 🔥 LINESTRING bauen
    const points_count = gps_track?.track.length ?? 0;
    const coords = gps_track.track
      .map(p => `${p[1]} ${p[0]}`) // ⚠️ lng lat!
      .join(", ");

    const geom = `LINESTRING(${coords})`;
    timing.mark("build-geometry-wkt");


    const {
      uid,
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
      validGps,
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
      timing.mark("begin-transaction");

      const result = await pool.query(
        `
INSERT INTO workouts (
  uid,
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
  validGps,
  year,
  month,
  week,
  year_quarter,
  year_month,
  year_week,
  bounds,
  geom,
  points_count,
  sampleRateGPS,
  stream        
)
VALUES (
  $1,$2,
  $3,$4,$5,$6,$7,$8,$9,$10,
  $11,$12,$13,$14,$15,$16,$17,$18,
  $19,$20,$21,$22,$23,$24,$25,$26,$27,
CASE 
  WHEN $21 = true
  THEN ST_MakeEnvelope(
    $28::float8,
    $29::float8,
    $30::float8,
    $31::float8,
    4326
  )
  ELSE NULL
END,
CASE 
  WHEN $21 = true
  THEN $32
  ELSE NULL
END,
  $33,
  $34,
  $35
)
ON CONFLICT (uid, start_time)
DO NOTHING
RETURNING id, uid;
    `,
        [
          uid,              // $1
          start_time,            // $2
          end_time,              // $3
          total_elapsed_time,    // $4
          total_timer_time,      // $5
          total_distance,        // $6
          total_cycles,          // $7
          total_work,            // $8
          total_calories,        // $9
          total_ascent,          // $10
          total_descent,         // $11
          avg_speed,             // $12
          max_speed,             // $13
          avg_power,             // $14
          max_power,             // $15
          avg_normalized_power,  // $16
          avg_heart_rate,        // $17
          max_heart_rate,        // $18
          avg_cadence,           // $19
          max_cadence,           // $20
          validGps,              // $21
          year,                  // $22
          month,                 // $23
          week,                  // $24
          year_quarter,          // $25
          year_month,            // $26
          year_week,             // $27
          gps_track?.bbox?.minLng ?? null, // $28
          gps_track?.bbox?.minLat ?? null, // $29
          gps_track?.bbox?.maxLng ?? null, // $30
          gps_track?.bbox?.maxLat ?? null, // $31
          geom,                  // $32
          points_count,          // $33
          sampleRateGPS,         // $34
          compressedBuffer       // $35
        ]
      );

      if (result.rows.length === 0) {

        const str = d.toLocaleDateString();
        throw new Error(
          `Upload failed: At '${str}' there's already a workout for this user`
        );
      }
      timing.mark("insert-workout-row", {
        workoutId: result.rows[0]?.id
      });

      //await FileDBService.insertBestEfforts(result.rows[0].id, bestEfforts);
      await FileDBService.upsertSegmentsBulk(uid, result.rows[0].id, segments);
      timing.mark("upsert-workout-segments");
      await pool.query('COMMIT');
      timing.mark("commit");
      timing.flush({
        status: "completed",
        workoutId: result.rows[0]?.id
      });

      return result.rows[0];

    } catch (err) {
      await pool.query('ROLLBACK');
      timing.mark("rollback");
      timing.flush({
        status: "failed",
        error: err.message
      });
      throw err;
    }

  }

} // class








export { FileDBService };
