import pool from "./database.js";
import { FileDBService } from "./fileDBService.js";
import SegmentMatcher from "./SegmentMatcher.js";
import WorkoutDBService from "./workoutDBService.js";



export default class SegmentDBService {

  static allowedColumns = [
    "id",
    "sid",
    "wid",
    "start_time",
    "uid",
    "duration",
    "start_offset",
    "end_offset",
    "avg_power",
    "avg_heart_rate",
    "avg_cadence",
    "avg_speed",
  ];

  static numericFields = [
    "duration",
    "start_time",
    "start_offset",
    "end_offset",
    "avg_power",
    "avg_heart_rate",
    "avg_cadence",
    "avg_speed"
  ];

  static async storeSegmentBestEffortsV2(matches) {

    const gps_segments_be = [];
    matches.forEach(match => {
      const duration = match.end_offset - match.start_offset;
      const segment_id = match.segment_id;
      const file_id = match.workout_id;
      const start_offset = match.start_offset;
      const end_offset = match.end_offset;
      const avg_power = match.power;
      const avg_heart_rate = match.hr;
      const avg_cadence = match.cadence;
      const avg_speed = match.speed;

      gps_segments_be.push({
        segment_id,
        file_id,
        start_offset,
        end_offset,
        duration,
        avg_power,
        avg_heart_rate,
        avg_cadence,
        avg_speed
      });

    });

    const segmentIds = [];
    const fileIds = [];
    const starts = [];
    const ends = [];
    const durations = [];
    const pws = [];
    const hrs = [];
    const cds = [];
    const sps = [];

    for (const m of gps_segments_be) {
      segmentIds.push(m.segment_id);
      fileIds.push(m.file_id);
      starts.push(m.start_offset);
      ends.push(m.end_offset);
      durations.push(m.duration);
      pws.push(m.avg_power);
      hrs.push(m.avg_heart_rate);
      cds.push(m.avg_cadence);
      sps.push(m.avg_speed);
    }

    const result = await pool.query(`
    INSERT INTO gps_segment_best_efforts (
      sid,
      wid,
      start_offset,
      end_offset,
      duration,
      avg_power,
      avg_heart_rate,
      avg_cadence,
      avg_speed
    )
    SELECT *
    FROM UNNEST(
      $1::int[],
      $2::int[],   
      $3::int[],   
      $4::int[],   
      $5::int[],    
      $6::float8[],
      $7::float8[],
      $8::float8[],
      $9::float8[]
    )
    RETURNING *;
  `, [segmentIds, fileIds, starts, ends, durations, pws, hrs, cds, sps]);

    return result.rows;

  }


  static matchSegments(workout, segments) {
    const results = [];


    const wotrack = {
      wid: workout.id,
      track: workout.track.map(p => ({ lat: p[0], lng: p[1] })),
      sampleRate: workout.sampleRate
    }


    for (const seg of segments) {
      //results.push( ... matchSegment(track, seg));
      const segLine = seg.geom.coordinates.map(([lng, lat]) => ({ lat, lng }));
      const m = SegmentMatcher.findMatches(wotrack, { id: seg.id, track: segLine });
      //console.log({ wid: workout.id, sid: seg.id, segcount: m.length });
      results.push(...m);
    }

    return results;
  }


