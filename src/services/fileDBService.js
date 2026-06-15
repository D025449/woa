import pool from "./database.js";
import pgPromise from "pg-promise";
import WorkoutSharingService from "./workoutSharingService.js";
import GpsTrackBlobService from "./gpsTrackBlobService.js";

const IMPORT_TIMING_DEBUG = String(process.env.IMPORT_TIMING_DEBUG || "").trim() === "1";
const FEATURE_THUMBNAILS_ON_DEMAND = String(process.env.FEATURE_THUMBNAILS_ON_DEMAND || "1").trim() !== "0";

class FileDBService {
  static searchColumns = [
    "id",
    "start_time",
    "uploaded_at",
    "total_distance",
    "total_timer_time",
    "total_ascent",
    "avg_power",
    "avg_heart_rate",
    "avg_normalized_power",
    "avg_cadence",
    "avg_speed"
  ];

  static scopedSearchColumns = {
    id: "id",
    date: "start_time",
    start: "start_time",
    uploaded: "uploaded_at",
    distance: "total_distance",
    duration: "total_timer_time",
    alt: "total_ascent",
    altitude: "total_ascent",
    ascent: "total_ascent",
    power: "avg_power",
    hr: "avg_heart_rate",
    heartrate: "avg_heart_rate",
    np: "avg_normalized_power",
    cadence: "avg_cadence",
    cad: "avg_cadence",
    speed: "avg_speed"
  };

  static normalizeQueryArray(value) {
    if (Array.isArray(value)) {
      return value;
    }

    if (typeof value === "string" && value.trim()) {
      try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }

    return [];
  }

