import pool from "./database.js";
import { FileDBService } from "./fileDBService.js";
import SegmentMatcher from "./SegmentMatcher.js";
import WorkoutDBService from "./workoutDBService.js";
import CollaborationDBService from "./collaborationDBService.js";
import WorkoutSharingService from "./workoutSharingService.js";



export default class SegmentDBService {

  static async getSegmentDistanceMap(segmentIds = []) {
    const normalizedIds = [...new Set(
      (Array.isArray(segmentIds) ? segmentIds : [])
        .map((segmentId) => Number(segmentId))
        .filter((segmentId) => Number.isInteger(segmentId) && segmentId > 0)
    )];

    if (!normalizedIds.length) {
      return new Map();
    }

    const result = await pool.query(`
      SELECT id, distance
      FROM gps_segments
      WHERE id = ANY($1::bigint[])
    `, [normalizedIds]);

    return new Map(
      result.rows.map((row) => [Number(row.id), Number(row.distance) || 0])
    );
  }

  static calculateNormalizedSegmentSpeed(distanceMeters, durationSeconds) {
    const distance = Number(distanceMeters);
    const duration = Number(durationSeconds);

    if (!Number.isFinite(distance) || distance <= 0 || !Number.isFinite(duration) || duration <= 0) {
      return null;
    }

    return Math.round(((distance * 3.6) / duration) * 10) / 10;
  }

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
    const distanceMap = await SegmentDBService.getSegmentDistanceMap(matches.map((match) => match.segment_id));

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
      const avg_speed = SegmentDBService.calculateNormalizedSegmentSpeed(
        distanceMap.get(Number(segment_id)),
        duration
      );

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