  static async storeSegmentBestEfforts(uid, matches, powers, heartRates, cadences, speeds) {

    const gps_segments_be = [];
    matches.forEach(match => {
      const duration = match.end_offset - match.start_offset;
      const segment_id = match.segment_id;
      const file_id = match.workout_id;
      const start_offset = match.start_offset;
      const end_offset = match.end_offset;
      let avg_power = 0;
      let avg_heart_rate = 0;
      let avg_cadence = 0;
      let avg_speed = 0;
      let cnt = 0;
      for (let i = start_offset; i <= end_offset; ++i) {
        avg_power += powers[i];
        avg_heart_rate += heartRates[i];
        avg_cadence += cadences[i];
        avg_speed += speeds[i];
        ++cnt;
      }
      if (cnt > 0) {
        avg_power = Math.round(avg_power / cnt);
        avg_heart_rate = Math.round(avg_heart_rate / cnt);
        avg_cadence = Math.round(avg_cadence / cnt);
        avg_speed = Math.round(avg_speed * 10 / cnt) / 10;
      }
      gps_segments_be.push({
        segment_id,
        file_id,
        uid,
        start_offset,
        end_offset,
        duration,
        avg_power,
        avg_heart_rate,
        avg_cadence,
        avg_speed
      });

    });

    const segmentIds = [];
    const fileIds = [];
    //    const uids = [];
    const starts = [];
    const ends = [];
    const durations = [];
    const pws = [];
    const hrs = [];
    const cds = [];
    const sps = [];

    for (const m of gps_segments_be) {
      segmentIds.push(m.segment_id);
      fileIds.push(m.file_id);
      //      uids.push(m.uid);
      starts.push(m.start_offset);
      ends.push(m.end_offset);
      durations.push(m.duration);
      pws.push(m.avg_power);
      hrs.push(m.avg_heart_rate);
      cds.push(m.avg_cadence);
      sps.push(m.avg_speed);
    }

    const result = await pool.query(`
    INSERT INTO gps_segment_best_efforts (
      sid,
      wid,
      start_offset,
      end_offset,
      duration,
      avg_power,
      avg_heart_rate,
      avg_cadence,
      avg_speed
    )
    SELECT *
    FROM UNNEST(
      $1::int[],
      $2::int[],   
      $3::int[],   
      $4::int[],   
      $5::int[],    
      $6::float8[],
      $7::float8[],
      $8::float8[],
      $9::float8[]
    )
    RETURNING *;
  `, [segmentIds, fileIds, starts, ends, durations, pws, hrs, cds, sps]);

    return result.rows;

  }


  static matchSegments(workout, segments) {
    const results = [];


    const wotrack = {
      wid: workout.id,
      track: workout.track.map(p => ({ lat: p[0], lng: p[1] })),
      sampleRate: workout.sampleRate
    }


    for (const seg of segments) {
      //results.push( ... matchSegment(track, seg));
      const segLine = seg.geom.coordinates.map(([lng, lat]) => ({ lat, lng }));
      const m = SegmentMatcher.findMatches(wotrack, { id: seg.id, track: segLine });
      console.log({ wid: workout.id, sid: seg.id, segcount: m.length });
      results.push(...m);
    }

    return results;
  }

  static async getMatchingSegmentCandidates(wid, uid) {

    const sql = `SELECT
      s.id,
      ST_AsGeoJSON(s.geom)::json AS geom
    FROM gps_segments s
    JOIN workouts w
      ON w.id = $1
      AND w.uid = $2
    WHERE
      s.uid = $2
      AND s.bounds && w.bounds
      AND ST_DWithin(w.geom, s.geom, 30)
      `

    const result = await pool.query(
      sql,
      [wid, uid]
    );


    return result.rows;
  }