  static createStepLogger(scope, meta = {}) {
    const startedAt = Date.now();
    let lastAt = startedAt;
    const steps = [];

    return {
      steps,
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
        if (!IMPORT_TIMING_DEBUG) {
          return;
        }
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
    "uploaded_at",
    "uid",
    "id",
    "total_distance",
    "total_ascent",
    "avg_speed",
    "avg_power",
    "avg_heart_rate",
    "avg_cadence",
    "avg_speed",
    "avg_normalized_power",
    "total_timer_time"
  ];

  static numericFields = [
    "id",
    "total_distance",
    "total_ascent",
    "avg_speed",
    "avg_power",
    "avg_heart_rate",
    "avg_cadence",
    "avg_speed",
    "avg_normalized_power",
    "total_timer_time"
  ];



static async getMatchingWorkoutCandidates(sids, uid) {
  const USE_BOUNDS_ONLY_SEGMENT_CANDIDATES = true;

  const spatialFilter = `s.bounds && w.bounds`;

  const sql = `
    SELECT
      w.id as wid,
      w.samplerategps as wsamplerate,
      w.gps_track_blob,
      s.id as sid,
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

  return Promise.all(result.rows.map(async (row) => {
    const decoded = await GpsTrackBlobService.decodeRowTrack({
      gps_track_blob: row.gps_track_blob
    });
    return {
      ...row,
      wgeom: decoded.geoJson
    };
  }));
}

static async getMatchingWorkoutCandidatesV2(bounds, segmentId, uid) {
  const sql = `
    SELECT
      w.id as wid,
      w.samplerategps as wsamplerate,
      w.gps_track_blob
    FROM workouts w
    WHERE
      (
        w.uid = $1
        OR EXISTS (
          SELECT 1
          FROM workout_group_shares wgs
          INNER JOIN gps_segment_group_shares sgs
            ON sgs.group_id = wgs.group_id
          WHERE wgs.workout_id = w.id
            AND sgs.segment_id = $6
        )
      )
      AND w.bounds && ST_MakeEnvelope($2, $3, $4, $5, 4326)
      AND NOT EXISTS (
        SELECT 1
        FROM gps_segment_best_efforts sbe
        WHERE sbe.sid = $6
          AND sbe.wid = w.id
      )
  `;

  const result = await pool.query(
    sql,
    [
      uid,
      bounds.minLng,
      bounds.minLat,
      bounds.maxLng,
      bounds.maxLat,
      segmentId
    ]
  );

  return Promise.all(result.rows.map(async (row) => {
    const decoded = await GpsTrackBlobService.decodeRowTrack({
      gps_track_blob: row.gps_track_blob
    });
    return {
      ...row,
      wgeom: decoded.geoJson
    };
  }));
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
    const normalizedSort = FileDBService.normalizeQueryArray(sort);
    const normalizedFilter = FileDBService.normalizeQueryArray(filter);

    let whereParts = [];
    let orderParts = [];
    let params = [];

    // --------------------
    // FILTER
    // --------------------
    normalizedFilter.forEach(f => {
      if (f.field === "__search") {
        const paramIndex = params.length + 1;
        const searchValue = String(f.value ?? "").trim();
        if (!searchValue) {
          return;
        }

        const scopedComparisonMatch = searchValue.match(/^([a-z_]+)\s*(<=|>=|=|<|>)\s*(.+)$/i);
        if (scopedComparisonMatch) {
          const scopeKey = String(scopedComparisonMatch[1] || "").toLowerCase();
          const operator = String(scopedComparisonMatch[2] || "").trim();
          const scopedValue = String(scopedComparisonMatch[3] || "").trim();
          const scopedColumn = FileDBService.scopedSearchColumns[scopeKey];

          if (scopedColumn && scopedValue && numericColumns.includes(scopedColumn)) {
            const numericValue = Number.parseFloat(scopedValue);
            if (Number.isFinite(numericValue)) {
              whereParts.push(`${scopedColumn} ${operator} $${paramIndex}`);
              params.push(numericValue);
              return;
            }
          }
        }

        const scopedMatch = searchValue.match(/^([a-z_]+)\s*:\s*(.+)$/i);
        if (scopedMatch) {
          const scopeKey = String(scopedMatch[1] || "").toLowerCase();
          const scopedValue = String(scopedMatch[2] || "").trim();
          const scopedColumn = FileDBService.scopedSearchColumns[scopeKey];

          if (scopedColumn && scopedValue) {
            if (numericColumns.includes(scopedColumn)) {
              whereParts.push(`ROUND(${scopedColumn})::text ILIKE $${paramIndex}`);
            } else {
              whereParts.push(`${scopedColumn}::text ILIKE $${paramIndex}`);
            }
            params.push(`%${scopedValue}%`);
            return;
          }
        }

        const likeParts = FileDBService.searchColumns.map((column) => `${column}::text ILIKE $${paramIndex}`);
        whereParts.push(`(${likeParts.join(" OR ")})`);
        params.push(`%${searchValue}%`);
        return;
      }

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
    normalizedSort.forEach(s => {

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

  static qualifySqlColumns(sqlFragment = "", columns = [], qualifier = "") {
    if (!sqlFragment || !qualifier || !Array.isArray(columns) || columns.length === 0) {
      return sqlFragment;
    }

    let qualified = sqlFragment;
    for (const column of columns) {
      const pattern = new RegExp(`(?<![\\w.])${column}(?![\\w])`, "g");
      qualified = qualified.replace(pattern, `${qualifier}.${column}`);
    }

    return qualified;
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

  static async deleteWorkouts(uid, workoutIds = []) {
    const normalizedIds = [...new Set(
      (Array.isArray(workoutIds) ? workoutIds : [])
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0)
    )];

    if (!normalizedIds.length) {
      return {
        rowCount: 0,
        deletedIds: []
      };
    }

    const result = await pool.query(
      `
      DELETE FROM workouts
      WHERE uid = $1
        AND id = ANY($2::int[])
      RETURNING id
      `,
      [uid, normalizedIds]
    );

    return {
      rowCount: result.rowCount,
      deletedIds: result.rows.map((row) => Number(row.id))
    };
  }

  static async getWorkoutRecords() {
    throw new Error("Legacy workout data endpoint is no longer supported");
  }

  static getFileDefaultColumns() {
    return `workouts.id,
      workouts.uid,
      workouts.uploaded_at,
      workouts.start_time,
      workouts.end_time,
      workouts.year,
      workouts.month,
      workouts.week,
      workouts.year_quarter,
      workouts.year_month,
      workouts.year_week,
      workouts.total_elapsed_time,
      workouts.total_timer_time,
      workouts.total_distance,
      workouts.total_cycles,
      workouts.total_work,
      workouts.total_calories,
      workouts.total_ascent,
      workouts.total_descent,
      workouts.avg_speed,
      workouts.max_speed,
      workouts.avg_normalized_power,
      workouts.avg_power,
      workouts.max_power,
      workouts.avg_heart_rate,
      workouts.max_heart_rate,
      workouts.avg_cadence,
      workouts.max_cadence,
      workouts.validgps,
      workouts.segment_processing_status,
      workouts.segment_processing_error,
      workouts.segment_processing_updated_at,
      owner.display_name AS owner_display_name,
      owner.email AS owner_email,
      (workouts.uid = $1)::boolean AS is_owned,
      CASE
        WHEN ${FEATURE_THUMBNAILS_ON_DEMAND ? "TRUE" : "FALSE"}
        THEN TRUE
        ELSE EXISTS(
          SELECT 1
          FROM workout_thumbnails wt
          WHERE wt.workout_id = workouts.id
        )
      END AS has_thumbnail,
      (
        SELECT wt.updated_at
        FROM workout_thumbnails wt
        WHERE wt.workout_id = workouts.id
      ) AS thumbnail_updated_at,
      (
        SELECT COUNT(*)
        FROM workout_group_shares wgs
        WHERE wgs.workout_id = workouts.id
      )::int AS share_group_count`
  }


  static async getWorkoutsByUser(uid, page, size, sort, filter, scope = "mine") {

    const offset = (page - 1) * size;

    const { whereSQL, orderSQL, params } =
      FileDBService.buildQueryParts(FileDBService.allowedColumns, FileDBService.numericFields, sort, filter);

    // -----------------------------------
    // BASE WHERE (User Filter + Tabulator Filter)
    // -----------------------------------

    const normalizedScope = ["mine", "shared", "all"].includes(String(scope).toLowerCase())
      ? String(scope).toLowerCase()
      : "mine";

    let accessPredicate = `workouts.uid = $1`;

    if (normalizedScope === "shared") {
      accessPredicate = `
        workouts.uid <> $1
        AND EXISTS (
          SELECT 1
          FROM workout_group_shares wgs
          INNER JOIN group_members gm
            ON gm.group_id = wgs.group_id
          WHERE wgs.workout_id = workouts.id
            AND gm.user_id = $1
        )
      `;
    } else if (normalizedScope === "all") {
      accessPredicate = `
        workouts.uid = $1
        OR EXISTS (
          SELECT 1
          FROM workout_group_shares wgs
          INNER JOIN group_members gm
            ON gm.group_id = wgs.group_id
          WHERE wgs.workout_id = workouts.id
            AND gm.user_id = $1
        )
      `;
    }

    let baseWhere = `WHERE (${accessPredicate})`;
    let sqlParams = [uid, ...params];
    if (whereSQL) {
      const adjustedWhere = FileDBService.qualifySqlColumns(
        whereSQL.replace(/\$(\d+)/g, (_, index) => `$${Number(index) + 1}`),
        FileDBService.allowedColumns,
        "workouts"
      );
      baseWhere += ` AND (${adjustedWhere.replace("WHERE ", "")})`;
    }

    const colums = FileDBService.getFileDefaultColumns();
    const qualifiedOrderSQL = FileDBService.qualifySqlColumns(
      orderSQL,
      FileDBService.allowedColumns,
      "workouts"
    );

    // -----------------------------------
    // DATA QUERY
    // -----------------------------------



    const dataQuery = `
    SELECT ${colums} 
    FROM workouts
    INNER JOIN users owner
      ON owner.id = workouts.uid
    ${baseWhere}
    ${qualifiedOrderSQL}
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
    INNER JOIN users owner
      ON owner.id = workouts.uid
    ${baseWhere}
  `;

    const countResult = await pool.query(countQuery, sqlParams);

    const totalRecords = parseInt(countResult.rows[0].total);
    const summaryResult = await pool.query(`
      SELECT
        COUNT(*)::int AS workout_count,
        COALESCE(SUM(total_timer_time), 0)::bigint AS total_timer_time,
        COALESCE(SUM(total_distance), 0)::double precision AS total_distance
      FROM workouts
      WHERE uid = $1
    `, [uid]);
    const summaryRow = summaryResult.rows[0] || {};

    const enriched_recs = await FileDBService.post_calculations(uid, dataResult.rows, "year");

    return {
      data: enriched_recs,
      last_page: Math.ceil(totalRecords / size),
      total_records: totalRecords,
      own_summary: {
        workout_count: Number(summaryRow.workout_count) || 0,
        total_timer_time: Number(summaryRow.total_timer_time) || 0,
        total_distance: Number(summaryRow.total_distance) || 0
      }
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

  static buildSegmentBulkArrays(uid, workoutId, segments) {
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

    segments.forEach((seg) => {
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
      segmentnames.push(seg.segmentname ?? "");
      positions.push(++cnt);
    });

    return {
      count: cnt,
      values: [
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
      ]
    };
  }

  static async insertSegmentsBulk(uid, workoutId, segments) {
    const createSegments = segments.filter((seg) => seg.rowstate === 'CRE');
    const { count, values } = FileDBService.buildSegmentBulkArrays(
      uid,
      workoutId,
      createSegments
    );

    if (count === 0) {
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
  RETURNING *
`;

    const result = await pool.query(query, values);
    return result.rows;
  }

  static async updateSegmentsBulk(uid, workoutId, segments) {
    const normalizeSegmentId = (value) => {
      if (Number.isInteger(value)) {
        return value;
      }

      if (typeof value === "string" && /^\d+$/.test(value.trim())) {
        return Number.parseInt(value, 10);
      }

      return null;
    };

    const updateSegments = segments
      .filter((seg) => seg.rowstate === 'UPD')
      .map((seg) => ({
        ...seg,
        id: normalizeSegmentId(seg.id)
      }))
      .filter((seg) => Number.isInteger(seg.id));

    if (updateSegments.length === 0) {
      return [];
    }

    const ids = [];
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
    let cnt = 0;

    updateSegments.forEach((seg) => {
      ids.push(seg.id);
      starts.push(seg.start_offset);
      ends.push(seg.end_offset);
      types.push(seg.segmenttype || "manual");
      durations.push(seg.duration);
      powers.push(seg.avg_power);
      heartrates.push(seg.avg_heart_rate);
      cadences.push(seg.avg_cadence);
      speeds.push(seg.avg_speed);
      altimetersArr.push(seg.altimeters);
      segmentnames.push(seg.segmentname ?? "");
      positions.push(++cnt);
    });

    const query = `
    UPDATE workout_segments AS ws
    SET
      start_offset = u.start_offset,
      end_offset = u.end_offset,
      segmenttype = u.segmenttype,
      duration = u.duration,
      avg_power = u.avg_power,
      avg_heart_rate = u.avg_heart_rate,
      avg_cadence = u.avg_cadence,
      avg_speed = u.avg_speed,
      altimeters = u.altimeters,
      position = u.position,
      segmentname = u.segmentname
    FROM UNNEST(
      $1::int[],
      $2::int[],
      $3::int[],
      $4::text[],
      $5::float8[],
      $6::float8[],
      $7::float8[],
      $8::float8[],
      $9::float8[],
      $10::float8[],
      $11::int[],
      $12::text[]
    ) AS u(
      id,
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
    WHERE ws.id = u.id
      AND ws.uid = $13
      AND ws.wid = $14
    RETURNING ws.*;
  `;

    const values = [
      ids,
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
      uid,
      workoutId
    ];

    const result = await pool.query(query, values);
    return result.rows;
  }

  static async upsertSegmentsBulk(uid, workoutId, segments) {
    const [inserted, updated] = await Promise.all([
      FileDBService.insertSegmentsBulk(uid, workoutId, segments),
      FileDBService.updateSegmentsBulk(uid, workoutId, segments)
    ]);

    return [...inserted, ...updated];
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
    WHERE id = ANY($1::int[])
      AND uid = $2
    RETURNING id
  `;

    const values = [ids, uid];

    const result = await pool.query(query, values);
    return result.rows;
  }

  static async getWorkoutSegmentProcessingStatus(uid, workoutId) {
    await WorkoutSharingService.getAccessibleWorkout(uid, workoutId);

    const result = await pool.query(`
      SELECT
        id,
        segment_processing_status,
        segment_processing_error,
        segment_processing_updated_at
      FROM workouts
      WHERE id = $1
    `, [workoutId]);

    return result.rows[0] || null;
  }

  static async updateWorkoutSegmentProcessingStatus(uid, workoutId, status, errorMessage = null) {
    const normalizedWorkoutId = Number(workoutId);
    if (!uid || !Number.isInteger(normalizedWorkoutId) || !status) {
      return null;
    }

    const result = await pool.query(`
      UPDATE workouts
      SET
        segment_processing_status = $3,
        segment_processing_error = $4,
        segment_processing_updated_at = NOW()
      WHERE uid = $1
        AND id = $2
      RETURNING
        id,
        segment_processing_status,
        segment_processing_error,
        segment_processing_updated_at
    `, [uid, normalizedWorkoutId, status, errorMessage]);

    return result.rows[0] || null;
  }

  static async getSegmentsByWorkout(uid, workoutId) {
    const statusRow = await FileDBService.getWorkoutSegmentProcessingStatus(uid, workoutId);

    const query = `
    SELECT
   *
    FROM workout_segments
    WHERE wid = $1
    ORDER BY start_offset ASC
  `;

    const values = [workoutId];

    const result = await pool.query(query, values);

    return {
      status: statusRow
        ? {
            workoutId: Number(statusRow.id),
            segmentProcessingStatus: statusRow.segment_processing_status || "queued",
            segmentProcessingError: statusRow.segment_processing_error || null,
            segmentProcessingUpdatedAt: statusRow.segment_processing_updated_at || null
          }
        : null,
      rows: result.rows
    };
  }

  static createDuplicateWorkoutMessage(startTime) {
    const date = new Date(startTime);
    return `Upload failed: At '${date.toLocaleDateString()}' there's already a workout for this user`;
  }

  static async prepareInsertFilePayload(fileRow, gps_track, workoutObject) {
    const timing = FileDBService.createStepLogger("db.prepare-insert-file", {
      uid: fileRow.uid,
      validGps: !!gps_track?.validGps,
      gpsPointCount: gps_track?.pointCount ?? gps_track?.track?.length ?? 0
    });

    const compressedBuffer = await workoutObject.toCompressedBuffer();
    timing.mark("to-compressed-buffer", {
      compressedBytes: compressedBuffer.length
    });

    fileRow.validGps = gps_track.validGps;
    const gpsSource = fileRow.validGps
      ? (fileRow.gps_source || "recorded")
      : null;
    let sampleRateGPS = gps_track?.sampleRate ?? 1;
    if (fileRow.validGps) {
      fileRow.bbox = gps_track?.bbox ?? null;
    } else {
      sampleRateGPS = 1;
      fileRow.bbox = null;
    }

    const points_count = gps_track?.pointCount ?? gps_track?.track?.length ?? 0;
    const firstTrackPoint = points_count > 0
      ? (gps_track?.latitudesQ ? [
          gps_track.latitudesQ[0] / gps_track.quantizationScale,
          gps_track.longitudesQ[0] / gps_track.quantizationScale
        ] : gps_track.track[0])
      : null;
    const lastTrackPoint = points_count > 0
      ? (gps_track?.latitudesQ ? [
          gps_track.latitudesQ[points_count - 1] / gps_track.quantizationScale,
          gps_track.longitudesQ[points_count - 1] / gps_track.quantizationScale
        ] : gps_track.track[points_count - 1])
      : null;
    const trackStartGeom = firstTrackPoint
      ? `POINT(${firstTrackPoint[1]} ${firstTrackPoint[0]})`
      : null;
    const trackEndGeom = lastTrackPoint
      ? `POINT(${lastTrackPoint[1]} ${lastTrackPoint[0]})`
      : null;
    timing.mark("build-geometry-wkt");

    const compressedGpsTrackBlob = gps_track?.latitudesQ && gps_track?.longitudesQ
      ? await GpsTrackBlobService.encodeCompressedFromQuantized(gps_track, {
          sampleRateGps: sampleRateGPS,
          scale: gps_track.quantizationScale
        })
      : await GpsTrackBlobService.encodeCompressed(gps_track?.track ?? [], {
          sampleRateGps: sampleRateGPS
        });

    if (fileRow.validGps && points_count < 2) {
      console.warn("[db.insert-file] forcing GPS invalid because track has fewer than 2 points", {
        uid: fileRow.uid,
        startTime: fileRow.start_time,
        pointsCount: points_count
      });
      fileRow.validGps = false;
      fileRow.bbox = null;
      sampleRateGPS = 1;
    }

    return {
      fileRow,
      gps_track,
      workoutObject,
      compressedBuffer,
      compressedGpsTrackBlob,
      trackStartGeom,
      trackEndGeom,
      points_count,
      sampleRateGPS,
      gpsSource,
      timingSteps: Array.isArray(timing?.steps)
        ? timing.steps.map((step) => ({
            label: step.label,
            stepMs: Number(step.stepMs || 0)
          }))
        : []
    };
  }

  static buildPreparedInsertParams(prepared) {
    const {
      fileRow,
      gps_track,
      compressedBuffer,
      compressedGpsTrackBlob,
      trackStartGeom,
      trackEndGeom,
      points_count,
      sampleRateGPS,
      gpsSource
    } = prepared;
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

    return [
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
      gps_track?.bbox?.minLng ?? null,
      gps_track?.bbox?.minLat ?? null,
      gps_track?.bbox?.maxLng ?? null,
      gps_track?.bbox?.maxLat ?? null,
      trackStartGeom,
      trackEndGeom,
      points_count,
      sampleRateGPS,
      compressedGpsTrackBlob,
      compressedBuffer,
      gpsSource
    ];
  }

  static buildWorkoutInsertValuesClause(rowIndex) {
    const offset = rowIndex * 38;
    const p = (index) => `$${offset + index}`;
    return `(
  ${p(1)},${p(2)},
  ${p(3)},${p(4)},${p(5)},${p(6)},${p(7)},${p(8)},${p(9)},${p(10)},
  ${p(11)},${p(12)},${p(13)},${p(14)},${p(15)},${p(16)},${p(17)},${p(18)},
  ${p(19)},${p(20)},${p(21)},${p(22)},${p(23)},${p(24)},${p(25)},${p(26)},${p(27)},
CASE
  WHEN ${p(21)} = true
  THEN ST_MakeEnvelope(
    ${p(28)}::float8,
    ${p(29)}::float8,
    ${p(30)}::float8,
    ${p(31)}::float8,
    4326
  )
  ELSE NULL
END,
CASE
  WHEN ${p(21)} = true
  THEN ST_GeomFromText(${p(32)}, 4326)
  ELSE NULL
END,
CASE
  WHEN ${p(21)} = true
  THEN ST_GeomFromText(${p(33)}, 4326)
  ELSE NULL
END,
  ${p(34)},
  ${p(35)},
  ${p(36)},
  ${p(37)},
  ${p(38)}
)`;
  }

  static async findExistingWorkoutsByStartTimes(uid, startTimes = []) {
    if (!uid || !Array.isArray(startTimes) || startTimes.length === 0) {
      return new Map();
    }

    const result = await pool.query(
      `
      SELECT id, uid, start_time
      FROM workouts
      WHERE uid = $1
        AND start_time = ANY($2::timestamptz[])
      `,
      [uid, startTimes]
    );

    return new Map(result.rows.map((row) => [
      `${row.uid}:${new Date(row.start_time).toISOString()}`,
      row
    ]));
  }

  static async insertPreparedFilesBulk(preparedItems = []) {
    if (!Array.isArray(preparedItems) || preparedItems.length === 0) {
      return {
        insertedRows: [],
        existingRowsByKey: new Map(),
        timingSteps: []
      };
    }

    const timing = FileDBService.createStepLogger("db.insert-files-bulk", {
      rowCount: preparedItems.length
    });

    const valuesClauses = [];
    const params = [];
    for (let index = 0; index < preparedItems.length; index += 1) {
      valuesClauses.push(FileDBService.buildWorkoutInsertValuesClause(index));
      params.push(...FileDBService.buildPreparedInsertParams(preparedItems[index]));
    }

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
  track_start,
  track_end,
  points_count,
  sampleRateGPS,
  gps_track_blob,
  stream,
  gps_source
)
VALUES
${valuesClauses.join(",\n")}
ON CONFLICT (uid, start_time)
DO NOTHING
RETURNING id, uid, start_time;
      `,
      params
    );
    timing.mark("insert-workout-rows", {
      insertedCount: result.rowCount
    });

    const insertedRows = Array.isArray(result.rows) ? result.rows : [];
    const startTimes = preparedItems.map((item) => item.fileRow.start_time);
    const existingRowsByKey = await FileDBService.findExistingWorkoutsByStartTimes(
      preparedItems[0]?.fileRow?.uid,
      startTimes
    );
    timing.mark("load-existing-rows", {
      resolvedCount: existingRowsByKey.size
    });

    return {
      insertedRows,
      existingRowsByKey,
      timingSteps: Array.isArray(timing?.steps)
        ? timing.steps.map((step) => ({
            label: step.label,
            stepMs: Number(step.stepMs || 0)
          }))
        : []
    };
  }

  static async insertFile(fileRow, segments, gps_track, workoutObject) {
    const timing = FileDBService.createStepLogger("db.insert-file", {
      uid: fileRow.uid,
      validGps: !!gps_track?.validGps,
      gpsPointCount: gps_track?.pointCount ?? gps_track?.track?.length ?? 0,
      segmentCount: segments?.length ?? 0
    });
    const prepared = await FileDBService.prepareInsertFilePayload(fileRow, gps_track, workoutObject);
    const d = new Date(fileRow.start_time);

    try {
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
  track_start,
  track_end,
  points_count,
  sampleRateGPS,
  gps_track_blob,
  stream,
  gps_source
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
  THEN ST_GeomFromText($32, 4326)
  ELSE NULL
END,
CASE
  WHEN $21 = true
  THEN ST_GeomFromText($33, 4326)
  ELSE NULL
END,
  $34,
  $35,
  $36,
  $37,
  $38
)
ON CONFLICT (uid, start_time)
DO NOTHING
RETURNING id, uid;
    `,
        FileDBService.buildPreparedInsertParams(prepared)
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
      timing.flush({
        status: "completed",
        workoutId: result.rows[0]?.id
      });

      return {
        ...result.rows[0],
        timingSteps: [
          ...(Array.isArray(prepared.timingSteps) ? prepared.timingSteps : []),
          ...(Array.isArray(timing?.steps)
            ? timing.steps.map((step) => ({
                label: step.label,
                stepMs: Number(step.stepMs || 0)
              }))
            : [])
        ]
      };

    } catch (err) {
      timing.flush({
        status: "failed",
        error: err.message
      });
      throw err;
    }

  }

} // class








export { FileDBService };