  static async storeSegmentBestEfforts(matches, workoutObject) {
    const distanceMap = await SegmentDBService.getSegmentDistanceMap(matches.map((match) => match.segment_id));

    const gps_segments_be = [];
    matches.forEach(match => {
      const duration = match.end_offset - match.start_offset;
      const segment_id = match.segment_id;
      const file_id = match.workout_id;
      const start_offset = match.start_offset;
      const end_offset = match.end_offset;
      const averages = workoutObject.getAverages(start_offset, end_offset);
      const avg_power = Math.round(averages.power ?? 0);
      const avg_heart_rate = Math.round(averages.hr ?? 0);
      const avg_cadence = Math.round(averages.cadence ?? 0);
      const avg_speed = SegmentDBService.calculateNormalizedSegmentSpeed(
        distanceMap.get(Number(segment_id)),
        duration
      );

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

  static async getMatchingSegmentCandidatesV2(bounds, uid, workoutId = null) {
    const sql = `SELECT
      s.id,
      ST_AsGeoJSON(s.geom)::json AS geom
      FROM gps_segments s
      WHERE
        (
          s.uid = $1
          OR (
            $6::bigint IS NOT NULL
            AND EXISTS (
              SELECT 1
              FROM gps_segment_group_shares sgs
              INNER JOIN workout_group_shares wgs
                ON wgs.group_id = sgs.group_id
              WHERE sgs.segment_id = s.id
                AND wgs.workout_id = $6
            )
          )
        )
        AND s.bounds && ST_MakeEnvelope($2, $3, $4, $5, 4326)
        AND (
          $6::bigint IS NULL
          OR NOT EXISTS (
            SELECT 1
            FROM gps_segment_best_efforts sbe
            WHERE sbe.wid = $6
              AND sbe.sid = s.id
          )
        );`;

    const result = await pool.query(
      sql,
      [uid,
      bounds.minLng,
      bounds.minLat,
      bounds.maxLng,
      bounds.maxLat,
      workoutId]
    );

    return result.rows;
  }

  static async getSegmentById(uid, segmentId) {
    const result = await pool.query(`
      SELECT
        s.id,
        s.uid,
        s.distance,
        s.duration,
        s.start_lat,
        s.start_lng,
        s.start_name,
        s.start_altitude,
        s.end_lat,
        s.end_lng,
        s.end_name,
        s.end_altitude,
        s.ascent,
        s.altitudes,
        s.points_count,
        s.best_efforts_status,
        (
          SELECT COUNT(*)
          FROM gps_segment_group_shares sgs
          WHERE sgs.segment_id = s.id
        )::int AS share_group_count,
        owner.display_name AS owner_display_name,
        owner.email AS owner_email,
        ST_AsGeoJSON(s.geom)::json AS geom_geojson,
        ST_YMin(s.bounds) AS min_lat,
        ST_YMax(s.bounds) AS max_lat,
        ST_XMin(s.bounds) AS min_lng,
        ST_XMax(s.bounds) AS max_lng
      FROM gps_segments s
      LEFT JOIN users owner
        ON owner.id = s.uid
      WHERE s.id = $1
        AND s.uid = $2
    `, [segmentId, uid]);

    return result.rows[0] ? SegmentDBService.mapSegment(result.rows[0]) : null;
  }

  static async getSegmentSharing(uid, segmentId) {
    const segmentResult = await pool.query(`
      SELECT id, uid
      FROM gps_segments
      WHERE id = $1
        AND uid = $2
      LIMIT 1
    `, [segmentId, uid]);

    if (segmentResult.rowCount === 0) {
      throw new Error("Segment not found");
    }

    const sharesResult = await pool.query(`
      SELECT
        sgs.group_id,
        g.name AS group_name
      FROM gps_segment_group_shares sgs
      INNER JOIN groups g
        ON g.id = sgs.group_id
      WHERE sgs.segment_id = $1
      ORDER BY lower(g.name) ASC, sgs.group_id ASC
    `, [segmentId]);

    const groupIds = sharesResult.rows.map((row) => Number(row.group_id));

    return {
      shareMode: groupIds.length > 0 ? "groups" : "private",
      groupIds,
      groups: sharesResult.rows
    };
  }

  static async updateSegmentSharing(uid, segmentId, payload = {}) {
    const shareMode = String(payload.shareMode || "private").toLowerCase() === "groups"
      ? "groups"
      : "private";
    let newlyPublishedGroupIds = [];

    const requestedGroupIds = [...new Set(
      (Array.isArray(payload.groupIds) ? payload.groupIds : [])
        .map((groupId) => Number(groupId))
        .filter((groupId) => Number.isInteger(groupId) && groupId > 0)
    )];

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const segmentResult = await client.query(`
        SELECT
          id,
          uid,
          distance,
          duration,
          start_name,
          end_name
        FROM gps_segments
        WHERE id = $1
          AND uid = $2
        LIMIT 1
      `, [segmentId, uid]);

      if (segmentResult.rowCount === 0) {
        throw new Error("Segment not found");
      }

      const previousSharesResult = await client.query(`
        SELECT group_id
        FROM gps_segment_group_shares
        WHERE segment_id = $1
      `, [segmentId]);

      const previousGroupIds = previousSharesResult.rows.map((row) => Number(row.group_id));

      await client.query(`
        DELETE FROM gps_segment_group_shares
        WHERE segment_id = $1
      `, [segmentId]);

      if (shareMode === "groups") {
        if (requestedGroupIds.length === 0) {
          throw new Error("Bitte mindestens eine Gruppe auswaehlen.");
        }

        const groupsResult = await client.query(`
          SELECT group_id
          FROM group_members
          WHERE user_id = $1
            AND group_id = ANY($2::bigint[])
        `, [uid, requestedGroupIds]);

        const allowedGroupIds = groupsResult.rows.map((row) => Number(row.group_id));

        if (allowedGroupIds.length !== requestedGroupIds.length) {
          throw new Error("Mindestens eine Gruppe ist fuer dieses Segment nicht erlaubt.");
        }

        await client.query(`
          INSERT INTO gps_segment_group_shares (segment_id, group_id, shared_by_user_id)
          SELECT
            $1,
            gm.group_id,
            $2
          FROM group_members gm
          WHERE gm.user_id = $2
            AND gm.group_id = ANY($3::bigint[])
          ON CONFLICT (segment_id, group_id) DO NOTHING
        `, [segmentId, uid, allowedGroupIds]);

        newlyPublishedGroupIds = allowedGroupIds.filter((groupId) => !previousGroupIds.includes(groupId));

        if (newlyPublishedGroupIds.length > 0) {
          await CollaborationDBService.createSegmentPublishedFeedEvents({
            groupIds: newlyPublishedGroupIds,
            actorUserId: uid,
            segmentId,
            payload: {
              segmentType: "gps",
              distance: segmentResult.rows[0].distance ?? null,
              duration: segmentResult.rows[0].duration ?? null,
              startName: segmentResult.rows[0].start_name || null,
              endName: segmentResult.rows[0].end_name || null
            }
          });
        }
      }

      await client.query("COMMIT");

      const sharing = await SegmentDBService.getSegmentSharing(uid, segmentId);
      return {
        ...sharing,
        newlyPublishedGroupIds
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  static async bulkPublishSegmentsToGroup(uid, groupId) {
    const normalizedGroupId = Number(groupId);
    if (!Number.isInteger(normalizedGroupId) || normalizedGroupId <= 0) {
      const error = new Error("Ungueltige Gruppe.");
      error.statusCode = 400;
      throw error;
    }

    const membershipResult = await pool.query(`
      SELECT group_id
      FROM group_members
      WHERE user_id = $1
        AND group_id = $2
      LIMIT 1
    `, [uid, normalizedGroupId]);

    if (membershipResult.rowCount === 0) {
      const error = new Error("Gruppe fuer dieses Segment nicht erlaubt.");
      error.statusCode = 403;
      throw error;
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const insertResult = await client.query(`
        WITH candidates AS (
          SELECT
            s.id,
            s.distance,
            s.duration,
            s.start_name,
            s.end_name
          FROM gps_segments s
          WHERE s.uid = $1
            AND NOT EXISTS (
              SELECT 1
              FROM gps_segment_group_shares sgs
              WHERE sgs.segment_id = s.id
                AND sgs.group_id = $2
            )
        )
        INSERT INTO gps_segment_group_shares (segment_id, group_id, shared_by_user_id)
        SELECT
          c.id,
          $2,
          $1
        FROM candidates c
        RETURNING segment_id
      `, [uid, normalizedGroupId]);

      const segmentIds = insertResult.rows.map((row) => Number(row.segment_id));
      let segments = [];

      if (segmentIds.length > 0) {
        const segmentsResult = await client.query(`
          SELECT
            id,
            distance,
            duration,
            start_name,
            end_name
          FROM gps_segments
          WHERE id = ANY($1::bigint[])
        `, [segmentIds]);

        segments = segmentsResult.rows;
      }

      await client.query("COMMIT");

      return {
        groupId: normalizedGroupId,
        segmentIds,
        segments,
        publishedCount: segmentIds.length
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /*
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
        AND s.bounds && w.bounds;`;

    const result = await pool.query(
      sql,
      [wid, uid]
    );

    return result.rows;
  }
  */

  static async getGPSSegmentByWorkout(uid, wid){
    await WorkoutSharingService.getAccessibleWorkout(uid, wid);

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
      avg_speed
    FROM v_gps_segment_best_efforts
    WHERE wid = $1

  `;

    const dataParams = [
      wid
    ];

    const dataResult = await pool.query(dataQuery, dataParams);
    return dataResult;
  }

  static async getBestEffortsBySegment(uid, segid, page, size, sort, filter, scope = "mine", perUser = "all") {

    const offset = (page - 1) * size;

    const filter_all = [];
    //filter_all.push({ field: 'uid', type: '=', value: uid });
    filter_all.push({ field: 'sid', type: '=', value: segid });
    filter_all.push(...filter);



    const { whereSQL, orderSQL, params } =
      FileDBService.buildQueryParts(SegmentDBService.allowedColumns, SegmentDBService.numericFields, sort, filter_all);

    const normalizedScope = ["mine", "shared", "all"].includes(String(scope).toLowerCase())
      ? String(scope).toLowerCase()
      : "mine";
    const normalizedPerUser = ["all", "1", "3"].includes(String(perUser).toLowerCase())
      ? String(perUser).toLowerCase()
      : "all";
    const perUserLimit = normalizedPerUser === "all" ? null : Number(normalizedPerUser);

    let accessPredicate = `v.uid = $1`;

    if (normalizedScope === "shared") {
      accessPredicate = `
        v.uid <> $1
        AND EXISTS (
          SELECT 1
          FROM workout_group_shares wgs
          INNER JOIN group_members gm
            ON gm.group_id = wgs.group_id
          WHERE wgs.workout_id = v.wid
            AND gm.user_id = $1
        )
      `;
    } else if (normalizedScope === "all") {
      accessPredicate = `
        v.uid = $1
        OR EXISTS (
          SELECT 1
          FROM workout_group_shares wgs
          INNER JOIN group_members gm
            ON gm.group_id = wgs.group_id
          WHERE wgs.workout_id = v.wid
            AND gm.user_id = $1
        )
      `;
    }

    // -----------------------------------
    // BASE WHERE (User Filter + Tabulator Filter)
    // -----------------------------------

    let baseWhere = `WHERE (${accessPredicate})`;
    let sqlParams = [uid, ...params];
    if (whereSQL) {
      const adjustedWhere = whereSQL.replace(/\$(\d+)/g, (_, index) => `$${Number(index) + 1}`);
      baseWhere += ` AND (${adjustedWhere.replace("WHERE ", "")})`;
    }

    const userRankWhere = Number.isInteger(perUserLimit) && perUserLimit > 0
      ? `WHERE ranked.user_rank <= ${perUserLimit}`
      : "";

    // -----------------------------------
    // DATA QUERY
    // -----------------------------------

    const dataQuery = `
    WITH base AS (
      SELECT 
        v.id, 
        v.sid,
        v.wid,
        v.uid,
        v.start_time, 
        v.duration, 
        v.start_offset, 
        v.end_offset, 
        v.avg_power, 
        v.avg_heart_rate, 
        v.avg_cadence, 
        v.avg_speed
      FROM v_gps_segment_best_efforts v
      ${baseWhere}
    ),
    ranked AS (
      SELECT
        base.*,
        ROW_NUMBER() OVER (
          PARTITION BY base.sid
          ORDER BY base.duration ASC
        ) AS rn,
        ROW_NUMBER() OVER (
          PARTITION BY base.sid, base.uid
          ORDER BY base.duration ASC
        ) AS user_rank
      FROM base
    )
    SELECT 
      ranked.id,
      ranked.sid,
      ranked.wid,
      ranked.uid,
      ranked.start_time,
      ranked.duration,
      ranked.start_offset,
      ranked.end_offset,
      ranked.avg_power,
      ranked.avg_heart_rate,
      ranked.avg_cadence,
      owner.display_name AS owner_display_name,
      owner.email AS owner_email,
      ranked.avg_speed,
      ranked.rn
    FROM ranked
    LEFT JOIN users owner
      ON owner.id = ranked.uid
    ${userRankWhere}
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
    WITH base AS (
      SELECT 
        v.id,
        v.sid,
        v.uid,
        v.duration
      FROM v_gps_segment_best_efforts v
      ${baseWhere}
    ),
    ranked AS (
      SELECT
        base.*,
        ROW_NUMBER() OVER (
          PARTITION BY base.sid, base.uid
          ORDER BY base.duration ASC
        ) AS user_rank
      FROM base
    )
    SELECT COUNT(*) AS total
    FROM ranked
    ${userRankWhere}
  `;

    const countResult = await pool.query(countQuery, sqlParams);

    const totalRecords = parseInt(countResult.rows[0].total);


    return {
      data: dataResult.rows,
      last_page: Math.ceil(totalRecords / size),
      total_records: totalRecords
    };
  }

  static async getBestEffortsStatus(uid, segmentId) {
    const result = await pool.query(`
      SELECT
        id,
        best_efforts_status,
        best_efforts_error
      FROM gps_segments
      WHERE id = $1
        AND uid = $2
    `, [segmentId, uid]);

    return result.rows[0] ?? null;
  }





  static async querySegmentsByBounds(uid, bounds, excludeIds, limit, scope = "mine") {
    const normalizedScope = ["mine", "shared", "all"].includes(String(scope).toLowerCase())
      ? String(scope).toLowerCase()
      : "mine";

    let accessPredicate = `s.uid = $1`;

    if (normalizedScope === "shared") {
      accessPredicate = `
        s.uid <> $1
        AND EXISTS (
          SELECT 1
          FROM gps_segment_group_shares sgs
          INNER JOIN group_members gm
            ON gm.group_id = sgs.group_id
          WHERE sgs.segment_id = s.id
            AND gm.user_id = $1
        )
      `;
    } else if (normalizedScope === "all") {
      accessPredicate = `
        s.uid = $1
        OR EXISTS (
          SELECT 1
          FROM gps_segment_group_shares sgs
          INNER JOIN group_members gm
            ON gm.group_id = sgs.group_id
          WHERE sgs.segment_id = s.id
            AND gm.user_id = $1
        )
      `;
    }

    const result = await pool.query(`
  SELECT
    s.id,
    s.uid,
    s.created_at,
    s.distance,
    s.duration,
    s.start_lat,
    s.start_lng,
    s.start_name,
    s.start_altitude,
    s.end_lat,
    s.end_lng,
    s.end_name,
    s.end_altitude,
    s.ascent,
    s.altitudes,
    s.points_count,
    s.best_efforts_status,
    (
      SELECT COUNT(*)
      FROM gps_segment_group_shares sgs
      WHERE sgs.segment_id = s.id
    )::int AS share_group_count,
    owner.display_name AS owner_display_name,
    owner.email AS owner_email,
    ST_AsGeoJSON(s.geom)::json AS geom_geojson,
    ST_YMin(s.bounds) AS min_lat,
    ST_YMax(s.bounds) AS max_lat,
    ST_XMin(s.bounds) AS min_lng,
    ST_XMax(s.bounds) AS max_lng
  FROM gps_segments s
  LEFT JOIN users owner
    ON owner.id = s.uid
  WHERE (${accessPredicate})
    AND (
      $2::int[] IS NULL
      OR NOT (s.id = ANY($2))
    )
    AND s.bounds && ST_MakeEnvelope($3, $4, $5, $6, 4326)
  ORDER BY s.created_at DESC
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

  static async deleteSegmentById(uid, segmentId) {
    const result = await pool.query(`
      DELETE FROM gps_segments
      WHERE id = $1
        AND uid = $2
      RETURNING id
    `, [segmentId, uid]);

    return result.rows[0] ?? null;
  }

  static async updateBestEffortsStatus(uid, segmentIds, status, errorMessage = null) {
    if (!Array.isArray(segmentIds) || segmentIds.length === 0) {
      return [];
    }

    const result = await pool.query(`
      UPDATE gps_segments
      SET
        best_efforts_status = $3,
        best_efforts_error = $4,
        updated_at = NOW()
      WHERE id = ANY($1::bigint[])
        AND uid = $2
      RETURNING id
    `, [segmentIds, uid, status, errorMessage]);

    return result.rows;
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
    if (sids.length < 1) {
      return [];
    }

    console.time("scanWorkoutsForSegments");

    const candidates = await FileDBService.getMatchingWorkoutCandidates(sids, uid);
    //console.log({NumberOfCandidates: candidates.length, sids, wids: candidates.map(m=>m.wid)  });

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
    console.timeEnd("scanWorkoutsForSegments");
    return matches;
  }

  static async scanWorkoutsForSegment(uid, segment) {
    if (!segment?.id || !segment?.bbox) {
      return [];
    }

    console.time("scanWorkoutsForSegment");

    const candidates = await FileDBService.getMatchingWorkoutCandidatesV2(
      segment.bbox,
      segment.id,
      uid
    );

    const segLine = segment.track.map(({ lat, lng }) => ({ lat, lng }));
    const matches = [];

    candidates.forEach((cand) => {
      const wotrack = {
        wid: cand.wid,
        track: cand.wgeom.coordinates.map(([lng, lat]) => ({ lat, lng })),
        sampleRate: cand.wsamplerate
      };

      const found = SegmentMatcher.findMatches(wotrack, {
        id: segment.id,
        track: segLine
      });

      matches.push(...found);
    });

    const uniqueIds = [...new Set(matches.map((match) => match.workout_id))];

    if (uniqueIds.length > 0) {
      const chunks = SegmentDBService.chunkArray(uniqueIds, 10);
      const CONCURRENCY = 3;

      for (let i = 0; i < chunks.length; i += CONCURRENCY) {
        const batch = chunks.slice(i, i + CONCURRENCY);

        const results = await Promise.all(
          batch.map((chunk) => WorkoutDBService.getWorkouts(chunk))
        );

        results.forEach((workoutMap, idx) => {
          const chunk = batch[idx];

          matches.forEach((match) => {
            if (!chunk.includes(match.workout_id)) return;

            const workoutObject = workoutMap.get(match.workout_id);
            if (!workoutObject) return;

            const avgs = workoutObject.getAverages(match.start_offset, match.end_offset);
            Object.assign(match, avgs);
          });
        });
      }
    }

    console.timeEnd("scanWorkoutsForSegment");
    return matches;
  }

  static async getSharedSegmentRescanTargetsForWorkout(workoutId, workoutOwnerId, groupIds = []) {
    const normalizedGroupIds = [...new Set(
      (Array.isArray(groupIds) ? groupIds : [])
        .map((groupId) => Number(groupId))
        .filter((groupId) => Number.isInteger(groupId) && groupId > 0)
    )];

    if (!workoutId || normalizedGroupIds.length === 0) {
      return [];
    }

    const result = await pool.query(`
      SELECT DISTINCT
        s.id,
        s.uid
      FROM workouts w
      INNER JOIN gps_segment_group_shares sgs
        ON sgs.group_id = ANY($3::bigint[])
      INNER JOIN gps_segments s
        ON s.id = sgs.segment_id
      WHERE w.id = $1
        AND w.uid = $2
        AND s.uid <> $2
        AND s.bounds && w.bounds
    `, [workoutId, workoutOwnerId, normalizedGroupIds]);

    return result.rows.map((row) => ({
      id: Number(row.id),
      uid: Number(row.uid)
    }));
  }

  static async getSharedSegmentRescanTargetsForGroup(groupId) {
    const normalizedGroupId = Number(groupId);
    if (!Number.isInteger(normalizedGroupId) || normalizedGroupId <= 0) {
      return [];
    }

    const result = await pool.query(`
      SELECT DISTINCT
        s.id,
        s.uid
      FROM gps_segments s
      INNER JOIN gps_segment_group_shares sgs
        ON sgs.segment_id = s.id
      WHERE sgs.group_id = $1
      ORDER BY s.uid, s.id
    `, [normalizedGroupId]);

    return result.rows.map((row) => ({
      id: Number(row.id),
      uid: Number(row.uid)
    }));
  }

  static async rescanSegmentBestEffortsForWorkout(uid, workoutId) {
    const workoutRowResult = await pool.query(`
      SELECT
        id,
        samplerategps,
        ST_AsGeoJSON(geom)::json AS track_geojson
      FROM workouts
      WHERE id = $1
        AND uid = $2
      LIMIT 1
    `, [workoutId, uid]);

    if (workoutRowResult.rowCount === 0) {
      return [];
    }

    const workoutRow = workoutRowResult.rows[0];
    const coordinates = workoutRow.track_geojson?.coordinates || [];
    const track = coordinates.map(([lng, lat]) => ({ lat, lng }));

    if (track.length === 0) {
      return [];
    }

    const bounds = track.reduce((acc, point) => ({
      minLat: Math.min(acc.minLat, point.lat),
      maxLat: Math.max(acc.maxLat, point.lat),
      minLng: Math.min(acc.minLng, point.lng),
      maxLng: Math.max(acc.maxLng, point.lng)
    }), {
      minLat: Infinity,
      maxLat: -Infinity,
      minLng: Infinity,
      maxLng: -Infinity
    });

    const candidates = await SegmentDBService.getMatchingSegmentCandidatesV2(bounds, uid, workoutId);

    if (candidates.length === 0) {
      return [];
    }

    const workout = {
      id: workoutId,
      track,
      sampleRate: workoutRow.samplerategps
    };

    const matches = SegmentDBService.matchSegments(workout, candidates);
    if (matches.length === 0) {
      return [];
    }

    const workoutObject = await WorkoutDBService.getWorkout(workoutId);
    await SegmentDBService.storeSegmentBestEfforts(matches, workoutObject);
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
    const bestEffortsStatuses = [];

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
      bestEffortsStatuses.push(seg.bestEffortsStatus ?? "queued");

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
      best_efforts_status,

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
      u.best_efforts_status,

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
      $15::text[],
      $16::text[]
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
      best_efforts_status,

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
    best_efforts_status,
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
      bestEffortsStatuses,

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
      uid: row.uid,
      ownerDisplayName: row.owner_display_name || null,
      ownerEmail: row.owner_email || null,
      distance: row.distance,
      duration: row.duration,
      ascent: row.ascent,
      points_count: row.points_count,
      bestEffortsStatus: row.best_efforts_status,
      shareGroupCount: Number(row.share_group_count || 0),

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