  static async getBestEffortsBySegment(uid, segid, page, size, sort, filter) {

    const offset = (page - 1) * size;

    const filter_all = [];
    //filter_all.push({ field: 'uid', type: '=', value: uid });
    filter_all.push({ field: 'sid', type: '=', value: segid });
    filter_all.push(...filter);



    const { whereSQL, orderSQL, params } =
      FileDBService.buildQueryParts(SegmentDBService.allowedColumns, SegmentDBService.numericFields, sort, filter_all);

    // -----------------------------------
    // BASE WHERE (User Filter + Tabulator Filter)
    // -----------------------------------

    let baseWhere = "WHERE ";
    let sqlParams = params;
    if (whereSQL) {
      baseWhere += whereSQL.replace("WHERE ", "");
      // sqlParams = [params];
    }

    // -----------------------------------
    // DATA QUERY
    // -----------------------------------

    const dataQuery = `
    SELECT 
      id, 
      sid,
      wid,
      uid,
      start_time, 
      duration, 
      start_offset, 
      end_offset, 
      avg_power, 
      avg_heart_rate, 
      avg_cadence, 
      avg_speed,
      ROW_NUMBER() OVER (
        PARTITION BY sid
        ORDER BY duration ASC
      ) AS rn
    FROM v_gps_segment_best_efforts
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
    FROM gps_segment_best_efforts
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


  static async querySegmentsByBounds(uid, bounds, excludeIds, limit) {



    const result = await pool.query(`
  SELECT
    id,
    uid,
    distance,
    duration,
    start_lat,
    start_lng,
    start_name,
    start_altitude,
    end_lat,
    end_lng,
    end_name,
    end_altitude,
    ascent,
    altitudes,
    points_count,
    ST_AsGeoJSON(geom)::json AS geom_geojson,
    ST_YMin(bounds) AS min_lat,
    ST_YMax(bounds) AS max_lat,
    ST_XMin(bounds) AS min_lng,
    ST_XMax(bounds) AS max_lng
  FROM gps_segments
  WHERE uid = $1
    AND (
      $2::int[] IS NULL
      OR NOT (id = ANY($2))
    )
    AND bounds && ST_MakeEnvelope($3, $4, $5, $6, 4326)

  ORDER BY created_at DESC
  LIMIT $7
`, [
      uid,
      excludeIds,
      bounds.minLng,
      bounds.minLat,
      bounds.maxLng,
      bounds.maxLat,
      limit

    ]);

    return result;


  }

static chunkArray(arr, size) {
  const result = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}

  static async scanWorkoutsForSegments(uid, segments) {
    const sids = segments.map(m => m.id);

    const candidates = await FileDBService.getMatchingWorkoutCandidates(sids, uid);

    const matches = [];

    candidates.forEach(cand => {
      const wotrack = {
        wid: cand.wid,
        track: cand.wgeom.coordinates.map(([lng, lat]) => ({ lat, lng })),
        sampleRate: cand.wsamplerate
      }
      const segLine = cand.sgeom.coordinates.map(([lng, lat]) => ({ lat, lng }));
      const m = SegmentMatcher.findMatches(wotrack, { id: cand.sid, track: segLine });
      //console.log({ wid: cand.wdisplay_id, sid: cand.sdisplay_id, segcount: m.length });
      matches.push(...m);
    });


    const uniqueIds = [...new Set(matches.map(w => w.workout_id))];

    if (uniqueIds.length > 0) {
      const chunks = SegmentDBService.chunkArray(uniqueIds, 10);

      const CONCURRENCY = 3; // 🔥 feinjustieren!

      for (let i = 0; i < chunks.length; i += CONCURRENCY) {
        const batch = chunks.slice(i, i + CONCURRENCY);

        const results = await Promise.all(
          batch.map(chunk => WorkoutDBService.getWorkouts(chunk))
        );

        results.forEach((workoutMap, idx) => {
          const chunk = batch[idx];

          matches.forEach(match => {
            if (!chunk.includes(match.workout_id)) return;

            const workoutObject = workoutMap.get(match.workout_id);
            if (!workoutObject) return;

            const avgs = workoutObject.getAverages(match.start_offset, match.end_offset);
            Object.assign(match, avgs);
          });
        });
      }
    }
    return matches;
  }

  static async insertGpsSegmentsBulk(uid, segments) {
    if (!segments || segments.length === 0) return [];

    const ids = [];
    const uids = [];
    const distances = [];
    const durations = [];

    const startLats = [];
    const startLngs = [];
    const startNames = [];
    const startAltitudes = [];

    const endLats = [];
    const endLngs = [];
    const endNames = [];
    const endAltitudes = [];

    const ascents = [];
    const pointCounts = [];
    const altitudes = [];

    const wkts = [];

    for (const seg of segments) {
      ids.push(seg.id);
      uids.push(uid);

      distances.push(seg.distance ?? null);
      durations.push(seg.duration ?? null);

      startLats.push(seg.start?.lat ?? null);
      startLngs.push(seg.start?.lng ?? null);
      startNames.push(seg.start?.name ?? null);
      startAltitudes.push(seg.start?.altitude ?? null);

      endLats.push(seg.end?.lat ?? null);
      endLngs.push(seg.end?.lng ?? null);
      endNames.push(seg.end?.name ?? null);
      endAltitudes.push(seg.end?.altitude ?? null);

      ascents.push(seg.ascent ?? null);

      const altis = seg.track.map(t => t.ele ?? null);
      altitudes.push(JSON.stringify(altis));

      pointCounts.push(seg.track.length);

      const coords = seg.track
        .map(p => `${p.lng} ${p.lat}`)
        .join(", ");

      wkts.push(`LINESTRING(${coords})`);
    }

    const query = `
    INSERT INTO gps_segments (
      uid,
      distance,
      duration,

      start_lat,
      start_lng,
      start_name,
      start_altitude,

      end_lat,
      end_lng,
      end_name,
      end_altitude,

      ascent,
      points_count,
      altitudes,

      bounds,
      geom
    )
    SELECT
      u.uid,
      u.distance,
      u.duration,

      u.start_lat,
      u.start_lng,
      u.start_name,
      u.start_altitude,

      u.end_lat,
      u.end_lng,
      u.end_name,
      u.end_altitude,

      u.ascent,
      u.points_count,
      u.altitudes,

      ST_Envelope(ST_GeomFromText(u.wkt, 4326)),
      ST_GeomFromText(u.wkt, 4326)

    FROM UNNEST(
      $1::int[],
      $2::float8[],
      $3::float8[],

      $4::float8[],
      $5::float8[],
      $6::text[],
      $7::float8[],

      $8::float8[],
      $9::float8[],
      $10::text[],
      $11::float8[],

      $12::float8[],
      $13::int[],
      $14::jsonb[],

      $15::text[]
    ) AS u(
      uid,
      distance,
      duration,

      start_lat,
      start_lng,
      start_name,
      start_altitude,

      end_lat,
      end_lng,
      end_name,
      end_altitude,

      ascent,
      points_count,
      altitudes,

      wkt
    )
    ON CONFLICT (id) DO NOTHING
    RETURNING 
        id,
    uid,
    distance,
    duration,
    start_lat,
    start_lng,
    start_name,
    start_altitude,
    end_lat,
    end_lng,
    end_name,
    end_altitude,
    ascent,
    altitudes,
    points_count,
    ST_AsGeoJSON(geom)::json AS geom_geojson,
    ST_YMin(bounds) AS min_lat,
    ST_YMax(bounds) AS max_lat,
    ST_XMin(bounds) AS min_lng,
    ST_XMax(bounds) AS max_lng;
  `;

    const values = [
      uids,
      distances,
      durations,

      startLats,
      startLngs,
      startNames,
      startAltitudes,

      endLats,
      endLngs,
      endNames,
      endAltitudes,

      ascents,
      pointCounts,
      altitudes,

      wkts
    ];

    const result = await pool.query(query, values);
    return result.rows;
  }


  static mapSegment(row, rowstate = 'DB') {
    const merged = [];
    for (let i = 0; i < row.points_count; ++i) {
      const cc = row.geom_geojson.coordinates[i];
      const ele = row.altitudes[i];
      merged.push({
        lat: cc[1],
        lng: cc[0],
        ele: ele
      });

    }

    return {

      id: row.id,
      distance: row.distance,
      duration: row.duration,
      ascent: row.ascent,
      points_count: row.points_count,

      start: {
        lat: row.start_lat,
        lng: row.start_lng,
        name: row.start_name,
        altitude: row.start_altitude
      },

      end: {
        lat: row.end_lat,
        lng: row.end_lng,
        name: row.end_name,
        altitude: row.end_altitude

      },
      track: merged,

      // 🔥 Track umwandeln
      /*track: row.geom_geojson.coordinates.map(([lng, lat]) => ({
        lat,
        lng
      })),*/



      // 🔥 Bounds
      bbox: {
        minLat: row.min_lat,
        maxLat: row.max_lat,
        minLng: row.min_lng,
        maxLng: row.max_lng
      },
      rowstate: rowstate
    };
  }

}